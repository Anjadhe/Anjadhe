// Pins the analytics opt-in gate (js/core/analytics-manager.js):
// shouldNudgeOptIn / noteLaunch. The ask is one-time and unrepeatable, so
// the thing worth pinning is that it cannot fire on a fresh install —
// noteLaunch runs from AppManager.init, which is a RENDERER init (Cmd+R,
// a flag flip, a second window, the reload that ends first-run setup), and
// counting those reached the old three-launch threshold in minutes.
const assert = require('assert');

// --- stubs the module reads ---------------------------------------------
let blob = {};
global.StorageManager = {
    get: (key) => (key === 'analytics' ? JSON.parse(JSON.stringify(blob)) : null),
    set: (key, value) => { if (key === 'analytics') blob = JSON.parse(JSON.stringify(value)); },
};
const store = new Map();
global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};
let usage = {};
global.AppManager = { getAppUsage: () => usage };

const A = require('../js/core/analytics-manager.js');

const DAY = 24 * 60 * 60 * 1000;
const reset = () => { blob = {}; store.clear(); usage = {}; A._state = null; };
// noteLaunch keys off the LOCAL day; travel by rewriting the stamp instead
// of the clock so the test does not depend on the machine's timezone.
const backdate = (days) => {
    const st = A._load();
    st.firstSeenAt = Date.now() - days * DAY;
    st.lastLaunchDay = '';
};
const usedApps = (n) => { usage = { notes: { count: n, last: Date.now() } }; };

// --- a fresh install is never asked -------------------------------------
reset();
A.noteLaunch();
assert.strictEqual(A.shouldNudgeOptIn(), false, 'day zero must not ask');

// three renderer inits in one day are ONE day of use (the reported bug:
// finish setup -> reload, flip a flag -> reload, Cmd+R -> modal)
reset();
usedApps(50);
A.noteLaunch(); A.noteLaunch(); A.noteLaunch();
assert.strictEqual(A._load().launchCount, 1, 'reloads inside a day count once');
assert.strictEqual(A.shouldNudgeOptIn(), false, 'three reloads must not ask');

// --- all three gates are required ---------------------------------------
// enough days of use, but installed today
reset();
usedApps(50);
A.noteLaunch(); backdate(0); A.noteLaunch(); backdate(0); A.noteLaunch();
assert.strictEqual(A._load().launchCount, 3);
assert.strictEqual(A.shouldNudgeOptIn(), false, 'age gate holds');

// old enough, used enough, but only opened on two days
reset();
usedApps(50);
A.noteLaunch(); backdate(9); A.noteLaunch();
assert.strictEqual(A._load().launchCount, 2);
assert.strictEqual(A.shouldNudgeOptIn(), false, 'days-used gate holds');

// old enough and opened on three days, but nothing was ever done
reset();
usedApps(0);
A.noteLaunch(); backdate(9); A.noteLaunch(); backdate(9); A.noteLaunch();
assert.strictEqual(A.shouldNudgeOptIn(), false, 'usage gate holds');

// --- the ask ------------------------------------------------------------
reset();
usedApps(A.NUDGE_MIN_APP_OPENS);
A.noteLaunch(); backdate(9); A.noteLaunch(); backdate(9); A.noteLaunch();
assert.strictEqual(A.shouldNudgeOptIn(), true, 'three days, three days old, real use');

// asked once, ever — and durably, in localStorage, not the churning blob
A.markNudged();
assert.strictEqual(A.shouldNudgeOptIn(), false);
blob = {};                      // the blob is wiped under us
A._state = null;
usedApps(A.NUDGE_MIN_APP_OPENS);
assert.strictEqual(A.shouldNudgeOptIn(), false, 'nudgedAt survives a lost blob');

// opted in already: never asked
reset();
usedApps(50);
A.setEnabled(true);
A.noteLaunch(); backdate(9); A.noteLaunch(); backdate(9); A.noteLaunch();
assert.strictEqual(A.shouldNudgeOptIn(), false, 'an opted-in Mac is not asked');

// firstSeenAt is stamped once and never moves
reset();
A._load();
const first = A._load().firstSeenAt;
assert.ok(first > 0, 'first seen is stamped on first load');
A._state = null;
assert.strictEqual(A._load().firstSeenAt, first, 'first seen survives a reload');

console.log('analytics-nudge-test: OK');
