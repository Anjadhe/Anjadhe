// Pins (js/core/pins.js): a stored reference per commitment, nothing more.
const assert = require('assert');
let store = {};
global.StorageManager = { get: k => store[k] ? JSON.parse(JSON.stringify(store[k])) : null, set: (k, v) => { store[k] = v; } };
const items = { a: { id: 'a', title: 'Run a 10K', state: 'open' }, b: { id: 'b', title: 'Stretch daily', state: 'open' } };
global.Commitments = { _inited: true, get: id => items[id] || null };
const { Pins } = require('../js/core/pins.js');

assert.deepStrictEqual(Pins.list(), [], 'nothing pinned at first');
assert.strictEqual(Pins.set('a', true).pinned, true);
assert.strictEqual(Pins.set('b', true).pinned, true);
assert.deepStrictEqual(Pins.list().map(x => x.id), ['b', 'a'], 'newest pin first');
Pins.set('a', true);
assert.deepStrictEqual(Pins.list().map(x => x.id), ['a', 'b'], 'pinning again moves it up, never twice');
assert.strictEqual(Pins.toggle('b').pinned, false);
assert.ok(!Pins.has('b'), 'unpinned');
assert.strictEqual(Pins.set('zzz', true).ok, false, 'an unknown commitment cannot be pinned');
// A deleted commitment's pin is skipped on read and dropped on the next write.
Pins.set('b', true);
delete items.a;
assert.deepStrictEqual(Pins.list().map(x => x.id), ['b'], 'gone commitment not listed');
Pins.set('b', false);
assert.deepStrictEqual(store.pinned.items, [], 'stale pin dropped on write');
console.log('pins passed');
