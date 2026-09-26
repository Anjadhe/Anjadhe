// The phone builds News itself when the Mac is away
// (ios-engine/.../AnjadheCore/NewsLogic.swift, docs/MOBILE_NATIVE.md "M5").
// Like tests/task-list-parity-test.js: this runs the DESKTOP's real code —
// news-sources.js's parsers, NewsFeed._refresh, NewsApp._buildGroups and
// MobileViews._news — on a fixture and pins its output in a golden file the
// Swift NewsParityTests compare the phone's port against. Re-run with
// --update when a desktop rule changes on purpose, then make Swift match.
process.env.TZ = 'UTC';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const R = path.join(__dirname, '..') + '/';
const FIX = R + 'ios-engine/Anjadhe/Tests/AnjadheCoreTests/Fixtures/';
const fx = JSON.parse(fs.readFileSync(FIX + 'news-parity.input.json', 'utf8'));
const NewsSources = require(R + 'js/main/news-sources.js');

const parsed = {
    google: NewsSources.stampVia(NewsSources.parseRss(fx.google), 'google'),
    bing: NewsSources.stampVia(NewsSources.parseRss(fx.bing), 'bing'),
    hn: NewsSources.stampVia(NewsSources.hnItems(fx.hn), 'hn'),
};
// One topic per source list, as the fetch would merge them (plus a failed topic).
const fetched = [
    { topic: 'Technology', items: NewsSources.mergeSourceItems([parsed.google]) },
    { topic: 'Chennai', items: NewsSources.mergeSourceItems([parsed.bing]) },
    { topic: 'Climate', items: NewsSources.mergeSourceItems([parsed.hn]) },
    { topic: 'Failed', items: [], error: 'unavailable' },
];

const realNow = Date.now;
Date.now = () => fx.nowMs;
const noop = () => {};
const mem = { 'discover-settings': fx.settings, 'discover-taste': fx.taste, 'news-saved': [] };
Object.assign(globalThis, {
    window: globalThis,
    document: { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null, addEventListener: noop, createElement: () => ({ style: {}, classList: { add: noop } }) },
    localStorage: { getItem: () => null, setItem: noop },
    StorageManager: { get: (k) => mem[k] ?? null, set: (k, v) => { mem[k] = v; } },
    AppManager: { register: noop }, UIUtils: { escapeHtml: (s) => String(s), showToast: noop },
    FEATURES: { isEnabled: () => false },
});
const load = (f) => (0, eval)(fs.readFileSync(R + f, 'utf8').replace(/^const (\w+) =/m, 'globalThis.$1 ='));
load('js/apps/news/news-feed.js');
load('js/apps/news/news-app.js');
load('js/agent/mobile-views.js');
NewsFeed._checkWeb = async () => true;
NewsFeed._fetchNews = async () => ({ topics: JSON.parse(JSON.stringify(fetched)) });
NewsFeed._rankItems = async (items) => items;
NewsFeed._digestNotify = noop;

(async () => {
    await NewsFeed._refresh();
    NewsFeed.ensureFresh = async () => {};
    const view = await MobileViews._news();
    Date.now = realNow;
    const out = { parsed, fetched, groups: view.groups, topicHues: view.topicHues, bySource: view.bySource, total: view.total };
    const goldenPath = FIX + 'news-parity.golden.json';
    if (process.argv.includes('--update')) {
        fs.writeFileSync(goldenPath, JSON.stringify(out, null, 1) + '\n');
        console.log('news-parity-test: golden updated (' + view.groups.length + ' groups, ' + view.total + ' rows)');
        return;
    }
    assert.deepStrictEqual(out, JSON.parse(fs.readFileSync(goldenPath, 'utf8')),
        'the desktop News pipeline changed — run with --update, then make NewsLogic.swift match');
    console.log('news-parity-test: ok (' + view.groups.length + ' groups, ' + view.total + ' rows)');
})().catch((e) => { console.error(e.stack || e.message || e); process.exit(1); });
