// SenderLook (js/core/sender-look.js, docs/SENDERS.md M6): the pure core.
const assert = require('assert');
const L = require('../js/core/sender-look.js');

const s = { id: 'sender:auto', name: 'Auto insurance', allGood: 'Covered, paid, the renewal not missed.' };
const items = [
    { key: 'matter:r', title: 'GEICO renewal', what: 'bill from their mail or texts', open: true, status: 'Renews Nov 2', next: 'Review the renewal', when: 'Nov 2', amount: '$612', onNow: '', updatedAt: '2026-10-09T10:00:00Z' },
    { key: 'matter:c', title: 'New ID cards', what: 'other from their mail or texts', open: true, status: 'Ready to print', next: '', when: '', amount: '', onNow: 'Print your new ID cards', updatedAt: '2026-10-08T10:00:00Z' },
    { key: 'matter:p', title: 'September payment', what: 'bill from their mail or texts', open: false, status: 'Paid', next: '', when: '', amount: '', onNow: '', updatedAt: '2026-09-20T10:00:00Z' }
];

// The sheet names everything the look needs, and what is already in front of them.
const sheet = L.sheetLines(s, items, ['Agent is Dana Ruiz.']).join('\n');
assert.ok(sheet.includes('ALL GOOD MEANS: Covered, paid') && sheet.includes('Agent is Dana Ruiz.'));
assert.ok(sheet.includes('"GEICO renewal" (bill from their mail or texts, id matter:r), Nov 2, $612; status: Renews Nov 2; next step: Review the renewal'));
assert.ok(sheet.includes('ALREADY IN FRONT OF THEM: "Print your new ID cards"'));
assert.ok(sheet.includes('SETTLED LATELY:') && sheet.includes('"September payment"'));
assert.ok(L.sheetLines({ name: 'X' }, []).join('\n').includes('ALL GOOD: not said yet'));

// What changed, by the items' own state.
const fig = L.figures(items);
assert.deepStrictEqual(L.changes(null, items), []);
assert.deepStrictEqual(L.changes(fig, items), []);
const later = [{ ...items[0], open: false }, { ...items[1], updatedAt: 'x' }, items[2], { key: 'matter:n', title: 'Claim', open: true }];
assert.deepStrictEqual(L.changes(fig, later), ['"GEICO renewal" was settled.', '"New ID cards" changed.', '"Claim" is new since your last look.']);
assert.notStrictEqual(L.fingerprint(s, items), L.fingerprint(s, later));
assert.notStrictEqual(L.fingerprint(s, items), L.fingerprint(s, items, ['a fact']));

// Pace (L1): first look, changed, look-again day, slow; never twice a day, not right after a try.
const now = new Date('2026-10-10T12:00:00');
const fp = L.fingerprint(s, items);
assert.strictEqual(L.due({}, fp, now), true);
assert.strictEqual(L.due({ lookedAt: now - 86400000 * 3, lookedDay: '2026-10-07', fp }, fp, now), false);
assert.strictEqual(L.due({ lookedAt: now - 86400000 * 3, lookedDay: '2026-10-07', fp: 'old' }, fp, now), true);
assert.strictEqual(L.due({ lookedAt: now - 86400000 * 3, lookedDay: '2026-10-07', fp, lookAgain: '2026-10-10' }, fp, now), true);
assert.strictEqual(L.due({ lookedAt: now - 86400000 * 15, lookedDay: '2026-09-25', fp }, fp, now), true);
assert.strictEqual(L.due({ lookedAt: now - 3600000, lookedDay: '2026-10-10', fp: 'old' }, fp, now), false);
assert.strictEqual(L.due({ triedAt: now - 60000 }, fp, now), false);

// Which first: never looked, then changed, then the oldest; none past the day's budget.
const st = { senders: { a: { lookedAt: now - 86400000 * 20, lookedDay: 'x', fp: 'A' }, b: { lookedAt: now - 86400000 * 2, lookedDay: 'y', fp: 'old' } } };
assert.strictEqual(L.pickNext([{ id: 'a', fp: 'A' }, { id: 'b', fp: 'B' }, { id: 'c', fp: 'C' }], st, now).id, 'c');
assert.strictEqual(L.pickNext([{ id: 'a', fp: 'A' }, { id: 'b', fp: 'B' }], st, now).id, 'b');
assert.strictEqual(L.pickNext([{ id: 'a', fp: 'A' }], st, now).id, 'a');
assert.strictEqual(L.pickNext([{ id: 'c', fp: 'C' }], { ...st, day: { date: '2026-10-10', looks: L.LOOKS_PER_DAY } }, now), null);

// The check on a raise (L3).
const nb = { subjects: {} };
const known = new Set(['612', '2']);
const ok = L.vetRaise({ item: 'matter:r', title: 'Your renewal is Nov 2', body: 'It renews at $612 and nothing is done yet. I can compare it with last year.', offer: 'Compare', ask: 'Compare my renewal with last year' }, { s, items, known, nb, nowMs: +now });
assert.strictEqual(ok.card.subject, 'sender:sender:auto');
assert.strictEqual(ok.card.item, 'matter:r');
assert.ok(L.vetRaise({ title: 'x', body: 'y' }, { s, items, known, nb, nowMs: +now, raisedSoFar: [ok.card] }).error);
assert.ok(/already in front/.test(L.vetRaise({ item: 'matter:c', title: 'Print', body: 'Print them.' }, { s, items, known, nb, nowMs: +now }).error));
assert.ok(/Everything open here/.test(L.vetRaise({ title: 'a', body: 'b' }, { s, items: [items[1], items[2]], known, nb, nowMs: +now }).error));
assert.ok(/must be the id/.test(L.vetRaise({ item: 'matter:zz', title: 'a', body: 'b' }, { s, items, known, nb, nowMs: +now }).error));
assert.ok(/not in anything you read: 700/.test(L.vetRaise({ title: 'Up to $700', body: 'A rise.' }, { s, items, known, nb, nowMs: +now }).error));
assert.ok(/1 to 4 words/.test(L.vetRaise({ title: 'a', body: 'b', offer: 'Compare my renewal price with last year' }, { s, items, known, nb, nowMs: +now }).error));
assert.ok(/Too long/.test(L.vetRaise({ title: 'x'.repeat(91), body: 'y' }, { s, items, known, nb, nowMs: +now }).error));
assert.ok(/not now/.test(L.vetRaise({ title: 'a', body: 'b' }, { s, items, known, nb: { subjects: { 'sender:sender:auto': { until: +now + 1000 } } }, nowMs: +now }).error));
assert.ok(/not to be asked/.test(L.vetRaise({ title: 'a', body: 'b' }, { s, items, known, nb: { subjects: { 'sender:sender:auto': { stop: true } } }, nowMs: +now }).error));

// Cards: answered, put off and stopped ones are not shown; gone senders are not shown.
const state = { senders: {
    a: { lookedAt: 2, cards: [{ sender: 'a', subject: 'sender:a', title: 'A' }], subjects: {} },
    b: { lookedAt: 3, cards: [{ sender: 'b', subject: 'sender:b', title: 'B' }], subjects: { 'sender:b': { answered: true } } },
    c: { lookedAt: 4, cards: [{ sender: 'c', subject: 'sender:c', title: 'C' }], subjects: { 'sender:c': { until: +now + 1 } } },
    d: { lookedAt: 5, cards: [{ sender: 'd', subject: 'sender:d', title: 'D' }], subjects: {} }
} };
assert.deepStrictEqual(L.shown(state, +now).map(c => c.title), ['D', 'A']);
assert.deepStrictEqual(L.shown(state, +now, id => id !== 'd').map(c => c.title), ['A']);

// One notification a day, in waking hours, never on a coach's day (L5).
assert.strictEqual(L.nudgeOk({}, now), true);
assert.strictEqual(L.nudgeOk({ nudged: '2026-10-10' }, now), false);
assert.strictEqual(L.nudgeOk({}, now, { coachNudged: '2026-10-10' }), false);
assert.strictEqual(L.nudgeOk({}, new Date('2026-10-10T07:00:00')), false);
console.log('sender-look-test: ok');
