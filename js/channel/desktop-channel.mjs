/**
 * desktop-channel.mjs — the Mac side of the phone<->Mac channel.
 * ==============================================================
 * Wraps the host endpoint with everything the Electron main process needs:
 * a persistent X25519 identity, one stable relay routing id, the paired-phones
 * list, and the QR-pairing flow. `main.js` constructs one of these, gives it a
 * storage adapter and a request dispatcher, and drives it.
 *
 * Storage is injected (`{ get(key), set(key, value) }`, synchronous — the
 * shape of the app's existing store) so this module stays testable without
 * Electron.
 *
 * If the relay connection drops, the host endpoint reconnects on its own
 * with exponential backoff — see channel-endpoint.mjs.
 *
 * Two relays, one channel (2026-08-31): when main.js runs the embedded LAN
 * relay (js/channel/lan-relay.mjs) it passes `lanRelayUrl` (loopback) and
 * `getLanUrls` (the LAN addresses phones dial). The Mac then registers as
 * host on BOTH relays; a phone connects to whichever it can reach, and the
 * Noise handshake and everything above it are identical on either path.
 */
import {
  generateIdentity, identityToHex, identityFromHex,
  createPairingOffer, verifyPairingRegistration,
} from './secure-channel.mjs';
import { createHostEndpoint } from './channel-endpoint.mjs';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

const K_IDENTITY = 'channel.identity';    // { secretKey, publicKey } as hex
const K_ROUTING = 'channel.routingId';    // hex string, generated once
const K_PEERS = 'channel.pairedPeers';    // [{ pub, name, pairedAt }]

const PAIRING_TTL_MS = 2 * 60 * 1000;     // a QR offer is valid for 2 minutes

export function createDesktopChannel({ storage, relayUrl, lanRelayUrl, getLanUrls, onRequest }) {
  const lanUrls = () => {
    try { return (typeof getLanUrls === 'function' && getLanUrls()) || []; }
    catch { return []; }
  };
  // --- persistent identity + stable routing id ---------------------------
  let identity;
  const savedIdentity = storage.get(K_IDENTITY);
  if (savedIdentity) {
    identity = identityFromHex(savedIdentity);
  } else {
    identity = generateIdentity();
    storage.set(K_IDENTITY, identityToHex(identity));
  }

  let routingId = storage.get(K_ROUTING);
  if (!routingId) {
    routingId = bytesToHex(randomBytes(16));
    storage.set(K_ROUTING, routingId);
  }

  // --- paired phones -----------------------------------------------------
  const loadPeers = () => storage.get(K_PEERS) || [];
  const savePeers = (list) => storage.set(K_PEERS, list);
  const isPairedPeer = (pubHex) => loadPeers().some((p) => p.pub === pubHex);

  // --- transient pairing state -------------------------------------------
  let pairingState = null; // { offer, pending } while a QR is on screen
  let pairingTimer = null;
  const pairedListeners = [];

  function clearPairing() {
    pairingState = null;
    if (pairingTimer) { clearTimeout(pairingTimer); pairingTimer = null; }
  }

  // --- the live host endpoints -------------------------------------------
  // `endpoint` faces the hosted relay; `lanEndpoint` faces the embedded LAN
  // relay over loopback (when one is running). A phone only ever holds one
  // session, on whichever relay it reached; both endpoints share the same
  // identity, routing id, paired-peer list, and dispatcher.
  let endpoint = null;
  let lanEndpoint = null;

  function handlePairing(clientId, registration, reply) {
    if (!pairingState) return reply({ ok: false, error: 'not in pairing mode' });
    const result = verifyPairingRegistration(pairingState.pending, registration);
    if (!result.ok) return reply({ ok: false, error: 'pairing verification failed' });

    const pubHex = bytesToHex(result.phonePub);
    const peers = loadPeers();
    if (!peers.some((p) => p.pub === pubHex)) {
      peers.push({
        pub: pubHex,
        name: (registration.deviceName || 'iPhone').slice(0, 64),
        pairedAt: new Date().toISOString(),
      });
      savePeers(peers);
    }
    clearPairing(); // the pairing secret is one-time
    reply({ ok: true });
    pairedListeners.forEach((cb) => { try { cb(pubHex); } catch { /* ignore */ } });
  }

  function handleRequest(peerId, message, respond) {
    Promise.resolve()
      .then(() => onRequest(message, peerId))
      .then(
        (reply) => respond(reply ?? { ok: true }),
        (err) => respond({ ok: false, error: String((err && err.message) || err) }),
      );
  }

  return {
    /** Public details that go into the pairing QR / Settings UI. */
    getPublicInfo: () => ({
      routingId,
      hostPub: bytesToHex(identity.publicKey),
      relayUrl,
      lanUrls: lanUrls(),
    }),

    /** Connect to the relay(s) and start serving paired phones. */
    start() {
      if (endpoint) return endpoint.ready;
      const opts = {
        routingId, identity, isPairedPeer,
        onRequest: handleRequest,
        onPairing: handlePairing,
      };
      endpoint = createHostEndpoint({ relayUrl, ...opts });
      if (lanRelayUrl) lanEndpoint = createHostEndpoint({ relayUrl: lanRelayUrl, ...opts });
      // Ready when either relay answers — the LAN one is loopback and
      // typically wins instantly, so startup never waits on the internet.
      return lanEndpoint
        ? Promise.race([endpoint.ready, lanEndpoint.ready])
        : endpoint.ready;
    },

    /** Whether a relay connection (hosted or LAN) is currently live. */
    isConnected: () => (!!endpoint && endpoint.isConnected())
      || (!!lanEndpoint && lanEndpoint.isConnected()),

    /**
     * Send a message to every connected paired phone — used to nudge them
     * after a data change so they can pull fresh state without waiting for
     * the next manual sync. Returns the number of recipients (0 if no
     * phone is currently online, or the channel has not been started).
     * A phone holds one session on one relay, so the sum never double-counts.
     */
    broadcastToPeers: (message) => (endpoint ? endpoint.broadcastToPeers(message) : 0)
      + (lanEndpoint ? lanEndpoint.broadcastToPeers(message) : 0),

    /** Enter pairing mode; returns the offer to render as a QR code. */
    beginPairing() {
      pairingState = createPairingOffer(identity, { relayUrl, routingId, lanUrls: lanUrls() });
      if (pairingTimer) clearTimeout(pairingTimer);
      pairingTimer = setTimeout(clearPairing, PAIRING_TTL_MS);
      return pairingState.offer;
    },
    cancelPairing: clearPairing,
    isPairing: () => !!pairingState,

    listPairedDevices: () => loadPeers().map(({ pub, name, pairedAt }) => ({ pub, name, pairedAt })),
    removePairedDevice: (pubHex) => savePeers(loadPeers().filter((p) => p.pub !== pubHex)),

    /** Notified with the phone's public key each time one pairs. */
    onPaired: (cb) => { pairedListeners.push(cb); },

    close() {
      if (endpoint) { endpoint.close(); endpoint = null; }
      if (lanEndpoint) { lanEndpoint.close(); lanEndpoint = null; }
    },
  };
}
