/**
 * Discover pane — the right-hand column on Home (docs/DISCOVER.md).
 *
 * D1 (Layer 1): deterministic news plumbing. Real headlines with real
 * publication timestamps and real article URLs, fetched per user-chosen
 * topic via the `discover-news` IPC — which routes by the user's web-access
 * provider choice (Anjadhe Connect relay with server-side topic caching, or
 * direct Google News RSS for BYOK users; direct is also the fallback when
 * Connect is unreachable). No model is involved: headlines are QUOTED from
 * sources, never written by AI (the doc's gimmick-avoidance rule #1), so
 * the pane works with no model configured. Layer 2 (private relevance
 * ranking against local context) comes later and only reorders.
 *
 * The pane exists ONLY while web search is enabled AND the user turned the
 * pane on (Settings › Appearance › Discover pane — opt-in since
 * 2026-07-26); it hides entirely otherwise and re-checks on every poll and
 * return home.
 *
 * Storage:
 *   - `discover-settings` (synced): { enabled, interests: [], location }.
 *   - `discover-cache` (machine-local, in SYNC_EXCLUDE_KEYS): last fetched
 *     items; `v: 2` marks the D1 shape — v1 caches (model-written items)
 *     are ignored, not migrated.
 */
const DiscoverPane = {
    SETTINGS_KEY: 'discover-settings',
    CACHE_KEY: 'discover-cache',
    TASTE_KEY: 'discover-taste',        // synced: the user's private taste file
    TTL_MS: 30 * 60 * 1000,             // refresh at most every 30 minutes
    POLL_MS: 10 * 60 * 1000,            // wall-clock staleness check cadence
    MAX_LIST: 14,                       // most records the pane shows
    MAX_TOPICS: 8,                      // per fetch (matches /v1/news cap)
    TOPIC_MAX: 12,                      // per-topic rows kept for the News app
    STORY_MAX_AGE_MS: 48 * 60 * 60 * 1000, // undated or older stories never render

    PRESET_TOPICS: [
        'Cricket', 'Football', 'Tennis', 'Formula 1',
        'Technology', 'AI', 'Science', 'Business', 'Stock markets',
        'World news', 'US politics', 'India news', 'Movies', 'Health'
    ],

    _busy: false,
    _timer: null,
    // Last-known web-search status. False until the first async check
    // resolves, so the pane starts hidden and reveals itself only when a
    // provider is confirmed.
    _webOn: false,

    // Re-check the search provider and show/hide the whole pane to match.
    // Cheap (settings read over IPC), so it runs on every render and poll —
    // that's what makes the Settings toggle take effect without a reload.
    async _checkWeb() {
        let on = false;
        try {
            const s = await window.electronSearch?.getStatus?.();
            on = !!(s && s.enabled && s.provider);
        } catch { /* treat as off */ }
        const changed = on !== this._webOn;
        this._webOn = on;
        this._applyVisibility();
        if (changed) this._renderIfVisible();
        return on;
    },

    _applyVisibility() {
        const pane = document.getElementById('discover-pane');
        if (pane) pane.hidden = !(this._webOn && this.settings().enabled);
    },

    init() {
        document.getElementById('discover-refresh')
            ?.addEventListener('click', () => this.refresh());
        document.getElementById('discover-prefs')
            ?.addEventListener('click', () => this.openPrefs());
        // Items are re-rendered wholesale; delegate clicks once.
        document.getElementById('discover-list')?.addEventListener('click', (e) => {
            const act = e.target && e.target.closest && e.target.closest('[data-discover-action]');
            if (act) {
                if (act.dataset.discoverAction === 'catchup') {
                    // The digest is a reading surface, not pane furniture:
                    // jump to the News front page and prepare it there.
                    if (typeof NewsApp !== 'undefined') {
                        NewsApp._topic = null;
                        NewsApp._mode = 'list';
                        AppManager.openApp('news');
                        NewsApp.render();
                    }
                    this.catchMeUp();   // no-op if a digest already exists
                }
                else if (act.dataset.discoverAction === 'digest-hide') this.clearDigest();
                else if (act.dataset.discoverAction === 'open-news') AppManager.openApp('news');
                else if (act.dataset.discoverAction === 'fewer') {
                    const it = (this.cache().items || [])[Number(act.dataset.idx)];
                    if (it) this.recordFewer(it);
                }
                return;
            }
            const btn = e.target && e.target.closest && e.target.closest('.discover-item');
            if (!btn) return;
            const items = this.cache().items || [];
            const it = items[Number(btn.dataset.idx)];
            if (it) this.openItem(it);
        });
        this.render();
        // Deferred past first paint so launch work (sync merge, email kick)
        // settles before the first network fetch.
        setTimeout(() => this.tick(), 12000);
        this._timer = setInterval(() => this.tick(), this.POLL_MS);
    },

    settings() {
        const s = StorageManager.get(this.SETTINGS_KEY) || {};
        return {
            // Opt-in since 2026-07-26: off unless the user explicitly enabled
            // it (Settings › Appearance › Discover pane). Existing installs
            // that never touched the toggle go dark too — only a stored
            // enabled:true keeps the pane on.
            enabled: s.enabled === true,
            interests: Array.isArray(s.interests)
                ? s.interests.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim())
                : [],
            location: typeof s.location === 'string' ? s.location.trim() : ''
        };
    },

    // Settings › Appearance › Discover pane. Preserves the user's topic
    // picks — disabling just hides the pane and stops fetching.
    setEnabled(on) {
        const cur = StorageManager.get(this.SETTINGS_KEY) || {};
        StorageManager.set(this.SETTINGS_KEY, { ...cur, enabled: !!on });
        this._applyVisibility();
        if (on) { this.render(); this.tick(); }
    },

    cache() {
        const c = StorageManager.get(this.CACHE_KEY) || {};
        // v1 caches held model-written items with no URLs — ignore them
        // rather than render unverifiable rows.
        if (c.v !== 2) return { generatedAt: 0, route: '', ranked: false, items: [], digest: null };
        return {
            generatedAt: typeof c.generatedAt === 'number' ? c.generatedAt : 0,
            route: typeof c.route === 'string' ? c.route : '',
            ranked: !!c.ranked,
            items: Array.isArray(c.items) ? c.items : [],
            // Full per-topic lists (beyond the pane's cap) for the News
            // app's expandable topic groups. Absent in pre-existing caches.
            topics: Array.isArray(c.topics) ? c.topics : [],
            // "Catch me up" digest for THESE items. It lives in the same
            // blob so a headline refresh (full overwrite) invalidates it.
            digest: (c.digest && typeof c.digest.text === 'string' && c.digest.text)
                ? { text: c.digest.text, at: Number(c.digest.at) || 0 } : null,
            // Today's conditions for the typed location (Open-Meteo),
            // refreshed with the headlines.
            weather: (c.weather && typeof c.weather === 'object'
                && Number.isFinite(c.weather.tempNow)) ? c.weather : null
        };
    },

    /* ---------- Rendering ---------- */

    render() {
        const list = document.getElementById('discover-list');
        const footer = document.getElementById('discover-footer');
        if (!list) return;

        // Fire-and-forget status probe: hides or reveals the pane, and
        // re-renders once if the status flipped since the last look.
        this._checkWeb();
        if (!this._webOn || !this.settings().enabled) return;

        const refreshBtn = document.getElementById('discover-refresh');
        if (refreshBtn) {
            refreshBtn.classList.toggle('discover-refreshing', this._busy);
            refreshBtn.disabled = this._busy;
        }

        const { interests } = this.settings();
        if (!interests.length) {
            list.innerHTML = `
                <div class="discover-empty">Discover content on topics that interest you: sports, news, your city, weather and more.</div>
                <button id="discover-setup-btn" class="secondary-btn discover-setup-btn" type="button">Choose topics</button>`;
            list.querySelector('#discover-setup-btn')
                ?.addEventListener('click', () => this.openPrefs());
            if (footer) footer.textContent = '';
            return;
        }

        const cache = this.cache();
        if (!cache.items.length) {
            list.innerHTML = this._busy
                ? '<div class="discover-empty">Fetching headlines&hellip;</div>'
                : '<div class="discover-empty">No recent headlines yet. They refresh in the background, or use the refresh button above.</div>';
            if (footer) footer.textContent = '';
            return;
        }

        // Taste memory (Layer 4): dismissed stories vanish retroactively —
        // the filter runs at render so a "fewer" click takes effect now,
        // not at the next fetch. Indexes stay tied to the raw cache array.
        const fewer = this.taste().fewer;
        const isRead = this.readMatcher();
        const visible = cache.items
            .map((it, i) => ({ it, i }))
            .filter(({ it }) => !this._isDismissed(it.title, fewer));
        list.innerHTML = this._weatherHtml(cache) + this._paneCatchupHtml(cache) + visible.map(({ it, i }) => {
            const metaBits = [];
            if (it.topic) metaBits.push(UIUtils.escapeHtml(it.topic));
            if (it.source) metaBits.push(UIUtils.escapeHtml(it.source));
            // Real publication time from the feed — never the pane's own
            // pickup time (the v1 "4m ago on a weeks-old story" trap).
            if (it.publishedAt) metaBits.push(UIUtils.escapeHtml(this._ago(it.publishedAt)));
            return `
            <div class="discover-item-wrap${isRead(it.title) ? ' is-read' : ''}">
                <button class="discover-item" type="button" data-idx="${i}" title="Open the article">
                    <span class="discover-item-title">${UIUtils.escapeHtml(it.title || '')}</span>
                    ${it.why ? `<span class="discover-item-why">For you &middot; ${UIUtils.escapeHtml(it.why)}</span>` : ''}
                    ${metaBits.length ? `<span class="discover-item-meta">${metaBits.join(' &middot; ')}</span>` : ''}
                </button>
                <button class="discover-item-x" type="button" data-discover-action="fewer" data-idx="${i}" title="Show fewer like this">&times;</button>
            </div>`;
        }).join('')
            // The pane shows a capped mix; the News app has every topic in
            // full, so always leave a door to it at the bottom.
            + ((typeof NewsApp !== 'undefined')
                ? '<button type="button" class="discover-all-news" data-discover-action="open-news">All news &rarr;</button>'
                : '');

        if (footer) {
            const parts = ['Updated ' + this._ago(cache.generatedAt)];
            // Route transparency: where the topic queries went.
            if (cache.route === 'connect') parts.push('via Anjadhe Connect');
            else if (cache.route === 'direct') parts.push('fetched directly from this Mac');
            if (cache.ranked) parts.push('ranked for you on this Mac');
            if (this._busy) parts.push('refreshing…');
            footer.innerHTML = parts.map(p => UIUtils.escapeHtml(p)).join(' &middot; ');
        }
    },

    // Repaint only when Home is on screen; rendering into a hidden view is
    // wasted work and the next showDashboard() repaints anyway.
    _renderIfVisible() {
        if (document.getElementById('dashboard-view')?.classList.contains('active')) this.render();
    },

    _ago(ts) {
        if (!ts) return 'just now';
        const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
        if (mins < 1) return 'just now';
        if (mins < 60) return mins + 'm ago';
        const hours = Math.round(mins / 60);
        if (hours < 24) return hours + 'h ago';
        return Math.round(hours / 24) + 'd ago';
    },

    /* ---------- Opening items ---------- */

    // Clicking a headline opens the News app's reader (summary before the
    // browser hop — docs/DISCOVER.md D3); the direct-browser paths below
    // survive only as fallbacks for a build without NewsApp.
    openItem(it) {
        if (typeof NewsApp !== 'undefined' && typeof AppManager !== 'undefined') {
            NewsApp.openReader(it);   // records the click itself
            return;
        }
        this.recordClick(it);
        const url = String(it.url || '').trim();
        if (/^https?:/i.test(url)) {
            if (typeof AppManager !== 'undefined' && AppManager.openInBrowse) {
                AppManager.openInBrowse(url, {
                    label: 'Back to Home',
                    onBack: () => AppManager.showDashboard(),
                    // Article links land in Browse's reader view by default.
                    readerMode: true
                });
            } else if (window.electronAuth?.openExternal) {
                window.electronAuth.openExternal(url);
            } else {
                window.open(url, '_blank');
            }
            return;
        }
        const q = String(it.title || '').trim();
        if (!q) return;
        const searchUrl = (typeof BrowseApp !== 'undefined' && BrowseApp._buildSearchUrl)
            ? BrowseApp._buildSearchUrl(q)
            : 'https://duckduckgo.com/?q=' + encodeURIComponent(q);
        if (typeof AppManager !== 'undefined' && AppManager.openInBrowse) {
            AppManager.openInBrowse(searchUrl, { label: 'Back to Home', onBack: () => AppManager.showDashboard() });
        } else if (window.electronAuth?.openExternal) {
            window.electronAuth.openExternal(searchUrl);
        }
    },

    /* ---------- Scheduling ---------- */

    async tick() {
        if (this._busy) return;
        // Poll doubles as the visibility watcher: enabling or disabling web
        // search in Settings shows/hides the pane within one poll (or
        // immediately on the next return home).
        if (!await this._checkWeb()) return;
        const { interests, enabled } = this.settings();
        if (!enabled || !interests.length) return;
        const c = this.cache();
        if (c.generatedAt && (Date.now() - c.generatedAt) < this.TTL_MS) return;
        this._refresh();
    },

    // Manual refresh from the pane header — runs immediately, TTL ignored.
    refresh() {
        if (this._busy) return;
        const { interests } = this.settings();
        if (!interests.length) { this.openPrefs(); return; }
        this._refresh();
    },

    /* ---------- Fetching ---------- */

    // Indirection so tests can stub the fetch (the contextBridge property
    // itself is non-writable).
    _fetchNews(topics) {
        if (!window.electronSearch?.news) return Promise.resolve({ error: 'unavailable' });
        return window.electronSearch.news(topics);
    },

    // Today's conditions for the typed location. Unit follows the system
    // locale (US/Liberia/Myanmar use Fahrenheit). Null on any failure —
    // the pane just has no weather row.
    async _fetchWeather() {
        const { location } = this.settings();
        if (!location || !window.electronSearch?.weather) return null;
        try {
            const unit = /-(US|LR|MM)\b/i.test(String(navigator.language || ''))
                ? 'fahrenheit' : 'celsius';
            const w = await window.electronSearch.weather(location, unit);
            if (!w || w.error || !Number.isFinite(w.tempNow)) return null;
            return { ...w, at: Date.now() };
        } catch { return null; }
    },

    // WMO weather codes -> a short honest phrase.
    _weatherDesc(code) {
        if (code === 0) return 'Clear';
        if (code === 1 || code === 2) return 'Partly cloudy';
        if (code === 3) return 'Overcast';
        if (code === 45 || code === 48) return 'Fog';
        if (code >= 51 && code <= 57) return 'Drizzle';
        if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'Rain';
        if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'Snow';
        if (code >= 95) return 'Thunderstorms';
        return '';
    },

    _weatherHtml(cache) {
        const w = cache.weather;
        // A cleared location leaves stale weather in the cache until the
        // next refresh — hide it right away instead.
        if (!w || !this.settings().location) return '';
        const r = n => Number.isFinite(n) ? Math.round(n) : null;
        const desc = this._weatherDesc(Number.isFinite(w.codeToday) ? w.codeToday : w.codeNow);
        const main = [desc, r(w.tempNow) !== null ? `${r(w.tempNow)}&deg; now` : '']
            .filter(Boolean).join(', ');
        const meta = [
            (r(w.hi) !== null && r(w.lo) !== null) ? `${r(w.hi)}&deg;/${r(w.lo)}&deg; today` : '',
            (Number.isFinite(w.precipProb) && w.precipProb >= 20) ? `${r(w.precipProb)}% rain` : '',
            UIUtils.escapeHtml(w.place || '')
        ].filter(Boolean).join(' &middot; ');
        if (!main && !meta) return '';
        return `
        <div class="discover-weather" title="Today's weather from Open-Meteo, for the location in your Discover topics">
            ${main ? `<span class="discover-weather-main">${main}</span>` : ''}
            ${meta ? `<span class="discover-weather-meta">${meta}</span>` : ''}
        </div>`;
    },

    async _refresh() {
        if (this._busy) return;
        const { interests, location, enabled } = this.settings();
        if (!enabled || !interests.length) return;
        if (!await this._checkWeb()) return;
        this._busy = true;
        this._renderIfVisible();
        try {
            const topics = interests.slice(0, this.MAX_TOPICS - (location ? 1 : 0));
            if (location) topics.push(location);
            // Weather rides the same refresh rhythm as the headlines; a
            // null just means no row (no location, or Open-Meteo down).
            const [res, weather] = await Promise.all([
                this._fetchNews(topics),
                this._fetchWeather()
            ]);
            // Any failure keeps the previous items — a feed hiccup should
            // never blank the pane.
            if (!res || res.error || !Array.isArray(res.topics)) return;

            const now = Date.now();
            // Taste memory: dismissed stories never even enter the cache,
            // so the caps aren't spent on rows nobody will see.
            const fewerList = this.taste().fewer;
            const perTopic = new Map(); // topic -> items, newest first
            for (const t of res.topics) {
                const rows = [];
                for (const it of (Array.isArray(t.items) ? t.items : [])) {
                    const pub = it.publishedAt ? Date.parse(it.publishedAt) : NaN;
                    // Undated stories are unverifiable — the v1 lesson says
                    // never show content whose age can't be proven.
                    if (Number.isNaN(pub)) continue;
                    if (now - pub > this.STORY_MAX_AGE_MS) continue;
                    if (!it.title || !it.url) continue;
                    if (this._isDismissed(it.title, fewerList)) continue;
                    rows.push({
                        title: String(it.title).slice(0, 200),
                        url: String(it.url),
                        source: String(it.source || '').slice(0, 60),
                        topic: String(t.topic || ''),
                        publishedAt: pub
                    });
                }
                rows.sort((a, b) => b.publishedAt - a.publishedAt);
                if (rows.length) perTopic.set(t.topic, rows);
            }

            // Full per-topic lists first (story-deduped within the topic,
            // capped): the News app's topic groups expand into these. The
            // round-robin below consumes the rows, so snapshot now.
            const topicLists = [];
            for (const [topic, rows] of perTopic) {
                const kept = [];
                for (const r of rows) {
                    if (kept.some(k => this._sameStory(k.title, r.title))) continue;
                    kept.push(r);
                    if (kept.length >= this.TOPIC_MAX) break;
                }
                topicLists.push({ topic: String(topic || ''), items: kept });
            }

            // Round-robin across topics (newest first within each) so one
            // hot topic can't flood the pane, then story-level dedup — the
            // same story from many outlets keeps its newest telling.
            const items = [];
            let added = true;
            while (added && items.length < this.MAX_LIST) {
                added = false;
                for (const rows of perTopic.values()) {
                    while (rows.length) {
                        const cand = rows.shift();
                        if (items.some(k => this._sameStory(k.title, cand.title))) continue;
                        items.push(cand);
                        added = true;
                        break;
                    }
                    if (items.length >= this.MAX_LIST) break;
                }
            }

            if (items.length) {
                // Two-phase: recency order paints immediately, then the
                // Layer 2 rank pass (slow on a local model) reorders in
                // place when it lands. Both writes share generatedAt.
                StorageManager.set(this.CACHE_KEY, {
                    v: 2,
                    generatedAt: now,
                    route: res.route || '',
                    items,
                    topics: topicLists,
                    ...(weather ? { weather } : {})
                });
                this._renderIfVisible();
                const ranked = await this._rankItems(items);
                if (ranked !== items) {
                    // A digest written while the rank pass ran describes
                    // these same items (reordered) — carry it over.
                    const digest = StorageManager.get(this.CACHE_KEY)?.digest;
                    StorageManager.set(this.CACHE_KEY, {
                        v: 2,
                        generatedAt: now,
                        route: res.route || '',
                        ranked: true,
                        items: ranked,
                        topics: topicLists,
                        ...(weather ? { weather } : {}),
                        ...(digest ? { digest } : {})
                    });
                }
            }
        } finally {
            this._busy = false;
            this._renderIfVisible();
        }
    },

    /* ---------- Layer 2: private relevance ranking (docs/DISCOVER.md D2) ----
     *
     * The one thing a cloud feed cannot do without surveillance: rank the
     * day's headlines against the user's OWN context — portfolio tickers,
     * upcoming schedule, goals, location — entirely on their chosen model.
     * The model only picks and explains; it never writes content. Boosted
     * rows carry a visible "For you · <reason>" label so the AI's hand is
     * always attributable. No model, no briefing, or a failed call = the
     * recency order stands, silently.
     */

    RANK_MAX_BOOSTS: 4,
    RANK_MIN_ITEMS: 4,   // ranking 2-3 rows is noise, not signal

    // Compact briefing lines from local data. This stays inside the rank
    // prompt on the user-chosen model — the same trust boundary as chat.
    _localBriefing() {
        const lines = [];
        try {
            const shares = {};
            for (const t of (StorageManager.get('portfolio')?.transactions || [])) {
                const sym = String(t.ticker || '').trim().toUpperCase();
                if (!sym) continue;
                const q = Number(t.quantity) || 0;
                shares[sym] = (shares[sym] || 0) + (t.type === 'sell' ? -q : q);
            }
            const held = Object.keys(shares).filter(s => shares[s] > 0.0001).slice(0, 15);
            if (held.length) lines.push('Holds stock in: ' + held.join(', '));
        } catch { /* briefing is best-effort */ }
        try {
            const todayStr = new Date().toISOString().slice(0, 10);
            const horizon = new Date(Date.now() + 14 * 86400e3).toISOString().slice(0, 10);
            const upcoming = (StorageManager.get('schedule')?.scheduleItems || [])
                .filter(t => t && t.title && t.scheduledDate
                    && t.scheduledDate >= todayStr && t.scheduledDate <= horizon)
                .slice(0, 8);
            if (upcoming.length) {
                lines.push('Coming up (next 2 weeks): '
                    + upcoming.map(t => `${t.title} (${t.scheduledDate})`).join('; '));
            }
        } catch { /* best-effort */ }
        try {
            const goals = (StorageManager.get('goals')?.goals || [])
                .filter(g => g && g.title && g.status !== 'completed').slice(0, 6);
            if (goals.length) lines.push('Goals: ' + goals.map(g => g.title).join('; '));
        } catch { /* best-effort */ }
        try {
            // Taste memory (Layer 4): what they actually read, and what
            // they asked to see less of — same trust boundary as the rest
            // of the briefing (never leaves the chosen model).
            const { clicks, fewer } = this.taste();
            const recent = clicks.slice(-5).map(c => c.title.slice(0, 60));
            if (recent.length) lines.push('News stories they recently chose to read: ' + recent.join(' | '));
            const muted = fewer.slice(-4).map(c => c.title.slice(0, 50));
            if (muted.length) lines.push('Asked to see fewer stories like: ' + muted.join(' | '));
        } catch { /* best-effort */ }
        const { location } = this.settings();
        if (location) lines.push('Location: ' + location);
        return lines;
    },

    // Returns the items reordered (boosted rows first, each with a `why`),
    // or the input untouched on any guard or failure.
    async _rankItems(items) {
        if (typeof AgentService === 'undefined' || !AgentService.model) return items;
        if (typeof LLMLogger === 'undefined' || !window.electronLLM?.chat) return items;
        if (!Array.isArray(items) || items.length < this.RANK_MIN_ITEMS) return items;
        const briefing = this._localBriefing();
        if (!briefing.length) return items;
        const list = items.map((it, i) => `${i}. [${it.topic}] ${it.title}`).join('\n');
        try {
            const res = await LLMLogger.call('discover-rank', {
                model: AgentService.model,
                messages: [
                    { role: 'system', content: 'You pick which headlines are personally relevant to a user. Respond with JSON only, no prose.' },
                    { role: 'user', content: `About the user (private, from their own device):
${briefing.join('\n')}

Today's headlines:
${list}

Pick up to ${this.RANK_MAX_BOOSTS} headlines that are clearly MORE relevant to this user than the rest, judged only from the details above (their stocks, plans, goals, location, what they recently read). Never pick a headline resembling ones they asked to see fewer of. If none clearly match, return an empty list.

Return JSON exactly like: {"picks":[{"i":<headline number>,"why":"<reason tied to a user detail, under 8 words>"}]}` }
                ],
                format: 'json',
                // Capped call: without think:false a thinking model burns the
                // whole cap in <think> and content comes back empty.
                think: false,
                maxTokens: 250,
                // num_ctx in lockstep with chat so this background pass
                // reuses the already-loaded runner.
                options: { temperature: 0.1, num_ctx: AgentService.numCtx || 8192 },
                stream: false,
                jobClass: 'background',
                logTag: 'discover-rank'
            });
            if (res?.error) return items;
            const text = String(res?.message?.content || '')
                .replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
            let picks = null;
            try { picks = JSON.parse(text)?.picks; } catch { /* malformed = no boosts */ }
            if (!Array.isArray(picks)) return items;
            const boosts = new Map();
            for (const p of picks) {
                const i = Number(p?.i);
                if (!Number.isInteger(i) || i < 0 || i >= items.length || boosts.has(i)) continue;
                boosts.set(i, String(p?.why || '').slice(0, 60));
                if (boosts.size >= this.RANK_MAX_BOOSTS) break;
            }
            if (!boosts.size) return items;
            const top = [], rest = [];
            items.forEach((it, i) => {
                if (boosts.has(i)) top.push({ ...it, why: boosts.get(i) });
                else rest.push(it);
            });
            return top.concat(rest);
        } catch {
            return items;
        }
    },

    /* ---------- Layer 4: taste memory (docs/DISCOVER.md D4) ----------
     *
     * Clicks and "show fewer like this" dismissals tune the feed over
     * time. The signal file is the user's own preference data — in every
     * other feed product this is the data being sold; here it lives in
     * their store (synced between their Macs) and serves only them.
     * Dismissals apply DETERMINISTICALLY via the same `_sameStory` token
     * match used for dedup — no model decides what gets hidden; the model
     * only sees a compact taste summary inside the private rank briefing.
     */

    TASTE_CLICKS_MAX: 120,
    TASTE_FEWER_MAX: 80,
    TASTE_MAX_AGE_MS: 90 * 86400e3,     // signals expire after ~3 months

    taste() {
        const t = StorageManager.get(this.TASTE_KEY) || {};
        const now = Date.now();
        const fresh = arr => (Array.isArray(arr) ? arr : [])
            .filter(s => s && typeof s.title === 'string' && s.title
                && (now - (Number(s.at) || 0)) < this.TASTE_MAX_AGE_MS);
        return { clicks: fresh(t.clicks), fewer: fresh(t.fewer) };
    },

    _saveTaste(t) {
        StorageManager.set(this.TASTE_KEY, {
            clicks: t.clicks.slice(-this.TASTE_CLICKS_MAX),
            fewer: t.fewer.slice(-this.TASTE_FEWER_MAX)
        });
    },

    recordClick(item) {
        if (!item || !item.title) return;
        const t = this.taste();
        // Re-opening the same story isn't a stronger signal.
        if (t.clicks.slice(-10).some(c => this._sameStory(c.title, item.title))) return;
        t.clicks.push({ title: String(item.title).slice(0, 200), topic: String(item.topic || ''), at: Date.now() });
        this._saveTaste(t);
    },

    recordFewer(item) {
        if (!item || !item.title) return;
        const t = this.taste();
        if (!t.fewer.some(c => this._sameStory(c.title, item.title))) {
            t.fewer.push({ title: String(item.title).slice(0, 200), topic: String(item.topic || ''), at: Date.now() });
            this._saveTaste(t);
        }
        UIUtils.showToast('Showing fewer stories like that');
        // The story disappears from both surfaces right away.
        this._digestNotify();
    },

    // The deterministic gate: a story matching any dismissal is hidden —
    // that exact story and its retellings/follow-ups, not its whole topic.
    _isDismissed(title, fewerList) {
        return fewerList.some(s => this._sameStory(s.title, title));
    },

    /* ---------- Layer 3: "Catch me up" digest (docs/DISCOVER.md D3) ----
     *
     * One button that synthesizes the current headlines into a few
     * sentences — user-initiated (never auto), written on the local model,
     * and always labeled as AI-written (gimmick rule #3). The digest is
     * stored inside `discover-cache` so the next headline refresh discards
     * it along with the items it described. No model = no button; the
     * quoted headlines stand alone (rule #4).
     */

    DIGEST_MIN_ITEMS: 3,     // a digest of one or two rows is just a reword
    _digestBusy: false,

    _canDigest() {
        return typeof AgentService !== 'undefined' && !!AgentService.model
            && typeof LLMLogger !== 'undefined' && !!window.electronLLM?.chat;
    },

    // The cache's pane mix minus dismissed stories — what the user actually
    // sees, and therefore what digests are written from.
    visibleItems(cache) {
        const fewer = this.taste().fewer;
        return cache.items.filter(it => !this._isDismissed(it.title, fewer));
    },

    // The digest block renders ONLY in the News app; the pane just offers
    // the button (below) and hands off, so it never grows scrolly.
    _digestHtml(cache) {
        if (!this._canDigest() || this.visibleItems(cache).length < this.DIGEST_MIN_ITEMS) return '';
        if (cache.digest) {
            return `
            <div class="news-digest">
                <div class="news-digest-note">
                    <span>AI digest of these headlines, written on your Mac</span>
                    <button type="button" class="news-digest-hide" data-news-action="digest-hide" title="Hide digest">Hide</button>
                </div>
                ${this._digestParagraphs(cache.digest.text)}
            </div>`;
        }
        return `<button type="button" class="news-catchup" data-news-action="catchup"${this._digestBusy ? ' disabled' : ''}>${this._digestBusy ? 'Writing your digest&hellip;' : 'Catch me up'}</button>`;
    },

    // The pane's version: a button that hands off to News, never a block.
    _paneCatchupHtml(cache) {
        if (!this._canDigest() || this.visibleItems(cache).length < this.DIGEST_MIN_ITEMS) return '';
        return `<button type="button" class="discover-catchup" data-discover-action="catchup"${this._digestBusy ? ' disabled' : ''}>${this._digestBusy ? 'Writing your digest&hellip;' : 'Catch me up'}</button>`;
    },

    // Digest prose is plain text (the prompt forbids markdown) — escape and
    // paragraph it, never parse it. A leading "Topic:" prefix (the format
    // the prompt asks for) gets bolded deterministically on our side.
    _digestParagraphs(text) {
        return String(text || '').split(/\n+/)
            .map(l => l.trim()).filter(Boolean)
            .map(p => {
                const m = p.match(/^([^:]{2,40}):\s+(.+)$/);
                if (m) return `<p><strong>${UIUtils.escapeHtml(m[1])}:</strong> ${UIUtils.escapeHtml(m[2])}</p>`;
                return `<p>${UIUtils.escapeHtml(p)}</p>`;
            }).join('');
    },

    async catchMeUp() {
        if (this._digestBusy || !this._canDigest()) return;
        const cache = this.cache();
        const items = this.visibleItems(cache);
        if (cache.digest || items.length < this.DIGEST_MIN_ITEMS) return;
        this._digestBusy = true;
        this._digestNotify();
        try {
            const text = await this._writeDigest(items);
            if (text) this._saveDigest(text);
            else UIUtils.showToast('Could not write a digest right now', 'error');
        } finally {
            this._digestBusy = false;
            this._digestNotify();
        }
    },

    // One capped, narrow synthesis call. Returns plain prose or null.
    // Topic-by-topic, one line each — a single mixed narrative across
    // unrelated topics reads as word salad, so the structure forbids it.
    async _writeDigest(items) {
        const byTopic = new Map();
        for (const it of items) {
            const k = it.topic || 'More';
            if (!byTopic.has(k)) byTopic.set(k, []);
            byTopic.get(k).push(it);
        }
        const blocks = [...byTopic].map(([topic, rows]) =>
            `${topic.toUpperCase()}:\n` + rows.map(it => `- ${it.title}`).join('\n')
        ).join('\n\n');
        try {
            const res = await LLMLogger.call('discover-digest', {
                model: AgentService.model,
                messages: [
                    { role: 'system', content: 'You write a brief digest of news headlines. Use ONLY the headlines provided; never add facts they do not contain.' },
                    { role: 'user', content: `Current headlines, grouped by the user's chosen topics:

${blocks}

Catch the user up, topic by topic. For each topic with something notable, write exactly one line: the topic name, a colon, then one or two short sentences summarizing that topic's headlines. Keep every sentence inside its topic — never combine different topics in one sentence, and skip a topic entirely rather than stretching to include it. Every statement must come strictly from a headline above. Plain text: one line per topic, no bullet points, no markdown, no preamble.` }
                ],
                // Capped call: without think:false a thinking model burns the
                // whole cap in <think> and content comes back empty.
                think: false,
                maxTokens: 450,
                options: { temperature: 0.3, num_ctx: AgentService.numCtx || 8192 },
                stream: false,
                jobClass: 'background',
                logTag: 'discover-digest'
            });
            if (res?.error) return null;
            return String(res?.message?.content || '').trim() || null;
        } catch { return null; }
    },

    // Merge-writes so the digest rides the existing cache blob without
    // disturbing items written since we read them.
    _saveDigest(text) {
        const raw = StorageManager.get(this.CACHE_KEY);
        if (!raw || raw.v !== 2) return;
        StorageManager.set(this.CACHE_KEY, { ...raw, digest: { text: String(text), at: Date.now() } });
    },

    clearDigest() {
        const raw = StorageManager.get(this.CACHE_KEY);
        if (raw && raw.digest) {
            const { digest, ...rest } = raw;
            StorageManager.set(this.CACHE_KEY, rest);
        }
        this._digestNotify();
    },

    // The digest shows in two places (pane + News list); repaint whichever
    // is on screen.
    _digestNotify() {
        this._renderIfVisible();
        if (typeof NewsApp !== 'undefined' && NewsApp._mode !== 'reader'
            && document.getElementById('news-view')?.classList.contains('active')) {
            NewsApp.render();
        }
    },

    /* ---------- Story-level dedup ---------- */

    _STOP: new Set([
        'the', 'and', 'for', 'with', 'from', 'into', 'over', 'after', 'amid',
        'says', 'say', 'its', 'his', 'her', 'their', 'this', 'that', 'are',
        'was', 'will', 'has', 'have', 'had', 'been', 'more', 'most',
        'latest', 'today', 'news', 'update', 'updates', 'live', 'breaking',
        'how', 'what', 'when', 'why', 'who'
    ]),

    _titleTokens(t) {
        const out = new Set();
        for (const w of String(t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
            if (w.length > 2 && !this._STOP.has(w)) out.add(w);
        }
        return out;
    },

    // Two headlines about the same story share most substantive words even
    // when reworded, while different stories on the same topic don't.
    // Containment of the smaller token set >= 0.6 marks them as the same.
    _sameStory(a, b) {
        return this._tokensMatch(this._titleTokens(a), this._titleTokens(b));
    },

    _tokensMatch(ta, tb) {
        if (!ta.size || !tb.size) return false;
        let hit = 0;
        for (const w of ta) if (tb.has(w)) hit++;
        return hit / Math.min(ta.size, tb.size) >= 0.6;
    },

    // Read-state check for a whole render pass: click signals double as
    // read marks (a story and its retellings). Token sets are precomputed
    // once so marking ~50 rows against ~100 clicks stays cheap.
    readMatcher() {
        const sets = this.taste().clicks.map(c => this._titleTokens(c.title));
        return (title) => {
            const t = this._titleTokens(title);
            return sets.some(s => this._tokensMatch(t, s));
        };
    },

    /* ---------- Preferences ---------- */

    openPrefs() {
        const s = this.settings();
        const selected = new Set(s.interests.map(t => t.toLowerCase()));
        const customs = s.interests.filter(
            t => !this.PRESET_TOPICS.some(p => p.toLowerCase() === t.toLowerCase()));
        const chip = (label, isSel) =>
            `<button type="button" class="discover-chip${isSel ? ' selected' : ''}" data-topic="${UIUtils.escapeHtml(label)}">${UIUtils.escapeHtml(label)}</button>`;

        const modal = Modal.create({
            title: 'Discover topics',
            className: 'discover-prefs-modal',
            content: `
                <p class="discover-prefs-desc">Pick topics that interest you. Discover shows current headlines about them on your home page.</p>
                <div class="discover-chip-grid" id="discover-chip-grid">
                    ${this.PRESET_TOPICS.map(t => chip(t, selected.has(t.toLowerCase()))).join('')}
                    ${customs.map(t => chip(t, true)).join('')}
                </div>
                <div class="discover-custom-row">
                    <input type="text" id="discover-custom-input" placeholder="Add your own topic, e.g. Chennai city updates" maxlength="60" spellcheck="false">
                    <button type="button" id="discover-custom-add" class="secondary-btn">Add</button>
                </div>
                <label class="discover-loc-row">
                    <span>Location (optional)</span>
                    <input type="text" id="discover-location" placeholder="City, region or country" maxlength="60" spellcheck="false" value="${UIUtils.escapeHtml(s.location)}">
                </label>
                <p class="discover-prefs-hint">Location adds local news to your headlines.</p>
                ${this.taste().fewer.length ? `
                <p class="discover-prefs-hint" id="discover-muted-row">Hidden stories ("show fewer like this"): ${this.taste().fewer.length}.
                    <button type="button" id="discover-muted-reset" class="discover-muted-reset">Show them again</button></p>` : ''}`,
            buttons: [{
                text: 'Save',
                className: 'primary-btn',
                onClick: () => {
                    const grid = modal.body.querySelector('#discover-chip-grid');
                    const interests = [...grid.querySelectorAll('.discover-chip.selected')]
                        .map(b => b.dataset.topic).filter(Boolean);
                    const location = modal.body.querySelector('#discover-location')?.value.trim() || '';
                    const changed = JSON.stringify({ interests, location })
                        !== JSON.stringify({ interests: s.interests, location: s.location });
                    // Merge so fields this modal doesn't own (enabled) survive.
                    const cur = StorageManager.get(this.SETTINGS_KEY) || {};
                    StorageManager.set(this.SETTINGS_KEY, { ...cur, interests, location });
                    modal.close();
                    this.render();
                    // New picks should show up right away, not at the next TTL.
                    if (changed && interests.length) this._refresh();
                }
            }]
        });

        const grid = modal.body.querySelector('#discover-chip-grid');
        grid.addEventListener('click', (e) => {
            const b = e.target.closest('.discover-chip');
            if (b) b.classList.toggle('selected');
        });
        const input = modal.body.querySelector('#discover-custom-input');
        const addCustom = () => {
            const t = (input.value || '').trim();
            if (!t) return;
            const existing = [...grid.querySelectorAll('.discover-chip')]
                .find(b => b.dataset.topic.toLowerCase() === t.toLowerCase());
            if (existing) existing.classList.add('selected');
            else grid.insertAdjacentHTML('beforeend', chip(t, true));
            input.value = '';
            input.focus();
        };
        modal.body.querySelector('#discover-muted-reset')?.addEventListener('click', () => {
            const t = this.taste();
            this._saveTaste({ clicks: t.clicks, fewer: [] });
            modal.body.querySelector('#discover-muted-row')?.remove();
            this._digestNotify();
        });
        modal.body.querySelector('#discover-custom-add')?.addEventListener('click', addCustom);
        input?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); addCustom(); }
        });
    }
};
