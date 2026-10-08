// The Portfolio views the phone asks the Mac for
// (js/agent/mobile-views.js, 2026-09-21 — docs/MOBILE_NATIVE.md "M3").
//
// The phone draws the app in full, which means these digests are the
// whole contract. What must hold:
//   1. every number comes from the desktop's OWN accessors — the phone does
//      no portfolio arithmetic, so a second implementation cannot drift;
//   2. a digest is a READ: opening a page never spends a model run, and the
//      things that do (a brief, a profile, a summary) are named actions that
//      START work and say so, because they outlive the 30s view window;
//   3. the desktop's scoping rules survive the crossing — an unknown account
//      falls back to All, the all-scope-only sections stay there, source
//      counts are unscoped while the rows carry their own `via`;
//   4. `hideValues` is a per-Mac display preference and never travels.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const viewsSource = fs.readFileSync(path.join(__dirname, '../js/agent/mobile-views.js'), 'utf8');
const dom = new JSDOM('<body></body>', { url: 'https://local.test', runScripts: 'outside-only' });
const w = dom.window;

// --- the calls the digests are allowed to make, recorded ------------------
const calls = [];
const record = (name) => calls.push(name);

const HOLDINGS = [
    { ticker: 'AAPL', totalShares: 10, avgCostBasis: 100, costBasis: 1000, currentPrice: 150,
      currentValue: 1500, profitLoss: 500, profitLossPercent: 50, dayChange: 30, dayChangePercent: 2,
      dayBase: 1470, accounts: ['a1'] },
    { ticker: 'VOO', totalShares: 5, avgCostBasis: 400, costBasis: 2000, currentPrice: 420,
      currentValue: 2100, profitLoss: 100, profitLossPercent: 5, dayChange: -5, dayChangePercent: -0.2,
      dayBase: 2105, accounts: ['a1'] },
];

w.PortfolioApp = {
    hideValues: true,     // set on purpose: it must NOT reach the digest
    priceCache: { AAPL: { price: 150, change: 3, changePercent: 2, updatedAt: 1000 },
                  VOO: { price: 420, updatedAt: 2000 },
                  NVDA: { price: 900, change: 9, changePercent: 1, updatedAt: 1500 } },
    companyInfoCache: { AAPL: { name: 'Apple Inc.', sector: 'Technology', type: 'EQUITY' } },
    TICKER_SITES: [{ action: 'yahoo', label: 'Yahoo', url: (s) => `https://y/${s}` }],
    loadData() { record('loadData'); },
    async autoRefreshPrices() { record('autoRefreshPrices'); },
    async refreshPrices() { record('refreshPrices'); },
    getAccounts: () => [{ id: 'a1', name: 'Brokerage', type: 'brokerage' }],
    getSharedAccounts: () => [],
    computeHoldings: (id) => (id && id !== 'a1' ? [] : HOLDINGS),
    computeCash: () => 500,
    computeTotalCash: () => 500,
    getSummary: (hs, id) => ({
        totalValue: id ? 4100 : 4100, totalCost: 3000, totalPL: 600, totalPLPercent: 20,
        totalDayChange: 25, totalDayChangePercent: 0.7, totalDayBase: 3575,
        cash: 500, realEstateValue: 0, liabilitiesTotal: id ? 0 : 200000,
        netWorth: id ? 4100 : -195900, afterSession: null, afterChange: null, afterBase: null,
    }),
    getProperties: () => [{ id: 'p1', name: 'House', currentValue: 500000, purchasePrice: 400000 }],
    getLiabilities: () => [{ id: 'l1', name: 'Mortgage', type: 'mortgage', balance: 200000, monthlyPayment: 1500, propertyId: 'p1' }],
    liabilityTypeLabel: () => 'Mortgage',
    getWatchlist: () => [{ id: 'w1', ticker: 'NVDA' }],
    isWatched: (t) => t === 'NVDA',
    addToWatchlist(t) { record('addToWatchlist:' + t); return true; },
    removeFromWatchlist(t) { record('removeFromWatchlist:' + t); return true; },
    displayTicker: (t) => t,
    optionMeta: (t) => (t === 'AAPL250C' ? { underlying: 'AAPL', expiration: '2026-12-18', optionType: 'call', strike: 250 } : null),
    optionDaysToExpiry: () => 88,
    txnAmount: (t) => t.quantity * t.pricePerShare,
    valueHistory: [{ date: '2026-09-19', totalValue: 4000, netWorth: -196000 },
                   { date: '2026-09-20', totalValue: 4100, netWorth: -195900 }],
    getAccountHistory: () => [{ date: '2026-09-20', value: 4100, cash: 500 }],
    getTickerHistory: () => [{ date: '2026-09-20', price: 150, value: 1500 }],
    async getMarketHistory(t, r) { record('getMarketHistory:' + r); return [{ date: '2026-09-20', price: 150 }]; },
    async fetchCompanyInfo() { record('fetchCompanyInfo'); },
    computeHoldingsForTickerByAccount: () => [{ account: { id: 'a1', name: 'Brokerage', type: 'brokerage' },
        totalShares: 10, avgCostBasis: 100, costBasis: 1000, currentValue: 1500, profitLoss: 500, profitLossPercent: 50 }],
    getTickerTransactions: () => [{ id: 't1', type: 'buy', date: '2026-01-02', quantity: 10, pricePerShare: 100, accountId: 'a1' }],
};
w.PortfolioUI = { tickerName: (t) => (t === 'AAPL' ? 'Apple Inc.' : ''), formatAccountType: () => 'Brokerage' };

const VERDICTS = [
    { key: 'valuation', label: 'Valuation', options: ['Cheap', 'Fair', 'Expensive'], tones: ['good', 'ink', 'bad'] },
    { key: 'ai', label: 'AI role', options: ['Builder', 'Supplier'], categorical: true, fundOptions: ['Heavy', 'Light'] },
];
w.PortfolioProfile = {
    VERDICTS,
    get: (t) => (t === 'AAPL' ? { day: '2026-09-21', at: 5, model: 'm', name: 'Apple Inc.', text: '# Apple', verdicts: { valuation: 'Fair' }, format: 2 } : null),
    current: () => true,
    available: () => true,
    destination: () => 'this Mac',
    ownerNotes: () => [{ text: 'I hold this for the long term' }],
    ensure() { record('profile.ensure'); return Promise.resolve(); },
    parseVerdicts: () => ({ verdicts: {} }),
};
w.PortfolioBrief = {
    get: () => ({ day: '2026-09-21', at: 7, model: 'm', text: 'The market rose.' }),
    isToday: () => true,
    available: () => true,
    writing: () => null,
    destination: () => 'this Mac',
    ensure() { record('brief.ensure'); return Promise.resolve(); },
};
w.PortfolioTickers = {
    specs: () => VERDICTS,
    nameOf: (t) => t,
    _profileOf: (t) => (t === 'AAPL' ? { day: '2026-09-21', fund: false, verdicts: { valuation: 'Fair' } } : null),
    consolidate: ({ holdings, watchlist }) => [
        ...holdings.map((h) => ({ ticker: h.ticker, label: h.ticker, name: h.ticker, held: true, watched: false,
            shares: h.totalShares, avgCost: h.avgCostBasis, price: h.currentPrice, value: h.currentValue,
            weight: 30, pl: h.profitLoss, plPct: h.profitLossPercent, dayChange: h.dayChange, dayPct: h.dayChangePercent,
            accounts: h.accounts, accountCount: 1 })),
        ...watchlist.map((wl) => ({ ticker: wl.ticker, label: wl.ticker, name: wl.ticker, held: false, watched: true,
            shares: 0, avgCost: null, price: 900, value: null, weight: null, pl: null, plPct: null,
            dayChange: 9, dayPct: 1, accounts: [], accountCount: 0 })),
    ],
    attachIndicators: (rows, { profileOf }) => rows.map((r) => {
        const p = profileOf(r.ticker);
        return { ...r, ind: p ? { valuation: { word: 'Fair', rank: 1, tone: 'ink' } } : {}, profiled: !!p, profileDay: p?.day || null };
    }),
    summarize: (rows) => ({ total: rows.length, held: 2, watched: 1, value: 3600 }),
    summarizeIndicators: (rows) => ({ total: rows.length, profiled: 1, today: 1, missing: 2 }),
    defaultDir: (col) => (col === 'ind:valuation' ? 'asc' : null),
};
w.PortfolioStrategy = {
    INTERVIEW: [{ id: 'purpose', question: 'What is this money for?' }],
    all: () => [{ id: 's1', name: 'Core', objective: 'Grow steadily', status: 'active', isDefault: true, history: [] }],
    getById: (id) => (id === 's1' ? { id: 's1', name: 'Core', objective: 'Grow steadily', status: 'active', isDefault: true, history: [{ at: '2026-09-01', summary: 'Created' }] } : null),
    getDefault: () => ({ id: 's1', name: 'Core', objective: 'Grow steadily', status: 'active' }),
    forAccount: () => ({ strategy: { id: 's1', name: 'Core', objective: 'Grow steadily', status: 'active' }, inherited: true }),
    accountsUsing: () => [{ id: 'a1', name: 'Brokerage', strategyId: null }],
    missingTopics: () => [],
    evaluate: () => ({ status: 'drift', headline: 'One sleeve is out of band.', counts: { drifted: 1, breaches: 0, needsJudgment: 0 },
        total: 4100, cash: 500,
        targets: [{ label: 'Equities', tickers: ['AAPL'], targetPct: 60, minPct: 55, maxPct: 65, actualPct: 40, value: 1500, status: 'under', deltaValue: 800, driftPct: -20 }],
        rules: [{ kind: 'min_cash', text: 'Keep 5% cash', label: 'Keep 5% cash', status: 'ok', detail: '12% held' }],
        unclassified: null, unpriced: [] }),
};
w.PortfolioNews = {
    async headlines(opts) { record('headlines:' + JSON.stringify(opts)); return { tickers: ['AAPL'], items: [{ ticker: 'AAPL', title: 'Apple ships', url: 'https://x/1', source: 'Reuters', publishedAt: 5 }] }; },
};

w.StorageManager = { get: () => summaries, set: (k, v) => { summaries = v; } };

w.eval(viewsSource + '\nwindow.subject = MobileViews;');
const views = w.subject;

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ok   ' + name); }
    catch (e) { failures++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The digests are built inside the JSDOM realm, so their arrays and objects
// carry that realm's prototypes and `deepEqual` calls them unequal. Compare
// the values, which is what a phone receives anyway — JSON over a socket.
const plain = (v) => JSON.parse(JSON.stringify(v));

(async () => {
    console.log('\nPortfolio');
    const all = await views._portfolio();

    await check('the ask IS a render — stale quotes refresh before a number is read', () => {
        assert.ok(calls.includes('loadData') && calls.includes('autoRefreshPrices'));
    });
    await check('pricesAsOf is the NEWEST quote behind these holdings', () => {
        assert.equal(all.pricesAsOf, 2000);
    });
    await check('hideValues never travels — the phone keeps its own', () => {
        assert.ok(!JSON.stringify(all).includes('hideValues'));
        assert.equal(all.totalValue, 4100, 'and the real number is sent');
    });
    await check('holdings carry the desktop table\'s columns, weight against the scope', () => {
        const aapl = all.holdings.find((h) => h.ticker === 'AAPL');
        assert.equal(aapl.value, 1500);
        assert.equal(aapl.avgCost, 100);
        // denominator = holdings (3600) + cash (500) = 4100
        assert.ok(Math.abs(aapl.weight - (1500 / 4100 * 100)) < 0.01);
    });
    await check('the nav travels with every answer', () => {
        assert.equal(all.accounts.length, 1);
        assert.equal(all.accounts[0].typeLabel, 'Brokerage');
        assert.deepEqual(plain(all.tickersNav), { held: 2, watching: 1 });
    });
    await check('the composition bar drops empty classes', () => {
        assert.deepEqual(plain(all.composition).map((c) => c.key), ['stocks', 'cash']);
    });
    await check('the daily brief is a PURE read — opening the page runs no model', () => {
        assert.equal(all.brief.text, 'The market rose.');
        assert.ok(!calls.includes('brief.ensure'), 'ensure() is an action, never a side effect of looking');
    });

    const scoped = await views._portfolio({ accountId: 'a1' });
    await check('an account scope drops the all-scope-only sections', () => {
        assert.ok(scoped.account, 'and names the account');
        for (const key of ['properties', 'liabilities', 'watchlist', 'brief']) {
            assert.equal(scoped[key], undefined, `${key} belongs to All accounts`);
        }
    });
    await check('an account that no longer exists falls back to All, like setScope', async () => {
        const gone = await views._portfolio({ accountId: 'nope' });
        assert.equal(gone.scope, 'all');
        assert.ok(gone.watchlist, 'so the All sections come back');
    });

    const tickers = await views._portfolioTickers();
    await check('the verdict SPEC ships with the rows, so columns cannot drift', () => {
        assert.deepEqual(plain(tickers.specs).map((s) => s.key), ['valuation', 'ai']);
        assert.equal(tickers.specs[0].defaultDir, 'asc', 'first click sorts best-first');
        assert.equal(tickers.specs[1].categorical, true);
    });
    await check('a watch-only row carries no position', () => {
        const nvda = tickers.rows.find((r) => r.ticker === 'NVDA');
        assert.equal(nvda.held, false);
        assert.equal(nvda.value, null);
        assert.equal(nvda.dayPct, 1, 'its day move comes from the quote');
    });

    const ticker = await views._portfolioTicker({ ticker: 'AAPL', range: '3m' });
    await check('the ticker page fetches what the desktop page fetches', () => {
        assert.ok(calls.includes('fetchCompanyInfo'));
        assert.ok(calls.includes('getMarketHistory:3m'));
        assert.equal(ticker.marketHistory.length, 1);
    });
    await check('its profile is a read, and its decisions come with it', () => {
        assert.equal(ticker.profile.verdicts.valuation, 'Fair');
        assert.deepEqual(plain(ticker.decisions), ['I hold this for the long term']);
        assert.ok(!calls.includes('profile.ensure'));
    });
    await check('an unknown range falls back rather than asking Yahoo for nonsense', async () => {
        await views._portfolioTicker({ ticker: 'AAPL', range: 'lol' });
        assert.ok(calls.includes('getMarketHistory:1y'));
    });

    const plans = await views._portfolioStrategy();
    await check('a plan carries evaluate()\'s arithmetic, nothing model-written', () => {
        const r = plans.strategies[0].report;
        assert.equal(r.status, 'drift');
        assert.equal(r.targets[0].deltaValue, 800);
        assert.equal(r.rules[0].status, 'ok');
    });
    await check('one plan in full adds its followers and change log', async () => {
        const one = await views._portfolioStrategy({ strategyId: 's1' });
        assert.equal(one.strategy.followers.length, 1);
        assert.equal(one.strategy.history.length, 1);
    });

    console.log('\nPortfolio writes');
    await check('watch and unwatch go through the desktop\'s own writers', async () => {
        await views._portfolioAction({ action: 'watch', ticker: 'NVDA' });
        assert.ok(calls.includes('addToWatchlist:NVDA'));
        await views._portfolioAction({ action: 'unwatch', ticker: 'NVDA' });
        assert.ok(calls.includes('removeFromWatchlist:NVDA'));
    });
    await check('an option cannot be watched, as on the Mac', async () => {
        await assert.rejects(() => views._portfolioAction({ action: 'watch', ticker: 'AAPL250C' }), /Options/);
    });
    await check('writing a brief STARTS the run and says so — it outlives the window', async () => {
        const out = await views._portfolioAction({ action: 'write-brief' });
        assert.equal(out.started, true);
        assert.ok(calls.includes('brief.ensure'));
    });
    await check('an unknown action is refused', async () => {
        await assert.rejects(() => views._portfolioAction({ action: 'drop-everything' }), /unknown action/);
    });

    console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})();
