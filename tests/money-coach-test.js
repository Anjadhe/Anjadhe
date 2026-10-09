#!/usr/bin/env node
/**
 * MoneyCoach (js/core/money-coach.js): the pure core of the agent's look
 * (what changed, when a look is due, the notebook, the check on a raise),
 * and one whole look driven by a scripted model.
 *
 *   node tests/money-coach-test.js
 */
const assert = require('assert');
const C = require('../js/core/money-coach.js');

const sheet = {
    has: { investments: true, bank: true, mail: true },
    netWorth: { assets: 500000, invested: 180000, cash: 20000, realEstate: 300000, debts: 12400, netWorth: 487600 },
    plan: { name: 'Core', status: 'drift', headline: 'Cash is 10% against a 5% target.', offTarget: [{ sleeve: 'Cash', actualPct: 10, targetPct: 5, band: '0-8' }], brokenRules: [] },
    cash: { inBank: 24000, monthsOfSpending: 4, accounts: [{ name: 'Checking', balance: 9000 }, { name: 'Savings', balance: 15000 }] },
    spending: { thisMonth: { month: '2026-10', spentSoFar: 400, incomeSoFar: 0, samePointLastMonth: 650, topCategories: [] }, months: [] },
    recurring: { perMonth: 122, charges: [{ merchant: 'Gym', amount: 60, cadence: 'monthly', times: 5 }] },
    debts: [{ name: 'Card', type: 'credit card', balance: 2400 }, { name: 'Car', type: 'loan', balance: 10000, ratePct: 7.4 }],
    bills: [{ id: 'm1', kind: 'bill', title: 'City Water bill', amount: 84.2, due: '2026-10-10', inDays: 7 }]
};

// ── figures, changes, fingerprint ──
const f1 = C.figures(sheet);
assert.equal(f1.netWorth, 487600);
assert.equal(f1.debts, 12400);
assert.equal(f1.bills, 'm1:2026-10-10');
assert.deepEqual(C.changes(null, f1), [], 'a first look has nothing to compare');
const f2 = { ...f1, netWorth: 480000, inBank: 26500, debts: 10000, plan: 'on-track', spent: 900, bills: '' };
const ch = C.changes(f1, f2);
assert.ok(ch.includes('Net worth went down $7,600, from $487,600 to $480,000.'));
assert.ok(ch.includes('Cash in the bank went up $2,500, from $24,000 to $26,500.'));
assert.ok(ch.includes('Total owed went down $2,400, from $12,400 to $10,000.'));
assert.ok(ch.some(l => /status went from drift to on-track/.test(l)));
assert.ok(ch.some(l => /Spending in 2026-10 went up \$500/.test(l)));
assert.ok(ch.some(l => /open bills/.test(l)));
assert.ok(!C.changes({ ...f1, month: '2026-09' }, f2).some(l => /^Spending in/.test(l)), 'a new month is not compared with the old one');
assert.equal(C.fingerprint(f1), C.fingerprint({ ...f1, netWorth: 488900 }), 'market noise is not a change');
assert.notEqual(C.fingerprint(f1), C.fingerprint({ ...f1, netWorth: 440000 }));
assert.notEqual(C.fingerprint(f1), C.fingerprint({ ...f1, inBank: 23990 }), 'bank cash is exact');

// ── when a look is due (MC8) ──
{
    const now = new Date('2026-10-05T10:00:00');
    const fp = C.fingerprint(f1);
    assert.equal(C.due({}, fp, now), true, 'never looked');
    const looked = { lookedAt: now.getTime() - 86400000, lookedDay: '2026-10-04', fp };
    assert.equal(C.due(looked, fp, now), false, 'nothing changed, nothing asked for');
    assert.equal(C.due(looked, 'other', now), true, 'the figures changed');
    assert.equal(C.due({ ...looked, lookAgain: '2026-10-05' }, fp, now), true, 'its own look-again day');
    assert.equal(C.due({ ...looked, lookAgain: '2026-10-09' }, fp, now), false);
    assert.equal(C.due({ ...looked, lookedAt: now.getTime() - 8 * 86400000 }, fp, now), true, 'a week at most');
    assert.equal(C.due({ ...looked, lookedDay: '2026-10-05' }, 'other', now), false, 'never twice a day');
    assert.equal(C.due({ triedAt: now.getTime() - 60000 }, fp, now), false, 'a failed try waits an hour');
}

// ── subjects and the notebook ──
assert.equal(C.subjectOf('debt', 'Chase Sapphire ····3333'), 'debt:chase-sapphire-3333');
assert.equal(C.subjectOf('cash'), 'cash');
assert.equal(C.subjectOf('nonsense', 'x'), 'other:x');
{
    const t = Date.parse('2026-10-01T10:00:00');
    const st = { journal: [
        { subject: 'debt:card', title: 'Card beside idle cash', at: t, answer: 'accept', answeredAt: t + 3600000 },
        { subject: 'cash', title: 'Cash doing nothing', at: t, answer: 'notnow', answeredAt: t },
        { subject: 'recurring', title: 'Gym went up', at: t },
        { subject: 'plan', title: 'Off plan', at: t, settled: 'rebalanced', settledAt: t + 86400000 },
        { subject: 'saving', title: 'Saving', at: t } ],
        subjects: { cash: { until: t + 7 * 86400000 }, saving: { stop: true } },
        notes: [{ at: t, text: 'Watching the card balance.' }] };
    const lines = C.journalLines(st, new Date(t + 2 * 86400000)).join('\n');
    assert.ok(/\[debt:card\] "Card beside idle cash": they took the offer on 2026-10-01/.test(lines));
    assert.ok(/\[cash\].*not now/.test(lines) && /\[recurring\].*no answer yet/.test(lines) && /settled 2026-10-02: rebalanced/.test(lines));
    assert.ok(/\[saving\].*don't ask/.test(lines));
    assert.ok(/your note: Watching the card balance\./.test(lines));
    assert.ok(/Do not raise: cash \(until 2026-10-08\), saving \(never\)\./.test(lines));
}

// ── the check on a raise (MC1) ──
{
    const known = new Set(C.nums('$2,400 on Card; $24,000 in the bank; 7.4%'));
    const st = { subjects: { cash: { until: 9e15 }, saving: { stop: true } } };
    const ok = C.vetRaise({ about: 'debt', ref: 'Card', title: 'Your card holds $2,400 beside $24,000 in the bank', body: 'Paying it from Savings stops the interest.', offer: 'Plan the payoff', ask: 'Help me pay off my card.' }, known, st, 1000);
    assert.equal(ok.card.subject, 'debt:card');
    assert.equal(ok.card.name, 'Card');
    assert.equal(ok.card.prompt, 'Help me pay off my card.');
    assert.ok(/600000/.test(C.vetRaise({ about: 'net-worth', title: 'It will be $600,000 next year', body: 'x' }, known, st, 1000).error), 'an unread number is named back to the agent');
    assert.ok(/not now/.test(C.vetRaise({ about: 'cash', title: 'a', body: 'b' }, known, st, 1000).error));
    assert.ok(/asked not to/.test(C.vetRaise({ about: 'saving', title: 'a', body: 'b' }, known, st, 1000).error));
    assert.ok(/must be one of/.test(C.vetRaise({ about: 'stocks', title: 'a', body: 'b' }, known, st, 1000).error));
    assert.ok(/already raised debt:card/.test(C.vetRaise({ about: 'debt', ref: 'card', title: 'a', body: 'b' }, known, st, 1000, [ok.card]).error));
    assert.ok(/limit/.test(C.vetRaise({ about: 'plan', title: 'a', body: 'b' }, known, st, 1000, [ok.card, ok.card]).error));
    const named = C.vetRaise({ about: 'plan', title: 'Cash is over target', body: 'Putting the extra into VTI would bring it back.' }, known, st, 1000);
    assert.ok(named.card && /VTI/.test(named.card.body), 'naming a fund is allowed (MC3)');
    assert.ok(named.card.prompt.includes('plan'), 'a missing ask falls back to a plain one');
}

// ── the nudge ──
{
    const st = { subjects: {}, nudged: '' };
    const cards = [{ subject: 'cash', title: 'T', body: 'B' }];
    assert.equal(C.nudgeChoice(cards, st, new Date('2026-10-01T08:00:00')), null);
    assert.equal(C.nudgeChoice(cards, st, new Date('2026-10-01T11:00:00')).subject, 'cash');
    assert.equal(C.nudgeChoice(cards, st, new Date('2026-10-01T11:00:00'), { looking: true }), null);
    assert.equal(C.nudgeChoice(cards, { ...st, nudged: '2026-10-01' }, new Date('2026-10-01T11:00:00')), null);
}

// ── one whole look, with a scripted model ──
(async () => {
    const store = {};
    global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
    global.MoneyFacts = Object.assign(require('../js/core/money-facts.js'), { current: () => sheet });
    global.AgentLoop = require('../js/agent/agent-loop.js');
    const executed = [];
    global.AgentTools = {
        definitions: ['list_spending', 'add_commitment', 'money_overview'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } })),
        execute: async (name, args, ctx) => { executed.push({ name, ctx }); return { transactions: [{ merchant: 'Gym', amount: 75, date: '2026-09-15' }] }; }
    };
    const call = (name, args) => ({ message: { content: '', tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } });
    const script = [
        call('list_spending', { search: 'Gym' }),
        call('raise', { about: 'recurring', ref: 'Gym', title: 'The gym went from $60 to $80', body: 'x', offer: 'Look at it', ask: 'Check my gym charge.' }),
        call('raise', { about: 'recurring', ref: 'Gym', title: 'The gym charged $75, it was $60', body: 'Worth a look before the next one.', offer: 'Look at it', ask: 'Check my gym charge.' }),
        call('add_commitment', { title: 'sneaky write' }),
        call('note', { text: 'Watching the gym charge.', look_again_days: 12 }),
        { message: { content: 'Raised the gym charge.' } }
    ];
    const seen = [];
    global.LLMLogger = { call: async (source, params) => { seen.push({ source, tools: (params.tools || []).map(t => t.function.name), last: params.messages[params.messages.length - 1] }); return script.shift(); } };
    const now = new Date('2026-10-05T10:00:00');
    const r = await C.look(now);
    assert.equal(r.stop, 'done');
    assert.equal(seen[0].source, 'money-coach');
    assert.deepEqual(seen[0].tools, ['list_spending', 'raise', 'note', 'settle'], 'only reads and its own three tools: a write tool is never offered');
    assert.deepEqual(executed.map(e => e.name), ['list_spending'], 'a tool it was not given is not run');
    assert.ok(executed[0].ctx.ambient && executed[0].ctx.source === 'money-coach', 'reads are gated as background work');
    assert.ok(/80/.test(seen[2].last.content) && /not in anything you read/.test(seen[2].last.content), 'the invented $80 was refused with the reason');
    assert.equal(r.raised.length, 1);
    assert.equal(r.raised[0].title, 'The gym charged $75, it was $60', 'the $75 it read in list_spending may be said');
    const st = C.state();
    assert.equal(st.cards[0].subject, 'recurring:gym');
    assert.equal(st.journal[0].subject, 'recurring:gym');
    assert.equal(st.lookedDay, '2026-10-05');
    assert.equal(st.lookAgain, '2026-10-17');
    assert.equal(st.notes[0].text, 'Watching the gym charge.');
    assert.equal(st.lastSaid, 'Raised the gym charge.');
    assert.equal(C.due(st, st.fp, new Date('2026-10-06T10:00:00')), false, 'quiet until something changes');

    // The person's answer lands in the notebook, and the next look can settle it.
    C.respond('recurring:gym', 'accept');
    assert.ok(/took the offer/.test(C.journalLines(C.state(), now).join('\n')));
    script.push(call('settle', { subject: 'recurring:gym', outcome: 'They cancelled it.' }), { message: { content: 'Settled.' } });
    const r2 = await C.look(new Date('2026-10-17T10:00:00'));
    assert.equal(r2.settled.length, 1);
    assert.equal(C.state().journal[0].settled, 'They cancelled it.');
    assert.equal(C.state().cards.length, 0, 'a look that raises nothing leaves Now quiet');

    // A model error leaves the notebook alone, so the look is tried again.
    script.push({ error: 'boom' });
    const r3 = await C.look(new Date('2026-10-20T10:00:00'));
    assert.equal(r3.stop, 'error');
    assert.equal(C.state().lookedDay, '2026-10-17');

    console.log('money-coach: ok');
})().catch(e => { console.error(e); process.exit(1); });

// ── derived figures and length (found on a live run, 2026-10-04) ──
{
    const known = new Set(C.nums('$6,400 on the card; $12,500 in savings; 24.9%; 5 and 2'));
    const st = { subjects: {} };
    assert.ok(C.vetRaise({ about: 'debt', ref: 'Card', title: 'Paying the $6,400 leaves $6,100', body: 'From $12,500.' }, known, st, 1).card, 'a difference of two read figures is vouched for');
    assert.ok(C.vetRaise({ about: 'debt', ref: 'Card', title: 'Together $18,900', body: 'x' }, known, st, 1).card, 'and a sum');
    assert.ok(C.vetRaise({ about: 'debt', ref: 'Card', title: 'Save $1,594 a year', body: 'x' }, known, st, 1).error, 'a product or estimate is not');
    assert.ok(C.vetRaise({ about: 'debt', ref: 'Card', title: 'In 3 months', body: 'x' }, known, st, 1).error, 'small numbers are never derived');
    assert.ok(/Too long/.test(C.vetRaise({ about: 'cash', title: 'Cash', body: 'x'.repeat(281) }, known, st, 1).error), 'too long is sent back, never cut');
}
