#!/usr/bin/env node
/**
 * Finance in threads (docs/THREAD_PANELS.md step 3): what Your money, an
 * account, a strategy, a ticker and a sender with accounts attached draw in
 * their drawers. Every figure is the package's own arithmetic (V1), here
 * over small stubs of PortfolioApp, PortfolioStrategy and SpendingApp.
 */
const assert = require('assert');
global.AnswerBlocks = require('../js/components/answer-blocks.js');
global.ThreadPanels = require('../js/core/thread-panels.js');
ThreadPanels._providers = [];   // only Finance's here

const store = {
    portfolio: { accounts: [{ id: 'a1', name: 'Fidelity IRA', type: 'ira' }, { id: 'a2', name: 'Robinhood', type: 'brokerage', brokerage: { itemId: 'i1', institution: 'Robinhood', needsLogin: true } }], properties: [], liabilities: [] },
    spending: { accounts: [{ id: 'b1', name: 'Amex Gold', type: 'credit', itemId: 'i2', institution: 'Amex', balance: { current: 812.4 } }] }
};
global.StorageManager = { get: k => store[k] || null, set() {} };
const H = (ticker, value, cost, account) => ({ ticker, totalShares: 10, currentValue: value, costBasis: cost, profitLoss: value - cost, profitLossPercent: (value - cost) / cost * 100, currentPrice: value / 10, account });
global.PortfolioApp = {
    valueHistory: [{ date: '2026-10-01', netWorth: 100000 }, { date: '2026-10-10', netWorth: 104000 }],
    loadData() {}, changed() {}, autoRefreshPrices() {},
    getAccounts: () => store.portfolio.accounts,
    computeHoldings: (id) => (id === 'a1' ? [H('VTI', 60000, 50000)] : id === 'a2' ? [H('AAPL', 30000, 20000), H('VTI', 10000, 9000)] : [H('VTI', 70000, 59000), H('AAPL', 30000, 20000)]),
    computeCash: id => (id === 'a1' ? 4000 : 0),
    getSummary: () => ({ totalValue: 104000, cash: 4000, realEstateValue: 0, liabilitiesTotal: 0, netWorth: 104000, totalDayChange: 0, totalDayChangePercent: 0 }),
    getAccountHistory: id => (id === 'a1' ? [{ date: '2026-10-01', value: 62000 }, { date: '2026-10-10', value: 64000 }] : []),
    computeHoldingsForTickerByAccount: t => (t === 'AAPL' ? [{ ...H('AAPL', 30000, 20000), account: { name: 'Robinhood' } }] : []),
    getTickerHistory: () => [], getUniqueTickers: () => ['VTI', 'AAPL'],
    optionMeta: () => null, displayTicker: t => t
};
global.PortfolioStrategy = {
    getById: id => (id === 's1' ? { id: 's1', name: 'Three-fund' } : null),
    getDefault: () => ({ id: 's1', name: 'Three-fund' }),
    forAccount: () => ({ strategy: { id: 's1', name: 'Three-fund' } }),
    missingTopics: () => [],
    evaluate: () => ({ empty: false, headline: 'One sleeve over its band', targets: [{ label: 'US stocks', actualPct: 67.3, targetPct: 60, minPct: 55, maxPct: 65, status: 'over' }, { label: 'Bonds', actualPct: 3.8, targetPct: 10, minPct: 5, maxPct: 15, status: 'under' }], rules: [{ status: 'breach', detail: 'AAPL is 29% of the book; the limit is 10%.' }] })
};
global.SpendingApp = {
    loadData() {}, accounts: () => store.spending.accounts, accountById: id => store.spending.accounts.find(a => a.id === id), links: () => [{ id: 'i2', needsLogin: false }],
    currentMonth: () => '2026-10', monthLabel: m => m, rules: () => [], scopedTransactions: () => [],
    summary: () => ({ byCategory: [{ label: 'Dining', total: 420 }, { label: 'Travel', total: 1200 }] }),
    monthTrend: () => [{ month: '2026-09', spend: 1900 }, { month: '2026-10', spend: 1620 }]
};
const FinancePanels = require('../js/apps/portfolio/finance-panels.js');
const ctx = {};
const ids = row => ThreadPanels.blocksFor(row, ctx).map(b => b.id);
const block = (row, id) => (ThreadPanels.blocksFor(row, ctx).find(b => b.id === id) || {}).block;

// scopeOf: the thread's key or the accounts attached to a sender.
assert.deepStrictEqual(FinancePanels.scopeOf({ key: 'page:portfolio' }), { whole: true, portfolio: 'all', spending: 'all' });
assert.deepStrictEqual(FinancePanels.scopeOf({ key: 'portfolio:account:a1' }), { portfolio: ['a1'], spending: [] });
assert.deepStrictEqual(FinancePanels.scopeOf({ key: 'sender:x', rec: { links: [{ kind: 'account', ref: 'spending:b1' }, { kind: 'doc', ref: 'd1' }, { kind: 'account', ref: 'portfolio:a1' }] } }), { portfolio: ['a1'], spending: ['b1'] });
assert.strictEqual(FinancePanels.scopeOf({ key: 'sender:y', rec: { links: [] } }), null, 'a sender with no account draws no money');
assert.deepStrictEqual(ids({ key: 'sender:y', type: 'sender', rec: { links: [] }, memberRows: [] }), []);

// Your money: the whole picture.
const money = { key: 'page:portfolio', type: 'other' };
assert.deepStrictEqual(ids(money), ['networth:now', 'networth:history', 'accounts:list', 'plan:targets:s1', 'plan:rules:s1', 'holdings:top', 'spending:categories', 'spending:months']);
assert.strictEqual(block(money, 'networth:now').items[0].value, 104000);
const accts = block(money, 'accounts:list').rows;
assert.deepStrictEqual(accts.map(r => [r.name, r.kind, r.value, r.status]), [['Fidelity IRA', 'IRA', 64000, 'Kept by hand'], ['Robinhood', 'Brokerage', 40000, 'Needs sign-in'], ['Amex Gold', 'Card', -812.4, 'Linked to Amex']]);
const plan = block(money, 'plan:targets:s1');
assert.ok(plan.title.includes('Three-fund') && plan.rows[0].state === 'Over' && plan.rows[1].state === 'Under', 'the plan\'s check, by its own arithmetic');
assert.deepStrictEqual(block(money, 'holdings:top').rows.map(r => [r.ticker, r.share]), [['VTI', 70], ['AAPL', 30]]);

// One account's thread: its value over time, its plan, its holdings; no one-row table.
const ira = { key: 'portfolio:account:a1', type: 'other' };
assert.deepStrictEqual(ids(ira), ['accounts:history', 'plan:targets:s1', 'plan:rules:s1', 'holdings:top']);
assert.deepStrictEqual(block(ira, 'accounts:history').points.map(p => p.y), [62000, 64000]);

// A sender holding the IRA and the Amex card: both halves, scoped; the one investment account's plan.
const sender = { key: 'sender:r', type: 'sender', rec: { links: [{ kind: 'account', ref: 'portfolio:a1' }, { kind: 'account', ref: 'spending:b1' }] }, memberRows: [] };
assert.deepStrictEqual(ids(sender), ['accounts:list', 'plan:targets:s1', 'plan:rules:s1', 'holdings:top', 'spending:categories', 'spending:months']);
assert.deepStrictEqual(block(sender, 'accounts:list').rows.map(r => r.name), ['Fidelity IRA', 'Amex Gold']);

// An account that only follows the household plan is not graded against it alone.
PortfolioStrategy.forAccount = () => ({ strategy: { id: 's1', name: 'Three-fund' }, inherited: true });
assert.deepStrictEqual(ids(ira), ['accounts:history', 'holdings:top']);

// A strategy's thread: only its check. A ticker's: the position.
assert.deepStrictEqual(ids({ key: 'portfolio:strategy:s1', type: 'other' }), ['plan:targets:s1', 'plan:rules:s1']);
assert.deepStrictEqual(ids({ key: 'portfolio:ticker:AAPL', type: 'other' }), ['holdings:position']);
assert.strictEqual(block({ key: 'portfolio:ticker:AAPL', type: 'other' }, 'holdings:position').items[1].value, 10000, 'gain = value − cost');

// Titles for chats no page drew.
assert.strictEqual(FinancePanels.hostFor('page:portfolio').title, 'Your money');
assert.strictEqual(FinancePanels.hostFor('portfolio:account:a1').recordKey, 'portfolio:account:a1');
assert.strictEqual(FinancePanels.hostFor('portfolio:account:gone'), null);
assert.ok(FinancePanels.hasData());

console.log('finance-panels: Your money, accounts, a strategy, a ticker and a sender\'s accounts drawn from the records passed');
