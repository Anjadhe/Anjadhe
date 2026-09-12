#!/usr/bin/env node
/**
 * NewsApp's related-coverage shortlist — what a web search on a headline
 * becomes under the article summary (js/apps/news/news-app.js). The law it
 * pins is docs/DISCOVER.md's gimmick-avoidance rule 5: the model only
 * SELECTS, so every title, link and publisher on the card comes from a real
 * search result and an index the model invented cannot become a link.
 *
 * Pure over plain data, so it runs standalone:
 *
 *   node tests/news-related-test.js
 */

const NewsApp = require('../js/apps/news/news-app.js');

let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

const ARTICLE = {
    title: 'City council approves the harbour expansion',
    url: 'https://www.example-times.com/2026/09/harbour-expansion?utm_source=rss'
};
const opts = { selfUrls: [ARTICLE.url], title: ARTICLE.title, site: 'example-times.com' };

// ── the shortlist ──
console.log('shortlist');
{
    const rows = NewsApp._relatedCandidates([
        // The article itself, back from the search under a tracking query.
        { title: 'City council approves the harbour expansion', url: 'https://example-times.com/2026/09/harbour-expansion/?ref=search' },
        { title: 'Harbour vote clears the way for 400 new berths', url: 'https://www.coast-herald.com/news/harbour-vote', snippet: 'Councillors voted 7-2 on Tuesday.' },
        { title: 'What the harbour plan actually changes', url: 'https://publicradio.org/explainer/harbour', snippet: 'A guide to the plan.' }
    ], opts);
    check('drops the article itself by url, ignoring www and query', !rows.some(r => r.url.includes('harbour-expansion')), JSON.stringify(rows));
    check('keeps the other two', rows.length === 2);
    check('carries the publisher, not the full host', rows[0].site === 'coast-herald.com');
    check('snippet rides along for the pick', rows[1].snippet === 'A guide to the plan.');
}
{
    const rows = NewsApp._relatedCandidates([
        { title: 'City council approves the harbour expansion!', url: 'https://wire-reprint.com/a/1' },
        { title: 'Harbour vote clears the way', url: 'https://coast-herald.com/a' },
        { title: 'Harbour vote — the reaction', url: 'https://coast-herald.com/b' },
        { title: 'World', url: 'https://bbc.co.uk/news' },
        { title: 'Harbour expansion explained', url: 'https://news.google.com/articles/abc' },
        { title: 'Everyone is talking about the harbour', url: 'https://x.com/someone/status/1' },
        { title: 'Harbour expansion explained in five charts', url: 'ftp://files.example.com/x' },
        { title: 'Five charts on the harbour expansion', url: 'https://chartsdaily.com/harbour' }
    ], opts);
    const hosts = rows.map(r => r.site);
    check('a syndicated reprint of the same headline is a duplicate', !hosts.includes('wire-reprint.com'), JSON.stringify(hosts));
    check('one row per publisher', hosts.filter(h => h === 'coast-herald.com').length === 1);
    check('a section name is not a headline', !rows.some(r => r.title === 'World'));
    check('aggregators are skipped', !hosts.includes('news.google.com'));
    check('social wrappers are skipped', !hosts.includes('x.com'));
    check('non-http links are skipped', !rows.some(r => r.url.startsWith('ftp:')));
    check('real coverage survives', hosts.includes('coast-herald.com') && hosts.includes('chartsdaily.com'));
}
// ── the publisher tail ──
console.log('publisher tail');
check('the masthead comes off when it is the host',
    NewsApp._stripPublisherTail('Harbour vote clears the way for 400 new berths - Coast Herald', 'coast-herald.com')
    === 'Harbour vote clears the way for 400 new berths');
check('www and a leading The do not stop it',
    NewsApp._stripPublisherTail('Harbour vote clears the way for 400 new berths | The Coast Herald', 'www.coast-herald.com')
    === 'Harbour vote clears the way for 400 new berths');
check('a real headline tail is left alone',
    NewsApp._stripPublisherTail('Council approves harbour plan - what happens next', 'coast-herald.com')
    === 'Council approves harbour plan - what happens next');
check('a short headline is left alone',
    NewsApp._stripPublisherTail('Harbour - Reuters', 'reuters.com') === 'Harbour - Reuters');
check('the shortlist strips it too',
    NewsApp._relatedCandidates([{ title: 'Harbour vote clears the way for 400 new berths - Coast Herald', url: 'https://www.coast-herald.com/a' }], opts)[0].title
    === 'Harbour vote clears the way for 400 new berths');

check('nothing in, nothing out', NewsApp._relatedCandidates(null, opts).length === 0);
check('candidate list is capped', NewsApp._relatedCandidates(
    Array.from({ length: 20 }, (_, i) => ({ title: `Harbour expansion story number ${i}`, url: `https://site${i}.com/a` })),
    opts).length === NewsApp.RELATED_CANDIDATES);

// ── the model's picks ──
console.log('picks');
const cands = [
    { title: 'A', url: 'https://a.com/1', site: 'a.com', snippet: '' },
    { title: 'B', url: 'https://b.com/1', site: 'b.com', snippet: '' },
    { title: 'C', url: 'https://c.com/1', site: 'c.com', snippet: '' },
    { title: 'D', url: 'https://d.com/1', site: 'd.com', snippet: '' },
    { title: 'E', url: 'https://e.com/1', site: 'e.com', snippet: '' },
    { title: 'F', url: 'https://f.com/1', site: 'f.com', snippet: '' }
];
{
    const picked = NewsApp._applyPicks(cands, [{ i: 2, kind: 'background' }, { i: 0, kind: 'coverage' }]);
    check('order is the model\'s', picked.map(r => r.title).join('') === 'CA');
    check('links come from the candidate, never the model', picked[0].url === 'https://c.com/1');
    check('kind rides through', picked[0].kind === 'background');
    check('picked rows are marked as AI work', picked.every(r => r.picked === true));
}
{
    const picked = NewsApp._applyPicks(cands, [
        { i: 99, kind: 'coverage' },          // invented
        { i: '1', kind: 'coverage' },         // a numeric string, which small models do emit
        { i: -1 }, { i: null }, { i: 'two' }, // nonsense
        { i: 3, kind: 'gossip' },             // kind outside the vocabulary
        { i: 3, kind: 'coverage' }            // repeat
    ]);
    check('an index out of range is dropped', !picked.some(r => r.url.includes('99')) && picked.length === 2, JSON.stringify(picked));
    check('a numeric string still names a real candidate', picked[0].title === 'B' && picked[0].url === 'https://b.com/1');
    check('an unparseable index is dropped', !picked.some(r => r.title === 'C'));
    check('an unknown kind falls back to no chip', picked[1].kind === null);
    check('a repeated index appears once', picked.filter(r => r.title === 'D').length === 1);
}
check('picks are capped at what the card shows',
    NewsApp._applyPicks(cands, cands.map((_, i) => ({ i, kind: 'coverage' }))).length === NewsApp.RELATED_MAX);
check('a malformed answer means no picks, not a bad card', NewsApp._applyPicks(cands, 'nope') === null);
check('an empty pick list is a real answer', NewsApp._applyPicks(cands, []).length === 0);

// ── what a cache hands back ──
console.log('cached rows');
{
    const rows = NewsApp._validRelated([
        { title: 'Still good', url: 'https://a.com/1', site: 'a.com', kind: 'coverage', picked: true },
        { title: 'Broken link', url: 'not a url', site: 'b.com' },
        { title: '', url: 'https://c.com/1' },
        { title: 'Odd kind', url: 'https://d.com/1', kind: 'whatever' }
    ]);
    check('a row whose link no longer parses is dropped', rows.length === 2, JSON.stringify(rows));
    check('site is learned from the url when missing', rows[1].site === 'd.com');
    check('a kind outside the vocabulary is dropped', rows[1].kind === null);
    check('non-arrays are empty', NewsApp._validRelated(undefined).length === 0);
}

console.log(failures ? `\n${failures} failing` : '\nall good');
process.exit(failures ? 1 : 0);
