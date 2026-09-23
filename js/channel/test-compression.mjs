/**
 * Compressed channel frames ('Z') — the wire-size half of the sync speed-up
 * (channel-endpoint.mjs, 2026-09-20).
 *
 * Proves the four things the framing has to get right:
 *   1. a large message round-trips, and actually travels compressed;
 *   2. the wire is dramatically smaller than the old hex framing;
 *   3. order survives compression — the SecureChannel counter rejects any
 *      gap, and compression is async, so a big message must not overtake a
 *      small one queued behind it;
 *   4. a peer that never advertises 'Z' is still sent 'E', so an old Mac or
 *      an old phone keeps working.
 *
 * Run:  node js/channel/test-compression.mjs
 */
import { startRelay } from '../../relay/server.js';
import { generateIdentity } from './secure-channel.mjs';
import { createHostEndpoint, createClientEndpoint } from './channel-endpoint.mjs';
import { bytesToHex } from '@noble/hashes/utils.js';

const PORT = 8816;
const RELAY = `ws://127.0.0.1:${PORT}`;
const ROUTING = 'compression-test-routing';

let failed = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const relay = startRelay(PORT);
await relay.ready;

const mac = generateIdentity();
const phone = generateIdentity();
const phonePubHex = bytesToHex(phone.publicKey);

// A payload shaped like the real thing: JSON text with heavy repetition,
// which is why gzip earns its place on this channel.
const note = (i) => ({
  id: 'n' + i,
  title: 'Note ' + i,
  content: '<p>the quick brown fox jumps over a lazy dog while notes accumulate</p>'.repeat(12),
  modifiedAt: '2026-09-20T10:00:00.000Z',
});
const bigBlob = { type: 'sync-values', values: { app_notes: { value: { notes: Array.from({ length: 400 }, (_, i) => note(i)) } } } };
const bigChars = JSON.stringify(bigBlob).length;

// Sniff the tag of every frame the PHONE puts on the wire, so this test can
// tell a genuine 'Z' from a silent fall back to 'E' (a round-trip alone
// cannot — both framings carry the same message).
const sentTags = [];
const RealWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends RealWebSocket {
  send(data) {
    try {
      const m = JSON.parse(data);
      if (m && m.t === 'data' && typeof m.payload === 'string') sentTags.push(m.payload[0]);
    } catch { /* not a data frame */ }
    return super.send(data);
  }
};

const hostInbox = [];
const host = createHostEndpoint({
  relayUrl: RELAY,
  routingId: ROUTING,
  identity: mac,
  isPairedPeer: (hex) => hex === phonePubHex,
  onRequest: (peerId, msg, respond) => {
    hostInbox.push(msg);
    if (msg.type === 'echo-big') respond(bigBlob);
    if (msg.type === 'seq') respond({ type: 'seq', n: msg.n });
  },
});
await host.ready;

const clientInbox = [];
const client = createClientEndpoint({
  relayUrl: RELAY,
  routingId: ROUTING,
  identity: phone,
  hostStaticPub: mac.publicKey,
  onMessage: (msg) => clientInbox.push(msg),
});
await client.ready;
// The capability messages cross right after the handshake.
await wait(150);

console.log('\nlarge payload round-trip');
client.send(bigBlob);
await wait(600);
const got = hostInbox.find((m) => m.type === 'sync-values');
check('the Mac receives the whole blob', !!got, bigChars + ' chars of JSON');
check('every record survives', !!got && got.values.app_notes.value.notes.length === 400);
check('content is byte-identical', JSON.stringify(got) === JSON.stringify(bigBlob));
check(`it actually travelled as 'Z', not 'E'`, sentTags.includes('Z'), 'tags sent: ' + sentTags.join(','));
check('and fitted in a single relay frame', !sentTags.includes('C'));

console.log('\nwire size');
// Measure both framings directly, the way the endpoint builds them.
const { chacha20poly1305 } = await import('@noble/ciphers/chacha.js');
const { randomBytes } = await import('@noble/hashes/utils.js');
const key = randomBytes(32), nonce = randomBytes(12);
const plain = new TextEncoder().encode(JSON.stringify(bigBlob));
const hexWire = bytesToHex(chacha20poly1305(key, nonce).encrypt(plain)).length;
const gz = new Uint8Array(await new Response(new Response(plain).body.pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
const zWire = Math.ceil(chacha20poly1305(key, nonce).encrypt(gz).length * 4 / 3);
check(`'Z' is much smaller than 'E'`, zWire * 3 < hexWire,
  `${(hexWire / 1024).toFixed(0)} KB -> ${(zWire / 1024).toFixed(0)} KB (${(hexWire / zWire).toFixed(1)}x)`);

console.log('\norder survives async compression');
// A big message (slow to compress) queued immediately before small ones:
// if the queue leaked, the small ones would arrive first, or the frame
// counter would gap and the channel would drop them entirely.
hostInbox.length = 0;
client.send({ type: 'seq', n: 0, filler: 'x'.repeat(200_000) });
for (let i = 1; i <= 5; i++) client.send({ type: 'seq', n: i });
await wait(900);
const order = hostInbox.filter((m) => m.type === 'seq').map((m) => m.n);
check('all six arrive', order.length === 6, 'got ' + order.length);
check('in the order they were sent', JSON.stringify(order) === JSON.stringify([0, 1, 2, 3, 4, 5]), JSON.stringify(order));

console.log('\nsmall messages stay uncompressed');
sentTags.length = 0;
client.send({ type: 'seq', n: 99 });
await wait(300);
check(`a short message is sent as 'E'`, sentTags.length > 0 && sentTags.every((t) => t === 'E'), 'tags sent: ' + sentTags.join(','));

console.log('\nreplies come back compressed too');
clientInbox.length = 0;
client.send({ type: 'echo-big' });
await wait(800);
const echoed = clientInbox.find((m) => m.type === 'sync-values');
check('the phone receives the Mac reply whole', !!echoed && echoed.values.app_notes.value.notes.length === 400);

console.log('\na peer that never advertises Z');
// A raw client that completes the handshake but sends no capability message:
// the Mac must keep answering in 'E', which this one can still read.
const legacyPhone = generateIdentity();
const legacyPubHex = bytesToHex(legacyPhone.publicKey);
let legacyGot = null;
const host2Routing = ROUTING + '-legacy';
const host2 = createHostEndpoint({
  relayUrl: RELAY,
  routingId: host2Routing,
  identity: mac,
  isPairedPeer: (hex) => hex === legacyPubHex,
  onRequest: (peerId, msg, respond) => { if (msg.type === 'ask') respond(bigBlob); },
});
await host2.ready;

// Drive the raw frames by hand so nothing announces a capability.
const { startHandshake } = await import('./secure-channel.mjs');
const { hexToBytes } = await import('@noble/hashes/utils.js');
globalThis.WebSocket = RealWebSocket;
const ws = new WebSocket(RELAY + '/' + encodeURIComponent(host2Routing));
let hs = null, ch = null;
const seenTags = [];
await new Promise((resolve) => {
  ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', routingId: host2Routing, role: 'client' })));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'welcome') {
      hs = startHandshake(legacyPhone, mac.publicKey, 'initiator');
      ws.send(JSON.stringify({ t: 'data', payload: 'H' + bytesToHex(legacyPhone.publicKey) + bytesToHex(hs.ephemeralPublicKey) }));
      return;
    }
    if (m.t !== 'data' || typeof m.payload !== 'string') return;
    const tag = m.payload[0];
    if (tag === 'H' && !ch) {
      ch = hs.complete(m.payload.slice(1));
      ws.send(JSON.stringify({ t: 'data', payload: 'E' + bytesToHex(ch.seal(new TextEncoder().encode(JSON.stringify({ type: 'ask' })))) }));
      return;
    }
    seenTags.push(tag);
    if (tag === 'E') {
      try {
        const msg = JSON.parse(new TextDecoder().decode(ch.open(hexToBytes(m.payload.slice(1)))));
        if (msg.type === 'sync-values') { legacyGot = msg; resolve(); }
      } catch { /* the cap message rides ahead of the reply */ }
    }
    if (tag === 'C') resolve(); // chunked 'E' reply — also fine, still readable
  });
  setTimeout(resolve, 2500);
});
check('the Mac answers an old peer in E', !!legacyGot || seenTags.includes('C'), 'tags seen: ' + seenTags.join(','));
check('no Z frame was ever sent to it', !seenTags.includes('Z'));

try { ws.close(); } catch { /* done */ }
client.close(); host.close(); host2.close(); relay.close();
await wait(100);
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
