/**
 * News — the full-page home of Discover's headlines (docs/DISCOVER.md D3).
 *
 * The list view groups the same items the Discover pane shows (one shared
 * cache, DiscoverPane owns fetching). The reader view is the D3 "read
 * before you leave" layer: opening a headline does NOT jump to the browser
 * — the article is fetched onto the user's machine (read_url) and their
 * chosen model writes a detailed summary; if the page won't read (consent
 * walls, scripted redirects), coverage from web search stands in, clearly
 * labeled. With no model configured the extracted article text shows
 * instead — deterministic and honest. The "Open article" button is always
 * there; the summary just means the browser hop is a choice, not a
 * requirement.
 *
 * AI stays in its lane (the doc's hard rules): summaries are user-initiated
 * by the click, always labeled with what they were built from, and every
 * failure path degrades to something real (extract, search coverage, or
 * just the link).
 *
 * Storage: `news-summaries` (machine-local, in SYNC_EXCLUDE_KEYS) — a small
 * per-URL summary cache so re-opening an article is instant.
 */
const NewsApp = {
    SUMMARY_KEY: 'news-summaries',
    SUMMARY_MAX: 60,           // cached summaries kept (oldest trimmed)
    MIN_ARTICLE_CHARS: 400,    // under this, read_url got a stub, not an article
    ARTICLE_PROMPT_CHARS: 6000,

    LATEST_ROWS: 4,            // one-liners in the hero band's Latest rail

    _mode: 'list',             // 'list' (card grid) | 'topic' | 'reader'
    _current: null,            // reader item {title, url, source, topic, publishedAt, why?}
    _summaryState: null,       // {status} while working, {summary, mode, openUrl} when done
    _groups: null,             // rendered groups [{topic, rows}]
    _topic: null,              // drilled-into topic name ('topic' mode)

    init() {
        const view = document.getElementById('news-view');
        if (!view || view._wired) return;
        view._wired = true;
        view.addEventListener('click', (e) => {
            const row = e.target.closest && e.target.closest('[data-news-g]');
            if (row && !row.dataset.newsAction) {
                const it = this._groups?.[Number(row.dataset.newsG)]?.rows?.[Number(row.dataset.newsI)];
                if (it) this.openReader(it);
                return;
            }
            const act = e.target.closest && e.target.closest('[data-news-action]');
            if (!act) return;
            const action = act.dataset.newsAction;
            if (action === 'back') {
                // Reader backs out to wherever it was opened from.
                this._mode = this._topic ? 'topic' : 'list';
                this._current = null;
                this.render();
            }
            else if (action === 'open-topic') { this._topic = act.dataset.topic || ''; this._mode = 'topic'; this.render(); }
            else if (action === 'back-all') { this._topic = null; this._mode = 'list'; this.render(); }
            else if (action === 'topics' && typeof DiscoverPane !== 'undefined') DiscoverPane.openPrefs();
            else if (action === 'refresh' && typeof DiscoverPane !== 'undefined') { DiscoverPane.refresh(); setTimeout(() => this.render(), 800); }
            else if (action === 'open-article') this._openArticle();
            else if (action === 'discuss') this._discuss();
            else if (action === 'catchup' && typeof DiscoverPane !== 'undefined') DiscoverPane.catchMeUp();
            else if (action === 'digest-hide' && typeof DiscoverPane !== 'undefined') DiscoverPane.clearDigest();
            else if (action === 'add-event') this._addEvent(Number(act.dataset.idx));
            else if (action === 'fewer' && typeof DiscoverPane !== 'undefined') {
                const it = this._groups?.[Number(act.dataset.newsG)]?.rows?.[Number(act.dataset.newsI)];
                if (it) DiscoverPane.recordFewer(it);
            }
        });
    },

    render() {
        const view = document.getElementById('news-view');
        if (!view) return;
        if (this._mode === 'reader' && this._current) view.innerHTML = this._readerHtml();
        else if (this._mode === 'topic' && this._topic) view.innerHTML = this._topicHtml();
        else { this._mode = 'list'; view.innerHTML = this._listHtml(); }
    },

    /* ---------- List ---------- */

    _listHtml() {
        const cache = (typeof DiscoverPane !== 'undefined') ? DiscoverPane.cache() : null;
        // Masthead: title, dateline with freshness, actions. The double
        // rule below it is the page's one piece of newspaper furniture.
        const dateline = [
            new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
            cache?.generatedAt ? 'updated ' + DiscoverPane._ago(cache.generatedAt) : ''
        ].filter(Boolean).join(' &middot; ');
        const head = `
            <div class="news-head">
                <div class="news-masthead">
                    <h2 class="news-title">News</h2>
                    <span class="news-dateline">${dateline}</span>
                </div>
                <div class="news-head-actions">
                    <button class="secondary-btn" type="button" data-news-action="topics">Topics</button>
                    <button class="secondary-btn" type="button" data-news-action="refresh">Refresh</button>
                </div>
            </div>
            <div class="news-rule"></div>`;
        if (!cache) return head;
        const s = DiscoverPane.settings();
        if (!s.enabled || !DiscoverPane._webOn) {
            return head + `<div class="news-empty">News needs the Discover pane turned on (Settings &rsaquo; Appearance) and web access enabled (Settings &rsaquo; AI Assistant &rsaquo; Web Search).</div>`;
        }
        if (!s.interests.length) {
            return head + `<div class="news-empty">Pick some topics to follow.</div>
                <button class="secondary-btn news-empty-btn" type="button" data-news-action="topics">Choose topics</button>`;
        }
        if (!cache.items.length) {
            return head + `<div class="news-empty">No recent headlines yet. They refresh in the background, or use Refresh above.</div>`;
        }
        // "Catch me up" (docs/DISCOVER.md D3): the digest's only reading
        // surface — the pane's button just hands off to this page.
        // DiscoverPane owns generation, storage, and the AI-written label.
        const digest = DiscoverPane._digestHtml(cache);
        this._buildGroups(cache);
        if (!this._groups.length) {
            return head + `<div class="news-empty">Nothing to show right now.</div>`;
        }
        // Front page, not a feed: one hero story sets the scale, a slim
        // Latest rail beside it, then quiet per-topic sections. Everything
        // shown above is excluded from its section — nothing appears twice.
        const loc = new Map();   // url -> {gi, ri, it}
        this._groups.forEach((g, gi) => g.rows.forEach((it, ri) => {
            if (!loc.has(it.url)) loc.set(it.url, { gi, ri, it });
        }));
        const flat = [...loc.values()].map(x => x.it);
        const used = new Set();
        let band = '';
        if (flat.length >= 5) {
            // Hero: the rank pass's top pick when there is one (cache.items
            // keeps boosted rows first), otherwise the newest story.
            let hero = null;
            for (const it of cache.items) {
                if (it.why && loc.has(it.url)) { hero = loc.get(it.url).it; break; }
            }
            if (!hero) hero = flat.slice().sort((a, b) => b.publishedAt - a.publishedAt)[0];
            used.add(hero.url);
            // Latest rail: newest first, spread across topics before any
            // topic repeats (only the hero STORY is excluded, not its
            // topic — with few topics the rail must still mix).
            const byTime = flat.filter(it => !used.has(it.url))
                .sort((a, b) => b.publishedAt - a.publishedAt);
            const latest = [];
            const seenTopic = new Set();
            for (const it of byTime) {
                if (seenTopic.has(it.topic)) continue;
                seenTopic.add(it.topic);
                latest.push(it); used.add(it.url);
                if (latest.length >= this.LATEST_ROWS) break;
            }
            for (const it of byTime) {
                if (latest.length >= this.LATEST_ROWS) break;
                if (used.has(it.url)) continue;
                latest.push(it); used.add(it.url);
            }
            // Two sub-features under the hero keep the band composed
            // instead of leaving a hollow column beside the rail.
            const subs = [];
            for (const it of byTime) {
                if (subs.length >= 2) break;
                if (used.has(it.url)) continue;
                subs.push(it); used.add(it.url);
            }
            band = this._heroBandHtml(hero, subs, latest, loc);
        }
        // Few topics = deeper sections, so the page fills according to
        // what the user follows instead of ending in whitespace.
        const sectionRows = this._groups.length <= 2 ? 6 : this._groups.length <= 4 ? 4 : 3;
        const sections = this._groups.map((g, gi) => this._sectionHtml(g, gi, used, loc, sectionRows))
            .filter(Boolean).join('');
        const foot = cache.ranked
            ? `<div class="news-foot">Ranked for you on this Mac</div>` : '';
        return head + digest + band + `<div class="news-sections">${sections}</div>` + foot;
    },

    _heroBandHtml(hero, subs, latest, loc) {
        const h = loc.get(hero.url);
        const kicker = [hero.topic, hero.why ? 'For you' : '']
            .filter(Boolean).map(x => UIUtils.escapeHtml(x)).join(' &middot; ');
        const meta = [hero.source, hero.publishedAt ? DiscoverPane._ago(hero.publishedAt) : '']
            .filter(Boolean).map(x => UIUtils.escapeHtml(x)).join(' &middot; ');
        const subsHtml = subs.length ? `
            <div class="news-hero-subs">
                ${subs.map(it => {
                    const l = loc.get(it.url);
                    return `
                <button class="news-hero-sub${this._isRead && this._isRead(it.title) ? ' is-read' : ''}" type="button" data-news-g="${l.gi}" data-news-i="${l.ri}">
                    <span class="news-latest-kicker">${UIUtils.escapeHtml(it.topic || '')}</span>
                    <span class="news-hero-sub-title">${UIUtils.escapeHtml(it.title || '')}</span>
                    ${it.why ? `<span class="news-row-why">For you &middot; ${UIUtils.escapeHtml(it.why)}</span>` : ''}
                    <span class="news-latest-meta">${[it.source, it.publishedAt ? DiscoverPane._ago(it.publishedAt) : '']
                        .filter(Boolean).map(x => UIUtils.escapeHtml(x)).join(' &middot; ')}</span>
                </button>`;
                }).join('')}
            </div>` : '';
        const rail = latest.map(it => {
            const l = loc.get(it.url);
            return `
            <div class="news-latest-wrap${this._isRead && this._isRead(it.title) ? ' is-read' : ''}">
                <button class="news-latest-row" type="button" data-news-g="${l.gi}" data-news-i="${l.ri}">
                    <span class="news-latest-kicker">${UIUtils.escapeHtml(it.topic || '')}</span>
                    <span class="news-latest-title">${UIUtils.escapeHtml(it.title || '')}</span>
                    <span class="news-latest-meta">${[it.source, it.publishedAt ? DiscoverPane._ago(it.publishedAt) : '']
                        .filter(Boolean).map(x => UIUtils.escapeHtml(x)).join(' &middot; ')}</span>
                </button>
                <button class="news-row-x" type="button" data-news-action="fewer" data-news-g="${l.gi}" data-news-i="${l.ri}" title="Show fewer like this">&times;</button>
            </div>`;
        }).join('');
        return `
        <div class="news-front">
            <div class="news-hero-col">
                <button class="news-hero${this._isRead && this._isRead(hero.title) ? ' is-read' : ''}" type="button" data-news-g="${h.gi}" data-news-i="${h.ri}">
                    <span class="news-hero-kicker">${kicker}</span>
                    <span class="news-hero-title">${UIUtils.escapeHtml(hero.title || '')}</span>
                    ${hero.why ? `<span class="news-hero-why">For you &middot; ${UIUtils.escapeHtml(hero.why)}</span>` : ''}
                    <span class="news-hero-meta">${meta}</span>
                </button>
                ${subsHtml}
            </div>
            <aside class="news-latest">
                <div class="news-latest-head">The latest</div>
                ${rail}
            </aside>
        </div>`;
    },

    _sectionHtml(g, gi, used, loc, sectionRows) {
        const rows = g.rows.filter(it => !used.has(it.url)).slice(0, sectionRows);
        if (!rows.length) return '';
        const t = UIUtils.escapeHtml(g.topic);
        return `
        <section class="news-section">
            <button class="news-card-topic" type="button" data-news-action="open-topic" data-topic="${t}" title="All ${t} stories">${t}</button>
            ${rows.map((it, i) => this._rowHtml(it, gi, loc.get(it.url).ri, i === 0)).join('')}
            ${g.rows.length > rows.length ? `<button class="news-card-more" type="button" data-news-action="open-topic" data-topic="${t}">All ${g.rows.length} stories &rarr;</button>` : ''}
        </section>`;
    },

    // Topic groups come from the cache's full per-topic lists; pre-topics
    // caches fall back to grouping the pane's capped mix. Rank boosts live
    // on the capped items, so "For you" labels are re-attached by URL, and
    // taste memory (D4) drops dismissed stories.
    _buildGroups(cache) {
        const whyByUrl = new Map(cache.items.filter(x => x.why).map(x => [x.url, x.why]));
        const fewer = DiscoverPane.taste().fewer;
        this._isRead = DiscoverPane.readMatcher();
        const keep = rows => rows
            .filter(it => !DiscoverPane._isDismissed(it.title, fewer))
            .map(it => (!it.why && whyByUrl.get(it.url)) ? { ...it, why: whyByUrl.get(it.url) } : it);
        if (cache.topics.length) {
            this._groups = cache.topics
                .map(t => ({ topic: String(t.topic || 'More'), rows: keep(Array.isArray(t.items) ? t.items : []) }))
                .filter(g => g.rows.length);
        } else {
            const m = new Map();
            for (const it of keep(cache.items)) {
                const key = it.topic || 'More';
                if (!m.has(key)) m.set(key, []);
                m.get(key).push(it);
            }
            this._groups = [...m].map(([topic, rows]) => ({ topic, rows }));
        }
    },

    _rowHtml(it, gi, ri, lead) {
        const meta = [it.source, it.publishedAt ? DiscoverPane._ago(it.publishedAt) : '']
            .filter(Boolean).map(x => UIUtils.escapeHtml(x)).join(' &middot; ');
        const read = this._isRead ? this._isRead(it.title) : false;
        return `
        <div class="news-row-wrap${lead ? ' news-lead-wrap' : ''}${read ? ' is-read' : ''}">
            <button class="news-row${lead ? ' news-lead' : ''}" type="button" data-news-g="${gi}" data-news-i="${ri}">
                <span class="${lead ? 'news-lead-title' : 'news-row-title'}">${UIUtils.escapeHtml(it.title || '')}</span>
                ${it.why ? `<span class="news-row-why">For you &middot; ${UIUtils.escapeHtml(it.why)}</span>` : ''}
                <span class="news-row-meta">${meta}</span>
            </button>
            <button class="news-row-x" type="button" data-news-action="fewer" data-news-g="${gi}" data-news-i="${ri}" title="Show fewer like this">&times;</button>
        </div>`;
    },

    /* ---------- Single-topic drill-in ---------- */

    _topicHtml() {
        if (typeof DiscoverPane === 'undefined') { this._mode = 'list'; return this._listHtml(); }
        this._buildGroups(DiscoverPane.cache());
        const gi = this._groups.findIndex(g => g.topic === this._topic);
        if (gi === -1) { this._mode = 'list'; this._topic = null; return this._listHtml(); }
        const g = this._groups[gi];
        return `
        <div class="news-topic">
            <button class="news-back" type="button" data-news-action="back-all">&larr; All news</button>
            <h2 class="news-topic-title">${UIUtils.escapeHtml(g.topic)}</h2>
            ${g.rows.map((it, ri) => this._rowHtml(it, gi, ri)).join('')}
        </div>`;
    },

    /* ---------- Reader ---------- */

    openReader(item) {
        // Taste memory (D4): choosing to read a story is a signal.
        if (typeof DiscoverPane !== 'undefined') DiscoverPane.recordClick(item);
        this._mode = 'reader';
        this._current = item;
        this._summaryState = { status: 'Reading the article on your Mac…' };
        if (typeof AppManager !== 'undefined' && AppManager.currentApp !== 'news') {
            AppManager.openApp('news');
        }
        this.render();
        this._loadSummary(item);
    },

    _readerHtml() {
        const it = this._current;
        const st = this._summaryState || {};
        const meta = [it.topic, it.source, it.publishedAt ? DiscoverPane._ago(it.publishedAt) : '']
            .filter(Boolean).map(x => UIUtils.escapeHtml(x)).join(' &middot; ');
        const modeNote = {
            article: 'AI summary of the article, written on your Mac',
            coverage: 'AI summary from search coverage — the article itself would not load',
            extract: 'Article extract — add an AI model for a written summary'
        }[st.mode] || '';
        let body;
        if (st.summary) {
            // Model output is markdown (the sanitizing chat formatter renders
            // it); article extracts are raw page text and need honest
            // paragraphing instead — markdown parsing would mangle them.
            const html = st.mode === 'extract'
                ? this._paragraphs(st.summary)
                : ((typeof AgentUI !== 'undefined' && AgentUI.formatContent)
                    ? AgentUI.formatContent(st.summary)
                    : this._paragraphs(st.summary));
            body = `${modeNote ? `<div class="news-summary-note">${UIUtils.escapeHtml(modeNote)}</div>` : ''}
                    <div class="news-summary-body">${html}</div>`;
        } else if (st.error) {
            body = `<div class="news-summary-status">${UIUtils.escapeHtml(st.error)}</div>`;
        } else {
            body = `<div class="news-summary-status news-summary-working">${UIUtils.escapeHtml(st.status || 'Working…')}</div>`;
        }
        const events = Array.isArray(st.events) ? st.events : [];
        const eventsHtml = events.length ? `
            <div class="news-events">
                <div class="news-events-note">Upcoming date${events.length > 1 ? 's' : ''} spotted by AI in this article, check before you rely on it</div>
                ${events.map((ev, i) => {
                    const added = this._eventAdded(ev);
                    return `
                <div class="news-event">
                    <div class="news-event-what">
                        <span class="news-event-title">${UIUtils.escapeHtml(ev.title)}</span>
                        <span class="news-event-when">${UIUtils.escapeHtml(this._eventWhen(ev))}</span>
                    </div>
                    <button class="secondary-btn news-event-add" type="button" data-news-action="add-event" data-idx="${i}"${added ? ' disabled' : ''}>${added ? 'Added to Schedule' : 'Add to Schedule'}</button>
                </div>`;
                }).join('')}
            </div>` : '';
        return `
            <div class="news-reader">
                <button class="news-back" type="button" data-news-action="back">&larr; ${this._topic ? UIUtils.escapeHtml(this._topic) : 'All news'}</button>
                <h1 class="news-reader-title">${UIUtils.escapeHtml(it.title || '')}</h1>
                <div class="news-reader-meta">${meta}</div>
                <div class="news-reader-actions">
                    <button class="primary-btn" type="button" data-news-action="open-article">Open article</button>
                    <button class="secondary-btn" type="button" data-news-action="discuss">Ask about this</button>
                </div>
                ${eventsHtml}
                ${body}
            </div>`;
    },

    // Plain text -> escaped <p> blocks. read_url collapses whitespace to
    // one newline per block, so each non-trivial line is a paragraph;
    // stray short fragments (nav crumbs Readability let through) merge
    // into the following paragraph rather than standing alone.
    _paragraphs(text) {
        const out = [];
        let pending = '';
        for (const raw of String(text || '').split(/\n+/)) {
            const line = raw.trim();
            if (!line) continue;
            if (line.length < 60) { pending += (pending ? ' ' : '') + line; continue; }
            out.push(pending ? pending + ' ' + line : line);
            pending = '';
        }
        if (pending) out.push(pending);
        return out.map(p => `<p>${UIUtils.escapeHtml(p)}</p>`).join('');
    },

    _renderIfReader(item) {
        if (this._mode === 'reader' && this._current === item) this.render();
    },

    /* ---------- Summary pipeline ---------- */

    // Indirections so the test harness can stub what contextBridge won't let
    // it replace.
    _readUrl(url) {
        if (!window.electronSearch?.read) return Promise.resolve({ error: 'unavailable' });
        return window.electronSearch.read(url);
    },
    _searchWeb(query) {
        if (typeof AgentTools !== 'undefined' && AgentTools.handlers?.web_search) {
            return AgentTools.handlers.web_search({ query, maxResults: 5 });
        }
        if (window.electronSearch?.query) return window.electronSearch.query(query, 5);
        return Promise.resolve({ error: 'unavailable' });
    },

    async _loadSummary(item) {
        const key = this._hash(item.url || item.title);
        const cached = this._summaries()[key];
        if (cached && cached.summary) {
            this._summaryState = {
                summary: cached.summary, mode: cached.mode, openUrl: cached.openUrl,
                // Re-validating drops events whose date has since passed.
                events: this._validEvents(cached.events)
            };
            this._renderIfReader(item);
            return;
        }

        // 1. Pull the article onto the user's machine. Google News URLs are
        // redirects — read-url follows them, and its finalUrl becomes the
        // clean link for the Open button.
        const r = await this._readUrl(String(item.url || ''));
        if (this._current !== item) return; // user moved on
        const articleText = (!r?.error && typeof r.text === 'string') ? r.text.trim() : '';
        const openUrl = (r && typeof r.url === 'string' && /^https?:/i.test(r.url)) ? r.url : '';
        if (openUrl) this._summaryState.openUrl = openUrl;

        const hasModel = typeof AgentService !== 'undefined' && AgentService.model
            && typeof LLMLogger !== 'undefined' && window.electronLLM?.chat;

        // 2. Model + real article text → the primary path.
        if (hasModel && articleText.length >= this.MIN_ARTICLE_CHARS) {
            this._summaryState = { status: 'Summarizing on your Mac…', openUrl };
            this._renderIfReader(item);
            const summary = await this._summarize(item.title,
                `ARTICLE TEXT:\n${articleText.slice(0, this.ARTICLE_PROMPT_CHARS)}`);
            if (this._current !== item) return;
            if (summary) {
                this._finish(item, key, { summary, mode: 'article', openUrl });
                // D3 "act": fire-and-forget extraction of upcoming dates —
                // the card appears under the actions when (if) it lands.
                this._extractEvents(item, key, articleText.slice(0, this.ARTICLE_PROMPT_CHARS));
                return;
            }
        }

        // 3. Article unreadable (or summary judged it a stub) → search
        // coverage, when the user has search enabled.
        if (hasModel && DiscoverPane._webOn) {
            this._summaryState = { status: 'Article would not load — checking coverage…', openUrl };
            this._renderIfReader(item);
            try {
                const resp = await this._searchWeb(item.title);
                const results = Array.isArray(resp?.results) ? resp.results : [];
                if (this._current !== item) return;
                if (results.length) {
                    const digest = results.map(x =>
                        `- ${x.title || ''}${x.age ? ` (${x.age})` : ''}: ${String(x.snippet || '').slice(0, 250)}`).join('\n');
                    const summary = await this._summarize(item.title,
                        `SEARCH COVERAGE (snippets from several sources — the article itself could not be read):\n${digest}`);
                    if (this._current !== item) return;
                    if (summary) {
                        this._finish(item, key, { summary, mode: 'coverage', openUrl });
                        return;
                    }
                }
            } catch { /* fall through to the honest endings below */ }
        }

        // 4. No model but readable text → the deterministic extract.
        if (!hasModel && articleText.length >= this.MIN_ARTICLE_CHARS) {
            this._finish(item, key, {
                summary: articleText.slice(0, 1800) + (articleText.length > 1800 ? '…' : ''),
                mode: 'extract',
                openUrl
            });
            return;
        }

        // 5. Nothing worked — say so and leave the link.
        this._summaryState = {
            error: 'This article could not be read here. Use "Open article" to view it in the browser.',
            openUrl
        };
        this._renderIfReader(item);
    },

    // One capped, narrow summarization call. Returns markdown or null.
    // The model is the quality gate for garbage input: consent walls and
    // redirect stubs pass the length check but not a reader's sniff test.
    async _summarize(title, material) {
        try {
            const res = await LLMLogger.call('news-summary', {
                model: AgentService.model,
                messages: [
                    { role: 'system', content: 'You summarize news articles faithfully. Never invent facts that are not in the provided material.' },
                    { role: 'user', content: `Headline: ${title}

${material}

Write a detailed summary a busy reader can trust: two or three short paragraphs, then a line with just **Key points** followed by up to four bullet points with the key facts (numbers, names, dates). Plain markdown, no headline repetition, no preamble. Use ONLY the material above. If the material is not actually article content (a cookie or consent notice, a redirect stub, an error page, unrelated boilerplate), reply with exactly: UNUSABLE` }
                ],
                // Capped call: think:false or a thinking model burns the cap.
                think: false,
                maxTokens: 700,
                options: { temperature: 0.3, num_ctx: AgentService.numCtx || 8192 },
                stream: false,
                jobClass: 'background',
                logTag: 'news-summary'
            });
            if (res?.error) return null;
            const text = String(res?.message?.content || '').trim();
            if (!text || /^UNUSABLE\b/i.test(text)) return null;
            return text;
        } catch { return null; }
    },

    _finish(item, key, entry) {
        this._summaryState = entry;
        this._saveSummary(key, entry);
        this._renderIfReader(item);
    },

    /* ---------- Event extraction (docs/DISCOVER.md D3 "act") ----------
     *
     * After an article summary lands, one narrow structured call looks for
     * concrete upcoming dates (a match, launch, hearing, deadline) so the
     * story can become a schedule item. The model only extracts — nothing
     * is added without the user's click, the card is labeled as AI work,
     * and only real article text is mined (search snippets are too
     * truncated to date things reliably).
     */

    EVENT_MAX: 3,

    async _extractEvents(item, key, articleText) {
        try {
            const today = new Date().toISOString().slice(0, 10);
            const pub = item.publishedAt ? new Date(item.publishedAt).toISOString().slice(0, 10) : today;
            const res = await LLMLogger.call('news-events', {
                model: AgentService.model,
                messages: [
                    { role: 'system', content: 'You extract upcoming dated events and deadlines from news articles. Respond with JSON only, no prose.' },
                    { role: 'user', content: `Today is ${today}. The article was published ${pub}.

ARTICLE TEXT:
${articleText}

Find up to ${this.EVENT_MAX} concrete UPCOMING events or deadlines in this article that a reader might want on their calendar (a match, a launch, a hearing, a filing deadline, an election, a release). Only include events whose calendar date is stated or clearly resolvable from the text, and is today or later. Resolve relative wording ("next Sunday", "later this month") against the publication date. If there are none, return an empty list.

Return JSON exactly like: {"events":[{"title":"<what happens, under 10 words>","date":"YYYY-MM-DD","time":"HH:MM or null"}]}` }
                ],
                format: 'json',
                // Capped call: think:false or a thinking model burns the cap.
                think: false,
                maxTokens: 250,
                options: { temperature: 0.1, num_ctx: AgentService.numCtx || 8192 },
                stream: false,
                jobClass: 'background',
                logTag: 'news-events'
            });
            if (res?.error) return;
            const text = String(res?.message?.content || '')
                .replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
            let parsed = null;
            try { parsed = JSON.parse(text)?.events; } catch { /* malformed = no card */ }
            const events = this._validEvents(parsed);
            if (!events.length) return;
            this._persistEvents(key, events);
            if (this._current === item && this._summaryState?.summary) {
                this._summaryState.events = events;
                this.render();
            }
        } catch { /* the card is optional garnish; the summary already rendered */ }
    },

    // Model output (or a cached copy) -> trusted list: real parseable date,
    // today or later, within a year — a small model does mangle dates.
    _validEvents(list) {
        if (!Array.isArray(list)) return [];
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const horizon = today.getTime() + 400 * 86400e3;
        const out = [];
        for (const e of list) {
            const title = String(e?.title || '').trim().slice(0, 80);
            const date = String(e?.date || '').trim();
            if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
            const d = new Date(date + 'T00:00:00');
            if (Number.isNaN(d.getTime()) || d < today || d.getTime() > horizon) continue;
            const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(e?.time || '')) ? e.time : null;
            out.push({ title, date, time, ...(e.addedId ? { addedId: String(e.addedId) } : {}) });
            if (out.length >= this.EVENT_MAX) break;
        }
        return out;
    },

    _persistEvents(key, events) {
        const all = this._summaries();
        if (!all[key]) return;
        all[key] = { ...all[key], events };
        StorageManager.set(this.SUMMARY_KEY, all);
    },

    // Added means the schedule still has the item — if the user deleted the
    // task, the button comes back rather than pointing at nothing.
    _eventAdded(ev) {
        if (!ev.addedId) return false;
        return (StorageManager.get('schedule')?.scheduleItems || []).some(i => i.id === ev.addedId);
    },

    _eventWhen(ev) {
        const d = new Date(ev.date + 'T00:00:00');
        const s = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        return ev.time ? `${s}, ${ev.time}` : s;
    },

    _addEvent(idx) {
        const it = this._current;
        const st = this._summaryState;
        const ev = st && Array.isArray(st.events) ? st.events[idx] : null;
        if (!it || !ev || this._eventAdded(ev)) return;
        const data = StorageManager.get('schedule') || {};
        const items = data.scheduleItems || [];
        // Validate at write time: nothing that later opens this stored URL
        // should have to remember to check the scheme.
        const rawUrl = st.openUrl || it.url || '';
        const url = /^https?:/i.test(rawUrl) ? rawUrl : '';
        // Same article + same title already in the schedule (added on
        // another Mac — the blob syncs) → adopt it instead of duplicating.
        const norm = ev.title.toLowerCase().replace(/\s+/g, ' ').trim();
        const existing = items.find(x => x.sourceNewsUrl === url
            && String(x.title || '').toLowerCase().replace(/\s+/g, ' ').trim() === norm);
        if (existing) {
            ev.addedId = existing.id;
        } else {
            const id = UIUtils.generateId();
            items.push({
                id,
                title: ev.title,
                startTime: ev.time || '09:00',
                endTime: null,
                notifyBefore: 0,
                repeat: 'none',
                dayOfWeek: null,
                repeatDays: [],
                scheduledDate: ev.date,
                lastCompletedDate: null,
                createdAt: new Date().toISOString(),
                modifiedAt: new Date().toISOString(),
                source: 'news',
                sourceNewsUrl: url,
                sourceNewsTitle: String(it.title || ''),
                reminderDaysBefore: [0],
                reminderStrategy: 'single'
            });
            data.scheduleItems = items;
            StorageManager.set('schedule', data);
            ev.addedId = id;
            UIUtils.showToast('Added to Schedule', 'success');
        }
        this._persistEvents(this._hash(it.url || it.title), st.events);
        if (typeof AppManager !== 'undefined') AppManager.updateStats?.();
        if (typeof ScheduleApp !== 'undefined' && ScheduleApp.scheduleItems) {
            ScheduleApp.loadData();
            ScheduleApp.render();
        }
        this.render();
    },

    /* ---------- Summary cache (machine-local) ---------- */

    _summaries() {
        const d = StorageManager.get(this.SUMMARY_KEY);
        return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
    },

    _saveSummary(key, entry) {
        const all = this._summaries();
        all[key] = { summary: entry.summary, mode: entry.mode, openUrl: entry.openUrl || '', at: Date.now() };
        const keys = Object.keys(all);
        if (keys.length > this.SUMMARY_MAX) {
            keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
            for (const k of keys.slice(0, keys.length - this.SUMMARY_MAX)) delete all[k];
        }
        StorageManager.set(this.SUMMARY_KEY, all);
    },

    // Two independent 32-bit hashes (djb2 + sdbm) — a single 32-bit key
    // made cache collisions (wrong summary shown for a different URL)
    // merely improbable; the pair makes them negligible. Entries under
    // the old single-hash keys just orphan and age out of the cap.
    _hash(s) {
        const str = String(s || '');
        let h1 = 5381, h2 = 0;
        for (let i = 0; i < str.length; i++) {
            const c = str.charCodeAt(i);
            h1 = ((h1 << 5) + h1 + c) >>> 0;
            h2 = (c + (h2 << 6) + (h2 << 16) - h2) >>> 0;
        }
        return 'u' + h1.toString(36) + '-' + h2.toString(36);
    },

    /* ---------- Actions ---------- */

    _openArticle() {
        const it = this._current;
        if (!it) return;
        // Prefer the redirect-resolved URL from read_url over the feed's
        // Google News hop.
        const url = (this._summaryState && this._summaryState.openUrl) || it.url || '';
        if (!/^https?:/i.test(url)) return;
        if (typeof AppManager !== 'undefined' && AppManager.openInBrowse) {
            AppManager.openInBrowse(url, {
                label: 'Back to News',
                onBack: () => AppManager.openApp('news'),
                // Article links land in Browse's reader view by default.
                readerMode: true
            });
        } else if (window.electronAuth?.openExternal) {
            window.electronAuth.openExternal(url);
        }
    },

    // D3 "discuss": a fresh assistant chat seeded with the headline and
    // whatever the reader produced (summary or extract) — same extraContext
    // channel PromptFeed's posts use.
    _discuss() {
        const it = this._current;
        if (!it || typeof AgentService === 'undefined') return;
        const material = (this._summaryState && this._summaryState.summary) || '';
        AppManager.openApp('agent');
        const conv = AgentService.openFreshConversation?.()
            || AgentService.conversations.find(c => c.id === AgentService.activeConversationId);
        if (!conv) return;
        conv.title = `Re: ${it.title}`.slice(0, 80);
        conv.extraContext =
            `This conversation is about a news story the user just read in their News app.\n` +
            `Headline: "${it.title}" (${it.source || 'unknown source'}${it.publishedAt ? ', ' + new Date(it.publishedAt).toISOString().slice(0, 10) : ''}).\n` +
            (material ? `\nWHAT THE USER READ (summary shown in the app):\n${material.slice(0, 5000)}` : '\nNo summary was available; answer from general knowledge and say so.');
        conv.messages.push({
            role: 'assistant',
            content: `Let’s talk about **${it.title}** — I have the summary you just read in my context. What would you like to know?`,
            metadata: {}
        });
        if (AgentService.activeConversationId === conv.id) {
            AgentService.conversation = [...conv.messages];
        }
        AgentService._saveConversations?.();
        if (typeof AgentUI !== 'undefined') {
            AgentUI.renderMessages?.();
            AgentUI.renderHistorySidebar?.();
        }
    }
};

AppManager.register('news', NewsApp);
