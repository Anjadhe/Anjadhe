/**
 * mobile-views.js — Mac-served read-only views for the paired phone.
 * ==================================================================
 * Lane 2 of the mobile restructure (docs/MOBILE_NATIVE.md): the phone asks
 * over the encrypted channel for data that deliberately does NOT sync as a
 * blob — email insights (the mailbox lives in SQLite, Gmail is the source
 * of truth), the News cache (machine-local, regenerable), and computed
 * portfolio numbers (quotes are machine-local). Main forwards the request
 * (`mobile-view-request`), this module builds a compact digest from the
 * SAME accessors the desktop surfaces use (EmailApp.getProfileAnalyses,
 * EmailTrips.trips, NewsFeed.cache, PortfolioApp.getSummary — never a
 * parallel computation), and answers over `mobile-view-result`.
 *
 * Everything returned is a DIGEST: titles, dates, amounts, urls — never
 * email bodies, and nothing model-written on the way out. The phone caches
 * what it gets and shows staleness honestly when the Mac is unreachable.
 */
const MobileViews = {
    init() {
        if (!window.electronMobileViews) return;
        window.electronMobileViews.onRequest((msg) => this._handle(msg));
    },

    async _handle(msg) {
        const reqId = msg && msg.reqId;
        if (!reqId) return;
        const respond = (data, error) => window.electronMobileViews
            .sendResult({ reqId, data: data || null, error: error || null })
            .catch(() => { /* main timed the request out; nothing to do */ });
        try {
            if (msg.view === 'insights') return respond(await this._insights());
            if (msg.view === 'news') return respond(await this._news());
            if (msg.view === 'portfolio') return respond(this._portfolio());
            respond(null, 'unknown view');
        } catch (e) {
            respond(null, (e && e.message) || 'failed to build the view');
        }
    },

    // --- Email AI: unread-first insight digest + live trips -----------------
    async _insights() {
        if (typeof EmailApp === 'undefined') throw new Error('Email is not available on your Mac.');
        if (!EmailApp._dataLoaded) {
            // A session that never opened Email/home may not have bootstrapped.
            try { await EmailApp.loadData(); } catch { /* fall through to whatever loaded */ }
        }
        if (!EmailApp.aiInsightsEnabled) throw new Error('Email AI is turned off on your Mac.');
        const analyses = EmailApp.getProfileAnalyses() || {};
        const todayISO = UIUtils.todayISO();

        const rows = [];
        for (const [emailId, a] of Object.entries(analyses)) {
            if (!a || !a.type || a.type === 'none') continue;
            if (a.suppressed) continue;
            rows.push({
                emailId,
                type: String(a.type),
                title: String(a.title || a.subject || 'Untitled').slice(0, 160),
                summary: String(a.summary || '').slice(0, 280),
                from: String(a.fromName || a.from || '').slice(0, 80),
                dueDate: a.dueDate || null,
                amount: a.amount || null,
                matterDate: (EmailApp._matterDate && EmailApp._matterDate(a)) || null,
                receivedAt: a.receivedAt || a.analyzedAt || null,
                read: !!a.readAt,
            });
        }
        // Unread first, then by when they matter / arrived, newest forward.
        rows.sort((x, y) => (x.read - y.read)
            || String(y.matterDate || y.receivedAt || '').localeCompare(String(x.matterDate || x.receivedAt || '')));

        let trips = [];
        try {
            trips = EmailTrips.trips(analyses, todayISO).map((t) => ({
                label: EmailTrips.label(t),
                start: t.span && t.span.start,
                end: t.span && t.span.end,
                count: (t.members || t.items || []).length || undefined,
            }));
        } catch { /* trips are a bonus; the digest stands without them */ }

        return {
            at: Date.now(),
            unread: rows.filter((r) => !r.read).length,
            insights: rows.slice(0, 60),
            trips,
        };
    },

    // --- News: the cached feed, refreshed if the TTL says so ----------------
    async _news() {
        if (typeof NewsFeed === 'undefined') throw new Error('News is not installed on your Mac.');
        try { await NewsFeed.ensureFresh(); } catch { /* serve the cache we have */ }
        const c = NewsFeed.cache();
        if (!c.items.length) throw new Error('No news cached yet — open News on your Mac once.');
        return {
            at: Date.now(),
            generatedAt: c.generatedAt || 0,
            items: c.items.slice(0, 50).map((it) => ({
                title: String(it.title || '').slice(0, 200),
                url: String(it.url || ''),
                topic: String(it.topic || ''),
                source: String(it.source || ''),
            })).filter((it) => it.title && it.url),
        };
    },

    // --- Portfolio: the glance-card numbers, nothing more -------------------
    _portfolio() {
        if (typeof PortfolioApp === 'undefined') throw new Error('Portfolio is not installed on your Mac.');
        PortfolioApp.loadData();
        if (!PortfolioApp.getAccounts().length) throw new Error('No portfolio accounts yet.');
        const holdings = PortfolioApp.computeHoldings();
        const summary = PortfolioApp.getSummary(holdings);
        const num = (v) => (Number.isFinite(v) ? v : null);
        const movers = holdings
            .filter((h) => Number.isFinite(h.dayChange) && Number.isFinite(h.dayChangePercent)
                && Math.abs(h.dayChangePercent) >= 1)
            .sort((a, b) => Math.abs(b.dayChange) - Math.abs(a.dayChange))
            .slice(0, 6)
            .map((h) => ({
                ticker: String(h.ticker || h.symbol || '').slice(0, 12),
                dayChange: num(h.dayChange),
                dayChangePercent: num(h.dayChangePercent),
            }));
        return {
            at: Date.now(),
            totalValue: num(summary.totalValue),
            netWorth: num(summary.netWorth),
            liabilitiesTotal: num(summary.liabilitiesTotal),
            dayChange: num(summary.totalDayChange),
            dayChangePercent: num(summary.totalDayChangePercent),
            totalPL: num(summary.totalPL),
            totalPLPercent: num(summary.totalPLPercent),
            movers,
        };
    },
};
