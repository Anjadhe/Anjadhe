/**
 * channel-endpoint.mjs
 * ====================
 * Connects to the Anjadhe relay and runs an end-to-end-encrypted channel on
 * top of it. The Mac uses `createHostEndpoint`; the phone uses
 * `createClientEndpoint`. Both build on:
 *   - the relay protocol            (relay/server.js)
 *   - the handshake + frame crypto  (secure-channel.mjs)
 *
 * It runs in Node (the Electron main process) and in the iOS WebView — it
 * only uses globals both provide (WebSocket, CompressionStream, btoa).
 *
 * The relay forwards opaque `data` payloads. This module tags each one:
 *   'H' + hex   handshake — ephemeral / static *public* keys (no secrets)
 *   'E' + hex   a SecureChannel-sealed app message
 *   'Z' + b64   the same, gzipped before sealing and base64 on the wire
 *   'C' + …     one chunk of a payload too large for a single relay frame
 *   'P' + json  one-time pairing registration / reply
 * App messages are JSON objects; the relay never sees their plaintext.
 *
 * WHY 'Z' EXISTS (2026-09-20). A sync payload is JSON text — the notes blob
 * compresses about 4:1 — and hex DOUBLES whatever it wraps, so the original
 * 'E' framing put roughly 8x the necessary bytes on the wire. Measured on a
 * 4.1 MB blob: 8.27 MB as 'E' (11 relay frames) against 1.02 MB as 'Z' (2),
 * for 160 ms of gzip on the sender and 4 ms of gunzip on the phone. On a
 * phone that is the difference between a sync you wait for and one you don't.
 *
 * 'Z' is NEGOTIATED, never assumed: each side announces what it accepts in a
 * `__channel-cap` control message as soon as the channel is up, and until
 * that arrives everything goes out as 'E'. A build that predates this file
 * answers an unknown message type harmlessly (main.js `dispatchChannelRequest`
 * returns an error object; the phone's `handleHostMessage` ignores it), so an
 * old Mac and a new phone — or the reverse — keep working at the old size.
 *
 * ORDER IS LOAD-BEARING. `SecureChannel` numbers every frame and rejects any
 * gap, so seal order must equal write order and open order must equal arrival
 * order. Compression is async, which breaks both if it is awaited in the
 * middle. Hence the two queues below: outbound, the seal and the write happen
 * together inside one ordered task; inbound, the frame is OPENED synchronously
 * on arrival (keeping the counter honest) and only the decompress + parse +
 * deliver runs in the ordered tail.
 */
import { startHandshake } from './secure-channel.mjs';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const PUBKEY_HEX = 64; // a 32-byte key encoded as hex

/** The control message both sides send once the channel is up. */
const CAP_TYPE = '__channel-cap';
/** Below this, gzip's header costs more than it saves — send 'E'. */
const COMPRESS_MIN_CHARS = 4096;

const canCompress = typeof CompressionStream === 'function'
  && typeof DecompressionStream === 'function'
  && typeof Response === 'function'
  && typeof btoa === 'function' && typeof atob === 'function';

/** What this build can RECEIVE. Sent to the peer; never inferred. */
const ACCEPTS = canCompress ? ['Z'] : [];

async function gzipBytes(bytes) {
  const cs = new CompressionStream('gzip');
  const stream = new Response(bytes).body.pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzipBytes(bytes) {
  const ds = new DecompressionStream('gzip');
  const stream = new Response(bytes).body.pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// btoa/atob take binary strings, and String.fromCharCode blows the argument
// limit on a multi-megabyte payload — so both directions go in slices.
const B64_SLICE = 0x8000;
function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += B64_SLICE) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + B64_SLICE));
  }
  return btoa(s);
}
function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Seal `obj` into a wire payload. Async because compression is — callers go
 * through `orderedSender` so seal order still equals write order.
 */
async function packMessage(channel, obj, peerAcceptsZ) {
  const json = JSON.stringify(obj);
  if (peerAcceptsZ && canCompress && json.length >= COMPRESS_MIN_CHARS) {
    try {
      const gz = await gzipBytes(enc.encode(json));
      return 'Z' + bytesToB64(channel.seal(gz));
    } catch {
      // Compression is an optimisation; a failure must not drop the message.
    }
  }
  return 'E' + bytesToHex(channel.seal(enc.encode(json)));
}

/**
 * Step 1 of receiving, SYNCHRONOUS so the channel counter stays sequential
 * in arrival order. Throws on a tampered or reordered frame, as before.
 */
function openFrame(channel, tag, body) {
  return channel.open(tag === 'Z' ? b64ToBytes(body) : hexToBytes(body));
}
/** Step 2: decompress (if needed) and parse. Safe to run in an ordered tail. */
async function parseOpened(tag, opened) {
  return JSON.parse(dec.decode(tag === 'Z' ? await gunzipBytes(opened) : opened));
}

/**
 * A serial task queue. Everything that seals, and everything that delivers,
 * runs through one of these so the peer never sees a gap in the counter or a
 * message out of order. A failing task is swallowed here — the layers above
 * (request timeouts, the next sync) own recovery.
 */
function createOrderedQueue() {
  let tail = Promise.resolve();
  return function enqueue(task) {
    tail = tail.then(task).catch(() => { /* one bad frame must not stall the rest */ });
    return tail;
  };
}

/**
 * Build the relay WebSocket URL. The production relay (Cloudflare Workers)
 * routes to a per-room Durable Object by the routing ID in the URL path; the
 * Node relay (relay/server.js) ignores the path and reads the id from the
 * hello frame — so appending it works against both.
 */
function relaySocketUrl(relayUrl, routingId) {
  return relayUrl.replace(/\/+$/, '') + '/' + encodeURIComponent(routingId);
}

/*
 * Frame chunking. The hosted relay (Anjadhe Connect) caps a WebSocket frame
 * at 1 MiB so that parsing a frame's JSON envelope can't stall its shared
 * event loop — but a sealed data-sync payload can run to tens of MiB. Large
 * payloads are split into chunk frames and reassembled by the peer:
 *
 *   'C' + <16-hex chunk id> + <4-hex index> + <4-hex count> + slice
 *
 * The relay forwards chunk frames like any other opaque payload, so this
 * works against the Node dev relay too (which allows 32 MiB frames and
 * simply never sees a chunk in practice for small messages).
 */
const CHUNK_SLICE_CHARS = 800_000; // payload chars per frame — < 1 MiB with the JSON envelope
const CHUNK_HEADER_CHARS = 1 + 16 + 4 + 4;
const MAX_CHUNKS = 0xffff;
const MAX_REASSEMBLY_CHARS = 128 * 1024 * 1024; // 64 MiB of ciphertext, hex-encoded

const hex4 = (n) => n.toString(16).padStart(4, '0');

/** Send `payload` through `sendFrame`, splitting it into chunks if needed. */
function sendChunked(payload, sendFrame) {
  if (payload.length <= CHUNK_SLICE_CHARS) return sendFrame(payload);
  const total = Math.ceil(payload.length / CHUNK_SLICE_CHARS);
  if (total > MAX_CHUNKS) return; // absurd size — drop rather than flood the relay
  const id = bytesToHex(randomBytes(8));
  for (let i = 0; i < total; i++) {
    sendFrame('C' + id + hex4(i) + hex4(total)
      + payload.slice(i * CHUNK_SLICE_CHARS, (i + 1) * CHUNK_SLICE_CHARS));
  }
}

/**
 * Per-peer chunk reassembly. Returns accept(payload, deliver): non-chunk
 * payloads are delivered untouched; chunks are buffered until their payload
 * completes. Bounded — a flood of half-finished assemblies evicts the lot
 * (the sender's request layer retries), and an oversized or inconsistent
 * assembly is dropped whole.
 */
function createReassembler() {
  const pending = new Map(); // chunk id -> { total, got, chars, parts }
  const MAX_PENDING = 8;
  return function accept(payload, deliver) {
    if (payload[0] !== 'C') return deliver(payload);
    if (payload.length <= CHUNK_HEADER_CHARS) return;
    const id = payload.slice(1, 17);
    const index = parseInt(payload.slice(17, 21), 16);
    const total = parseInt(payload.slice(21, 25), 16);
    const part = payload.slice(CHUNK_HEADER_CHARS);
    if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index >= total) return;
    let p = pending.get(id);
    if (!p) {
      if (pending.size >= MAX_PENDING) pending.clear();
      p = { total, got: 0, chars: 0, parts: new Array(total) };
      pending.set(id, p);
    }
    if (p.total !== total || p.parts[index] !== undefined) { pending.delete(id); return; }
    p.parts[index] = part;
    p.got++;
    p.chars += part.length;
    if (p.chars > MAX_REASSEMBLY_CHARS) { pending.delete(id); return; }
    if (p.got === p.total) {
      pending.delete(id);
      deliver(p.parts.join(''));
    }
  };
}

/**
 * Mac side. Registers as `host` for `routingId`, accepts sessions from paired
 * phones, and surfaces decrypted requests through `onRequest`.
 *
 * Long-lived: it reconnects to the relay on its own (exponential backoff with
 * jitter) if the connection drops, until `close()` is called. `ready` resolves
 * on the first successful connection; `isConnected()` reflects the live state.
 *
 *   isPairedPeer(staticPubHex) -> boolean   is this phone paired with us?
 *   onRequest(peerId, message, respond)     respond(obj) sends an encrypted reply
 */
export function createHostEndpoint({ relayUrl, routingId, identity, isPairedPeer, onRequest, onPairing, onPeerLeave }) {
  const sessions = new Map(); // relay clientId -> { channel, peerStatic }

  // Relay reconnection. The connection to the relay can drop at any time —
  // the network changes, the relay restarts, the Mac wakes from sleep. The
  // endpoint reconnects on its own with exponential backoff (1s, 2s, 4s …
  // with the ceiling held near 30s) plus jitter, so a fleet of Macs does not
  // stampede the relay as it comes back. A connection that proves stable
  // resets the backoff.
  const RECONNECT_BASE_MS = 1000;
  const RECONNECT_MAX_MS = 30000;
  const STABLE_MS = 30000; // a connection alive this long is deemed healthy

  let ws = null;
  let closed = false;       // close() was called — stop reconnecting for good
  let connected = false;    // a relay session is live (between welcome & close)
  let reconnecting = false; // a drop has occurred — affects only log wording
  let attempt = 0;          // consecutive failed connects; drives the backoff
  let reconnectTimer = null;
  let stableTimer = null;

  let resolveReady;
  // `ready` resolves on the first successful connection and never rejects —
  // an unreachable relay is a retry state here, not a terminal failure.
  const ready = new Promise((res) => { resolveReady = res; });

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    const ceiling = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    const delay = Math.round(ceiling * (0.5 + Math.random())); // 50–150% jitter
    attempt += 1;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }

  function connect() {
    if (closed) return;
    ws = new WebSocket(relaySocketUrl(relayUrl, routingId));

    ws.addEventListener('open', () => {
      // hostKey proves continuity to the relay (2026-08-05): a live keyed
      // host is only replaced by a reconnect presenting the same key, so a
      // stranger who learns the routing id can no longer evict this Mac.
      // Derived (one-way) from the Noise static public key: deterministic
      // across restarts with nothing new to store, and never the key itself.
      const hostKey = bytesToHex(sha256(identity.publicKey));
      ws.send(JSON.stringify({ t: 'hello', routingId, role: 'host', hostKey }));
    });

    // A failed or dropped connection emits 'error' then 'close'; reconnection
    // is driven from 'close' alone. The 'error' listener must still exist —
    // without one the underlying socket treats the error as unhandled.
    ws.addEventListener('error', () => {});

    ws.addEventListener('close', () => {
      connected = false;
      if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
      // Sessions are bound to this socket, and the relay issues fresh
      // clientIds on reconnect — drop them so phones cleanly re-handshake.
      if (typeof onPeerLeave === 'function') {
        for (const clientId of sessions.keys()) { try { onPeerLeave(clientId); } catch { /* ignore */ } }
      }
      sessions.clear();
      if (!closed) {
        reconnecting = true;
        console.warn('[channel] relay connection lost — reconnecting');
        scheduleReconnect();
      }
    });

    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'welcome') {
        connected = true;
        if (reconnecting) {
          reconnecting = false;
          console.log('[channel] relay connection restored');
        }
        // Reset the backoff only once a connection has proven stable, so a
        // relay that accepts then immediately drops keeps backing off.
        if (stableTimer) clearTimeout(stableTimer);
        stableTimer = setTimeout(() => { attempt = 0; }, STABLE_MS);
        return resolveReady();
      }
      if (m.t === 'peer-join') { if (!sessions.has(m.clientId)) sessions.set(m.clientId, { channel: null }); return; }
      if (m.t === 'peer-leave') {
        sessions.delete(m.clientId);
        if (typeof onPeerLeave === 'function') { try { onPeerLeave(m.clientId); } catch { /* ignore */ } }
        return;
      }
      if (m.t === 'data') return onData(m.from, m.payload);
    });
  }

  function sendRaw(clientId, payload) {
    // While the relay is unreachable, drop the send rather than throw — the
    // phone reissues its request after it reconnects. Payloads too big for
    // one relay frame go out as chunks.
    if (ws && ws.readyState === ws.OPEN) {
      sendChunked(payload, (frame) =>
        ws.send(JSON.stringify({ t: 'data', to: clientId, payload: frame })));
    }
  }

  /**
   * Seal and send an app message to one phone. The seal and the write share
   * one queued task, so the frame counter the phone sees never has a gap —
   * see "ORDER IS LOAD-BEARING" at the top of this file.
   */
  function sendSealed(clientId, sess, message) {
    if (!sess || !sess.channel) return false;
    if (!sess.out) sess.out = createOrderedQueue();
    sess.out(async () => {
      sendRaw(clientId, await packMessage(sess.channel, message, sess.peerAcceptsZ));
    });
    return true;
  }

  function onData(clientId, payload) {
    if (typeof payload !== 'string' || payload.length < 1) return;
    let sess = sessions.get(clientId);
    if (!sess) { sess = { channel: null }; sessions.set(clientId, sess); }
    if (!sess.reasm) sess.reasm = createReassembler();
    sess.reasm(payload, (full) => handlePayload(clientId, sess, full));
  }

  function handlePayload(clientId, sess, payload) {
    const tag = payload[0];
    const body = payload.slice(1);

    if (tag === 'H') {
      // The phone's handshake: clientStaticPub || clientEphemeralPub.
      const clientStatic = body.slice(0, PUBKEY_HEX);
      const clientEph = body.slice(PUBKEY_HEX, PUBKEY_HEX * 2);
      if (clientStatic.length !== PUBKEY_HEX || clientEph.length !== PUBKEY_HEX) return;
      if (!isPairedPeer(clientStatic)) return; // unknown phone — ignore
      const hs = startHandshake(identity, clientStatic, 'responder');
      sess.channel = hs.complete(clientEph);
      sess.peerStatic = clientStatic;
      sess.peerAcceptsZ = false;
      sess.out = createOrderedQueue();
      sess.in = createOrderedQueue();
      sendRaw(clientId, 'H' + bytesToHex(hs.ephemeralPublicKey));
      // Announce what we can receive. Plain 'E' — the peer has told us
      // nothing yet, and this message is far too small to compress anyway.
      sendSealed(clientId, sess, { type: CAP_TYPE, accepts: ACCEPTS });
    } else if (tag === 'E' || tag === 'Z') {
      if (!sess.channel) return;
      let opened;
      // Opened HERE, synchronously, so the counter follows arrival order.
      try { opened = openFrame(sess.channel, tag, body); }
      catch { return; } // tampered / replayed — rejected by the AEAD
      if (!sess.in) sess.in = createOrderedQueue();
      sess.in(async () => {
        let message;
        try { message = await parseOpened(tag, opened); }
        catch { return; }
        if (message && message.type === CAP_TYPE) {
          sess.peerAcceptsZ = Array.isArray(message.accepts) && message.accepts.includes('Z');
          return; // a channel control message, never an app request
        }
        // The fourth argument names the peer by its static key (hex) — a room
        // hosting several contacts (js/channel/peer-channel.mjs) needs it;
        // the phone channel ignores it.
        onRequest(clientId, message, (reply) => sendSealed(clientId, sess, reply), sess.peerStatic);
      });
    } else if (tag === 'P') {
      // One-time pairing: the phone proves it scanned the QR. Body is JSON;
      // the pairing proof itself is verified by the caller's onPairing.
      if (!onPairing) return;
      let registration;
      try { registration = JSON.parse(body); } catch { return; }
      onPairing(clientId, registration, (reply) => sendRaw(clientId, 'P' + JSON.stringify(reply)));
    }
  }

  connect();

  return {
    ready,
    /** True while a live relay session is established. */
    isConnected: () => connected,
    /** Push an unsolicited encrypted message to a connected phone. */
    sendTo(clientId, message) {
      return sendSealed(clientId, sessions.get(clientId), message);
    },
    /**
     * Push an unsolicited encrypted message to every connected paired
     * phone whose handshake has completed. Used by the Mac to notify
     * phones that their data is stale (the Mac just wrote something) so
     * they can pull fresh state instead of waiting for the next launch.
     * Returns the number of peers the message reached.
     */
    broadcastToPeers(message) {
      let n = 0;
      for (const [clientId, sess] of sessions) {
        if (sendSealed(clientId, sess, message)) n++;
      }
      return n;
    },
    close() {
      closed = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
      if (ws) { try { ws.close(); } catch { /* already closing */ } }
    },
  };
}

/**
 * Phone side. Connects as `client` for `routingId`, runs the handshake with
 * the Mac (whose static key it learned at pairing), then exchanges encrypted
 * messages. `ready` resolves once the channel is established.
 */
export function createClientEndpoint({ relayUrl, routingId, identity, hostStaticPub, onMessage, onClose }) {
  const ws = new WebSocket(relaySocketUrl(relayUrl, routingId));
  const reasm = createReassembler();
  const outQueue = createOrderedQueue();
  const inQueue = createOrderedQueue();
  let handshake = null;
  let channel = null;
  let peerAcceptsZ = false; // until the Mac says otherwise, send 'E'
  let closeFired = false; // guard so onClose runs at most once

  /** Seal + write as one ordered task (see "ORDER IS LOAD-BEARING" above). */
  function sendSealed(message) {
    return outQueue(async () => {
      const payload = await packMessage(channel, message, peerAcceptsZ);
      sendChunked(payload, (frame) => ws.send(JSON.stringify({ t: 'data', payload: frame })));
    });
  }

  let resolveReady, rejectReady;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });

  function fireClose() {
    if (closeFired) return;
    closeFired = true;
    rejectReady(new Error('client: relay connection closed'));
    if (typeof onClose === 'function') { try { onClose(); } catch {} }
  }

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ t: 'hello', routingId, role: 'client' }));
  });
  ws.addEventListener('error', () => rejectReady(new Error('client: relay connection failed')));
  // Both a local close() and a relay-side drop land here. The mobile sync
  // uses onClose to drive reconnect, and we want it to fire either way.
  ws.addEventListener('close', (ev) => {
    // Name the close so the phone's connection log can say WHY the relay
    // hung up (its own {t:'error'} message, else the close code/reason).
    if (!closeFired && !channel) {
      rejectReady(new Error('client: relay connection closed'
        + (relayError ? ' — ' + relayError : (ev && ev.code ? ' (code ' + ev.code + (ev.reason ? ' ' + ev.reason : '') + ')' : ''))));
    }
    fireClose();
  });
  let relayError = null;
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'error') { relayError = String(m.message || 'relay error'); return; }
    if (m.t === 'host-state' && m.online === false) { relayError = 'your Mac is not connected to the relay'; return; }
    if (m.t === 'welcome') {
      // Begin the handshake: send our static + ephemeral public keys.
      handshake = startHandshake(identity, hostStaticPub, 'initiator');
      ws.send(JSON.stringify({
        t: 'data',
        payload: 'H' + bytesToHex(identity.publicKey) + bytesToHex(handshake.ephemeralPublicKey),
      }));
      return;
    }
    if (m.t === 'data' && typeof m.payload === 'string' && m.payload.length >= 1) {
      reasm(m.payload, (payload) => {
        const tag = payload[0];
        const body = payload.slice(1);
        if (tag === 'H' && handshake && !channel) {
          channel = handshake.complete(body); // the Mac's ephemeral public key
          resolveReady();
          sendSealed({ type: CAP_TYPE, accepts: ACCEPTS });
        } else if ((tag === 'E' || tag === 'Z') && channel) {
          let opened;
          // Opened HERE, synchronously, so the counter follows arrival order.
          try { opened = openFrame(channel, tag, body); }
          catch { return; } // tampered / replayed — dropped
          inQueue(async () => {
            let message;
            try { message = await parseOpened(tag, opened); }
            catch { return; }
            if (message && message.type === CAP_TYPE) {
              peerAcceptsZ = Array.isArray(message.accepts) && message.accepts.includes('Z');
              return; // a channel control message, never an app message
            }
            onMessage(message);
          });
        }
      });
    }
  });

  return {
    ready,
    send(message) {
      if (!channel) throw new Error('client: channel not established yet');
      sendSealed(message);
    },
    close: () => { try { ws.close(); } catch {} },
  };
}

/**
 * Phone side, one-time pairing. After the QR scan, sends the pairing
 * registration to the Mac over the relay and resolves with the Mac's reply
 * (`{ ok, ... }`). Short-lived — the connection closes itself when done.
 */
export function createPairingClient({ relayUrl, routingId, registration }) {
  const ws = new WebSocket(relaySocketUrl(relayUrl, routingId));
  let resolveResult, rejectResult;
  const result = new Promise((res, rej) => { resolveResult = res; rejectResult = rej; });

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ t: 'hello', routingId, role: 'client' }));
  });
  ws.addEventListener('error', () => rejectResult(new Error('pairing: relay connection failed')));
  ws.addEventListener('close', () => rejectResult(new Error('pairing: relay connection closed' + (pairError ? ' — ' + pairError : ''))));
  let pairError = null;
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'error') { pairError = String(m.message || 'relay error'); return; }
    if (m.t === 'welcome') {
      ws.send(JSON.stringify({ t: 'data', payload: 'P' + JSON.stringify(registration) }));
      return;
    }
    if (m.t === 'data' && typeof m.payload === 'string' && m.payload[0] === 'P') {
      try { resolveResult(JSON.parse(m.payload.slice(1))); }
      catch { rejectResult(new Error('pairing: malformed reply')); }
      ws.close();
    }
  });

  return { result, close: () => ws.close() };
}
