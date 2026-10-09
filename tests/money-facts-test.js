#!/usr/bin/env node
/**
 * MoneyFacts' pure core — the one sheet the money coach reads
 * (js/core/money-facts.js). Plain data in, plain data out:
 *
 *   node tests/money-facts-test.js
 */
const assert = require('assert');
const M = require('../js/core/money-facts.js');

const now = new Date('2026-10-03T10:00:00');

// ── amounts as mail states them ──
assert.equal(M.amount('$1,284.20'), 1284.2);
assert.equal(M.amount('USD 84'), 84);
assert.equal(M.amount(12.5), 12.5);
assert.equal(M.amount('due soon'), null);
assert.equal(M.amount(null), null);

// ── nothing at all: the sheet says what it cannot see ──
{
    const s = M.sheet({ portfolio: null, spending: null, matters: null, withheld: [] }, now);
    assert.deepEqual(s.has, { investments: false, bank: false, mail: false });
    assert.equal(s.notKnown.length, 3);
    assert.ok(!s.netWorth && !s.spending && !s.bills && !s.debts);
}

// ── email only: bills are the whole sheet ──
{
    const s = M.sheet({ portfolio: null, spending: null, withheld: [], matters: [
        { id: 'm1', kind: 'bill', state: 'open', title: 'City Water bill', amount: '$84.20', due: '2026-10-10', step: 'Pay it' },
        { id: 'm2', kind: 'subscription', state: 'open', title: 'Streaming renewal', amount: '$19.99', due: '2026-11-20' },
        { id: 'm3', kind: 'bill', state: 'done', title: 'Paid already', amount: '$50', due: '2026-10-05' },
        { id: 'm4', kind: 'appointment', state: 'open', title: 'Dentist', due: '2026-10-06' },
        { id: 'm5', kind: 'bill', state: 'open', title: 'Late fee', amount: '$15', due: '2026-10-01' }
    ] }, now);
    assert.equal(s.has.mail, true);
    assert.equal(s.bills.map(b => b.id).join(), 'm5,m1,m2', 'open bills and subscriptions only, soonest first');
    assert.equal(s.bills[1].inDays, 7);
    assert.equal(s.bills[0].inDays, -2, 'an overdue bill counts backwards');
    assert.equal(s.billsDueIn14Days, 99, '84.20 + 15, the November renewal is outside the window');
    assert.equal(s.notKnown.length, 2);
}

// ── the full picture ──
const data = {
    withheld: [],
    portfolio: {
        summary: { totalValue: 500000, invested: 180000, cash: 20000, realEstateValue: 300000, liabilitiesTotal: 210000, netWorth: 290000 },
        accounts: [{ name: 'Roth', type: 'roth-ira', value: 120000, cash: 5000 }],
        liabilities: [{ name: 'Mortgage', type: 'mortgage', balance: 200000, interestRate: 3.1, monthlyPayment: 1400 },
            { name: 'Car', type: 'loan', balance: 10000, interestRate: 7.4 }],
        history: [{ date: '2026-01-02', totalValue: 470000, liabilities: 215000 }, { date: '2026-08-30', netWorth: 280000 },
            { date: '2026-09-02', netWorth: 284000 }, { date: '2026-09-20', netWorth: 288000 }],
        top: [{ ticker: 'VTI', pct: 21.04 }],
        plan: { name: 'Core', status: 'drift', headline: 'Cash is 10% against a 5% target.', offTarget: [{ sleeve: 'Cash', actualPct: 10, targetPct: 5, band: '0-8' }], brokenRules: [] }
    },
    spending: {
        accounts: [{ name: 'Checking', type: 'checking', balance: 9000 }, { name: 'Savings', type: 'savings', balance: 15000 },
            { name: 'Card', type: 'credit', balance: 2400, limit: 10000 }, { name: 'Paid card', type: 'credit', balance: 0 }],
        months: [
            { month: '2026-10', spend: 400, refunds: 0, income: 0, byCategory: [{ label: 'Groceries', total: 250 }] },
            { month: '2026-09', spend: 6000, refunds: 200, income: 8000, byCategory: [] },
            { month: '2026-08', spend: 5000, refunds: 0, income: 8000, byCategory: [] },
            { month: '2026-07', spend: 7000, refunds: 0, income: 0, byCategory: [] }
        ],
        samePointLastMonth: 650,
        recurring: [{ name: 'Gym', amount: 60, cadence: 'monthly', count: 5, last: '2026-09-15', next: '2026-10-15' },
            { name: 'Coffee box', amount: 12, cadence: 'weekly', count: 9, last: '2026-09-29', next: '2026-10-06' },
            { name: 'Domain', amount: 120, cadence: 'yearly', count: 3, last: '2026-03-01', next: '2027-03-01' }]
    },
    matters: []
};
const s = M.sheet(data, now);
assert.deepEqual(s.has, { investments: true, bank: true, mail: true });
assert.ok(!s.notKnown, 'everything is known');
assert.equal(s.netWorth.netWorth, 290000);
assert.equal(s.netWorth.change.days30.from, '2026-09-02', 'the latest snapshot on or before 30 days back');
assert.equal(s.netWorth.change.days30.change, 6000);
assert.equal(s.netWorth.change.thisYear, undefined, 'no snapshot on or before Jan 1 means no claim');
assert.equal(M.sheet({ ...data, portfolio: { ...data.portfolio, history: [{ date: '2025-12-30', totalValue: 470000, liabilities: 215000 }] } }, now)
    .netWorth.change.thisYear.change, 35000, 'an old snapshot without netWorth is assets minus debts');
assert.equal(s.largestHoldings[0].pctOfAssets, 21);
assert.equal(s.plan.status, 'drift');

assert.equal(s.cash.inBank, 24000, 'cards are not cash');
assert.equal(s.spending.thisMonth.spentSoFar, 400);
assert.equal(s.spending.thisMonth.samePointLastMonth, 650);
assert.equal(s.spending.months.length, 3, 'complete months only');
assert.equal(s.spending.months[0].kept, 2200, 'income less spending net of refunds');
assert.equal(s.spending.months[0].savingsRatePct, 27.5);
assert.equal(s.spending.months[2].savingsRatePct, undefined, 'no income known means no rate');
assert.equal(s.spending.averageMonth, 6000);
assert.equal(s.cash.monthsOfSpending, 4);
assert.equal(s.recurring.perMonth, 122, '60 + 12×52/12 + 120/12');

assert.equal(s.debts.map(d => d.name).join(), 'Car,Mortgage,Card', 'highest rate first, then unrated by balance');
assert.equal(s.debts[2].type, 'credit card');
assert.equal(s.debts.length, 3, 'a card with nothing owed is not a debt');

// A bank linked mid-month: the month its history starts in is not a whole month.
{
    const young = M.sheet({ ...data, spending: { ...data.spending, since: '2026-09-27' } }, now);
    assert.equal(young.spending.months.length, 0);
    assert.equal(young.cash.monthsOfSpending, undefined, 'no average, so no claim about how long the cash lasts');
    assert.equal(M.sheet({ ...data, spending: { ...data.spending, since: '2026-08-15' } }, now).spending.months.length, 1);
}

// ── a part withheld from a cloud run is named, not called missing ──
{
    const w = M.sheet({ ...data, spending: null, withheld: ['spending'] }, now);
    assert.ok(!w.spending && !w.notKnown);
    assert.equal(w.leftOut.length, 1);
    assert.ok(/spending/.test(w.leftOut[0]));
}

// ── lines carry only numbers the sheet holds ──
{
    const text = M.lines(s).join('\n');
    assert.ok(/Net worth \$290,000/.test(text));
    assert.ok(/2026-09: \$6,000 spent, \$8,000 in, kept \$2,200 \(27\.5%\)/.test(text));
    assert.ok(/Car \(loan\) \$10,000 at 7\.4%/.test(text));
    assert.ok(/Cash 10% against 5%/.test(text));
    assert.ok(M.lines(M.sheet({}, now)).every(l => l.startsWith('Not known')));
}

// ── money goals: a commitment's amount, counted from the accounts that hold it ──
{
    const P = require('../js/core/money-plan.js');
    const accounts = [{ name: 'Ally Savings', value: 12500 }, { name: 'Checking', value: 3000 }];
    const g = P.progress({ id: 'c1', title: 'Emergency fund', amount: 30000, by: '2027-10-03', accounts: ['ally savings'] }, accounts, '2026-10-03');
    assert.equal(g.saved, 12500);
    assert.equal(g.pct, 41.7);
    assert.equal(g.left, 17500);
    assert.equal(g.monthsLeft, 12);
    assert.equal(g.perMonthNeeded, 1458);
    assert.equal(P.progress({ id: 'c2', amount: 5000, by: '2026-12-01' }, accounts, '2026-10-03').saved, undefined, 'nothing recorded toward it is not zero');
    assert.equal(P.progress({ id: 'c3', amount: 5000, saved: 1000 }, accounts, '2026-10-03').left, 4000, 'a figure they told us counts when no account does');
    assert.deepEqual(P.progress({ id: 'c4', amount: 5000, accounts: ['Vault'] }, accounts, '2026-10-03').accountsNotFound, ['Vault']);
    assert.equal(P.progress({ id: 'c5', amount: 5000, by: '2026-10-20', accounts: ['Checking'] }, accounts, '2026-10-03').perMonthNeeded, undefined, 'under a month away: no monthly figure');

    const withGoals = M.sheet({ ...data, goals: [{ id: 'c1', title: 'Emergency fund', amount: 30000, by: '2027-10-03', accounts: ['Savings'] }], progress: (x, a, t) => P.progress(x, a, t) }, now);
    assert.equal(withGoals.goals[0].saved, 15000, 'a bank account by name counts toward the goal');
    assert.ok(/Goal "Emergency fund": \$15,000 of \$30,000 \(50%\), by 2027-10-03, needs \$1,250 a month/.test(M.lines(withGoals).join('\n')));
}

// ── receipts and renewals seen in mail (email first) ──
{
    const mail = [
        { id: 'e1', kind: 'receipt', amount: '$42.10', date: '2026-10-01', from: 'Trader Joe\'s' },
        { id: 'e2', kind: 'receipt', amount: '$18.00', date: '2026-10-02', from: 'Trader Joe\'s' },
        { id: 'e3', kind: 'receipt', amount: '$240', date: '2026-09-12', from: 'Delta' },
        { id: 'e4', kind: 'renewal', amount: '$119/year', date: '2026-09-28', from: 'Prime', due: '2026-10-15' },
        { id: 'e5', kind: 'receipt', amount: 'see attached', date: '2026-10-02', from: 'Nobody' }
    ];
    const m = M.sheet({ portfolio: null, spending: null, matters: [], mail, withheld: [] }, now).fromMail;
    assert.equal(m.receiptsByMonth[0].month, '2026-10');
    assert.equal(m.receiptsByMonth[0].total, 60);
    assert.equal(m.receiptsByMonth[0].receipts, 2, 'a receipt with no amount is not counted');
    assert.equal(m.receiptsByMonth[0].top[0].from, "Trader Joe's");
    assert.equal(m.receiptsByMonth[1].total, 240);
    assert.equal(m.renewals[0].amount, 119);
    assert.equal(m.renewals[0].inDays, 12);
    assert.ok(/Only what their mail shows/.test(m.note), 'the sheet says it is partial');
}

console.log('money-facts: ok');
