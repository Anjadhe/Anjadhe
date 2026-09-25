/**
 * Smoke test for a *running* relay, over the wire.
 *
 * Unlike the js/channel/test-*.mjs suites (which start the Node relay
 * in-process), this drives the real channel endpoints against a relay that is
 * already serving — so it exercises the actual routing, upgrade handling and
 * frame limits a phone would meet.
 *
 * Run:  node relay/server.js                              # serves :8787
 *       node relay/worker/smoke.mjs                       # in another shell
 *
 * Override the target with RELAY_URL — a staging deployment is fine:
 *
 *       RELAY_URL=wss://<staging-host>/v1/relay node relay/worker/smoke.mjs
 *
 * Production is the one target that needs ALLOW_PROD_RELAY=1, because every
 * run adds one Mac connect and two phone connects to the ops counters, where
 * they are indistinguishable from real devices on the /admin dashboard.
 */
import { generateIdentity } from '../../js/channel/secure-channel.mjs';
import { createHostEndpoint, createClientEndpoint } from '../../js/channel/channel-endpoint.mjs';
import { bytesToHex } from '@noble/hashes/utils.js';

const RELAY = process.env.RELAY_URL || 'ws://127.0.0.1:8787';
const HTTP = RELAY.replace(/^ws/, 'http');
const ROUTING = 'worker-smoke-' + Date.now().toString(36);

// Every run books 1 Mac + 2 phone connects in the target's daily counters,
// where they look exactly like real devices. Against production that
// corrupts the only usage history the service has, so it takes an explicit
// flag; local and staging are free to hit.
const PROD_HOSTS = new Set(['api.anjadhe.com']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const relayHost = (() => {
  try { return new URL(HTTP).hostname; } catch { return ''; }
})();
if (PROD_HOSTS.has(relayHost) && !process.env.ALLOW_PROD_RELAY) {
  console.error(`Refusing to smoke-test ${RELAY} — that is production.\n`
    + '  This run would add 1 Mac + 2 phone connects to the /admin counters,\n'
    + '  indistinguishable from real devices.\n\n'
    + '  Local:    node relay/server.js   (then re-run this with no RELAY_URL)\n'
    + '  Staging:  RELAY_URL=wss://<staging-host>/v1/relay node relay/worker/smoke.mjs\n'
    + '  Anyway:   ALLOW_PROD_RELAY=1 RELAY_URL=' + RELAY + ' node relay/worker/smoke.mjs\n');
  process.exit(2);
}
if (!LOCAL_HOSTS.has(relayHost)) {
  console.log(`! smoke-testing the deployed relay at ${RELAY}\n`
    + '! this run adds 1 Mac + 2 phone connects to its /admin counters\n');
}

let failed = 0;
function check(label, ok) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failed++;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. liveness — always at the ORIGIN's /healthz, so this works both for the
// dev relay (serves at the root) and for Anjadhe Connect (relay lives under
// /v1/relay but health is the service-wide /healthz).
try {
  const res = await fetch(new URL('/healthz', HTTP));
  check('GET /healthz returns ok', res.ok);
} catch {
  check('GET /healthz returns ok', false);
  console.error(`  could not reach the relay at ${HTTP} — is it running?`);
}

// 2. a paired Mac + phone round-trip an encrypted message through the relay
const mac = generateIdentity();
const phone = generateIdentity();
const phonePubHex = bytesToHex(phone.publicKey);

const hostInbox = [];
let macPeerId = null;
const host = createHostEndpoint({
  relayUrl: RELAY,
  routingId: ROUTING,
  identity: mac,
  isPairedPeer: (hex) => hex === phonePubHex,
  onRequest: (peerId, msg, respond) => {
    macPeerId = peerId;
    hostInbox.push(msg);
    if (msg.type === 'ping') respond({ type: 'pong', text: msg.text });
  },
});
await host.ready;
check('Mac host registers with the relay', true);

const clientInbox = [];
const client = createClientEndpoint({
  relayUrl: RELAY,
  routingId: ROUTING,
  identity: phone,
  hostStaticPub: mac.publicKey,
  onMessage: (msg) => clientInbox.push(msg),
});
await client.ready;
check('phone completes the handshake through the relay', true);

client.send({ type: 'ping', text: 'hello' });
await wait(300);
check('encrypted request round-trips',
  hostInbox.length === 1 && clientInbox.length === 1
  && clientInbox[0].type === 'pong' && clientInbox[0].text === 'hello');

host.sendTo(macPeerId, { type: 'push', text: 'from the Mac' });
await wait(300);
check('Mac can push an encrypted message to the phone',
  clientInbox.length === 2 && clientInbox[1].type === 'push');

// 3. an unpaired phone must not be able to establish a channel
const stranger = generateIdentity();
const strangerClient = createClientEndpoint({
  relayUrl: RELAY, routingId: ROUTING, identity: stranger,
  hostStaticPub: mac.publicKey, onMessage: () => {},
});
const outcome = await Promise.race([
  strangerClient.ready.then(() => 'connected', () => 'blocked'),
  wait(1800).then(() => 'blocked'),
]);
check('an unpaired phone cannot establish a channel', outcome === 'blocked');

strangerClient.close();
client.close();
host.close();
console.log(failed ? `\n${failed} RELAY SMOKE CHECK(S) FAILED\n` : '\nALL RELAY SMOKE CHECKS PASSED\n');
process.exit(failed ? 1 : 0);
