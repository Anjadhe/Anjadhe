// Commitments.setDone (2026-10-11): done or not, said as a direction, the
// one replacement for the old task toggle. A one-time commitment resolves
// or reopens; a repeat marks or clears a day; the same direction twice is a
// no-op, so a stale tap can never flip it back.
const assert = require('assert');
const C = require('../js/core/commitments.js');
const store = {};
global.StorageManager = { get: k => store[k] ? JSON.parse(JSON.stringify(store[k])) : null, set: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
C._inited = true;
const at = '2026-10-01T06:00:00Z', today = C.today();
store[C.KEY] = { items: [
    { ...C.blank('once', at), title: 'Call the plumber', when: { date: today, time: null, end: null } },
    { ...C.blank('daily', at), title: 'Walk', when: { date: '2026-10-01', time: '19:00', end: null }, repeat: { rule: 'daily', days: [] } }
], ledger: [], tombstones: {} };
C._data = null;

let r = C.setDone('once', true);
assert.ok(r.ok && r.changed.length && r.ledgerId, 'a one-time commitment is marked done, ledgered');
assert.strictEqual(C.get('once').state, 'done');
r = C.setDone('once', true);
assert.deepStrictEqual(r.changed, [], 'done again changes nothing');
r = C.setDone('once', false);
assert.strictEqual(C.get('once').state, 'open', 'and back');

C.setDone('daily', true);
assert.strictEqual(C.isDone(C.get('daily'), today), true, 'a repeat marks today');
assert.strictEqual(C.get('daily').state, 'open', 'the repeat itself stays open');
assert.deepStrictEqual(C.setDone('daily', true).changed, []);
C.setDone('daily', false);
assert.strictEqual(C.isDone(C.get('daily'), today), false, 'and clears it');
assert.strictEqual(C.setDone('nope', true).ok, false);
console.log('commitments-setdone: a direction, never a toggle; passed');
