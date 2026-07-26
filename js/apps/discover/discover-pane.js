/**
 * Discover pane — the right-hand column on Home (Twitter/LinkedIn style).
 *
 * A short list of timely, clickable links generated from the user's chosen
 * interest topics (sports, politics, a home city, weather and so on). The
 * whole pane exists ONLY while a web search provider is enabled — without
 * grounding the links would just be model guesses, so the pane hides
 * entirely (and reappears when web search is turned on in Settings; the
 * poll and every return home re-check). The topics are searched and the
 * model curates the freshest stories from real results. A click never
 * trusts a model-written URL — it opens the item as a search in the user's
 * configured search engine (the Browse app's engine setting), so links
 * can't be dead or hallucinated.
 *
 * Storage:
 *   - `discover-settings` (synced): { interests: [], location: '' } — the
 *     user's picks follow them across Macs.
 *   - `discover-cache` (machine-local, listed in SYNC_EXCLUDE_KEYS): the
 *     generated items depend on this Mac's model and are regenerable, so
 *     each machine keeps its own.
 *
 * Refresh policy mirrors PromptFeed: a wall-clock staleness check every few
 * minutes, generation at most every TTL_MS, first pass deferred past launch
 * so it never contends with model prewarm.
 *
 * The pane re-curates every 30 minutes, but web searches are the scarce
 * resource (Anjadhe Connect's free tier is monthly-metered), so search
 * results are cached per topic for SEARCH_TTL_MS and only stale topics are
 * re-searched on a pass. The local LLM call is cheap; the searches aren't.
 */
const DiscoverPane = {
    SETTINGS_KEY: 'discover-settings',
    CACHE_KEY: 'discover-cache',
    TTL_MS: 30 * 60 * 1000,             // re-curation ATTEMPTED at most every 30
                                        // minutes; it actually runs only when new
                                        // search results arrived (see _generate)
    SEARCH_TTL_MS: 2 * 60 * 60 * 1000,  // re-search a topic at most every 2 hours
    POLL_MS: 10 * 60 * 1000,            // wall-clock staleness check cadence
    MAX_FRESH: 8,                       // new items asked of the model per pass
    MAX_LIST: 14,                       // most records the pane keeps and shows
    ITEM_MAX_AGE_MS: 24 * 60 * 60 * 1000, // carried-over items age out after a day
    MAX_TOPICS: 6,                      // topics searched per refresh (quota guard)
    STORY_MAX_AGE_MS: 3 * 24 * 60 * 60 * 1000, // provider-dated stories older than
                                        // this are dropped even if the model picks them

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
            on = !!s?.provider;
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
            const btn = e.target && e.target.closest && e.target.closest('.discover-item');
            if (!btn) return;
            const items = this.cache().items || [];
            const it = items[Number(btn.dataset.idx)];
            if (it) this.openItem(it);
        });
        // Collapse same-story near-duplicates an existing cache accumulated
        // before fuzzy dedup shipped (items are newest-first, so the first
        // occurrence kept is the newest wording).
        this._dedupCache();
        this.render();
        // Deferred past first paint so a cold model load or prewarm isn't
        // contended with at launch (same stagger idea as PromptFeed, later
        // so the two background passes don't start together).
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
    // picks — disabling just hides the pane and stops generation.
    setEnabled(on) {
        const cur = StorageManager.get(this.SETTINGS_KEY) || {};
        StorageManager.set(this.SETTINGS_KEY, { ...cur, enabled: !!on });
        this._applyVisibility();
        if (on) { this.render(); this.tick(); }
    },

    cache() {
        const c = StorageManager.get(this.CACHE_KEY) || {};
        return {
            generatedAt: typeof c.generatedAt === 'number' ? c.generatedAt : 0,
            grounded: !!c.grounded,
            items: Array.isArray(c.items) ? c.items : [],
            // Per-topic search-result cache: { [topic lowercased]: { at, lines: [] } }.
            // Keeps the 30-minute re-curation from re-searching every topic
            // every pass — only topics older than SEARCH_TTL_MS hit the
            // provider again.
            searches: (c.searches && typeof c.searches === 'object') ? c.searches : {}
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
            if (this._busy) {
                list.innerHTML = '<div class="discover-empty">Finding fresh links&hellip;</div>';
            } else if (typeof AgentService === 'undefined' || !AgentService.model) {
                list.innerHTML = '<div class="discover-empty">Links appear here once an AI model is set up.</div>';
            } else {
                list.innerHTML = '<div class="discover-empty">No links yet. They refresh in the background, or use the refresh button above.</div>';
            }
            if (footer) footer.textContent = '';
            return;
        }

        list.innerHTML = cache.items.map((it, i) => {
            const metaBits = [];
            if (it.topic) metaBits.push(UIUtils.escapeHtml(it.topic));
            // Publication time when the provider dated the story; otherwise
            // an honest "added" stamp — the pane's pickup time is NOT the
            // story's age.
            if (it.publishedAt) metaBits.push(UIUtils.escapeHtml(this._ago(it.publishedAt)));
            else if (it.at) metaBits.push('added ' + UIUtils.escapeHtml(this._ago(it.at)));
            return `
            <button class="discover-item" type="button" data-idx="${i}" title="Open as a search">
                <span class="discover-item-title">${UIUtils.escapeHtml(it.title || '')}</span>
                ${metaBits.length ? `<span class="discover-item-meta">${metaBits.join(' &middot; ')}</span>` : ''}
            </button>`;
        }).join('');

        if (footer) {
            const parts = ['Updated ' + this._ago(cache.generatedAt)];
            // Searches failed on the last pass (quota, network) — these are
            // model-written queries rather than curated stories.
            if (!cache.grounded) parts.push('search suggestions');
            if (this._busy) parts.push('refreshing&hellip;');
            footer.innerHTML = UIUtils.escapeHtml(parts[0])
                + parts.slice(1).map(p => ' &middot; ' + p).join('');
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

    // The click contract: open the item as a search in the user's configured
    // search engine. Uses the in-app Browse tab with a back strip (same
    // pattern as feed links); external browser only as a fallback.
    openItem(it) {
        const q = String(it.query || it.title || '').trim();
        if (!q) return;
        let url;
        if (typeof BrowseApp !== 'undefined' && BrowseApp._buildSearchUrl) {
            url = BrowseApp._buildSearchUrl(q);
        } else {
            url = 'https://duckduckgo.com/?q=' + encodeURIComponent(q);
        }
        if (typeof AppManager !== 'undefined' && AppManager.openInBrowse) {
            AppManager.openInBrowse(url, {
                label: 'Back to Home',
                onBack: () => AppManager.showDashboard()
            });
        } else if (window.electronAuth?.openExternal) {
            window.electronAuth.openExternal(url);
        } else {
            window.open(url, '_blank');
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
        // No model yet — skip quietly; the next poll retries once one is set.
        if (typeof AgentService === 'undefined' || !AgentService.model) return;
        const c = this.cache();
        if (c.generatedAt && (Date.now() - c.generatedAt) < this.TTL_MS) return;
        this._generate();
    },

    // Manual refresh from the pane header — the user wants new content NOW,
    // so it bypasses both the TTL and the per-topic search cache.
    refresh() {
        if (this._busy) return;
        const { interests } = this.settings();
        if (!interests.length) { this.openPrefs(); return; }
        if (typeof AgentService === 'undefined' || !AgentService.model) {
            if (typeof UIUtils !== 'undefined') {
                UIUtils.showToast('Set up an AI model first (Settings &rsaquo; AI Assistant)', 'error');
            }
            return;
        }
        this._generate({ forceSearch: true });
    },

    /* ---------- Generation ---------- */

    async _generate(opts = {}) {
        const forceSearch = !!opts.forceSearch;
        if (this._busy) return;
        if (typeof AgentService === 'undefined' || !AgentService.model || !window.electronLLM?.chat) return;
        const { interests, location, enabled } = this.settings();
        if (!enabled || !interests.length) return;

        const topics = interests.slice(0, this.MAX_TOPICS);
        const queries = topics.map(t => ({ topic: t, q: t + ' news today' }));
        if (location) {
            queries.push({ topic: location, q: location + ' local news and weather today' });
        }

        // If every topic's search results are still fresh there is nothing
        // new to curate — re-running the model over the same digest just
        // rewrites the same stories with new words, which read as duplicate
        // items. Wait for new data (or a manual refresh, which forces it).
        const cached = this.cache();
        if (!forceSearch && cached.items.length) {
            const now = Date.now();
            const anyStale = queries.some(({ topic }) => {
                const prev = cached.searches[topic.toLowerCase()];
                return !(prev && Array.isArray(prev.lines) && prev.lines.length
                    && (now - prev.at) < this.SEARCH_TTL_MS);
            });
            if (!anyStale) return;
        }

        this._busy = true;
        this._renderIfVisible();
        try {
            // The pane only exists while a provider is enabled; bail if web
            // search was turned off since the last check (the pane hides).
            if (!await this._checkWeb()) return;

            const prevSearches = cached.searches;
            const searches = {};
            const digest = [];
            let searchUsed = false;
            {
                const now = Date.now();
                // Sequential on purpose: bounded, gentle on the provider, and
                // one failed search never sinks the whole refresh. A topic
                // with results younger than SEARCH_TTL_MS reuses them instead
                // of spending another provider call (unless forced) — that's
                // what keeps the frequent re-curation quota-safe.
                for (const { topic, q } of queries) {
                    const key = topic.toLowerCase();
                    const prev = prevSearches[key];
                    const prevUsable = prev && Array.isArray(prev.lines) && prev.lines.length;
                    if (!forceSearch && prevUsable && (now - prev.at) < this.SEARCH_TTL_MS) {
                        searches[key] = prev;
                        digest.push(...prev.lines);
                        searchUsed = true;
                        continue;
                    }
                    let lines = [];
                    const refs = [];
                    try {
                        const resp = (typeof AgentTools !== 'undefined' && AgentTools.handlers?.web_search)
                            ? await AgentTools.handlers.web_search({ query: q, maxResults: 4 })
                            : await window.electronSearch.query(q, 4);
                        const results = Array.isArray(resp?.results) ? resp.results : [];
                        for (const r of results) {
                            let dom = '';
                            try { dom = new URL(r.url).hostname.replace(/^www\./, ''); } catch { /* keep blank */ }
                            // Age rides along when the provider supplies one
                            // (Brave "2 days ago", Tavily published_date) so
                            // the model can drop stale stories; a Google-style
                            // leading snippet date fills in when it doesn't.
                            const age = String(r.age || r.published_date || '').slice(0, 32)
                                || this._snippetDate(r.snippet);
                            const src = [dom, age].filter(Boolean).join(', ');
                            const snippet = String(r.snippet || '').slice(0, 180);
                            lines.push(`[${topic}] ${r.title || ''}${src ? ' (' + src + ')' : ''} - ${snippet}`);
                            refs.push({ t: r.title || '', age });
                        }
                    } catch { /* fall through to the expired cache below */ }
                    if (!lines.length && prevUsable) {
                        // Failed or empty search: expired results beat none,
                        // and keeping prev.at means we retry next pass.
                        searches[key] = prev;
                        digest.push(...prev.lines);
                        searchUsed = true;
                        continue;
                    }
                    if (lines.length) {
                        searches[key] = { at: now, lines, refs };
                        digest.push(...lines);
                        searchUsed = true;
                    }
                }
            }

            const dateLine = new Date().toDateString();
            const topicLine = topics.join(', ') + (location ? `. The user's location: ${location}` : '');
            let user;
            if (searchUsed) {
                user = `Today is ${dateLine}. The user follows these topics: ${topicLine}.

Fresh web search results:
${digest.join('\n')}

From ONLY the results above, pick up to ${this.MAX_FRESH} items that are clearly CURRENT — published today or within the last day or two. A result's age is shown in parentheses when known: skip anything older, and skip evergreen or undated pages that do not read like fresh news. Returning fewer items is better than padding the list with stale ones. Spread picks across the user's topics and rewrite each as a short headline.`;
            } else {
                user = `Today is ${dateLine}. The user follows these topics: ${topicLine}.

Web search is not available, so instead write ${this.MAX_FRESH} specific web searches the user should run today to catch up on these topics. Make each concrete and time-anchored (for example "India vs England 3rd Test day 2 score").`;
            }
            // The model rewrites headlines, so exact-match dedup can't stop
            // it from re-listing a story it already picked last pass — tell
            // it what the pane already shows.
            const existingTitles = cached.items.map(i => i && i.title).filter(Boolean);
            if (existingTitles.length) {
                user += `

Already shown on the pane (do NOT include these stories again, even reworded):
${existingTitles.map(t => '- ' + t).join('\n')}

Only return stories that are not in that list. Returning fewer items, or an empty list, is fine.`;
            }
            user += `

Return JSON in exactly this shape:
{"items":[{"title":"short headline shown to the user (under 90 characters, plain text)","query":"a web search query that finds this item","topic":"which of the user's topics it belongs to"}]}`;

            const res = await LLMLogger.call('discover', {
                model: AgentService.model,
                messages: [
                    { role: 'system', content: 'You curate a compact "Discover" list of timely items for a personal dashboard. Respond with JSON only, no prose.' },
                    { role: 'user', content: user }
                ],
                format: 'json',
                // Capped call: on thinking models the <think> block alone
                // would eat the whole cap and content comes back empty.
                think: false,
                maxTokens: 1000,
                // num_ctx in lockstep with the chat path so this background
                // pass reuses the already-loaded runner.
                options: { temperature: 0.4, num_ctx: AgentService.numCtx || 8192 },
                stream: false,
                jobClass: 'background',
                logTag: 'discover'
            });
            if (res?.error) throw new Error(res.error);
            let fresh = this._parseItems((res?.message?.content || '').trim());
            // Anchor each item back to the search result it came from (fuzzy
            // title match) to recover the story's REAL published age. Two
            // uses: the meta line shows publication time instead of when the
            // pane picked the item up, and a mechanical guard drops anything
            // the provider dates older than STORY_MAX_AGE_MS — the prompt
            // asks for current-only, but a small model misses some.
            const allRefs = Object.values(searches).flatMap(s => Array.isArray(s?.refs) ? s.refs : []);
            fresh = fresh.filter(it => {
                const ref = allRefs.find(r => r.age && this._sameStory(it.title, r.t));
                if (!ref) return true;
                const ageMs = this._ageToMs(ref.age);
                if (ageMs === null) return true;
                if (ageMs > this.STORY_MAX_AGE_MS) return false;
                it.publishedAt = Date.now() - ageMs;
                return true;
            });
            if (fresh.length) {
                // Fresh items go on top; earlier ones ride below until the
                // list cap or their age pushes them out, so a pass adds to
                // the pane instead of wiping it. Dedup is fuzzy (_sameStory):
                // the model rewords headlines between passes, so an exact
                // title match would let the same story pile up — a reworded
                // fresh item REPLACES its older twin instead.
                const now = Date.now();
                const freshItems = [];
                for (const it of fresh) {
                    if (freshItems.some(d => this._sameStory(d.title, it.title))) continue;
                    it.at = now;
                    freshItems.push(it);
                }
                const carried = this.cache().items.filter(it =>
                    it && it.title
                    && !freshItems.some(f => this._sameStory(f.title, it.title))
                    && (now - (it.at || 0)) < this.ITEM_MAX_AGE_MS);
                StorageManager.set(this.CACHE_KEY, {
                    generatedAt: now,
                    model: res?.model || AgentService.model,
                    grounded: searchUsed,
                    items: freshItems.concat(carried).slice(0, this.MAX_LIST),
                    searches
                });
            } else if (Object.keys(searches).length) {
                // Parse failure: keep the previous items (stale links beat an
                // emptied pane) but persist the search spend so the next pass
                // reuses these results instead of re-buying them.
                const c = StorageManager.get(this.CACHE_KEY) || {};
                StorageManager.set(this.CACHE_KEY, { ...c, searches });
            }
        } catch (err) {
            console.warn('[discover] generation failed:', err?.message || err);
        } finally {
            this._busy = false;
            this._renderIfVisible();
        }
    },

    /* ---------- Story age ---------- */

    // Serper-style snippets often lead with the article date
    // ("Jul 10, 2026 — ..."); recover it when the provider sends no age
    // field. Anchored to the start so body-text dates don't false-match.
    _snippetDate(snippet) {
        const m = String(snippet || '').match(/^([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})/);
        return m ? m[1] : '';
    },

    // "2 hours ago" / "3 weeks ago" / "Jul 10, 2026" / ISO date → age in ms,
    // or null when unparseable.
    _ageToMs(age) {
        const s = String(age || '').trim().toLowerCase();
        if (!s) return null;
        const m = s.match(/(\d+)\s*(minute|min|hour|hr|day|week|month|year)s?\s*ago/);
        if (m) {
            const unit = {
                minute: 60000, min: 60000, hour: 3600000, hr: 3600000,
                day: 86400000, week: 604800000, month: 2592000000, year: 31536000000
            }[m[2]];
            return Number(m[1]) * unit;
        }
        const d = Date.parse(age);
        if (!Number.isNaN(d)) return Math.max(0, Date.now() - d);
        return null;
    },

    /* ---------- Story-level dedup ---------- */

    _dedupCache() {
        const c = StorageManager.get(this.CACHE_KEY);
        if (!c || !Array.isArray(c.items) || c.items.length < 2) return;
        const kept = [];
        for (const it of c.items) {
            if (!it || !it.title) continue;
            if (kept.some(k => this._sameStory(k.title, it.title))) continue;
            kept.push(it);
        }
        if (kept.length !== c.items.length) {
            StorageManager.set(this.CACHE_KEY, { ...c, items: kept });
        }
    },

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
    // when reworded ("day 2 latest score" vs "day two score update"), while
    // different stories on the same topic don't. Containment of the smaller
    // token set >= 0.6 marks them as the same story.
    _sameStory(a, b) {
        const ta = this._titleTokens(a), tb = this._titleTokens(b);
        if (!ta.size || !tb.size) return false;
        let hit = 0;
        for (const w of ta) if (tb.has(w)) hit++;
        return hit / Math.min(ta.size, tb.size) >= 0.6;
    },

    _parseItems(text) {
        if (!text) return [];
        const cleaned = text.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
        let arr = null;
        try {
            const obj = JSON.parse(cleaned);
            arr = Array.isArray(obj) ? obj : (Array.isArray(obj?.items) ? obj.items : null);
        } catch { /* fall through to the lenient scan */ }
        if (!arr && typeof AgentService !== 'undefined' && AgentService._parseFirstJsonArray) {
            arr = AgentService._parseFirstJsonArray(cleaned);
        }
        if (!Array.isArray(arr)) return [];
        const seen = new Set();
        const out = [];
        for (const it of arr) {
            if (!it || typeof it !== 'object') continue;
            const title = String(it.title || '').trim().slice(0, 140);
            if (!title) continue;
            const key = title.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                title,
                query: String(it.query || '').trim().slice(0, 200) || title,
                topic: String(it.topic || '').trim().slice(0, 40)
            });
            if (out.length >= this.MAX_FRESH) break;
        }
        return out;
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
                <p class="discover-prefs-desc">Pick topics that interest you. Discover shows current content about them on your home page.</p>
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
                <p class="discover-prefs-hint">Location adds local news and weather alerts to your links.</p>`,
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
                    if (changed && interests.length) this._generate();
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
        modal.body.querySelector('#discover-custom-add')?.addEventListener('click', addCustom);
        input?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); addCustom(); }
        });
    }
};
