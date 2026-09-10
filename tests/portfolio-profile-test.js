#!/usr/bin/env node
/**
 * PortfolioProfile.factSheet — the lines the model is allowed to cite in a
 * ticker's daily business profile (js/apps/portfolio/portfolio-profile.js).
 * Pure over a Yahoo quoteSummary result, so it runs standalone:
 *
 *   node tests/portfolio-profile-test.js
 */

const PortfolioProfile = require('../js/apps/portfolio/portfolio-profile.js');

let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
const n = (raw, fmt) => ({ raw, fmt: fmt != null ? fmt : String(raw) });

// An equity, the way Yahoo returns it (numbers as {raw, fmt}).
const equity = {
    quoteType: { quoteType: 'EQUITY', longName: 'Example Systems, Inc.' },
    price: { regularMarketPrice: n(123.45, '123.45'), marketCap: n(2.5e12, '2.5T'), currency: 'USD', exchangeName: 'NasdaqGS', regularMarketChangePercent: n(0.0123, '1.23%') },
    assetProfile: { sector: 'Technology', industry: 'Semiconductors', country: 'United States', fullTimeEmployees: 29600,
        longBusinessSummary: 'Example Systems designs accelerators.', website: 'https://example.com',
        companyOfficers: [{ name: 'Pat Lee', title: 'Chief Executive Officer' }, { name: 'Sam Roe', title: 'CFO' }] },
    summaryDetail: { trailingPE: n(45.2, '45.20'), forwardPE: n(30.1, '30.10'), dividendYield: n(0.0003, '0.03%'), beta: n(1.7, '1.70'),
        fiftyTwoWeekLow: n(80, '80.00'), fiftyTwoWeekHigh: n(140, '140.00') },
    defaultKeyStatistics: { pegRatio: n(1.1, '1.10'), priceToBook: n(40, '40.00'), enterpriseToEbitda: n(38, '38.00'), '52WeekChange': n(0.45, '45.00%') },
    financialData: { totalRevenue: n(1.3e11, '130B'), revenueGrowth: n(0.62, '62.00%'), grossMargins: n(0.75, '75.00%'), totalCash: n(4e10, '40B'), totalDebt: n(1e10, '10B'),
        freeCashflow: n(6e10, '60B'), recommendationKey: 'buy', numberOfAnalystOpinions: n(52, '52'), targetMeanPrice: n(150, '150.00') }
};
const headlines = [
    { title: 'Example beats on revenue', source: 'Reuters', publishedAt: Date.parse('2026-09-02T12:00:00Z') },
    { title: 'Example unveils new chip', source: 'The Verge', publishedAt: Date.parse('2026-09-01T12:00:00Z') }
];
const eq = PortfolioProfile.factSheet(equity, { ticker: 'EXMP', today: '2026-09-03', headlines, ago: () => '1d ago' });

check('equity is not a fund', eq.fund === false && eq.type === 'EQUITY');
check('name comes from quoteType.longName', eq.name === 'Example Systems, Inc.');
check('header lines', /^Symbol: EXMP\nName: Example Systems, Inc\.\nDate: 2026-09-03/.test(eq.text));
check('formatted numbers are used, not raw', eq.text.includes('- Market cap: 2.5T') && eq.text.includes('- Trailing P/E: 45.20'));
check('CEO picked from officers by title', eq.text.includes('- CEO: Pat Lee') && !eq.text.includes('Sam Roe'));
check('plain numbers pass through', eq.text.includes('- Employees: 29600'));
check('valuation, health and analyst sections present', ['Valuation:', 'Business health', 'Analysts:'].every(h => eq.text.includes(h)));
check('cash vs debt on the sheet', eq.text.includes('- Cash: 40B') && eq.text.includes('- Debt: 10B'));
check('description clipped in', eq.text.includes('Description (Yahoo Finance):\nExample Systems designs accelerators.'));
check('headlines listed with source and age', eq.text.includes('- Example beats on revenue — Reuters (1d ago)') && eq.text.includes('- Example unveils new chip — The Verge (1d ago)'));
check('no fund sections on an equity', !eq.text.includes('Top holdings') && !eq.text.includes('Expense ratio'));

// Missing modules leave no line behind (the prompt says "not on the sheet").
const thin = PortfolioProfile.factSheet({ quoteType: { quoteType: 'EQUITY', shortName: 'Thin Co' }, price: { regularMarketPrice: n(10, '10.00') } }, { ticker: 'THIN', today: '2026-09-03' });
check('thin summary: name from shortName', thin.name === 'Thin Co');
check('thin summary: no invented lines', !thin.text.includes('P/E') && !thin.text.includes('Revenue') && thin.text.includes('- Price: 10.00'));
check('thin summary: no headline section', !thin.text.includes('Recent headlines'));
check('null summary still yields a sheet', PortfolioProfile.factSheet(null, { ticker: 'X', today: '2026-09-03' }).text.startsWith('Symbol: X'));

// A fund: holdings, sector weights (raw fractions → percent), expense ratio.
const fund = {
    quoteType: { quoteType: 'ETF', longName: 'Example Total Market ETF' },
    price: { regularMarketPrice: n(300, '300.00'), currency: 'USD' },
    fundProfile: { family: 'Example Funds', categoryName: 'Large Blend', legalType: 'Exchange Traded Fund', feesExpensesInvestment: { annualReportExpenseRatio: n(0.0003, '0.03%') } },
    summaryDetail: { totalAssets: n(4e11, '400B'), yield: n(0.012, '1.20%') },
    defaultKeyStatistics: { fundInceptionDate: n(1000000000, '2001-09-09') },
    topHoldings: {
        holdings: [{ symbol: 'AAA', holdingName: 'Alpha Corp', holdingPercent: n(0.0712) }, { symbol: 'BBB', holdingName: 'Beta Inc', holdingPercent: n(0.0501) }],
        sectorWeightings: [{ technology: n(0.31) }, { realestate: n(0.002) }, { financial_services: n(0.12) }],
        equityHoldings: { priceToEarnings: n(24.5, '24.50'), priceToBook: n(4.1, '4.10') }
    }
};
const fs = PortfolioProfile.factSheet(fund, { ticker: 'EXTM', today: '2026-09-03' });
check('fund detected', fs.fund === true);
check('fund facts', fs.text.includes('- Type: ETF (fund)') && fs.text.includes('- Expense ratio: 0.03%') && fs.text.includes('- Inception: 2001-09-09'));
check('top holdings with percent', fs.text.includes('- Alpha Corp (AAA) 7.1%') && fs.text.includes('- Beta Inc (BBB) 5.0%'));
check('sector weights sorted, tiny ones dropped, underscores spaced', /Sector weights:\n- technology: 31\.0%\n- financial services: 12\.0%/.test(fs.text) && !fs.text.includes('realestate'));
check('holdings valuation block', fs.text.includes('Valuation of the holdings:') && fs.text.includes('- Price to earnings: 24.50'));
check('no equity valuation on a fund', !fs.text.includes('Trailing P/E') && !fs.text.includes('Analysts:'));

// The calendar day is local, the once-a-day unit.
check('today() is local YYYY-MM-DD', PortfolioProfile.today(new Date(2026, 8, 3, 23, 30)) === '2026-09-03');
check('isToday compares the day only', PortfolioProfile.isToday({ day: PortfolioProfile.today() }) && !PortfolioProfile.isToday({ day: '2026-01-01' }) && !PortfolioProfile.isToday(null));

// The owner's corrections: the block handed to the model after the sheet.
const notes = [
    { title: 'Largest customer', body: 'Their largest customer is Acme, not Globex.' },
    { title: 'Framing', body: 'I hold this for income; judge it that way.' },
    { title: 'Same as body', body: 'Same as body' },
    { title: 'Empty', body: '   ' }
];
const block = PortfolioProfile.ownerNotesBlock(notes);
check('notes block header', block.startsWith("OWNER'S CORRECTIONS AND NOTES"));
check('title: body lines, in order', block.includes('- Largest customer: Their largest customer is Acme, not Globex.\n- Framing: I hold this for income; judge it that way.'));
check('title equal to body is not doubled', block.includes('\n- Same as body') && !block.includes('Same as body: Same as body'));
check('blank note dropped', !block.includes('Empty'));
check('no notes → empty string', PortfolioProfile.ownerNotesBlock([]) === '' && PortfolioProfile.ownerNotesBlock(null) === '');
check('long note clipped', PortfolioProfile.ownerNotesBlock([{ title: 'T', body: 'x'.repeat(500) }]).endsWith('…'));
check('cap on count', PortfolioProfile.ownerNotesBlock(Array.from({ length: 20 }, (_, i) => ({ title: 'N' + i, body: 'b' + i }))).split('\n').length === 13);

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall portfolio-profile checks passed');
