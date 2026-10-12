'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const main = fs.readFileSync(require.resolve('../main.js'), 'utf8');
const handlers = {}, effects = [];
let fail = false, unchanged = false;
const source = main.slice(main.indexOf('// Synchronous IPC handlers for storage'), main.indexOf('// Network transparency log — every outbound'));
vm.runInNewContext(source, {
    ipcMain: { on: (name, handler) => { handlers[name] = handler; } },
    dataStore: { get: () => ({}), getAll: () => ({ app_notes: {} }), isUnchanged: () => unchanged,
        set: () => { if (fail) throw Error('private data in sqlite error'); effects.push('commit'); },
        delete: () => { if (fail) throw Error('disk'); effects.push('delete'); },
        clear: () => { if (fail) throw Error('disk'); effects.push('clear'); } },
    mergedForWrite: (key, value) => value,
    console: { warn: () => {} }
});
for (const operation of ['set', 'delete', 'clear']) {
    effects.length = 0; fail = true;
    const event = {}; handlers[`store-${operation}-sync`](event, 'app_notes', {});
    assert.equal(event.returnValue.ok, false); assert.ok(!event.returnValue.error.includes('private'));
    assert.deepEqual(effects, []);
    effects.length = 0; fail = false;
    const success = {}; handlers[`store-${operation}-sync`](success, 'app_notes', {});
    assert.equal(success.returnValue, true);
    assert.deepEqual(effects, operation === 'set' ? ['commit'] : operation === 'delete' ? ['delete'] : ['clear']);
}
effects.length = 0; unchanged = true;
const noop = {}; handlers['store-set-sync'](noop, 'app_notes', {});
assert.equal(noop.returnValue, true); assert.deepEqual(effects, []);
const preload = fs.readFileSync(require.resolve('../preload.js'), 'utf8');
let result;
const sandbox = { ipcRenderer: { sendSync: () => result } };
vm.runInNewContext(preload.slice(preload.indexOf('function storeWrite('), preload.indexOf('const storeApi = {')), sandbox);
for (result of [false, undefined, { ok: false, error: 'Could not save' }]) assert.throws(() => sandbox.storeWrite('store-set-sync'));
result = true; assert.equal(sandbox.storeWrite('store-set-sync'), true);
console.log('store write transaction: failure response, durable commit and preload propagation passed');
