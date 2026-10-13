// Raises (js/core/raises.js, docs/NOW.md): a card on Now is a record.
// R1 one thing one raise · R2 settled by the record or the person · R3 a
// settlement holds on the same rev and reopens with a reason on a new one.
const assert = require('assert');
const R = require('../js/core/raises.js');

const t0 = Date.parse('2026-10-06T09:00:00Z');
const at = (h) => t0 + h * 3600000;
const bill = (rev = 'a', extra = {}) => ({ thing: 'matter:m1', rev, producer: 'matters',
    content: { kind: 'decide', title: 'Water bill', body: 'Due Oct 14 · $82', primary: 'Open the link', dismiss: 'Already done' }, ...extra });
const task = (rev = 't') => ({ thing: 'task:t1', rev, producer: 'commitments', content: { kind: 'decide', title: 'Pay the water bill', primary: 'Mark done' } });

// ── R1: one thing, one raise ─────────────────────────────────────────
{
    const out = R.reconcile(R.blank(), [bill(), bill('b')], t0);
    assert.strictEqual(out.state.raises.length, 1, 'two producers naming one thing: the first wins');
    assert.strictEqual(out.state.raises[0].rev, 'a');
    // A commitment made from a folder's step speaks for the folder.
    const both = R.reconcile(R.blank(), [bill(), { ...task(), also: ['matter:m1'] }], t0).state;
    assert.deepStrictEqual(both.raises.map(r => r.thing), ['task:t1'], 'the folder gets no raise of its own');
    assert.strictEqual(both.raises[0].id, 'r:task:t1');
}

// ── A raise is created open, updates on a new rev, and settles when gone ──
{
    let s = R.reconcile(R.blank(), [bill()], t0).state;
    const r = s.raises[0];
    assert.strictEqual(r.state, 'open');
    assert.strictEqual(r.title, 'Water bill');
    assert.strictEqual(r.history[0].how, 'raised');
    // Same rev, fresher words: the words change, nothing else.
    s = R.reconcile(s, [bill('a', { content: { ...bill().content, body: 'Due in 8 days · $82' } })], at(1)).state;
    assert.strictEqual(s.raises[0].body, 'Due in 8 days · $82');
    assert.strictEqual(s.raises[0].history.length, 1, 'no history line for the same facts');
    // A new rev on an open raise just updates.
    s = R.reconcile(s, [bill('b')], at(2)).state;
    assert.strictEqual(s.raises[0].rev, 'b');
    assert.strictEqual(s.raises[0].history.at(-1).how, 'changed');
    // The producer stops raising it: settled by the record, kept as history.
    const gone = R.reconcile(s, [], at(3));
    assert.strictEqual(gone.changed, true);
    assert.deepStrictEqual(gone.state.raises[0].settled, { how: 'gone', by: 'record', at: new Date(at(3)).toISOString() });
    // And forgotten after a month, through a tombstone.
    const old = R.reconcile(gone.state, [], at(24 * 40));
    assert.strictEqual(old.state.raises.length, 0);
    assert.ok(old.state.tombstones['r:matter:m1'], 'tombstoned, so the other side forgets it too');
}

// ── R2 + R3: set aside by the person; holds on the rev, reopens with a reason ──
{
    let s = R.reconcile(R.blank(), [bill()], t0).state;
    assert.strictEqual(R.settle(s, 'nope', 'ignore'), null, 'no such raise');
    assert.strictEqual(R.settle(s, 'matter:m1', 'whatever'), null, 'not a way to settle');
    s = R.settle(s, 'matter:m1', 'ignore', { by: 'chat', quote: 'just ignore it', now: at(1) });
    assert.strictEqual(s.raises[0].state, 'settled');
    assert.strictEqual(s.raises[0].settled.by, 'chat');
    assert.strictEqual(s.raises[0].settled.quote, 'just ignore it');
    assert.deepStrictEqual(R.openOf(s, at(1)), [], 'off Now');
    // The producer still raises it with the SAME facts: it stays settled.
    s = R.reconcile(s, [bill()], at(2)).state;
    assert.strictEqual(s.raises[0].state, 'settled', 'a settlement holds while the facts hold');
    assert.strictEqual(R.openOf(s, at(2)).length, 0);
    // The facts change (a new email on the bill): it reopens, saying so.
    const back = R.reconcile(s, [bill('b', { whatsNew: 'An email from the water company on Oct 9.' })], at(3));
    assert.deepStrictEqual(back.reopened, ['matter:m1']);
    const r = back.state.raises[0];
    assert.strictEqual(r.state, 'open');
    assert.strictEqual(r.reopened.why, 'New since you set this aside. An email from the water company on Oct 9.');
    assert.strictEqual(r.history.at(-1).how, 'reopened');
    assert.strictEqual(r.history.find(h => h.how === 'ignore').quote, 'just ignore it', 'the settlement stays in its history');
    // Settled twice is not a thing.
    assert.strictEqual(R.settle(R.settle(back.state, 'matter:m1', 'done', { now: at(4) }), 'matter:m1', 'done', { now: at(5) }), null);
}

// ── A raise settled by the RECORD comes back quietly when the record does ──
{
    let s = R.reconcile(R.blank(), [bill()], t0).state;
    s = R.reconcile(s, [], at(1)).state;                       // gone
    const back = R.reconcile(s, [bill('b')], at(2));
    assert.strictEqual(back.state.raises[0].state, 'open');
    assert.strictEqual(back.state.raises[0].reopened, undefined, 'no "new since you set this aside": the person never did');
    assert.deepStrictEqual(back.reopened, []);
    // Same facts: a pass that produced nothing (a reload before the stores
    // loaded) must not hide the card for good (2026-10-08).
    const same = R.reconcile(s, [bill()], at(2));
    assert.strictEqual(same.state.raises[0].state, 'open', 'raised again with the same rev: open');
    assert.strictEqual(same.state.raises[0].settled, undefined);
    assert.deepStrictEqual(same.reopened, []);
    // The person's settlement still holds on the same rev.
    const mine = R.settle(R.reconcile(R.blank(), [bill()], t0).state, 'matter:m1', 'done', { now: at(1) });
    assert.strictEqual(R.reconcile(mine, [bill()], at(2)).state.raises[0].state, 'settled');
}

// ── Later: a state with an until, back when it passes or when the facts move ──
{
    let s = R.reconcile(R.blank(), [bill()], t0).state;
    s = R.settle(s, 'matter:m1', 'later', { until: 2 * 3600000, now: t0 });
    assert.strictEqual(s.raises[0].state, 'later');
    assert.strictEqual(s.raises[0].until, new Date(at(2)).toISOString());
    assert.deepStrictEqual(R.openOf(s, at(1)), []);
    assert.strictEqual(R.openOf(s, at(2)).length, 1, 'due back');
    s = R.reconcile(s, [bill()], at(2)).state;
    assert.strictEqual(s.raises[0].state, 'open');
    assert.strictEqual(s.raises[0].until, undefined);
    // Later, then the facts move before the time: back now, with the reason.
    let l = R.settle(R.reconcile(R.blank(), [bill()], t0).state, 'matter:m1', 'later', { until: 4 * 3600000, now: t0 });
    l = R.reconcile(l, [bill('b')], at(1)).state;
    assert.strictEqual(l.raises[0].state, 'open');
    assert.strictEqual(l.raises[0].reopened.why, R.REOPEN_LINE);
    // A settled raise may still be put off (a tap on Show later after Ignore is not a thing, but later after later is).
    assert.ok(R.settle(l, 'matter:m1', 'later', { now: at(2) }));
}

// ── Held while the mailbox is read; opens when the hold lifts ───────────
{
    let s = R.reconcile(R.blank(), [bill('a', { held: true })], t0).state;
    assert.strictEqual(s.raises[0].state, 'held');
    assert.deepStrictEqual(R.openOf(s, t0), []);
    s = R.reconcile(s, [bill()], at(1)).state;
    assert.strictEqual(s.raises[0].state, 'open');
}

// ── Content is clamped to what a card shows; rev defaults to the content ──
{
    const s = R.reconcile(R.blank(), [{ thing: 'job:j1', producer: 'jobs', content: { kind: 'bogus', title: 'x'.repeat(300), secret: 'never', choices: ['a', 'b', 'c', 'd', 'e'] } }], t0).state;
    const r = s.raises[0];
    assert.strictEqual(r.kind, 'headsup');
    assert.strictEqual(r.title.length, 200);
    assert.strictEqual(r.secret, undefined);
    assert.strictEqual(r.choices.length, 4);
    assert.strictEqual(r.rev, R.rev({ kind: 'headsup', title: r.title, body: '', choices: r.choices }));
}

// ── R7: what the person did lately, as facts for a raiser's judge ──────
{
    let s = R.reconcile(R.blank(), [bill(), { thing: 'matter:m2', rev: 'x', producer: 'matters', content: { kind: 'decide', title: 'Fidelity statement' } }], t0).state;
    s = R.settle(s, 'matter:m2', 'ignore', { now: at(1) });
    s = R.reconcile(s, [bill()], at(2)).state;   // m2's producer stopped too; the person's settlement is what counts
    const recent = R.recentSettlements(s, { producer: 'matters', now: at(3) });
    assert.deepStrictEqual(recent.map(r => [r.title, r.how, r.by]), [['Fidelity statement', 'ignore', 'you']]);
    assert.deepStrictEqual(R.recentSettlements(s, { producer: 'jobs', now: at(3) }), []);
}

console.log('raises: R1 one thing one raise, R2 settled by the record or the person, R3 holds on the rev and reopens with a reason, later, held, clamp, history passed');
