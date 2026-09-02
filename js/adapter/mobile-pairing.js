/**
 * mobile-pairing.js — device pairing for the iPhone app's sync host.
 * ==================================================================
 * Runs inside the hidden WKWebView the native app hosts (AnjadheUI.
 * SyncCoordinator). The native UI scans the Mac's QR code (or takes a pasted
 * offer) and hands the offer text to `AnjadhePairing.pairWithOffer`, which
 * runs the channel handshake over the same transport ladder as sync and
 * persists the pairing on success. No DOM, no camera here — the 2026-06
 * in-WebView overlay went with the JS mobile UI (2026-09-01).
 *
 * Loaded by the host page after channel.bundle.js (window.AnjadheChannel)
 * and native-bridge.js (window.electronStore over the native KVStore).
 *
 * The phone's identity and the pairing record persist through electronStore
 * → native KVStore → disk; the native bridge keeps these `anjadhe:channel:*`
 * keys device-local (never synced to the Mac).
 */
(function () {
  'use strict';
  if (!window.__ANJADHE_MOBILE__) return;

  const LS_IDENTITY = 'anjadhe:channel:identity'; // phone X25519 identity (hex)
  const LS_PAIRING = 'anjadhe:channel:pairing';   // stored pairing record

  const nativeStore = window.__ANJADHE_NATIVE_HOST__ && window.electronStore ? window.electronStore : null;
  function load(key) {
    if (nativeStore) { const v = nativeStore.get(key); return v == null ? null : v; }
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }
  function save(key, value) {
    if (nativeStore) { try { nativeStore.set(key, value); } catch { /* ignore */ } return; }
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  }
  function remove(key) {
    if (nativeStore) { try { nativeStore.delete(key); } catch { /* ignore */ } return; }
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }

  // The phone's long-term identity — generated once, persisted thereafter.
  function phoneIdentity() {
    const stored = load(LS_IDENTITY);
    if (stored && stored.secretKey && stored.publicKey) {
      return window.AnjadheChannel.identityFromHex(stored);
    }
    const fresh = window.AnjadheChannel.generateIdentity();
    save(LS_IDENTITY, window.AnjadheChannel.identityToHex(fresh));
    return fresh;
  }

  // Parse the offer text (the JSON the Mac's pairing QR encodes), run the
  // channel handshake, and persist the pairing on success.
  // Returns { ok, error?, pairing? }.
  async function acceptOfferText(text) {
    if (!window.AnjadheChannel) return { ok: false, error: 'The channel is not loaded.' };
    let offer = null;
    try { offer = JSON.parse(text); } catch { /* not JSON */ }
    if (!offer || offer.v !== 1 || !offer.relayUrl || !offer.routingId) {
      return { ok: false, error: 'That is not an Anjadhe pairing code.' };
    }
    try {
      const identity = phoneIdentity();
      const { registration, pairing } = window.AnjadheChannel.acceptPairingOffer(offer, identity);
      // Same transport ladder as sync: the Mac's own LAN relay first (the
      // offer carries its current addresses — pairing at home works with no
      // internet at all), then the hosted relay. A LAN attempt that REACHED
      // the Mac and got a refusal is final; only unreachable rungs fall
      // through.
      const lanUrls = Array.isArray(offer.lanUrls)
        ? offer.lanUrls.filter((u) => typeof u === 'string' && /^wss?:\/\//.test(u)).slice(0, 4)
        : [];
      const rungs = lanUrls.map((url) => ({ url, timeoutMs: 4000 }))
        .concat([{ url: offer.relayUrl, timeoutMs: 20000 }]);
      let result = null;
      for (const rung of rungs) {
        const pc = window.AnjadheChannel.createPairingClient({
          relayUrl: rung.url, routingId: offer.routingId, registration,
        });
        try {
          result = await Promise.race([
            pc.result,
            new Promise((_, reject) => setTimeout(
              () => reject(new Error('Timed out. Is your Mac on the same Wi-Fi with Anjadhe open?')),
              rung.timeoutMs,
            )),
          ]);
          pc.close();
          break; // the Mac answered (ok or refusal) — the ladder is done
        } catch (err) {
          pc.close();
          if (rung === rungs[rungs.length - 1]) throw err; // last rung — surface it
        }
      }
      if (result && result.ok) {
        save(LS_PAIRING, pairing);
        return { ok: true, pairing: pairing };
      }
      return { ok: false, error: (result && result.error) || 'Your Mac refused the pairing.' };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : 'Pairing failed.' };
    }
  }

  // Drop the stored pairing — the phone stops syncing until paired again.
  function forget() {
    remove(LS_PAIRING);
  }

  window.AnjadhePairing = {
    forget: forget,
    isPaired: function () { return !!load(LS_PAIRING); },
    pairWithOffer: function (text) { return acceptOfferText(text); },
  };
})();
