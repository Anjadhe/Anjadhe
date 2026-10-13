// Pins js/apps/commitments/commitment-transfer.js: one commitment out as a
// file and its merge-by-id import (CT1-CT5), plus Commitments.importRecords
// and its Undo.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let stored = null;
const ctx = { console, JSON, Date, Map, Set, Object, Number, String, Array, Math, setTimeout,
    StorageManager: { get: () => (stored ? JSON.parse(JSON.stringify(stored)) : null), set: (k, v) => { stored = JSON.parse(JSON.stringify(v)); } } };
vm.createContext(ctx);
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
vm.runInContext(read('js/shared/commitment-calendar.js') + '\nthis.CommitmentCalendar = CommitmentCalendar;', ctx);
vm.runInContext(read('js/shared/commitments-records.js'), ctx);
vm.runInContext(read('js/core/commitments.js') + '\nCommitments.project = () => {};\nthis.C = Commitments;', ctx);
vm.runInContext(read('js/apps/commitments/commitment-transfer.js') + '\nthis.CT = CommitmentTransfer;', ctx);
const { C, CT } = ctx;
const j = x => JSON.parse(JSON.stringify(x));

const rec = (id, title, extra = {}) => ({ ...C.blank(id, '2026-10-01T00:00:00.000Z'), title, ...extra });
const all = [
    rec('c-goal', 'Run a 10K', { kind: 'goal', domain: 'fitness', read: { stance: 'fine' }, log: { '2026-10-02': [{ quote: 'ran 5k' }] } }),
    rec('c-step', 'Run 5K', { parent: 'c-goal', repeat: { rule: 'weekly', days: [1, 4] }, history: { '2026-10-02': 'done' } }),
    rec('c-sub', 'Stretch', { parent: 'c-step' }),
    rec('c-other', 'Pay rent')
];

// 1. Export: the family, whole, without the assistant's read.
const file = j(CT.build('c-goal', all, new Date('2026-10-11T10:00:00Z')));
assert.equal(file.format, 'nenva-commitment');
assert.equal(file.root, 'c-goal');
assert.deepEqual(j(file.commitments.map(c => c.id)), ['c-goal', 'c-step', 'c-sub'], 'the commitment and every step under it');
assert.equal(file.commitments[0].read, undefined, 'the assistant\'s read stays behind');
assert.deepEqual(file.commitments[0].log, { '2026-10-02': [{ quote: 'ran 5k' }] }, 'what was said travels');
assert.equal(file.commitments[1].history['2026-10-02'], 'done', 'the done history travels');
assert.ok(CT.build('nope', all).error);
assert.equal(CT.fileName({ title: 'Run a 10K!' }, new Date(2026, 9, 11)), 'nenva-run-a-10k-2026-10-11.json');

// 2. CT5: anything else is refused whole.
assert.ok(CT.parse('not json').error);
assert.ok(CT.parse(JSON.stringify({ format: 'nenva-finance' })).error);
assert.ok(CT.parse(JSON.stringify({ format: 'nenva-commitment', version: 99, commitments: [] })).error);
assert.ok(CT.parse(JSON.stringify({ format: 'nenva-commitment', version: 1, commitments: [{ id: 'x' }] })).error, 'no readable record');

// 3. CT3: records are checked.
const bad = CT.clean({ id: 'c-x', title: ' T ', state: 'weird', repeat: { rule: 'hourly' }, when: { date: '2026-02-31', time: '25:00' }, kind: 'epic', domain: 'astrology', parent: 'c-x', read: {} });
assert.equal(bad.title, 'T');
assert.equal(bad.state, 'open');
assert.equal(bad.repeat.rule, 'none');
assert.equal(bad.when, null, 'an unreal date and time are dropped');
assert.equal(bad.kind, undefined);
assert.equal(bad.domain, undefined);
assert.equal(bad.parent, null, 'its own parent is no parent');
assert.equal(bad.read, undefined);
assert.equal(CT.clean({ id: '../etc', title: 'x' }), null, 'an id must be an id');
assert.equal(CT.clean({ id: 'c-y', title: '' }), null, 'a title is required');

// 4. CT1/CT2/CT3 plan: added, newer replaces, older kept, deleted restored, orphan parent dropped.
const parsed = CT.parse(JSON.stringify(file));
assert.equal(parsed.title, 'Run a 10K');
const current = {
    items: { 'c-step': { ...rec('c-step', 'Run 5K (here)'), updatedAt: '2026-10-05T00:00:00.000Z' } },
    tombstones: { 'c-sub': '2026-10-09T00:00:00.000Z' }
};
const p = CT.plan(parsed, current, '2026-10-11T12:00:00.000Z');
assert.equal(p.added, 1);
assert.equal(p.same, 1, 'this Mac\'s newer copy is kept');
assert.equal(p.restored, 1);
assert.deepEqual(j(p.write.map(r => r.id)), ['c-goal', 'c-sub']);
assert.equal(p.write[1].updatedAt, '2026-10-11T12:00:00.000Z', 'a restored record is stamped now');
const orphan = CT.plan(CT.parse(JSON.stringify(CT.build('c-step', all))), { items: {}, tombstones: {} });
assert.equal(orphan.write.find(r => r.id === 'c-step').parent, null, 'a parent that is nowhere is dropped');
assert.equal(orphan.write.find(r => r.id === 'c-sub').parent, 'c-step', 'a parent in the file is kept');
// A loop through this Mac's records is cut.
const loopFile = { commitments: [CT.clean({ id: 'a', title: 'A', parent: 'b', updatedAt: '2026-10-10T00:00:00Z' })] };
const loop = CT.plan(loopFile, { items: { b: rec('b', 'B', { parent: 'a' }) }, tombstones: {} });
assert.equal(loop.write[0].parent, null);

// A deleted goal comes back with the steps the delete had moved up.
const cut = CT.plan(parsed, { items: { 'c-step': { ...rec('c-step', 'Run 5K'), parent: null, updatedAt: '2026-10-10T00:00:00.000Z' } }, tombstones: { 'c-goal': '2026-10-10T00:00:00.000Z' } }, '2026-10-11T12:00:00.000Z');
assert.equal(cut.write.find(r => r.id === 'c-step').parent, 'c-goal', 'the step rejoins its restored goal');
assert.equal(cut.write.find(r => r.id === 'c-step').title, 'Run 5K', 'only its parent changes');

// 5. CT4: the write is ledgered and Undo puts this Mac back exactly.
stored = { items: [rec('c-goal', 'Old title', { updatedAt: '2026-09-01T00:00:00.000Z' })], ledger: [], tombstones: {} };
C.reload();
const r = CT.apply(parsed);
assert.equal(r.ok, true);
assert.equal(r.updated, 1);
assert.equal(r.added, 2);
assert.equal(C.get('c-goal').title, 'Run a 10K');
assert.equal(C.get('c-sub').parent, 'c-step');
assert.equal(r.ledgerIds.length, 3);
CT.undo(r.ledgerIds);
assert.equal(C.get('c-goal').title, 'Old title', 'Undo restores what was here');
assert.equal(C.get('c-step'), null, 'Undo removes what was added');
assert.equal(C.get('c-sub'), null);
// Importing the same file twice changes nothing the second time.
C.reload();
CT.apply(parsed);
const again = CT.apply(parsed);
assert.equal(again.added + again.updated + again.restored, 0);
assert.equal(again.unchanged, 3);
assert.match(CT.sentence({ ...again, title: 'Run a 10K' }), /already had everything/);

// 6. All of them: every commitment, finished ones too, back through the same import.
const everything = j(CT.buildAll([...all, rec('c-done', 'Renew passport', { state: 'done' })], new Date('2026-10-12T10:00:00Z')));
assert.equal(everything.all, true);
assert.equal(everything.root, null);
assert.deepEqual(j(everything.commitments.map(c => c.id)), ['c-goal', 'c-step', 'c-sub', 'c-other', 'c-done'], 'every commitment, finished ones too');
assert.equal(everything.commitments[0].read, undefined, 'the assistant\'s read stays behind');
assert.ok(CT.buildAll([]).error, 'nothing to export');
assert.equal(CT.allFileName(new Date(2026, 9, 12)), 'nenva-commitments-2026-10-12.json');
const parsedAll = CT.parse(JSON.stringify(everything));
assert.equal(parsedAll.all, true);
assert.equal(parsedAll.root, null);
assert.equal(parsedAll.commitments.length, 5);
stored = { items: [rec('c-other', 'Pay rent', { updatedAt: '2026-10-05T00:00:00.000Z' })], ledger: [], tombstones: {} };
C.reload();
const ra = CT.apply(parsedAll);
assert.equal(ra.all, true);
assert.equal(ra.added, 4);
assert.equal(ra.unchanged, 1, 'a newer copy here is kept');
assert.equal(C.get('c-sub').parent, 'c-step', 'steps keep their parents');
assert.equal(C.get('c-done').state, 'done');
assert.match(CT.sentence(ra), /^Imported your commitments: 4 added/);
CT.undo(ra.ledgerIds);
assert.equal(C.get('c-goal'), null, 'Undo takes the whole import back');
assert.equal(C.get('c-other').title, 'Pay rent');
assert.match(CT.sentence({ all: true, added: 0, updated: 0, restored: 0 }), /already had every commitment/);

console.log('commitment-transfer-test: ok');
