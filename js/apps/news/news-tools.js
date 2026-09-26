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

    // ── Article links (2026-09-22) ─────────────────────────────────────
    // Every story get_news hands the model carries a short `ref`, and the
    // model cites it as [CNBC](anjadhe://article/<ref>) — the RecordLinks
    // grammar, so the chat, routine posts on Home and the result page all
    // render it as a link that opens the story in the News reader. The
    // model never copies a URL (Google News links run to hundreds of
    // characters, and a small model mangles them); the app holds the
    // ref → article map and a ref it never issued opens nothing.
    //
    // The map is per-Mac localStorage, capped, oldest dropped: a post read
    // on another Mac, or long after, finds its ref gone and says so in a
    // toast rather than guessing. A ref is a hash of the URL, so the same
    // story keeps the same ref across runs.
    const REFS_KEY = 'news-article-refs';
    const REFS_MAX = 800;

    const refOf = (url) => {
        let h = 5381;
        for (const ch of String(url)) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
        return 'a' + h.toString(36);
    };
    const readRefs = () => {
        try { return JSON.parse(localStorage.getItem(REFS_KEY) || '{}') || {}; } catch (_) { return {}; }
    };
    const rememberRefs = (items) => {
        const refs = readRefs();
        const now = Date.now();
        for (const it of items) {
            if (!it?.url) continue;
            refs[refOf(it.url)] = {
                title: it.title || '', url: it.url, source: it.source || '',
                topic: it.topic || '', publishedAt: it.publishedAt || null, at: now
            };
        }
        const keys = Object.keys(refs);
        if (keys.length > REFS_MAX) {
            keys.sort((a, b) => (refs[a].at || 0) - (refs[b].at || 0));
            for (const k of keys.slice(0, keys.length - REFS_MAX)) delete refs[k];
        }
        try { localStorage.setItem(REFS_KEY, JSON.stringify(refs)); } catch (_) { /* links just won't resolve */ }
    };

    if (typeof RecordLinks !== 'undefined') {
        RecordLinks.register('article', {
            label: 'article',
            hint: 'a News story — use its ref from get_news',
            exists: (ref) => !!readRefs()[ref],
            open(ref) {
                const a = readRefs()[ref];
                if (!a || typeof NewsApp === 'undefined') return;
                const { at, ...item } = a;
                NewsApp.openReader(item);
            }
        });
    }

    // ── The words that summon the group ────────────────────────────────
    // "Topics" alone is too common a word to summon News, but following,
    // adding or tracking topics is what this app means by it — "can you add
    // the topics yourself" shipped no news tools (2026-09-22).
    AgentTools.registerDomain(SOURCE, /\b(news|headlines?|top\s+stories|current\s+events|world\s+news|press)\b|\b(follow|unfollow|add|track|remove)\w*\b[^.?!]{0,40}\btopics?\b/);

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
            return { error: 'The user follows no news topics yet. If you know what they want to read about, call follow_news_topics with a few specific topics and then get_news again; otherwise ask them which subjects to follow.' };
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
        const shown = items.slice(0, limit);
        rememberRefs(shown);
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
            // No URLs — a short ref instead (see "Article links" above):
            // 20 raw links are a lot of tokens for a local model to carry
            // and to copy without a typo.
            linkWith: 'Link every story you mention with its ref, as a markdown link on the source or a short headline: [CNBC](anjadhe://article/<ref>). Use the ref exactly as given, and never write any other URL for these stories.',
            items: shown.map(it => ({
                ref: it.url ? refOf(it.url) : undefined,
                title: it.title,
                source: it.source || '',
                topic: it.topic || '',
                published: it.publishedAt ? NewsFeed._ageLabel(it) : 'undated',
                // Which news source carried it, when not the default —
                // "via Hacker News, 320 points" is worth a digest line.
                ...(it.via && it.via !== 'google' ? { via: NewsFeed.sourceLabel(it.via) || it.via } : {}),
                ...(Number.isInteger(it.points) ? { points: it.points } : {})
            }))
        };
    }, { source: SOURCE, group: SOURCE, webRun: true });

    // Following a topic is a reversible preference the user can see and
    // undo on the Topics page, so it runs without a dialog — the same bar
    // as tag_document. Written through NewsFeed.saveSettings, the one
    // writer the Topics page uses; the next ensureFresh() fetches a newly
    // followed topic regardless of TTL (a followed topic with no cache rows
    // is stale by definition). Blocked on untrusted turns: an email or a
    // web page must not be able to reshape what the user reads.
    // (2026-09-22: the assistant told a user it "could not authorize"
    // topics, when there was simply no tool for it.)
    AgentTools.register({ type: 'function', function: {
        name: 'follow_news_topics',
        description: 'Follow or unfollow topics in the user\'s News app — the topics get_news, the News page and the Morning News routine read from. Any words work as a topic ("AI stocks", "Nvidia", "Semiconductors", "Federal Reserve"); each is a news search. Call it whenever the user asks you to add, follow, track, remove or stop following news topics, or agrees to your suggestion to add some — do it in this turn, do not tell them to do it themselves. Prefer a few specific topics over one broad one. Reversible from News › Topics; no confirmation needed.',
        parameters: { type: 'object', properties: {
            follow: { type: 'array', items: { type: 'string' }, description: 'Topics to start following.' },
            unfollow: { type: 'array', items: { type: 'string' }, description: 'Topics to stop following (matched case-insensitively).' }
        }}
    }}, async (args = {}) => {
        const clean = (list) => (Array.isArray(list) ? list : [])
            .map(t => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 60))
            .filter(Boolean);
        const follow = clean(args.follow);
        const unfollow = new Set(clean(args.unfollow).map(t => t.toLowerCase()));
        if (!follow.length && !unfollow.size) return { error: 'Pass topics in "follow" or "unfollow".' };

        const before = NewsFeed.settings().interests;
        const kept = before.filter(t => !unfollow.has(t.toLowerCase()));
        const have = new Set(kept.map(t => t.toLowerCase()));
        const added = [];
        for (const t of follow) {
            if (have.has(t.toLowerCase())) continue;
            have.add(t.toLowerCase());
            added.push(t);
        }
        const room = Math.max(0, NewsFeed.TOPIC_LIMIT - kept.length);
        const fits = added.slice(0, room);
        const skipped = added.slice(room);
        const removed = before.filter(t => unfollow.has(t.toLowerCase()));
        NewsFeed.saveSettings({ interests: [...kept, ...fits] });
        // Fetch now so get_news (and a routine run later this turn) sees the
        // new topics; a failure leaves them followed and fetched next open.
        if (fits.length) { try { await NewsFeed.ensureFresh(); } catch (_) { /* fetched on next open */ } }
        if (typeof NewsApp !== 'undefined' && NewsApp.repaintRail) { try { NewsApp.repaintRail(); } catch (_) {} }

        const after = NewsFeed.settings().interests;
        return {
            followed: fits,
            unfollowed: removed,
            alreadyFollowing: follow.filter(t => !added.includes(t)),
            ...(skipped.length ? { notAdded: skipped, note: `The News app follows at most ${NewsFeed.TOPIC_LIMIT} topics. Ask which to drop to make room for: ${skipped.join(', ')}.` } : {}),
            nowFollowing: after
        };
    }, { source: SOURCE, group: SOURCE, blockUntrusted: true });

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
