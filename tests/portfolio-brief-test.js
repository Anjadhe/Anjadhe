#!/usr/bin/env node
/**
 * PortfolioBrief.factSheet / changeSince — the lines the model is allowed
 * to cite in the daily market-and-portfolio brief
 * (js/apps/portfolio/portfolio-brief.js). Pure over plain data, so it runs
 * standalone:
 *
 *   node tests/portfolio-brief-test.js
 */

const PortfolioBrief = require('../js/apps/portfolio/portfolio-brief.js');

let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

const today = '2026-09-04';
const summary = {
    totalValue: 250000, totalCost: 180000, totalPL: 40000, totalPLPercent: 22.2,
    totalDayChange: -1500, totalDayChangePercent: -0.68, totalDayBase: 221500,
    cash: 30000, realEstateValue: 0, liabilitiesTotal: 0, netWorth: 250000
};
const holdings = [
    { label: 'NVDA', currentValue: 100000, currentPrice: 500, dayChange: -3000, dayChangePercent: -2.9, profitLossPercent: 80 },
    { label: 'VOO', currentValue: 80000, currentPrice: 480, dayChange: 400, dayChangePercent: 0.5, profitLossPercent: 12 },
    { label: 'AAPL', currentValue: 40000, currentPrice: 210, dayChange: 1100, dayChangePercent: 2.8, profitLossPercent: 5 },
    { label: 'OLDCO', currentValue: 0, currentPrice: 0, dayChange: 0, dayChangePercent: 0, profitLossPercent: 0 }
];
const history = [
    { date: '2026-01-02', totalValue: 200000, netWorth: 200000 },
    { date: '2026-08-05', totalValue: 240000, netWorth: 240000 },
    { date: '2026-08-28', totalValue: 245000, netWorth: 245000 },
    { date: '2026-09-03', totalValue: 251500, netWorth: 251500 }
];
const plan = {
    name: 'House plan', objective: 'Grow for retirement', horizon: '15+ years', riskLevel: 'moderate', thesis: 'Index core, a few conviction names.',
    report: {
        status: 'breach', headline: 'NVDA is 45% against a 25% cap.', empty: false,
        targets: [{ label: 'Index core', targetPct: 60, minPct: 55, maxPct: 65, actualPct: 36.4, status: 'under' }],
        unclassified: { pct: 18.2, tickers: ['AAPL'], includesCash: false },
        rules: [
            { label: 'No position over 25%', status: 'breach', detail: 'NVDA is 45% against a 25% cap.' },
            { label: 'At least 5% cash', status: 'ok', detail: 'Cash is 12%.' }
        ]
    }
};
const market = [
    { label: 'S&P 500', price: 6400.12, changePercent: -0.81 },
    { label: 'VIX (volatility index)', price: 18.4, changePercent: 9.2 }
];
const marketHeadlines = [{ title: 'Stocks slip as yields climb', source: 'Reuters', publishedAt: Date.parse('2026-09-04T20:00:00Z') }];
const holdingHeadlines = [{ ticker: 'NVDA', title: 'Nvidia falls after export ruling', source: 'Bloomberg', publishedAt: Date.parse('2026-09-04T18:00:00Z') }];

const sheet = PortfolioBrief.factSheet({
    today, summary, holdings, history, plan, market, marketHeadlines, holdingHeadlines,
    accounts: [{ name: 'Brokerage', type: 'taxable', value: 170000, cash: 30000, plan: null }, { name: 'Roth', type: 'ira', value: 80000, cash: 0, plan: 'Roth plan' }],
    accountPlans: [{ account: 'Roth', name: 'Roth plan', status: 'on-track', headline: 'Holdings match the plan.' }],
    ago: () => '2h ago'
});
const t = sheet.text;

check('date line leads', t.startsWith('Date: 2026-09-04'));
check('market quotes with change', t.includes('- S&P 500: 6,400.12 (-0.8%)') && t.includes('VIX (volatility index): 18.4 (+9.2%)'));
check('headline is total value without debt', t.includes('- Total value: $250,000') && !t.includes('Net worth'));
check('investments = total − cash − real estate', t.includes('- Investments (stocks, funds, options): $220,000'));
check('today\'s change signed with percent', t.includes('- Today\'s change in investments: -$1,500 (-0.7%)'));
check('all-time gain against cost', t.includes('- All-time gain on investments (against cost): +$40,000 (+22.2%)'));
check('position count includes unpriced', t.includes('- Positions: 4'));

// Since-lines: a week ago (Aug 28, 7 days) and a month ago (Aug 5, 30 days)
// are in the history; the start of the year snapshot is Jan 2 (inside the
// 10-day slack from Jan 1). Yesterday's snapshot is not a "week ago".
check('week-ago change from the Aug 28 snapshot', t.includes('- One week ago (2026-08-28): +$5,000 (+2.0%) from $245,000'));
check('month-ago change from the Aug 5 snapshot', t.includes('- One month ago (2026-08-05): +$10,000 (+4.2%) from $240,000'));
check('year-to-date from the Jan 2 snapshot', t.includes('- Start of the year (2026-01-02): +$50,000 (+25.0%) from $200,000'));

check('largest positions carry weight of investments', t.includes('- NVDA: $100,000, 45.5% of investments, today -2.9%, all-time +80.0%'));
check('concentration line', t.includes('- Concentration: largest position 45.5% of investments; top five 100.0%'));
check('movers: up and down over the threshold, VOO (0.5%) left out', t.includes('- Up: AAPL +2.8% (+$1,100)') && t.includes('- Down: NVDA -2.9% (-$3,000)') && !t.includes('Up: VOO'));
check('unpriced positions named', t.includes('- Positions without a price today: OLDCO'));
check('accounts with cash and own plan', t.includes('- Brokerage (taxable): $170,000, of which cash $30,000') && t.includes('- Roth (ira): $80,000, follows its own plan "Roth plan"'));
check('plan status and target band', t.includes('- Status (computed by the app): breach — NVDA is 45% against a 25% cap.') && t.includes('- Target "Index core": 36.4% now against 60% (band 55–65%) — under'));
check('unclassified slice', t.includes('- Not covered by any target: 18.2% (AAPL)'));
check('only broken rules listed', t.includes('- Rule "No position over 25%": breach') && !t.includes('At least 5% cash'));
check('account plans listed', t.includes('- Roth — "Roth plan": on-track — Holdings match the plan.'));
check('headlines: market first, then holdings, with age', t.indexOf('- Market: Stocks slip as yields climb — Reuters (2h ago)') < t.indexOf('- NVDA: Nvidia falls after export ruling — Bloomberg (2h ago)'));
check('summary flags', sheet.positions === 4 && sheet.hasPlan && sheet.hasMarket && sheet.headlines === 2);

// Debt flips the headline to net worth and reports both.
const debt = PortfolioBrief.factSheet({ today, summary: { ...summary, liabilitiesTotal: 100000, netWorth: 150000, realEstateValue: 400000, totalValue: 650000 }, holdings: holdings.slice(0, 1), history: [], market: [] }).text;
check('debt: net worth headline, assets, real estate and debt lines', debt.includes('- Net worth: $150,000') && debt.includes('- Total assets: $650,000') && debt.includes('- Real estate: $400,000') && debt.includes('- Debt: $100,000'));
check('no quotes → says so', debt.includes('Market quotes could not be fetched today'));
check('no plan → says so', debt.includes('The plan: none written yet'));
check('weekend note', PortfolioBrief.factSheet({ today, summary, holdings: [], weekend: true }).text.includes('(weekend — market figures are the last session\'s close)'));

// changeSince: nothing is claimed when the history does not reach back.
check('changeSince: gap wider than slack → null', PortfolioBrief.changeSince(history, { fromDate: '2026-06-01', current: 250000 }) === null);
check('changeSince: nearest earlier snapshot inside slack', PortfolioBrief.changeSince(history, { fromDate: '2026-08-30', current: 250000 })?.fromDate === '2026-08-28');
check('changeSince: zero base → null', PortfolioBrief.changeSince([{ date: '2026-08-28', totalValue: 0 }], { fromDate: '2026-08-28', current: 100 }) === null);

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nportfolio-brief: all checks passed');
