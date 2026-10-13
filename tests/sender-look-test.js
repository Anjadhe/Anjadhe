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

// Code's arithmetic on the sheet (docs/THREADS_DEMO.md G9): the change against
// the last amount from the same sender, the usual amount, the subscriptions' sum.
{
    const bill = (key, day, amount, open = false, title = 'Austin Water bill') => ({ key, title, what: 'bill from their mail or texts', open, status: '', next: '', when: '', amount, from: 'billing@austinwater.example', day, updatedAt: '' });
    const items = [bill('m7', '2026-10-21', '$142.80', true), bill('m1', '2026-04-22', '$61.40'), bill('m2', '2026-05-22', '$72.10'), bill('m3', '2026-06-21', '$74.80'),
        bill('m4', '2026-07-21', '$66.90'), bill('m5', '2026-08-20', '$68.50'), bill('m6', '2026-09-19', '$64.20')];
    const figs = L.arithmetic(items);
    assert.strictEqual(figs.length, 1);
    assert.strictEqual(figs[0], '"Austin Water bill" is $142.80; the one before it was $64.20 on 2026-09-19: up $78.60 (122%); the usual amount from this sender is $67.70 (the middle of the last 6).');
    const sheet2 = L.sheetLines({ name: 'Home utilities', allGood: 'Paid.' }, items).join('\n');
    assert.ok(sheet2.includes('FIGURES (worked out by the app') && sheet2.includes('$67.70'), 'the figures ride the sheet, so the look may quote them');
    assert.ok(sheet2.includes('$64.20, 2026-09-19') || sheet2.includes('$64.20 on 2026-09-19'), 'a settled item shows its amount and day');
    const renewal = [bill('o', '2026-11-02', '$724.00', true, 'Policy renewal'), bill('r3', '2026-04-13', '$612.00', false, 'Renewed'), bill('r2', '2025-10-12', '$566.00', false, 'Renewed')];
    assert.strictEqual(L.arithmetic(renewal)[0], '"Policy renewal" is $724; the one before it was $612 on 2026-04-13: up $112 (18%); the usual amount from this sender is $589 (the middle of the last 2).');
    assert.deepStrictEqual(L.arithmetic([bill('x', '2026-10-21', '$10', true)]), [], 'nothing to compare with: no figure');
    assert.deepStrictEqual(L.arithmetic([bill('x', '2026-10-21', '$10', true), bill('y', '2026-10-22', '$12')]), [], 'only earlier amounts count');
    const subs = [{ key: 's1', title: 'Netflix', what: 'subscription from their mail or texts', open: true, amount: '$15.49', from: 'a', day: '2026-10-01' },
        { key: 's2', title: 'Spotify Family', what: 'subscription from their mail or texts', open: true, amount: '$16.99', from: 'b', day: '2026-10-02' },
        { key: 's3', title: 'iCloud+', what: 'subscription from their mail or texts', open: true, amount: '$2.99', from: 'c', day: '2026-10-03' }];
    assert.strictEqual(L.arithmetic(subs)[0], 'The open subscriptions add up to $35.47 (Netflix $15.49, Spotify Family $16.99, iCloud+ $2.99).');
    console.log('sender-look-test: arithmetic ok');
}

// A raise's other one-tap answers (docs/THREADS_DEMO.md G1): checked like the offer, taken by number.
{
    const s = { id: 'sender:a', name: 'Auto insurance' };
    const items = [{ key: 'matter:o', title: 'Renewal offer', what: 'bill', open: true, amount: '$724', onNow: '' }];
    const base = { title: 'Renewal up to $724', body: 'It renews Nov 2 at $724, up from $612.', offer: 'Compare quotes', ask: 'Can you compare quotes?' };
    const o = { s, items, known: new Set(['724', '612', '2']), nb: { subjects: {} }, nowMs: Date.now() };
    const ok = L.vetRaise({ ...base, answers: [{ label: 'Keep Harbor', ask: "I'll keep Harbor, note that it renews at $724." }, { label: 'Remind me next week', later_days: 7 }] }, o);
    assert.deepStrictEqual(ok.card.answers, [{ label: 'Keep Harbor', ask: "I'll keep Harbor, note that it renews at $724." }, { label: 'Remind me next week', laterDays: 7 }]);
    assert.match(L.vetRaise({ ...base, answers: [{ label: 'Keep Harbor and do not look for quotes anywhere', ask: 'x' }] }, o).error, /1 to 4 words/);
    assert.match(L.vetRaise({ ...base, answers: [{ label: 'Keep Harbor' }] }, o).error, /needs an "ask"/);
    assert.strictEqual(L.vetRaise({ ...base, answers: [{ label: 'A', ask: 'a' }, { label: 'B', ask: 'b' }, { label: 'C', ask: 'c' }] }, o).card.answers.length, 2, 'two at most');
    assert.strictEqual(L.vetRaise({ ...base, answers: [{ label: 'Later', later_days: 90 }] }, o).card.answers[0].laterDays, 30, 'a put-off is capped at a month');
    assert.ok(!('answers' in L.vetRaise(base, o).card), 'none given, none kept');
    // Taking an answer: its words are sent; a put-off is a Not now for its days, nothing sent.
    const sent = [];
    global.ThreadsPage = { open() {}, send(id, text) { sent.push([id, text]); } }; global.AppManager = {};
    global.Senders = { get: id => (id === 'sender:a' ? { id, name: 'Auto insurance', state: 'open' } : null) };
    const st = { senders: { 'sender:a': { cards: [ok.card], subjects: {}, journal: [{ subject: ok.card.subject, title: ok.card.title, at: Date.now() }], notes: [] } } };
    L.state = () => st; L.save = () => {};
    assert.deepStrictEqual(L.accept('sender:a', 1), { sent: "I'll keep Harbor, note that it renews at $724." });
    assert.strictEqual(st.senders['sender:a'].journal[0].chosen, 'Keep Harbor');
    assert.ok(L.journalLines(st.senders['sender:a'])[0].includes('answered "Keep Harbor"'));
    st.senders['sender:a'].subjects = {}; st.senders['sender:a'].journal[0].answer = null;
    assert.deepStrictEqual(L.accept('sender:a', 2), { later: 7 });
    assert.strictEqual(sent.length, 1, 'a put-off sends nothing');
    assert.ok(st.senders['sender:a'].subjects[ok.card.subject].until > Date.now() + 6 * 86400000, 'not now for seven days');
    assert.deepStrictEqual(L.accept('sender:a', 3), { error: 'no such answer' });
    console.log('sender-look-test: answers ok');
}
// The sheet says who each item is from (a look-alike address is a fact the look must see).
{
    const items = [{ key: 'matter:x', title: 'Action required on your policy', what: 'other from their mail or texts', open: true, status: '', next: 'Forward ID cards', when: '', amount: '', from: 'service@harbormutual-notice.example', day: '2026-10-11', updatedAt: '' }];
    assert.ok(L.sheetLines({ name: 'Auto insurance' }, items).join('\n').includes('from service@harbormutual-notice.example'));
    console.log('sender-look-test: addresses ok');
}
