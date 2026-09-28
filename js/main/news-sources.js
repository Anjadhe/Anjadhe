'use strict';
/**
 * News sources (docs/DISCOVER.md, 2026-09-10).
 *
 * The registry of places a followed topic's headlines can come from, and
 * the pure parsers that turn each one's reply into the app's item shape.
 * Until today Google News was the one source; now the user PICKS sources
 * on the Topics page, every followed topic is fetched from each one, and
 * the rows merge per topic (story-level dedup in NewsFeed keeps the same
 * story once). Google News stays the default so nothing changes for a
 * user who never opens the Sources card.
 *
 * Two fetch paths read this registry: main.js's direct fetch (BYOK users;
 * `fetchTopicFrom` below) and, by hand, Connect's `lib/news.js` — the
 * same three sources, the same ids, the same item fields. Keep them in
 * step: a source added here is added there in the same change, and the
 * renderer's label list (`NewsFeed.SOURCES`) names the same ids.
 *
 * Item shape (every source): { title, url, source, sourceUrl,
 * publishedAt, via } plus, from Hacker News, { discussionUrl, points }.
 * `via` is the SOURCE id — what the post's byline shows as "via Hacker
 * News" — while `source` stays the PUBLISHER (an HN story's link points
 * at the article's own site, and that is whose favicon the post wears).
 *
 * Privacy: nothing but the topic rides in any of these URLs; the fetch
 * helper sends a minimal static User-Agent and no cookies.
 */

const MAX_ITEMS = 20;                 // per source per topic (Connect's cap too)
const TIMEOUT_MS = 15000;
const HN_WINDOW_S = 48 * 60 * 60;     // NewsFeed.STORY_MAX_AGE_MS, in seconds
// A story needs some traction before it is news: the feed sorts by date,
// and without a floor the newest rows were 1-point submissions nobody had
// read yet (seen 2026-09-10 on the first live run).
const HN_MIN_POINTS = 10;

const SOURCES = [
    {
        id: 'google',
        label: 'Google News',
        desc: 'Thousands of publishers, searched by topic.',
        url: (topic) => 'https://news.google.com/rss/search?'
            + new URLSearchParams({ q: topic, hl: 'en-US', gl: 'US', ceid: 'US:en' }),
        parse: (text) => parseRss(text)
    },
    {
        id: 'bing',
        label: 'Bing News',
        desc: 'A second news index, searched by topic.',
        url: (topic) => 'https://www.bing.com/news/search?'
            + new URLSearchParams({ q: topic, format: 'rss', mkt: 'en-US' }),
        parse: (text) => parseRss(text)
    },
    {
        id: 'hn',
        label: 'Hacker News',
        desc: 'Stories from the last two days that match your topics, ranked by its readers. Best for technology, science and startups.',
        url: (topic, now = Date.now()) => 'https://hn.algolia.com/api/v1/search?'
            + new URLSearchParams({
                query: topic,
                tags: 'story',
                hitsPerPage: String(MAX_ITEMS),
                numericFilters: `created_at_i>${Math.floor(now / 1000) - HN_WINDOW_S},points>=${HN_MIN_POINTS}`
            }),
        parse: (text) => hnItems(text)
    }
];
const SOURCE_IDS = SOURCES.map(s => s.id);
const DEFAULT_SOURCES = ['google'];

/**
 * The allowlist gate: unknown ids drop, duplicates fold, the order is the
 * registry's, and an empty pick means the default — a stored settings
 * blob from before sources existed reads as Google News.
 */
function normalizeSources(list) {
    const want = new Set((Array.isArray(list) ? list : [])
        .map(x => String(x || '').trim().toLowerCase())
        .filter(x => SOURCE_IDS.includes(x)));
    const out = SOURCE_IDS.filter(id => want.has(id));
    return out.length ? out : DEFAULT_SOURCES.slice();
}

function sourceById(id) {
    return SOURCES.find(s => s.id === id) || null;
}

function decodeEntities(s) {
    // Entity order matters: &amp; must decode LAST. Decoding it first
    // turns double-encoded text (&amp;lt;script&amp;gt;) into literal
    // <script> strings — inert only as long as every sink escapes.
    return String(s || '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .trim();
}

// Bing wraps the article in a click-tracking redirect whose `url`
// parameter is the publisher's page — hand that over instead, so the
// reader opens the real article and not a tracker hop.
function unwrapBingLink(url) {
    try {
        const u = new URL(url);
        if (!/(^|\.)bing\.com$/i.test(u.hostname)) return null;
        const target = u.searchParams.get('url');
        return target && /^https?:\/\//i.test(target) ? target : null;
    } catch { return null; }
}

/**
 * Minimal RSS <item> parser (twin of anjadhe-connect lib/news.js — keep
 * in step). Google and Bing news feeds are regular enough that a
 * dependency isn't warranted.
 */
function parseRss(xml) {
    const items = [];
    const blocks = String(xml || '').split(/<item(?:\s[^>]*)?>/).slice(1);
    for (const b of blocks) {
        const end = b.indexOf('</item>');
        const block = end === -1 ? b : b.slice(0, end);
        const tag = (name) => {
            const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
            return m ? decodeEntities(m[1]) : '';
        };
        let title = tag('title');
        let url = tag('link');
        // Google: <source url="…">Publisher</source>. Bing: <News:Source>.
        const source = tag('source') || tag('News:Source');
        const pub = Date.parse(tag('pubDate'));
        if (!title || !url) continue;
        const unwrapped = unwrapBingLink(url);
        if (unwrapped) url = unwrapped;
        // Google News titles carry a " - Publisher" suffix duplicating
        // <source>; strip it so the post shows the source once.
        if (source && title.toLowerCase().endsWith(' - ' + source.toLowerCase())) {
            title = title.slice(0, title.length - source.length - 3).trim();
        }
        // The <source> tag's url attribute is the publisher's site — the
        // item <link> is a news.google.com redirect, so this is the only
        // publisher domain in the feed (the News app's favicon avatars).
        const srcM = block.match(/<source\s[^>]*url=(?:"([^"]*)"|'([^']*)')/i);
        let sourceUrl = decodeEntities(srcM ? (srcM[1] || srcM[2]) : '');
        // Bing carries no publisher site; the unwrapped article's origin is.
        if (!sourceUrl && unwrapped) { try { sourceUrl = new URL(unwrapped).origin; } catch { /* leave empty */ } }
        items.push({
            title: title.slice(0, 300),
            url: url.slice(0, 2000),
            source: source.slice(0, 100),
            sourceUrl: /^https?:\/\//i.test(sourceUrl) ? sourceUrl.slice(0, 300) : '',
            publishedAt: Number.isNaN(pub) ? null : new Date(pub).toISOString()
        });
        if (items.length >= MAX_ITEMS) break;
    }
    return items;
}

/**
 * Hacker News via the Algolia search API (JSON). A story's `url` is the
 * article on its own site, so the PUBLISHER is that site's host and the
 * HN thread is carried separately as `discussionUrl` (the reader offers
 * it under Source). A story with no link (Ask HN, Show HN text posts)
 * IS its thread. `points` is real data from the community, shown as-is.
 */
function hnItems(json) {
    let data = json;
    if (typeof json === 'string') {
        try { data = JSON.parse(json); } catch { return []; }
    }
    const hits = Array.isArray(data?.hits) ? data.hits : [];
    const items = [];
    for (const h of hits) {
        const id = String(h?.objectID || '');
        const title = String(h?.title || '').trim();
        if (!title || !/^\d{1,12}$/.test(id)) continue;
        const thread = `https://news.ycombinator.com/item?id=${id}`;
        const link = typeof h.url === 'string' && /^https?:\/\//i.test(h.url) ? h.url.trim() : '';
        const url = link || thread;
        let host = '';
        let origin = '';
        if (link) {
            try { const u = new URL(link); host = u.hostname.replace(/^www\./i, ''); origin = u.origin; }
            catch { /* unparsable link: fall through to the thread */ }
        }
        const pub = Date.parse(h.created_at || '');
        const points = Number(h.points);
        items.push({
            title: title.slice(0, 300),
            url: (host ? url : thread).slice(0, 2000),
            source: (host || 'Hacker News').slice(0, 100),
            sourceUrl: (host ? origin : 'https://news.ycombinator.com').slice(0, 300),
            publishedAt: Number.isNaN(pub) ? null : new Date(pub).toISOString(),
            discussionUrl: thread,
            ...(Number.isFinite(points) ? { points: Math.max(0, Math.round(points)) } : {})
        });
        if (items.length >= MAX_ITEMS) break;
    }
    return items;
}

const FETCH_HEADERS = {
    'Accept': 'application/rss+xml, application/xml, text/xml, application/json',
    'User-Agent': 'Anjadhe/1.0'
};

/**
 * One topic from one source, stamped `via`. Throws on a failed fetch so
 * the caller can decide per source (Google down should not blank the
 * Hacker News rows, and vice versa). `fetchImpl` is injectable for tests.
 */
async function fetchTopicFrom(sourceId, topic, fetchImpl = globalThis.fetch) {
    const src = sourceById(sourceId);
    if (!src) throw new Error('unknown news source');
    const res = await fetchImpl(src.url(topic), {
        headers: FETCH_HEADERS,
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`news HTTP ${res.status}`);
    return stampVia(src.parse(await res.text()), sourceId);
}

function stampVia(items, via) {
    return items.map(it => ({ ...it, via }));
}

/**
 * The per-topic merge: each source's rows in publication order, newest
 * first, so the topic reads as one dated list whichever source a row
 * came from. Story-level dedup is NewsFeed's job (it owns the token
 * matcher); this only orders.
 */
function mergeSourceItems(lists) {
    const all = [].concat(...lists.filter(Array.isArray));
    const when = (it) => { const t = Date.parse(it?.publishedAt || ''); return Number.isNaN(t) ? 0 : t; };
    return all.sort((a, b) => when(b) - when(a));
}

module.exports = {
    SOURCES, SOURCE_IDS, DEFAULT_SOURCES, MAX_ITEMS,
    normalizeSources, sourceById, parseRss, hnItems, unwrapBingLink,
    fetchTopicFrom, stampVia, mergeSourceItems
};
