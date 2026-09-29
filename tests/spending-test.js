#!/usr/bin/env node
/**
 * SpendingApp's pure core — what a bank's Plaid rows become on the page
 * (js/apps/spending/spending-app.js). Plain data in, plain data out, so it
 * runs standalone:
 *
 *   node tests/spending-test.js
 */

const S = require('../js/apps/spending/spending-app.js');

let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const cat = (primary, detailed = null) => ({ primary, detailed });

// ── accounts ──
console.log('accounts');
check('checking', S.accountTypeFor({ type: 'depository', subtype: 'checking' }) === 'checking');
check('savings', S.accountTypeFor({ type: 'depository', subtype: 'savings' }) === 'savings');
check('money market reads as savings', S.accountTypeFor({ type: 'depository', subtype: 'money market' }) === 'savings');
check('credit card', S.accountTypeFor({ type: 'credit', subtype: 'credit card' }) === 'credit');
check('investment is not a bank account', S.isBankAccount({ type: 'investment', subtype: 'brokerage' }) === false);
check('depository is', S.isBankAccount({ type: 'depository' }) === true);
check('name carries institution and mask', S.accountNameFor({ name: 'Total Checking', mask: '0000' }, 'Chase') === 'Chase Total Checking ····0000');
check('name does not repeat the institution', S.accountNameFor({ name: 'Chase Sapphire', mask: '3333' }, 'Chase') === 'Chase Sapphire ····3333');

// ── merchant keys ──
console.log('merchant keys');
check('store numbers and punctuation fall away', S.merchantKey('STARBUCKS STORE #12345') === S.merchantKey('Starbucks Store 12345'));
check('same merchant, different suffix', S.merchantKey('AMAZON.COM*2K3JH9') === S.merchantKey('Amazon.com'));
check('pos/debit noise is ignored', S.merchantKey('POS DEBIT TRADER JOES') === 'trader joes');
check('empty in, empty out', S.merchantKey('') === '');

// ── categories ──
console.log('categories');
const rules = [{ id: 'costco', merchant: 'Costco', category: 'GROCERIES' }];
const byKey = S.rulesByKey(rules);
const costco = { id: 't1', name: 'COSTCO WHSE #123', merchant: 'Costco', amount: 180, date: '2026-09-03', plaidCategory: cat('GENERAL_MERCHANDISE') };
check('rule beats Plaid', S.categoryOf(costco, byKey) === 'GROCERIES');
check('row override beats Plaid', S.categoryOf({ ...costco, merchant: 'Target', name: 'Target', category: 'HOME_IMPROVEMENT' }, byKey) === 'HOME_IMPROVEMENT');
check('rule beats row override', S.categoryOf({ ...costco, category: 'ENTERTAINMENT' }, byKey) === 'GROCERIES');
check('Plaid primary when nothing else', S.categoryOf({ ...costco, merchant: 'Shell', name: 'Shell', plaidCategory: cat('TRANSPORTATION') }, byKey) === 'TRANSPORTATION');
check('unknown primary → OTHER', S.categoryOf({ ...costco, merchant: 'X', plaidCategory: cat('SOMETHING_NEW') }, byKey) === 'OTHER');
check('label', S.categoryLabel('FOOD_AND_DRINK') === 'Food & drink');
check('label for an unknown id is humanised', S.categoryLabel('PET_SUPPLIES') === 'Pet supplies');

// ── spend / not spend ──
console.log('what counts as spending');
check('a purchase spends', S.isSpend({ amount: 12 }, 'FOOD_AND_DRINK') === true);
check('income does not', S.isSpend({ amount: -2500 }, 'INCOME') === false);
check('a transfer out does not', S.isSpend({ amount: 500 }, 'TRANSFER_OUT') === false);
check('paying the credit card does not', S.isSpend({ amount: 900, plaidCategory: cat('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') }, 'LOAN_PAYMENTS') === false);
check('a mortgage payment does', S.isSpend({ amount: 2100, plaidCategory: cat('LOAN_PAYMENTS', 'LOAN_PAYMENTS_MORTGAGE_PAYMENT') }, 'LOAN_PAYMENTS') === true);
check('a refund nets against its category', S.isRefund({ amount: -30 }, 'GENERAL_MERCHANDISE') === true);
check('a deposit is not a refund', S.isRefund({ amount: -30 }, 'TRANSFER_IN') === false);

// ── months ──
console.log('months');
check('monthKey', S.monthKey('2026-09-03') === '2026-09');
check('addMonths forward across a year', S.addMonths('2026-12', 1) === '2027-01');
check('addMonths back', S.addMonths('2026-01', -1) === '2025-12');
check('monthLabel', S.monthLabel('2026-09') === 'September 2026');

// ── monthSummary ──
console.log('monthSummary');
const txns = [
    { id: 'a', date: '2026-09-01', name: 'Payroll', amount: -4000, plaidCategory: cat('INCOME', 'INCOME_WAGES') },
    { id: 'b', date: '2026-09-02', merchant: 'Costco', name: 'COSTCO WHSE', amount: 180, plaidCategory: cat('GENERAL_MERCHANDISE') },
    { id: 'c', date: '2026-09-02', merchant: 'Starbucks', name: 'STARBUCKS', amount: 6.5, plaidCategory: cat('FOOD_AND_DRINK') },
    { id: 'd', date: '2026-09-05', merchant: 'Starbucks', name: 'STARBUCKS', amount: 5.5, plaidCategory: cat('FOOD_AND_DRINK'), pending: true },
    { id: 'e', date: '2026-09-06', merchant: 'Amazon', name: 'AMAZON', amount: -20, plaidCategory: cat('GENERAL_MERCHANDISE') },   // refund
    { id: 'f', date: '2026-09-07', name: 'Transfer to savings', amount: 500, plaidCategory: cat('TRANSFER_OUT') },
    { id: 'g', date: '2026-09-08', name: 'Chase card payment', amount: 900, plaidCategory: cat('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') },
    { id: 'h', date: '2026-09-20', merchant: 'Shell', name: 'SHELL', amount: 40, plaidCategory: cat('TRANSPORTATION') },
    { id: 'i', date: '2026-08-03', merchant: 'Costco', name: 'COSTCO', amount: 150, plaidCategory: cat('GENERAL_MERCHANDISE') },
    { id: 'j', date: '2026-08-25', merchant: 'Shell', name: 'SHELL', amount: 45, plaidCategory: cat('TRANSPORTATION') }
];
const sep = S.monthSummary(txns, rules, '2026-09');
check('spend is gross purchases, skipping income/transfer/card payment', near(sep.spend, 180 + 6.5 + 5.5 + 40), String(sep.spend));
check('refunds and net are their own numbers', near(sep.refunds, 20) && near(sep.net, sep.spend - 20));
check('income', sep.income === 4000);
check('transfers out', sep.transfersOut === 500);
check('count is purchases only', sep.count === 4);
check('pending counted', sep.pending === 1);
check('rule moves Costco into Groceries', sep.byCategory.find(c => c.id === 'GROCERIES')?.total === 180);
check('refund nets Shopping to −20', sep.byCategory.find(c => c.id === 'GENERAL_MERCHANDISE')?.total === -20);
check('categories sorted by total', sep.byCategory[0].id === 'GROCERIES');
check('merchants merged by key', sep.byMerchant.find(m => m.name === 'Starbucks')?.count === 2);
const sepUpTo = S.monthSummary(txns, rules, '2026-09', { upTo: '2026-09-06' });
check('upTo caps the window', near(sepUpTo.spend, 180 + 6.5 + 5.5) && near(sepUpTo.refunds, 20), String(sepUpTo.spend));
const aug = S.monthSummary(txns, rules, '2026-08');
check('another month is its own', near(aug.spend, 195));
check('empty month', S.monthSummary(txns, rules, '2026-07').spend === 0);

// ── recurring ──
console.log('recurring');
const beat = [
    { id: 'n1', date: '2026-06-15', merchant: 'Netflix', amount: 15.49, plaidCategory: cat('ENTERTAINMENT') },
    { id: 'n2', date: '2026-07-15', merchant: 'Netflix', amount: 15.49, plaidCategory: cat('ENTERTAINMENT') },
    { id: 'n3', date: '2026-08-15', merchant: 'Netflix', amount: 15.49, plaidCategory: cat('ENTERTAINMENT') },
    { id: 'g1', date: '2026-08-01', merchant: 'Gym', amount: 40, plaidCategory: cat('PERSONAL_CARE') },
    { id: 'g2', date: '2026-08-08', merchant: 'Gym', amount: 40, plaidCategory: cat('PERSONAL_CARE') },
    { id: 'g3', date: '2026-08-15', merchant: 'Gym', amount: 40, plaidCategory: cat('PERSONAL_CARE') },
    { id: 'g4', date: '2026-08-22', merchant: 'Gym', amount: 40, plaidCategory: cat('PERSONAL_CARE') },
    { id: 'c1', date: '2026-06-02', merchant: 'Costco', amount: 180, plaidCategory: cat('GROCERIES') },
    { id: 'c2', date: '2026-07-01', merchant: 'Costco', amount: 95, plaidCategory: cat('GROCERIES') },
    { id: 'c3', date: '2026-08-03', merchant: 'Costco', amount: 260, plaidCategory: cat('GROCERIES') },
    { id: 'o1', date: '2025-01-10', merchant: 'Old Sub', amount: 9, plaidCategory: cat('ENTERTAINMENT') },
    { id: 'o2', date: '2025-02-10', merchant: 'Old Sub', amount: 9, plaidCategory: cat('ENTERTAINMENT') },
    { id: 'o3', date: '2025-03-10', merchant: 'Old Sub', amount: 9, plaidCategory: cat('ENTERTAINMENT') },
    { id: 'p1', date: '2026-08-29', merchant: 'Netflix', amount: 15.49, pending: true, plaidCategory: cat('ENTERTAINMENT') }
];
const rec = S.recurring(beat, [], { today: '2026-09-09' });
const netflix = rec.find(r => r.name === 'Netflix');
check('monthly beat found', netflix && netflix.cadence === 'monthly', JSON.stringify(rec));
check('amount is the median', netflix && near(netflix.amount, 15.49));
check('next is last + 30 days', netflix && netflix.next === '2026-09-14', netflix && netflix.next);
check('pending rows do not count', netflix && netflix.count === 3);
check('weekly beat found', rec.find(r => r.name === 'Gym')?.cadence === 'weekly');
check('variable amounts are not a subscription', !rec.find(r => r.name === 'Costco'));
check('a beat that stopped is history', !rec.find(r => r.name === 'Old Sub'));
check('sorted by amount', rec[0].name === 'Gym');

// ── applySyncPage ──
console.log('applySyncPage');
const accountIdFor = (pid) => (pid === 'chk' ? 'acct-1' : pid === 'cc' ? 'acct-2' : null);
const blob = { transactions: [], tombstones: {} };
const now = '2026-09-09T10:00:00.000Z';
let c = S.applySyncPage(blob, {
    added: [
        { id: 'p1', accountId: 'chk', date: '2026-09-01', name: 'STARBUCKS', merchant: 'Starbucks', amount: 6.5, pending: true, category: cat('FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE') },
        { id: 'x1', accountId: 'other', date: '2026-09-01', name: 'IGNORED', amount: 99 },
        { id: 'u1', accountId: 'cc', date: '2026-09-02', name: 'UNITED', merchant: 'United Airlines', amount: 500, category: cat('TRAVEL') }
    ]
}, accountIdFor, { now });
check('added rows land; untracked account dropped', c.added === 2 && blob.transactions.length === 2, JSON.stringify(c));
check('row shape', blob.transactions[0].accountId === 'acct-1' && blob.transactions[0].plaidCategory.primary === 'FOOD_AND_DRINK' && blob.transactions[0].createdAt === now);
blob.transactions[0].category = 'GROCERIES';   // the user's own filing on the pending row
c = S.applySyncPage(blob, {
    added: [{ id: 's1', accountId: 'chk', date: '2026-09-03', name: 'STARBUCKS', merchant: 'Starbucks', amount: 6.5, pending: false, pendingId: 'p1', category: cat('FOOD_AND_DRINK') }],
    modified: [{ id: 'u1', accountId: 'cc', date: '2026-09-02', name: 'UNITED', merchant: 'United Airlines', amount: 512.8, category: cat('TRAVEL') }],
    removed: [{ id: 'p1' }]
}, accountIdFor, { now });
check('posted row retires its pending twin', !blob.transactions.find(t => t.id === 'p1') && blob.transactions.find(t => t.id === 's1'));
check('twin is tombstoned', blob.tombstones.p1 === now);
check('the user\'s filing carries over', blob.transactions.find(t => t.id === 's1').category === 'GROCERIES');
check('modified updates the amount', blob.transactions.find(t => t.id === 'u1').amount === 512.8);
check('removed already gone is not double-counted', c.removed === 0 && c.added === 1 && c.modified === 1, JSON.stringify(c));
blob.transactions.find(t => t.id === 'u1').category = 'ENTERTAINMENT';
S.applySyncPage(blob, { modified: [{ id: 'u1', accountId: 'cc', date: '2026-09-02', name: 'UNITED', amount: 512.8, category: cat('TRAVEL') }] }, accountIdFor, { now });
check('a modification keeps the user override', blob.transactions.find(t => t.id === 'u1').category === 'ENTERTAINMENT');
c = S.applySyncPage(blob, { removed: ['u1', 'nope'] }, accountIdFor, { now });
check('removed by bare id', c.removed === 1 && !blob.transactions.find(t => t.id === 'u1'));
c = S.applySyncPage(blob, { modified: [{ id: 'm1', accountId: 'chk', date: '2026-09-04', name: 'NEW VIA MODIFIED', amount: 3 }] }, accountIdFor, { now });
check('a modified row we never saw is added', c.added === 1);

// ── pruneOld ──
console.log('pruneOld');
const old = { transactions: [
    { id: 'k', date: '2024-09-15', amount: 1 },
    { id: 'l', date: '2024-10-01', amount: 1 },
    { id: 'm', date: '2026-09-01', amount: 1 }
], tombstones: {} };
const pruned = S.pruneOld(old, { today: '2026-09-09', now });
check('rows before the 24-month window go', pruned === 1 && old.transactions.length === 2 && old.tombstones.k === now);
check('the window starts at the first of the month', !!old.transactions.find(t => t.id === 'l'));

// ── display names, trend, day strip ──
console.log('display helpers');
check('raw bank text is title-cased and trimmed', S.prettyName({ name: 'ZELLE TO PARKMERCED APTS' }) === 'Zelle to Parkmerced Apts');
check('reference codes fall away', S.prettyName({ name: 'AMAZON.COM*2K3JH9' }) === 'Amazon.com' && S.prettyName({ name: 'ONLINE TRANSFER TO ALLY ****7730' }) === 'Online Transfer to Ally');
check('Plaid merchant is used as is', S.prettyName({ merchant: 'Starbucks', name: 'STARBUCKS 123' }) === 'Starbucks');
check('mixed-case names are left alone', S.prettyName({ name: 'Apple.com/bill' }) === 'Apple.com/bill');
check('monogram', S.monogram('Whole Foods') === 'WF' && S.monogram('Uber') === 'UB');
const trend = S.monthTrend(txns, rules, '2026-09', 3);
check('trend covers n months ending at the month', trend.length === 3 && trend[0].month === '2026-07' && trend[2].month === '2026-09');
check('trend spend matches the summary', near(trend[1].spend, 195) && near(trend[2].spend, sep.spend));
const daily = S.dailySpend(txns, rules, '2026-09');
check('daily has one slot per day', daily.days.length === 30);
check('daily nets the refund on its day', near(daily.days[5], -20) && near(daily.days[1], 186.5));
check('busiest day', daily.top === 2 && near(daily.topValue, 186.5));

console.log('');
if (failures) { console.error(`spending: ${failures} check(s) failed`); process.exit(1); }
console.log('spending: all checks passed');
