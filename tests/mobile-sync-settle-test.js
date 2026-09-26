#!/usr/bin/env node
/**
 * "The Mac has taken it" — the phone's upload ack (js/adapter/mobile-sync.js).
 *
 * A Mac-served screen (Tasks) shows rows the MAC computed. Nothing in a
 * cached answer can tell that the question changed, so when the phone edits a
 * task the screen has to be told to ask again — but only once the Mac
 * actually holds the edit, or it would answer with the rows it already had.
 * Everything the Mac sends DOWN reaches the app through the store; what goes
 * UP had no echo at all, which is what this adds.
 *
 * What must stay true:
 *   1. `onSynced` fires on the Mac's `sync-values-ack`, naming the keys that
 *      went up — never at the moment the phone wrote them;
 *   2. it does not fire for a round trip that uploaded nothing;
 *   3. a sync trigger that lands mid-round-trip is DEFERRED, not dropped (a
 *      local write's own push is the commonest one, and losing it left the
 *      edit on the phone until something else happened to sync).
 *
 * Run:  node tests/mobile-sync-settle-test.js
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

const RELAY_URL = 'wss://api.anjadhe.com/v1/relay';

/**
 * A phone on a live channel to a Mac we drive by hand: `sent` is everything
 * the phone put on the wire, `deliver` is the Mac answering.
 */
function boot() {
  const store = new Map();
  const sent = [];
  let deliver = () => {};

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
      createClientEndpoint({ onMessage }) {
        deliver = onMessage;
        return {
          ready: Promise.resolve(),
          send: (m) => sent.push(m),
          close() {},
        };
      },
    },
    __anjadheStore: {
      exportManifest: () => ({ app_schedule: '2026-09-22T10:00:00.000Z' }),
      exportValues: (keys) => Object.fromEntries(
        (keys || []).map((k) => [k, { value: { scheduleItems: [] }, modifiedAt: '2026-09-22T10:00:00.000Z' }]),
      ),
      applyRemote: () => {},
      applyRemoteDelete: () => {},
      localModifiedAt: () => '1970-01-01T00:00:00.000Z',
    },
    __anjadheStoreReady: Promise.resolve(),
  };
  win.window = win;

  global.window = win;
  global.localStorage = localStorageStub;
  global.document = { readyState: 'complete', addEventListener: () => {} };
  global.WebSocket = function () {};

  store.set('anjadhe:channel:identity', JSON.stringify('aa'.repeat(32)));
  store.set('anjadhe:channel:pairing', JSON.stringify({
    routingId: 'r1', hostPub: 'bb'.repeat(32), relayUrl: RELAY_URL,
  }));
  store.set('anjadhe:channel:synced-once', JSON.stringify(true));

  delete require.cache[require.resolve(path.join(__dirname, '..', 'js', 'adapter', 'mobile-sync.js'))];
  require(path.join(__dirname, '..', 'js', 'adapter', 'mobile-sync.js'));

  const settled = [];
  win.AnjadheSync.onSynced((keys) => settled.push(keys));
  return { sync: win.AnjadheSync, sent, settled, mac: (m) => deliver(m) };
}

const typesOf = (sent) => sent.map((m) => m.type);

(async () => {
  // --- 1. A key the phone uploaded settles on the ACK, not on the write ---
  console.log('\nthe phone is newer: the Mac asks, the phone uploads, the Mac acks');
  {
    const w = boot();
    w.sync.sync();
    await sleep(50);
    check('stage 1 is a manifest', typesOf(w.sent).includes('sync-manifest'));

    w.mac({ type: 'sync-plan', send: {}, want: ['app_schedule'] });
    await sleep(10);
    check('the phone uploads what was asked for', typesOf(w.sent).includes('sync-values'));
    check('nothing has settled yet — the Mac has not answered',
      w.settled.length === 0, 'fired ' + w.settled.length + ' time(s)');

    w.mac({ type: 'sync-values-ack', applied: 1 });
    await sleep(10);
    check('the ack settles the uploaded keys', w.settled.length === 1);
    check('and names them', JSON.stringify(w.settled[0] || []) === JSON.stringify(['app_schedule']),
      JSON.stringify(w.settled[0]));
  }

  // --- 2. Nothing uploaded: nothing settles ------------------------------
  console.log('\nnothing to upload');
  {
    const w = boot();
    w.sync.sync();
    await sleep(50);
    w.mac({ type: 'sync-plan', send: {}, want: [] });
    await sleep(20);
    check('a round trip that uploaded nothing settles nothing', w.settled.length === 0,
      'fired ' + w.settled.length + ' time(s)');
  }

  // --- 3. A trigger mid-round-trip is deferred, never dropped ------------
  console.log('\na local write pushes while a sync is already in flight');
  {
    const w = boot();
    w.sync.sync();
    await sleep(50);
    const before = typesOf(w.sent).filter((t) => t === 'sync-manifest').length;
    check('one manifest so far', before === 1, 'manifests=' + before);

    // The local push lands while the manifest is still out.
    w.sync.sync();
    await sleep(10);
    check('the second trigger does not race a second manifest onto the wire',
      typesOf(w.sent).filter((t) => t === 'sync-manifest').length === 1);

    w.mac({ type: 'sync-plan', send: {}, want: ['app_schedule'] });
    await sleep(10);
    w.mac({ type: 'sync-values-ack', applied: 1 });
    await sleep(20);
    check('the deferred trigger runs once the round trip is done',
      typesOf(w.sent).filter((t) => t === 'sync-manifest').length === 2,
      'manifests=' + typesOf(w.sent).filter((t) => t === 'sync-manifest').length);
  }

  console.log('');
  if (failures.length) {
    console.log(`${failures.length} FAILED, ${passed} passed`);
    process.exit(1);
  }
  console.log(`ALL ${passed} CHECKS PASSED`);
  process.exit(0);
})();
