/**
 * News — where the user reads the news. Since 2026-07-29 it is the ONLY
 * place: the home Discover pane was removed (docs/DISCOVER.md).
 *
 * NewsFeed (js/apps/news/news-feed.js) owns fetching, the cache, topics
 * and ranking; this file is the UI over it. The reader view is the D3 "read
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
 * per-URL summary cache so re-opening an article is instant. Saved stories
 * live in `news-saved`, which DOES sync: keeping a story is a deliberate act,
 * and the headline cache it came from expires within a day, so the saved list
 * is the only place it survives.
 */
const NewsApp = {
    SUMMARY_KEY: 'news-summaries',
    SUMMARY_MAX: 60,           // cached summaries kept (oldest trimmed)
    MIN_ARTICLE_CHARS: 400,    // under this, read_url got a stub, not an article
    ARTICLE_PROMPT_CHARS: 12000,
    // Bump when the summary prompt changes: cached summaries written by an
    // older prompt are discarded on read rather than outliving it. Entries
    // from before versioning have no `v` and are treated as stale.
    SUMMARY_VERSION: 2,

    SAVED_KEY: 'news-saved',   // synced (see header note)
    SAVED_MAX: 300,

    _mode: 'list',             // 'list' (card grid) | 'topic' | 'saved' | 'search' | 'reader'
    _current: null,            // reader item {title, url, source, topic, publishedAt, why?}
    _summaryState: null,       // {status} while working, {summary, mode, openUrl} when done
    _groups: null,             // rendered groups [{topic, rows}]
    _topic: null,              // drilled-into topic name ('topic' mode)
    _search: '',               // masthead search query ('search' mode while non-empty)
    _returnMode: 'list',       // where the reader's back button goes
    _returnTo: null,           // {label, onBack} when another app opened the reader (Portfolio's holdings news)
    _streamId: null,           // in-flight summary stream, so it can be cancelled

    init() {
        // Headlines are pulled when News opens, not on a background timer —
        // the timer existed to keep the home Discover pane warm, and that
        // pane is gone (2026-07-29). No-ops inside the TTL.
        if (typeof NewsFeed !== 'undefined') NewsFeed.ensureFresh();

        const view = document.getElementById('news-view');
        if (!view || view._wired) return;
        view._wired = true;
        // Favicon avatars: the letter shows until the favicon actually
        // loads, then the img takes the circle. 'load' doesn't bubble, so
        // capture; a failed favicon fires 'error' instead and the letter
        // simply stays.
        view.addEventListener('load', (e) => {
            if (e.target?.classList?.contains('news-post-avatar-img')) {
                e.target.parentElement?.classList.add('has-img');
            }
        }, true);
        view.addEventListener('click', (e) => {
            // Actions resolve before the post's own click: a post is one big
            // open-the-reader button, and the elements inside it that do
            // something else (the topic tag, the hover ×) carry
            // data-news-action and must win over it.
            const act = e.target.closest && e.target.closest('[data-news-action]');
            if (!act) {
                const row = e.target.closest && e.target.closest('[data-news-g]');
                if (row) {
                    const it = this._groups?.[Number(row.dataset.newsG)]?.rows?.[Number(row.dataset.newsI)];
                    if (it) this.openReader(it);
                    return;
                }
                const savedRow = e.target.closest && e.target.closest('[data-news-saved-i]');
                if (savedRow) {
                    const it = this._saved()[Number(savedRow.dataset.newsSavedI)];
                    if (it) this.openReader(it);
                }
                return;
            }
            const action = act.dataset.newsAction;
            if (action === 'back') {
                this._abortStream();
                // Opened from another app: back goes there, not to a News list.
                if (this._returnMode === 'external' && this._returnTo) {
                    const ret = this._returnTo;
                    this._returnTo = null;
                    this._current = null;
                    this._mode = 'list';
                    try { ret.onBack(); } catch (e) { console.warn('[news] return failed:', e?.message); }
                    return;
                }
                // Reader backs out to wherever it was opened from.
                this._mode = this._returnMode === 'saved' ? 'saved'
                    : this._returnMode === 'search' && this._search.trim() ? 'search'
                    : this._returnMode === 'topic' && this._topic ? 'topic' : 'list';
                this._current = null;
                this.render();
            }
            else if (action === 'toggle-rail') this.toggleSidebar();
            else if (action === 'open-topic') { this._topic = act.dataset.topic || ''; this._mode = 'topic'; this.render(); }
            else if (action === 'back-all') { this._topic = null; this._mode = 'list'; this.render(); }
            else if (action === 'open-saved') { this._topic = null; this._mode = 'saved'; this.render(); }
            else if (action === 'save') this._toggleSave();
            else if (action === 'unsave') { this._unsave(this._saved()[Number(act.dataset.newsSavedI)]); this.render(); }
            else if (action === 'topics' && typeof NewsFeed !== 'undefined') NewsFeed.openPrefs();
            else if (action === 'refresh' && typeof NewsFeed !== 'undefined') { NewsFeed.refresh(); setTimeout(() => this.render(), 800); }
            else if (action === 'open-article') this._openArticle();
            else if (action === 'discuss') this._discuss();
            else if (action === 'catchup' && typeof NewsFeed !== 'undefined') NewsFeed.catchMeUp();
            else if (action === 'digest-hide' && typeof NewsFeed !== 'undefined') NewsFeed.clearDigest();
            else if (action === 'add-event') this._addEvent(Number(act.dataset.idx));
            else if (action === 'fewer' && typeof NewsFeed !== 'undefined') {
                const it = this._groups?.[Number(act.dataset.newsG)]?.rows?.[Number(act.dataset.newsI)];
                if (it) NewsFeed.recordFewer(it);
            }
        });

        // Masthead search. Typing repaints ONLY the body and rail — a full
        // render() would replace the input mid-keystroke and drop focus.
        view.addEventListener('input', (e) => {
            const box = e.target.closest && e.target.closest('[data-news-search]');
            if (!box) return;
            // Typing over an open reader leaves it — cancel its summary
            // stream rather than letting it write into a replaced node.
            if (this._mode === 'reader') { this._abortStream(); this._current = null; }
            this._search = box.value;
            this._mode = this._search.trim() ? 'search' : 'list';
            const layout = view.querySelector('.news-layout');
            if (!layout) return;
            layout.querySelector('.news-main').innerHTML =
                this._mode === 'search' ? this._searchHtml() : this._listHtml();
            layout.querySelector('.news-sidebar').innerHTML = this._sidebarHtml();
        });
        view.addEventListener('keydown', (e) => {
            const box = e.target.closest && e.target.closest('[data-news-search]');
            if (!box || e.key !== 'Escape') return;
            box.value = '';
            box.dispatchEvent(new Event('input', { bubbles: true }));
        });
    },

    /**
     * Masthead, then topics rail beside the body.
     *
     * The masthead is rendered HERE rather than inside _listHtml so it
     * survives the drill-in and the reader (both of which used to replace the
     * whole view, taking the page's title with them), and so it stays
     * full-bleed above the rail — the rail's job is to sit under the title,
     * not beside it.
     */
    render() {
        const view = document.getElementById('news-view');
        if (!view) return;
        let body;
        if (this._mode === 'reader' && this._current) body = this._readerHtml();
        else if (this._mode === 'saved') body = this._savedHtml();
        else if (this._mode === 'topic' && this._topic) body = this._topicHtml();
        else if (this._mode === 'search' && this._search.trim()) body = this._searchHtml();
        else { this._mode = 'list'; body = this._listHtml(); }
        view.innerHTML = this._headHtml()
            + `<div class="news-layout${this._sidebarCollapsed() ? ' sidebar-collapsed' : ''}">
                   <aside class="news-sidebar">${this._sidebarHtml()}</aside>
                   <div class="news-main">${body}</div>
               </div>`;
    },

    /* ---------- Topics rail ---------- */

    _sidebarCollapsed() {
        try { return localStorage.getItem('news-sidebar-collapsed') === '1'; } catch { return false; }
    },

    toggleSidebar() {
        try {
            localStorage.setItem('news-sidebar-collapsed', this._sidebarCollapsed() ? '0' : '1');
        } catch { /* ignore */ }
        document.querySelector('#news-view .news-layout')
            ?.classList.toggle('sidebar-collapsed', this._sidebarCollapsed());
    },

    /**
     * The topics you subscribed to, in the order you picked them — NOT the
     * topics that happen to have stories today. A followed topic with nothing
     * new still belongs in the list; dropping it would make the rail flicker
     * between refreshes and hide the fact that you follow it at all.
     */
    _sidebarHtml() {
        if (typeof NewsFeed === 'undefined') return '';
        const s = NewsFeed.settings();
        const savedCount = this._saved().length;
        // Saved stories outlive the headline cache and the topic list, so the
        // rail stays even for someone who follows nothing today.
        if (!s.interests.length && !savedCount) return '';

        // Counts come from the built groups, so they match what a drill-in
        // would actually show (dismissed stories already removed).
        const counts = new Map((this._groups || []).map(g => [g.topic, g.rows.length]));
        const esc = (x) => UIUtils.escapeHtml(x);
        const rows = s.interests.map(t => {
            const n = counts.get(t) || 0;
            return `
            <button class="news-topic-item${this._topic === t ? ' active' : ''}" type="button"
                    data-news-action="open-topic" data-topic="${esc(t)}" title="${esc(t)}">
                <span class="news-topic-name">${esc(t)}</span>
                <span class="news-topic-count">${n || ''}</span>
            </button>`;
        }).join('');

        // All news / Saved are view switches, not topics — their own list
        // above the Topics heading.
        const inSaved = this._mode === 'saved'
            || (this._mode === 'reader' && this._returnMode === 'saved');
        const nav = `
            <div class="news-topic-list news-nav-list">
                <button class="news-topic-item${!inSaved && !this._topic ? ' active' : ''}" type="button" data-news-action="back-all">
                    <span class="news-topic-name">All news</span>
                    <span class="news-topic-count">${(this._groups || []).reduce((a, g) => a + g.rows.length, 0) || ''}</span>
                </button>
                <button class="news-topic-item${inSaved ? ' active' : ''}" type="button" data-news-action="open-saved">
                    <span class="news-topic-name">Saved</span>
                    <span class="news-topic-count">${savedCount || ''}</span>
                </button>
            </div>`;
        if (!s.interests.length) return nav;
        return nav + `<h3 class="sidebar-title">Topics</h3>
            <div class="news-topic-list">
                ${rows}
                <button class="news-topics-manage-link" type="button" data-news-action="topics">Edit topics &rsaquo;</button>
            </div>`;
    },

    /* ---------- List ---------- */

    // Masthead: sidebar toggle, title, dateline with freshness, actions.
    // Rendered by render() so it outlives the drill-in and the reader.
    _headHtml() {
        const cache = (typeof NewsFeed !== 'undefined') ? NewsFeed.cache() : null;
        const dateline = [
            new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
            cache?.generatedAt ? 'updated ' + NewsFeed._ago(cache.generatedAt) : ''
        ].filter(Boolean).join(' &middot; ');
        return `
            <div class="news-head">
                <div class="news-masthead">
                    <button class="email-sidebar-toggle" type="button" data-news-action="toggle-rail" title="Toggle topics sidebar" aria-label="Toggle topics sidebar">&#9776;</button>
                    <h2 class="news-title">News</h2>
                    <span class="news-dateline">${dateline}</span>
                </div>
                <div class="news-head-actions">
                    <input type="search" class="news-search" data-news-search placeholder="Search headlines" aria-label="Search headlines"
                           value="${UIUtils.escapeHtml(this._search)}" spellcheck="false">
                    <button class="icon-btn app-help-btn" data-help-for="news" title="News help" aria-label="News help">?</button>
                    <button class="secondary-btn" type="button" data-news-action="topics">Topics</button>
                    <button class="secondary-btn" type="button" data-news-action="refresh">Refresh</button>
                </div>
            </div>`;
    },

    _listHtml() {
        const cache = (typeof NewsFeed !== 'undefined') ? NewsFeed.cache() : null;
        if (!cache) return '';
        const s = NewsFeed.settings();
        // No topics yet is the FIRST-RUN state — it gets the welcome page
        // (which also carries the web-access note when that is off too),
        // so the web check only stands alone for someone mid-use.
        if (!s.interests.length) return this._welcomeHtml();
        if (!NewsFeed._webOn) {
            return `<div class="news-empty">News needs web access (Settings &rsaquo; AI Assistant &rsaquo; Web Search).</div>`;
        }
        if (!cache.items.length) {
            return `<div class="news-empty">No recent headlines yet. They refresh in the background, or use Refresh above.</div>`;
        }
        // "Catch me up" (docs/DISCOVER.md D3): the digest's only reading
        // surface — the pane's button just hands off to this page.
        // NewsFeed owns generation, storage, and the AI-written label.
        const digest = NewsFeed._digestHtml(cache);
        this._buildGroups(cache);
        if (!this._groups.length) {
            return `<div class="news-empty">Nothing to show right now.</div>`;
        }
        // A timeline, not a front page (2026-08-28 by request): one
        // chronological column of posts, newest first, every story once —
        // a story sitting in two topic lists keeps its first location so
        // clicks and "fewer" still resolve through this._groups.
        const loc = new Map();   // url -> {gi, ri, it}
        this._groups.forEach((g, gi) => g.rows.forEach((it, ri) => {
            if (!loc.has(it.url)) loc.set(it.url, { gi, ri, it });
        }));
        const posts = [...loc.values()]
            .sort((a, b) => (b.it.publishedAt || 0) - (a.it.publishedAt || 0))
            .map(x => this._rowHtml(x.it, x.gi, x.ri, true)).join('');
        const foot = cache.ranked
            ? `<div class="news-foot">Ranked for you on this Mac</div>` : '';
        return `<div class="news-feed">${digest}${posts}${foot}</div>`;
    },

    /**
     * The no-topics blank state is a pitch, not a dead end: what this news
     * page does differently, then the one door in (Choose topics). Every
     * claim here must stay true to docs/DISCOVER.md's hard rules — the
     * model never authors a headline, summaries are grounded and labeled,
     * taste/ranking never leaves this Mac. Update this copy if those change.
     */
    _welcomeHtml() {
        const webOff = typeof NewsFeed !== 'undefined' && !NewsFeed._webOn;
        return UIUtils.appWelcome({
            title: 'Your own front page',
            lede: 'Follow a few topics — a team, your city, an industry — and News builds a front page from real, current headlines. AI helps you read the news; it never writes it.',
            cta: `<button class="primary-btn" type="button" data-news-action="topics">Choose topics to follow</button>`,
            note: webOff ? 'News also needs web access &mdash; turn it on in Settings &rsaquo; AI Assistant &rsaquo; Web Search.' : '',
            rows: [
                ['Real headlines, never AI-written',
                 'Stories come straight from news feeds: quoted headlines, real sources, real timestamps. AI never writes the news here.'],
                ['Read the whole story without leaving',
                 'Open a headline and the article is fetched onto your Mac, then your AI model writes a detailed summary grounded only in that article. The original is always one click away.'],
                ['Ranked for you, on this Mac',
                 'What you read and what you dismiss teach the front page. Your taste never leaves this machine — no tracking, no ad profile.'],
                ['Catch me up',
                 'One digest of what actually changed across your topics since you last looked.'],
                ['Stories become actions',
                 'AI spots upcoming dates in an article — a match, a launch, a deadline — so you can put them on your Schedule, and &ldquo;Ask about this&rdquo; starts a chat grounded in the story itself.']
            ]
        });
    },

    // Topic groups come from the cache's full per-topic lists; pre-topics
    // caches fall back to grouping the pane's capped mix. Rank boosts live
    // on the capped items, so "For you" labels are re-attached by URL, and
    // taste memory (D4) drops dismissed stories.
    _buildGroups(cache) {
        const items = Array.isArray(cache.items) ? cache.items : [];
        const whyByUrl = new Map(items.filter(x => x.why).map(x => [x.url, x.why]));
        const fewer = NewsFeed.taste().fewer;
        this._isRead = NewsFeed.readMatcher();
        const keep = rows => rows
            .filter(it => !NewsFeed._isDismissed(it.title, fewer))
            .map(it => (!it.why && whyByUrl.get(it.url)) ? { ...it, why: whyByUrl.get(it.url) } : it);
        // topics is absent from pre-v2 caches, which Saved can render against.
        if (Array.isArray(cache.topics) && cache.topics.length) {
            this._groups = cache.topics
                .map(t => ({ topic: String(t.topic || 'More'), rows: keep(Array.isArray(t.items) ? t.items : []) }))
                .filter(g => g.rows.length);
        } else {
            const m = new Map();
            for (const it of keep(items)) {
                const key = it.topic || 'More';
                if (!m.has(key)) m.set(key, []);
                m.get(key).push(it);
            }
            this._groups = [...m].map(([topic, rows]) => ({ topic, rows }));
        }
    },

    // A headline as a timeline post: source-initial avatar, then a byline
    // (source · age, plus the topic as a clickable tag that opens that
    // topic's feed), the headline as the post text, and the rank pass's
    // "For you" note when it has one. There is no snippet line — the
    // feeds ship title/source/date only, and nothing on this surface is
    // ever model-written (docs/DISCOVER.md rule #1).
    _rowHtml(it, gi, ri, withTopic = true) {
        const esc = UIUtils.escapeHtml;
        const read = this._isRead ? this._isRead(it.title) : false;
        const head = [
            `<span class="news-post-source">${esc(it.source || this._hostOf(it.url) || 'News')}</span>`,
            it.publishedAt ? `<span class="news-post-time">${esc(NewsFeed._ago(it.publishedAt))}</span>` : ''
        ].filter(Boolean).join(' <span class="news-post-sep">&middot;</span> ')
            + (withTopic && it.topic ? ` ${this._topicTagHtml(it.topic)}` : '');
        return `
        <div class="news-post-wrap${read ? ' is-read' : ''}">
            <button class="news-post" type="button" data-news-g="${gi}" data-news-i="${ri}">
                ${this._avatarHtml(it)}
                <span class="news-post-main">
                    <span class="news-post-head">${head}</span>
                    <span class="news-post-text">${esc(it.title || '')}</span>
                    ${it.why ? `<span class="news-post-why">For you &middot; ${esc(it.why)}</span>` : ''}
                </span>
            </button>
            <button class="news-row-x" type="button" data-news-action="fewer" data-news-g="${gi}" data-news-i="${ri}" title="Show fewer like this">&times;</button>
        </div>`;
    },

    _avatarChar(it) {
        const s = String(it.source || this._hostOf(it.url) || it.topic || '').trim();
        return s ? s[0].toUpperCase() : '·';
    },

    /**
     * The avatar circle: the publisher's favicon when the feed named the
     * publisher's site (the RSS <source url> attribute — the item link
     * itself is a news.google.com redirect, so it can't be used), with the
     * source-initial letter as both placeholder and fallback. Same favicon
     * service Bookmarks already uses. The letter renders first and the img
     * only takes over once it actually loads (the 'load' capture listener
     * in init — CSP blocks inline onerror), so a dead favicon never shows
     * as a broken-image glyph.
     */
    _avatarHtml(it) {
        const domain = this._hostOf(it.sourceUrl || '');
        const img = (domain && domain !== 'news.google.com')
            ? `<img class="news-post-avatar-img" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&amp;sz=64" alt="" loading="lazy">`
            : '';
        return `<span class="news-post-avatar" aria-hidden="true"><span class="news-post-avatar-char">${UIUtils.escapeHtml(this._avatarChar(it))}</span>${img}</span>`;
    },

    // The topic tag on a post — a span, not a button, because the post
    // itself is a button and buttons don't nest; the view's click
    // delegation routes it by data-news-action before the post's own click.
    _topicTagHtml(topic) {
        const t = UIUtils.escapeHtml(topic);
        return `<span class="news-post-topic" role="link" data-news-action="open-topic" data-topic="${t}" title="All ${t} stories">${t}</span>`;
    },

    /* ---------- Search ----------
     *
     * Searches what the page holds: the current headline cache (the last
     * 48 hours of every followed topic) plus Saved stories. It is a filter
     * over real fetched rows, never a web search — the row a hit opens is
     * the same row the topic pages show, so clicks, saves and "fewer"
     * all work unchanged.
     */

    _searchHtml() {
        if (typeof NewsFeed === 'undefined') { this._mode = 'list'; return this._listHtml(); }
        this._buildGroups(NewsFeed.cache());
        const terms = this._search.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const match = (hay) => terms.every(t => hay.includes(t));

        const seen = new Set();
        const hits = [];
        (this._groups || []).forEach((g, gi) => g.rows.forEach((it, ri) => {
            if (!match(`${it.title} ${it.source} ${it.topic}`.toLowerCase())) return;
            if (seen.has(it.url)) return;   // one story can sit in two topic lists
            seen.add(it.url);
            hits.push({ it, gi, ri });
        }));
        hits.sort((a, b) => (b.it.publishedAt || 0) - (a.it.publishedAt || 0));

        const saved = this._saved()
            .map((it, i) => ({ it, i }))
            .filter(({ it }) => match(`${it.title} ${it.source} ${it.topic}`.toLowerCase()))
            .filter(({ it }) => !seen.has(this._savedKeyOf(it)));

        const n = hits.length + saved.length;
        let html = `<div class="news-topic">
            <h2 class="news-topic-title">Results</h2>
            <p class="news-search-note">${n ? `${n} matching stor${n === 1 ? 'y' : 'ies'} in` : 'Nothing matches in'} the current headlines${saved.length ? ' and Saved' : ''}. This searches the last 48 hours of the topics you follow.</p>`;
        html += hits.map(h => this._rowHtml(h.it, h.gi, h.ri, true)).join('');
        if (saved.length) {
            html += `<h3 class="news-search-saved-head">Saved</h3>`
                + saved.map(({ it, i }) => this._savedRowHtml(it, i)).join('');
        }
        return html + '</div>';
    },

    /* ---------- Single-topic drill-in ---------- */

    _topicHtml() {
        if (typeof NewsFeed === 'undefined') { this._mode = 'list'; return this._listHtml(); }
        this._buildGroups(NewsFeed.cache());
        const gi = this._groups.findIndex(g => g.topic === this._topic);
        if (gi === -1) {
            // A topic you follow that has nothing today is a real state, not a
            // mistake — say so and stay put. Bouncing back to All (what this
            // did before the rail existed, when the only way in was a card
            // that could not be empty) reads as a dead click.
            const followed = NewsFeed.settings().interests.includes(this._topic);
            if (!followed) { this._mode = 'list'; this._topic = null; return this._listHtml(); }
            return `
            <div class="news-topic">
                <button class="news-back" type="button" data-news-action="back-all">&larr; All news</button>
                <h2 class="news-topic-title">${UIUtils.escapeHtml(this._topic)}</h2>
                <div class="news-empty">Nothing new under this topic right now. Headlines refresh in the background, or use Refresh above.</div>
            </div>`;
        }
        const g = this._groups[gi];
        return `
        <div class="news-topic">
            <button class="news-back" type="button" data-news-action="back-all">&larr; All news</button>
            <h2 class="news-topic-title">${UIUtils.escapeHtml(g.topic)}</h2>
            ${g.rows.map((it, ri) => this._rowHtml(it, gi, ri, false)).join('')}
        </div>`;
    },

    /* ---------- Saved ----------
     *
     * Keeping a story is the one piece of News that has to outlive the
     * headline cache (which turns over within a day), so saved rows carry
     * their own copy of the item — title, source, topic, the resolved article
     * URL — rather than pointing into a cache that will be gone tomorrow.
     */

    _saved() {
        const d = StorageManager.get(this.SAVED_KEY);
        return Array.isArray(d) ? d : [];
    },

    // Identity is the feed URL (what the cache and the reader both key on),
    // with the title as a fallback for feeds that ship no link.
    _savedKeyOf(item) {
        return String(item?.url || item?.title || '');
    },

    _isSavedItem(item) {
        const k = this._savedKeyOf(item);
        return !!k && this._saved().some(x => this._savedKeyOf(x) === k);
    },

    _toggleSave() {
        const it = this._current;
        if (!it) return;
        if (this._isSavedItem(it)) {
            this._unsave(it);
        } else {
            const k = this._savedKeyOf(it);
            const list = this._saved().filter(x => this._savedKeyOf(x) !== k);
            list.unshift({
                url: String(it.url || ''),
                // The redirect-resolved link when the reader already found it
                // (feed URLs are often Google News hops).
                openUrl: (this._summaryState && this._summaryState.openUrl) || '',
                title: String(it.title || ''),
                source: String(it.source || ''),
                sourceUrl: String(it.sourceUrl || ''),
                topic: String(it.topic || ''),
                publishedAt: it.publishedAt || null,
                savedAt: Date.now()
            });
            StorageManager.set(this.SAVED_KEY, list.slice(0, this.SAVED_MAX));
            UIUtils.showToast('Saved', 'success');
        }
        this.render();
    },

    _unsave(item) {
        const k = this._savedKeyOf(item);
        if (!k) return;
        StorageManager.set(this.SAVED_KEY, this._saved().filter(x => this._savedKeyOf(x) !== k));
        UIUtils.showToast('Removed from Saved', 'info');
    },

    _savedHtml() {
        // Browsing Saved shouldn't blank out the rail's story counts.
        if (typeof NewsFeed !== 'undefined') {
            const cache = NewsFeed.cache();
            if (cache) this._buildGroups(cache);
        }
        const list = this._saved();
        const head = `<h2 class="news-topic-title">Saved</h2>`;
        if (!list.length) {
            return `<div class="news-topic">${head}
                <div class="news-empty">Nothing saved yet. Open a story and use Save to keep it here.</div>
            </div>`;
        }
        return `<div class="news-topic">${head}
            ${list.map((it, i) => this._savedRowHtml(it, i)).join('')}
        </div>`;
    },

    _savedRowHtml(it, i) {
        const esc = UIUtils.escapeHtml;
        const ago = (ts) => (ts && typeof NewsFeed !== 'undefined') ? NewsFeed._ago(ts) : '';
        // Same post shape as the timeline; "saved Nd" rides the byline so
        // the keep date stays visible without a second meta line.
        const head = [
            `<span class="news-post-source">${esc(it.source || this._hostOf(it.url) || 'News')}</span>`,
            it.publishedAt ? `<span class="news-post-time">${esc(ago(it.publishedAt))}</span>` : '',
            it.savedAt ? `<span class="news-post-time">saved ${esc(ago(it.savedAt))}</span>` : ''
        ].filter(Boolean).join(' <span class="news-post-sep">&middot;</span> ')
            + (it.topic ? ` ${this._topicTagHtml(it.topic)}` : '');
        return `
        <div class="news-post-wrap">
            <button class="news-post" type="button" data-news-saved-i="${i}">
                ${this._avatarHtml(it)}
                <span class="news-post-main">
                    <span class="news-post-head">${head}</span>
                    <span class="news-post-text">${esc(it.title || '')}</span>
                </span>
            </button>
            <button class="news-row-x" type="button" data-news-action="unsave" data-news-saved-i="${i}" title="Remove from Saved">&times;</button>
        </div>`;
    },

    /* ---------- Reader ---------- */

    /**
     * @param {object} item {title, url, source, publishedAt, topic}
     * @param {{returnTo?: {label: string, onBack: Function}}} [opts] — set by
     *   another app (Portfolio's holdings news) so the reader's back button
     *   returns THERE instead of to a News list.
     */
    openReader(item, opts = {}) {
        // A summary still streaming for the previous story is dead work now,
        // and on a local model it holds the engine against the one the reader
        // actually wants. Cancel before starting the next.
        this._abortStream();
        // Taste memory (D4): choosing to read a story is a signal.
        if (typeof NewsFeed !== 'undefined') NewsFeed.recordClick(item);
        // Remember the surface behind the reader before replacing it.
        if (opts.returnTo) {
            this._returnMode = 'external';
            this._returnTo = opts.returnTo;
        } else if (this._mode !== 'reader') {
            this._returnTo = null;
            this._returnMode = this._mode === 'saved' ? 'saved'
                : this._mode === 'search' ? 'search'
                : this._topic ? 'topic' : 'list';
        }
        this._mode = 'reader';
        this._current = item;
        this._articleText = '';   // the previous story's text must not leak into this one's discuss
        this._summaryState = { status: 'Reading the article on your Mac…', openUrl: item.openUrl || '' };
        if (typeof AppManager !== 'undefined' && AppManager.currentApp !== 'news') {
            AppManager.openApp('news');
        }
        this.render();
        this._loadSummary(item);
    },

    _readerHtml() {
        const it = this._current;
        const st = this._summaryState || {};
        const meta = [it.topic, it.source, it.publishedAt ? NewsFeed._ago(it.publishedAt) : '']
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
            // While streaming: a caret on the last line, and no Source block
            // yet — it belongs under a finished piece, and drawing it early
            // would have the page jump as the prose grows past it.
            body = `${modeNote ? `<div class="news-summary-note">${UIUtils.escapeHtml(modeNote)}</div>` : ''}
                    <div class="news-summary-body ai-prose${st.streaming ? ' is-streaming' : ''}">${html}</div>
                    ${st.streaming ? '' : this._sourceHtml(st.source)}`;
        } else if (st.error) {
            // Attribution still belongs here — a story we could not read is
            // exactly when the reader wants the link and the timestamp.
            body = `<div class="news-summary-status">${UIUtils.escapeHtml(st.error)}</div>
                    ${this._sourceHtml(st.source)}`;
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
        const backTo = this._returnMode === 'external' && this._returnTo ? UIUtils.escapeHtml(this._returnTo.label || 'Back')
            : this._returnMode === 'saved' ? 'Saved'
            : this._returnMode === 'search' && this._search.trim() ? 'Results'
            : this._returnMode === 'topic' && this._topic ? UIUtils.escapeHtml(this._topic)
            : 'All news';
        const saved = this._isSavedItem(it);
        return `
            <div class="news-reader">
                <button class="news-back" type="button" data-news-action="back">&larr; ${backTo}</button>
                <h1 class="news-reader-title">${UIUtils.escapeHtml(it.title || '')}</h1>
                <div class="news-reader-meta">${meta}</div>
                <div class="news-reader-actions">
                    <button class="primary-btn" type="button" data-news-action="open-article">Open article</button>
                    <button class="secondary-btn" type="button" data-news-action="discuss">Ask about this</button>
                    <button class="secondary-btn news-save-btn${saved ? ' is-saved' : ''}" type="button" data-news-action="save"
                            title="${saved ? 'Remove from Saved' : 'Keep this story in Saved'}">${saved ? '&#9733; Saved' : '&#9734; Save'}</button>
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
        // Summaries written by an older prompt are dropped, not shown — the
        // brief changed, so the cached text is not what the reader would get.
        if (cached && cached.summary && cached.v === this.SUMMARY_VERSION) {
            this._summaryState = {
                summary: cached.summary, mode: cached.mode, openUrl: cached.openUrl,
                source: cached.source,
                // Re-validating drops events whose date has since passed.
                events: this._validEvents(cached.events)
            };
            this._renderIfReader(item);
            return;
        }

        // 1. Pull the article onto the user's machine. Feed links are Google
        // News shells; read-url trades them for the publisher URL, and its
        // returned url becomes the clean link for the Open button.
        const r = await this._readUrl(String(item.url || ''));
        if (this._current !== item) return; // user moved on
        const articleText = (!r?.error && typeof r.text === 'string') ? r.text.trim() : '';
        const openUrl = (r && typeof r.url === 'string' && /^https?:/i.test(r.url)) ? r.url : '';
        if (openUrl) this._summaryState.openUrl = openUrl;
        // Kept in memory for "Ask about this": the discuss chat grounds in
        // the article itself, not just the summary of it. Never persisted —
        // the summaries cache syncs and full texts would bloat it.
        this._articleText = articleText.slice(0, this.ARTICLE_PROMPT_CHARS);

        // Attribution shown under the summary. Page metadata wins over the
        // feed's — it distinguishes an update from the original publication,
        // which the RSS pubDate cannot.
        const source = {
            url: openUrl || String(item.url || ''),
            title: item.title || r?.title || '',
            site: r?.siteName || item.source || this._hostOf(openUrl || item.url),
            publishedAt: r?.publishedAt || item.publishedAt || null,
            updatedAt: r?.updatedAt || null
        };

        const hasModel = typeof AgentService !== 'undefined' && AgentService.model
            && typeof LLMLogger !== 'undefined' && window.electronLLM?.chat;

        // 2. Model + real article text → the primary path.
        if (hasModel && articleText.length >= this.MIN_ARTICLE_CHARS) {
            this._summaryState = { status: 'Summarizing on your Mac…', openUrl };
            this._renderIfReader(item);
            const summary = await this._summarize(item.title,
                `ARTICLE TEXT:\n${articleText.slice(0, this.ARTICLE_PROMPT_CHARS)}`,
                (partial) => this._paintStream(item, partial, 'article', openUrl));
            if (this._current !== item) return;
            if (summary) {
                this._finish(item, key, { summary, mode: 'article', openUrl, source });
                // D3 "act": fire-and-forget extraction of upcoming dates —
                // the card appears under the actions when (if) it lands.
                this._extractEvents(item, key, articleText.slice(0, this.ARTICLE_PROMPT_CHARS));
                return;
            }
        }

        // 3. Article unreadable (or summary judged it a stub) → search
        // coverage, when the user has search enabled.
        if (hasModel && NewsFeed._webOn) {
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
                        `SEARCH COVERAGE (snippets from several sources — the article itself could not be read):\n${digest}`,
                        (partial) => this._paintStream(item, partial, 'coverage', openUrl));
                    if (this._current !== item) return;
                    if (summary) {
                        this._finish(item, key, { summary, mode: 'coverage', openUrl, source });
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
                openUrl,
                source
            });
            return;
        }

        // 5. Nothing worked — say so and leave the link.
        this._summaryState = {
            error: 'This article could not be read here. Use "Open article" to view it in the browser.',
            openUrl,
            source
        };
        this._renderIfReader(item);
    },

    // One capped, narrow summarization call. Returns markdown or null.
    // The model is the quality gate for garbage input: consent walls and
    // redirect stubs pass the length check but not a reader's sniff test.
    //
    // The brief is the user's own: a journalist's write-up with background and
    // insight, grounded strictly in the supplied text. The source line under
    // the summary is rendered by the app from real metadata, never asked of
    // the model — it would invent a plausible URL and date.
    async _summarize(title, material, onText) {
        // Streaming is opt-in per call: pass onText and the summary paints as
        // it is written. Reasoning is deliberately dropped — the chunk
        // callback's second argument tags 'thinking' chunks and we only take
        // the untagged content ones, so a thinking model shows nothing until
        // it starts writing the answer.
        const streaming = typeof onText === 'function';
        const streamId = streaming
            ? `news-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` : undefined;
        if (streamId) this._streamId = streamId;
        try {
            const params = {
                model: AgentService.model,
                messages: [
                    { role: 'system', content: 'You are a news journalist writing for a reader who has not followed this story. You write only from the source material you are given. You never invent facts, numbers, names, dates, or quotes that are not in that material.' },
                    { role: 'user', content: `Headline: ${title}

${material}

Give me a detailed summary of this news with full background, details and insights, in simple language, written like a human journalist, grounded on the information from the source material above. No exaggerations. No filler words. Just facts.

How to write it:
- Open with what happened and why it matters, in plain language.
- Then the background a newcomer needs to follow the story.
- Then the specifics: the numbers, names, dates and quotes that are actually in the material.
- Close with what it means or what happens next, but ONLY where the material supports it. If it does not, leave it out rather than speculating.
- Finish with a line containing just **Key points**, then up to five bullets carrying the hard facts.

Rules: plain markdown, no preamble, do not repeat the headline as a title, do not pad. Use ONLY the material above; if something is not in it, do not write it. Do not write a source, link, or date line at the end - the app adds that itself.

If the material is not actually article content (a cookie or consent notice, a redirect stub, a paywall or sign-in wall, an error page, unrelated boilerplate), reply with exactly: UNUSABLE` }
                ],
                // Capped call: think:false or a thinking model burns the cap.
                // Honoured on the streaming path too (openaiStreamRequest
                // takes `think` and sets enable_thinking:false) — verify that
                // still holds if this ever moves to another backend.
                think: false,
                maxTokens: 1400,
                options: { temperature: 0.3, num_ctx: AgentService.numCtx || 8192 },
                stream: streaming,
                jobClass: 'background',
                logTag: 'news-summary'
            };

            let res;
            if (streaming) {
                let acc = '';
                res = await LLMLogger.callStream('news-summary', { ...params, streamId },
                    (chunk, kind) => {
                        // 'thinking' / 'thinking-done' / 'tool-progress' are
                        // other channels on the same callback. Only prose.
                        if (kind || typeof chunk !== 'string') return;
                        acc += chunk;
                        const shown = this._streamable(acc);
                        if (shown !== null) onText(shown);
                    });
            } else {
                res = await LLMLogger.call('news-summary', params);
            }

            if (res?.error) return null;
            const text = String(res?.message?.content || '').trim();
            if (!text || /^UNUSABLE\b/i.test(text)) return null;
            return text;
        } catch { return null; }
        finally {
            if (streamId && this._streamId === streamId) this._streamId = null;
        }
    },

    // Cancel an in-flight summary stream. A no-op once the stream has
    // settled: main drops the id from activeLLMStreams on resolve, so a late
    // abort simply reports aborted:false.
    _abortStream() {
        const id = this._streamId;
        this._streamId = null;
        if (!id) return;
        try { window.electronLLM?.abortStream?.(id); } catch { /* best-effort */ }
    },

    /**
     * What of a partial stream is safe to paint.
     *
     * The prompt's escape hatch for a consent wall or paywall stub is to reply
     * with exactly UNUSABLE, which makes _summarize return null and hands the
     * article to the coverage path. Streaming that verbatim would flash the
     * word at the reader before it got replaced. So while the text so far is
     * still a possible prefix of the sentinel, paint nothing; the moment it
     * diverges, it is real prose and everything flushes at once.
     *
     * Returns the text to show, or null to keep holding.
     */
    _streamable(acc) {
        const head = acc.trimStart();
        if (!head) return null;
        const probe = head.slice(0, 8).toUpperCase();
        if ('UNUSABLE'.startsWith(probe)) return null;
        return acc;
    },

    /**
     * Paint a partial summary as it streams in.
     *
     * The first chunk needs a full render, to swap the "Summarizing…" status
     * out for the prose container. Every chunk after that patches ONLY that
     * container's innerHTML: re-rendering the view per token would rebuild
     * the topics rail and the masthead sixty times a second and throw away
     * the reader's scroll position.
     *
     * The Source block is deliberately not drawn yet. It is provenance for a
     * finished piece, and the metadata it needs is already known — showing it
     * above a half-written summary would just make the page jump.
     */
    _paintStream(item, partial, mode, openUrl) {
        if (this._current !== item || this._mode !== 'reader') return;
        this._summaryState = { summary: partial, mode, openUrl, streaming: true };

        const body = document.querySelector('#news-view .news-summary-body');
        if (!body) { this.render(); return; }
        body.innerHTML = (typeof AgentUI !== 'undefined' && AgentUI.formatContent)
            ? AgentUI.formatContent(partial)
            : this._paragraphs(partial);
    },

    _finish(item, key, entry) {
        this._summaryState = entry;
        this._saveSummary(key, { ...entry, v: this.SUMMARY_VERSION });
        this._renderIfReader(item);
    },

    _hostOf(url) {
        try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
    },

    // Absolute local time — "2h ago" is fine on a card, but under a summary
    // the reader wants the actual stamp they can quote. Takes either shape:
    // read-url returns ISO strings, the Discover cache stores epoch numbers.
    _stamp(when) {
        if (when == null || when === '') return '';
        const t = typeof when === 'number' ? when : Date.parse(when);
        if (!Number.isFinite(t)) return '';
        return new Date(t).toLocaleString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit'
        });
    },

    // Google News titles often keep a " - Publisher" tail that the feed
    // parser only strips when it matches <source> exactly ("theguardian.com"
    // never matches "The Guardian"). Drop it here too, so the subject line
    // isn't the headline plus a name already on the row above it.
    _cleanSubject(title, site) {
        let s = String(title || '').trim();
        const tails = [site, this._hostOf(site), (site || '').replace(/^the\s+/i, '')]
            .filter(Boolean).map(x => String(x).toLowerCase());
        for (const tail of tails) {
            const lower = s.toLowerCase();
            for (const sep of [' - ', ' | ', ' – ']) {
                if (lower.endsWith(sep + tail)) return s.slice(0, s.length - sep.length - tail.length).trim();
            }
        }
        return s;
    },

    /**
     * Attribution under the summary: subject, source site, timestamp, link.
     * Built from real metadata (the page's own head, else the feed) and never
     * from the model, which would happily invent a plausible URL and date.
     * "Updated" is shown only when the page says it differs from publication.
     */
    _sourceHtml(src) {
        if (!src || !src.url) return '';
        const esc = UIUtils.escapeHtml;
        const rows = [];
        const subject = this._cleanSubject(src.title, src.site);
        if (subject) rows.push(['Subject', esc(subject)]);
        if (src.site) rows.push(['Source', esc(src.site)]);
        const pub = this._stamp(src.publishedAt);
        if (pub) rows.push(['Published', esc(pub)]);
        const upd = this._stamp(src.updatedAt);
        if (upd && upd !== pub) rows.push(['Updated', esc(upd)]);
        // A button, not an <a href="#"> — the view's click delegation never
        // preventDefaults, and the app routes on the hash, so a stray "#"
        // navigation would knock the router off the current app.
        rows.push(['Article', `<button type="button" class="news-source-link" data-news-action="open-article" title="Open in the browser">${esc(src.url)}</button>`]);
        return `
            <div class="news-source">
                <div class="news-source-head">Source</div>
                <dl class="news-source-rows">
                    ${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}
                </dl>
            </div>`;
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

    // Writes an explicit object rather than spreading `entry`, to keep the
    // cache shape bounded. That means every field the reader expects has to
    // be listed HERE: a field added to the entry and not to this line is
    // silently dropped on the way to disk. `v` and `source` were exactly
    // that — v went missing, so the version check on read never matched and
    // every visit re-summarized the same article from scratch.
    _saveSummary(key, entry) {
        const all = this._summaries();
        const prev = all[key];
        all[key] = {
            summary: entry.summary,
            mode: entry.mode,
            openUrl: entry.openUrl || '',
            source: entry.source || null,
            // Events land later, from _extractEvents' own write — keep any
            // already stored rather than blanking them on a re-save.
            events: Array.isArray(entry.events) ? entry.events : prev?.events,
            v: entry.v,
            at: Date.now()
        };
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
        // Google News hop — saved rows carry their own resolved copy, which
        // stands in when this visit's read failed.
        const url = (this._summaryState && this._summaryState.openUrl) || it.openUrl || it.url || '';
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

    // D3 "discuss": a fresh assistant chat seeded with the headline and the
    // best material the reader holds — the ARTICLE TEXT itself when the
    // fetch succeeded, the summary otherwise — same extraContext channel
    // PromptFeed's posts use. The seed also tells the model to reach for
    // web_search / read_url (both core tools, shipped on every turn) for
    // anything the text doesn't answer: this is a CURRENT story, and a
    // model answering follow-ups from training memory is behind by
    // construction. The instruction is conditional on web access actually
    // being on — telling the model to search when the provider is off just
    // manufactures a failed tool call.
    _discuss() {
        const it = this._current;
        if (!it || typeof AgentService === 'undefined') return;
        const st = this._summaryState || {};
        const article = (this._articleText || '').slice(0, 6000);
        const summary = (st.summary || '').slice(0, 5000);
        const url = st.openUrl || it.url || '';
        const webOn = typeof NewsFeed !== 'undefined' && NewsFeed._webOn;
        AppManager.openApp('agent');
        const conv = AgentService.openFreshConversation?.()
            || AgentService.conversations.find(c => c.id === AgentService.activeConversationId);
        if (!conv) return;
        conv.title = `Re: ${it.title}`.slice(0, 80);
        const material = article
            ? `\nARTICLE TEXT (what the user read; may be truncated):\n${article}`
            : summary
                ? `\nWHAT THE USER READ (summary shown in the app):\n${summary}`
                : '\nNo article text was available; say so when it matters.';
        const reach = webOn
            ? `\n\nGround answers about the story in the text above. For anything it does not cover — background, what has happened since, other coverage, fact-checks — use web_search (and read_url on the article URL or a search result) instead of answering from memory alone: this is a current news story and your training data is behind it. Mention when an answer came from a search.`
            : `\n\nGround answers about the story in the text above. Web search is off in this app, so for anything beyond the text answer from general knowledge and say that is what you are doing.`;
        conv.extraContext =
            `This conversation is about a news story the user just read in their News app.\n` +
            `Headline: "${it.title}" (${it.source || 'unknown source'}${it.publishedAt ? ', ' + new Date(it.publishedAt).toISOString().slice(0, 10) : ''}).\n` +
            (url ? `Article URL: ${url}\n` : '') +
            material + reach;
        conv.messages.push({
            role: 'assistant',
            content: article
                ? `Let’s talk about **${it.title}** — I have the article you just read${webOn ? ', and I can search the web for background or newer developments' : ''}. What would you like to know?`
                : `Let’s talk about **${it.title}** — I have the summary you just read${webOn ? ', and I can search the web for background or newer developments' : ''}. What would you like to know?`,
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
