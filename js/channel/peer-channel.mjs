/**
 * peer-channel.mjs — Mac<->Mac contacts over the Connect relay.
 * ==============================================================
 * The sibling of desktop-channel.mjs for OTHER PEOPLE's Macs
 * (docs/PEER_PROTOCOL.md layer 1 + 2, first used by docs/PORTFOLIO_SHARING.md).
 * Same crypto (secure-channel.mjs), same relay endpoints
 * (channel-endpoint.mjs), same injected synchronous storage. What differs:
 *
 *  - PAIRING IS AN INVITE CODE, not a QR scan. The inviter mints an offer
 *    (relay url, this Mac's sharing room id, static public key, one-time
 *    pairing secret) and hands the code to the other person over whatever
 *    they already trust (iMessage, in person). The invitee pastes it; the
 *    HMAC proof over the secret makes them a CONTACT on both sides.
 *  - A CONTACT IS A KEY WITH A LOCAL LABEL. The label is whatever each side
 *    typed, never something the peer asserted. Contacts are per-Mac (they
 *    are bound to this Mac's static identity, which never leaves it), kept
 *    in settingsStore like the paired phones.
 *  - ROLES ARE TRANSPORT ONLY. The inviter HOSTS a relay room for its
 *    contacts (one room per Mac, `peers.routingId`, distinct from the phone
 *    room); each invitee connects to it as a CLIENT. Messages flow both
 *    ways on that one session (the host pushes with sendTo, the client with
 *    send); which side invited says nothing about who shares what.
 *  - MESSAGES ARE OPAQUE HERE. This module delivers `{ contactId, message }`
 *    to the app and sends whatever the app hands it. What a message may
 *    contain is the app's law (the projection builder), not the channel's.
 *  - A CLIENT RECONNECTS ON ITS OWN. createClientEndpoint has no reconnect
 *    (the phone's JS drives it); this module retries with a backoff that
 *    stretches to ten minutes while the inviter's Mac is offline, and every
 *    (re)connect announces itself with a `peer.hello` so the app can pull
 *    current state — lost frames heal on the next connection.
 *
 * Phase 1 (2026-09-11): both Macs online. The store-and-forward mailbox is
 * the phase-2 transport (PORTFOLIO_SHARING.md §5); nothing here assumes it.
 */
import {
  generateIdentity, identityToHex, identityFromHex,
  createPairingOffer, acceptPairingOffer, verifyPairingRegistration,
} from './secure-channel.mjs';
import { createHostEndpoint, createClientEndpoint, createPairingClient } from './channel-endpoint.mjs';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';

const K_IDENTITY = 'channel.identity';   // shared with the phone channel: ONE identity per Mac
const K_ROUTING = 'peers.routingId';     // this Mac's sharing room, generated once
const K_CONTACTS = 'peers.contacts';     // [{ id, label, pub, role, routingId, relayUrl, pairedAt, lastSeenAt }]

export const INVITE_PREFIX = 'anjadhe-invite:';
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000; // a code travels over iMessage; a day is honest
const MAX_LABEL = 64;
const RECONNECT_MIN_MS = 15 * 1000;
const RECONNECT_MAX_MS = 10 * 60 * 1000;
const PAIR_TIMEOUT_MS = 20 * 1000;

const b64u = {
  encode: (str) => Buffer.from(str, 'utf8').toString('base64url'),
  decode: (str) => Buffer.from(str, 'base64url').toString('utf8'),
};

/** Serialize a pairing offer as the code a person pastes into the other Mac. */
export function encodeInvite(offer) {
  return INVITE_PREFIX + b64u.encode(JSON.stringify(offer));
}

/** Parse an invite code; returns the offer or throws with a human reason. */
export function decodeInvite(code) {
  const raw = String(code || '').trim();
  if (!raw.startsWith(INVITE_PREFIX)) throw new Error('That is not an Anjadhe invite code.');
  let offer;
  try { offer = JSON.parse(b64u.decode(raw.slice(INVITE_PREFIX.length))); }
  catch { throw new Error('The invite code is damaged.'); }
  if (!offer || offer.v !== 1 || typeof offer.relayUrl !== 'string' || typeof offer.routingId !== 'string'
      || typeof offer.hostPub !== 'string' || typeof offer.pairingSecret !== 'string') {
    throw new Error('The invite code is incomplete.');
  }
  if (offer.expiresAt && Date.parse(offer.expiresAt) < Date.now()) throw new Error('That invite has expired.');
  return offer;
}

const cleanLabel = (label, fallback) => (String(label || '').trim() || fallback).slice(0, MAX_LABEL);
const newId = () => 'ct_' + bytesToHex(randomBytes(8));

export function createPeerChannel({ storage, relayUrl, onMessage, onChanged }) {
  // --- identity (shared with the phone channel) + own sharing room -------
  let identity;
  const savedIdentity = storage.get(K_IDENTITY);
  if (savedIdentity) identity = identityFromHex(savedIdentity);
  else { identity = generateIdentity(); storage.set(K_IDENTITY, identityToHex(identity)); }

  let routingId = storage.get(K_ROUTING);
  if (!routingId) { routingId = bytesToHex(randomBytes(16)); storage.set(K_ROUTING, routingId); }

  // --- contacts -----------------------------------------------------------
  const loadContacts = () => (storage.get(K_CONTACTS) || []).filter((c) => c && c.pub && c.id);
  const saveContacts = (list) => { storage.set(K_CONTACTS, list); changed(); };
  const contactByPub = (pub) => loadContacts().find((c) => c.pub === pub) || null;
  const contactById = (id) => loadContacts().find((c) => c.id === id) || null;
  const touchSeen = (id) => {
    const list = loadContacts();
    const c = list.find((x) => x.id === id);
    if (!c) return;
    c.lastSeenAt = new Date().toISOString();
    storage.set(K_CONTACTS, list); // no changed(): presence is not a roster edit
  };
  function changed() { if (typeof onChanged === 'function') { try { onChanged(); } catch { /* ignore */ } } }

  function deliver(contactId, message) {
    touchSeen(contactId);
    if (typeof onMessage !== 'function') return;
    Promise.resolve().then(() => onMessage(contactId, message)).catch(() => {});
  }

  // --- the room this Mac hosts (contacts that accepted OUR invite) --------
  let host = null;
  const hostSessions = new Map(); // relay clientId -> contactId (learned from the first message)
  const isHostedPeer = (pubHex) => { const c = contactByPub(pubHex); return !!c && c.role === 'host'; };

  function handleHostRequest(clientId, message, respond, peerStatic) {
    const c = peerStatic ? contactByPub(peerStatic) : null;
    if (!c) return respond({ ok: false, error: 'unknown contact' });
    hostSessions.set(clientId, c.id);
    respond({ ok: true });
    deliver(c.id, message);
  }

  // --- invites (this Mac hosting) ---------------------------------------
  const invites = new Map(); // inviteId -> { id, label, offer, pending, createdAt, expiresAt }
  function pruneInvites() {
    const now = Date.now();
    for (const [id, inv] of invites) if (Date.parse(inv.expiresAt) < now) invites.delete(id);
  }
  function handlePairing(clientId, registration, reply) {
    pruneInvites();
    for (const [id, inv] of invites) {
      const result = verifyPairingRegistration(inv.pending, registration);
      if (!result.ok) continue;
      const pub = bytesToHex(result.phonePub);
      const list = loadContacts().filter((c) => c.pub !== pub); // a re-pair replaces the old row
      const contact = {
        id: newId(), label: inv.label, pub, role: 'host',
        routingId, relayUrl, pairedAt: new Date().toISOString(), lastSeenAt: null,
      };
      list.push(contact);
      invites.delete(id); // the secret is one-time
      saveContacts(list);
      return reply({ ok: true });
    }
    reply({ ok: false, error: 'no matching invite' });
  }

  // --- rooms other Macs host (contacts whose invite WE accepted) ----------
  const clients = new Map(); // contactId -> { endpoint, timer, attempt, closed, live }

  function connectClient(contact) {
    const slot = clients.get(contact.id) || { endpoint: null, timer: null, attempt: 0, closed: false, live: false };
    clients.set(contact.id, slot);
    if (slot.closed || slot.endpoint) return;
    let endpoint;
    try {
      endpoint = createClientEndpoint({
        relayUrl: contact.relayUrl, routingId: contact.routingId, identity,
        hostStaticPub: hexToBytes(contact.pub),
        onMessage: (message) => deliver(contact.id, message),
        onClose: () => {
          slot.endpoint = null; slot.live = false;
          if (!slot.closed) scheduleReconnect(contact);
        },
      });
    } catch { scheduleReconnect(contact); return; }
    slot.endpoint = endpoint;
    endpoint.ready.then(() => {
      slot.attempt = 0; slot.live = true;
      touchSeen(contact.id);
      try { endpoint.send({ type: 'peer.hello', v: 1 }); } catch { /* closed already */ }
    }, () => { /* onClose schedules the retry */ });
  }
  function scheduleReconnect(contact) {
    const slot = clients.get(contact.id);
    if (!slot || slot.closed || slot.timer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(slot.attempt, 6))
      * (0.75 + Math.random() * 0.5);
    slot.attempt++;
    slot.timer = setTimeout(() => {
      slot.timer = null;
      const fresh = contactById(contact.id);
      if (fresh) connectClient(fresh);
    }, delay);
    if (slot.timer.unref) slot.timer.unref();
  }
  function dropClient(contactId) {
    const slot = clients.get(contactId);
    if (!slot) return;
    slot.closed = true;
    if (slot.timer) clearTimeout(slot.timer);
    if (slot.endpoint) { try { slot.endpoint.close(); } catch { /* ignore */ } }
    clients.delete(contactId);
  }

  let started = false;
  return {
    /** What Settings shows: this Mac's public half, never the secret. */
    getPublicInfo: () => ({ routingId, hostPub: bytesToHex(identity.publicKey), relayUrl }),

    start() {
      if (started) return host ? host.ready : Promise.resolve();
      started = true;
      host = createHostEndpoint({
        relayUrl, routingId, identity,
        isPairedPeer: isHostedPeer,
        onRequest: handleHostRequest,
        onPairing: handlePairing,
        onPeerLeave: (clientId) => hostSessions.delete(clientId),
      });
      for (const c of loadContacts()) if (c.role === 'client') connectClient(c);
      return host.ready;
    },
    isConnected: () => !!host && host.isConnected(),

    // --- invites --------------------------------------------------------
    createInvite(label) {
      pruneInvites();
      const { offer, pending } = createPairingOffer(identity, { relayUrl, routingId });
      const id = 'inv_' + bytesToHex(randomBytes(6));
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
      const inv = { id, label: cleanLabel(label, 'Contact'), offer: { ...offer, expiresAt }, pending, createdAt, expiresAt };
      invites.set(id, inv);
      return { id, label: inv.label, code: encodeInvite(inv.offer), createdAt, expiresAt };
    },
    listInvites() {
      pruneInvites();
      return [...invites.values()].map(({ id, label, offer, createdAt, expiresAt }) =>
        ({ id, label, code: encodeInvite(offer), createdAt, expiresAt }));
    },
    cancelInvite(id) { invites.delete(id); },

    /** Accept another Mac's invite code; resolves with the new contact. */
    async acceptInvite(code, label) {
      const offer = decodeInvite(code);
      if (offer.hostPub === bytesToHex(identity.publicKey)) throw new Error('That is your own invite.');
      const { registration, pairing } = acceptPairingOffer(offer, identity);
      const pc = createPairingClient({ relayUrl: offer.relayUrl, routingId: offer.routingId, registration });
      let timer;
      const result = await Promise.race([
        pc.result,
        new Promise((_, rej) => { timer = setTimeout(() => { pc.close(); rej(new Error('The other Mac did not answer. It has to be open and online while you accept.')); }, PAIR_TIMEOUT_MS); }),
      ]).finally(() => clearTimeout(timer));
      if (!result || !result.ok) throw new Error((result && result.error) || 'The other Mac refused the invite.');
      const pub = pairing.hostPub; // already hex
      const list = loadContacts().filter((c) => c.pub !== pub);
      const contact = {
        id: newId(), label: cleanLabel(label, 'Contact'), pub, role: 'client',
        routingId: offer.routingId, relayUrl: offer.relayUrl,
        pairedAt: new Date().toISOString(), lastSeenAt: null,
      };
      list.push(contact);
      saveContacts(list);
      if (started) connectClient(contact);
      return { ...contact };
    },

    // --- contacts -------------------------------------------------------
    listContacts: () => loadContacts().map((c) => ({
      ...c, online: c.role === 'host'
        ? [...hostSessions.values()].includes(c.id) && !!host && host.isConnected()
        : !!(clients.get(c.id) && clients.get(c.id).live),
    })),
    renameContact(id, label) {
      const list = loadContacts();
      const c = list.find((x) => x.id === id);
      if (!c) return false;
      c.label = cleanLabel(label, c.label);
      saveContacts(list);
      return true;
    },
    removeContact(id) {
      dropClient(id);
      for (const [clientId, cid] of hostSessions) if (cid === id) hostSessions.delete(clientId);
      saveContacts(loadContacts().filter((c) => c.id !== id));
    },

    /**
     * Send one message to one contact. `delivered` is false when no live
     * session exists — the caller decides what to do about that (Portfolio
     * sharing re-pushes on the contact's next hello).
     */
    send(contactId, message) {
      const c = contactById(contactId);
      if (!c) return { ok: false, delivered: false, error: 'unknown contact' };
      if (c.role === 'host') {
        if (!host) return { ok: true, delivered: false };
        let n = 0;
        for (const [clientId, cid] of hostSessions) if (cid === contactId && host.sendTo(clientId, message)) n++;
        return { ok: true, delivered: n > 0 };
      }
      const slot = clients.get(contactId);
      if (!slot || !slot.live || !slot.endpoint) return { ok: true, delivered: false };
      try { slot.endpoint.send(message); return { ok: true, delivered: true }; }
      catch { return { ok: true, delivered: false }; }
    },

    close() {
      for (const id of [...clients.keys()]) dropClient(id);
      if (host) { host.close(); host = null; }
      started = false;
    },
  };
}
