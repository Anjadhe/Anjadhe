'use strict';
/**
 * CNBC headlines for Portfolio's "Current headlines" section (2026-09-22).
 *
 * What CNBC is running right now, read from its own public RSS feeds (top
 * news, markets, investing, economy, earnings); a ticker page gets the feed
 * rows that name the symbol or company. Main fetches; the renderer's
 * PortfolioHeadlines hands the rows to the user's model and shows the
 * summary it writes.
 *
 * Laws:
 *  - READ, never scraped into storage: nothing here is written to disk;
 *    the renderer caches the finished section machine-locally.
 *  - PUBLISHED FEEDS ONLY (2026-10-08). CNBC's site search (a private
 *    Queryly endpoint, called with a key lifted from cnbc.com's JavaScript)
 *    was removed: it is not an interface CNBC offers, and nenva is a
 *    product, not a reader's own script. Don't bring it, or any other
 *    undocumented endpoint, back.
 *  - NOTHING PERSONAL IN A URL. The section feeds carry no query at all.
 *    The fetch sends no cookies.
 *  - A FAILED SOURCE IS NOT A FAILED SECTION. Each feed is
 *    fetched independently; whatever came back is merged, deduped by URL
 *    and ordered newest first. Only "nothing came back at all" is an error.
 *
 * The parsers are pure and pinned by tests/portfolio-headlines-test.js.
 */

const TIMEOUT_MS = 12000;
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;   // "current": the last three days
const MAX_ITEMS = 40;
const MAX_SYMBOL_ITEMS = 12;

// CNBC's section feeds (https://www.cnbc.com/rss-feeds/). Ids are CNBC's.
const FEEDS = [
    { id: '100003114', section: 'Top News' },
    { id: '20409666', section: 'Markets' },
    { id: '15839069', section: 'Investing' },
    { id: '20910258', section: 'Economy' },
    { id: '15839135', section: 'Earnings' }
];
const feedUrl = (id) => `https://www.cnbc.com/id/${id}/device/rss/rss.html`;

const HEADERS = {
    'Accept': 'application/rss+xml, application/xml, text/xml',
    'User-Agent': 'nenva (+https://nenva.co)'
};

/** A ticker as the search accepts it: letters, digits, dot, dash. */
function normalizeSymbol(s) {
    const t = String(s || '').trim().toUpperCase();
    return /^[A-Z0-9.\-]{1,12}$/.test(t) ? t : null;
}

function decode(s) {
    return String(s || '')
        .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
        .replace(/<[^>]+>/g, '')
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

const isCnbcUrl = (u) => { try { return /(^|\.)cnbc\.com$/i.test(new URL(u).hostname) && /^https:/i.test(u); } catch { return false; } };

/** One CNBC section feed → [{title, url, summary, publishedAt, section}]. */
function parseRss(xml, section = '') {
    const out = [];
    const blocks = String(xml || '').split(/<item(?:\s[^>]*)?>/).slice(1);
    for (const b of blocks) {
        const end = b.indexOf('</item>');
        const block = end === -1 ? b : b.slice(0, end);
        const tag = (name) => {
            const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
            return m ? decode(m[1]) : '';
        };
        const title = tag('title');
        const url = tag('link');
        if (!title || !isCnbcUrl(url)) continue;
        // Sponsored rows are advertising, not news.
        if (/<metadata:sponsored>\s*true\s*</i.test(block)) continue;
        const ts = Date.parse(tag('pubDate'));
        out.push({
            title: title.slice(0, 300),
            url: url.slice(0, 1000),
            summary: tag('description').slice(0, 400),
            publishedAt: Number.isFinite(ts) ? new Date(ts).toISOString() : null,
            section
        });
    }
    return out;
}

/**
 * Merge lists: one row per URL (the first list that has it wins, so a
 * story keeps its section), dated rows within MAX_AGE_MS only, newest
 * first, capped.
 */
function mergeItems(lists, { now = Date.now(), max = MAX_ITEMS } = {}) {
    const seen = new Set();
    const out = [];
    for (const list of lists) {
        for (const it of (Array.isArray(list) ? list : [])) {
            const key = String(it.url || '').replace(/[?#].*$/, '').toLowerCase();
            if (!key || seen.has(key)) continue;
            const ts = Date.parse(it.publishedAt || '');
            if (!Number.isFinite(ts) || now - ts > MAX_AGE_MS || ts - now > 60 * 60 * 1000) continue;
            seen.add(key);
            out.push(it);
        }
    }
    return out.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, max);
}

/**
 * Rows that actually name the symbol or the company. The symbol matches CASE-SENSITIVELY (a ticker like ON or IT is
 * also an English word) and only from two letters up; company names match
 * case-insensitively on word boundaries.
 */
function mentioning(items, symbol, names = []) {
    const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const bound = (alts, flags) => new RegExp(`(^|[^A-Za-z0-9])(${alts.map(esc).join('|')})([^A-Za-z0-9]|$)`, flags);
    const sym = String(symbol || '').trim();
    const nameWords = names.map(w => String(w || '').trim()).filter(w => w.length >= 3);
    const symRx = sym.length >= 2 ? bound([sym], '') : null;
    const nameRx = nameWords.length ? bound(nameWords, 'i') : null;
    if (!symRx && !nameRx) return [];
    return (items || []).filter(it => {
        const text = `${it.title} ${it.summary || ''}`;
        return (symRx && symRx.test(text)) || (nameRx && nameRx.test(text));
    });
}

async function _get(url, fetchImpl) {
    const res = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`CNBC HTTP ${res.status}`);
    return res.text();
}

/**
 * The market's headlines, and — given a symbol — the ones that name it.
 * Resolves { items, symbolItems, fetchedAt } or { error }.
 */
async function fetchHeadlines({ symbol = null, names = [], fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
    const sym = symbol ? normalizeSymbol(symbol) : null;
    const feedJobs = FEEDS.map(f => _get(feedUrl(f.id), fetchImpl).then(x => parseRss(x, f.section)).catch(() => null));
    const good = (await Promise.all(feedJobs)).filter(Array.isArray);
    if (!good.length) return { error: 'CNBC could not be reached right now.' };
    const items = mergeItems(good, { now });
    // Ticker stories come from the full feed rows, before the market cap.
    const symbolItems = sym ? mergeItems([mentioning(good.flat(), sym, names)], { now, max: MAX_SYMBOL_ITEMS }) : [];
    return { items, symbolItems, fetchedAt: new Date(now).toISOString() };
}

module.exports = { FEEDS, MAX_AGE_MS, normalizeSymbol, parseRss, mergeItems, mentioning, fetchHeadlines };
