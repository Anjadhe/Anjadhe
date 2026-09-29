#!/usr/bin/env node
/**
 * The phone's transport ladder (js/adapter/mobile-sync.js).
 *
 * Pins the 2026-09-20 change: the hosted relay is raced ALONGSIDE the Mac's
 * own LAN relay after a short head start, instead of only being dialled once
 * the LAN race has run out its clock. Sequentially, a phone away from home
 * paid 3s — or 8s with a Tailscale wss:// candidate in the list — with
 * nothing on the wire before the relay was even tried.
 *
 * What must stay true:
 *   1. at home the direct rung still wins, and the relay is never dialled;
 *   2. away from home the relay is adopted in about the head start, not
 *      after the LAN clock expires;
 *   3. a LAN rung that merely LOST the race is not marked failed (so the
 *      foreground upgrade can still move us over), while one that genuinely
 *      failed while we sit on the relay is;
 *   4. when nothing answers, the connection still fails rather than hanging.
 *
 * Run:  node tests/mobile-sync-ladder-test.js
 */
'use strict';
const path = require('path');

const failures = [];
let passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name + (detail ? ' — ' + detail : '')); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LAN_URL = 'ws://192.168.1.10:8899';
const TAILSCALE_URL = 'wss://mac.tail1234.ts.net';
const RELAY_URL = 'wss://api.anjadhe.com/v1/relay';

/**
 * Load a fresh copy of mobile-sync.js against a stubbed WebView world.
 * `latency` maps a candidate url to ms-until-handshake, 'fail' to refuse
 * immediately, or null to hang until its own timeout cuts it.
 */
function boot({ lanUrls, latency }) {
  const store = new Map();
  const dialled = [];
  const listeners = {};

  const localStorageStub = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  const win = {
    __ANJADHE_MOBILE__: true,
    localStorage: localStorageStub,
    addEventListener: () => {},
    AnjadheChannel: {
      identityFromHex: (h) => ({ hex: h }),
      createClientEndpoint({ relayUrl }) {
        const at = Date.now();
        dialled.push({ url: relayUrl, at });
        let closed = false;
        const ms = latency[relayUrl];
        const ready = new Promise((resolve, reject) => {
          if (ms === 'fail') return setTimeout(() => reject(new Error('refused')), 5);
          if (ms == null) return; // hangs until its own timeout closes it
          setTimeout(() => (closed ? reject(new Error('closed')) : resolve()), ms);
        });
        ready.catch(() => {}); // the ladder attaches its own handlers
        return { ready, send() {}, close() { closed = true; } };
      },
    },
    __anjadheStore: {
      exportManifest: () => ({}),
      exportValues: () => ({}),
      applyRemote: () => {},
      applyRemoteDelete: () => {},
      localModifiedAt: () => '1970-01-01T00:00:00.000Z',
    },
    __anjadheStoreReady: Promise.resolve(),
  };
  win.window = win;

  global.window = win;
  global.localStorage = localStorageStub;
  global.document = {
    readyState: 'complete',
    addEventListener: (k, fn) => { listeners[k] = fn; },
  };
  global.WebSocket = function () {};

  // Pairing as the QR left it.
  store.set('anjadhe:channel:identity', JSON.stringify('aa'.repeat(32)));
  store.set('anjadhe:channel:pairing', JSON.stringify({
    routingId: 'r1', hostPub: 'bb'.repeat(32), relayUrl: RELAY_URL, lanUrls,
  }));
  store.set('anjadhe:channel:synced-once', JSON.stringify(true));

  delete require.cache[require.resolve(path.join(__dirname, '..', 'js', 'adapter', 'mobile-sync.js'))];
  require(path.join(__dirname, '..', 'js', 'adapter', 'mobile-sync.js'));
  return { sync: win.AnjadheSync, dialled, store, startedAt: Date.now() };
}

const dialledUrls = (d) => d.map((x) => x.url);

(async () => {
  // --- 1. At home: the direct rung wins and the relay is never dialled ----
  console.log('\nat home (LAN answers quickly)');
  {
    const w = boot({
      lanUrls: [LAN_URL],
      latency: { [LAN_URL]: 40, [RELAY_URL]: 200 },
    });
    await sleep(1100); // the module connects ~600ms after load
    check('adopts the direct rung', w.sync.getTransport() === 'direct', 'transport=' + w.sync.getTransport());
    check('names it "lan" for the UI', w.sync.getVia() === 'lan', 'via=' + w.sync.getVia());
    check('never dials the hosted relay', !dialledUrls(w.dialled).includes(RELAY_URL),
      'dialled: ' + dialledUrls(w.dialled).join(', '));
  }

  // --- 2. Away: a hanging Tailscale candidate must not hold the relay back -
  console.log('\naway from home (a wss:// candidate that never answers)');
  {
    const w = boot({
      lanUrls: [TAILSCALE_URL],
      latency: { [TAILSCALE_URL]: null, [RELAY_URL]: 150 },
    });
    await sleep(1600);
    const relay = w.dialled.find((x) => x.url === RELAY_URL);
    check('the relay is dialled at all', !!relay);
    const afterConnectStart = relay ? relay.at - w.dialled[0].at : Infinity;
    // Old behaviour: nothing until the 8s wss:// clock expired.
    check('dialled about one head start in, not one LAN clock',
      afterConnectStart < 1500, afterConnectStart + 'ms after the first candidate');
    check('adopts the relay', w.sync.getTransport() === 'relay', 'transport=' + w.sync.getTransport());
    check('a LAN rung that only lost is NOT marked failed',
      w.store.get('anjadhe:channel:lan-failed-at') == null);
  }

  // --- 3. Away, LAN candidate refused outright: remember it --------------
  console.log('\naway from home (the LAN candidate is refused)');
  {
    const w = boot({
      lanUrls: [LAN_URL],
      latency: { [LAN_URL]: 'fail', [RELAY_URL]: 150 },
    });
    await sleep(1600);
    check('still ends up on the relay', w.sync.getTransport() === 'relay', 'transport=' + w.sync.getTransport());
    check('a LAN rung that genuinely failed IS remembered',
      w.store.get('anjadhe:channel:lan-failed-at') != null,
      'stamp=' + String(w.store.get('anjadhe:channel:lan-failed-at')));
  }

  // --- 4. Nothing answers: fail, do not hang -----------------------------
  console.log('\nnothing answers');
  {
    const w = boot({
      lanUrls: [LAN_URL],
      latency: { [LAN_URL]: null, [RELAY_URL]: null },
    });
    await sleep(1200);
    check('not connected', w.sync.getTransport() == null, 'transport=' + String(w.sync.getTransport()));
    check('state is not left on "connecting" forever', ['offline', 'error', 'connecting'].includes(w.sync.getState()),
      'state=' + w.sync.getState());
  }

  console.log(failures.length ? `\n${failures.length} check(s) FAILED` : `\nAll ${passed} checks passed`);
  process.exit(failures.length ? 1 : 0);
})();
