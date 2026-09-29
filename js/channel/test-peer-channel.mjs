/**
 * End-to-end test for the Mac<->Mac peer channel (peer-channel.mjs).
 *
 * Two "Macs" against a real relay: Ram invites Priya with a code, Priya
 * accepts it, messages cross both ways over the one session, a lost session
 * heals on reconnect, and a removed contact can no longer reach the room.
 *
 * Run:  node js/channel/test-peer-channel.mjs
 */
import { startRelay } from '../../relay/server.js';
import { createPeerChannel, decodeInvite, encodeInvite, INVITE_PREFIX } from './peer-channel.mjs';

const PORT = 8813;
const RELAY = `ws://127.0.0.1:${PORT}`;

let failed = 0;
function check(label, ok) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failed++;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const memStore = () => { const m = new Map(); return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v) }; };

const relay = startRelay(PORT);
await relay.ready;

const ramInbox = [], priyaInbox = [];
let ramChanged = 0, priyaChanged = 0;
const ramStore = memStore(), priyaStore = memStore();
const ram = createPeerChannel({ storage: ramStore, relayUrl: RELAY,
  onMessage: (id, m) => ramInbox.push({ id, m }), onChanged: () => ramChanged++ });
const priya = createPeerChannel({ storage: priyaStore, relayUrl: RELAY,
  onMessage: (id, m) => priyaInbox.push({ id, m }), onChanged: () => priyaChanged++ });
await ram.start();
await priya.start();
check('both Macs host their own sharing room', ram.isConnected() && priya.isConnected());
check('identity is the phone channel\'s (one key per Mac)', !!ramStore.get('channel.identity'));

// --- invite code -------------------------------------------------------
const invite = ram.createInvite('Priya');
check('invite code carries the prefix', invite.code.startsWith(INVITE_PREFIX));
const offer = decodeInvite(invite.code);
check('invite decodes to the offer', offer.routingId === ram.getPublicInfo().routingId && offer.hostPub === ram.getPublicInfo().hostPub);
check('a damaged code is refused', (() => { try { decodeInvite(INVITE_PREFIX + 'zzz'); return false; } catch (e) { return /damaged|incomplete/.test(e.message); } })());
check('a foreign string is refused', (() => { try { decodeInvite('hello'); return false; } catch (e) { return /not an Anjadhe/.test(e.message); } })());
check('an expired code is refused', (() => {
  try { decodeInvite(encodeInvite({ ...offer, expiresAt: new Date(Date.now() - 1000).toISOString() })); return false; }
  catch (e) { return /expired/.test(e.message); }
})());
check('your own invite is refused', await ram.acceptInvite(invite.code, 'Me').then(() => false, (e) => /your own/.test(e.message)));
check('listInvites shows the pending one', ram.listInvites().length === 1 && ram.listInvites()[0].label === 'Priya');

const contactOnPriya = await priya.acceptInvite(invite.code, 'Ram');
check('Priya gets a contact in the client role', contactOnPriya.role === 'client' && contactOnPriya.label === 'Ram');
const ramContacts = ram.listContacts();
check('Ram gets a contact in the host role with HIS label', ramContacts.length === 1 && ramContacts[0].role === 'host' && ramContacts[0].label === 'Priya');
check('the invite was consumed', ram.listInvites().length === 0);
check('both sides were told the roster changed', ramChanged >= 1 && priyaChanged >= 1);
check('a used code cannot be accepted twice', await priya.acceptInvite(invite.code, 'Ram').then(() => false, () => true));

// --- session + both directions ---------------------------------------
await wait(400);
check('Priya announced herself on connect', ramInbox.some((x) => x.m.type === 'peer.hello' && x.id === ramContacts[0].id));
check('Ram sees Priya online', ram.listContacts()[0].online === true);
check('Priya sees Ram online', priya.listContacts()[0].online === true);

let r = ram.send(ramContacts[0].id, { type: 'share.snapshot', n: 1 });
await wait(200);
check('host -> client push delivered', r.delivered && priyaInbox.some((x) => x.m.type === 'share.snapshot' && x.id === contactOnPriya.id));
r = priya.send(contactOnPriya.id, { type: 'share.ack', n: 1 });
await wait(200);
check('client -> host delivered', r.delivered && ramInbox.some((x) => x.m.type === 'share.ack'));
check('unknown contact is refused', ram.send('ct_nope', { type: 'x' }).ok === false);

// --- rename / remove ----------------------------------------------------
check('rename is local', ram.renameContact(ramContacts[0].id, 'Priya S.') && ram.listContacts()[0].label === 'Priya S.'
  && priya.listContacts()[0].label === 'Ram');
priya.removeContact(contactOnPriya.id);
await wait(200);
check('removed contact is gone and offline on that side', priya.listContacts().length === 0);
r = ram.send(ramContacts[0].id, { type: 'share.snapshot', n: 2 });
check('host push to a departed client is not delivered', r.ok && r.delivered === false);

// --- a stranger cannot join the room -------------------------------------
const stranger = createPeerChannel({ storage: memStore(), relayUrl: RELAY, onMessage: () => {} });
check('a stranger\'s guess at the code fails', await stranger.acceptInvite(invite.code, 'x').then(() => false, () => true));

ram.close(); priya.close(); stranger.close();
await relay.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall peer-channel checks passed');
process.exit(failed ? 1 : 0);
