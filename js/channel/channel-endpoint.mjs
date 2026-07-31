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
 * only uses the global WebSocket, which both provide.
 *
 * The relay forwards opaque `data` payloads. This module tags each one:
 *   'H' + hex   handshake — ephemeral / static *public* keys (no secrets)
 *   'E' + hex   a SecureChannel-sealed app message
 *   'C' + …     one chunk of a payload too large for a single relay frame
 * App messages are JSON objects; the relay never sees their plaintext.
 */
import { startHandshake } from './secure-channel.mjs';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const PUBKEY_HEX = 64; // a 32-byte key encoded as hex

function packMessage(channel, obj) {
  return 'E' + bytesToHex(channel.seal(enc.encode(JSON.stringify(obj))));
}
function unpackMessage(channel, body) {
  return JSON.parse(dec.decode(channel.open(hexToBytes(body))));
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
export function createHostEndpoint({ relayUrl, routingId, identity, isPairedPeer, onRequest, onPairing }) {
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
      ws.send(JSON.stringify({ t: 'hello', routingId, role: 'host' }));
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
      if (m.t === 'peer-leave') { sessions.delete(m.clientId); return; }
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
      sendRaw(clientId, 'H' + bytesToHex(hs.ephemeralPublicKey));
    } else if (tag === 'E') {
      if (!sess.channel) return;
      let message;
      try { message = unpackMessage(sess.channel, body); }
      catch { return; } // tampered / replayed — rejected by the AEAD
      onRequest(clientId, message, (reply) => sendRaw(clientId, packMessage(sess.channel, reply)));
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
      const sess = sessions.get(clientId);
      if (sess && sess.channel) sendRaw(clientId, packMessage(sess.channel, message));
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
        if (sess && sess.channel) {
          sendRaw(clientId, packMessage(sess.channel, message));
          n++;
        }
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
  let handshake = null;
  let channel = null;
  let closeFired = false; // guard so onClose runs at most once

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
  ws.addEventListener('close', fireClose);
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
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
        } else if (tag === 'E' && channel) {
          try { onMessage(unpackMessage(channel, body)); }
          catch { /* tampered / replayed — dropped */ }
        }
      });
    }
  });

  return {
    ready,
    send(message) {
      if (!channel) throw new Error('client: channel not established yet');
      sendChunked(packMessage(channel, message), (frame) =>
        ws.send(JSON.stringify({ t: 'data', payload: frame })));
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
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
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
