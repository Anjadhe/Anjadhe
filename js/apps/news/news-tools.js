/**
 * News — the package's contribution to the assistant and the shell.
 *
 * Registered from the app's own folder (docs/PLATFORM.md "App packages"):
 * the get_news tool (flagged `webRun` so a web-grounded routine run offers
 * it beside web_search — the Morning News starter is built on it), the
 * words that summon the group, the Morning News starter routine, the
 * "Catch me up on the news" quick-start pill, and the cross-app API other
 * packages act through — Anjadhe.expose('news') — which Portfolio's
 * holdings-news rows use to open the reader with a back door to
 * Portfolio. Loads last in the package, after the agent stack.
 */

(function registerNewsPackage() {
    if (typeof AgentTools === 'undefined' || typeof NewsFeed === 'undefined') return;

    const SOURCE = 'news';

    // ── Cross-app API (Anjadhe.use('news')) ────────────────────────────
    if (typeof Anjadhe !== 'undefined') {
        Anjadhe.expose(SOURCE, {
            /** { interests, location } — what the user follows. */
            settings() { return NewsFeed.settings(); },
            /** The reader for one story ({ title, url, source, publishedAt,
             *  topic }); opts.returnTo = { label, onBack } makes its back
             *  button return to the caller's page. */
            openReader(item, opts) { if (typeof NewsApp !== 'undefined') NewsApp.openReader(item, opts || {}); },
            /** The user's current headlines (the get_news list), newest
             *  cache; { topic?, limit? }. */
            async headlines({ topic, limit } = {}) {
                try { await NewsFeed.ensureFresh(); } catch (_) { /* stale beats none */ }
                let items = NewsFeed.visibleItems(NewsFeed.cache());
                const wanted = String(topic || '').trim().toLowerCase();
                if (wanted) items = items.filter(it => String(it.topic || '').toLowerCase() === wanted);
                return items.slice(0, Math.min(Math.max(Number(limit) || 20, 1), 40)).map(it => ({ ...it }));
            }
        });
    }

    // ── The words that summon the group ────────────────────────────────
    AgentTools.registerDomain(SOURCE, /\b(news|headlines?|top\s+stories|current\s+events|world\s+news|press)\b/);

    // ── Tool ───────────────────────────────────────────────────────────
    // The user's own news feed, not a web search. This exists so the
    // Morning News routine reports on the topics the user actually follows
    // instead of whatever a generic search turns up. The headlines are
    // quoted from real sources with real publication times
    // (docs/DISCOVER.md gimmick-avoidance rule #1: the model never authors
    // a headline), so the model's job here is summarising given text — the
    // thing a 12B model does well — rather than recalling world events,
    // which it cannot. Awaits ensureFresh: a 7am digest reading a cache
    // last filled at 6pm yesterday would be worse than no digest.
    AgentTools.register({ type: 'function', function: {
        name: 'get_news',
        description: 'Current headlines for the topics the user follows in the News app — real, dated, sourced articles they already chose to see. Prefer this over web_search for "what is the news", a news digest, or anything about their topics: it is one local read of an already-fetched list, and every headline is quoted from a real source rather than assembled from search snippets. Returns how long ago each story was published, so never describe an old story as breaking.',
        parameters: { type: 'object', properties: {
            topic: { type: 'string', description: 'Optional: only headlines for this topic. Must be one the user follows — the result lists them.' },
            limit: { type: 'number', description: 'Max headlines to return (default 20, max 40).' }
        }}
    }}, async (args = {}) => {
        const { interests } = NewsFeed.settings();
        if (!interests.length) {
            return { error: 'The user follows no news topics yet. They can pick some with the Topics button on the News page.' };
        }

        try {
            await NewsFeed.ensureFresh();
        } catch (e) {
            // Stale headlines beat none — fall through to whatever is cached.
            console.warn('[get_news] refresh failed:', e);
        }

        const cache = NewsFeed.cache();
        // visibleItems applies the user's "show fewer like this" hides,
        // so the assistant never reads back a story they dismissed.
        let items = NewsFeed.visibleItems(cache);

        const wanted = String(args.topic || '').trim().toLowerCase();
        if (wanted) items = items.filter(it => String(it.topic || '').toLowerCase() === wanted);

        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 40);
        if (!items.length) {
            return {
                topics: interests,
                count: 0,
                note: wanted
                    ? `No current headlines for "${args.topic}". Topics followed: ${interests.join(', ')}.`
                    : 'No current headlines cached. Web access may be off (Settings > AI Assistant > Web Search).'
            };
        }

        const ageMs = cache.generatedAt ? Date.now() - cache.generatedAt : null;
        return {
            topics: interests,
            updated: cache.generatedAt ? NewsFeed._ago(cache.generatedAt) : 'unknown',
            // An explicit flag, because "6h ago" in a field is easy for a
            // small model to skim past when it is about to write "today".
            stale: ageMs !== null && ageMs > 6 * 60 * 60 * 1000,
            // `count` is what the model can actually see. A bare total
            // would invite "here are your 20 stories" under a limit of 5.
            count: Math.min(items.length, limit),
            ...(items.length > limit ? { moreAvailable: items.length - limit } : {}),
            // No URLs: the digest names sources, and 20 links is a lot of
            // tokens for a local model to carry for no gain.
            items: items.slice(0, limit).map(it => ({
                title: it.title,
                source: it.source || '',
                topic: it.topic || '',
                published: it.publishedAt ? NewsFeed._ago(it.publishedAt) : 'undated'
            }))
        };
    }, { source: SOURCE, group: SOURCE, webRun: true });

    // ── Starter routine + quick-start pill ──────────────────────────────
    // Morning News, 07:00 (moved from 17:00 on 2026-07-29 when the home
    // Discover pane went: the feed post is what greets you with the news,
    // so it should be there before the day starts). Reads the user's OWN
    // topics via get_news rather than searching the web: the headlines come
    // back real, dated and sourced, so the model is summarising given text
    // instead of recalling world events — the difference between a digest
    // a 12B model can do well and one it cannot.
    if (typeof StarterPrompts !== 'undefined') {
        StarterPrompts.register({
            id: 'starter-news-digest',
            title: 'Morning News',
            config: { offline: true, interval: 'daily', time: '07:00', web: true, useContext: false },
            body: 'Call get_news to fetch the headlines for the topics I follow, then write my morning news digest from them. Group the stories by topic, one or two sentences each, and name the source. Only use the headlines the tool returned — never add stories from memory. Lead with whatever is most significant. If the tool says the headlines are stale, say how old they are instead of calling them today’s news. If it returns nothing, say so in one line.'
        });
    }
    if (typeof AgentUI !== 'undefined' && AgentUI.registerSuggestion) {
        AgentUI.registerSuggestion({ text: 'Catch me up on the news',
            when: () => (NewsFeed.settings().interests || []).length > 0 });
    }
})();
