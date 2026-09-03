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
            if (msg.view === 'insight') return respond(await this._insight(msg.params || {}));
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

        // The folder vocabulary the Mac's Email AI nav uses (INSIGHT_TYPES
        // order, `general` last, labels from INSIGHT_TYPE_LABELS) so the
        // phone's drawer lists the same folders in the same order.
        const typeOrder = [...(EmailApp.INSIGHT_TYPES || []), 'general'];
        const labels = EmailApp.INSIGHT_TYPE_LABELS || {};
        const folders = typeOrder.map((type) => ({ type, label: labels[type] || 'Other' }));

        const rows = [];
        for (const [emailId, a] of Object.entries(analyses)) {
            if (!a || !a.type || a.type === 'none') continue;
            if (a.suppressed) continue;
            // An analysis carries no title of its own; the page shows the
            // model's summary and falls back to the email's subject — the
            // subject lives on the EMAIL record, joined by id here.
            const email = (EmailApp.emailById && EmailApp.emailById(emailId)) || {};
            rows.push({
                emailId,
                type: typeOrder.includes(String(a.type)) ? String(a.type) : 'general',
                title: String(email.subject || '(no subject)').slice(0, 160),
                summary: String(a.summary || '').slice(0, 280),
                from: String(email.fromName || email.from || a.fromName || a.from || '').slice(0, 80),
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
            folders,
            insights: rows.slice(0, 300),
            trips,
        };
    },

    // --- Email AI: one insight in full, for the phone's detail page --------
    // The same facts the Mac's detail pane lays out (fyi-page.js
    // _renderDetail): the subject, the model's summary, the property rows in
    // the order they answer questions (when, where, which booking, how much,
    // who from, when it arrived), action items, and the email's plain text
    // to check the insight against. Opening it marks the insight read on the
    // Mac exactly as opening the detail there does (`markRead`); `read:false`
    // flips it back. Dates travel as ISO — the phone formats them.
    async _insight(params) {
        if (typeof EmailApp === 'undefined') throw new Error('Email is not available on your Mac.');
        if (!EmailApp._dataLoaded) { try { await EmailApp.loadData(); } catch { /* fall through */ } }
        const emailId = typeof params.emailId === 'string' ? params.emailId : '';
        const analyses = EmailApp.getProfileAnalyses() || {};
        const a = emailId && analyses[emailId];
        if (!a) throw new Error('That insight is no longer on your Mac.');
        if (typeof params.read === 'boolean') EmailApp.markAnalysisRead(emailId, params.read);
        else if (params.markRead === true && !a.readAt) EmailApp.markAnalysisRead(emailId, true);
        const email = (EmailApp.emailById && EmailApp.emailById(emailId)) || {};
        const res = a.reservation || null;
        const props = [];
        const push = (label, value) => { if (value) props.push({ label, value: String(value).slice(0, 200) }); };
        if (res && res.from && res.to) push('Route', `${res.from} to ${res.to}`);
        if (res && res.place) push('Where', res.place);
        push('Booked with', res && res.vendor);
        push('Confirmation', res && res.confirmationCode);
        if (a.amount && a.amount !== 'null') push('Amount', a.amount);
        push('From', (typeof EmailUI !== 'undefined' && EmailUI.extractName) ? EmailUI.extractName(email.from) : (email.fromName || email.from));
        let body = '';
        try { body = String(EmailApp._plainBody(email) || '').slice(0, 8000); } catch { body = String(email.snippet || ''); }
        const labels = EmailApp.INSIGHT_TYPE_LABELS || {};
        const type = String(a.type || 'general');
        return {
            emailId,
            type,
            typeLabel: labels[type] || 'Other',
            subject: String(email.subject || '(no subject)').slice(0, 300),
            summary: String(a.summary || '').slice(0, 2000),
            read: !!a.readAt,
            status: res && res.status ? String(res.status) : null,
            whenStart: (res && res.start) || (EmailApp._matterDate && EmailApp._matterDate(a)) || null,
            whenEnd: (res && res.end) || null,
            returnStart: (res && res.returnStart) || null,
            returnEnd: (res && res.returnEnd) || null,
            cancelBy: (res && res.cancelBy) || null,
            receivedAt: email.date || email.internalDate || a.receivedAt || null,
            props,
            actionItems: (Array.isArray(a.actionItems) ? a.actionItems : [])
                .map((it) => (typeof it === 'string' ? it : (it && (it.text || it.title)) || ''))
                .filter(Boolean).slice(0, 20),
            attachments: (Array.isArray(email.attachments) ? email.attachments : [])
                .map((att) => String((att && (att.filename || att.name)) || '')).filter(Boolean).slice(0, 10),
            body,
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
