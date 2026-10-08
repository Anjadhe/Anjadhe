// ThingCapture (js/agent/thing-capture.js, docs/NOW.md R4): the one chat
// judge's pure parts — which thing a chat is about, what the answer means
// for the card, and the plan for the record through the existing checks.
const assert = require('assert');
global.MatterCapture = require('../js/agent/matter-capture.js');
global.OccurrenceCapture = require('../js/agent/occurrence-capture.js');
const C = require('../js/core/commitments.js');
const T = require('../js/agent/thing-capture.js');

// Which chats are tied to a thing.
assert.deepStrictEqual(T.thingOf({ todayKey: 'matter:matter:m1' }), { thing: 'matter:matter:m1', type: 'matter', id: 'matter:m1' });
assert.deepStrictEqual(T.thingOf({ todayKey: 'task:t1' }), { thing: 'task:t1', type: 'task', id: 't1' });
assert.strictEqual(T.thingOf({ todayKey: 'page:commitments' }), null, 'a page chat is not about one thing');
assert.strictEqual(T.thingOf({}), null);
assert.strictEqual(T.eligible({ todayKey: 'task:t1' }), true);
assert.strictEqual(T.eligible({ todayKey: 'task:t1' }, { untrusted: true }), false);
assert.strictEqual(T.eligible({ todayKey: 'task:t1' }, { headless: true }), false);
assert.strictEqual(T.eligible({ todayKey: 'task:t1', contextMode: 'simple' }), false);

// The card: only the three words, only at the person's word.
assert.strictEqual(T.cardOf({ card: 'gone' }), 'gone');
assert.strictEqual(T.cardOf({ card: 'LATER' }), 'later');
assert.strictEqual(T.cardOf({ card: 'drop' }), 'gone', 'a near-synonym from a small model is read');
assert.strictEqual(T.cardOf({ card: 'maybe' }), 'keep');
assert.strictEqual(T.cardOf(null), 'keep');
const trip = { thing: 'trip:x', type: 'trip', id: 'x' };
assert.deepStrictEqual(T.planFor({ card: 'gone', quote: 'ignore it' }, trip, { card: { title: 'Seattle' } }, 'just ignore it please'), { card: 'gone', record: null, quote: 'ignore it' });
assert.strictEqual(T.planFor({ card: 'gone', quote: 'drop it' }, trip, {}, 'what is this?').card, 'keep', 'a quote not in their words keeps the card');

// A folder: "paid it" closes the folder (MatterCapture.vet) and the card goes.
const m = { id: 'matter:m1', kind: 'bill', state: 'open', title: 'Water bill', status: 'Due Oct 14', amount: '$82', when: { date: '2026-10-14' }, next: { what: 'Pay it', state: 'open', how: 'link' }, sources: [] };
const mt = { thing: 'matter:matter:m1', type: 'matter', id: 'matter:m1' };
const paid = T.planFor({ card: 'gone', change: 'done', quote: 'paid it yesterday' }, mt, { matter: m }, 'I paid it yesterday', Date.parse('2026-10-06T12:00:00Z'));
assert.strictEqual(paid.card, 'gone');
assert.strictEqual(paid.record.door, 'matter');
assert.strictEqual(paid.record.j.change, 'done');
assert.strictEqual(paid.record.j.quote, 'paid it yesterday');
// "ignore it": the card goes, the folder is not changed by the judge (Ignore is the card's own button, run by letGoFromChat).
const ign = T.planFor({ card: 'gone', change: 'none', quote: 'ignore it' }, mt, { matter: m }, 'just ignore it');
assert.strictEqual(ign.card, 'gone');
assert.strictEqual(ign.record, null);
// A new date: the folder changes, the card stays.
const moved = T.planFor({ card: 'keep', change: 'changed', quote: 'moved it to the 20th', when: '2026-10-20' }, mt, { matter: m }, 'they moved it to the 20th', Date.parse('2026-10-06T12:00:00Z'));
assert.strictEqual(moved.card, 'keep');
assert.strictEqual(moved.record.j.when, '2026-10-20');
// A number the folder and the words lack is dropped by the check.
const bad = T.planFor({ card: 'keep', change: 'changed', quote: 'moved it', status: 'now $120' }, mt, { matter: m }, 'they moved it', Date.parse('2026-10-06T12:00:00Z'));
assert.strictEqual(bad.record, null);

// A commitment: a report lands on its day (OccurrenceCapture.vet); "cancel it" drops a one-time one.
const today = '2026-10-06';
const once = { ...C.blank('t1', '2026-09-01T00:00:00Z'), title: 'Send the deck', state: 'open', when: { date: '2026-10-04', time: null, end: null } };
const tk = { thing: 'task:t1', type: 'task', id: 't1' };
const facts = { commitment: once, repeats: false, today };
const cancel = T.planFor({ card: 'gone', report: 'none', record: 'cancelled', quote: 'cancel it' }, tk, facts, 'cancel it, not needed any more');
assert.deepStrictEqual(cancel.record, { door: 'resolve', how: 'dropped', quote: 'cancel it' });
assert.strictEqual(cancel.card, 'gone');
const ignoreWords = 'these can be ignored because i returns books once in a while';
const ignoreRaw = { card: 'gone', report: 'none', record: 'ignored', quote: ignoreWords };
const ignore = T.planFor(ignoreRaw, tk, facts, ignoreWords);
assert.deepStrictEqual(ignore.record, { door: 'resolve', how: 'dropped', quote: ignoreWords }, 'ignoring an alert also closes the task');
assert.strictEqual(T.planFor({ ...ignoreRaw, report: 'note' }, tk, facts, ignoreWords).record.door, 'resolve', 'a note about their habits does not replace ignoring this task');
assert.strictEqual(T.planFor(ignoreRaw, tk, facts, 'what is this?').record, null, 'no change without their own words');
assert.strictEqual(T.planFor(ignoreRaw, tk, { ...facts, commitment: { ...once, state: 'done' } }, ignoreWords).record, null, 'do not overwrite an already finished task');
assert.strictEqual(T.planFor({ card: 'gone', report: 'none', record: 'none', quote: 'hide only the card' }, tk, facts, 'hide only the card').record, null, 'card dismissal alone never drops the task');
const didIt = T.planFor({ card: 'gone', report: 'done', quote: 'sent it this morning' }, tk, facts, 'sent it this morning');
assert.strictEqual(didIt.record.door, 'report');
assert.strictEqual(didIt.record.j.how, 'done');
assert.strictEqual(didIt.record.j.day, today);
// A repeat is never cancelled whole from here; a day of it is reported on.
const weekly = { ...C.blank('w1', '2026-06-01T00:00:00Z'), title: 'Workout', state: 'open', when: { date: '2026-06-01', time: '07:00', end: null }, repeat: { rule: 'weekly', days: [1] } };
const wk = { thing: 'task:w1', type: 'task', id: 'w1' };
const rep = T.planFor({ card: 'keep', report: 'none', record: 'cancelled', quote: 'cancel it' }, wk, { commitment: weekly, repeats: true, today: '2026-10-06' }, 'cancel it');
assert.strictEqual(rep.record, null, 'a repeat is changed through its tools, with their asks');
assert.strictEqual(T.planFor(ignoreRaw, wk, { commitment: weekly, repeats: true, today }, ignoreWords).record, null, 'ignore never cancels a repeating series from capture');
const skipped = T.planFor({ card: 'keep', report: 'skipped', quote: 'skipped it today', day: '2026-10-05' }, wk, { commitment: weekly, repeats: true, today: '2026-10-06' }, 'skipped it today, knee');
assert.strictEqual(skipped.record.j.how, 'dropped');
assert.strictEqual(skipped.record.j.day, '2026-10-05');
// A question changes nothing.
assert.deepStrictEqual(T.planFor({ card: 'keep', report: 'none', record: 'none', quote: '' }, tk, facts, 'when is it due?'), { card: 'keep', record: null, quote: '' });

// The prompt carries the card clause into the folder's and the commitment's own prompts.
assert.match(T._prompt(mt, { matter: m }, 'hi', null), /"card": what they want done with this on their Now page/);
assert.match(T._prompt(tk, facts, 'hi', null), /"record": "ignored"/);
assert.doesNotMatch(T._prompt(wk, { commitment: weekly, repeats: true, today }, 'hi', null), /"record": "ignored"/);
assert.match(T._prompt(trip, { card: { title: 'Seattle trip', body: 'Flights Thursday' } }, 'hi', null), /THE CARD\nSeattle trip\nFlights Thursday/);

console.log('thing-capture: which thing, the card at their word, a folder and a commitment through the existing checks, cancel on a one-time only passed');

// The detail-page path, with the actual store/bridge and no Now card.
// The model answer is scripted; now-eval.js separately tests the judgment.
(async () => {
    const store = {};
    global.StorageManager = { get: k => store[k] ? structuredClone(store[k]) : null, set: (k, v) => { store[k] = structuredClone(v); } };
    global.Commitments = C;
    global.FEATURES = { isEnabled: () => true };
    global.AgentService = { model: 'test', numCtx: 8192 };
    C._inited = true;
    const library = { ...once, title: 'Return overdue library books', when: { date: C.today() }, origin: { kind: 'email', ref: 'library-alert' } };
    store[C.KEY] = { items: [library], ledger: [], tombstones: {} };
    C._data = null;
    let calls = 0;
    global.LLMLogger = { call: async () => { calls++; return { message: { content: JSON.stringify(ignoreRaw) } }; } };
    global.SimpleExperience = { cardForThing: () => null };
    const conv = { id: 'library-chat', todayKey: 'task:t1', messages: [] };
    const out = await T.beforeReply({ conv, userText: ignoreWords });
    assert.ok(out);
    assert.strictEqual(C.get('t1').state, 'dropped');
    assert.strictEqual(store[C.KEY].items[0].state, 'dropped', 'the change persists, not just a hidden card');
    assert.strictEqual(store.schedule.scheduleItems[0].history[C.today()], 'abandoned', 'schedule consumers receive the ignored state too');
    assert.strictEqual(store[C.KEY].ledger.length, 1);
    assert.match(out.line, /marked ignored/);
    const receipt = out.receipts[0].occurrence;
    assert.ok(receipt.ledgerId);
    assert.ok(C.undo(receipt.ledgerId).ok);
    assert.strictEqual(C.get('t1').state, 'open', 'Undo restores the task');
    assert.ok(!C.get('t1').history[C.today()]);
    for (const gates of [{ untrusted: true }, { headless: true }]) {
        assert.strictEqual(await T.beforeReply({ conv, userText: ignoreWords, ...gates }), null);
    }
    global.PrivateChat = { isPrivate: () => true };
    assert.strictEqual(await T.beforeReply({ conv, userText: ignoreWords }), null);
    assert.strictEqual(calls, 1, 'ineligible turns never run the judge');
    console.log('thing-capture: ignored email task persists without a card, projects to schedule, and has Undo; privacy gates passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
