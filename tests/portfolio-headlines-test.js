#!/usr/bin/env node
/**
 * Portfolio's "Current headlines" (2026-09-22): the CNBC parsers and merge
 * in js/main/cnbc-headlines.js, and PortfolioHeadlines' pure pieces — the
 * headline sheet the model may cite, the list signature that decides
 * whether a ten-minute tick needs a model call at all, and the clock.
 * No network:
 *
 *   node tests/portfolio-headlines-test.js
 */

const Cnbc = require('../js/main/cnbc-headlines.js');
const PortfolioHeadlines = require('../js/apps/portfolio/portfolio-headlines.js');

let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

const NOW = Date.parse('2026-09-22T19:00:00Z');

/* ---------- RSS ---------- */

const rss = `<?xml version="1.0"?><rss><channel><title>US Top News</title>
<item><link>https://www.cnbc.com/2026/09/22/oil-iran.html</link><metadata:sponsored>false</metadata:sponsored>
<title>Oil little changed after Trump&apos;s UN speech</title>
<description><![CDATA[Oil prices <b>reversed</b> early gains &amp; more.]]></description>
<pubDate>Tue, 22 Sep 2026 18:38:13 GMT</pubDate></item>
<item><link>https://www.cnbc.com/2026/09/22/ad.html</link><metadata:sponsored>true</metadata:sponsored>
<title>Sponsored: a brokerage offer</title><pubDate>Tue, 22 Sep 2026 18:00:00 GMT</pubDate></item>
<item><link>https://evil.example.com/x.html</link><title>Not CNBC</title><pubDate>Tue, 22 Sep 2026 18:00:00 GMT</pubDate></item>
<item><link>https://www.cnbc.com/2026/09/22/nvidia-options.html</link>
<title>Nvidia options are doing something unusual</title>
<pubDate>Tue, 22 Sep 2026 16:58:28 GMT</pubDate></item>
</channel></rss>`;

const rows = Cnbc.parseRss(rss, 'Top News');
check('RSS: sponsored and off-site rows are dropped', rows.length === 2, JSON.stringify(rows.map(r => r.url)));
check('RSS: entities and CDATA decode, tags strip', rows[0].title === "Oil little changed after Trump's UN speech" && rows[0].summary === 'Oil prices reversed early gains & more.', JSON.stringify(rows[0]));
check('RSS: section and ISO date carried', rows[0].section === 'Top News' && rows[0].publishedAt === '2026-09-22T18:38:13.000Z');

/* ---------- site search ---------- */

const search = Cnbc.parseSearch(JSON.stringify({ results: [
    { 'cn:title': 'AI could sway shares of Nvidia', url: 'https://www.cnbc.com/video/2026/09/22/nvda.html', 'cn:type': 'cnbcvideo', datePublished: '2026-09-22T16:55:39+0000', description: 'Clip.' },
    { 'cn:title': 'Nvidia earnings preview', url: 'https://www.cnbc.com/2026/09/21/nvda-preview.html', 'cn:type': 'cnbcnewsstory', section: 'Earnings', datePublished: '2026-09-21T12:00:00+0000' },
    { 'cn:title': 'Somewhere else', url: 'http://www.cnbc.com/insecure.html', datePublished: '2026-09-21T12:00:00+0000' }
] }));
check('search: videos labelled, sections kept, non-https dropped', search.length === 2 && search[0].section === 'Video' && search[1].section === 'Earnings', JSON.stringify(search));
check('search: garbage JSON is an empty list', Cnbc.parseSearch('<html>').length === 0);

/* ---------- merge ---------- */

const old = { title: 'Old', url: 'https://www.cnbc.com/old.html', publishedAt: '2026-09-10T00:00:00Z' };
const dup = { ...rows[0], section: 'Markets', url: rows[0].url + '?utm=x' };
const merged = Cnbc.mergeItems([rows, [dup, old]], { now: NOW });
check('merge: one row per URL, first list wins its section', merged.filter(r => r.title.startsWith('Oil')).length === 1 && merged[0].section === 'Top News');
check('merge: older than three days is not current', !merged.some(r => r.title === 'Old'));
check('merge: newest first', Date.parse(merged[0].publishedAt) >= Date.parse(merged[merged.length - 1].publishedAt));

check('symbol gate: tickers only', Cnbc.normalizeSymbol(' brk.b ') === 'BRK.B' && Cnbc.normalizeSymbol('AAPL; rm') === null);
check('fallback: section rows naming the symbol or company', Cnbc.mentioning(rows, 'NVDA', ['Nvidia']).length === 1 && Cnbc.mentioning(rows, 'AMD', []).length === 0);
const fuzzy = [
    { title: 'Final Trades: Amazon, Check Point, Micron and Apple', summary: '' },
    { title: 'Peloton is revamping its treadmills', summary: 'Connected fitness.' },
    { title: 'Stocks turn ON the charm', summary: '' },
    { title: 'Apple-picking season', summary: '' }
];
check('mentioning: a fuzzy search hit that names neither is dropped', Cnbc.mentioning(fuzzy, 'AAPL', ['Apple']).length === 2 && !Cnbc.mentioning(fuzzy, 'AAPL', ['Apple']).some(r => /Peloton/.test(r.title)));
check('mentioning: a ticker that is a word matches only in capitals', Cnbc.mentioning([{ title: 'turn on the lights' }], 'ON', []).length === 0 && Cnbc.mentioning(fuzzy, 'ON', []).length === 1);
check('mentioning: one-letter tickers never match by symbol', Cnbc.mentioning([{ title: 'A big day' }], 'A', []).length === 0);


/* ---------- fetch (injected) ---------- */

(async () => {
    const calls = [];
    const fake = async (url) => {
        calls.push(url);
        if (url.includes('queryly')) return { ok: true, text: async () => JSON.stringify({ results: [
            { 'cn:title': 'Nvidia story', url: 'https://www.cnbc.com/n.html', datePublished: '2026-09-22T18:00:00Z' },
            { 'cn:title': 'Peloton treadmills', url: 'https://www.cnbc.com/p.html', datePublished: '2026-09-22T18:10:00Z' }
        ] }) };
        if (url.includes('100003114')) return { ok: true, text: async () => rss };
        return { ok: false, status: 500, text: async () => '' };
    };
    const r = await Cnbc.fetchHeadlines({ symbol: 'nvda', names: ['Nvidia'], fetchImpl: fake, now: NOW });
    check('fetch: one failed feed does not fail the section', !r.error && r.items.length === 2, JSON.stringify(r));
    check('fetch: the symbol list is search + feed rows that name it, fuzzy hits out', r.symbolItems.map(x => x.title).join('|') === 'Nvidia story|Nvidia options are doing something unusual', r.symbolItems.map(x => x.title).join('|'));
    check('fetch: only the symbol rides in a URL', calls.filter(u => u.includes('queryly')).every(u => /query=NVDA&/.test(u)));
    const down = await Cnbc.fetchHeadlines({ fetchImpl: async () => { throw new Error('offline'); }, now: NOW });
    check('fetch: nothing at all is an error', !!down.error);
    const noSearch = await Cnbc.fetchHeadlines({ symbol: 'NVDA', names: ['Nvidia'], now: NOW,
        fetchImpl: async (url) => url.includes('queryly') ? { ok: false, status: 403, text: async () => '' } : { ok: true, text: async () => rss } });
    check('fetch: search down → feed rows that mention it', noSearch.symbolItems.length === 1 && /Nvidia/.test(noSearch.symbolItems[0].title));

    const nw = (n) => PortfolioHeadlines.nameWords(n);
    check('nameWords: suffixes go', JSON.stringify(nw('Apple Inc.')) === '["Apple"]' && JSON.stringify(nw('NVIDIA Corporation')) === '["NVIDIA"]', JSON.stringify(nw('Apple Inc.')));
    check('nameWords: two words also match by the first', JSON.stringify(nw('Micron Technology, Inc.')) === '["Micron Technology","Micron"]', JSON.stringify(nw('Micron Technology, Inc.')));
    check('nameWords: a long fund name is only matched whole', JSON.stringify(nw('Vanguard Total Stock Market Index Fund ETF')) === '["Vanguard Total Stock Market Index"]', JSON.stringify(nw('Vanguard Total Stock Market Index Fund ETF')));
    check('nameWords: nothing known, nothing claimed', nw('').length === 0);

    /* ---------- the sheet ---------- */

    const all = PortfolioHeadlines.headlineSheet({ subject: 'all', market: rows, holdings: ['NVDA', 'VOO'], now: NOW });
    check('sheet (all): headlines with section and age', /\[Top News\] Oil little changed .* \(22m ago\)/.test(all.text), all.text);
    check('sheet (all): the held symbols ride along, no amounts', /The reader holds: NVDA, VOO/.test(all.text) && !/\$/.test(all.text));
    const one = PortfolioHeadlines.headlineSheet({ subject: 'AMD', name: 'Advanced Micro Devices', market: rows, symbolNews: [], now: NOW });
    check('sheet (ticker): says when CNBC has nothing on it', /CNBC stories mentioning AMD \(Advanced Micro Devices\):\n- None found on CNBC right now\./.test(one.text), one.text);
    check('sheet (ticker): no holdings list', !/reader holds/.test(one.text));

    /* ---------- signature + clock ---------- */

    check('signature: tracking params do not make a list new', PortfolioHeadlines.signature(rows) === PortfolioHeadlines.signature(rows.map(r => ({ ...r, url: r.url + '?x=1' }))));
    check('signature: a new story does', PortfolioHeadlines.signature(rows) !== PortfolioHeadlines.signature([...rows, old]));
    const t = Date.now();
    check('clock: nine minutes is not due', !PortfolioHeadlines.isDue({ at: t - 9 * 60000 }, t));
    check('clock: ten minutes is due', PortfolioHeadlines.isDue({ at: t - 10 * 60000 }, t));
    check('clock: a recent "checked, unchanged" resets it', !PortfolioHeadlines.isDue({ at: t - 60 * 60000, checkedAt: t - 60000 }, t));
    check('clock: a recent failure waits too (no retry storm)', !PortfolioHeadlines.isDue({ at: t - 60 * 60000, errorAt: t - 60000 }, t, t - 5 * 60000));
    check('clock: nothing yet is due', PortfolioHeadlines.isDue(null, t));
    check('clock: a failure from an earlier session is retried at once', PortfolioHeadlines.isDue({ at: t - 60 * 60000, errorAt: t - 60000 }, t, t - 30000));
    check('clock: an earlier-session failure followed by a success is not', !PortfolioHeadlines.isDue({ at: t - 60 * 60000, errorAt: t - 120000, checkedAt: t - 60000 }, t, t - 30000));

    if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
    console.log('\nportfolio-headlines: all passed');
})();
