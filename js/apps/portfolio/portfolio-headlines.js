/**
 * PortfolioHeadlines — "Current headlines": what CNBC is running right now,
 * summarized by the user's AI model, on the All Accounts page
 * (`#portfolio-headlines`, under the daily brief) and on a ticker page
 * (`#portfolio-ticker-headlines`, under the business profile). The brief's
 * sibling with a shorter clock: the brief is once a day, this is the last
 * ten minutes.
 *
 * Laws:
 *  - OFF UNTIL ASKED FOR. Settings › Portfolio › "Current headlines from
 *    CNBC" (`PortfolioApp.headlinesEnabled()`, default false). Off means not
 *    fetched, not written and not shown — a ten-minute read left on screen
 *    from yesterday is worse than none.
 *  - GROUNDED, not recalled. The model is handed the headline list main
 *    fetched (js/main/cnbc-headlines.js — CNBC's section RSS feeds, plus
 *    CNBC's own site search for the symbol on a ticker page) and may cite
 *    nothing else. The pure `headlineSheet` is pinned by
 *    tests/portfolio-headlines-test.js.
 *  - EVERY TEN MINUTES, WHILE IT IS ON SCREEN. A one-minute tick rewrites
 *    the section that is visible once its read is ten minutes old; nothing
 *    runs for a page nobody is looking at, and a return after longer
 *    rewrites at once. When CNBC's list has not changed since the last
 *    read, the tick only re-stamps "checked" — no model call for the same
 *    headlines. "Refresh now" rewrites on demand, changed or not.
 *  - DESCRIBES, never prescribes, like the brief. At All Accounts the held
 *    symbols ride along (so "for your holdings" can be said) and that makes
 *    it a Portfolio read: consent follows DocTidy/PortfolioBrief — auto when
 *    the model is on this Mac or the Portfolio class may leave, otherwise a
 *    button naming the destination, and the click is the consent.
 *  - MACHINE-LOCAL. localStorage `portfolio-headlines-cache`, keyed 'all' or
 *    by symbol; never the synced portfolio blob.
 */
const PortfolioHeadlines = {
    SOURCE: 'portfolio-headlines',
    CACHE_KEY: 'portfolio-headlines-cache',
    COLLAPSED_KEY: 'portfolio-headlines-collapsed',
    EXPANDED_KEY: 'portfolio-headlines-expanded',
    REFRESH_MS: 10 * 60 * 1000,
    TICK_MS: 60 * 1000,
    MARKET_LINES: 30,
    MARKET_LINES_TICKER: 15,
    SYMBOL_LINES: 12,
    HOLDINGS_IN_PROMPT: 40,
    LIST_ROWS: 8,
    MAX_OUTPUT_TOKENS: 900,
    MAX_CACHED: 40,
    OFF_ERROR: 'Turned off in Settings › Portfolio ("Current headlines from CNBC").',

    _cache: null,
    _inflight: new Map(),     // subject → Promise
    _partial: new Map(),      // subject → text so far
    _listeners: new Map(),    // subject → Set<fn>
    _timer: null,
    _unlisten: {},            // slot ('all' | 'ticker') → unsubscribe

    /* ---------- storage ---------- */

    cache() {
        if (!this._cache) {
            try { this._cache = JSON.parse(localStorage.getItem(this.CACHE_KEY) || 'null') || {}; }
            catch { this._cache = {}; }
        }
        return this._cache;
    },
    _save() {
        const c = this.cache();
        // Bounded: a symbol visited once does not keep its read forever.
        const keys = Object.keys(c).filter(k => k !== 'all');
        if (keys.length > this.MAX_CACHED) {
            keys.sort((a, b) => (c[a]?.at || 0) - (c[b]?.at || 0))
                .slice(0, keys.length - this.MAX_CACHED).forEach(k => delete c[k]);
        }
        try { localStorage.setItem(this.CACHE_KEY, JSON.stringify(c)); } catch { /* cache only */ }
    },
    get(subject) { return this.cache()[subject] || null; },

    /** 'all', or the symbol a ticker page is about (an option reads as its underlying). */
    subjectFor(ticker) {
        if (!ticker) return 'all';
        if (ticker === '__CASH__') return null;
        try { return PortfolioApp.optionMeta(ticker)?.underlying || String(ticker).toUpperCase(); }
        catch { return String(ticker).toUpperCase(); }
    },

    /** When this subject's read was last settled: written, checked, or failed. */
    lastTouched(entry) {
        if (!entry) return 0;
        return Math.max(entry.at || 0, entry.checkedAt || 0, entry.errorAt || 0);
    },
    // When this session started. A failure saved by an EARLIER session (the
    // app was offline, or updated without a restart) is retried at once
    // rather than waited out: the ten-minute hold is there to stop a retry
    // storm within one session, not to carry an old error across a relaunch.
    _bootAt: Date.now(),
    isDue(entry, now = Date.now(), bootAt = this._bootAt) {
        if (entry?.errorAt && entry.errorAt >= Math.max(entry.at || 0, entry.checkedAt || 0) && entry.errorAt < bootAt) return true;
        return now - this.lastTouched(entry) >= this.REFRESH_MS;
    },

    /* ---------- policy (the PortfolioBrief shape) ---------- */

    settingOn() {
        try { return PortfolioApp.headlinesEnabled(); } catch { return false; }
    },
    available() {
        return typeof AgentService !== 'undefined' && !!AgentService.model
            && typeof LLMLogger !== 'undefined' && typeof LLMLogger.callStream === 'function';
    },
    autoAllowed() {
        if (!this.available()) return false;
        if (typeof CloudPrivacy === 'undefined') return true;
        return !CloudPrivacy.leavesFor(this.SOURCE) || CloudPrivacy.allowsFor('portfolio', this.SOURCE);
    },
    destination() {
        try { return (typeof CloudPrivacy !== 'undefined' && CloudPrivacy.leavesFor(this.SOURCE)) ? (CloudPrivacy.destinationFor(this.SOURCE) || 'your AI model') : null; }
        catch { return null; }
    },
    _entryModel() {
        try { return AgentService.entryForSource?.(this.SOURCE) ?? AgentService.getDefaultEntry?.() ?? null; }
        catch { return null; }
    },
    _modelLabel() {
        try {
            const entry = this._entryModel();
            if (entry?.engine === 'anjadhe' && AgentService.anjadheEntryLabel) return AgentService.anjadheEntryLabel(entry);
            return entry?.label || entry?.model || AgentService.model || 'your AI model';
        } catch { return 'your AI model'; }
    },
    _numCtx() {
        try {
            const entry = this._entryModel();
            const n = AgentService.entryNumCtx ? AgentService.entryNumCtx(entry) : (AgentService.numCtx || 8192);
            return (Number.isFinite(n) && n > 0) ? n : 8192;
        } catch { return 8192; }
    },
    _chatBusy() {
        try { return (AgentService.getActiveStreamingConvIds?.() || []).length > 0; } catch { return false; }
    },

    /* ---------- the headline sheet (pure; Node-tested) ---------- */

    ago(ts, now = Date.now()) {
        const t = typeof ts === 'number' ? ts : Date.parse(ts || '');
        if (!Number.isFinite(t)) return '';
        const mins = Math.max(0, Math.round((now - t) / 60000));
        if (mins < 60) return mins < 1 ? 'just now' : `${mins}m ago`;
        const hours = Math.round(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        return `${Math.round(hours / 24)}d ago`;
    },

    /** The identity of a headline list: its URLs, in order. Same list, same read. */
    signature(items) {
        return (items || []).map(it => String(it.url || '').replace(/[?#].*$/, '')).join('\n');
    },

    /**
     * The lines the model may cite.
     *   subject    'all' or a symbol
     *   name       company name for a symbol ('' when unknown)
     *   market     [{title, summary, section, publishedAt}]  CNBC section feeds
     *   symbolNews [{…}]                                       CNBC search for the symbol
     *   holdings   ['AAPL', …]                                 All Accounts only
     */
    headlineSheet({ subject = 'all', name = '', market = [], symbolNews = [], holdings = [], now = Date.now() } = {}) {
        const lines = [];
        const row = (it) => {
            const bits = [it.section ? `[${it.section}]` : '', it.title, this.ago(it.publishedAt, now) ? `(${this.ago(it.publishedAt, now)})` : ''].filter(Boolean).join(' ');
            lines.push(`- ${bits}${it.summary ? ` — ${it.summary}` : ''}`);
        };
        const isAll = subject === 'all';
        if (!isAll) {
            lines.push(`CNBC stories mentioning ${subject}${name ? ` (${name})` : ''}:`);
            if (symbolNews.length) symbolNews.slice(0, this.SYMBOL_LINES).forEach(row);
            else lines.push('- None found on CNBC right now.');
            lines.push('');
        }
        lines.push('CNBC headlines right now (newest first):');
        const cap = isAll ? this.MARKET_LINES : this.MARKET_LINES_TICKER;
        if (market.length) market.slice(0, cap).forEach(row);
        else lines.push('- None could be read.');
        if (isAll && holdings.length) {
            lines.push('', `The reader holds: ${holdings.slice(0, this.HOLDINGS_IN_PROMPT).join(', ')}`);
        }
        return {
            text: lines.join('\n'),
            count: Math.min(market.length, cap) + (isAll ? 0 : Math.min(symbolNews.length, this.SYMBOL_LINES))
        };
    },

    _systemPrompt(subject) {
        const isAll = subject === 'all';
        const sections = isAll ? [
            'The big picture — two to four sentences on what dominates the news right now.',
            'What is moving markets — up to five bullets, each one story or theme from the list and why it matters to investors.',
            'For your holdings — only headlines that name, or plainly bear on, a symbol the reader holds, each tied to that symbol. Omit this section entirely when none do.'
        ] : [
            `${subject} in the news — what CNBC's stories mentioning it say about it right now. Some name it only in passing; say so rather than treating them as stories about it. When the list has none, or none is really about it, say in one sentence that CNBC has nothing specific on it at the moment.`,
            'The market around it — up to four bullets from the wider headlines that bear on this company, its industry or its kind of stock. Omit the section when nothing does.',
            'Bottom line — one or two sentences.'
        ];
        return [
            'You summarize the headlines CNBC is running right now for one individual investor. Plain English, in Markdown, short.',
            'Use exactly these sections, in this order. Each heading is "## " followed by the section title (the words before the dash); the text after the dash says what it covers:',
            ...sections.map((s, i) => `${i + 1}. ${s}`),
            '',
            'Rules:',
            '- Only the headlines on the list exist. Never invent a story, a number, a quote or a date; when something is not on the list, do not mention it.',
            '- Say how fresh a story is where it matters, using its age from the list (e.g. "2h ago").',
            '- Describe, never prescribe: no advice to buy, sell, trim or add.',
            '- No tables, no disclaimers, no offers to help further. When the summary is complete, stop.'
        ].join('\n');
    },

    /* ---------- the run ---------- */

    _holdingSymbols() {
        try {
            PortfolioApp.loadData?.();
            const seen = new Set(); const out = [];
            PortfolioApp.computeHoldings().slice().sort((a, b) => (b.currentValue || 0) - (a.currentValue || 0)).forEach(h => {
                const s = this.subjectFor(h.ticker);
                if (s && !seen.has(s)) { seen.add(s); out.push(PortfolioApp.displayTicker(s)); }
            });
            return out;
        } catch { return []; }
    },
    _nameOf(subject) {
        try { return (typeof PortfolioTickers !== 'undefined' && PortfolioTickers.nameOf(subject)) || ''; } catch { return ''; }
    },
    /** The company's name, from the app's caches or one Yahoo lookup. */
    async _companyName(subject) {
        const known = this._nameOf(subject);
        if (known) return known;
        try {
            const r = await window.electronNet?.fetchYahooQuoteSummary?.(subject, ['price']);
            const p = r?.price || null;
            return String(p?.longName || p?.shortName || '').trim();
        } catch { return ''; }
    },
    /**
     * What a headline would call the company: "Apple Inc." → "Apple",
     * "Micron Technology, Inc." → "Micron Technology" and "Micron". A name
     * of three words or more is only matched whole — "Vanguard" alone
     * would claim every Vanguard story for VTI. Pure; Node-tested.
     */
    nameWords(name) {
        const core = String(name || '')
            .replace(/\(.*?\)/g, ' ')
            .replace(/,?\s+(Inc|Incorporated|Corp|Corporation|Co|Company|Ltd|Limited|plc|PLC|N\.?V|S\.?A|AG|SE|Holdings?|Group|Class [A-C]|ETF|Trust|Fund)\.?(?=\s|,|$)/gi, ' ')
            .replace(/^The\s+/i, '')
            .replace(/[\s,]+/g, ' ').trim();
        if (!core) return [];
        const words = core.split(' ');
        const out = [core];
        if (words.length === 2 && words[0].length >= 4) out.push(words[0]);
        return out;
    },

    /**
     * The subject's current read. Fetches CNBC; when the list is the same
     * one the last read was written from (and this is not `force`), only
     * re-stamps `checkedAt`. `manual: true` is a click (consent given).
     */
    async ensure(subject = 'all', { manual = false, force = false } = {}) {
        if (!subject) return { error: 'Nothing to summarize.' };
        if (!this.settingOn()) return { error: this.OFF_ERROR, off: true };
        if (this._inflight.has(subject)) return this._inflight.get(subject);
        if (!this.available()) return { error: 'No AI model is set up (Settings › AI Assistant).' };
        if (!manual && !this.autoAllowed()) return { error: 'Portfolio data may not leave this Mac on its own.', needsConsent: true };
        const run = this._run(subject, { force }).finally(() => { this._inflight.delete(subject); this._partial.delete(subject); });
        this._inflight.set(subject, run);
        this._emit(subject, { started: true });
        return run;
    },

    async _run(subject, { force }) {
        const isAll = subject === 'all';
        const name = isAll ? '' : await this._companyName(subject);
        let r;
        try {
            r = await window.electronNet?.fetchCnbcHeadlines?.(isAll ? {} : { symbol: subject, names: this.nameWords(name) });
        } catch (e) {
            // A main process older than this renderer (updated, then Cmd+R —
            // which reloads the page but not main.js) has no handler yet.
            const msg = String(e?.message || '');
            r = { error: /No handler registered/i.test(msg)
                ? 'Quit and reopen nenva to finish turning this on.'
                : (msg || 'CNBC could not be reached right now.') };
        }
        if (!r || r.error) return this._fail(subject, (r && r.error) || 'CNBC could not be reached right now.');
        const symbolNews = Array.isArray(r.symbolItems) ? r.symbolItems : [];
        // A story on the symbol is listed once, under the symbol.
        const own = new Set(symbolNews.map(it => this.signature([it])));
        const market = (Array.isArray(r.items) ? r.items : []).filter(it => !own.has(this.signature([it])));
        if (!market.length && !symbolNews.length) return this._fail(subject, 'CNBC returned no current headlines.');
        const listed = isAll ? market.slice(0, this.MARKET_LINES)
            : [...symbolNews.slice(0, this.SYMBOL_LINES), ...market.slice(0, this.MARKET_LINES_TICKER)];
        const sig = this.signature(listed);
        const have = this.get(subject);
        if (!force && have?.text && have.sig === sig) {
            have.checkedAt = Date.now();
            delete have.error; delete have.errorAt;
            this._save();
            this._emit(subject, { entry: have });
            return have;
        }
        const holdings = isAll ? this._holdingSymbols() : [];
        const sheet = this.headlineSheet({ subject, name, market, symbolNews, holdings });
        const system = this._systemPrompt(subject);
        const now = new Date();
        const user = `It is ${now.toLocaleString()}. Summarize ${isAll ? 'the current CNBC headlines for me' : `what CNBC is saying about ${subject} and the market around it`}.\n\nHEADLINES (from cnbc.com, fetched just now):\n${sheet.text}`;
        const numCtx = this._numCtx();
        const promptTokens = Math.ceil((system.length + user.length) / 3.2);
        const numPredict = Math.max(400, Math.min(this.MAX_OUTPUT_TOKENS, numCtx - promptTokens - 200));
        const params = {
            model: AgentService.model,
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            keep_alive: AgentService.keepAlive,
            think: false,
            options: { temperature: 0.3, repeat_penalty: 1.1, repeat_last_n: 256, num_predict: numPredict, num_ctx: numCtx },
            logTag: this.SOURCE,
            logDetail: isAll ? 'All accounts' : subject
        };
        let text = '';
        let lastPaint = 0;
        const onChunk = (chunk, event) => {
            if (event || typeof chunk !== 'string') return;
            text += chunk;
            this._partial.set(subject, text);
            const t = Date.now();
            if (t - lastPaint > 400) { lastPaint = t; this._emit(subject, { partial: text }); }
        };
        let response;
        try { response = await LLMLogger.callStream(this.SOURCE, params, onChunk); }
        catch (e) { return this._fail(subject, e.message || String(e)); }
        if (response && response.error) return this._fail(subject, String(response.error).slice(0, 300));
        const clean = text.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        if (!clean) return this._fail(subject, 'The model returned no text.');
        const entry = {
            at: Date.now(), checkedAt: Date.now(), model: this._modelLabel(), text: clean, sig,
            headlines: listed.slice(0, 40).map(it => ({ title: it.title, url: it.url, section: it.section || '', publishedAt: it.publishedAt }))
        };
        this.cache()[subject] = entry;
        this._save();
        this._emit(subject, { entry });
        return entry;
    },

    // A failed run keeps the last good read and records the error on it.
    _fail(subject, error) {
        const prev = this.get(subject);
        const entry = Object.assign({}, prev || { text: '' }, { error, errorAt: Date.now() });
        this.cache()[subject] = entry;
        this._save();
        this._emit(subject, { entry });
        return { error, entry };
    },

    _emit(subject, ev) {
        const set = this._listeners.get(subject);
        if (!set) return;
        for (const fn of [...set]) { try { fn(ev); } catch { /* a listener is a courtesy */ } }
    },
    _listen(subject, fn) {
        if (!this._listeners.has(subject)) this._listeners.set(subject, new Set());
        this._listeners.get(subject).add(fn);
        return () => this._listeners.get(subject)?.delete(fn);
    },

    /** BackgroundWork descriptor: null when idle. */
    writing() {
        if (!this._inflight.size) return null;
        const s = [...this._inflight.keys()][0];
        return { current: s === 'all' ? 'All accounts' : PortfolioApp.displayTicker(s) };
    },

    /* ---------- the ten-minute clock ---------- */

    /** The section on screen right now, as {subject, render}, or null. */
    _visible() {
        const shown = (el) => !!(el && el.isConnected && el.offsetParent !== null);
        const t = document.getElementById('portfolio-ticker-headlines');
        if (shown(t) && PortfolioApp.viewingTicker && PortfolioApp.viewingTicker !== '__CASH__') {
            const ticker = PortfolioApp.viewingTicker;
            return { subject: this.subjectFor(ticker), render: () => this.renderForTicker(ticker) };
        }
        const a = document.getElementById('portfolio-headlines');
        if (shown(a) && PortfolioApp.currentAccountFilter === 'all') {
            return { subject: 'all', render: () => this.renderForOverview() };
        }
        return null;
    },

    _startClock() {
        if (this._timer) return;
        this._timer = setInterval(() => this._tick(), this.TICK_MS);
    },
    _stopClock() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    },

    _tick() {
        if (!this.settingOn()) { this._stopClock(); return; }
        const v = this._visible();
        if (!v) { this._stopClock(); return; }       // the next render restarts it
        if (typeof document !== 'undefined' && document.hidden) return;
        if (!this.autoAllowed() || this._inflight.has(v.subject) || this._chatBusy()) return;
        if (!this.isDue(this.get(v.subject))) { v.render(); return; }   // keeps "checked Nm ago" honest
        this.ensure(v.subject).catch(() => {});
    },

    /* ---------- rendering ---------- */

    _expanded() { try { return localStorage.getItem(this.EXPANDED_KEY) === '1'; } catch { return false; } },
    _setExpanded(on) { try { localStorage.setItem(this.EXPANDED_KEY, on ? '1' : '0'); } catch { /* per-Mac */ } },
    _collapsed() { try { return localStorage.getItem(this.COLLAPSED_KEY) === '1'; } catch { return false; } },
    _setCollapsed(on) { try { localStorage.setItem(this.COLLAPSED_KEY, on ? '1' : '0'); } catch { /* per-Mac */ } },

    _timeLabel(at) {
        if (!at) return '';
        try { return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); } catch { return ''; }
    },

    _html(md) {
        return (typeof AgentUI !== 'undefined' && typeof AgentUI.formatContent === 'function')
            ? AgentUI.formatContent(md) : `<p>${AppManager.escapeHtml(md)}</p>`;
    },

    renderForOverview() {
        this._render({ slot: 'all', elId: 'portfolio-headlines', subject: 'all',
            stillHere: () => PortfolioApp.currentAccountFilter === 'all',
            rerender: () => this.renderForOverview(),
            back: () => { AppManager.openApp('portfolio'); PortfolioApp.setScope('all'); } });
    },

    renderForTicker(ticker) {
        const subject = this.subjectFor(ticker);
        this._render({ slot: 'ticker', elId: 'portfolio-ticker-headlines', subject,
            stillHere: () => PortfolioApp.viewingTicker === ticker,
            rerender: () => this.renderForTicker(ticker),
            back: () => { AppManager.openApp('portfolio'); PortfolioApp.openTickerDetail(ticker); } });
    },

    /**
     * Paint what is cached, then ask for a fresh read when this one is ten
     * minutes old (auto when allowed), streaming into place while the page
     * still shows the same subject.
     */
    _render({ slot, elId, subject, stillHere, rerender, back }) {
        const el = document.getElementById(elId);
        if (!el) return;
        if (this._unlisten[slot]) { this._unlisten[slot](); this._unlisten[slot] = null; }
        if (!this.settingOn()) { this._stopClock(); el.innerHTML = ''; return; }
        if (!subject) { el.innerHTML = ''; return; }
        const title = subject === 'all' ? 'Current headlines · CNBC' : `Current headlines · ${AppManager.escapeHtml(PortfolioApp.displayTicker(subject))} on CNBC`;
        if (!this.available()) {
            el.innerHTML = `<div class="portfolio-profile-head"><h4 class="portfolio-ticker-section-title">${title}</h4></div><p class="portfolio-news-empty">A summary of CNBC’s current headlines appears here once an AI model is set up (Settings › AI Assistant).</p>`;
            return;
        }
        const paint = (state = {}) => {
            if (!el.isConnected || !stillHere()) return;
            el.innerHTML = this._sectionHtml(subject, title, state);
            this._bind(el, subject, rerender, back);
        };
        const entry = this.get(subject);
        const running = this._inflight.has(subject);
        paint({ entry, partial: running ? (this._partial.get(subject) || '') : null, running });
        this._unlisten[slot] = this._listen(subject, (ev) => {
            if (ev.started) paint({ entry: this.get(subject), partial: '', running: true });
            else if (ev.partial != null) paint({ entry: this.get(subject), partial: ev.partial, running: true });
            else paint({ entry: ev.entry || this.get(subject), running: false });
        });
        this._startClock();
        if (!running && this.isDue(entry) && this.autoAllowed()) this.ensure(subject).catch(() => {});
    },

    _sectionHtml(subject, title, { entry, partial, running }) {
        const esc = AppManager.escapeHtml;
        const expanded = this._expanded();
        const dest = this.destination();
        const withDest = dest ? ` with ${esc(dest)}` : '';
        let meta = '', body = '', actions = '', dim = false;
        if (running) {
            meta = partial ? `Summarizing with ${esc(this._modelLabel())}…` : 'Reading CNBC…';
            if (partial) body = this._html(partial);
            else if (entry?.text) { body = this._html(entry.text); dim = true; }
        } else if (entry?.text) {
            const checked = entry.checkedAt && entry.checkedAt - entry.at > 60 * 1000
                ? ` · no new headlines as of ${esc(this._timeLabel(entry.checkedAt))}` : '';
            meta = `Written ${esc(this.ago(entry.at))} by ${esc(entry.model || 'your AI model')}${checked}`;
            body = this._html(entry.text);
            dim = this.isDue(entry) && !this.autoAllowed();
        }
        if (!running && entry?.error && (!entry.text || (entry.errorAt || 0) > (entry.checkedAt || 0))) {
            meta = `${meta ? meta + ' · ' : ''}Could not refresh: ${esc(entry.error)}`;
        }
        if (!running) {
            if (!entry?.text && !this.autoAllowed()) {
                actions = `<button type="button" class="portfolio-profile-btn" data-hl-refresh>Summarize the headlines${withDest}</button>`;
            } else {
                actions = `<button type="button" class="portfolio-profile-btn" data-hl-refresh title="Read CNBC again and write a fresh summary">Refresh now${withDest}</button>`;
            }
        }
        if (!body && !running && !actions) return '';
        const foldable = body && !running;
        const toggle = foldable ? `<button type="button" class="portfolio-profile-toggle" data-hl-toggle>${expanded ? 'Show less' : 'Read the full summary'}</button>` : '';
        const heads = (!running && Array.isArray(entry?.headlines)) ? entry.headlines.slice(0, this.LIST_ROWS) : [];
        const list = heads.length && expanded ? `
            <div class="portfolio-headlines-list">
                ${heads.map((h, i) => `
                    <button type="button" class="portfolio-news-row" data-hl-i="${i}">
                        <span class="portfolio-news-title">${esc(h.title)}</span>
                        <span class="portfolio-news-meta">${h.section ? esc(h.section) + ' · ' : ''}CNBC · ${esc(this.ago(h.publishedAt))}</span>
                    </button>`).join('')}
            </div>` : '';
        const collapsed = this._collapsed();
        return `
            <div class="portfolio-profile-head is-collapsible" data-hl-collapse role="button" tabindex="-1">
                <h4 class="portfolio-ticker-section-title">
                    <button type="button" class="portfolio-profile-chevron" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${collapsed ? 'Show' : 'Hide'} current headlines"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>
                    ${title}
                </h4>
                <span class="portfolio-profile-meta">${meta}</span>
            </div>
            ${body && !collapsed ? `<div class="portfolio-profile-body feed-card-body${foldable && !expanded ? ' is-folded' : ''}${dim ? ' is-stale' : ''}">${body}</div>` : ''}
            ${list && !collapsed ? list : ''}
            ${(toggle || actions) && !collapsed ? `<div class="portfolio-profile-actions">${toggle}${actions}</div>` : ''}`;
    },

    _bind(el, subject, rerender, back) {
        el.querySelector('[data-hl-collapse]')?.addEventListener('click', (e) => {
            if (e.target.closest('[data-hl-refresh], [data-hl-toggle]')) return;
            this._setCollapsed(!this._collapsed());
            rerender();
        });
        el.querySelector('[data-hl-toggle]')?.addEventListener('click', () => {
            this._setExpanded(!this._expanded());
            rerender();
        });
        el.querySelector('[data-hl-refresh]')?.addEventListener('click', () => {
            this.ensure(subject, { manual: true, force: true }).catch(() => {});
            rerender();
        });
        const heads = this.get(subject)?.headlines || [];
        el.querySelectorAll('[data-hl-i]').forEach(btn => {
            btn.addEventListener('click', () => {
                const h = heads[Number(btn.dataset.hlI)];
                if (!h || !/^https:/i.test(h.url)) return;
                // Same door as the holdings news: the News reader when it is
                // installed (its Back returns here), else the Mac's browser.
                const news = (typeof Anjadhe !== 'undefined') ? Anjadhe.use('news') : null;
                if (news) {
                    news.openReader({ title: h.title, url: h.url, source: 'CNBC', publishedAt: Date.parse(h.publishedAt || '') || null, topic: subject === 'all' ? 'Markets' : PortfolioApp.displayTicker(subject) },
                        { returnTo: { label: 'Portfolio', onBack: back } });
                } else {
                    AppManager.openExternal(h.url);
                }
            });
        });
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = PortfolioHeadlines;
