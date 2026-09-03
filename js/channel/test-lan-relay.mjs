/**
 * Test for the embedded LAN relay + the dual-relay desktop channel.
 *
 * Verifies the LAN-direct architecture (2026-08-31): the Mac hosts its own
 * relay on the LAN and registers as host on BOTH it and the hosted relay;
 * a phone that reaches the LAN relay pairs, syncs and receives pushes
 * exactly as it would through the hosted one, and the pairing offer / sync
 * replies advertise the LAN addresses. Also pins the LAN relay's
 * loopback-only host rule at the unit level.
 *
 * Run:  node js/channel/test-lan-relay.mjs
 */
import { startRelay } from '../../relay/server.js';
import { startLanRelay } from './lan-relay.mjs';
import { generateIdentity, acceptPairingOffer, createPairingOffer } from './secure-channel.mjs';
import { createClientEndpoint, createPairingClient } from './channel-endpoint.mjs';
import { createDesktopChannel } from './desktop-channel.mjs';

const HOSTED_PORT = 8841;
const HOSTED = `ws://127.0.0.1:${HOSTED_PORT}`;

let failed = 0;
function check(label, ok) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failed++;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeStorage() {
  const m = new Map();
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, v); } };
}

// --- both relays up ------------------------------------------------------
const hosted = startRelay(HOSTED_PORT);
await hosted.ready;
const lan = startLanRelay(0); // ephemeral — the port is advertised, never assumed
const lanPort = await lan.ready;
check('LAN relay binds an ephemeral port', lanPort > 0 && lan.port() === lanPort);
const LAN = `ws://127.0.0.1:${lanPort}`;

// --- the desktop registers on both --------------------------------------
const storage = makeStorage();
const requests = [];
const desktop = createDesktopChannel({
  storage,
  relayUrl: HOSTED,
  lanRelayUrl: LAN,
  getLanUrls: () => [`ws://192.0.2.10:${lanPort}`, LAN], // what a phone would dial
  onRequest: (msg) => {
    requests.push(msg);
    // Mirror main.js: sync replies carry the current LAN urls in-band.
    return { type: 'pong', text: msg.text, lanUrls: [LAN] };
  },
});
await desktop.start();
check('desktop channel starts with both relays', desktop.isConnected() === true);

const info = desktop.getPublicInfo();
check('public info advertises the LAN urls',
  Array.isArray(info.lanUrls) && info.lanUrls.includes(LAN));

// --- the pairing offer carries the LAN urls -----------------------------
const phone = generateIdentity();
const offer = desktop.beginPairing();
check('pairing offer carries lanUrls', Array.isArray(offer.lanUrls) && offer.lanUrls.length === 2);

// The phone stores them in its pairing record for the connect ladder.
const { registration, pairing } = acceptPairingOffer(offer, phone);
check('phone pairing record keeps lanUrls',
  Array.isArray(pairing.lanUrls) && pairing.lanUrls.includes(LAN));

// --- pairing OVER THE LAN RELAY (no hosted relay involved) --------------
const pairResult = await createPairingClient({
  relayUrl: LAN, routingId: pairing.routingId, registration,
}).result;
check('pairing completes over the LAN relay', pairResult.ok === true);
check('desktop lists the paired phone', desktop.listPairedDevices().length === 1);

// --- a session over the LAN relay ---------------------------------------
const inbox = [];
const session = createClientEndpoint({
  relayUrl: LAN, routingId: pairing.routingId, identity: phone,
  hostStaticPub: pairing.hostPub, onMessage: (m) => inbox.push(m),
});
await session.ready;
session.send({ type: 'ping', text: 'over the lan' });
await wait(200);
check('desktop dispatcher serves a LAN-relay session',
  requests.length === 1 && requests[0].text === 'over the lan');
check('phone receives the reply with in-band lanUrls',
  inbox.length === 1 && inbox[0].type === 'pong'
  && Array.isArray(inbox[0].lanUrls) && inbox[0].lanUrls[0] === LAN);

// --- and a second phone on the HOSTED relay at the same time ------------
const phone2 = generateIdentity();
const offer2 = desktop.beginPairing();
const acc2 = acceptPairingOffer(offer2, phone2);
await createPairingClient({
  relayUrl: HOSTED, routingId: acc2.pairing.routingId, registration: acc2.registration,
}).result;
const inbox2 = [];
const session2 = createClientEndpoint({
  relayUrl: HOSTED, routingId: acc2.pairing.routingId, identity: phone2,
  hostStaticPub: acc2.pairing.hostPub, onMessage: (m) => inbox2.push(m),
});
await session2.ready;

// --- broadcast reaches peers on BOTH relays, each exactly once ----------
const reached = desktop.broadcastToPeers({ type: 'data-changed', keys: ['app_schedule'] });
check('broadcast reaches one peer per relay', reached === 2);
await wait(200);
check('LAN-relay phone got the push',
  inbox.some((m) => m.type === 'data-changed'));
check('hosted-relay phone got the push',
  inbox2.some((m) => m.type === 'data-changed'));

session.close();
session2.close();
desktop.close();

// --- LAN relay refuses the host role from a non-loopback address --------
// Every socket in this test IS loopback, so pin the rule at the unit
// level: a non-loopback remoteAddress must be rejected for role:host.
// (The regexp is the gate startLanRelay applies to req.socket.remoteAddress.)
const LOOPBACK_RX = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;
check('loopback matcher accepts 127.0.0.1 / ::1 / mapped',
  LOOPBACK_RX.test('127.0.0.1') && LOOPBACK_RX.test('::1') && LOOPBACK_RX.test('::ffff:127.0.0.1'));
check('loopback matcher rejects LAN and spoof-shaped addresses',
  !LOOPBACK_RX.test('192.168.1.20') && !LOOPBACK_RX.test('10.0.0.5')
  && !LOOPBACK_RX.test('1127.0.0.1') && !LOOPBACK_RX.test('::ffff:192.168.1.20'));

// --- offer builder ignores junk lanUrls ---------------------------------
const mac = generateIdentity();
const junkOffer = createPairingOffer(mac, {
  relayUrl: HOSTED,
  lanUrls: ['ws://ok:1', 42, 'http://not-ws', 'wss://ok:2', 'ws://3', 'ws://4', 'ws://5'],
}).offer;
check('offer keeps only ws(s) urls, capped at 4',
  junkOffer.lanUrls.length === 4 && junkOffer.lanUrls.every((u) => /^wss?:/.test(u)));
const noLan = createPairingOffer(mac, { relayUrl: HOSTED }).offer;
check('offer omits lanUrls when there are none', !('lanUrls' in noLan));

lan.close();
hosted.close();
console.log(failed ? `\n${failed} CHECK(S) FAILED\n` : '\nALL LAN-RELAY CHECKS PASSED\n');
process.exit(failed ? 1 : 0);
