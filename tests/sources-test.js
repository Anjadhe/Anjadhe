// Sources (js/core/sources.js, docs/VISION.md "Sources"): one registry the
// Connectors and Privacy pages are generated from.
const assert = require('assert');
const S = require('../js/core/sources.js');

assert.strictEqual(S.register(null), null);
assert.strictEqual(S.register({ id: 'x', label: 'X' }), null, 'a source without a status is not one');
S.register({ id: 'mail', label: 'Mail', kind: 'mail', reads: 'Your mail.', privacy: 'email', status: () => ({ on: true, value: 'a@b.c' }) });
S.register({ id: 'docs', label: 'Docs', kind: 'docs', mode: 'reference', reads: 'A doc when a thing needs it.', status: () => ({ on: true, value: 'On' }) });
S.register({ id: 'off', label: 'Off one', kind: 'tasks', reads: 'Tasks.', status: () => ({ on: false, value: 'Off' }) });
S.register({ id: 'broken', label: 'Broken', kind: 'notes', reads: 'Notes.', status: () => { throw new Error('no module'); } });
S.register({ id: 'mail', label: 'Mail again', kind: 'mail', reads: 'Your mail.', privacy: 'email', status: () => ({ on: true, value: 'a@b.c' }) });

assert.deepStrictEqual(S.list().map(s => s.id), ['docs', 'off', 'broken', 'mail'], 'registering again replaces, at the end');
assert.strictEqual(S.get('mail').label, 'Mail again');
assert.strictEqual(S.get('docs').mode, 'reference');
assert.strictEqual(S.get('off').mode, 'mirror', 'mirror is the default');
assert.deepStrictEqual(S.status('broken'), { on: false, value: 'Not available' }, 'a failing status reads as off, never throws');
assert.deepStrictEqual(S.on().map(s => s.id), ['docs', 'mail']);

// The Privacy lines: what is read, and whether the AI may see it, from facts.
global.CloudPrivacy = { brainLeaves: () => true, isEnabled: (c) => c === 'email' };
let lines = S.privacyLines();
assert.strictEqual(lines.find(l => l.id === 'mail').ai, 'Read on this Mac; what your AI needs from it may be sent to your model.');
assert.strictEqual(lines.find(l => l.id === 'docs').ai, 'Read only when you ask or a thing needs it; each read is in the ledger.', 'a reference source is never ambient');
assert.strictEqual(lines.find(l => l.id === 'off').ai, '', 'nothing to say about a source that is off');
global.CloudPrivacy = { brainLeaves: () => false, isEnabled: () => true };
lines = S.privacyLines();
assert.strictEqual(lines.find(l => l.id === 'mail').ai, 'Read on this Mac; your AI runs here too, so none of it leaves.');
global.CloudPrivacy = { brainLeaves: () => true, isEnabled: () => false };
assert.strictEqual(S.privacyLines().find(l => l.id === 'mail').ai, 'Read on this Mac; kept from your AI unless you allow it.');

console.log('sources: register, replace, status never throws, privacy lines from facts passed');

// A financial connector carries holdings AND bank transactions. Allowing
// one class must not claim that all of its data may go to a cloud model.
S.register({ id: 'institutions', label: 'Linked institutions', privacy: ['portfolio', 'spending'], status: () => ({ on: true }) });
global.CloudPrivacy = { brainLeaves: () => true, isEnabled: kind => kind === 'portfolio' };
assert.match(S.privacyLines().find(s => s.id === 'institutions').ai, /kept from your AI/);
global.CloudPrivacy.isEnabled = () => true;
assert.match(S.privacyLines().find(s => s.id === 'institutions').ai, /may be sent to your model/);
