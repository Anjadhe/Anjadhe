/**
 * Live prices while the US market is open (2026-09-29).
 *
 * While a Portfolio page is on screen and the regular session is open
 * (9:30-16:00 New York, Mon-Fri — the EXCHANGE's clock, never the user's
 * timezone), US stocks and ETFs are re-quoted every 15 seconds from
 * Robinhood's public quote endpoint (js/main/robinhood-quotes.js) and the
 * price-dependent parts of the page repaint in place. Everything Robinhood
 * does not quote (mutual funds, non-US listings, indices, options) stays
 * on Yahoo's 5-minute path in PriceFetcher. Outside the session nothing
 * here runs and the page behaves exactly as before.
 *
 * Laws:
 *  - ONLY WHILE LOOKED AT. No background poll: the clock runs while a
 *    Portfolio page is the active view and the window is visible, and
 *    stops itself the first tick either is not true. A render restarts it.
 *  - ONE SOURCE PER SYMBOL. A symbol Robinhood answers is Robinhood's; one
 *    it returned nothing for is remembered for the session and never asked
 *    again, so it is Yahoo's. Not a fallback chain.
 *  - PRICES ARE MACHINE-LOCAL. A tick writes the localStorage quote cache
 *    only. The synced value history (recordSnapshot) is written at most
 *    every SNAPSHOT_MS from here — an automatic refresh four times a
 *    minute must not journal to every Mac (docs/SYNC.md: volatile data).
 *  - NEVER UNDER THE USER'S HANDS. A repaint is skipped (and retried next
 *    tick) while a field in the page has focus or text is selected there.
 *  - THE MARKET SAYS WHEN IT IS QUIET. A holiday or an early close looks
 *    "open" to the clock; when no quoted symbol has traded in FRESH_MS the
 *    loop backs off to one call every QUIET_MS instead of keeping a
 *    calendar of its own.
 *
 * `usSession`, `eligible` and `merge` are pure and pinned by
 * tests/portfolio-live-test.js.
 */

const PortfolioLive = {
    TICK_MS: 15 * 1000,
    FRESH_MS: 15 * 60 * 1000,
    QUIET_MS: 5 * 60 * 1000,
    SNAPSHOT_MS: 30 * 60 * 1000,
    LIVE_WINDOW_MS: 60 * 1000,       // a quote younger than this reads "Live"
    FLASH_MS: 1200,

    // Mirrors js/main/robinhood-quotes.js SYMBOL_RX (main re-checks).
    SYMBOL_RX: /^[A-Z]{1,5}(\.[A-E])?$/,

    _timer: null,
    _inflight: false,
    _misses: new Set(),
    _quietUntil: 0,
    _lastSnapshotAt: 0,
    _pendingRepaint: null,

    /* ---------- pure ---------- */

    /** 'regular' during the NYSE/Nasdaq regular session, else 'closed'.
     *  Holidays and early closes are not known here — see the quiet rule. */
    usSession(now = new Date()) {
        let parts;
        try {
            parts = new Intl.DateTimeFormat('en-US', {
                timeZone: 'America/New_York', weekday: 'short',
                hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
            }).formatToParts(now);
        } catch { return 'closed'; }
        const get = (t) => parts.find(p => p.type === t)?.value;
        const day = get('weekday');
        if (day === 'Sat' || day === 'Sun') return 'closed';
        const mins = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
        return mins >= 9 * 60 + 30 && mins < 16 * 60 ? 'regular' : 'closed';
    },

    /** May this symbol be asked of Robinhood? US-shaped, not an option
     *  contract, and not one it already said it does not quote. */
    eligible(ticker, { isOption = () => false, misses = this._misses } = {}) {
        const t = String(ticker || '').toUpperCase();
        return this.SYMBOL_RX.test(t) && !isOption(t) && !misses.has(t);
    },

    /**
     * Fold a Robinhood answer into the quote cache. Returns the new cache,
     * the symbols whose price moved (with direction, for the flash) and the
     * newest trade time seen.
     */
    merge(cache, quotes, now = Date.now()) {
        const next = { ...(cache || {}) };
        const moved = [];
        let newestTrade = 0;
        for (const [sym, q] of Object.entries(quotes || {})) {
            if (!(q?.price > 0)) continue;
            const prev = next[sym]?.price;
            next[sym] = {
                price: q.price,
                change: q.change || 0,
                changePercent: q.changePercent || 0,
                updatedAt: now,
                source: 'robinhood',
                ...(q.tradeAt ? { tradeAt: q.tradeAt } : {})
            };
            if (prev > 0 && prev !== q.price) moved.push({ ticker: sym, dir: q.price > prev ? 'up' : 'down' });
            if (q.tradeAt > newestTrade) newestTrade = q.tradeAt;
        }
        return { cache: next, moved, newestTrade };
    },

    /** Is this cache entry a live quote right now? */
    isLive(entry, now = Date.now()) {
        return !!entry && entry.source === 'robinhood' && now - (entry.updatedAt || 0) < this.LIVE_WINDOW_MS;
    },

    /* ---------- the clock ---------- */

    /** Which Portfolio surface is on screen: 'ticker' | 'tickers' | 'main' | null. */
    _visible() {
        if (typeof document === 'undefined' || document.hidden) return null;
        const active = (id) => document.getElementById(id)?.classList.contains('active');
        if (active('portfolio-ticker-view')) {
            const t = PortfolioApp.viewingTicker;
            return t && t !== '__CASH__' ? 'ticker' : null;
        }
        if (!active('portfolio-view')) return null;
        const scope = PortfolioApp.currentAccountFilter;
        if (scope === 'strategy') return null;
        return scope === 'tickers' ? 'tickers' : 'main';
    },

    /** Called from every Portfolio render: start the clock if it can run. */
    ensure() {
        if (this._timer || !this._visible()) return;
        this._timer = setInterval(() => this._tick(), this.TICK_MS);
        // A page opened mid-session should not wait 15 s for its first tick.
        setTimeout(() => this._tick(), 0);
    },

    stop() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    },

    /** Is the loop quoting live right now (for the caption)? */
    running() {
        return !!this._timer && this.usSession() === 'regular' && Date.now() >= this._quietUntil;
    },

    async _tick() {
        const where = this._visible();
        if (!where) { this.stop(); return; }
        if (this._pendingRepaint && !this._busy()) this._repaint(where, this._pendingRepaint);
        if (this._inflight || this.usSession() !== 'regular') return;
        const now = Date.now();
        if (now < this._quietUntil) return;
        if (typeof window === 'undefined' || typeof window.electronNet?.fetchRobinhoodQuotes !== 'function') return;

        const isOption = (t) => !!PortfolioApp.optionMeta(t);
        const all = PortfolioApp.getUniqueTickers();
        if (where === 'ticker' && !all.includes(PortfolioApp.viewingTicker)) all.push(PortfolioApp.viewingTicker);
        const ask = all.filter(t => this.eligible(t, { isOption }));
        if (!ask.length) return;

        this._inflight = true;
        try {
            const quotes = await window.electronNet.fetchRobinhoodQuotes(ask);
            if (!quotes) return;                      // unreachable: Yahoo's path stands
            ask.forEach(t => { if (!quotes[t]) this._misses.add(t); });
            const { cache, moved, newestTrade } = this.merge(PortfolioApp.priceCache, quotes, Date.now());
            if (newestTrade && Date.now() - newestTrade > this.FRESH_MS) {
                this._quietUntil = Date.now() + this.QUIET_MS;
            }
            PortfolioApp.priceCache = cache;
            PortfolioApp._savePriceCache();

            // Symbols Robinhood does not quote still refresh on Yahoo's
            // clock; fetchPrices only fetches what is stale.
            const others = all.filter(t => !quotes[t]);
            if (others.some(t => PriceFetcher.isStale(PortfolioApp.priceCache[t]))) {
                PortfolioApp.priceCache = await PriceFetcher.fetchPrices(others, PortfolioApp.priceCache);
                PortfolioApp._savePriceCache();
            }

            if (Date.now() - this._lastSnapshotAt > this.SNAPSHOT_MS) {
                this._lastSnapshotAt = Date.now();
                PortfolioApp.recordSnapshot();
            }

            const here = this._visible();
            if (!here) return;
            if (this._busy()) { this._pendingRepaint = moved; return; }
            this._repaint(here, moved);
        } catch (e) {
            console.warn('[portfolio] live quote tick failed:', e?.message);
        } finally {
            this._inflight = false;
        }
    },

    /* ---------- repaint ---------- */

    /** A field in the page has focus, or text is selected in it. */
    _busy() {
        const roots = ['portfolio-view', 'portfolio-ticker-view'].map(id => document.getElementById(id)).filter(Boolean);
        const inside = (node) => roots.some(r => node && r.contains(node));
        const a = document.activeElement;
        if (a && inside(a) && (a.matches?.('input, textarea, select') || a.isContentEditable)) return true;
        const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
        if (sel && !sel.isCollapsed && inside(sel.anchorNode)) return true;
        // An open menu (PortfolioApp.openAnchoredMenu hangs it on <body>)
        // or dialog: the user is mid-choice.
        if (document.querySelector('.portfolio-more-menu, dialog[open]')) return true;
        return false;
    },

    _repaint(where, moved) {
        this._pendingRepaint = null;
        if (where === 'ticker') PortfolioApp.renderTickerLive();
        else if (where === 'tickers') {
            PortfolioApp.renderPricesAsOfFor(PortfolioApp.computeHoldings());
            if (typeof PortfolioTickers !== 'undefined') PortfolioTickers.render();
        } else PortfolioApp.renderLivePrices();
        this._flash(moved || []);
    },

    /** Tint the rows whose price just moved, green up / red down (STATE). */
    _flash(moved) {
        for (const { ticker, dir } of moved) {
            const sel = `#portfolio-view tr[data-ticker="${CSS.escape(ticker)}"], #portfolio-ticker-view .portfolio-summary[data-ticker="${CSS.escape(ticker)}"]`;
            document.querySelectorAll(sel).forEach(el => {
                el.classList.remove('pf-tick-up', 'pf-tick-down');
                void el.offsetWidth;                  // restart the transition
                el.classList.add(dir === 'up' ? 'pf-tick-up' : 'pf-tick-down');
                setTimeout(() => el.classList.remove('pf-tick-up', 'pf-tick-down'), this.FLASH_MS);
            });
        }
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = PortfolioLive;
