// Pins js/components/save-status.js — the registry half (flushAll,
// dirtyLabels, announce) is DOM-free and runs in plain Node.
const assert = require('assert');
const SaveStatus = require('../js/components/save-status.js');

const toasts = [];
global.UIUtils = { showToast: (msg, type, dur, opts) => toasts.push({ msg, type, action: opts?.actionLabel || null, run: opts?.onAction || null }) };

let wrote = [];
SaveStatus.register('clean', { isDirty: () => false, flush: () => { throw new Error('must not flush a clean editor'); }, label: 'Clean' });
SaveStatus.register('ok', { isDirty: () => true, flush: () => { wrote.push('ok'); return { ok: true }; }, label: () => 'Note "A"' });
SaveStatus.register('stuck', { isDirty: () => true, flush: () => ({ ok: false, reason: 'it needs a title', actionLabel: 'Go back', onAction: () => wrote.push('reopened') }), label: 'This task' });
SaveStatus.register('throws', { isDirty: () => true, flush: () => { throw new Error('boom'); }, label: 'Broken', reopen: () => wrote.push('reopen-fallback') });
SaveStatus.register('noflush', { isDirty: () => true }); // ignored: no flush()
assert.strictEqual(SaveStatus.isRegistered('noflush'), false);

// dirtyLabels: no flushing, names only the dirty ones
assert.deepStrictEqual(SaveStatus.dirtyLabels().sort(), ['Broken', 'Note "A"', 'This task']);
assert.deepStrictEqual(wrote, []);

// flushAll: writes what it can, reports what it cannot, announces on request
const stuck = SaveStatus.flushAll({ announce: true });
assert.deepStrictEqual(wrote, ['ok']);
assert.deepStrictEqual(stuck.map(s => s.id).sort(), ['stuck', 'throws']);
const s = stuck.find(x => x.id === 'stuck');
assert.strictEqual(s.reason, 'it needs a title');
assert.strictEqual(s.actionLabel, 'Go back');
assert.strictEqual(toasts.length, 2);
const t = toasts.find(x => x.msg.startsWith('This task'));
assert.strictEqual(t.msg, 'This task not saved — it needs a title');
assert.strictEqual(t.type, 'warning');
assert.strictEqual(t.action, 'Go back');
t.run(); assert.ok(wrote.includes('reopened'));
// a throwing flush falls back to the editor's reopen
const b = toasts.find(x => x.msg.startsWith('Broken'));
assert.strictEqual(b.msg, 'Broken not saved — could not save');
b.run(); assert.ok(wrote.includes('reopen-fallback'));

// unregister drops it from every list
SaveStatus.unregister('stuck'); SaveStatus.unregister('throws');
assert.deepStrictEqual(SaveStatus.flushAll(), []);

console.log('save-status-test: ok');
