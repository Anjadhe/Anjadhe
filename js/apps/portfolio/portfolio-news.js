/**
 * PortfolioNews — headlines about the tickers you hold, on three surfaces:
 * the ticker page (one symbol), an account page (that account's holdings)
 * and All Accounts (every holding, then the watchlist).
 *
 * It is a LISTING over the News engine, not a second feed: every headline
 * comes from the same `discover-news` IPC News uses (Google News RSS search
 * per topic, direct or via Connect's unmetered /v1/news), with the same
 * hygiene — undated stories dropped, a max age, one row per URL — and rule
 * #1 of docs/DISCOVER.md holds unchanged: no model ever authors a headline.
 *
 *  - Topic per ticker = company name + symbol ("Apple Inc. AAPL"); a bare
 *    symbol ("T", "F") searches as a word and returns noise. Names come from
 *    the same Yahoo quoteSummary the ticker page already fetches, remembered
 *    in localStorage so the account feeds don't re-ask per open.
 *  - Funds (ETF / mutual fund) are queried by name alone on their own page
 *    and SKIPPED in the collated feeds: "Vanguard Total Stock Market ETF"
 *    headlines are listicles, and they would crowd out the companies.
 *  - Option contracts read as their underlying.
 *  - Per-TICKER cache (`portfolio-news-cache`, localStorage, machine-local,
 *    30-min TTL like News) so the ticker page and the account feeds share
 *    hits; never inside the synced portfolio blob (the volatile-data law).
 *  - Fetch on open only, TTL-gated — no background poll, like News. Gated by
 *    the same web-access consent: with web access off the section simply
 *    does not render.
 */
const PortfolioNews = {
    CACHE_KEY: 'portfolio-news-cache',
    NAMES_KEY: 'portfolio-company-names',
    TTL_MS: 30 * 60 * 1000,
    STORY_MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000,
    NAME_TTL_MS: 30 * 24 * 60 * 60 * 1000,
    PER_TICKER: 8,          // rows kept per ticker
    TICKER_PAGE_ROWS: 8,
    FEED_ROWS: 12,
    FEED_TICKERS: 12,       // topics per collated feed (2 Connect calls)
    FUND_TYPES: ['ETF', 'MUTUALFUND', 'INDEX', 'MONEYMARKET'],

    _cache: null,
    _names: null,
    _inflight: new Map(),   // ticker -> Promise

    /* ---------- storage ---------- */

    _load(key) {
        try { return JSON.parse(localStorage.getItem(key) || 'null') || {}; }
        catch { return {}; }
    },
    _save(key, obj) {
        try { localStorage.setItem(key, JSON.stringify(obj)); } catch { /* cache only */ }
    },
    cache() { if (!this._cache) this._cache = this._load(this.CACHE_KEY); return this._cache; },
    names() { if (!this._names) this._names = this._load(this.NAMES_KEY); return this._names; },

    async _webOn() {
        try {
            const s = await window.electronSearch?.getStatus?.();
            return !!(s && s.enabled && s.provider);
        } catch { return false; }
    },

    /* ---------- tickers → topics ---------- */

    /** The symbol news is about: an option contract reads as its underlying. */
    _subject(ticker) {
        if (!ticker || ticker === '__CASH__') return null;
        return PortfolioApp.optionMeta(ticker)?.underlying || ticker;
    },

    /**
     * Company name + quote type for a symbol, from the in-memory page cache,
     * then the persisted one, then one Yahoo fetch (remembered for a month).
     */
    async _identity(ticker) {
        const mem = PortfolioApp.companyInfoCache[ticker];
        if (mem && !mem.error) return { name: mem.name, type: mem.type || null };
        const names = this.names();
        const hit = names[ticker];
        if (hit && (Date.now() - hit.at) < this.NAME_TTL_MS) return hit;
        let info = null;
        try { info = await PriceFetcher.fetchCompanyInfo(ticker); } catch { /* falls back to the symbol */ }
        const id = { name: info?.name || ticker, type: info?.type || null, at: Date.now() };
        names[ticker] = id;
        this._save(this.NAMES_KEY, names);
        return id;
    },

    _isFund(id) { return !!id?.type && this.FUND_TYPES.includes(String(id.type).toUpperCase()); },

    /** "Apple Inc." → "Apple"; the suffix only dilutes the search. */
    _cleanName(name) {
        return String(name || '')
            .replace(/[,.]?\s+(Inc|Corp|Corporation|Co|Company|Ltd|Limited|PLC|plc|Holdings|Group|N\.V\.|S\.A\.|AG|SE)\.?$/i, '')
            .replace(/[,.]\s*$/, '')
            .trim();
    },

    // ≤80 chars: the IPC drops longer topics silently, which would shift
    // the topic→ticker mapping below.
    _topic(ticker, id) {
        const name = this._cleanName(id.name);
        if (!name || name.toUpperCase() === ticker.toUpperCase()) return `${ticker} stock`;
        const t = this._isFund(id) ? name : `${name} ${ticker}`;
        return t.length <= 80 ? t : (this._isFund(id) ? name.slice(0, 80) : `${name.slice(0, 79 - ticker.length)} ${ticker}`);
    },

    /* ---------- fetch ---------- */

    _fresh(entry) { return entry && (Date.now() - entry.at) < this.TTL_MS; },

    /**
     * Headlines for a set of subject symbols, each from cache when fresh.
     * Stale ones fetch in one batched call (chunked by 8, the IPC's cap).
     * A failed fetch keeps yesterday's rows — a hiccup never blanks a list.
     */
    async _ensure(tickers) {
        const cache = this.cache();
        const stale = tickers.filter(t => !this._fresh(cache[t]) && !this._inflight.has(t));
        if (!stale.length) {
            await Promise.all(tickers.map(t => this._inflight.get(t)).filter(Boolean));
            return;
        }
        const ids = await Promise.all(stale.map(t => this._identity(t)));
        const topics = stale.map((t, i) => this._topic(t, ids[i]));
        const run = (async () => {
            const chunks = [];
            for (let i = 0; i < topics.length; i += 8) chunks.push(topics.slice(i, i + 8));
            const results = await Promise.all(chunks.map(c => window.electronSearch.news(c).catch(() => null)));
            const byTopic = new Map();
            for (const r of results) {
                if (!r || r.error || !Array.isArray(r.topics)) continue;
                for (const t of r.topics) byTopic.set(String(t.topic || '').trim().toLowerCase(), t.items || []);
            }
            const now = Date.now();
            stale.forEach((ticker, i) => {
                const items = byTopic.get(topics[i].trim().toLowerCase());
                if (!items) return; // that chunk failed: keep the old entry
                const rows = [];
                for (const it of items) {
                    const pub = it.publishedAt ? Date.parse(it.publishedAt) : NaN;
                    if (Number.isNaN(pub) || now - pub > this.STORY_MAX_AGE_MS) continue;
                    if (!it.title || !it.url) continue;
                    rows.push({ title: String(it.title).slice(0, 200), url: String(it.url), source: String(it.source || '').slice(0, 60), publishedAt: pub });
                }
                rows.sort((a, b) => b.publishedAt - a.publishedAt);
                cache[ticker] = { at: now, fund: this._isFund(ids[i]), items: rows.slice(0, this.PER_TICKER) };
            });
            this._save(this.CACHE_KEY, cache);
        })();
        stale.forEach(t => this._inflight.set(t, run));
        try { await run; } finally { stale.forEach(t => this._inflight.delete(t)); }
        await Promise.all(tickers.map(t => this._inflight.get(t)).filter(Boolean));
    },

    /**
     * Collate several tickers' rows: newest-first within each, then
     * round-robin across tickers so one loud name can't fill the list.
     */
    _collate(tickers, limit) {
        const cache = this.cache();
        const lists = tickers.map(t => (cache[t]?.items || []).map(it => ({ ...it, ticker: t }))).filter(l => l.length);
        const out = []; const seen = new Set();
        for (let i = 0; out.length < limit && lists.some(l => i < l.length); i++) {
            for (const l of lists) {
                const it = l[i];
                if (!it || seen.has(it.url)) continue;
                seen.add(it.url); out.push(it);
                if (out.length >= limit) break;
            }
        }
        return out;
    },

    /* ---------- the tickers each surface is about ---------- */

    /** Holdings of a scope (null = all) by weight, options as underlyings, cash out. */
    _holdingSubjects(accountId) {
        const seen = new Set(); const out = [];
        const holdings = PortfolioApp.computeHoldings(accountId)
            .slice().sort((a, b) => (b.currentValue || 0) - (a.currentValue || 0));
        for (const h of holdings) {
            const s = this._subject(h.ticker);
            if (s && !seen.has(s)) { seen.add(s); out.push(s); }
        }
        if (!accountId) {
            for (const w of PortfolioApp.getWatchlist()) {
                const s = this._subject(w.ticker);
                if (s && !seen.has(s)) { seen.add(s); out.push(s); }
            }
        }
        return out;
    },

    /* ---------- rendering ---------- */

    _ago(ts) {
        const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
        if (mins < 60) return mins < 1 ? 'just now' : mins + 'm ago';
        const hours = Math.round(mins / 60);
        if (hours < 24) return hours + 'h ago';
        return Math.round(hours / 24) + 'd ago';
    },

    _rowsHtml(rows, { chips }) {
        const esc = AppManager.escapeHtml;
        return rows.map((it, i) => `
            <button type="button" class="portfolio-news-row" data-news-i="${i}">
                <span class="portfolio-news-title">${esc(it.title)}</span>
                <span class="portfolio-news-meta">${chips ? `<span class="portfolio-news-chip">${esc(PortfolioApp.displayTicker(it.ticker))}</span>` : ''}${it.source ? esc(it.source) + ' · ' : ''}${this._ago(it.publishedAt)}</span>
            </button>`).join('');
    },

    /**
     * A headline opens the News app's reader — the article fetched onto the
     * Mac and summarized by the user's model — with its back button
     * returning to the Portfolio page it came from. Browse is only the
     * fallback when News isn't loaded.
     */
    _bind(el, rows, back) {
        el.querySelectorAll('[data-news-i]').forEach(btn => {
            btn.addEventListener('click', () => {
                const it = rows[Number(btn.dataset.newsI)];
                if (!it || !/^https?:/i.test(it.url)) return;
                const news = (typeof Anjadhe !== 'undefined') ? Anjadhe.use('news') : null;
                if (news) {
                    news.openReader({
                        title: it.title, url: it.url, source: it.source, publishedAt: it.publishedAt,
                        topic: PortfolioApp.displayTicker(it.ticker)
                    }, { returnTo: { label: 'Portfolio', onBack: back } });
                } else {
                    AppManager.openInBrowse(it.url, { label: 'Back to Portfolio', onBack: back, readerMode: true });
                }
            });
        });
    },

    /**
     * Fill `el` with news for `tickers`. Draws what the cache has at once,
     * then refreshes stale tickers and repaints — as long as the element is
     * still in the document (the page may have moved on).
     */
    async _render(el, tickers, { limit, chips, back, heading = 'News' }) {
        if (!el) return;
        if (!tickers.length || !(await this._webOn())) { el.innerHTML = ''; return; }
        const paint = (loading) => {
            if (!el.isConnected) return;
            const rows = this._collate(tickers, limit);
            if (!rows.length && !loading) { el.innerHTML = ''; return; }
            el.innerHTML = `
                <h4 class="portfolio-ticker-section-title">${heading}</h4>
                ${rows.length ? this._rowsHtml(rows, { chips }) : '<p class="portfolio-news-empty">Looking for headlines&hellip;</p>'}`;
            this._bind(el, rows, back);
        };
        paint(true);
        try { await this._ensure(tickers); } catch { /* keep what we had */ }
        paint(false);
    },

    /**
     * Read API for the assistant's get_holdings_news tool: headlines for
     * given symbols, or (none given) the scope's holdings. Fetches stale
     * tickers first, same cache and hygiene as the pages.
     */
    async headlines({ tickers = null, accountId = null, limit = 20 } = {}) {
        let subjects;
        if (tickers && tickers.length) {
            subjects = [...new Set(tickers.map(t => this._subject(String(t).toUpperCase())).filter(Boolean))];
        } else {
            subjects = this._holdingSubjects(accountId).slice(0, this.FEED_TICKERS + 4);
            const ids = await Promise.all(subjects.map(t => this._identity(t)));
            subjects = subjects.filter((t, i) => !this._isFund(ids[i])).slice(0, this.FEED_TICKERS);
        }
        if (!subjects.length) return { tickers: [], items: [] };
        try { await this._ensure(subjects); } catch { /* cached rows still answer */ }
        return { tickers: subjects, items: this._collate(subjects, limit) };
    },

    /** Ticker page: this one symbol (funds included — it is their own page). */
    renderForTicker(ticker) {
        const el = document.getElementById('portfolio-ticker-news');
        const s = this._subject(ticker);
        if (!s) { if (el) el.innerHTML = ''; return; }
        return this._render(el, [s], {
            limit: this.TICKER_PAGE_ROWS, chips: false,
            back: () => { AppManager.openApp('portfolio'); PortfolioApp.openTickerDetail(ticker); }
        });
    },

    /** Account page or All Accounts: holdings by weight (funds skipped), watchlist at All. */
    async renderForScope(accountId) {
        const el = document.getElementById('portfolio-news');
        if (!el) return;
        // Bounded before the identity lookups: a first visit costs one
        // Yahoo call per symbol here, so a 60-holding book asks for its top
        // sixteen, not all sixty.
        const subjects = this._holdingSubjects(accountId).slice(0, this.FEED_TICKERS + 4);
        if (!subjects.length || !(await this._webOn())) { el.innerHTML = ''; return; }
        // Funds out: needs each symbol's quote type, which is one cached
        // lookup per ticker after the first visit.
        const ids = await Promise.all(subjects.map(t => this._identity(t)));
        const tickers = subjects.filter((t, i) => !this._isFund(ids[i])).slice(0, this.FEED_TICKERS);
        if (!el.isConnected) return;
        return this._render(el, tickers, {
            limit: this.FEED_ROWS, chips: true,
            heading: accountId ? 'News on this account’s holdings' : 'News on your holdings',
            back: () => { AppManager.openApp('portfolio'); PortfolioApp.setScope(accountId || 'all'); }
        });
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = PortfolioNews;
