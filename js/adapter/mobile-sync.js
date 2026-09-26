/**
 * mobile-sync.js — syncs the phone's data with the paired Mac.
 * ============================================================
 * Keeps a long-lived encrypted channel to the Mac. On launch (and on every
 * reconnect) the phone sends its key/value set; the Mac replies with the
 * merged set and the phone applies any newer values. Last-writer-wins by
 * modifiedAt — same model as the desktop iCloud journal.
 *
 * TRANSPORT LADDER (2026-08-31): the channel rides whichever relay the
 * phone can reach — the Mac's own LAN relay first (direct, same Wi-Fi,
 * `pairing.lanUrls` from the QR and refreshed in-band on every sync-plan),
 * then the hosted relay. The choice is made once per CONNECTION, never per
 * request: everything below (sync round-trips, pushes, heartbeat) rides
 * the one adopted socket until it drops. A LAN attempt that fails is
 * remembered briefly (LAN_FAILURE_TTL_MS) so away-from-home reconnects
 * don't pay the probe on every backoff tick; foregrounding while connected
 * via the hosted relay probes the LAN again and upgrades in place. The
 * Noise handshake authenticates the Mac by its static key on either path,
 * so an untrusted network changes nothing.
 *
 * The Mac also pushes a `data-changed` message whenever something changes
 * on its side (a task you typed on the Mac, a Mac-to-Mac iCloud merge
 * arriving, …). The phone treats that as a trigger to sync immediately —
 * so a change on the Mac shows up on the phone within seconds, instead of
 * waiting for the next app launch.
 *
 * The first sync after pairing is Mac-authoritative: the phone sends an
 * empty set and adopts the Mac's data, so first-run defaults cannot
 * overwrite it.
 *
 * Sync state is surfaced through `AnjadheSync.onStateChange` so screens
 * can render a quiet header indicator instead of popping a banner.
 *
 * Mobile-only — loaded by the iPhone app's hidden sync host (AnjadheUI.
 * SyncCoordinator; assets from scripts/build-ios-host.js) after the channel
 * bundle, native-bridge.js and mobile-pairing.js.
 */
(function () {
  'use strict';
  if (!window.__ANJADHE_MOBILE__) return;

  const LS_IDENTITY = 'anjadhe:channel:identity';
  const LS_PAIRING = 'anjadhe:channel:pairing';
  const LS_SYNCED_ONCE = 'anjadhe:channel:synced-once';
  const LS_LAN_FAILED = 'anjadhe:channel:lan-failed-at';

  // Transport ladder timing. The LAN probe is short — on the same network
  // the whole open+welcome+handshake runs in tens of ms, so 3s is generous;
  // away from home it caps what a doomed probe can cost. A failed probe is
  // remembered for LAN_FAILURE_TTL_MS so backoff reconnects skip the rung.
  const LAN_CONNECT_TIMEOUT_MS = 3000;
  // A wss:// candidate is the Mac's relay behind Tailscale Funnel (a public
  // https name, TLS ending on the Mac): a first handshake from cellular can
  // take longer than a LAN one, so it gets its own, longer clock.
  const REMOTE_DIRECT_TIMEOUT_MS = 8000;
  const candidateTimeout = (url, lanMs) => (/^wss:\/\//.test(url) ? Math.max(lanMs, REMOTE_DIRECT_TIMEOUT_MS) : lanMs);
  const RELAY_CONNECT_TIMEOUT_MS = 15000;
  // The hosted relay is raced ALONGSIDE the LAN rung, not after it (2026-09-20).
  // Sequentially, every sync away from home paid the LAN race's full clock
  // before the relay was even dialled — 3s, or 8s with a Tailscale wss://
  // candidate in the list — with nothing on the wire in the meantime. The
  // head start is what keeps the direct rung winning at home: a Mac on the
  // same network answers in tens of milliseconds, so the relay socket is
  // never opened there.
  const RELAY_HEAD_START_MS = 400;
  const LAN_FAILURE_TTL_MS = 2 * 60 * 1000;

  // Reconnect: any backoff has to stay polite to the relay. We aim for the
  // same shape as the host endpoint (1s base, 30s ceiling, 50–150% jitter).
  const RECONNECT_BASE_MS = 1000;
  const RECONNECT_MAX_MS = 30000;

  // The Mac debounces its pushes to ~500ms; we collapse syncs at a slightly
  // bigger window so several quick pushes still produce one sync round-trip.
  const PUSH_SYNC_DEBOUNCE_MS = 250;
  const PUSH_SYNC_MIN_INTERVAL_MS = 8000;
  let lastSyncFinishedAt = 0;

  // Heartbeat: a network drop sometimes doesn't fire `close` on the
  // WebSocket (iOS WebView quirks, NAT timeouts). Pinging keeps it honest —
  // if no pong arrives within the deadline, we treat the channel as dead
  // and reconnect.
  const HEARTBEAT_INTERVAL_MS = 25000;
  const HEARTBEAT_TIMEOUT_MS = 8000;

  let endpoint = null;
  let transport = null;     // 'direct' (Mac's LAN relay) | 'relay' (hosted) | null
  let transportUrl = null;  // the url the adopted socket dialled (null on the hosted relay)
  // 'lan' (the Mac's relay on this network) | 'tailscale' (the same relay
  // through Tailscale Funnel — a wss:// url) | 'relay' (hosted) | null.
  // What the sync icon's dot and the "Connected …" copy say (2026-09-08).
  const viaFor = (t, url) => (t === 'relay' ? 'relay' : t === 'direct' ? (/^wss:\/\//.test(url || '') ? 'tailscale' : 'lan') : null);
  let chatQueue = null;     // one chat waiting for the channel to come up
  let upgrading = false;    // a background LAN probe is running
  let connecting = false;
  let closed = false;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let pushSyncTimer = null;
  let syncInFlight = false; // a sync round-trip is mid-request
  let syncAgain = false;    // a trigger arrived mid-round-trip; run once more
  let uploading = [];       // keys in the stage-2 upload we are waiting on
  let uploadedStamps = {};  // {key: modifiedAt} of that upload, to settle `dirty` on ack
  let heartbeatTimer = null;
  let heartbeatPongTimer = null;

  // In the native host the sync WebView is rebuilt from loadHTMLString each
  // launch (no durable localStorage), so the pairing record + identity + the
  // synced-once flag are read/written through electronStore → native KVStore →
  // disk. The native bridge keeps these `anjadhe:channel:*` keys device-local.
  // On the Capacitor web build, localStorage on the real origin is durable.
  const nativeStore = window.__ANJADHE_NATIVE_HOST__ && window.electronStore ? window.electronStore : null;
  function load(key) {
    if (nativeStore) { const v = nativeStore.get(key); return v == null ? null : v; }
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }
  function save(key, value) {
    if (nativeStore) { try { nativeStore.set(key, value); } catch { /* ignore */ } return; }
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  }

  // --- transport ladder helpers ------------------------------------------
  function lanCandidates(pairing) {
    const urls = pairing && Array.isArray(pairing.lanUrls) ? pairing.lanUrls : [];
    return urls.filter((u) => typeof u === 'string' && /^wss?:\/\//.test(u)).slice(0, 4);
  }
  function lanRecentlyFailed() {
    const at = load(LS_LAN_FAILED);
    return typeof at === 'number' && Date.now() - at < LAN_FAILURE_TTL_MS;
  }
  function noteLanFailure() { save(LS_LAN_FAILED, Date.now()); }
  function clearLanFailure() { save(LS_LAN_FAILED, null); }

  // The Mac advertises its current LAN relay addresses on every sync reply
  // (IPs drift with networks; the QR's copy goes stale). Keep the stored
  // pairing record current so the NEXT connect can dial direct.
  function adoptAdvertisedLanUrls(urls) {
    if (!Array.isArray(urls)) return;
    const clean = urls.filter((u) => typeof u === 'string' && /^wss?:\/\//.test(u)).slice(0, 4);
    if (!clean.length) return;
    const pairing = load(LS_PAIRING);
    if (!pairing) return;
    if (JSON.stringify(pairing.lanUrls || []) === JSON.stringify(clean)) return;
    pairing.lanUrls = clean;
    save(LS_PAIRING, pairing);
  }

  // --- observable state machine -----------------------------------------
  // Sync state is surfaced through a small subscription API instead of a
  // banner — the home screen renders a quiet icon, and we just fire state
  // changes for any subscriber. States:
  //   'offline'    — not connected (initial, or relay unreachable)
  //   'connecting' — handshake in progress
  //   'syncing'    — a sync round-trip is in flight
  //   'idle'       — handshake done, no work in flight; phone is up to date
  //   'error'      — recent failure (sync timed out, send threw). Returns
  //                  to 'connecting' or 'offline' on the next reconnect.
  let state = 'offline';
  const listeners = new Set();
  function setState(next) {
    if (state === next) return;
    state = next;
    for (const cb of listeners) { try { cb(state); } catch { /* keep firing */ } }
  }

  // Apply a {key: entry} map to local storage; returns how many keys
  // changed. Each entry is either `{value, modifiedAt}` (update) or
  // `{deleted: true, modifiedAt}` (tombstone — drop the local copy and
  // remember the delete so a third device still picks it up).
  function applyValues(values) {
    if (!values) return 0;
    let applied = 0;
    for (const key of Object.keys(values)) {
      const remote = values[key];
      if (!remote || !remote.modifiedAt) continue;
      const localAt = window.__anjadheStore.localModifiedAt(key);
      if (new Date(remote.modifiedAt) <= new Date(localAt)) continue;
      if (remote.deleted) {
        window.__anjadheStore.applyRemoteDelete(key, remote.modifiedAt);
      } else {
        window.__anjadheStore.applyRemote(key, remote.value, remote.modifiedAt);
      }
      applied++;
    }
    return applied;
  }

  /**
   * Re-render the live screen so changes pulled from the Mac actually
   * appear without a reload. Skip if the user is typing — we'd lose the
   * draft. A reload would also re-run mobile-sync, looping the app on
   * launch.
   */
  function rerenderIfIdle() {
    const el = document.activeElement;
    const typing = el && /^(INPUT|TEXTAREA)$/.test(el.tagName || '');
    if (!typing && window.App && typeof App.refresh === 'function') App.refresh();
  }

  /**
   * Stage 1 of the delta sync: send a manifest (key→modifiedAt only) so
   * the Mac can decide which values still need to travel. The endpoint
   * stays open afterwards so push notifications keep arriving on it.
   *
   * First-sync remains Mac-authoritative: an empty manifest means the
   * Mac will send everything down and request nothing up, so leftover
   * first-run defaults on the phone cannot overwrite real data.
   */
  function requestSync() {
    if (!endpoint) return;
    // A trigger that lands mid-round-trip used to be DROPPED (2026-09-22) —
    // and the commonest one is a local write's own push, so a task edited on
    // the phone while a sync was in flight simply never went up until
    // something else happened to sync. Remember it and run once more.
    if (syncInFlight) { syncAgain = true; return; }
    syncInFlight = true;
    setState('syncing');
    const firstSync = !load(LS_SYNCED_ONCE);
    const manifest = firstSync ? {} : window.__anjadheStore.exportManifest();
    // Keys changed HERE since the Mac last took them: for a record-merged key
    // the Mac merges ours instead of sending its newer copy over it.
    const dirty = (!firstSync && window.__anjadheStore.exportDirty) ? window.__anjadheStore.exportDirty() : [];
    try {
      endpoint.send(dirty.length ? { type: 'sync-manifest', manifest, dirty } : { type: 'sync-manifest', manifest });
    } catch (err) {
      syncInFlight = false;
      console.warn('[mobile-sync] sync send failed:', (err && err.message) || err);
      setState('error');
    }
  }

  /** Run the sync a trigger asked for while the last one was in flight. */
  function drainDeferredSync() {
    if (!syncAgain) return;
    syncAgain = false;
    requestSync();
  }

  function finishSync(applied) {
    save(LS_SYNCED_ONCE, true);
    lastSyncFinishedAt = Date.now();
    syncInFlight = false;
    console.log('[mobile-sync] applied', applied, 'change(s) from the Mac');
    if (applied > 0) rerenderIfIdle();
    setState('idle');
  }

  /**
   * The Mac has taken the keys we just uploaded (2026-09-22).
   *
   * Everything the Mac sends DOWN reaches the app through the store — the
   * native bridge persists each key and the UI hears about it. What goes UP
   * has no such echo: the Mac applies it silently, so a screen whose content
   * the MAC computes (a Mac-served view — Tasks is one) had no way to know
   * the answer it is showing is now out of date. This is that signal, and it
   * fires on the ack rather than on the write, because before the ack the
   * Mac would answer with the rows it already had.
   */
  const syncedListeners = new Set();
  function fireSynced(keys) {
    if (!keys || !keys.length) return;
    for (const cb of syncedListeners) { try { cb(keys.slice()); } catch { /* keep firing */ } }
  }

  // --- assistant chat over the channel -----------------------------------
  // The phone app as a remote channel to the Mac's assistant (the Telegram
  // shape on our own encrypted pipe). `sendChat` fires a chat-send on the
  // adopted socket; the Mac acks immediately (`chat-ack`) and pushes the
  // finished reply later (`chat-reply` / `chat-error`) — and the reply ALSO
  // lands in the synced conversations blob, so a dropped socket loses
  // nothing. The assistant screen subscribes via `AnjadheSync.onChat`.
  const chatListeners = new Set();
  function fireChat(msg) {
    for (const cb of chatListeners) { try { cb(msg); } catch { /* keep firing */ } }
  }
  // With no live socket the message WAITS for the next adopt instead of
  // being refused (2026-09-08): a channel mid-reconnect (a network blip,
  // foregrounding) came back within seconds, and refusing every send in
  // that window read as "not connected" on a phone that plainly was. One
  // message queues; the native reply timeout is the outer bound.
  function sendChat(text, opts) {
    const msg = {
      type: 'chat-send',
      text: String(text || ''),
      convId: (opts && opts.convId) || null,
      fresh: !!(opts && opts.fresh),
    };
    if (!endpoint) {
      chatQueue = msg;
      connect();
      return true;
    }
    try {
      endpoint.send(msg);
      return true;
    } catch (err) {
      console.warn('[mobile-sync] chat send failed:', (err && err.message) || err);
      return false;
    }
  }
  // An approval the Mac asked this phone for (chat-ask), answered. The Mac
  // matches it to a live ask or ignores it; with no socket it is refused
  // here and the card stays (the Mac re-serves it through `chat-asks`).
  function answerAsk(askId, approved, scope) {
    if (!endpoint) { connect(); return false; }
    try {
      endpoint.send({ type: 'chat-answer', askId: String(askId || ''), approved: approved === true, scope: String(scope || 'once') });
      return true;
    } catch (err) {
      console.warn('[mobile-sync] answer send failed:', (err && err.message) || err);
      return false;
    }
  }
  function flushChatQueue() {
    const msg = chatQueue;
    if (!msg || !endpoint) return;
    chatQueue = null;
    try { endpoint.send(msg); console.log('[mobile-sync] queued chat sent after reconnect'); }
    catch (err) { console.warn('[mobile-sync] queued chat send failed:', (err && err.message) || err); }
  }

  // --- Mac-served views ---------------------------------------------------
  // Read-only digests of data that deliberately does not sync as a blob
  // (email insights, news, portfolio numbers). One in-flight request per
  // reqId; the Mac answers on the same channel with view-data/view-error.
  const viewPending = new Map(); // reqId -> { resolve, reject, timer }
  let viewCounter = 0;
  const VIEW_REQ_TIMEOUT_MS = 35000; // just over the Mac's own 30s ceiling
  function requestView(view, params) {
    return new Promise((resolve, reject) => {
      if (!endpoint) { connect(); reject(new Error('offline')); return; }
      const reqId = 'r' + (++viewCounter) + '_' + Date.now();
      const timer = setTimeout(() => {
        viewPending.delete(reqId);
        reject(new Error('timed out'));
      }, VIEW_REQ_TIMEOUT_MS);
      viewPending.set(reqId, { resolve, reject, timer });
      try {
        const req = { type: 'view-get', view: String(view), reqId };
        if (params && typeof params === 'object') req.params = params;
        endpoint.send(req);
      } catch (err) {
        clearTimeout(timer);
        viewPending.delete(reqId);
        reject(err);
      }
    });
  }
  function settleView(msg) {
    const p = viewPending.get(msg.reqId);
    if (!p) return;
    clearTimeout(p.timer);
    viewPending.delete(msg.reqId);
    if (msg.type === 'view-data') p.resolve(msg.data);
    else p.reject(new Error(msg.error || 'view failed'));
  }

  function handleHostMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'chat-ack' || msg.type === 'chat-reply' || msg.type === 'chat-error'
        || msg.type === 'chat-delta' || msg.type === 'chat-ask' || msg.type === 'chat-ask-done') {
      fireChat(msg);
      return;
    }
    if (msg.type === 'view-data' || msg.type === 'view-error') {
      settleView(msg);
      return;
    }
    if (msg.type === 'pong') {
      if (heartbeatPongTimer) { clearTimeout(heartbeatPongTimer); heartbeatPongTimer = null; }
      return;
    }
    if (msg.type === 'sync-plan') {
      // Stage-1 reply: apply values the Mac sent down, then upload values
      // for the keys it asked for. Marking the sync done after stage 1
      // (not waiting for the upload ack) makes sync feel snappy — the
      // phone shows fresh data before we even start uploading.
      adoptAdvertisedLanUrls(msg.lanUrls);
      const applied = applyValues(msg.send);
      finishSync(applied);
      const wanted = Array.isArray(msg.want) ? msg.want : [];
      if (wanted.length > 0) {
        try {
          const values = window.__anjadheStore.exportValues(wanted);
          endpoint.send({ type: 'sync-values', values });
          uploading = wanted.slice();
          uploadedStamps = {};
          Object.keys(values).forEach((k) => { uploadedStamps[k] = values[k].modifiedAt; });
        } catch { uploading = []; uploadedStamps = {}; /* a failed upload will retry on next sync */ }
      } else {
        drainDeferredSync();
      }
      return;
    }
    if (msg.type === 'sync-values-ack') {
      // Mac confirmed our stage-2 upload: what we sent is now what it holds,
      // so anything it COMPUTES from those keys can be asked for again.
      const keys = uploading;
      uploading = [];
      // The Mac holds (or has merged) exactly what we sent: those writes
      // are no longer only ours.
      if (window.__anjadheStore.clearDirty) window.__anjadheStore.clearDirty(uploadedStamps);
      uploadedStamps = {};
      fireSynced(keys);
      drainDeferredSync();
      return;
    }
    if (msg.type === 'sync-result') {
      // Legacy full-set reply — kept for the case where the phone build
      // is running against an old Mac that hasn't shipped the delta
      // protocol yet. Should be a no-op in fresh deployments.
      adoptAdvertisedLanUrls(msg.lanUrls);
      finishSync(applyValues(msg.changes));
      drainDeferredSync();
      return;
    }
    if (msg.type === 'data-changed') {
      // The Mac touched something — collapse a flurry of pushes into one
      // sync round-trip, and never more than one push-driven sync per
      // PUSH_SYNC_MIN_INTERVAL_MS: a Mac mid-work (mail analysis, a typing
      // burst) nudges every few hundred ms, and the first nudge is enough
      // to make the change visible within seconds.
      if (pushSyncTimer) clearTimeout(pushSyncTimer);
      const sinceLast = Date.now() - lastSyncFinishedAt;
      const delay = Math.max(PUSH_SYNC_DEBOUNCE_MS, PUSH_SYNC_MIN_INTERVAL_MS - sinceLast);
      pushSyncTimer = setTimeout(() => { pushSyncTimer = null; requestSync(); }, delay);
      return;
    }
  }

  // onClose for the ADOPTED endpoint — a network blip, the relay cycling,
  // the Mac quitting. Clear state and reconnect with backoff so the push
  // channel self-heals.
  function onChannelClose() {
    connecting = false;
    endpoint = null;
    transport = null;
    transportUrl = null;
    syncInFlight = false;
    syncAgain = false;
    uploading = [];
    stopHeartbeat();
    if (closed) return;
    setState('offline');
    scheduleReconnect();
  }

  /**
   * One candidate connection. The slot guards its callbacks: a losing
   * candidate closed mid-race must not flip sync state or schedule
   * reconnects — only the adopted endpoint drives the state machine.
   */
  function makeSlot(url, pairing, identityHex) {
    const slot = { url: url, ep: null, adopted: false };
    slot.ep = window.AnjadheChannel.createClientEndpoint({
      relayUrl: url,
      routingId: pairing.routingId,
      identity: window.AnjadheChannel.identityFromHex(identityHex),
      hostStaticPub: pairing.hostPub,
      onMessage: (msg) => { if (slot.adopted) handleHostMessage(msg); },
      onClose: () => { if (slot.adopted && endpoint === slot.ep) onChannelClose(); },
    });
    return slot;
  }

  /**
   * Try every URL in parallel; resolve with the first slot whose Noise
   * handshake completes, closing the losers. Resolves null when all fail
   * or the timeout lapses.
   */
  function raceCandidates(urls, pairing, identityHex, timeoutMs) {
    return new Promise((resolve) => {
      const slots = [];
      let settled = false;
      let pendingCount = 0;
      let timer = null;
      let won = null;
      const winnerSlot = () => won;
      const finish = (winner) => {
        if (settled) return;
        settled = true;
        won = winner;
        if (timer) clearTimeout(timer);
        for (const s of slots) {
          if (s !== winner) { try { s.ep.close(); } catch { /* gone */ } }
        }
        resolve(winner || null);
      };
      for (const url of urls) {
        let slot;
        try { slot = makeSlot(url, pairing, identityHex); }
        catch (err) {
          console.warn('[mobile-sync] endpoint create failed for', url, (err && err.message) || err);
          continue;
        }
        slots.push(slot);
        pendingCount++;
        slot.ep.ready.then(
          () => finish(slot),
          (err) => {
            // Name the rung and the reason — "could not reach your Mac" alone
            // hid whether the socket, the relay room or the handshake failed.
            console.warn('[mobile-sync] candidate failed', url, (err && err.message) || err);
            pendingCount--; if (pendingCount === 0) finish(null);
          },
        );
      }
      if (!pendingCount) return finish(null);
      // The race lasts as long as its slowest candidate's clock; each
      // candidate is cut at its own (ws: LAN clock, wss: remote clock).
      const raceMs = Math.max(...slots.map((s) => candidateTimeout(s.url, timeoutMs)));
      for (const s of slots) {
        const ms = candidateTimeout(s.url, timeoutMs);
        if (ms >= raceMs) continue; // the race timer cuts it
        setTimeout(() => {
          if (settled || s === winnerSlot()) return;
          try { s.ep.close(); } catch { /* gone */ }
        }, ms);
      }
      timer = setTimeout(() => finish(null), raceMs);
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Resolve with the first rung to produce a winner, naming which rung it
   * was. A rung that wins LATE (it was merely slower) has its endpoint
   * closed — we are already connected on the other one.
   */
  function firstWinner(rungs) {
    return new Promise((resolve) => {
      let settled = false;
      let pending = rungs.length;
      const lose = () => { pending--; if (!pending && !settled) { settled = true; resolve(null); } };
      for (const rung of rungs) {
        rung.race.then((slot) => {
          if (!slot) return lose();
          if (settled) { try { slot.ep.close(); } catch { /* gone */ } return; }
          settled = true;
          resolve({ slot, via: rung.via });
        }, lose);
      }
      if (!pending) resolve(null);
    });
  }

  /** Make a raced winner THE channel: sync, heartbeat, clean backoff slate. */
  function adopt(slot, via) {
    slot.adopted = true;
    endpoint = slot.ep;
    transport = via;
    transportUrl = via === 'direct' ? slot.url : null;
    reconnectAttempt = 0; // a successful handshake earns a clean slate
    if (via === 'direct') clearLanFailure();
    console.log('[mobile-sync] connected', via === 'direct'
      ? 'directly to the Mac (' + slot.url + ')' : 'via the hosted relay');
    requestSync();
    startHeartbeat();
    flushChatQueue();
  }

  /**
   * Connect (or reconnect) the long-lived channel and run an initial sync
   * once the handshake completes. The transport ladder runs HERE, once per
   * connection: the Mac's LAN relay first (direct — same network, no hop),
   * then the hosted relay. No user-visible UI; the header indicator reads
   * state via onStateChange.
   */
  async function connect() {
    if (closed || connecting || endpoint) return;
    const pairing = load(LS_PAIRING);
    const identityHex = load(LS_IDENTITY);
    if (!pairing || !identityHex) return; // not paired yet
    if (!window.AnjadheChannel || !window.__anjadheStore) {
      console.warn('[mobile-sync] channel bundle not available');
      setState('error');
      return;
    }

    connecting = true;
    setState('connecting');

    const lan = lanCandidates(pairing);
    const lanTried = lan.length > 0 && !lanRecentlyFailed();

    const lanRace = lanTried
      ? raceCandidates(lan, pairing, identityHex, LAN_CONNECT_TIMEOUT_MS)
      : Promise.resolve(null);

    // The relay waits out the head start, and is skipped entirely if the LAN
    // answered inside it — the common case at home.
    const relayRace = (async () => {
      if (lanTried) {
        const early = await Promise.race([lanRace, sleep(RELAY_HEAD_START_MS)]);
        if (early || closed) return null;
      }
      return raceCandidates([pairing.relayUrl], pairing, identityHex, RELAY_CONNECT_TIMEOUT_MS);
    })();

    const first = await firstWinner([
      { race: lanRace, via: 'direct' },
      { race: relayRace, via: 'relay' },
    ]);
    const winner = first && first.slot;
    const via = first && first.via;

    // The LAN rung is only "known bad" when the Mac answered another way.
    // When the relay fails too, the Mac itself was unreachable (quit, asleep,
    // restarting) — penalising the LAN for two minutes then kept the phone
    // off the direct path after the Mac came back. Racing adds a second
    // case: a LAN candidate that merely LOST is not a failure, so we wait for
    // its race to actually conclude with nothing. Attached AFTER the winner
    // is known and re-checking `transport`, because the two races settle in
    // either order and an upgrade may have moved us since.
    if (lanTried && via === 'relay') {
      const remember = () => { if (transport === 'relay') noteLanFailure(); };
      lanRace.then((w) => { if (!w) remember(); }, remember);
    }

    connecting = false;
    if (closed) {
      if (winner) { try { winner.ep.close(); } catch { /* gone */ } }
      return;
    }
    if (!winner) {
      console.warn('[mobile-sync] could not reach your Mac (direct or via relay)');
      setState('error');
      scheduleReconnect();
      return;
    }
    adopt(winner, via);
  }

  /**
   * Connected via the hosted relay but possibly back on the Mac's network
   * (fired on foregrounding): probe the LAN in the background and swap the
   * session over if it answers. The swap is invisible to the sync layer —
   * the old slot's onClose guard keeps its close() from firing reconnects.
   */
  function tryUpgradeToDirect() {
    if (closed || upgrading || connecting || !endpoint || transport !== 'relay') return;
    if (lanRecentlyFailed()) return;
    const pairing = load(LS_PAIRING);
    const identityHex = load(LS_IDENTITY);
    const lan = pairing && identityHex ? lanCandidates(pairing) : [];
    if (!lan.length) return;
    upgrading = true;
    raceCandidates(lan, pairing, identityHex, LAN_CONNECT_TIMEOUT_MS).then((winner) => {
      upgrading = false;
      if (!winner) { noteLanFailure(); return; }
      if (closed || !endpoint || transport !== 'relay') {
        try { winner.ep.close(); } catch { /* gone */ }
        return;
      }
      const old = endpoint;
      syncInFlight = false; // anything mid-flight rides the socket we're dropping
      adopt(winner, 'direct'); // repoints `endpoint` — old's onClose guard now misses
      try { old.close(); } catch { /* gone */ }
      console.log('[mobile-sync] upgraded to a direct LAN connection');
    });
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    const ceiling = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
    const delay = Math.round(ceiling * (0.5 + Math.random()));
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }

  /**
   * Heartbeat: ping the Mac every HEARTBEAT_INTERVAL_MS. If no pong arrives
   * within HEARTBEAT_TIMEOUT_MS the channel is considered dead — we close
   * it locally, which fires onClose and starts the reconnect dance. This
   * catches "silent" disconnects (NAT timeouts, suspended WebView, lossy
   * networks) that don't deliver a clean close event.
   */
  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (!endpoint) return;
      try {
        endpoint.send({ type: 'ping' });
        if (heartbeatPongTimer) clearTimeout(heartbeatPongTimer);
        heartbeatPongTimer = setTimeout(() => {
          // No pong — bring the channel down so it can be rebuilt fresh.
          heartbeatPongTimer = null;
          try { if (endpoint) endpoint.close(); } catch {}
        }, HEARTBEAT_TIMEOUT_MS);
      } catch {
        try { if (endpoint) endpoint.close(); } catch {}
      }
    }, HEARTBEAT_INTERVAL_MS);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (heartbeatPongTimer) { clearTimeout(heartbeatPongTimer); heartbeatPongTimer = null; }
  }

  /**
   * Manual entry point — the home-screen sync indicator calls this on tap.
   * No banner; the state machine drives the UI through onStateChange.
   */
  function sync() {
    if (!endpoint) connect();
    else requestSync();
  }

  // Foreground: when iOS resumes the WebView, refresh state immediately
  // so the user sees the latest data without re-tapping. A bare
  // visibilitychange covers both Safari WebView and Capacitor.
  function onForeground() {
    if (document.visibilityState !== 'visible') return;
    if (!endpoint) {
      connect();
    } else {
      tryUpgradeToDirect(); // no-op unless riding the relay with LAN urls known
      requestSync();
    }
  }

  /**
   * The app came to the foreground (native tells us; the hidden host's own
   * visibilitychange is unreliable). Forget the backoff and the LAN penalty
   * — both were earned while the phone was asleep or the Mac was away — and
   * reconnect now, or refresh over the live socket and probe for direct.
   */
  function resume() {
    reconnectAttempt = 0;
    clearLanFailure();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (!endpoint) { if (!connecting) connect(); return; }
    tryUpgradeToDirect();
    requestSync();
  }

  window.AnjadheSync = {
    sync,
    resume,
    getState: () => state,
    /**
     * Subscribe to sync-state changes. The callback fires synchronously
     * with the current state on subscribe so the indicator can render
     * right away, and again on every transition. Returns an unsubscribe.
     */
    onStateChange(cb) {
      if (typeof cb !== 'function') return () => {};
      listeners.add(cb);
      try { cb(state); } catch { /* keep going */ }
      return () => listeners.delete(cb);
    },
    isConnected: () => !!endpoint && !connecting,
    /** 'direct' (Mac's LAN relay), 'relay' (hosted), or null when offline. */
    getTransport: () => transport,
    /** 'lan' | 'tailscale' | 'relay' | null — the rung, named for the UI. */
    getVia: () => viaFor(transport, transportUrl),
    /** Whether this phone has ever paired with a Mac. */
    isPaired: () => !!load(LS_PAIRING),
    /**
     * Send a chat message to the Mac's assistant. Returns false when there
     * is no live channel (and kicks off a connect attempt). The reply comes
     * through onChat as chat-reply/chat-error, and through sync either way.
     */
    sendChat,
    answerAsk,
    /** Subscribe to chat-ack / chat-reply / chat-error pushes. */
    onChat(cb) {
      if (typeof cb !== 'function') return () => {};
      chatListeners.add(cb);
      return () => chatListeners.delete(cb);
    },
    /**
     * Subscribe to "the Mac has taken these keys" — the ack of a stage-2
     * upload, with the key names that went up. Screens whose content the Mac
     * computes use it to re-ask for a view their own edit has just changed.
     */
    onSynced(cb) {
      if (typeof cb !== 'function') return () => {};
      syncedListeners.add(cb);
      return () => syncedListeners.delete(cb);
    },
    /**
     * Ask the Mac for a read-only view digest ('insights' | 'news' |
     * 'portfolio'). Resolves with the data or rejects ('offline', 'timed
     * out', or the Mac's own error message). Screens cache the result and
     * render staleness honestly when this rejects.
     */
    requestView,
  };

  document.addEventListener('visibilitychange', onForeground);
  window.addEventListener('focus', onForeground);

  // Wait for the IDB-backed cache to be ready before the initial sync —
  // otherwise the phone's manifest would look empty and we'd ship a
  // first-sync-style empty payload that adopts the Mac's data even when
  // we have real data locally that just hadn't loaded yet.
  const ready = window.__anjadheStoreReady || Promise.resolve();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      ready.then(() => setTimeout(connect, 600));
    });
  } else {
    ready.then(() => setTimeout(connect, 600));
  }
})();
