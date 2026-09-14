#!/usr/bin/env node
/**
 * PortfolioTickers.consolidate / filter / sort / summarize — the Tickers
 * page's view over holdings + watchlist (js/apps/portfolio/portfolio-tickers.js).
 * Pure over plain data, so it runs standalone:
 *
 *   node tests/portfolio-tickers-test.js
 */

const PortfolioTickers = require('../js/apps/portfolio/portfolio-tickers.js');

let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

const OCC = 'AAPL261218C00250000';
const optionMetaOf = (t) => (t === OCC ? { underlying: 'AAPL', expiration: '2026-12-18', optionType: 'call', strike: 250 } : null);

const holdings = [
    { ticker: 'NVDA', totalShares: 100, avgCostBasis: 300, costBasis: 30000, currentPrice: 500, currentValue: 50000, profitLoss: 20000, profitLossPercent: 66.7, dayChange: -1500, dayChangePercent: -2.9, accounts: ['acc-1', 'acc-2'] },
    { ticker: 'AAPL', totalShares: 50, avgCostBasis: 150, costBasis: 7500, currentPrice: 210, currentValue: 10500, profitLoss: 3000, profitLossPercent: 40, dayChange: 200, dayChangePercent: 1.9, accounts: ['acc-1'] },
    { ticker: OCC, option: optionMetaOf(OCC), totalShares: 2, avgCostBasis: 5, costBasis: 1000, currentPrice: 8, currentValue: 1600, profitLoss: 600, profitLossPercent: 60, dayChange: 40, dayChangePercent: 2.6, accounts: ['acc-2'], priceEstimated: true },
    // No quote yet: value/P&L unknown, must read "—" and sink in a sort.
    { ticker: 'NEWCO', totalShares: 10, avgCostBasis: 20, costBasis: 200, currentPrice: 0, currentValue: 0, profitLoss: -200, profitLossPercent: -100, dayChange: 0, dayChangePercent: 0, accounts: ['acc-1'] }
];
const watchlist = [{ ticker: 'MSFT' }, { ticker: 'aapl' }, { ticker: 'VOO' }];
const priceCache = {
    MSFT: { price: 400, change: 4, changePercent: 1.0 },
    VOO: { price: 480, change: -2.4, changePercent: -0.5, estimated: true }
};
const names = { NVDA: 'NVIDIA Corporation', AAPL: 'Apple Inc.', MSFT: 'Microsoft Corporation' };
const labelOf = (t) => (t === OCC ? 'AAPL $250 Call 12/18/26' : t);

// ── consolidate ──────────────────────────────────────────────────────
const rows = PortfolioTickers.consolidate({
    holdings, watchlist, priceCache, totalValue: 62100 + 10000 /* + cash */,
    nameOf: (t) => names[t] || '', labelOf, optionMetaOf
});
const by = Object.fromEntries(rows.map(r => [r.ticker, r]));

check('one row per ticker across both sources', rows.length === 6, `${rows.length}`);
check('held row keeps position numbers', by.NVDA.held && by.NVDA.shares === 100 && by.NVDA.value === 50000 && by.NVDA.pl === 20000);
check('held row counts its accounts', by.NVDA.accountCount === 2 && by.NVDA.accounts.join() === 'acc-1,acc-2');
check('ticker both held and watched is ONE row wearing both flags (case-insensitive)', by.AAPL.held && by.AAPL.watched && !rows.some(r => r.ticker === 'aapl'));
check('held-only row is not watched', by.NVDA.watched === false);
check('watch-only row reads the price cache', by.MSFT.watched && !by.MSFT.held && by.MSFT.price === 400 && by.MSFT.dayChange === 4 && by.MSFT.dayPct === 1.0);
check('watch-only row has no position numbers', by.MSFT.shares === 0 && by.MSFT.value === null && by.MSFT.pl === null && by.MSFT.weight === null && by.MSFT.accountCount === 0);
check('estimated flag rides through from the cache', by.VOO.priceEstimated === true && by[OCC].priceEstimated === true);
check('weight is the share of the scoped book (holdings + cash)', Math.abs(by.NVDA.weight - (50000 / 72100) * 100) < 1e-9);
check('weight defaults to the holdings value when no total is given',
    Math.abs(PortfolioTickers.consolidate({ holdings, watchlist: [], priceCache }).find(r => r.ticker === 'NVDA').weight - (50000 / 62100) * 100) < 1e-9);
check('unquoted holding: value 0, P&L and day unknown', by.NEWCO.held && by.NEWCO.value === 0 && by.NEWCO.pl === null && by.NEWCO.dayChange === null && by.NEWCO.weight === 0);
check('option row carries its meta and friendly label', by[OCC].option && by[OCC].option.strike === 250 && by[OCC].label === 'AAPL $250 Call 12/18/26');
check('names resolve through nameOf', by.NVDA.name === 'NVIDIA Corporation' && by.VOO.name === '');
check('inputs are not mutated', holdings[0].accounts.length === 2 && !('held' in holdings[0]));

// ── filter ───────────────────────────────────────────────────────────
const t = (f) => PortfolioTickers.filter(rows, f).map(r => r.ticker).sort();
check('no filter keeps everything', t({}).length === 6);
check('source=held drops watch-only rows', t({ source: 'held' }).join() === [OCC, 'AAPL', 'NEWCO', 'NVDA'].sort().join());
check('source=watch keeps held-and-watched rows too', t({ source: 'watch' }).join() === ['AAPL', 'MSFT', 'VOO'].sort().join());
check('kind=options keeps only contracts', t({ kind: 'options' }).join() === OCC);
check('kind=stocks drops contracts', !t({ kind: 'stocks' }).includes(OCC) && t({ kind: 'stocks' }).length === 5);
check('account filter keeps positions in that account only (watch-only rows fall away)', t({ accountId: 'acc-2' }).join() === [OCC, 'NVDA'].sort().join());
check('query matches the ticker', t({ query: 'nv' }).join() === 'NVDA');
check('query matches the company name', t({ query: 'micro' }).join() === 'MSFT');
check('query matches the option label', t({ query: '$250 call' }).join() === OCC);
check('query is trimmed and case-insensitive', t({ query: '  AAPL ' }).join() === [OCC, 'AAPL'].sort().join());
check('filters combine', t({ source: 'watch', query: 'ap' }).join() === 'AAPL');

// ── sort ─────────────────────────────────────────────────────────────
const s = (col, dir) => PortfolioTickers.sort(rows, { col, dir }).map(r => r.ticker);
check('value desc, unknowns last', s('value', 'desc').join() === ['NVDA', 'AAPL', OCC, 'NEWCO', 'MSFT', 'VOO'].join(), s('value', 'desc').join());
check('value asc still sinks unknowns', s('value', 'asc').slice(0, 4).join() === ['NEWCO', OCC, 'AAPL', 'NVDA'].join() && s('value', 'asc').slice(4).length === 2);
check('ticker asc sorts by display label', s('ticker', 'asc').join() === ['AAPL', OCC, 'MSFT', 'NEWCO', 'NVDA', 'VOO'].join(), s('ticker', 'asc').join());
check('day sorts by PERCENT so held and watched rows compare', s('day', 'desc').slice(0, 3).join() === [OCC, 'AAPL', 'MSFT'].join(), s('day', 'desc').join());
check('accounts desc puts the multi-account position first', s('accounts', 'desc')[0] === 'NVDA');
check('name sort: unnamed rows sink', s('name', 'asc').slice(0, 3).join() === ['AAPL', 'MSFT', 'NVDA'].join());
check('sort is stable for ties', (() => {
    const tie = [{ ticker: 'A', value: 1, label: 'A' }, { ticker: 'B', value: 1, label: 'B' }, { ticker: 'C', value: 1, label: 'C' }];
    return PortfolioTickers.sort(tie, { col: 'value', dir: 'desc' }).map(r => r.ticker).join() === 'A,B,C';
})());
check('sort does not mutate its input', rows[0].ticker === 'NVDA' && rows[4].ticker === 'MSFT');

// ── summarize ────────────────────────────────────────────────────────
const sum = PortfolioTickers.summarize(rows);
check('summary counts', sum.total === 6 && sum.held === 4 && sum.watched === 3 && sum.both === 1 && sum.options === 1);
check('summary totals cover held rows only', sum.value === 62100 && sum.pl === 23600 && sum.dayChange === -1260);
check('summary counts distinct accounts', sum.accountCount === 2);

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall good');
