// OccurrenceCapture (js/agent/occurrence-capture.js): what the person says
// about one day of a commitment lands on that day, with one Undo.
const assert = require('assert');
const store = {};
global.StorageManager = { get: k => (store[k] ? JSON.parse(JSON.stringify(store[k])) : null), set: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
const C = require('../js/core/commitments.js');
const O = require('../js/agent/occurrence-capture.js');

const today = '2026-10-06';   // a Tuesday
const workout = { ...C.blank('w', '2026-06-01T00:00:00Z'), title: 'Workout', when: { date: '2026-06-01', time: null, end: null }, repeat: { rule: 'weekly', days: [1] } };
const once = { ...C.blank('o', '2026-06-01T00:00:00Z'), title: 'File taxes', when: { date: '2026-10-08', time: null, end: null } };

// The days a report may be about: real occurrences, newest first, none ahead.
assert.deepStrictEqual(C.recentDays(workout, today, 3), ['2026-10-05', '2026-09-28', '2026-09-21']);
assert.deepStrictEqual(C.recentDays(once, today), [today]);

// O2: the quote is the person's own words.
const said = 'did Monday\'s workout this morning, 40 minutes, knee was sore';
assert.strictEqual(O.vet({ report: 'done', quote: 'ran a marathon', day: '2026-10-05' }, workout, said, today), null);
assert.strictEqual(O.vet({ report: 'none', quote: '40 minutes' }, workout, said, today), null);

// O3: the day. Monday's, said on Tuesday, is Monday's; the day it was done snaps to the one it was for.
let j = O.vet({ report: 'done', quote: '40 minutes, knee was sore', day: '2026-10-05' }, workout, said, today);
assert.strictEqual(j.day, '2026-10-05'); assert.strictEqual(j.how, 'done');
assert.strictEqual(j.receipt, 'Mon, Oct 5: done · "40 minutes, knee was sore"');
assert.strictEqual(O.vet({ report: 'done', quote: '40 minutes', day: today }, workout, said, today).day, '2026-10-05', 'done on Tuesday: filed on Monday, never a Tuesday occurrence');
assert.strictEqual(O.vet({ report: 'done', quote: '40 minutes', day: '2026-10-09' }, workout, said, today), null, 'a day ahead');
assert.strictEqual(O.vet({ report: 'done', quote: '40 minutes', day: null }, workout, said, today), null, 'no day, no guess');
assert.strictEqual(O.vet({ report: 'skipped', quote: '40 minutes', day: '2026-09-28' }, workout, said, today).how, 'dropped');
// A one-time one: the day it was said; "skipped" is only a note.
j = O.vet({ report: 'skipped', quote: 'knee was sore' }, once, said, today);
assert.strictEqual(j.day, today); assert.strictEqual(j.how, null);
// O5: the turn's own tool already marked it: only the words are kept.
assert.strictEqual(O.vet({ report: 'done', quote: '40 minutes', day: '2026-10-05' }, workout, said, today, { marked: true }).how, null);

// Which chats.
assert.strictEqual(O.eligible({ id: 'a' }), true);
assert.strictEqual(O.eligible({ id: 'a' }, { untrusted: true }), false);
assert.strictEqual(O.eligible({ id: 'a', contextMode: 'simple' }), false);
// The prompt lists the real days and names one as its example.
const p = O._prompt(workout, said, null, today);
assert.ok(p.includes('2026-10-05 (Mon, Oct 5)') && p.includes('for example "2026-10-05"'));

// O4: one write, one Undo, through the door.
store[C.KEY] = { items: [workout, once], ledger: [], tombstones: {} };
C._data = null;
const realToday = C.today();
const day = C.recentDays(C.get('w'), realToday)[0];
let r = C.report('w', { day, how: 'done', quote: '40 minutes, knee was sore' });
assert.ok(r.ok && r.ledgerId); assert.deepStrictEqual(r.changed, ['log', 'state']);
assert.strictEqual(C.get('w').history[day], 'done');
assert.strictEqual(C.get('w').log[day][0].quote, '40 minutes, knee was sore');
assert.ok(C.readFacts(C.get('w'), C.all(), realToday).saidOnDays[0].includes('(done): "40 minutes, knee was sore"'));
assert.deepStrictEqual(C.report('w', { day, how: 'done', quote: '40 minutes, knee was sore' }).changed, [], 'the same report again writes nothing');
const r2 = C.report('w', { day, quote: 'felt better after' });
assert.deepStrictEqual(r2.changed, ['log']); assert.strictEqual(C.get('w').log[day].length, 2);
assert.ok(C.undo(r2.ledgerId).ok); assert.strictEqual(C.get('w').log[day].length, 1);
assert.ok(C.undo(r.ledgerId).ok);
assert.ok(!C.get('w').history[day] && !(C.get('w').log && C.get('w').log[day]), 'Undo takes back the mark and the words');
// A repeat refuses a day it does not happen on, and a day ahead.
const tue = (() => { const d = new Date(`${day}T12:00:00`); d.setDate(d.getDate() + 1); return C.iso(d); })();
if (tue <= realToday) assert.ok(!C.report('w', { day: tue, quote: 'x' }).ok);
assert.ok(!C.report('w', { day: '2999-01-04', quote: 'x' }).ok);
// A one-time one: done closes it, Undo reopens it.
r = C.report('o', { how: 'done', quote: 'filed them' });
assert.strictEqual(C.get('o').state, 'done');
assert.ok(C.undo(r.ledgerId).ok); assert.strictEqual(C.get('o').state, 'open');

console.log('occurrence-capture: the quote, the day, the one write and its undo passed');

// "Could not this morning, will do it this evening" is a plan for today, not a report.
{
    const mon = '2026-10-05';
    const words = 'i could not do the workout this morning. planning to do it this evening.';
    const p = O.vet({ report: 'later', quote: 'planning to do it this evening', day: mon }, workout, words, mon);
    assert.deepStrictEqual([p.day, p.how, p.plan], [mon, null, true]);
    assert.match(p.receipt, /still to come/);
    assert.strictEqual(O.vet({ report: 'later', quote: 'planning to do it this evening', day: mon }, workout, words, today), null, 'only ever about today');
    assert.strictEqual(O.vet({ report: 'later', quote: 'planning to do it this evening', day: mon }, { ...workout, history: { [mon]: 'done' } }, words, mon), null, 'already done');
    assert.match(O._prompt(workout, words, '', mon), /"later" if they say today's is not done yet/);
    console.log('occurrence-capture: a plan for later today passed');
}
