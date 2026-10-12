'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const path = require('node:path');
const calendar = require('../js/shared/commitment-calendar');
const threads = require('../js/shared/thread-core');
const desktopCalendar = require('../js/core/commitments');
const desktopThreads = require('../js/core/threads-page');
// Desktop behavior tests exercise the shared functions themselves, not a copy.
for (const [key, value] of Object.entries(calendar)) assert.equal(desktopCalendar[key], value, key);
for (const [key, value] of Object.entries(threads)) assert.equal(desktopThreads[key], value, key);
assert.equal(threads._t(undefined), 0, 'missing dates never turn into an engine-specific calendar year');
assert.equal(threads._t(0), 0);
assert.equal(threads._t(1791712800000), 1791712800000, 'numeric event timestamps remain milliseconds');

const context = vm.createContext({});
const bundle = fs.readFileSync(path.join(__dirname, '../ios-engine/Anjadhe/Sources/AnjadheCore/Resources/shared-core.js'), 'utf8');
vm.runInContext(bundle, context);
const call = vm.runInContext('(method, args) => NenvaCore.call(method, args)', context);
assert.equal(vm.runInContext('[typeof window, typeof document, typeof require, typeof fetch, typeof StorageManager, typeof electron].join(",")', context), 'undefined,undefined,undefined,undefined,undefined,undefined');
assert.throws(() => call('constructor', '[]'), /Unsupported/);
assert.throws(() => call('threads.preview', '{}'), /Invalid/);
assert.throws(() => call('threads.preview', 'not json'));
const source = { id: 'x', title: 'தமிழ் café', state: 'open', sources: [
    { id: 'e', from: 'School', at: '2026-10-11T10:00:00Z', summary: 'Pay by Friday' }
] };
const conversation = { messages: [
    { role: 'user', content: '"; globalThis.injected = true; //', timestamp: '2026-10-11T12:00:00Z' },
    { role: 'assistant', content: 'Kept **தமிழ் café**.', timestamp: '2026-10-11T11:00:00Z' }
] };
const input = JSON.stringify([source, conversation]);
const items = JSON.parse(call('threads.timeline', input));
assert.equal(items[2].at, items[1].at, 'answer stays after its question despite timestamp skew');
assert.equal(JSON.parse(call('threads.preview', JSON.stringify([items]))), 'Kept தமிழ் café.');
assert.equal(vm.runInContext('typeof injected', context), 'undefined', 'record text cannot execute');
assert.equal(JSON.stringify([source, conversation]), input, 'rendering never changes records');
assert.equal(JSON.parse(call('calendar.nextOn', JSON.stringify([{ when: { date: '2026-01-31' }, repeat: { rule: 'monthly' } }, '2026-02-01']))), '2026-02-28');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
for (const [first, second] of [['js/shared/commitment-calendar.js', 'js/shared/thread-core.js'], ['js/shared/commitment-calendar.js', 'js/core/commitments.js'], ['js/shared/thread-core.js', 'js/core/threads-page.js']]) {
    assert.ok(scripts.indexOf(first) >= 0 && scripts.indexOf(first) < scripts.indexOf(second), `${first} loads before ${second}`);
}
console.log('Shared core: desktop identity, headless bundle, no host globals, JSON isolation and recurrence passed');

// Local snapshots reuse sender membership, recurrence and timeline rules.
const membership = require('../js/shared/sender-membership');
const desktopSenders = require('../js/core/senders');
for (const key of ['resolve', 'senderOfIn', 'isToDo', 'nenva', 'reminders']) assert.equal(desktopSenders[key], membership[key]);
const snapshotSource = {
    senders: { senders: { 'sender:school': { id: 'sender:school', name: 'School', state: 'active', confirmed: true } },
        place: { 'matter:fees': { sender: 'sender:school' } } },
    matters: { matters: { 'matter:fees': { id: 'matter:fees', title: 'School fees', state: 'open', tasks: ['pay'], createdAt: '2026-10-10' } } },
    commitments: { items: [
        { id: 'pay', title: 'Pay the school', state: 'open', when: { date: '2026-10-11' } },
        { id: 'milk', title: 'Buy milk', state: 'open', when: { date: '2026-10-11' } },
        { id: 'secret', title: 'Do not expose', state: 'open', privacySources: ['slack'], when: { date: '2026-10-11' } }
    ] },
    conversations: { conversations: [
        { id: 'general', messages: [{ role: 'user', content: 'Kept conversation' }] },
        { id: 'private', private: true, messages: [{ role: 'user', content: 'Never persisted' }] }
    ] }
};
const beforeSnapshot = JSON.stringify(snapshotSource);
const snapshot = JSON.parse(call('threads.snapshot', JSON.stringify([snapshotSource, '2026-10-11'])));
assert.deepEqual(snapshot.threads.slice(0, 2).map(x => x.key), ['nenva', 'sender:reminders']);
assert.deepEqual(snapshot.due.map(x => x.key), ['sender:school', 'sender:reminders']);
assert.equal(snapshot.threads[0].conversations.length, 1);
assert.equal(snapshot.threads.find(x => x.key === 'sender:school').info.open.length, 2);
assert.equal(JSON.stringify(snapshot).includes('Do not expose'), false);
assert.equal(JSON.stringify(snapshotSource), beforeSnapshot, 'display never mutates or executes');
assert.ok(scripts.indexOf('js/shared/commitment-calendar.js') < scripts.indexOf('js/shared/sender-membership.js'));
assert.ok(scripts.indexOf('js/shared/sender-membership.js') < scripts.indexOf('js/core/senders.js'));
console.log('Mobile records: local membership, Reminders, private exclusion and read-only projection passed');

for (const [module, host] of [['commitments', desktopCalendar], ['senders', desktopSenders], ['matters', require('../js/core/matters')]]) {
    const shared = require(`../js/shared/${module}-records`);
    for (const [key, fn] of Object.entries(shared)) assert.equal(host[key], fn, `${module}.${key} is shared`);
    assert.ok(scripts.indexOf(`js/shared/${module}-records.js`) < scripts.indexOf(`js/core/${module}.js`));
}
const prepare = (blobs, operation, args, id = 'fresh-action') => JSON.parse(call('records.prepare', JSON.stringify([blobs, { id, operation, args }])));
let records = { commitments: { custom: 'keep', items: [], ledger: [] }, senders: { future: 'keep' } };
const original = JSON.stringify(records);
const sender = prepare(records, 'sender.create', { name: 'School', allGood: 'Fees paid' }, 'action-1');
assert.equal(sender.ok, true);
assert.equal(JSON.stringify(records), original, 'prepare cannot publish writes');
records = { ...records, ...sender.changes };
const senderId = sender.receipt.target;
const created = prepare(records, 'commitment.create', { fields: { title: 'Pay the fee', when: { date: '2026-10-20', time: '09:00' } }, sender: senderId }, 'action-2');
assert.equal(created.ok, true);
assert.equal(created.changes.commitments.custom, 'keep');
assert.equal(created.changes.senders.future, 'keep');
assert.equal(created.changes.senders.place[`task:${created.receipt.target}`].sender, senderId);
assert.ok(created.receipt.ledgerId);
records = { ...records, ...created.changes };
assert.deepEqual(prepare(records, 'commitment.create', { fields: { title: 'DUPLICATE' } }, 'action-2').changes, {});
assert.equal(prepare(records, 'commitment.create', { fields: { title: 'Bad day', when: { date: '2026-02-30' } } }, 'invalid').ok, false);
assert.equal(prepare(records, 'commitment.create', { fields: { title: 'Dropped secret field', surprise: 'done' } }, 'invalid-2').ok, false);
assert.equal(prepare(records, 'commitment.change', { target: '__proto__', fields: { title: 'attack' } }).ok, false);
const changed = prepare(records, 'commitment.change', { target: created.receipt.target, fields: { title: 'Pay tuition' } }, 'action-3');
assert.equal(changed.ok, true);
records = { ...records, ...changed.changes };
assert.equal(prepare(records, 'commitment.undo', { target: created.receipt.ledgerId }, 'undo-old').ok, false);
const undone = prepare(records, 'commitment.undo', { target: changed.receipt.ledgerId }, 'undo-new');
assert.equal(undone.ok, true);
assert.equal(undone.record.title, 'Pay the fee');
const beforeInvalid = JSON.stringify(records);
assert.equal(prepare(records, 'commitment.create', { fields: { title: 'No orphan' }, sender: 'missing' }, 'invalid-3').ok, false);
assert.equal(JSON.stringify(records), beforeInvalid);
assert.equal(prepare({ commitments: { items: 'corrupt' } }, 'sender.create', { name: 'No overwrite' }).ok, false);
assert.equal(prepare(records, 'constructor', {}).ok, false);
console.log('Shared writes: desktop identity, isolated drafts, strict fields, membership, replay and ledger Undo passed');
const filed = prepare(records, 'matter.file', {
    observation: { id: 'email-1', source: 'email', own: false, who: 'School', title: 'Tuition', text: 'Please pay the tuition by October 20.', summary: 'Pay tuition' },
    judgment: { about: 'new', kind: 'bill', title: 'Tuition', status: 'Payment due', next: { what: 'Pay tuition', quote: 'Please pay the tuition', by: '2026-10-20', by_quote: 'by October 20', yours: true } },
    sender: senderId
}, 'file-1');
assert.equal(filed.ok, true);
assert.equal(filed.record.next.by, '2026-10-20');
assert.equal(filed.changes.senders.place[filed.record.id].sender, senderId);
assert.equal(filed.changes.commitments, undefined, 'filing evidence never executes or invents a commitment');
assert.equal(prepare({ ...records, ...filed.changes }, 'matter.file', {
    observation: { id: 'email-1', source: 'email', text: 'Different' }, judgment: { about: 'new', title: 'Overwrite' }
}, 'file-again').ok, false, 'a redelivery cannot overwrite a previously filed source');
console.log('Shared matter filing: source checks, sender placement and repeated-source protection passed');
const recurringSource = { commitments: { items: [{ id: 'daily', title: 'Walk', state: 'open', repeat: { rule: 'daily' }, when: { date: '2026-10-01' }, history: { '2026-10-11': 'done' } }] } };
const recurringSnapshot = JSON.parse(call('threads.snapshot', JSON.stringify([recurringSource, '2026-10-11'])));
const occurrence = recurringSnapshot.threads.find(r => r.key === 'task:daily');
assert.equal(occurrence.info.open[0].done, true, 'a completed occurrence can reopen even while its repeating record stays open');
console.log('Mobile completion controls: occurrence state comes from the shared calendar');

const agendaSource = {
    senders: snapshotSource.senders,
    commitments: { items: [
        { id: 'moved', title: 'Moved run', state: 'open', when: { date: '2026-10-01', time: '09:00' }, repeat: { rule: 'daily' }, moved: { '2026-10-11': { time: '15:00' } } },
        { id: 'finished', title: 'Already done', state: 'open', when: { date: '2026-10-01' }, repeat: { rule: 'daily' }, history: { '2026-10-11': 'done', '2026-10-12': 'dropped' } },
        { id: 'past', title: 'Past due', state: 'open', when: { date: '2026-10-09' } },
        { id: 'milk', title: 'Buy milk', state: 'open', when: { date: '2026-10-12' } },
        { id: 'unknown', title: 'No date yet', state: 'open' },
        { id: 'secret', title: 'Never show', state: 'open', privacySources: ['slack'], when: { date: '2026-10-11' } }
    ] },
    matters: { matters: {
        'matter:fees': { id: 'matter:fees', title: 'School fees', state: 'open', next: { state: 'open', by: '2026-10-11' } },
        'matter:invalid': { id: 'matter:invalid', title: 'Invalid evidence', state: 'open', next: { state: 'open', by: '2026-10-11', evidenceInvalidated: true } },
        'matter:linked': { id: 'matter:linked', title: 'Duplicate old deadline', state: 'open', tasks: ['milk'], next: { state: 'open', taskId: 'milk', by: '2026-10-11' } },
        'matter:appointment': { id: 'matter:appointment', title: 'Dentist', kind: 'appointment', state: 'open', when: { date: '2026-10-12', time: '10:00' } }
    } },
    conversations: { conversations: [
        { id: 'general', updatedAt: '2026-10-10', messages: [{ role: 'user', content: 'A trusted question' }] },
        { id: 'source', todayKey: 'nenva', untrusted: true, updatedAt: '2026-10-12', messages: [{ role: 'user', content: 'Pasted source' }] },
        { id: 'private', private: true, updatedAt: '2026-10-13', messages: [{ role: 'user', content: 'Private conversation' }] }
    ] }
};
const agendaBefore = JSON.stringify(agendaSource);
const agendaSnapshot = JSON.parse(call('threads.snapshot', JSON.stringify([agendaSource, '2026-10-11'])));
const agenda = agendaSnapshot.schedule;
assert.deepEqual(agenda.today.map(r => [r.title, r.time, r.key]), [['Moved run', '15:00', 'task:moved'], ['School fees', null, 'sender:school']]);
assert.deepEqual(agenda.overdue.map(r => r.title), ['Past due']);
assert.equal(agenda.coming.length, 7);
assert.deepEqual(agenda.coming[0].items.map(r => [r.title, r.time]), [['Moved run', '09:00'], ['Dentist', '10:00'], ['Buy milk', null]]);
assert.equal(agenda.coming[1].items.some(r => r.title === 'Already done'), true, 'done or skipped today never ends the repeat');
assert.equal(JSON.stringify(agenda).includes('Never show'), false);
assert.equal(JSON.stringify(agenda).includes('Invalid evidence'), false);
assert.equal(JSON.stringify(agenda).includes('Duplicate old deadline'), false);
assert.equal(agendaSnapshot.threads[0].conversationId, 'general', 'pasted source cannot take over the general composer');
assert.equal(agendaSnapshot.threads.find(r => r.key === 'task:moved').timeLabel, '', 'unknown creation dates have no invented list time');
assert.equal(agendaSnapshot.threads[0].items[0].text, 'A trusted question');
assert.equal(agendaSnapshot.threads[0].conversations.length, 2, 'source history remains reachable, private history stays excluded');
assert.equal(JSON.stringify(agendaSource), agendaBefore, 'opening the day never changes records or executes work');
console.log('Mobile agenda: moved times, occurrence completion, seven local dates, past due, source evidence, thread doors and trusted chat selection passed');
