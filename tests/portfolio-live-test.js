#!/usr/bin/env node
/**
 * Live prices (2026-09-29): Robinhood's quote parser and symbol rules in
 * js/main/robinhood-quotes.js, and PortfolioLive's pure pieces — the US
 * market clock, which symbols may be asked, and the cache merge. No
 * network:
 *
 *   node tests/portfolio-live-test.js
 */

const RH = require('../js/main/robinhood-quotes.js');
const PortfolioLive = require('../js/apps/portfolio/portfolio-live.js');

let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ---------- symbols ---------- */

check('US symbols and share classes pass', JSON.stringify(RH.normalizeSymbols(['aapl', 'BRK.B', 'SPY', 'AAPL'])) === '["AAPL","BRK.B","SPY"]');
check('Yahoo spellings and non-US listings are dropped',
    RH.normalizeSymbols(['BRK-B', 'RELIANCE.NS', 'SHOP.TO', 'BP.L', 'SAP.F', '^GSPC', 'BTC-USD', 'AAPL261218C00250000']).length === 0);
check('renderer and main agree on the symbol rule', String(RH.SYMBOL_RX) === String(PortfolioLive.SYMBOL_RX));

/* ---------- parse ---------- */

const body = JSON.stringify({ results: [
    { symbol: 'AAPL', last_trade_price: '331.890000', previous_close: '338.400000', adjusted_previous_close: '338.400000',
      venue_last_trade_time: '2026-09-29T15:33:03.976236289Z', trading_halted: false },
    null,
    { symbol: 'SPY', last_trade_price: '763.280000', previous_close: '765.610000', venue_last_trade_time: '2026-09-29T15:33:04Z' },
    { symbol: 'ZZZZ', last_trade_price: null, previous_close: '1.00' },
    { symbol: 'MSFT', last_trade_price: '400.00', previous_close: '390.00' }
] });
const q = RH.parseQuotes(body, ['AAPL', 'VTSAX', 'SPY', 'ZZZZ']);
check('parses the quoted symbols', Object.keys(q).join(',') === 'AAPL,SPY', Object.keys(q).join(','));
check('price is the last trade', q.AAPL.price === 331.89);
check('change is against the previous close', Math.abs(q.AAPL.change - (331.89 - 338.4)) < 1e-9);
check('change percent', Math.abs(q.AAPL.changePercent - ((331.89 - 338.4) / 338.4) * 100) < 1e-9);
check('trade time is kept', q.SPY.tradeAt === Date.parse('2026-09-29T15:33:04Z'));
check('a null slot and a symbol we did not ask for are left out', !('VTSAX' in q) && !('MSFT' in q));
check('a single-quote body parses too', RH.parseQuotes({ symbol: 'AAPL', last_trade_price: '1', previous_close: '1' }).AAPL.price === 1);
check('garbage parses to nothing', Object.keys(RH.parseQuotes('<html>')).length === 0);

/* ---------- market clock (New York, not the user's zone) ---------- */

const at = (iso) => new Date(iso);
check('Tue 9:29 ET is closed', PortfolioLive.usSession(at('2026-09-29T13:29:00Z')) === 'closed');
check('Tue 9:30 ET is regular', PortfolioLive.usSession(at('2026-09-29T13:30:00Z')) === 'regular');
check('Tue 15:59 ET is regular', PortfolioLive.usSession(at('2026-09-29T19:59:00Z')) === 'regular');
check('Tue 16:00 ET is closed', PortfolioLive.usSession(at('2026-09-29T20:00:00Z')) === 'closed');
check('Saturday midday is closed', PortfolioLive.usSession(at('2026-10-03T16:00:00Z')) === 'closed');
check('winter (EST) 9:30 is regular', PortfolioLive.usSession(at('2026-12-15T14:30:00Z')) === 'regular');
check('winter (EST) 9:29 is closed', PortfolioLive.usSession(at('2026-12-15T14:29:00Z')) === 'closed');

/* ---------- eligibility ---------- */

const misses = new Set(['VTSAX']);
const isOption = (t) => t === 'AAPL261218C00250000';
check('a US stock may be asked', PortfolioLive.eligible('AAPL', { isOption, misses }));
check('a remembered miss is not asked again', !PortfolioLive.eligible('VTSAX', { isOption, misses }));
check('an option is never asked', !PortfolioLive.eligible('AAPL261218C00250000', { isOption, misses }));
check('a non-US listing is never asked', !PortfolioLive.eligible('SHOP.TO', { isOption, misses }));

/* ---------- merge ---------- */

const NOW = Date.parse('2026-09-29T15:33:10Z');
const cache = {
    AAPL: { price: 330, change: 0, changePercent: 0, updatedAt: NOW - 20000, after: { session: 'pre', price: 329 } },
    VTSAX: { price: 140, change: 0.5, changePercent: 0.3, updatedAt: NOW - 100000 }
};
const m = PortfolioLive.merge(cache, q, NOW);
check('merged entry is marked live-sourced', m.cache.AAPL.source === 'robinhood' && m.cache.AAPL.updatedAt === NOW);
check('a pre-market sub-quote does not survive into the session', !('after' in m.cache.AAPL));
check('symbols it did not quote are untouched', m.cache.VTSAX === cache.VTSAX);
check('the input cache is not mutated', cache.AAPL.price === 330);
check('a move up is reported', m.moved.length === 1 && m.moved[0].ticker === 'AAPL' && m.moved[0].dir === 'up');
check('a first quote is not a move', !m.moved.some(x => x.ticker === 'SPY'));
check('newest trade time is reported', m.newestTrade === Date.parse('2026-09-29T15:33:04Z'));
check('isLive: fresh robinhood entry', PortfolioLive.isLive(m.cache.AAPL, NOW + 30000));
check('isLive: a minute later it is not', !PortfolioLive.isLive(m.cache.AAPL, NOW + 61000));
check('isLive: a Yahoo entry never is', !PortfolioLive.isLive(cache.VTSAX, NOW));

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nportfolio-live: all passed');
