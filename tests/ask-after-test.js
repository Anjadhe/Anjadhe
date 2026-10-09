// AskAfter (js/core/ask-after.js): when "how did it go?" is open, and what silences it.
const assert = require('assert');
const C = require('../js/core/commitments.js');
const A = require('../js/core/ask-after.js');
const at = (day, hm) => new Date(`${day}T${hm}:00`).getTime();
const mk = (id, x) => ({ ...C.blank(id, '2026-06-01T00:00:00Z'), title: id, read: { stance: 'fine', askAfter: true }, ...x });

const mon = '2026-10-05';
const workout = mk('workout', { when: { date: '2026-06-01', time: '07:00', end: null }, repeat: { rule: 'weekly', days: [1] } });
// Timed, no end: an hour long, asked two hours after.
assert.strictEqual(A.askAt(workout, mon), at(mon, '10:00'));
assert.strictEqual(A.askAt(mk('x', { when: { date: mon, time: '17:00', end: '18:30' } }), mon), at(mon, '20:30'));
assert.strictEqual(A.askAt(mk('x', { when: { date: mon, time: null, end: null } }), mon), at(mon, '18:00'), 'untimed: the evening');

assert.deepStrictEqual(A.due([workout], at(mon, '09:59')), [], 'not yet');
assert.strictEqual(A.due([workout], at(mon, '10:00'))[0].day, mon);
assert.strictEqual(A.due([workout], at('2026-10-06', '01:30'))[0].day, mon, 'still open into the night, as yesterday');
assert.deepStrictEqual(A.due([workout], at('2026-10-06', '02:00')), [], 'then it lapses');
assert.deepStrictEqual(A.due([workout], at('2026-10-07', '10:00')), [], 'not a day it happens');

// Anything already on the day silences it: a mark, or words said in the chat.
assert.deepStrictEqual(A.due([{ ...workout, history: { [mon]: 'done' } }], at(mon, '12:00')), []);
assert.deepStrictEqual(A.due([{ ...workout, history: { [mon]: 'dropped' } }], at(mon, '12:00')), []);
assert.deepStrictEqual(A.due([{ ...workout, log: { [mon]: [{ at: 'x', quote: 'knee was sore' }] } }], at(mon, '12:00')), []);
// Only what the assistant judged worth asking after; never one the person stopped, or a closed one.
assert.deepStrictEqual(A.due([{ ...workout, read: { askAfter: false } }], at(mon, '12:00')), []);
assert.deepStrictEqual(A.due([{ ...workout, read: null }], at(mon, '12:00')), []);
assert.deepStrictEqual(A.due([{ ...workout, read: { askAfter: true, stopAsk: true } }], at(mon, '12:00')), []);
assert.deepStrictEqual(A.due([mk('once', { when: { date: mon, time: '07:00', end: null }, state: 'done' })], at(mon, '12:00')), []);
assert.strictEqual(A.due([mk('once', { when: { date: mon, time: '07:00', end: null } })], at(mon, '12:00')).length, 1, 'a one-time one too');

// A day moved for that day only is asked about after ITS time, not the usual one.
const movedDay = { ...workout, moved: { [mon]: { time: '18:30', end: '19:30' } } };
assert.strictEqual(A.askAt(movedDay, mon), at(mon, '21:30'));
assert.deepStrictEqual(A.due([movedDay], at(mon, '13:00')), [], 'the evening has not come');
assert.strictEqual(A.due([movedDay], at(mon, '21:30')).length, 1);
assert.strictEqual(A.askAt(movedDay, '2026-10-12'), at('2026-10-12', '10:00'), 'next week is the usual time again');
// "Will do it this evening" is a plan, not a report: the question waits, it does not go away.
const planned = { ...workout, log: { [mon]: [{ at: 'x', quote: 'will do it this evening', plan: true }] } };
assert.deepStrictEqual(A.due([planned], at(mon, '13:00')), [], 'not asked in the afternoon');
assert.strictEqual(A.due([planned], at(mon, '20:00')).length, 1, 'asked once the evening has had its chance');
assert.deepStrictEqual(A.due([{ ...planned, log: { [mon]: [...planned.log[mon], { at: 'y', quote: 'did it, felt good' }] } }], at(mon, '20:00')), [], 'a real report still silences it');

// The question is code's, from the title and the day.
const x = A.due([workout], at(mon, '12:00'))[0];
assert.strictEqual(A.question(x, at(mon, '12:00')), 'How did “workout” go?');
assert.strictEqual(A.question(x, at('2026-10-06', '01:00')), 'How did “workout” go yesterday?');
assert.strictEqual(A.key(x), `askafter:workout:${mon}`);

// One notification per occurrence, never at night, never while looking at Now.
assert.strictEqual(A.nudgeChoice([x], {}, new Date(at(mon, '12:00'))), x);
assert.strictEqual(A.nudgeChoice([x], { [A.key(x)]: 1 }, new Date(at(mon, '12:00'))), null);
assert.strictEqual(A.nudgeChoice([x], {}, new Date(at(mon, '22:00'))), null);
assert.strictEqual(A.nudgeChoice([x], {}, new Date(at(mon, '12:00')), { looking: true }), null);

// The read carries the judgment; a thing with no day cannot be asked after.
const today = '2026-10-05';
const undated = { ...C.blank('u', '2026-09-01T00:00:00Z'), title: 'u' };
const reads = C.vetReads({ reads: [{ id: 'C1', stance: 'fine', ask_after: true }, { id: 'C2', stance: 'fine', ask_after: true }, { id: 'C3', stance: 'fine' }] }, [workout, undated, { ...workout, id: 'w2' }], [workout, undated], today);
assert.strictEqual(reads.workout.askAfter, true); assert.strictEqual(reads.u.askAfter, false); assert.strictEqual(reads.w2.askAfter, false);
// A repeat read before this existed is read once more.
const old = { ...workout, read: { stance: 'fine', fp: C.readFp(workout, [workout], today), next: '2026-12-01' } };
assert.ok(C.dueForRead([old], today).includes(old));
old.read.askAfter = false;
assert.ok(!C.dueForRead([old], today).includes(old));

console.log('ask-after: when it opens, what silences it, the nudge, the read passed');
