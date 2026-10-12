'use strict';
/**
 * Live US stock quotes for Portfolio (2026-09-29), from the quote endpoint
 * Robinhood's own site calls: `GET api.robinhood.com/quotes/?symbols=…`.
 * No login, no cookie, no key — verified 2026-09-29 with the market open:
 * last-trade times under a second old, 40 back-to-back calls all 200.
 *
 * What it is and is not:
 *  - US-listed stocks and ETFs ONLY. Mutual funds, indices, non-US
 *    listings and option contracts come back as `null` in their slot (or a
 *    404 for a lone symbol); those stay on Yahoo. One symbol, one stated
 *    source — this is not a fallback chain.
 *  - The same feed Yahoo's "Nasdaq Real Time Price" is: every row says
 *    `last_trade_price_source: "nls"` (Nasdaq Last Sale). Robinhood is not
 *    MORE accurate; it is cheaper to call (no crumb, no throttling seen).
 *  - Undocumented. It may start asking for a login any day, so a failure
 *    returns null and the renderer simply stays on Yahoo's 5-minute path.
 *  - Nothing personal in the URL: symbols only (the Yahoo calls already
 *    send them), a static User-Agent, no cookies. Nothing is stored here.
 *
 * `normalizeSymbols` and `parseQuotes` are pure and pinned by
 * tests/portfolio-live-test.js.
 */

const https = require('https');

const HOST = 'api.robinhood.com';
const TIMEOUT_MS = 8000;
const CHUNK = 50;            // symbols per request; keeps the URL short

// A US listing in Robinhood's spelling: 1-5 letters, optionally a share
// class letter after a DOT (BRK.B). Yahoo spells the class with a hyphen
// (BRK-B); the app stores dots, so dots are what we accept. A class suffix
// is limited to A-E so a Yahoo exchange suffix (BP.L, SAP.F, X.V, 7203.T)
// is never mistaken for a US share class.
const SYMBOL_RX = /^[A-Z]{1,5}(\.[A-E])?$/;

function normalizeSymbols(symbols) {
    const out = [];
    for (const s of Array.isArray(symbols) ? symbols : []) {
        const sym = String(s || '').trim().toUpperCase();
        if (SYMBOL_RX.test(sym) && !out.includes(sym)) out.push(sym);
    }
    return out;
}

const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
};

/**
 * Robinhood's `{results:[…]}` → `{ SYMBOL: { price, previousClose, change,
 * changePercent, tradeAt, halted } }`. A null slot, a row without a trade
 * price, or a symbol we did not ask for is left out.
 */
function parseQuotes(body, asked = null) {
    let data = body;
    if (typeof body === 'string') {
        try { data = JSON.parse(body); } catch { return {}; }
    }
    const rows = Array.isArray(data?.results) ? data.results : (data?.symbol ? [data] : []);
    const want = asked ? new Set(asked) : null;
    const out = {};
    for (const r of rows) {
        if (!r || typeof r.symbol !== 'string') continue;
        const sym = r.symbol.toUpperCase();
        if (want && !want.has(sym)) continue;
        const price = num(r.last_trade_price);
        if (!(price > 0)) continue;
        const prev = num(r.adjusted_previous_close) ?? num(r.previous_close);
        const change = prev > 0 ? price - prev : 0;
        const tradeAt = Date.parse(r.venue_last_trade_time || r.updated_at || '') || null;
        out[sym] = {
            price,
            previousClose: prev > 0 ? prev : null,
            change,
            changePercent: prev > 0 ? (change / prev) * 100 : 0,
            tradeAt,
            halted: r.trading_halted === true
        };
    }
    return out;
}

function get(path) {
    return new Promise((resolve, reject) => {
        const req = https.get({
            hostname: HOST,
            path,
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', Accept: 'application/json' }
        }, (res) => {
            res.setEncoding('utf8');
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.setTimeout(TIMEOUT_MS, () => { req.destroy(); reject(new Error('timeout')); });
    });
}

/**
 * Quotes for `symbols` (anything not US-shaped is dropped first). Returns
 * the parsed map, `{}` when nothing was quotable, or null when Robinhood
 * could not be reached or refused every request.
 */
async function fetchQuotes(symbols) {
    const list = normalizeSymbols(symbols);
    if (!list.length) return {};
    const chunks = [];
    for (let i = 0; i < list.length; i += CHUNK) chunks.push(list.slice(i, i + CHUNK));
    const results = await Promise.all(chunks.map(async (chunk) => {
        try {
            const res = await get(`/quotes/?symbols=${encodeURIComponent(chunk.join(','))}`);
            // A lone unknown symbol is a 404; that is an answer ("not here"),
            // not an outage.
            if (res.statusCode === 404) return {};
            if (res.statusCode !== 200) return null;
            return parseQuotes(res.body, chunk);
        } catch {
            return null;
        }
    }));
    if (results.every(r => r === null)) return null;
    return Object.assign({}, ...results.filter(Boolean));
}

module.exports = { SYMBOL_RX, normalizeSymbols, parseQuotes, fetchQuotes };
