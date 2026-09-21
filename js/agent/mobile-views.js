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
            if (msg.view === 'home') return respond(await this._home());
            if (msg.view === 'home-answer') return respond(await this._homeAnswer(msg.params || {}));
            if (msg.view === 'insights') return respond(await this._insights());
            if (msg.view === 'insight') return respond(await this._insight(msg.params || {}));
            if (msg.view === 'news') return respond(await this._news());
            if (msg.view === 'portfolio') return respond(await this._portfolio());
            respond(null, 'unknown view');
        } catch (e) {
            respond(null, (e && e.message) || 'failed to build the view');
        }
    },

    // --- The simple home's Mac-served half (2026-09-20) ---------------------
    //
    // "Needs you" and "Ongoing work" are the two sections the phone cannot
    // compute for itself: the permission queue, task runs and workroom state
    // are LIVE state in this renderer, not anything that syncs as a blob
    // (docs/SIMPLE_EXPERIENCE.md, "On the phone").
    //
    // Built from `SimpleExperience`'s OWN accessors, never a parallel
    // computation — the law this whole file follows. That is also what makes
    // the exclusions free and impossible to forget: `attention()` reads
    // conversations through `AgentService.getConversationList()`, which
    // applies the private-chat filter, and every section checks its app
    // lock. A locked Assistant contributes nothing; a private chat is not
    // there to contribute.
    //
    // It works whether or not the MAC is using its own simple home: none of
    // these accessors consult `enabled`, and the phone's shell is its own
    // preference.
    // Tools whose approval never travels to a phone, whatever else is true.
    // These reach OUT of Anjadhe — into the user's own browser, their other
    // apps, their screen — and an approval given on a phone is given without
    // seeing what is about to be clicked.
    PHONE_BLOCKED_TOOLS: ['mac_act', 'screen_act'],

    /**
     * May this request be answered from the phone? (2026-09-21, Ram's call.)
     *
     * THE MAC DECIDES, ALWAYS. The flag this returns rides along in the
     * digest so the phone knows whether to draw buttons, but it is a HINT —
     * `_homeAnswer` asks this question again before it settles anything, so
     * a phone that lies, or a build that drifts, changes nothing.
     *
     * The tiers:
     *   • an ordinary permission, and a "may I keep going?" continuation
     *     offer — yes, at ONCE scope only;
     *   • a step that asks EVERY time — no. `onceOnly` is already how
     *     MacTools marks its sensitive steps (buy / confirm an order / pay /
     *     send / delete / sign in, card-shaped text, Enter in a messaging
     *     app), so the one flag carries that whole class without this file
     *     having to name any of it;
     *   • the tools above — no;
     *   • a PLAN waiting to be reviewed — yes, and only because the plan
     *     itself travels with the row (`_planOf` below). Approving work
     *     whose steps the phone never showed you is not consent, so the
     *     screen is the permission here: no plan on the card, no button.
     *     Each risky step still raises its own ask when it runs, and that
     *     ask comes back through this same gate.
     *   • a task paused MID-RUN (a declined permission, a step waiting on
     *     a tool) — no. Resuming it means re-approving something the note
     *     names but the row cannot qualify, and `_planOf` would be showing
     *     a plan that is already half spent.
     * Widening a grant to session or always is never offered.
     */
    _phoneAnswerable(item, source) {
        if (!item || !source) return false;
        if (source.kind === 'permission') {
            const ask = source.ask;
            if (ask.onceOnly) return false;
            return !this.PHONE_BLOCKED_TOOLS.includes(String(ask.toolName || ''));
        }
        if (source.kind === 'continue') return true;
        if (source.kind === 'task') return !!this._planOf(source.task);
        return false;
    },

    /**
     * The plan of a task that is waiting for it to be REVIEWED — the exact
     * state `SimpleExperience.workMessage` calls "I have a plan ready",
     * which is `awaiting_user` with a plan not one step of which has run.
     * Null for anything else, and that null is what closes the tier above.
     */
    _planOf(task) {
        if (!task || task.status !== 'awaiting_user') return null;
        const plan = Array.isArray(task.plan) ? task.plan : [];
        if (!plan.length) return null;
        if (plan.some((s) => s && s.status && s.status !== 'pending')) return null; // already under way
        return plan.slice(0, 12).map((s) => String((s && s.step) || '').slice(0, 200)).filter(Boolean);
    },

    /** The live ask / offer / task behind an attention row, or null. */
    _attentionSource(id) {
        if (typeof AgentUI !== 'undefined') {
            const ask = [AgentUI._inlineAskCurrent, ...(AgentUI._inlineAskQueue || [])]
                .find((a) => a && !a.settled && a.attentionId === id);
            if (ask) return { kind: 'permission', ask };
            const offer = [...(AgentUI._continueOffers?.values() || [])].find((o) => o && o.attentionId === id);
            if (offer) return { kind: 'continue', offer };
        }
        if (typeof TaskService !== 'undefined') {
            const task = TaskService.get?.(id);
            if (task) return { kind: 'task', task };
        }
        return null;
    },

    /**
     * Answer a request from the phone. Re-derives everything: the row must
     * still be in `attention()` (not settled, not from a private chat, not
     * behind a lock) and must still pass `_phoneAnswerable`. Scope is
     * hard-coded to 'once' — it is never sent from the phone and never read
     * from it.
     */
    async _homeAnswer(params) {
        if (typeof SimpleExperience === 'undefined') throw new Error('This Mac is running an older version of Anjadhe.');
        const id = typeof params.id === 'string' ? params.id : '';
        const approved = params.approved === true;
        if (!id) throw new Error('missing request id');

        const item = SimpleExperience.attention().find((x) => String(x.id) === id);
        if (!item) throw new Error('That request is no longer waiting — it may have been answered on your Mac.');
        const source = this._attentionSource(id);
        if (!source) throw new Error('That request is no longer waiting — it may have been answered on your Mac.');
        if (!this._phoneAnswerable(item, source)) {
            throw new Error('This one has to be answered on your Mac.');
        }

        if (source.kind === 'permission') {
            AgentUI._finishInlineAsk(source.ask, approved, 'once');
        } else if (source.kind === 'continue') {
            AgentUI.answerContinueOffer(id, approved);
        } else {
            // The same two doors the Mac's own plan card offers.
            const out = approved ? await TaskService.approve(id) : TaskService.cancel(id);
            if (out && out.error) throw new Error(out.error);
        }
        return { ok: true, id, approved, at: new Date().toISOString() };
    },

    async _home() {
        if (typeof SimpleExperience === 'undefined') throw new Error('This Mac is running an older version of Anjadhe.');

        // A request the user put off ON THE MAC stays put off here. It is
        // the same person saying "not now"; showing it again on the phone
        // would make the deferral meaningless.
        const attention = SimpleExperience.attention()
            .filter((item) => !SimpleExperience.deferredUntil(item));

        const WORKING = ['planning', 'running', 'verifying', 'paused'];
        const working = SimpleExperience.work().filter((t) => WORKING.includes(t.status));

        return {
            // Titles and one line of explanation — the same fields the
            // desktop row shows, and nothing more. No conversation text.
            needsYou: attention.slice(0, 10).map((item) => ({
                id: String(item.id || ''),
                kind: String(item.kind || 'chat'),
                title: String(item.title || 'A decision for you').slice(0, 160),
                message: String(item.message || '').slice(0, 280),
                actionLabel: String(item.actionLabel || 'Review together').slice(0, 40),
                ...(() => {
                    const src = this._attentionSource(item.id);
                    // The plan travels WITH the row, because it is what makes
                    // the row answerable at all — see `_phoneAnswerable`.
                    const plan = src && src.kind === 'task' ? this._planOf(src.task) : null;
                    return {
                        plan: plan || undefined,
                        // A HINT for the phone's buttons only — `_homeAnswer`
                        // asks the same question again before it settles.
                        answerable: !!src && this._phoneAnswerable(item, src),
                    };
                })(),
            })),
            working: working.slice(0, 10).map((t) => ({
                id: String(t.id || ''),
                title: String(t.goal || 'Work in progress').slice(0, 160),
                status: String(t.status || ''),
                message: String(SimpleExperience.workMessage(t) || '').slice(0, 280),
            })),
            at: new Date().toISOString(),
        };
    },

    // --- Email AI: unread-first insight digest + live trips -----------------
    async _insights() {
        if (typeof EmailApp === 'undefined') throw new Error('Email is not available on your Mac.');
        if (!EmailApp._dataLoaded) {
            // A session that never opened Email/home may not have bootstrapped.
            try { await EmailApp.loadData(); } catch { /* fall through to whatever loaded */ }
        }
        if (!EmailApp.aiInsightsEnabled) throw new Error('Insights are turned off on your Mac.');
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
    // Quotes are machine-local and, on the Mac, refresh only when the
    // Portfolio page renders (`autoRefreshPrices` from `render`). A phone
    // asking while that page is closed used to get whatever the cache held,
    // stamped as if fresh (2026-09-08). Now the ask IS a render for this
    // purpose: stale quotes are refreshed first (the same TTL gate the page
    // uses; a fetch failure falls through to the cached numbers), and
    // `pricesAsOf` carries the newest quote time so the phone can say
    // "Prices as of …" like the home card does.
    async _portfolio() {
        if (typeof PortfolioApp === 'undefined') throw new Error('Portfolio is not installed on your Mac.');
        PortfolioApp.loadData();
        if (!PortfolioApp.getAccounts().length) throw new Error('No portfolio accounts yet.');
        try { await PortfolioApp.autoRefreshPrices(); } catch { /* cached numbers, honestly dated */ }
        const holdings = PortfolioApp.computeHoldings();
        let pricesAsOf = 0;
        for (const h of holdings) {
            const at = PortfolioApp.priceCache?.[h.ticker]?.updatedAt || 0;
            if (at > pricesAsOf) pricesAsOf = at;
        }
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
            pricesAsOf: pricesAsOf || null,
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
