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
        this._watchStore();
    },

    /**
     * A served view must be built from CURRENT data (2026-09-22).
     *
     * `ScheduleApp` keeps its own in-memory copy of the schedule blob and
     * loads it once, at init — so a write that did not come from this
     * renderer (the phone's own task editor arriving over the channel, an
     * iCloud merge from another Mac) left `scheduleItems` holding the
     * version from launch. The phone would edit a task, the write would
     * land on the Mac, and the Mac would answer the very next `tasks`
     * request with rows that predate it. Tapping refresh on the phone made
     * no difference, because the staleness was here.
     *
     * Main names the KEY of every write to every window
     * (`notifyStoreKeyChanged`), which is the same signal `StorageManager`
     * drops its read cache on. Mark the copy stale here and re-read it
     * lazily at the top of the tasks views, never mid-request.
     */
    _watchStore() {
        try {
            window.electronStore.onKeyChanged?.((key) => {
                if (key == null || String(key) === 'app_schedule') this._scheduleStale = true;
            });
        } catch { /* no bridge — the copy is only ever this window's own */ }
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
            // Approvals waiting on the phone (MobileChannel "Approvals on the phone").
            if (msg.view === 'chat-asks') return respond({ at: Date.now(), asks: (typeof MobileChannel !== 'undefined' && MobileChannel.pendingAsks) ? MobileChannel.pendingAsks() : [] });
            if (msg.view === 'insights') return respond(await this._insights());
            if (msg.view === 'insight') return respond(await this._insight(msg.params || {}));
            if (msg.view === 'news') return respond(await this._news());
            if (msg.view === 'news-saved') return respond(await this._newsSaved());
            if (msg.view === 'news-article') return respond(await this._newsArticle(msg.params || {}));
            if (msg.view === 'news-action') return respond(await this._newsAction(msg.params || {}));
            if (msg.view === 'portfolio') return respond(await this._portfolio(msg.params || {}));
            if (msg.view === 'portfolio-tickers') return respond(await this._portfolioTickers(msg.params || {}));
            if (msg.view === 'portfolio-ticker') return respond(await this._portfolioTicker(msg.params || {}));
            if (msg.view === 'portfolio-strategy') return respond(await this._portfolioStrategy(msg.params || {}));
            if (msg.view === 'portfolio-news') return respond(await this._portfolioNews(msg.params || {}));
            if (msg.view === 'portfolio-action') return respond(await this._portfolioAction(msg.params || {}));
            if (msg.view === 'tasks') return respond(await this._tasks(msg.params || {}));
            if (msg.view === 'task') return respond(await this._task(msg.params || {}));
            if (msg.view === 'tasks-action') return respond(await this._tasksAction(msg.params || {}));
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
    // These reach OUT of nenva — into the user's own browser, their other
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
        if (typeof SimpleExperience === 'undefined') throw new Error('This Mac is running an older version of nenva.');
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
        if (typeof SimpleExperience === 'undefined') throw new Error('This Mac is running an older version of nenva.');

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

    // === News ==============================================================
    //
    // The phone gets the News app, not a headline list: the rail (topics,
    // sources, saved), the timeline with its lead card, the reader with its
    // summary, related coverage and source block, the Catch-me-up digest and
    // the Topics page.
    //
    // Two things make that possible without a second implementation. The
    // grouping is the desktop's own `NewsApp._buildGroups`, so `gi/ri` — the
    // address every row action resolves through — means the same thing on
    // both ends. And the reader pipeline is `NewsApp._loadSummary` with a
    // channel CONTEXT (see `_readerCtx` over there): the Mac does the
    // reading, summarizing and searching it always did, writes what it
    // learns into the same `news-summaries` cache, and the phone polls.
    //
    // Rule #1 survives the crossing: nothing here writes a headline. Titles,
    // sources and dates are quoted from the feed, the summary is labelled as
    // model-written, and related coverage is the deterministic shortlist the
    // model may only SELECT from by index.

    /** In-flight reader runs, keyed by the summary cache's own hash. */
    _newsRuns: new Map(),

    /**
     * The feed, its rail and everything the phone needs to draw both.
     *
     * The SCOPE (`_via`) stays on the phone deliberately — it is session
     * state on the Mac too, and a scope that survived a relaunch would read
     * as News having lost half its stories. So the digest ships every row
     * with its `via`, the unscoped per-source counts the desktop's Sources
     * rail shows, and lets the phone filter. The topic and All-news counts
     * ARE scope-filtered on the desktop, which is why they are not sent:
     * computing them under the phone's own scope is the only way they can
     * agree with what it draws.
     */
    // The phone builds this view itself when the Mac is away
    // (AnjadheCore/NewsLogic.swift); tests/news-parity-test.js pins this
    // pipeline's output as the golden the Swift port must match.
    async _news() {
        if (typeof NewsFeed === 'undefined') throw new Error('News is not installed on your Mac.');
        try { await NewsFeed.ensureFresh(); } catch { /* serve the cache we have */ }
        const cache = NewsFeed.cache();
        const settings = NewsFeed.settings();

        // The desktop's own grouping — `_buildGroups` also applies the "show
        // fewer" hides and re-attaches the rank reasons, and it is what makes
        // the `gi/ri` addresses below the same ones the Mac would resolve.
        // Deterministic given the same cache, so rebuilding it costs the
        // Mac's own page nothing.
        let groups = [];
        let isRead = () => false;
        if (typeof NewsApp !== 'undefined' && typeof NewsApp._buildGroups === 'function') {
            try {
                NewsApp._buildGroups(cache);
                groups = NewsApp._groups || [];
                if (typeof NewsApp._isRead === 'function') isRead = NewsApp._isRead;
            } catch { groups = []; }
        }

        const hue = (t) => {
            try { return (typeof NewsApp !== 'undefined' && NewsApp.topicHue) ? String(NewsApp.topicHue(t) || '') : ''; } catch { return ''; }
        };
        const bySource = {};
        let total = 0;
        const shaped = groups.slice(0, 24).map((g, gi) => ({
            topic: String(g.topic || ''),
            hue: hue(g.topic),
            rows: (g.rows || []).slice(0, 60).map((it, ri) => {
                const via = String(it.via || 'google');
                bySource[via] = (bySource[via] || 0) + 1;
                total += 1;
                return {
                    gi, ri,
                    title: String(it.title || '').slice(0, 200),
                    url: String(it.url || ''),
                    source: String(it.source || '').slice(0, 60),
                    sourceUrl: String(it.sourceUrl || '').slice(0, 300),
                    topic: String(it.topic || ''),
                    publishedAt: it.publishedAt || null,
                    updated: (() => { try { return !!NewsFeed._isUpdate(it); } catch { return false; } })(),
                    via,
                    viaLabel: via === 'google' ? '' : String(NewsFeed.sourceLabel(via) || ''),
                    points: Number.isInteger(it.points) ? it.points : null,
                    discussionUrl: String(it.discussionUrl || ''),
                    why: String(it.why || '').slice(0, 60),
                    read: (() => { try { return !!isRead(it.title); } catch { return false; } })(),
                };
            }).filter((r) => r.title && r.url),
        }));

        const saved = (typeof NewsApp !== 'undefined' && NewsApp._saved) ? NewsApp._saved() : [];
        return {
            at: Date.now(),
            generatedAt: cache.generatedAt || 0,
            route: String(cache.route || ''),
            ranked: !!cache.ranked,
            lastError: NewsFeed.lastError() ? String(NewsFeed.lastError()).slice(0, 300) : null,
            webOn: !!NewsFeed._webOn,
            settings: {
                interests: (settings.interests || []).map(String),
                location: String(settings.location || ''),
                sources: (settings.sources || []).map(String),
            },
            sources: (NewsFeed.SOURCES || []).map((s) => ({
                id: String(s.id), label: String(s.label), desc: String(s.desc || ''),
                on: (settings.sources || []).includes(s.id),
            })),
            topicHues: Object.fromEntries((settings.interests || []).map((t) => [String(t), hue(t)])),
            groups: shaped,
            total,
            bySource,
            digest: cache.digest ? { text: String(cache.digest.text || '').slice(0, 6000), at: cache.digest.at || null } : null,
            digestAvailable: (() => { try { return !!NewsFeed._canDigest() && NewsFeed.visibleItems(cache).length >= NewsFeed.DIGEST_MIN_ITEMS; } catch { return false; } })(),
            savedCount: saved.length,
            // The Topics page's own furniture.
            catalog: (NewsFeed.TOPIC_CATALOG || []).map((g) => ({ group: String(g.group), topics: (g.topics || []).map(String) })),
            topicLimit: NewsFeed.TOPIC_LIMIT || 15,
            mutedCount: (() => { try { return (NewsFeed.taste().fewer || []).length; } catch { return 0; } })(),
        };
    },

    /** The saved list — synced, but sent with the feed's shape so the phone's
     *  Saved page and its rows are the same code as the feed's. */
    async _newsSaved() {
        if (typeof NewsApp === 'undefined') throw new Error('News is not installed on your Mac.');
        return {
            at: Date.now(),
            items: (NewsApp._saved() || []).slice(0, 300).map((it) => ({
                url: String(it.url || ''), openUrl: String(it.openUrl || ''),
                title: String(it.title || '').slice(0, 200), source: String(it.source || '').slice(0, 60),
                sourceUrl: String(it.sourceUrl || '').slice(0, 300), topic: String(it.topic || ''),
                publishedAt: it.publishedAt || null, savedAt: it.savedAt || null,
                updated: (() => { try { return !!NewsFeed._isUpdate(it); } catch { return false; } })(),
            })).filter((it) => it.title || it.url),
        };
    },

    /** The item behind a url, from the live cache when it is there (so the
     *  reader keeps the topic, the HN thread and the real publication date)
     *  and a bare link when it is not — `fromLink`, exactly as a pasted URL
     *  or the browser extension arrives on the Mac. */
    _newsItemFor(url, title) {
        const link = String(url || '');
        if (typeof NewsFeed !== 'undefined') {
            try {
                const cache = NewsFeed.cache();
                const pools = [cache.items || [], ...((cache.topics || []).map((t) => t.items || []))];
                for (const pool of pools) {
                    const hit = pool.find((x) => String(x.url || '') === link);
                    if (hit) return { ...hit };
                }
            } catch { /* fall through to the bare link */ }
        }
        if (typeof NewsApp !== 'undefined') {
            const savedHit = (NewsApp._saved() || []).find((x) => String(x.url || '') === link);
            if (savedHit) return { ...savedHit };
        }
        return {
            title: String(title || '').slice(0, 300),
            url: link,
            source: (typeof NewsApp !== 'undefined' && NewsApp._hostOf) ? NewsApp._hostOf(link) : '',
            publishedAt: null,
            fromLink: true,
        };
    },

    /**
     * One article, read the way the Mac reads it.
     *
     * The work outlives the thirty-second view window — reading a page,
     * writing a summary on a local model and running the related-coverage
     * search can take minutes — so this never blocks on it. The first ask
     * STARTS the pipeline and answers `pending`; the phone re-asks and gets
     * the status line, then the partial text as it streams, then the
     * finished piece. That is the same shape as `write-brief` next door, and
     * it needs no change to the channel.
     *
     * The finished article is read back out of `news-summaries` — the cache
     * the pipeline writes anyway — so a summary written for the Mac's own
     * reader is already there for the phone, and vice versa.
     */
    async _newsArticle(params = {}) {
        if (typeof NewsApp === 'undefined' || typeof NewsFeed === 'undefined') throw new Error('News is not installed on your Mac.');
        const url = typeof params.url === 'string' ? params.url.trim().slice(0, 2000) : '';
        if (!/^https?:\/\//i.test(url)) throw new Error('That is not a link this can read.');
        const item = this._newsItemFor(url, params.title);
        const key = NewsApp._hash(item.url || item.title);

        // Opening an article is a click, and the taste file is what "Ranked
        // for you" is built from. Recorded once per open, as on the Mac.
        if (params.record !== false) { try { NewsFeed.recordClick(item); } catch { /* taste is a bonus */ } }

        const run = this._newsRuns.get(key);
        const cached = NewsApp._summaries()[key];
        const fresh = cached && cached.summary && cached.v === NewsApp.SUMMARY_VERSION;

        if (params.refresh === true && !run) {
            // "Write it again" — drop the stored entry so the pipeline takes
            // the long road rather than answering from its own cache.
            try { const all = { ...NewsApp._summaries() }; delete all[key]; StorageManager.set(NewsApp.SUMMARY_KEY, all); } catch { /* it will just re-serve */ }
        } else if (fresh && !run) {
            return this._newsArticleOut(item, key, {
                summary: cached.summary, mode: cached.mode, openUrl: cached.openUrl, source: cached.source,
                events: NewsApp._validEvents(cached.events),
                related: Array.isArray(cached.related) ? NewsApp._validRelated(cached.related) : undefined,
            }, false);
        }

        if (!run) {
            const holder = { state: { status: 'Reading the article on your Mac…', openUrl: String(item.openUrl || '') }, at: Date.now() };
            this._newsRuns.set(key, holder);
            const ctx = {
                reader: false,
                // Nothing to navigate away from: the phone asked for this
                // article and the answer is the cache, which outlives it.
                alive: () => true,
                get: () => holder.state,
                set: (state) => { holder.state = state; },
                patch: (fields) => { holder.state = { ...(holder.state || {}), ...fields }; },
                repaint: () => { /* nothing is on screen here */ },
                stream: (partial, mode, openUrl) => { holder.state = { summary: partial, mode, openUrl, streaming: true }; },
            };
            Promise.resolve(NewsApp._loadSummary(item, ctx))
                .catch((e) => { holder.state = { error: String((e && e.message) || 'This article could not be read here.'), openUrl: holder.state?.openUrl || '' }; })
                .finally(() => {
                    // Leave it briefly so a poll racing the finish still sees
                    // the final state, then let the cache be the truth.
                    setTimeout(() => this._newsRuns.delete(key), 15000);
                });
        }

        const holder = this._newsRuns.get(key);
        const st = (holder && holder.state) || {};
        const done = !!(st.summary && !st.streaming) || !!st.error;
        return this._newsArticleOut(item, key, st, !done);
    },

    /** The reader's page, in the order the Mac lays it out. */
    _newsArticleOut(item, key, st, pending) {
        const modeNotes = {
            article: ['AI summary', 'Written on your Mac from the article itself'],
            coverage: ['AI summary', 'From search coverage — the article itself would not load'],
            extract: ['Extract', "The article's own text — add an AI model for a written summary"],
        };
        const note = modeNotes[st.mode] || null;
        const src = st.source || null;
        return {
            at: Date.now(),
            url: String(item.url || ''),
            title: String(item.title || '').slice(0, 300),
            topic: String(item.topic || ''),
            hue: (() => { try { return String(NewsApp.topicHue(item.topic) || ''); } catch { return ''; } })(),
            publisher: String(item.source || '').slice(0, 60),
            publishedAt: item.publishedAt || null,
            updated: (() => { try { return !!NewsFeed._isUpdate(item, src?.publishedAt); } catch { return false; } })(),
            discussionUrl: /^https?:/i.test(String(item.discussionUrl || '')) ? String(item.discussionUrl) : '',
            saved: !!NewsApp._isSavedItem(item),
            pending: !!pending,
            status: String(st.status || ''),
            streaming: !!st.streaming,
            summary: st.summary ? String(st.summary).slice(0, 20000) : null,
            mode: st.mode || null,
            modeTag: note ? note[0] : null,
            modeNote: note ? note[1] : null,
            // `extract` is the deterministic one: the phone draws its tag
            // monochrome, the model-written ones in the accent.
            modePlain: st.mode === 'extract',
            openUrl: String(st.openUrl || item.openUrl || item.url || ''),
            error: st.error ? String(st.error).slice(0, 300) : null,
            // Provenance belongs under a FINISHED piece — the Mac withholds
            // both of these while the summary is still being written.
            sourceCard: (!st.streaming && src) ? {
                subject: String(NewsApp._cleanSubject(src.title, src.site) || '').slice(0, 200),
                site: String(src.site || '').slice(0, 80),
                url: String(src.url || ''),
                publishedAt: src.publishedAt || null,
                updatedAt: (src.updatedAt && src.updatedAt !== src.publishedAt) ? src.updatedAt : null,
            } : null,
            related: (!st.streaming && Array.isArray(st.related)) ? st.related.slice(0, 4).map((r) => ({
                title: String(r.title || '').slice(0, 180), url: String(r.url || ''),
                site: String(r.site || '').slice(0, 80), kind: r.kind || null,
                kindLabel: (r.kind && NewsApp.RELATED_KINDS[r.kind]) || null, picked: !!r.picked,
            })) : null,
            relatedLoading: !!st.relatedLoading,
            relatedPicked: Array.isArray(st.related) && st.related.some((r) => r && r.picked),
            events: Array.isArray(st.events) ? st.events.slice(0, 3).map((e) => ({
                title: String(e.title || '').slice(0, 80), date: e.date || null, time: e.time || null,
            })) : null,
        };
    },

    /**
     * The News writes a phone may make. Each one is the desktop's own
     * writer: `saveSettings` is the single author of the followed list,
     * `recordFewer` the single author of a hide, `setSaved` the single
     * author of the saved list. Nothing here re-implements a rule.
     */
    async _newsAction(params = {}) {
        if (typeof NewsFeed === 'undefined') throw new Error('News is not installed on your Mac.');
        const action = typeof params.action === 'string' ? params.action : '';
        const settings = NewsFeed.settings();
        const norm = (s) => String(s || '').trim().toLowerCase();

        if (action === 'follow' || action === 'unfollow') {
            const topic = String(params.topic || '').trim().slice(0, 60);
            if (!topic) throw new Error('missing topic');
            const list = (settings.interests || []).slice();
            const at = list.findIndex((t) => norm(t) === norm(topic));
            if (action === 'follow') {
                if (at >= 0) return { ok: true, action, topic, changed: false, interests: list };
                if (list.length >= (NewsFeed.TOPIC_LIMIT || 15)) {
                    throw new Error(`You can follow up to ${NewsFeed.TOPIC_LIMIT || 15} topics. Unfollow one first.`);
                }
                list.push(topic);
            } else {
                if (at < 0) return { ok: true, action, topic, changed: false, interests: list };
                list.splice(at, 1);
            }
            NewsFeed.saveSettings({ interests: list });
            return { ok: true, action, topic, changed: true, interests: NewsFeed.settings().interests };
        }
        if (action === 'source') {
            const id = String(params.source || '');
            if (!(NewsFeed.SOURCES || []).some((s) => s.id === id)) throw new Error('unknown source');
            const on = params.on === true;
            const list = (settings.sources || []).filter((s) => s !== id);
            if (on) list.push(id);
            // The desktop refuses the last one off out loud, and so does this.
            if (!list.length) throw new Error('Keep at least one source on.');
            NewsFeed.saveSettings({ sources: list });
            return { ok: true, action, sources: NewsFeed.settings().sources };
        }
        if (action === 'location') {
            NewsFeed.saveSettings({ location: String(params.location || '').slice(0, 80) });
            return { ok: true, action, location: NewsFeed.settings().location };
        }
        if (action === 'refresh' || action === 'settle') {
            // The Topics page's one deferred refresh: picks write through at
            // once on the Mac and the fetch they earn runs on leave.
            Promise.resolve(NewsFeed._refresh()).catch(() => { /* lastError carries it */ });
            return { ok: true, action, started: true };
        }
        if (action === 'catchup') {
            if (!NewsFeed._canDigest()) throw new Error('No model is set up on your Mac to write it.');
            Promise.resolve(NewsFeed.catchMeUp()).catch(() => { /* the toast is the Mac's */ });
            return { ok: true, action, started: true };
        }
        if (action === 'clear-digest') { NewsFeed.clearDigest(); return { ok: true, action }; }
        if (action === 'reset-fewer') { NewsFeed.resetFewer(); return { ok: true, action }; }
        if (action === 'fewer') {
            const title = String(params.title || '').slice(0, 200);
            if (!title) throw new Error('missing title');
            NewsFeed.recordFewer({ title, topic: String(params.topic || '') });
            return { ok: true, action, title };
        }
        if (action === 'save' || action === 'unsave') {
            if (typeof NewsApp === 'undefined') throw new Error('News is not installed on your Mac.');
            const url = String(params.url || '');
            const item = this._newsItemFor(url, params.title);
            if (!item.url && !item.title) throw new Error('missing article');
            const openUrl = (() => {
                try {
                    const e = NewsApp._summaries()[NewsApp._hash(item.url || item.title)];
                    return (e && e.openUrl) || '';
                } catch { return ''; }
            })();
            NewsApp.setSaved(item, action === 'save', { openUrl });
            return { ok: true, action, url, saved: !!NewsApp._isSavedItem(item) };
        }
        throw new Error('unknown action');
    },

    // === Portfolio =========================================================
    //
    // The desktop Portfolio is a left nav of SCOPES (All accounts, one per
    // account, Tickers, Strategy) with detail pages under them. The phone
    // gets the same scopes, and each is its own view here rather than one fat
    // digest — otherwise opening the app would wait on a ticker's price
    // history and a strategy's arithmetic nobody asked for.
    //
    // What they all share, and the law this file already followed: every
    // number comes from the desktop's OWN accessors — `computeHoldings`,
    // `getSummary`, `PortfolioStrategy.evaluate`, `PortfolioTickers.
    // consolidate` — never a second implementation. The RECORDS (accounts,
    // transactions, properties, liabilities, watchlist, strategies) already
    // sync to the phone inside the `portfolio` blob; what is genuinely
    // Mac-only is the arithmetic over live quotes, the machine-local profile
    // / brief / headline caches, and Yahoo history. That is exactly what
    // these views carry, and why the phone must not compute holdings itself.
    //
    // `hideValues` is deliberately NOT applied here: it is a per-Mac display
    // preference and the phone keeps its own.

    /**
     * The two things every portfolio view needs before it reads a number.
     *
     * Quotes are machine-local and the Mac only refreshes them when its own
     * Portfolio page renders (`autoRefreshPrices` from `render`), so a phone
     * asking with that page closed used to get whatever the cache held,
     * stamped as if fresh (2026-09-08). The ask IS the render for this
     * purpose: the same TTL gate the page uses, and a failed fetch falls
     * through to the cached numbers rather than failing the view.
     */
    async _pfReady() {
        if (typeof PortfolioApp === 'undefined') throw new Error('Portfolio is not installed on your Mac.');
        PortfolioApp.loadData();
        try { await PortfolioApp.autoRefreshPrices(); } catch { /* cached numbers, honestly dated */ }
    },

    _num(v) { return Number.isFinite(v) ? v : null; },

    /** The newest quote behind these holdings — what "Prices as of …" reads. */
    _pricesAsOf(holdings) {
        let at = 0;
        for (const h of holdings || []) {
            const t = PortfolioApp.priceCache?.[h.ticker]?.updatedAt || 0;
            if (t > at) at = t;
        }
        return at || null;
    },

    /**
     * One holdings row, in the desktop table's columns. `weight` is against
     * the SCOPE's own denominator (its holdings plus its cash) — the same one
     * `renderHoldingsTable` uses, and deliberately not the net-worth figure.
     * Options keep their raw OCC symbol as the id and carry `label` for
     * display; `currentValue`/`costBasis` already include the 100× multiplier
     * while `price`/`avgCost` stay per share.
     */
    _pfHolding(h, denom) {
        const n = (v) => this._num(v);
        return {
            ticker: String(h.ticker || '').slice(0, 24),
            label: String(PortfolioApp.displayTicker(h.ticker) || h.ticker || '').slice(0, 48),
            name: String((typeof PortfolioUI !== 'undefined' && PortfolioUI.tickerName(h.ticker)) || '').slice(0, 80),
            option: h.option ? {
                underlying: String(h.option.underlying || ''),
                expiration: h.option.expiration || null,
                optionType: h.option.optionType || null,
                strike: n(h.option.strike),
                daysToExpiry: n(PortfolioApp.optionDaysToExpiry(h.option)),
            } : null,
            shares: n(h.totalShares),
            avgCost: n(h.avgCostBasis),
            costBasis: n(h.costBasis),
            price: n(h.currentPrice),
            priceEstimated: !!h.priceEstimated,
            value: n(h.currentValue),
            weight: denom > 0 ? n((h.currentValue || 0) / denom * 100) : null,
            pl: n(h.profitLoss),
            plPercent: n(h.profitLossPercent),
            dayChange: n(h.dayChange),
            dayPercent: n(h.dayChangePercent),
            after: h.after ? { price: n(h.after.price), change: n(h.after.change), changePercent: n(h.after.changePercent), session: h.after.session || null } : null,
            accounts: Array.isArray(h.accounts) ? h.accounts.map(String).slice(0, 12) : [],
        };
    },

    /** The strategy line the desktop draws under a scope's masthead. */
    _pfStrategyLine(accountId) {
        if (typeof PortfolioStrategy === 'undefined') return null;
        let s = null;
        let inherited = false;
        try {
            if (accountId) { const r = PortfolioStrategy.forAccount(accountId) || {}; s = r.strategy; inherited = !!r.inherited; }
            else s = PortfolioStrategy.getDefault();
        } catch { return null; }
        if (!s) return null;
        let report = null;
        try {
            const r = PortfolioStrategy.evaluate(s, accountId ? { accountId } : {});
            report = { status: String(r.status || ''), headline: String(r.headline || '').slice(0, 240), counts: r.counts || null, empty: !!r.empty };
        } catch { /* the line stands without a verdict */ }
        return {
            id: String(s.id || ''),
            name: String(s.name || '').slice(0, 80),
            objective: String(s.objective || '').slice(0, 300),
            status: String(s.status || 'active'),
            inherited,
            report,
        };
    },

    /**
     * A scope of the Portfolio app: All accounts (no `accountId`) or one
     * account. The nav list travels with every answer so the phone can draw
     * its own left nav without a second round trip; the all-scope-only
     * sections (properties, liabilities, watchlist, the daily brief) follow
     * the desktop, which shows them under All accounts and nowhere else.
     */
    async _portfolio(params = {}) {
        await this._pfReady();
        const accounts = PortfolioApp.getAccounts();
        if (!accounts.length) throw new Error('No portfolio accounts yet.');
        // A scope naming an account that no longer exists falls back to All,
        // exactly as `setScope` does on the Mac.
        const wanted = typeof params.accountId === 'string' ? params.accountId : '';
        const accountId = accounts.some((a) => a.id === wanted) ? wanted : null;

        const holdings = PortfolioApp.computeHoldings(accountId);
        const summary = PortfolioApp.getSummary(holdings, accountId);
        const n = (v) => this._num(v);
        const holdingsValue = holdings.reduce((s, h) => s + (h.currentValue || 0), 0);
        const denom = holdingsValue + (summary.cash || 0);

        const accountRow = (a) => {
            const hs = PortfolioApp.computeHoldings(a.id);
            const s = PortfolioApp.getSummary(hs, a.id);
            return {
                id: String(a.id),
                name: String(a.name || '').slice(0, 60),
                type: String(a.type || 'other'),
                typeLabel: String((typeof PortfolioUI !== 'undefined' && PortfolioUI.formatAccountType(a.type)) || a.type || '').slice(0, 30),
                value: n(s.totalValue),
                cash: n(s.cash),
                holdings: hs.length,
                linked: !!a.brokerage,
            };
        };

        const out = {
            at: Date.now(),
            scope: accountId || 'all',
            pricesAsOf: this._pricesAsOf(holdings),
            // --- the masthead, in the desktop's own terms ---
            totalValue: n(summary.totalValue),
            totalCost: n(summary.totalCost),
            netWorth: n(summary.netWorth),
            liabilitiesTotal: n(summary.liabilitiesTotal),
            cash: n(summary.cash),
            realEstateValue: n(summary.realEstateValue),
            dayChange: n(summary.totalDayChange),
            dayChangePercent: n(summary.totalDayChangePercent),
            dayBase: n(summary.totalDayBase),
            totalPL: n(summary.totalPL),
            totalPLPercent: n(summary.totalPLPercent),
            after: summary.afterSession
                ? { session: summary.afterSession, change: n(summary.afterChange), base: n(summary.afterBase) }
                : null,
            // The masthead's composition bar: only the classes that exist.
            composition: [
                { key: 'stocks', label: 'Investments', value: (summary.totalValue || 0) - (summary.cash || 0) - (summary.realEstateValue || 0) },
                { key: 'cash', label: 'Cash', value: summary.cash || 0 },
                { key: 'realestate', label: 'Real estate', value: summary.realEstateValue || 0 },
            ].filter((c) => c.value > 0).map((c) => ({ ...c, value: n(c.value) })),
            holdings: holdings.map((h) => this._pfHolding(h, denom)),
            movers: holdings
                .filter((h) => Number.isFinite(h.dayChange) && Number.isFinite(h.dayChangePercent) && Math.abs(h.dayChangePercent) >= 1)
                .sort((a, b) => Math.abs(b.dayChange) - Math.abs(a.dayChange))
                .slice(0, 6)
                .map((h) => ({ ticker: String(h.ticker || '').slice(0, 24), label: String(PortfolioApp.displayTicker(h.ticker) || '').slice(0, 48), dayChange: n(h.dayChange), dayChangePercent: n(h.dayChangePercent) })),
            // --- the nav ---
            accounts: accounts.map(accountRow),
            tickersNav: (() => {
                const held = new Set(PortfolioApp.computeHoldings().map((h) => h.ticker));
                const watching = (PortfolioApp.getWatchlist() || []).filter((w) => !held.has(String(w.ticker || '').toUpperCase())).length;
                return { held: held.size, watching };
            })(),
            strategy: this._pfStrategyLine(accountId),
        };

        // The value chart. Both series are already on the phone inside the
        // synced `portfolio-history` key, but sending the scoped series costs
        // nothing and keeps the phone from having to know the snapshot shape.
        const hist = accountId
            ? (PortfolioApp.getAccountHistory(accountId) || []).map((s) => ({ date: s.date, value: this._num(s.value) }))
            : (PortfolioApp.valueHistory || []).map((s) => ({ date: s.date, value: this._num(s.totalValue), netWorth: this._num(s.netWorth) }));
        out.history = hist.filter((p) => p && p.date && p.value !== null).slice(-800);

        if (accountId) {
            const a = accounts.find((x) => x.id === accountId);
            out.account = a ? accountRow(a) : null;
            return out;
        }

        // --- All accounts only, following the desktop page ---
        out.properties = (PortfolioApp.getProperties() || []).map((p) => ({
            id: String(p.id), name: String(p.name || '').slice(0, 80), address: String(p.address || '').slice(0, 160),
            currentValue: n(p.currentValue), purchasePrice: n(p.purchasePrice), purchaseDate: p.purchaseDate || null,
            notes: String(p.notes || '').slice(0, 600),
        }));
        out.liabilities = (PortfolioApp.getLiabilities() || []).map((l) => ({
            id: String(l.id), name: String(l.name || '').slice(0, 80), type: String(l.type || 'other'),
            typeLabel: String(PortfolioApp.liabilityTypeLabel(l.type) || '').slice(0, 40),
            lender: String(l.lender || '').slice(0, 60), balance: n(l.balance), originalAmount: n(l.originalAmount),
            interestRate: n(l.interestRate), monthlyPayment: n(l.monthlyPayment), startDate: l.startDate || null,
            propertyId: l.propertyId || null, notes: String(l.notes || '').slice(0, 600),
        }));
        out.monthlyPayments = out.liabilities.reduce((s, l) => s + (l.monthlyPayment || 0), 0) || null;
        out.watchlist = (PortfolioApp.getWatchlist() || []).map((w) => {
            const t = String(w.ticker || '').toUpperCase();
            const q = PortfolioApp.priceCache?.[t] || {};
            return { ticker: t, name: String((typeof PortfolioUI !== 'undefined' && PortfolioUI.tickerName(t)) || '').slice(0, 80), price: n(q.price), change: n(q.change), changePercent: n(q.changePercent) };
        }).sort((a, b) => a.ticker.localeCompare(b.ticker));

        // The daily brief is a PURE READ of the machine-local cache. Writing
        // one is a model run and therefore an explicit action (`write-brief`),
        // never something a phone opening the app sets off.
        if (typeof PortfolioBrief !== 'undefined') {
            const e = PortfolioBrief.get();
            out.brief = {
                available: !!PortfolioBrief.available(),
                writing: !!PortfolioBrief.writing(),
                destination: String(PortfolioBrief.destination() || ''),
                day: e?.day || null, at: e?.at || null, model: e?.model || null,
                text: e?.text ? String(e.text).slice(0, 12000) : null,
                error: e?.error ? String(e.error).slice(0, 300) : null,
                stale: e ? !PortfolioBrief.isToday(e) : false,
            };
        }
        return out;
    },

    /**
     * The Tickers page: every held or watched symbol on one table, in both of
     * its views. The rows come from `PortfolioTickers.consolidate` and the
     * verdict columns from `attachIndicators` over `PortfolioProfile.VERDICTS`
     * — the one spec, shipped WITH the rows so the phone's columns, tones and
     * first-click direction cannot drift from the Mac's.
     *
     * Filtering and sorting stay on the phone: they are pure view state, and a
     * round trip per column tap would be absurd. `defaultDir` travels per
     * column so "first click sorts best-first" survives the port.
     */
    async _portfolioTickers(params = {}) {
        await this._pfReady();
        if (typeof PortfolioTickers === 'undefined') throw new Error('This Mac is running an older version of nenva.');
        const accounts = PortfolioApp.getAccounts();
        const wanted = typeof params.accountId === 'string' ? params.accountId : '';
        const accountId = accounts.some((a) => a.id === wanted) ? wanted : '';

        const holdings = PortfolioApp.computeHoldings(accountId || null);
        const cash = accountId ? PortfolioApp.computeCash(accountId) : PortfolioApp.computeTotalCash();
        const totalValue = holdings.reduce((s, h) => s + (h.currentValue || 0), 0) + cash;
        const specs = PortfolioTickers.specs();
        const rows = PortfolioTickers.attachIndicators(
            PortfolioTickers.consolidate({
                holdings,
                watchlist: PortfolioApp.getWatchlist(),
                priceCache: PortfolioApp.priceCache,
                totalValue,
                nameOf: (t) => PortfolioTickers.nameOf(t),
                labelOf: (t) => PortfolioApp.displayTicker(t),
                optionMetaOf: (t) => PortfolioApp.optionMeta(t),
            }),
            { specs, profileOf: (t) => PortfolioTickers._profileOf(t) }
        );
        const n = (v) => this._num(v);
        return {
            at: Date.now(),
            pricesAsOf: this._pricesAsOf(holdings),
            accountId: accountId || null,
            summary: PortfolioTickers.summarize(rows),
            indicatorSummary: PortfolioTickers.summarizeIndicators(rows, {}),
            specs: specs.map((s) => ({
                key: String(s.key), label: String(s.label || s.key),
                options: Array.isArray(s.options) ? s.options.map(String) : [],
                fundOptions: Array.isArray(s.fundOptions) ? s.fundOptions.map(String) : null,
                categorical: !!s.categorical,
                defaultDir: PortfolioTickers.defaultDir('ind:' + s.key, specs),
            })),
            rows: rows.map((r) => ({
                ticker: String(r.ticker || '').slice(0, 24),
                label: String(r.label || r.ticker || '').slice(0, 48),
                name: String(r.name || '').slice(0, 80),
                held: !!r.held, watched: !!r.watched, option: !!r.option,
                shares: n(r.shares), avgCost: n(r.avgCost), price: n(r.price),
                priceEstimated: !!r.priceEstimated,
                value: n(r.value), weight: n(r.weight), pl: n(r.pl), plPct: n(r.plPct),
                dayChange: n(r.dayChange), dayPct: n(r.dayPct),
                accountCount: r.accountCount || 0,
                profiled: !!r.profiled, profileDay: r.profileDay || null,
                ind: r.ind || {},
            })),
        };
    },

    /**
     * One ticker in full: the desktop's detail page. Company info and market
     * history are fetched on demand (both are cached on the Mac, so a second
     * ask is cheap), the business profile is a PURE read of the machine-local
     * cache, and writing one is an explicit action like the brief.
     */
    async _portfolioTicker(params = {}) {
        await this._pfReady();
        const ticker = typeof params.ticker === 'string' ? params.ticker.trim().toUpperCase().slice(0, 24) : '';
        if (!ticker) throw new Error('missing ticker');
        const range = ['1m', '3m', '1y', '5y', 'max'].includes(params.range) ? params.range : '1y';
        const n = (v) => this._num(v);

        const all = PortfolioApp.computeHoldings();
        const denom = all.reduce((s, h) => s + (h.currentValue || 0), 0) + PortfolioApp.computeTotalCash();
        const holding = all.find((h) => h.ticker === ticker) || null;
        const meta = PortfolioApp.optionMeta(ticker);
        const subject = meta ? String(meta.underlying || ticker).toUpperCase() : ticker;

        // The page fetches these when it opens; so does the phone's ask.
        try { if (!meta) await PortfolioApp.fetchCompanyInfo(ticker); } catch { /* the card stands without it */ }
        let history = null;
        try { history = await PortfolioApp.getMarketHistory(ticker, range); } catch { history = null; }

        const q = PortfolioApp.priceCache?.[ticker] || {};
        const info = PortfolioApp.companyInfoCache?.[ticker] || null;
        const profile = (typeof PortfolioProfile !== 'undefined') ? PortfolioProfile.get(subject) : null;

        return {
            at: Date.now(),
            ticker,
            label: String(PortfolioApp.displayTicker(ticker) || ticker).slice(0, 48),
            subject,
            watched: typeof PortfolioApp.isWatched === 'function' ? !!PortfolioApp.isWatched(ticker) : false,
            option: meta ? { ...meta, daysToExpiry: n(PortfolioApp.optionDaysToExpiry(meta)) } : null,
            company: info && !info.error ? {
                name: String(info.name || '').slice(0, 120), type: String(info.type || ''),
                sector: String(info.sector || '').slice(0, 60), industry: String(info.industry || '').slice(0, 80),
                description: String(info.description || '').slice(0, 2000), website: String(info.website || '').slice(0, 200),
                country: String(info.country || '').slice(0, 60), employees: n(info.employees),
            } : null,
            quote: { price: n(q.price), change: n(q.change), changePercent: n(q.changePercent), estimated: !!q.estimated, updatedAt: q.updatedAt || null,
                after: q.after ? { price: n(q.after.price), change: n(q.after.change), changePercent: n(q.after.changePercent), session: q.after.session || null } : null },
            holding: holding ? this._pfHolding(holding, denom) : null,
            byAccount: (PortfolioApp.computeHoldingsForTickerByAccount(ticker) || []).map((r) => ({
                accountId: String(r.account?.id || ''), accountName: String(r.account?.name || '').slice(0, 60),
                typeLabel: String((typeof PortfolioUI !== 'undefined' && PortfolioUI.formatAccountType(r.account?.type)) || '').slice(0, 30),
                shares: n(r.totalShares), avgCost: n(r.avgCostBasis), costBasis: n(r.costBasis),
                value: n(r.currentValue), pl: n(r.profitLoss), plPercent: n(r.profitLossPercent),
            })),
            range,
            marketHistory: Array.isArray(history) ? history.map((p) => ({ date: p.date, price: n(p.price) })).slice(-1200) : null,
            valueHistory: (PortfolioApp.getTickerHistory(ticker) || []).map((p) => ({ date: p.date, price: n(p.price), value: n(p.value) })).slice(-800),
            transactions: (PortfolioApp.getTickerTransactions(ticker) || []).slice(0, 200).map((t) => ({
                id: String(t.id || ''), type: String(t.type || ''), date: t.date || null,
                quantity: n(t.quantity), pricePerShare: n(t.pricePerShare), amount: n(PortfolioApp.txnAmount(t)),
                accountId: String(t.accountId || ''), notes: String(t.notes || '').slice(0, 300),
            })),
            profile: profile ? {
                day: profile.day || null, at: profile.at || null, model: profile.model || null,
                name: String(profile.name || '').slice(0, 120), fund: !!profile.fund,
                text: profile.text ? String(profile.text).slice(0, 16000) : null,
                verdicts: profile.verdicts || null,
                corrections: profile.corrections || 0,
                error: profile.error ? String(profile.error).slice(0, 300) : null,
                current: typeof PortfolioProfile !== 'undefined' ? !!PortfolioProfile.current(profile) : false,
            } : null,
            profileAvailable: typeof PortfolioProfile !== 'undefined' ? !!PortfolioProfile.available() : false,
            profileDestination: typeof PortfolioProfile !== 'undefined' ? String(PortfolioProfile.destination() || '') : '',
            decisions: (() => {
                try { return (PortfolioProfile.ownerNotes(subject) || []).slice(0, 12).map((d) => String(d.text || d).slice(0, 400)); } catch { return []; }
            })(),
            sites: (PortfolioApp.TICKER_SITES || []).map((s) => ({ action: String(s.action), label: String(s.label), url: String(s.url(meta ? subject : ticker) || '') })),
        };
    },

    /**
     * The Strategy scope. With no `strategyId` it is the list, each plan
     * carrying its own adherence report; with one it is the detail, plus the
     * accounts following it and its change log. The report is
     * `PortfolioStrategy.evaluate` verbatim — the one arithmetic, never
     * anything model-written.
     */
    async _portfolioStrategy(params = {}) {
        await this._pfReady();
        if (typeof PortfolioStrategy === 'undefined') throw new Error('Strategies are not available on your Mac.');
        const accounts = PortfolioApp.getAccounts();
        const id = typeof params.strategyId === 'string' ? params.strategyId : '';
        const shape = (s, full) => {
            let report = null;
            try { report = PortfolioStrategy.evaluate(s); } catch { report = null; }
            const base = {
                id: String(s.id || ''), name: String(s.name || '').slice(0, 80),
                objective: String(s.objective || '').slice(0, 600), horizon: String(s.horizon || '').slice(0, 80),
                riskLevel: String(s.riskLevel || '').slice(0, 40), status: String(s.status || 'active'),
                isDefault: !!s.isDefault,
                thesis: String(s.thesis || '').slice(0, 2000), coverage: String(s.coverage || '').slice(0, 400),
                reviewCadence: String(s.reviewCadence || '').slice(0, 80),
                report: report && {
                    status: String(report.status || ''), headline: String(report.headline || '').slice(0, 300),
                    empty: !!report.empty, total: this._num(report.total), cash: this._num(report.cash),
                    counts: report.counts || null,
                    targets: (report.targets || []).map((t) => ({
                        label: String(t.label || '').slice(0, 60), tickers: (t.tickers || []).map(String).slice(0, 20),
                        includeCash: !!t.includeCash, targetPct: this._num(t.targetPct),
                        minPct: this._num(t.minPct), maxPct: this._num(t.maxPct),
                        actualPct: this._num(t.actualPct), value: this._num(t.value),
                        status: String(t.status || ''), deltaValue: this._num(t.deltaValue), driftPct: this._num(t.driftPct),
                    })),
                    rules: (report.rules || []).map((r) => ({
                        kind: String(r.kind || ''), text: String(r.text || '').slice(0, 300),
                        label: String(r.label || '').slice(0, 120), status: String(r.status || ''),
                        detail: String(r.detail || '').slice(0, 300),
                    })),
                    unclassified: report.unclassified ? {
                        pct: this._num(report.unclassified.pct), value: this._num(report.unclassified.value),
                        tickers: (report.unclassified.tickers || []).map(String).slice(0, 12),
                        includesCash: !!report.unclassified.includesCash,
                    } : null,
                    unpriced: (report.unpriced || []).map(String).slice(0, 20),
                },
            };
            if (!full) return base;
            let followers = [];
            try {
                followers = (PortfolioStrategy.accountsUsing(s.id) || []).map((a) => ({
                    id: String(a.id), name: String(a.name || '').slice(0, 60), own: a.strategyId === s.id,
                }));
            } catch { /* the detail stands without them */ }
            return {
                ...base,
                followers,
                accountsWithNoPlan: accounts.filter((a) => !a.strategyId).length,
                history: (Array.isArray(s.history) ? s.history : []).slice(-8).map((h) => ({ at: h.at || null, summary: String(h.summary || '').slice(0, 300) })),
                missingTopics: (() => { try { return (PortfolioStrategy.missingTopics(s) || []).map(String); } catch { return []; } })(),
            };
        };
        const list = PortfolioStrategy.all() || [];
        if (id) {
            const s = PortfolioStrategy.getById(id);
            if (!s) throw new Error('That plan is no longer on your Mac.');
            return { at: Date.now(), strategy: shape(s, true) };
        }
        return {
            at: Date.now(),
            strategies: list.map((s) => shape(s, false)),
            // The interview agenda the empty state lists.
            agenda: (PortfolioStrategy.INTERVIEW || []).map((t) => ({ id: String(t.id), question: String(t.question || '').slice(0, 200) })),
        };
    },

    /**
     * Headlines on the user's holdings — `PortfolioNews.headlines` verbatim,
     * which is the same read the `get_holdings_news` tool makes. It fetches
     * when its own 30-minute cache is cold and is gated by web access on the
     * Mac; nothing here is model-written.
     */
    async _portfolioNews(params = {}) {
        await this._pfReady();
        if (typeof PortfolioNews === 'undefined') throw new Error('News on holdings is not available on your Mac.');
        const opts = { limit: Math.min(30, Math.max(1, Number(params.limit) || 12)) };
        if (typeof params.ticker === 'string' && params.ticker.trim()) opts.tickers = [params.ticker.trim().toUpperCase().slice(0, 24)];
        else if (typeof params.accountId === 'string' && params.accountId) opts.accountId = params.accountId;
        const res = await PortfolioNews.headlines(opts);
        return {
            at: Date.now(),
            tickers: (res.tickers || []).map(String),
            fetchError: res.fetchError ? String(res.fetchError).slice(0, 200) : null,
            items: (res.items || []).map((it) => ({
                ticker: String(it.ticker || ''), title: String(it.title || '').slice(0, 200),
                url: String(it.url || ''), source: String(it.source || '').slice(0, 60),
                publishedAt: it.publishedAt || null,
            })).filter((it) => it.title && it.url),
        };
    },


    /* ─── Tasks ──────────────────────────────────────────────────────────
     *
     * The phone's Tasks screen used to be a Swift reimplementation over the
     * synced `schedule` blob: its own grouping, its own "is this due today",
     * its own idea of overdue. It drifted from the desktop the moment either
     * side learned something — recurrence anchors, abandoned occurrences,
     * tag and project scopes, tasks born from an email — and the phone could
     * only ever show the subset someone had ported.
     *
     * So Tasks joins Portfolio and News on the served-view model: the rows,
     * the groups, the counts and the scopes are the DESKTOP's own
     * (`ScheduleApp.getGroupedItems`, `ActionsApp._navCounts`,
     * `ActionsApp._rangeItems`, `ActionsApp.groupPredicateFor`), and the
     * phone draws what it is handed. Nothing here re-derives a date.
     *
     * One exception, by decision (docs/MOBILE_NATIVE.md "M5", 2026-09-25):
     * when the Mac cannot be reached, the phone builds this view itself
     * (AnjadheCore/TaskList.swift). Drift is caught, not hoped against —
     * tests/task-list-parity-test.js pins THIS code's output as the golden
     * the Swift port must match. Change a rule here and that test fails:
     * re-run it with --update, then make the Swift side pass.
     */
    SLICE_LABELS: { today: 'Today', tomorrow: 'Tomorrow', week: 'This week', month: 'This month', later: 'Later', all: 'All' },

    _tasksReady() {
        if (typeof ScheduleApp === 'undefined' || typeof ActionsApp === 'undefined') throw new Error('Tasks are not loaded on your Mac.');
        const load = typeof ScheduleApp.loadData === 'function';
        if (load && (this._scheduleStale || !ScheduleApp.scheduleItems?.length)) {
            this._scheduleStale = false;
            ScheduleApp.loadData();
        }
    },

    /** One task row, in the words the phone shows. Never a computed date. */
    _taskRow(item, { taskGoals, goalById } = {}) {
        const done = typeof TaskListUI !== 'undefined' && (TaskListUI.isCompleted(item) || TaskListUI.isAbandoned(item));
        const projects = [];
        for (const gid of (taskGoals?.get(item.id) || [])) {
            const g = goalById?.get(gid);
            if (g) projects.push({ id: g.id, title: String(g.title || '').slice(0, 120) });
        }
        return {
            id: item.id,
            title: String(item.title || '').slice(0, 300),
            date: item.scheduledDate || null,
            time: item.startTime || null,
            repeat: item.repeat && item.repeat !== 'none' ? item.repeat : null,
            done: !!done,
            completedToday: typeof ScheduleApp.isCompletedToday === 'function' ? !!ScheduleApp.isCompletedToday(item) : false,
            tags: Array.isArray(item.tags) ? item.tags.slice(0, 8).map(t => String(t).slice(0, 40)) : [],
            projects: projects.slice(0, 3),
            source: typeof ScheduleApp.messageSourceKind === 'function' ? (ScheduleApp.messageSourceKind(item) || null) : null,
            note: String(item.description || '').slice(0, 160) || null,
        };
    },

    /**
     * The list, under one scope. `slice` is the time dimension and `group`
     * the other one, exactly as the desktop's two-dimensional nav has it —
     * "this week, tagged home" is one request, not two filters on the phone.
     */
    async _tasks(params = {}) {
        this._tasksReady();
        const slice = ['today', 'tomorrow', 'week', 'month', 'later', 'all'].includes(params.slice) ? params.slice : 'today';
        const group = typeof params.group === 'string' && params.group ? params.group.slice(0, 80) : null;
        const pred = ActionsApp.groupPredicateFor(group);
        const { taskGoals } = ScheduleApp.buildTaskLinkIndex();
        const goalById = new Map((ActionsApp._allGoals() || []).map(g => [g.id, g]));
        const row = (item) => this._taskRow(item, { taskGoals, goalById });
        const keep = (list) => (pred ? list.filter(pred) : list).map(row);

        const groups = [];
        if (slice === 'today' || slice === 'all') {
            const g = ScheduleApp.getGroupedItems({ applySidebarFilter: false, applySearch: false });
            groups.push({ id: 'overdue', label: 'Overdue', danger: true, items: keep(g.overdue) });
            groups.push({ id: 'today', label: 'Today', danger: false, items: keep(g.todayActive) });
            if (slice === 'all') {
                groups.push({ id: 'tomorrow', label: 'Tomorrow', danger: false, items: keep(g.tomorrow || []) });
                groups.push({ id: 'later', label: 'Later', danger: false, items: keep(g.later || []) });
                groups.push({ id: 'nodate', label: 'No date', danger: false, items: keep(g.noDate || []) });
            }
            groups.push({ id: 'done', label: 'Done today', danger: false, items: keep(g.todayCompleted || []) });
        } else if (slice === 'later') {
            // Beyond this month: the desktop groups it by MONTH, then the
            // undated backlog. Its shape is `{ months:[{label, entries:
            // [{item, date}]}], noDate, done, total }`.
            const later = ActionsApp._laterItems(pred);
            for (const m of later.months || []) {
                groups.push({ id: m.key, label: m.label, danger: false, items: (m.entries || []).map(e => row(e.item)) });
            }
            groups.push({ id: 'nodate', label: 'No date', danger: false, items: (later.noDate || []).map(row) });
        } else {
            // Tomorrow / this week / this month come back day by day, which is
            // how the desktop shows them and what makes "when" readable.
            for (const day of ActionsApp._rangeItems(slice, pred).days || []) {
                groups.push({ id: day.date, label: day.date, date: day.date, danger: false, items: day.items.map(row) });
            }
        }

        const counts = ActionsApp._navCounts();
        return {
            today: ScheduleApp.getLocalToday(),
            slice, group,
            label: MobileViews.SLICE_LABELS[slice] || slice,
            nav: {
                slices: [
                    // Today wears the attention badge and nothing else does —
                    // its number is what wants you now; the rest is inventory
                    // (the Actions rail's own two-tier rule).
                    ...['today', 'tomorrow', 'week', 'month', 'later', 'all'].map(id => ({
                        id, label: MobileViews.SLICE_LABELS[id], count: counts[id] || 0, attention: id === 'today',
                    })),
                ],
                tags: [...counts.tags.entries()].map(([name, count]) => ({ id: 't:' + name, name, count }))
                    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 40),
                projects: [...counts.groups.entries()].map(([name, count]) => ({ id: 'g:' + name, name: name || 'Ungrouped', count }))
                    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 40),
                sources: [
                    { id: 'src:email', label: 'From email', count: counts.fromEmail },
                    { id: 'src:imessage', label: 'From texts', count: counts.fromTexts },
                ].filter(s => s.count > 0),
                unassigned: counts.unassigned,
            },
            groups: groups.filter(g => g.items.length),
        };
    },

    /** One task, with everything its desktop sheet shows that travels. */
    async _task(params = {}) {
        this._tasksReady();
        const id = typeof params.id === 'string' ? params.id : '';
        const item = ScheduleApp.scheduleItems.find(i => i.id === id);
        if (!item) throw new Error('That task is gone.');
        const { taskGoals } = ScheduleApp.buildTaskLinkIndex();
        const goalById = new Map((ActionsApp._allGoals() || []).map(g => [g.id, g]));
        const out = this._taskRow(item, { taskGoals, goalById });
        out.description = String(item.description || '').slice(0, 8000);
        out.totalTimeSpent = Number(item.totalTimeSpent) || 0;
        out.createdAt = item.createdAt || null;
        out.lastCompletedDate = item.lastCompletedDate || null;
        // History is the record of the recurring task's own days; the phone
        // shows the recent end of it, newest first.
        out.history = Object.entries(item.history || {})
            .sort((a, b) => String(b[0]).localeCompare(String(a[0]))).slice(0, 30)
            .map(([date, v]) => ({ date, state: typeof v === 'string' ? v : (v && v.state) || 'done' }));
        if (typeof UpdateStore !== 'undefined') {
            out.updates = (UpdateStore.listFor(`task:${id}`, { limit: 20 }) || []).map(u => ({
                id: u.id, at: u.at || u.createdAt || null, text: String(u.text || '').slice(0, 2000),
            }));
        }
        return out;
    },

    /**
     * The ONE write a phone may make through this family: the checkbox.
     *
     * The rule is narrow on purpose — a served list may write only what it
     * shows a control for. Ticking a box has to come back here because the
     * list being redrawn is the Mac's, computed from the Mac's own grouping;
     * a local write would leave the two disagreeing until the next sync.
     * Everything else a task has — its title, notes, date, time, recurrence,
     * whether it exists at all — stays in the phone's own editor, which
     * writes the synced blob and therefore works with no Mac in reach. That
     * is the more valuable half to keep offline, and it already exists.
     */
    async _tasksAction(params = {}) {
        this._tasksReady();
        const action = typeof params.action === 'string' ? params.action : '';
        const id = typeof params.id === 'string' ? params.id : '';
        const item = id ? ScheduleApp.scheduleItems.find(i => i.id === id) : null;
        if (!item) throw new Error('That task is gone.');
        // The write is the DESKTOP's own writer, never a copy of one.
        const after = () => {
            const fresh = ScheduleApp.scheduleItems.find(i => i.id === id)
                || (StorageManager.get('schedule')?.scheduleItems || []).find(i => i.id === id);
            return fresh ? this._taskRow(fresh, {}) : null;
        };
        if (action === 'complete' || action === 'uncomplete') {
            // The phone states a DIRECTION; `toggleComplete` is a toggle. Ask
            // the desktop's own question first so a stale row on the phone
            // cannot flip a task the other way, and pass `quiet` so the Mac
            // does not throw confetti at an empty chair.
            if (ScheduleApp.isDone(item) !== (action === 'complete')) ScheduleApp.toggleComplete(id, { quiet: true });
            return { ok: true, action, id, task: after() };
        }
        throw new Error('unknown action');
    },

    /**
     * The few Portfolio writes a phone may make.
     *
     * Two tiers, and the split is the same one the desktop makes. Watching a
     * ticker is a one-tap preference on a record that already syncs, so it
     * settles here. Writing a profile or a brief is a MODEL RUN that can
     * outlive the 30-second view window, so the action only STARTS it and
     * says so — the phone re-asks the view and sees the finished text, the
     * same way the Mac's own page does when the sweep lands.
     *
     * What is deliberately not here: adding a transaction, creating an
     * account, editing a strategy. Those are record authoring, and the
     * desktop already decided authoring is a conversation — the phone has the
     * assistant for it.
     */
    async _portfolioAction(params = {}) {
        await this._pfReady();
        const action = typeof params.action === 'string' ? params.action : '';
        const ticker = typeof params.ticker === 'string' ? params.ticker.trim().toUpperCase().slice(0, 24) : '';
        if (action === 'watch' || action === 'unwatch') {
            if (!ticker) throw new Error('missing ticker');
            if (PortfolioApp.optionMeta(ticker)) throw new Error('Options cannot be watched.');
            const ok = action === 'watch' ? PortfolioApp.addToWatchlist(ticker) : PortfolioApp.removeFromWatchlist(ticker);
            return { ok: true, action, ticker, changed: !!ok, watched: !!PortfolioApp.isWatched(ticker) };
        }
        if (action === 'refresh-prices') {
            await PortfolioApp.refreshPrices();
            return { ok: true, action, pricesAsOf: this._pricesAsOf(PortfolioApp.computeHoldings()) };
        }
        if (action === 'write-brief') {
            if (typeof PortfolioBrief === 'undefined' || !PortfolioBrief.available()) throw new Error('No model is set up on your Mac to write it.');
            if (PortfolioBrief.writing()) return { ok: true, action, started: false, running: true };
            // Not awaited: a local model can take minutes and the view window
            // is thirty seconds. The phone re-asks and finds it written.
            Promise.resolve(PortfolioBrief.ensure({ manual: true, force: params.force === true })).catch(() => { /* the entry carries its own error */ });
            return { ok: true, action, started: true };
        }
        if (action === 'write-profile') {
            if (!ticker) throw new Error('missing ticker');
            if (typeof PortfolioProfile === 'undefined' || !PortfolioProfile.available()) throw new Error('No model is set up on your Mac to write it.');
            Promise.resolve(PortfolioProfile.ensure(ticker, { manual: true, force: params.force === true })).catch(() => { /* ditto */ });
            return { ok: true, action, ticker, started: true };
        }
        throw new Error('unknown action');
    },
};
