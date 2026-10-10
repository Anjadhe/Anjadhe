// The phone builds Portfolio itself when the Mac is away
// (ios-engine/.../AnjadheCore/PortfolioLogic.swift, docs/MOBILE_NATIVE.md
// "M5" phase 3). Like tests/task-list-parity-test.js: this runs the DESKTOP's
// real code — PortfolioApp (computeHoldings, getSummary, …), PortfolioStrategy
// and MobileViews' portfolio family — on a fixture with a frozen clock and a
// fixed quote cache, and pins the output in a golden file that the Swift
// PortfolioParityTests hold the phone's port to. News on holdings, the
// Tickers page, the Watchlist, profiles and the brief left Finance
// 2026-10-09 (docs/COACH.md §7), so their halves left this test; the
// fixture still carries a stored `watchlist` to prove nothing reads it.
// Re-run with --update when a desktop rule changes on purpose, then make
// the Swift side match.
process.env.TZ = 'UTC';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const R = path.join(__dirname, '..') + '/';
const FIX = R + 'ios-engine/Anjadhe/Tests/AnjadheCoreTests/Fixtures/';
const fx = JSON.parse(fs.readFileSync(FIX + 'portfolio-parity.input.json', 'utf8'));

// A frozen clock: `new Date()` and Date.now() are fx.nowMs; everything else
// behaves as Date.
const RealDate = Date;
class FrozenDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(fx.nowMs); }
    static now() { return fx.nowMs; }
}
globalThis.Date = FrozenDate;

const noop = () => {};
const clone = (v) => JSON.parse(JSON.stringify(v));
const mem = { portfolio: clone(fx.portfolio), 'portfolio-history': clone(fx.history) };
const local = { 'portfolio-price-cache': JSON.stringify(fx.quotes) };
Object.assign(globalThis, {
    window: globalThis,
    document: { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null, addEventListener: noop, createElement: () => ({ style: {}, classList: { add: noop } }) },
    localStorage: { getItem: (k) => (k in local ? local[k] : null), setItem: (k, v) => { local[k] = String(v); }, removeItem: (k) => { delete local[k]; } },
    StorageManager: { get: (k) => (k in mem ? clone(mem[k]) : null), set: (k, v) => { mem[k] = clone(v); } },
    AppManager: { register: noop, escapeHtml: (s) => String(s) },
    UIUtils: { escapeHtml: (s) => String(s), showToast: noop },
    FEATURES: { isEnabled: () => false },
});
const load = (f) => (0, eval)(fs.readFileSync(R + f, 'utf8').replace(/^const (\w+) =/m, 'globalThis.$1 ='));
load('js/apps/portfolio/portfolio-prices.js');
load('js/apps/portfolio/portfolio-app.js');
load('js/apps/portfolio/portfolio-ui.js');
load('js/apps/portfolio/portfolio-strategy.js');
load('js/agent/mobile-views.js');

PortfolioApp.autoRefreshPrices = async () => {};
PortfolioApp.fetchCompanyInfo = async () => {};
PortfolioApp.companyInfoCache = clone(fx.companyInfo);
PriceFetcher.fetchPriceHistory = async (t, range) => (t === 'AAPL' && range === '1y' ? clone(fx.marketHistory) : null);
// loadData() re-reads localStorage and would drop the stubbed company cache
// only if it assigned it — it does not; keep a guard anyway.
const origLoad = PortfolioApp.loadData.bind(PortfolioApp);
PortfolioApp.loadData = function () { origLoad(); };

(async () => {
    const strip = (v) => { const o = clone(v); delete o.at; return o; };
    const run = async (fn, p) => { try { return strip(await fn.call(MobileViews, p)); } catch (e) { return { error: String(e.message || e) }; } };
    const out = { portfolio: {}, ticker: {}, strategy: {} };
    for (const id of ['', 'acc-a', 'acc-b', 'acc-c', 'acc-d', 'nope']) out.portfolio[id || 'all'] = await run(MobileViews._portfolio, id ? { accountId: id } : {});
    for (const [t, range] of [['AAPL', '1y'], ['AAPL', '5y'], ['NVDA270115C00150000', '1y'], ['GOOG', '1y'], ['BRK.B', '1y'], ['VTI', 'max'], ['ZZZ', '1y'], ['aapl', 'bogus']]) {
        out.ticker[t + '|' + range] = await run(MobileViews._portfolioTicker, { ticker: t, range });
    }
    for (const id of ['', 'strat-1', 'strat-2', 'gone']) out.strategy[id || 'list'] = await run(MobileViews._portfolioStrategy, id ? { strategyId: id } : {});

    globalThis.Date = RealDate;
    const goldenPath = FIX + 'portfolio-parity.golden.json';
    if (process.argv.includes('--update')) {
        fs.writeFileSync(goldenPath, JSON.stringify(out, null, 1) + '\n');
        console.log('portfolio-parity-test: golden updated');
        return;
    }
    assert.deepStrictEqual(out, JSON.parse(fs.readFileSync(goldenPath, 'utf8')),
        'the desktop Portfolio views changed — run with --update, then make PortfolioLogic.swift match');
    const n = Object.values(out).reduce((s, v) => s + Object.keys(v).length, 0);
    console.log('portfolio-parity-test: ok (' + n + ' views)');
})().catch((e) => { console.error(e.stack || e.message || e); process.exit(1); });
