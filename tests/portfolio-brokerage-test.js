#!/usr/bin/env node
/**
 * PortfolioBrokerage's pure mapping — what a linked brokerage's Plaid data
 * becomes in the portfolio (js/apps/portfolio/portfolio-brokerage.js).
 * Plain data in, plain rows out, so it runs standalone:
 *
 *   node tests/portfolio-brokerage-test.js
 */

const B = require('../js/apps/portfolio/portfolio-brokerage.js');

let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const aapl = { id: 's1', ticker: 'AAPL', name: 'Apple', type: 'equity', cash: false, option: null };
const call = { id: 's2', ticker: 'AAPL 261218C00250000', name: 'AAPL call', type: 'derivative', cash: false,
    option: { type: 'call', expiration: '2026-12-18', strike: 250, underlying: 'AAPL' } };
const put = { id: 's5', ticker: null, type: 'derivative', cash: false, option: { type: 'put', expiration: '2027-01-15', strike: 12.5, underlying: 'f' } };
const usd = { id: 's3', ticker: 'CUR:USD', name: 'US Dollar', type: 'cash', cash: true, option: null };
const mystery = { id: 's4', ticker: null, name: 'Some fund', type: 'mutual fund', cash: false, option: null };
const spaced = { id: 's6', ticker: 'BRK B', type: 'equity', cash: false, option: null };

// ── tickerFor ──
console.log('tickerFor');
check('stock passes through uppercased', B.tickerFor({ ...aapl, ticker: 'aapl' }) === 'AAPL');
check('option becomes the OCC symbol from contract fields', B.tickerFor(call) === 'AAPL261218C00250000');
check('put with fractional strike and no broker symbol', B.tickerFor(put) === 'F270115P00012500');
check('cash has no ticker', B.tickerFor(usd) === null);
check('CUR: symbols have no ticker', B.tickerFor({ ...usd, cash: false }) === null);
check('unidentified security has no ticker', B.tickerFor(mystery) === null);
check('symbol with whitespace is not a ticker', B.tickerFor(spaced) === null);
check('null security', B.tickerFor(null) === null);

// ── accountTypeFor / accountNameFor ──
console.log('account type and name');
check('brokerage', B.accountTypeFor({ subtype: 'brokerage' }) === 'brokerage');
check('401k', B.accountTypeFor({ subtype: '401k' }) === '401k');
check('roth', B.accountTypeFor({ subtype: 'roth' }) === 'roth-ira');
check('roth 401k reads as roth', B.accountTypeFor({ subtype: 'roth 401k' }) === 'roth-ira');
check('rollover ira', B.accountTypeFor({ subtype: 'rollover ira' }) === 'ira');
check('hsa', B.accountTypeFor({ subtype: 'hsa' }) === 'hsa');
check('unknown subtype → other', B.accountTypeFor({ subtype: 'crypto exchange' }) === 'other');
check('missing subtype → brokerage', B.accountTypeFor({}) === 'brokerage');
check('name carries institution and mask', B.accountNameFor({ name: 'Individual', mask: '1234' }, 'Fidelity') === 'Fidelity Individual ····1234');
check('name does not repeat the institution', B.accountNameFor({ name: 'Robinhood Individual', mask: null }, 'Robinhood') === 'Robinhood Individual');

// ── holdings → cash / positions / seed ──
console.log('holdings');
const holdings = [
    { accountId: 'a1', security: aapl, quantity: 10, costBasis: 1500, price: 210, value: 2100 },
    { accountId: 'a1', security: aapl, quantity: 5, costBasis: 1000, price: 210, value: 1050 },  // second lot, same ticker
    { accountId: 'a1', security: call, quantity: 2, costBasis: 900, price: 5.5, value: 1100 },
    { accountId: 'a1', security: usd, quantity: 250.5, costBasis: 250.5, price: 1, value: 250.5 },
    { accountId: 'a1', security: mystery, quantity: 3, costBasis: 30, price: 10, value: 30 },
    { accountId: 'a1', security: { ...aapl, id: 's9', ticker: 'NOCOST' }, quantity: 4, costBasis: null, price: 25, value: 100 },
    { accountId: 'a2', security: aapl, quantity: 99, costBasis: 1, price: 210, value: 1 },
    { accountId: 'a2', security: usd, quantity: 7, costBasis: 7, price: 1, value: 7 }
];
check('cash is the sum of cash-equivalent value in that account', B.cashOf(holdings, 'a1') === 250.5);
check('cash scopes by account', B.cashOf(holdings, 'a2') === 7);
check('no cash line → null (leave the balance alone)', B.cashOf([holdings[0]], 'a1') === null);
const pos = B.positionsOf(holdings, 'a1');
check('positions merge lots per ticker', pos.find(p => p.ticker === 'AAPL').quantity === 15);
check('positions sum cost across lots', pos.find(p => p.ticker === 'AAPL').costBasis === 2500);
check('positions skip cash and unidentified securities', pos.length === 3 && !pos.some(p => p.ticker === null));
check('option position carries the 100 multiplier', pos.find(p => p.ticker === 'AAPL261218C00250000').mult === 100);
const seed = B.seedFromHoldings(holdings, { accountId: 'L1', plaidAccountId: 'a1', institution: 'Fidelity', today: '2026-09-09' });
check('seed: one holding row per position', seed.length === 3 && seed.every(r => r.type === 'holding'));
const seedAapl = seed.find(r => r.ticker === 'AAPL');
check('seed: average cost per share across lots', near(seedAapl.pricePerShare, 2500 / 15, 1e-3));
check('seed: option premium per share (cost / contracts / 100)', near(seed.find(r => r.ticker.startsWith('AAPL26')).pricePerShare, 4.5));
check('seed: dated today, sourced, dedup key per account+ticker', seedAapl.date === '2026-09-09' && seedAapl.source === 'plaid' && seedAapl.sourceRef === 'plaid:seed:a1:AAPL');
const noCost = seed.find(r => r.ticker === 'NOCOST');
check('seed: no cost basis → priced at market and the note says so', noCost.pricePerShare === 25 && /no cost basis/.test(noCost.notes));

// ── perSharePrice ──
console.log('perSharePrice');
check('stock: price stands', near(B.perSharePrice({ quantity: 10, amount: 1500, price: 150 }, 1), 150));
check('stock: missing price derived from amount', near(B.perSharePrice({ quantity: 10, amount: 1500, price: 0 }, 1), 150));
check('option quoted per share', near(B.perSharePrice({ quantity: 2, amount: 900, price: 4.5 }, 100), 4.5));
check('option quoted per contract is divided by 100', near(B.perSharePrice({ quantity: 2, amount: 900, price: 450 }, 100), 4.5));
check('option with no amount keeps price', near(B.perSharePrice({ quantity: 2, amount: 0, price: 4.5 }, 100), 4.5));

// ── mapTransactions ──
console.log('mapTransactions');
const txns = [
    { id: 't1', accountId: 'a1', date: '2026-09-03', name: 'BUY AAPL', type: 'buy', subtype: 'buy', quantity: 10, amount: 1500, price: 150, fees: 0, security: aapl },
    { id: 't2', accountId: 'a1', date: '2026-09-04', name: 'SELL AAPL', type: 'sell', subtype: 'sell', quantity: -4, amount: -840, price: 210, fees: 0.5, security: aapl },
    { id: 't3', accountId: 'a1', date: '2026-09-05', name: 'BUY CALL', type: 'buy', subtype: 'buy', quantity: 2, amount: 900, price: 450, fees: 1.3, security: call },
    { id: 't4', accountId: 'a1', date: '2026-09-06', name: 'Dividend AAPL', type: 'cash', subtype: 'dividend', quantity: 0, amount: -12.34, price: 0, fees: 0, security: aapl },
    { id: 't5', accountId: 'a1', date: '2026-09-06', name: 'Deposit', type: 'cash', subtype: 'deposit', quantity: 0, amount: -500, price: 0, fees: 0, security: null },
    { id: 't6', accountId: 'a1', date: '2026-09-07', name: 'Fee', type: 'fee', subtype: 'account fee', quantity: 0, amount: 2, price: 0, fees: 0, security: null },
    { id: 't7', accountId: 'a1', date: '2026-09-07', name: 'Cancelled', type: 'cancel', subtype: 'cancel', quantity: 1, amount: 1, price: 1, fees: 0, security: aapl },
    { id: 't8', accountId: 'a1', date: '2026-09-07', name: 'Fund buy', type: 'buy', subtype: 'buy', quantity: 3, amount: 30, price: 10, fees: 0, security: mystery },
    { id: 't9', accountId: 'a2', date: '2026-09-07', name: 'Other account', type: 'buy', subtype: 'buy', quantity: 1, amount: 1, price: 1, fees: 0, security: aapl },
    { id: 't10', accountId: 'a1', date: '2026-09-08', name: 'Zero cash', type: 'cash', subtype: 'interest', quantity: 0, amount: 0, price: 0, fees: 0, security: null }
];
const rows = B.mapTransactions(txns, { accountId: 'L1', plaidAccountId: 'a1' });
const by = Object.fromEntries(rows.map(r => [r.sourceRef, r]));
check('scoped to the account', rows.every(r => r.accountId === 'L1') && !by['plaid:t9']);
check('buy maps with absolute quantity', by['plaid:t1'].type === 'buy' && by['plaid:t1'].quantity === 10 && by['plaid:t1'].pricePerShare === 150);
check('sell: negative quantity becomes positive, price kept', by['plaid:t2'].type === 'sell' && by['plaid:t2'].quantity === 4 && by['plaid:t2'].pricePerShare === 210);
check('option buy: OCC ticker, per-contract price normalised', by['plaid:t3'].ticker === 'AAPL261218C00250000' && near(by['plaid:t3'].pricePerShare, 4.5));
check('dividend → cash row, account’s point of view (+in)', by['plaid:t4'].type === 'cash' && by['plaid:t4'].subtype === 'dividend' && by['plaid:t4'].amount === 12.34 && by['plaid:t4'].ticker === 'AAPL');
check('deposit → cash row with no ticker', by['plaid:t5'].type === 'cash' && by['plaid:t5'].amount === 500 && by['plaid:t5'].ticker === null);
check('fee → cash row, negative', by['plaid:t6'].type === 'cash' && by['plaid:t6'].amount === -2);
check('cancel dropped', !by['plaid:t7']);
check('buy of an unidentified security becomes a cash line, not a phantom position', by['plaid:t8'].type === 'cash' && by['plaid:t8'].amount === -30);
check('zero-amount cash event dropped', !by['plaid:t10']);
check('every row is sourced and dated', rows.every(r => r.source === 'plaid' && /^\d{4}-\d{2}-\d{2}$/.test(r.date)));

// ── reconcile ──
console.log('reconcile');
const broker = B.positionsOf(holdings, 'a1'); // AAPL 15, call 2, NOCOST 4
const drift = B.reconcile([{ ticker: 'AAPL', shares: 15 }, { ticker: 'AAPL261218C00250000', shares: 1 }, { ticker: 'GONE', shares: 3 }], broker, { today: '2026-09-09' });
const d = Object.fromEntries(drift.map(x => [x.ticker, x]));
check('matching position is not drift', !d.AAPL);
check('broker has more → add a holding for the difference at avg cost', d['AAPL261218C00250000'].fix.type === 'holding' && d['AAPL261218C00250000'].fix.quantity === 1 && near(d['AAPL261218C00250000'].fix.pricePerShare, 4.5));
check('broker has a position Portfolio lacks → holding for the whole lot', d.NOCOST.fix.type === 'holding' && d.NOCOST.fix.quantity === 4 && d.NOCOST.fix.pricePerShare === 25);
check('Portfolio has a position the broker lacks → sell it out', d.GONE.fix.type === 'sell' && d.GONE.fix.quantity === 3 && d.GONE.broker === 0);
check('fixes are dated today', drift.every(x => x.fix.date === '2026-09-09'));
check('tiny float differences are not drift', B.reconcile([{ ticker: 'AAPL', shares: 15.00000001 }], broker.filter(p => p.ticker === 'AAPL')).length === 0);

// ── since ──
console.log('since');
check('first pull starts the day after the seed', B.since({ seededAt: '2026-09-09' }, '2026-09-12') === '2026-09-10');
check('later pulls re-cover the overlap window', B.since({ seededAt: '2026-08-01', lastTxnDate: '2026-09-12' }, '2026-09-15', 7) === '2026-09-05');
check('overlap never reaches back into the seeded history', B.since({ seededAt: '2026-09-09', lastTxnDate: '2026-09-12' }, '2026-09-15', 7) === '2026-09-10');
check('no seed date: today is the anchor', B.since({}, '2026-09-09') === '2026-09-10');

// ── occSymbol ──
console.log('occSymbol');
check('call', B.occSymbol('aapl', '2026-12-18', 'call', 250) === 'AAPL261218C00250000');
check('put with cents', B.occSymbol('F', '2027-01-15', 'put', 12.5) === 'F270115P00012500');
check('bad expiration → null', B.occSymbol('F', 'soon', 'put', 12.5) === null);
check('missing strike → null', B.occSymbol('F', '2027-01-15', 'put', 0) === null);

// ── orphanedAccounts ──
console.log('orphanedAccounts');
const orphAccts = [
    { id: 'o1', name: 'Old sandbox', type: 'brokerage' },                       // link-born, link gone
    { id: 'o2', name: 'Still linked', type: 'brokerage', brokerage: { itemId: 'i' } },
    { id: 'o3', name: 'Manual', type: 'ira' }
];
const orphTxns = [
    { id: 't1', accountId: 'o1', source: 'plaid', sourceRef: 'plaid:seed:x:AAPL' },
    { id: 't2', accountId: 'o2', source: 'plaid', sourceRef: 'plaid:seed:y:MSFT' },
    { id: 't3', accountId: 'o3', type: 'buy' }
];
const orphans = B.orphanedAccounts(orphAccts, orphTxns);
check('only unlinked accounts with Plaid rows', orphans.length === 1 && orphans[0].id === 'o1', JSON.stringify(orphans.map(a => a.id)));
check('unlinked account with no rows and a plain name is not an orphan', B.orphanedAccounts(orphAccts, []).length === 0);
const orphMore = [
    { id: 'o4', name: 'Tartan Bank Plaid Saving ····1111', type: 'other' },        // link-born, empty
    { id: 'o5', name: 'Rainy day ····1111', type: 'other' },                       // masked name but hand-kept rows
    { id: 'o6', name: 'Stamped', type: 'brokerage', source: 'plaid' },
    { id: 'o7', name: 'Stamped and linked', type: 'brokerage', source: 'plaid', brokerage: { itemId: 'i' } }
];
const orphMoreTx = [{ id: 't9', accountId: 'o5', type: 'buy' }];
const more = B.orphanedAccounts(orphMore, orphMoreTx).map(a => a.id);
check('empty masked-name account is an orphan', more.includes('o4'), JSON.stringify(more));
check('masked name with hand-logged rows is kept', !more.includes('o5'));
check('source stamp is the reliable mark', more.includes('o6'));
check('a live link is never an orphan', !more.includes('o7'));

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nportfolio-brokerage: all checks passed');
