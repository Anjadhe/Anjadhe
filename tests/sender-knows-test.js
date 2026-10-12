// SenderKnows (js/core/sender-knows.js, docs/SENDERS.md M8): one reader of
// what nenva knows about a sender. Pure parts.
const assert = require('assert');
const K = require('../js/core/sender-knows.js');

const sender = { id: 'sender:auto', name: 'Auto insurance',
    facts: [{ id: 'f1', text: 'Agent is Dana.', at: '2026-10-01' }, { id: 'f2', text: 'Policy GX-1.', at: '2026-10-02' }],
    links: [{ kind: 'doc', ref: 'd1', title: 'Policy PDF' }, { kind: 'routine', ref: 'r1', title: 'Price check' }, { kind: 'routine', ref: 'gone', title: 'Old' }] };
const k = K.gather({
    sender,
    members: [{ key: 'matter:renew', title: 'Renewal' }, { key: 'task:pay', title: 'Pay GEICO' }],
    decisionsOf: key => (key === 'task:pay' ? [{ title: 'Pay', body: 'Pay from the joint card.', createdAt: '2026-10-03' }] : []),
    updatesOf: key => (key === 'task:pay' ? [{ body: 'Called them.', createdAt: '2026-10-04', source: 'user' }, { body: 'Reminder sent.', createdAt: '2026-10-05', source: 'ai' }] : []),
    notebook: { notes: [{ text: 'Renews Nov 2.', at: 1 }], lookAgain: '2026-10-26' },
    routineOf: id => (id === 'r1' ? { title: 'Weekly price check', last: { at: '2026-10-06', line: 'No change.' } } : null),
    jobs: [{ id: 'j1', status: 'running', goal: 'Compare three quotes', note: 'reading sites' }]
});
assert.deepStrictEqual(k.told.map(f => f.text), ['Policy GX-1.', 'Agent is Dana.'], 'newest first');
assert.deepStrictEqual(k.decisions, [{ on: 'Pay GEICO', key: 'task:pay', title: 'Pay', text: 'Pay from the joint card.', at: '2026-10-03' }]);
assert.deepStrictEqual(k.updates.map(u => [u.text, u.by]), [['Reminder sent.', 'nenva'], ['Called them.', 'you']]);
assert.deepStrictEqual(k.watching, { notes: [{ text: 'Renews Nov 2.', at: 1 }], lookAgain: '2026-10-26' });
assert.deepStrictEqual(k.routines, [{ id: 'r1', title: 'Weekly price check', last: { at: '2026-10-06', line: 'No change.' } }], 'a routine that is gone is left out');
assert.deepStrictEqual(k.documents, [{ id: 'd1', title: 'Policy PDF' }]);
assert.strictEqual(k.jobs[0].status, 'running');

const lines = K.lines(k).join('\n');
assert.ok(lines.includes('Standing decisions on it (follow these):\n- on "Pay GEICO": Pay from the joint card.'));
assert.ok(lines.includes('Latest updates (history):'));
assert.ok(lines.includes('"Weekly price check", last: 2026-10-06 No change.'));
assert.ok(lines.includes('"Policy PDF" (id d1)'));
assert.ok(lines.includes('- running: Compare three quotes (reading sites)'));
assert.deepStrictEqual(K.lines(K.gather({ sender: { id: 'x' } })), [], 'nothing known, nothing said');
assert.deepStrictEqual(K._keysOf('task:c1'), ['task:c1', 'goal:c1'], 'a commitment carries task and project decisions');
console.log('sender-knows-test: ok');
