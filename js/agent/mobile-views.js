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
// A stored "written by" as the phone should read it: the tier name for a
// curated model (js/agent/model-names.js N2), never the model's own id.
function MobileViewsModelName(stored) {
    if (!stored) return null;
    try { return typeof AgentService !== 'undefined' && AgentService.displayForStoredModel ? AgentService.displayForStoredModel(stored) : String(stored); }
    catch { return String(stored); }
}

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
            if (msg.view === 'jobs') return respond(this._jobs());
            if (msg.view === 'job') return respond(this._job(msg.params || {}));
            if (msg.view === 'job-action') return respond(await this._jobAction(msg.params || {}));
            // Approvals waiting on the phone (MobileChannel "Approvals on the phone").
            if (msg.view === 'chat-asks') return respond({ at: Date.now(), asks: (typeof MobileChannel !== 'undefined' && MobileChannel.pendingAsks) ? MobileChannel.pendingAsks() : [] });
            if (msg.view === 'insights') return respond(await this._insights());
            if (msg.view === 'insight') return respond(await this._insight(msg.params || {}));
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
    // This reaches OUT of nenva — onto the user's screen — and an approval
    // given on a phone is given without seeing what is about to be clicked.
    PHONE_BLOCKED_TOOLS: ['screen_act'],

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
     *   • a step that asks EVERY time — no. `onceOnly` is how a tool marks
     *     its sensitive steps (buy / confirm an order / pay / send / delete /
     *     sign in), so the one flag carries that whole class without this
     *     file having to name any of it;
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
        // A Now card's quiet act rides the same allowlisted view name, so a
        // phone build needs no main-process change on the Mac.
        if (typeof params.card === 'string') return this._cardAct(params);
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

        // The Mac's "Show again in 1 hour" deferral went with the old Home
        // (2026-10-01, the nenva Now has no deferral), so every request
        // that needs the person is here.
        const attention = SimpleExperience.attention();

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
            // The desktop's Now, for the phone (2026-10-02). Optional: an
            // older phone ignores it, and a failure here must not cost the
            // queue above.
            now: (() => { try { return this._now(); } catch (e) { console.warn('[mobile-views] now failed:', e && e.message); return undefined; } })(),
            // This Mac's default model, so a phone with no model of its own
            // can follow it when the Mac is away (PhoneAI.swift P1). A cloud
            // model is named by tier; any other engine is only its kind.
            brain: this._brain(),
            at: new Date().toISOString(),
        };
    },

    _brain() {
        try {
            const e = typeof AgentService !== 'undefined' && AgentService.getDefaultEntry ? AgentService.getDefaultEntry() : null;
            if (!e) return undefined;
            if (e.engine === 'anjadhe') return { engine: 'anjadhe', model: String(e.model || ''), name: AgentService.displayModelName(e) };
            return { engine: e.engine === 'llamacpp' || !e.engine ? 'local' : 'other' };
        } catch { return undefined; }
    },

    // --- Now on the phone (2026-10-02) -------------------------------------
    //
    // The phone draws the desktop's Now — the sentence, ONE card at a time,
    // TODAY with one action a row, the presence line — and computes none of
    // it: every card, rank, word and help line is SimpleExperience's own
    // (laws W1–W5, H1–H3 there). What this adds is only WHERE each action can
    // run, because a phone cannot open a Mac window:
    //   'answer' — the request queue's own approve/decline (`_homeAnswer`,
    //              same `_phoneAnswerable` gate, scope always once);
    //   'mac'    — a quiet act the Mac performs with no window (Later, Got it,
    //              Don't ask, Mark done, insight Done) — `_cardAct` below
    //              re-derives the card and allows only these;
    //   'url'    — a link the phone opens itself (Join, Gmail, Directions);
    //   'chat'   — a prompt the phone sends as a NEW chat of its own, so the
    //              answer comes back to the phone (Talk it through, Prep);
    //   'post' / 'task' — a record the phone already has a screen for.
    // Anything else (connect Google, open a workroom) is a Mac chore and is
    // left off the phone rather than drawn as a dead button.
    // Later / Got it live in the Mac's `now-cards`, so a card cleared on the
    // phone is cleared on the Mac too: there is one list, the Mac's.

    _now() {
        if (typeof SimpleExperience === 'undefined' || !SimpleExperience.allCards) return undefined;
        const SE = SimpleExperience;
        const now = new Date();
        const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
        const lede = SE.ledeLine(now);
        const today = SE.todayItems(now);
        const cards = SE.cards(now);
        const cardsOut = [];
        for (const c of cards) {
            const card = this._phoneCard(c, clip);
            if (card) cardsOut.push(card);
            if (cardsOut.length >= 12) break;
        }
        const rows = today.map((t) => ({ kind: t.ev ? 'event' : 'task', time: t.time, title: t.title }));
        const hasTasks = today.some((t) => t.taskId);
        const pres = SE.presence();
        return {
            note: clip(SE.noteText(cards, now), 280),
            date: clip(lede.date, 60),
            status: clip(lede.status, 80),
            cards: cardsOut,
            today: {
                line: clip(SE.todayLine(today, now), 200),
                plan: hasTasks && typeof TodayHelp !== 'undefined' ? clip(TodayHelp.planPrompt(rows), 1500) : '',
                rows: today.map((t) => this._phoneTodayRow(t, clip)),
            },
            working: (pres.working || []).slice(0, 3).map((w) => clip(w, 80)),
            looking: (pres.looking || []).map((w) => clip(w, 40)),
        };
    },

    /** A Now card as the phone draws it, or null for a Mac-only chore. */
    _phoneCard(c, clip) {
        const out = {
            key: String(c.key), kind: String(c.kind),
            label: String(SimpleExperience.KIND_LABEL[c.kind] || ''),
            title: clip(c.title, 160), body: clip(c.body, 400),
            talk: c.talk ? clip(c.talk, 800) : '',
            quiet: [],
        };
        const row = c.row || null;
        if (row && (row.kind === 'connect' || row.kind === 'fix')) return null;

        if (row && row.kind === 'ask') {
            const item = SimpleExperience.attention().find((a) => a.id === row.id) || {};
            const src = this._attentionSource(row.id);
            const plan = src && src.kind === 'task' ? this._planOf(src.task) : null;
            out.id = String(row.id);
            out.plan = plan || undefined;
            out.answerable = !!src && this._phoneAnswerable(item, src);
            if (out.answerable) {
                out.primary = { label: plan ? 'Run it' : 'Allow', does: 'answer' };
                out.decline = plan ? 'Not now' : 'Don’t allow';
            }
            if (c.dismiss) out.quiet.push({ label: c.dismiss, act: 'dismiss' });
            else if (c.kind !== 'approval') out.quiet.push({ label: 'Later', act: 'later' });
            return out;
        }
        if (row && row.kind === 'task') {
            out.taskId = String(row.id);
            out.primary = { label: 'Mark done', does: 'mac', act: 'primary' };
        } else if (c.matter) {
            // A folder's step (docs/MATTERS.md §17): a link opens on the phone,
            // a plain "do it" is Done on the Mac; a reply is drafted on the Mac.
            const m = typeof Matters !== 'undefined' ? Matters.get(c.matter) : null;
            const step = m ? Matters.openStep(m) : null;
            out.matterId = String(c.matter);
            if (step && step.how === 'link' && /^https:\/\//i.test(step.url || '')) out.primary = { label: clip(c.primary || 'Open the link', 30), does: 'url', url: step.url };
            else if (step && step.how === 'none') out.primary = { label: clip(c.primary || 'Done', 30), does: 'mac', act: 'primary' };
        } else if (c.meeting) {
            const url = c.url || (c.meeting.open && c.meeting.open.url) || '';
            if (/^https:\/\//i.test(url)) out.primary = { label: clip(c.primary || 'Open', 30), does: 'url', url };
        } else if (c.post) {
            out.primary = { label: 'Read', does: 'post', id: String(c.post) };
        } else if (c.coach) {
            // The money coach's offer is a chat too (MoneyCoach.accept).
            if (c.talk) out.primary = { label: clip(c.primary || 'Talk it through', 40), does: 'chat', prompt: out.talk, act: 'accept' };
            out.talk = '';
        } else if (c.checkin) {
            // The offer is a chat that plans with the person (CheckIns.accept);
            // on the phone that chat is the phone's own. A memory edit has no
            // phone door, so it keeps only its answers.
            if (c.talk) out.primary = { label: clip(c.primary || 'Talk it through', 40), does: 'chat', prompt: out.talk, act: 'accept' };
            out.talk = '';
        }
        else if (c.job) {
            out.primary = { label: 'Open', does: 'job', id: String(c.job) };
        }

        if (c.kind === 'headsup') out.quiet.push({ label: 'Got it', act: 'gotit' });
        if (c.kind === 'checkin') {
            out.quiet.push({ label: 'Not now', act: 'later' });
            out.quiet.push({ label: 'Don’t ask about this', act: 'stop' });
        } else if (c.dismiss) out.quiet.push({ label: c.dismiss, act: 'dismiss' });
        else if (c.kind !== 'headsup') out.quiet.push({ label: 'Later', act: 'later' });
        return out;
    },

    /** A TODAY row as the phone draws it: help line plus a phone-runnable action. */
    _phoneTodayRow(t, clip) {
        const h = t.help || {};
        const out = { key: String(t.key), time: clip(t.time, 20), title: clip(t.title, 160),
            line: clip(h.line, 200), attn: !!h.attn, live: !!h.live };
        if (t.taskId) out.taskId = String(t.taskId);
        if (t.open && t.open.url && /^https:\/\//i.test(t.open.url)) out.openUrl = t.open.url;
        const a = h.action;
        if (a) {
            const label = clip(a.label, 30);
            if (a.kind === 'url' && /^https:\/\//i.test(a.url || '')) out.action = { label, does: 'url', url: a.url };
            else if (a.kind === 'chat' && a.prompt) out.action = { label, does: 'chat', prompt: clip(a.prompt, 1500) };
            else if (a.kind === 'task') out.action = { label, does: 'task', id: String(a.id) };
            else if (a.kind === 'job') out.action = { label, does: 'job', id: String(a.id) };
            else if (a.kind === 'conv') out.action = { label, does: 'conv', id: String(a.id) };
            else if (a.kind === 'email') {
                const email = this._emailDoor(a.id);
                if (email) out.action = { label: 'Open email', does: 'email', email };
            }
        }
        return out;
    },

    /**
     * What the phone needs to open one message in a mail app (2026-10-02,
     * reported: email cards opened nothing useful — the Gmail WEB link lands
     * in Safari): the Gmail thread for the Gmail app, the RFC Message-ID for
     * Apple Mail (`message://`), and the web link as the last resort. Null for
     * a text message (iMessage source) or a message the Mac does not hold.
     */
    _emailDoor(id) {
        try {
            if (typeof EmailApp === 'undefined') return null;
            const msg = EmailApp.emailById ? EmailApp.emailById(id) : (EmailApp.emails || []).find((e) => e && e.id === id);
            if (!msg || msg.source === 'imessage') return null;
            const web = EmailApp.gmailUrl ? EmailApp.gmailUrl(msg) : '';
            const header = String(msg.messageIdHeader || '').trim().replace(/^<|>$/g, '');
            const thread = /^[0-9a-f]{8,}$/i.test(String(msg.threadId || '')) ? String(msg.threadId) : '';
            if (!web && !header && !thread) return null;
            return {
                web: /^https:\/\//i.test(web || '') ? web : '',
                thread,
                header: header.slice(0, 300),
                account: String(msg.account || '').slice(0, 120),
            };
        } catch { return null; }
    },

    /**
     * A quiet card act from the phone. Re-derives the card from the Mac's own
     * list and allows only acts that need no window: Later / Got it / Don't
     * ask / a follow-up's dismiss, a check-in accepted (the chat itself is
     * the phone's), and the primary of an overdue task or an insight whose
     * action is Done.
     */
    async _cardAct(params) {
        const SE = SimpleExperience;
        const key = typeof params.card === 'string' ? params.card : '';
        const act = typeof params.act === 'string' ? params.act : '';
        const card = key && SE._cardByKey(key);
        if (!card) throw new Error('That card has moved on — it may have been handled on your Mac.');
        if (['later', 'gotit', 'stop', 'dismiss'].includes(act)) { SE.cardAct(key, act); return { ok: true, key, act }; }
        if (act === 'accept' && card.checkin && typeof CheckIns !== 'undefined') {
            CheckIns.respond(card.checkin, 'accept');
            SE._front = null; SE.render();
            return { ok: true, key, act };
        }
        if (act === 'accept' && card.coach && typeof MoneyCoach !== 'undefined') {
            MoneyCoach.respond(card.coach, 'accept');
            SE._front = null; SE.render();
            return { ok: true, key, act };
        }
        const plainStep = card.matter && typeof Matters !== 'undefined' && (() => { const m = Matters.get(card.matter); const st = m && Matters.openStep(m); return !!st && st.how === 'none'; })();
        if (act === 'primary' && ((card.row && card.row.kind === 'task') || plainStep)) {
            SE.cardAct(key, 'primary');
            return { ok: true, key, act };
        }
        throw new Error('Open nenva on your Mac for this one.');
    },

    // --- Jobs on the phone (2026-10-02) ------------------------------------
    // The desktop's Jobs page (SimpleExperience.jobs / jobStatus / jobTitle /
    // jobDetail's fields), every word the job record's own. The phone may
    // Stop, Continue, and answer a routine run's wait (TeamJobs J2: a change
    // the run wants to make, once) — the same buttons the Mac's job page has.

    _jobRow(t) {
        const SE = SimpleExperience;
        const st = SE.jobStatus(t);
        return { id: String(t.id), title: String(SE.jobTitle(t)).slice(0, 160), when: SE.jobWhen(t),
            status: st.label || '', live: !!st.live, attn: !!st.attn };
    },

    _jobs() {
        if (typeof SimpleExperience === 'undefined' || !SimpleExperience.jobs) throw new Error('This Mac is running an older version of nenva.');
        return { at: new Date().toISOString(), jobs: SimpleExperience.jobs().slice(0, 60).map((t) => this._jobRow(t)) };
    },

    _job(params) {
        const id = typeof params.id === 'string' ? params.id : '';
        const t = SimpleExperience.jobs().find((x) => x.id === id);
        if (!t) throw new Error('That job is gone — it may have been deleted on your Mac.');
        const st = SimpleExperience.jobStatus(t);
        const wait = typeof TeamJobs !== 'undefined' && TeamJobs.waiting ? TeamJobs.waiting(t.id) : null;
        const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
        return {
            ...this._jobRow(t),
            note: wait ? '' : clip(t.note, 600),
            steps: (t.plan || []).slice(0, 30).map((s) => ({ step: clip(s && s.step, 240), status: String((s && s.status) || 'pending'), note: clip(s && s.note, 240) })),
            changes: !st.live && Array.isArray(t.changes) ? t.changes.slice(0, 20).map((c) => clip(c, 200)) : [],
            wait: wait ? { label: clip(wait.def && wait.def.label, 60), text: clip(wait.text, 300) } : null,
            canStop: !!st.live && !st.attn,
            canContinue: t.engine === 'team' && (t.status === 'paused' || t.status === 'failed'),
            conversationId: t.conversationId || null,
            routineId: t.routineId || null,
            at: new Date().toISOString(),
        };
    },

    async _jobAction(params) {
        const id = typeof params.id === 'string' ? params.id : '';
        const act = typeof params.act === 'string' ? params.act : '';
        const t = SimpleExperience.jobs().find((x) => x.id === id);
        if (!t) throw new Error('That job is gone — it may have been deleted on your Mac.');
        if (typeof TeamJobs === 'undefined' || !TeamJobs.isJob(id)) throw new Error('Open nenva on your Mac for this one.');
        if (act === 'stop') await TeamJobs.stop(id);
        else if (act === 'continue') await TeamJobs.resume(id);
        else if (act === 'allow' || act === 'deny') {
            if (!TeamJobs.waiting(id)) throw new Error('That job is no longer waiting — it may have been answered on your Mac.');
            TeamJobs.answer(id, act === 'allow');
        } else throw new Error('unknown action');
        try { SimpleExperience.onTaskUpdate(); } catch { /* repaint only */ }
        return { ok: true, id, act };
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
        const typeOrder = [...(EmailApp.INSIGHT_TYPES || []).filter(t => t !== 'code'), 'general'];
        const labels = EmailApp.INSIGHT_TYPE_LABELS || {};
        const folders = typeOrder.map((type) => ({ type, label: labels[type] || 'Other' }));

        const rows = [];
        // One row per folder (docs/MATTERS.md §17): the newest message about a
        // thing stands for it, named by the folder, read when the folder is
        // settled or has nothing to do. A message with no folder keeps its own.
        const seen = new Set();
        const sorted = Object.entries(analyses).map(([id, a]) => ({ id, a, e: (EmailApp.emailById && EmailApp.emailById(id)) || {} }))
            .sort((x, y) => (Date.parse(y.e.date || 0) || 0) - (Date.parse(x.e.date || 0) || 0));
        for (const { id: emailId, a, e: email } of sorted) {
            if (!a || !a.type || a.type === 'none' || a.type === 'code') continue;   // a code is never listed (2026-10-07)
            if (a.suppressed) continue;
            const m = typeof Matters !== 'undefined' && Matters.forSource ? Matters.forSource(emailId) : null;
            if (m) { if (seen.has(m.id)) continue; seen.add(m.id); }
            // An analysis carries no title of its own; the page shows the
            // model's summary and falls back to the email's subject — the
            // subject lives on the EMAIL record, joined by id here.
            rows.push({
                emailId,
                type: typeOrder.includes(String(a.type)) ? String(a.type) : 'general',
                title: String(m ? Matters.titleOf(m) : (email.subject || '(no subject)')).slice(0, 160),
                summary: String(a.summary || '').slice(0, 280),
                from: String(email.fromName || email.from || a.fromName || a.from || '').slice(0, 80),
                dueDate: a.dueDate || null,
                amount: a.amount || null,
                matterDate: (EmailApp._matterDate && EmailApp._matterDate(a)) || null,
                receivedAt: a.receivedAt || a.analyzedAt || null,
                read: m ? !(m.state === 'open' && Matters.openStep(m)) : true,   // no folder: for information
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
            read: (() => { const m = typeof Matters !== 'undefined' && Matters.forSource ? Matters.forSource(emailId) : null; return m ? !(m.state === 'open' && Matters.openStep(m)) : true; })(),
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
            // The phone opens the message in its own mail app (MailDoor).
            email: this._emailDoor(emailId) || undefined,
        };
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
                day: e?.day || null, at: e?.at || null, model: MobileViewsModelName(e?.model),
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
                day: profile.day || null, at: profile.at || null, model: MobileViewsModelName(profile.model),
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
     * (`ScheduleApp.getGroupedItems`, `TaskGroups._navCounts`,
     * `TaskGroups._rangeItems`, `TaskGroups.groupPredicateFor`), and the
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
        if (typeof ScheduleApp === 'undefined' || typeof TaskGroups === 'undefined') throw new Error('Tasks are not loaded on your Mac.');
        const load = typeof ScheduleApp.loadData === 'function';
        if (load && (this._scheduleStale || !ScheduleApp.scheduleItems?.length)) {
            this._scheduleStale = false;
            ScheduleApp.loadData();
        }
    },

    /** One task row, in the words the phone shows. Never a computed date. */
    _taskRow(item, { taskGoals, goalById } = {}) {
        const done = typeof TaskGroups !== 'undefined' && TaskGroups._resolved(item);
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
        const pred = TaskGroups.groupPredicateFor(group);
        const { taskGoals } = ScheduleApp.buildTaskLinkIndex();
        const goalById = new Map((TaskGroups._allGoals() || []).map(g => [g.id, g]));
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
            const later = TaskGroups._laterItems(pred);
            for (const m of later.months || []) {
                groups.push({ id: m.key, label: m.label, danger: false, items: (m.entries || []).map(e => row(e.item)) });
            }
            groups.push({ id: 'nodate', label: 'No date', danger: false, items: (later.noDate || []).map(row) });
        } else {
            // Tomorrow / this week / this month come back day by day, which is
            // how the desktop shows them and what makes "when" readable.
            for (const day of TaskGroups._rangeItems(slice, pred).days || []) {
                groups.push({ id: day.date, label: day.date, date: day.date, danger: false, items: day.items.map(row) });
            }
        }

        const counts = TaskGroups._navCounts();
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
        const goalById = new Map((TaskGroups._allGoals() || []).map(g => [g.id, g]));
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
