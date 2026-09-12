'use strict';
// Pins js/main/news-sources.js: the source allowlist (unknown ids drop,
// empty means Google News), the RSS parser on Google's and Bing's shapes,
// the Hacker News mapping (publisher = the article's site, thread carried
// as discussionUrl, points as data), and the per-source fetch stamping
// `via`. Connect's lib/news.js is this module's twin — a change here is a
// change there.
const assert = require('assert');
const NS = require('../js/main/news-sources');

let n = 0;
const t = (name, fn) => { const r = fn(); if (r && r.then) return r.then(() => { n++; console.log('  ok', name); }); n++; console.log('  ok', name); };

(async () => {
t('registry ids are the allowlist and google is the default', () => {
    assert.deepStrictEqual(NS.SOURCE_IDS, ['google', 'bing', 'hn']);
    assert.deepStrictEqual(NS.DEFAULT_SOURCES, ['google']);
    assert.deepStrictEqual(NS.normalizeSources(undefined), ['google']);
    assert.deepStrictEqual(NS.normalizeSources([]), ['google']);
    assert.deepStrictEqual(NS.normalizeSources(['bogus', 42, null]), ['google']);
});
t('normalize folds duplicates and keeps registry order', () => {
    assert.deepStrictEqual(NS.normalizeSources(['hn', 'google', 'HN ', 'hn']), ['google', 'hn']);
    assert.deepStrictEqual(NS.normalizeSources(['bing']), ['bing']);
    assert.deepStrictEqual(NS.normalizeSources(['hn', 'bing']), ['bing', 'hn']);
});
t('every source builds a URL carrying only the topic', () => {
    for (const src of NS.SOURCES) {
        const u = new URL(src.url('cricket world cup', 1788975564000));
        assert.ok(['news.google.com', 'www.bing.com', 'hn.algolia.com'].includes(u.hostname), src.id);
        const q = u.searchParams.get('q') || u.searchParams.get('query');
        assert.strictEqual(q, 'cricket world cup', src.id);
    }
    const hn = new URL(NS.sourceById('hn').url('ai', 1788975564000));
    assert.strictEqual(hn.searchParams.get('tags'), 'story');
    // The window is the app's 48h story age, in seconds, from the given clock.
    assert.strictEqual(hn.searchParams.get('numericFilters'), `created_at_i>${1788975564 - 48 * 3600},points>=10`);
});
t('google rss: entities, publisher suffix, source url, ISO date', () => {
    const items = NS.parseRss(`<rss><channel>
        <item><title>Rates &amp; markets: a &quot;quiet&quot; week - Reuters</title>
        <link>https://news.google.com/rss/articles/abc</link>
        <pubDate>Wed, 09 Sep 2026 12:00:00 GMT</pubDate>
        <source url="https://www.reuters.com">Reuters</source></item>
        <item><title>no link</title></item>
    </channel></rss>`);
    assert.strictEqual(items.length, 1);
    assert.deepStrictEqual(items[0], {
        title: 'Rates & markets: a "quiet" week',
        url: 'https://news.google.com/rss/articles/abc',
        source: 'Reuters',
        sourceUrl: 'https://www.reuters.com',
        publishedAt: '2026-09-09T12:00:00.000Z'
    });
});
t('bing rss: News:Source publisher, tracker link unwrapped to the article', () => {
    const items = NS.parseRss(`<rss xmlns:News="x"><channel>
        <item><title>Apple is late to AI</title>
        <link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;url=https%3a%2f%2fwww.aol.com%2farticles%2fapple-ai.html&amp;c=1&amp;mkt=en-us</link>
        <pubDate>Thu, 03 Sep 2026 08:00:00 GMT</pubDate>
        <News:Source>AOL</News:Source></item>
    </channel></rss>`);
    assert.strictEqual(items[0].url, 'https://www.aol.com/articles/apple-ai.html');
    assert.strictEqual(items[0].source, 'AOL');
    assert.strictEqual(items[0].sourceUrl, 'https://www.aol.com');
    assert.strictEqual(NS.unwrapBingLink('https://d.example/a'), null);
});
t('hacker news: publisher is the article site, thread is the discussion', () => {
    const items = NS.hnItems(JSON.stringify({ hits: [
        { objectID: '49630253', title: 'AirPods 5', url: 'https://www.apple.com/newsroom/x', points: 502, num_comments: 446, created_at: '2026-09-09T17:39:24Z' },
        { objectID: '49630000', title: 'Ask HN: what changed?', url: null, points: 12, created_at: '2026-09-09T10:00:00Z' },
        { objectID: 'not-an-id', title: 'dropped', url: 'https://a.com' },
        { objectID: '5', title: '', url: 'https://a.com' }
    ] }));
    assert.strictEqual(items.length, 2);
    assert.deepStrictEqual(items[0], {
        title: 'AirPods 5',
        url: 'https://www.apple.com/newsroom/x',
        source: 'apple.com',
        sourceUrl: 'https://www.apple.com',
        publishedAt: '2026-09-09T17:39:24.000Z',
        discussionUrl: 'https://news.ycombinator.com/item?id=49630253',
        points: 502
    });
    // A text post IS its thread, and Hacker News is its publisher.
    assert.strictEqual(items[1].url, 'https://news.ycombinator.com/item?id=49630000');
    assert.strictEqual(items[1].source, 'Hacker News');
    assert.strictEqual(items[1].sourceUrl, 'https://news.ycombinator.com');
    assert.deepStrictEqual(NS.hnItems('not json'), []);
    assert.deepStrictEqual(NS.hnItems({}), []);
});
t('per-source cap holds', () => {
    const hits = Array.from({ length: 50 }, (_, i) => ({ objectID: String(i + 1), title: 'T' + i, url: 'https://a.com/' + i, created_at: '2026-09-09T10:00:00Z' }));
    assert.strictEqual(NS.hnItems({ hits }).length, NS.MAX_ITEMS);
    const xml = '<rss><channel>' + hits.map(h => `<item><title>${h.title}</title><link>${h.url}</link></item>`).join('') + '</channel></rss>';
    assert.strictEqual(NS.parseRss(xml).length, NS.MAX_ITEMS);
});
await t('fetchTopicFrom stamps via and throws on a bad status or unknown id', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(String(url));
        if (String(url).includes('hn.algolia.com')) {
            return { ok: true, text: async () => JSON.stringify({ hits: [{ objectID: '7', title: 'Hi', url: 'https://x.org/p', created_at: '2026-09-09T10:00:00Z' }] }) };
        }
        return { ok: false, status: 503, text: async () => '' };
    };
    const items = await NS.fetchTopicFrom('hn', 'rust', fetchImpl);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].via, 'hn');
    assert.strictEqual(items[0].source, 'x.org');
    await assert.rejects(() => NS.fetchTopicFrom('google', 'rust', fetchImpl), /HTTP 503/);
    await assert.rejects(() => NS.fetchTopicFrom('nope', 'rust', fetchImpl), /unknown/);
    assert.strictEqual(calls.length, 2);
});
t('mergeSourceItems orders newest first across sources', () => {
    const merged = NS.mergeSourceItems([
        [{ title: 'g1', publishedAt: '2026-09-09T10:00:00Z', via: 'google' }, { title: 'g2', publishedAt: '2026-09-08T10:00:00Z', via: 'google' }],
        [{ title: 'h1', publishedAt: '2026-09-09T12:00:00Z', via: 'hn' }, { title: 'undated', publishedAt: null, via: 'hn' }]
    ]);
    assert.deepStrictEqual(merged.map(x => x.title), ['h1', 'g1', 'g2', 'undated']);
    assert.deepStrictEqual(NS.mergeSourceItems([null, undefined]), []);
});
console.log(`news-sources-test: ${n} passed`);
})().catch(e => { console.error(e); process.exit(1); });
