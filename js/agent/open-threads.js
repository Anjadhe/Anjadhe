/**
 * OpenThreads — what a chat left open, captured DURING the chat
 * (docs/OPEN_THREADS.md). PHASE 0: capture and review only. Nothing is shown
 * anywhere; `OpenThreads.review()` in the console is the whole surface, the
 * Noticing P0 bargain — a wrong nudge costs trust, so a week of captures is
 * read before any of them is surfaced.
 *
 * Memory (MemoryManager) remembers the PERSON, after the fact. A thread
 * remembers the WORK: what was asked, whether it was done, and — the part
 * Phase 1 acts on — what blocked it, in terms code can check later
 * ("Gmail not connected", "web search off"). When the blocker is gone, the
 * assistant can come back: "Earlier you asked X. I can do it now."
 *
 * Laws (T1–T6, also in the doc):
 *  T1 Code decides when to ask. A turn is examined only when code sees a
 *     sign something is open: a tool failed, the tool budget ran out, the
 *     turn errored, the answer says it couldn't, or the user stated a plan
 *     for later. Most turns cost nothing.
 *  T2 The model proposes, code decides. The `asked` (and any `next`) quote
 *     must be copied verbatim from the user's message; the outcome and the
 *     blocker come from fixed lists; a blocker is kept only if it is TRUE
 *     right now by the app's own checks. Anything else is dropped, never
 *     repaired.
 *  T3 Never from private, simple-mode or headless turns, nor from an
 *     untrusted-context turn (a chat opened over an email or another
 *     outside-content page, or a run started by untrusted input). In an
 *     ordinary chat the assistant may READ outside content with a tool; what
 *     keeps that content from writing a thread is T2 — every kept quote must
 *     be the person's own words from their message.
 *  T4 An intention is never recorded as done (the memory intention rule):
 *     "I'll decide next week" is a `later` thread, not a decision.
 *  T5 Identity, not time: a thread's id is its conversation + the user
 *     message's index, so re-examining a turn cannot duplicate it.
 *  T6 Silent in Phase 0. No notification, no Home row, no chat note.
 */
const OpenThreads = {
    KEY: 'open-threads',
    SOURCE: 'open-threads',
    MAX_THREADS: 300,

    OUTCOMES: ['partly', 'couldnt', 'waiting', 'later'],

    // Blockers code can check. Each maps to a test over the setup snapshot;
    // `feature_off` names a flag in `feature`.
    BLOCKERS: {
        no_google_account: (s) => s.googleAccounts === 0,
        no_mail: (s) => !s.mail,
        no_calendar: (s) => !s.calendar,
        no_web_search: (s) => !s.webSearch,
        no_vision: (s) => !s.vision,
        feature_off: (s, feature) => !!feature && Array.isArray(s.featuresOff) && s.featuresOff.includes(feature)
    },

    // Flags a person can turn on themselves (Settings › Developer ›
    // Experimental features), so "this was off" is something they can fix.
    USER_FLAGS: ['workrooms', 'maccontrol', 'brokerage', 'terminal', 'sharing', 'mobilesync', 'noticing'],

    /* ---------- pure core (tests/open-threads-test.js) ---------- */

    _CANT_RX: /\b(?:i\s+(?:can(?:'|’)?t|cannot|couldn(?:'|’)?t|could not|was(?:n(?:'|’)?t| not) able|am not able|don(?:'|’)?t have (?:access|a way|the ability))|(?:isn(?:'|’)?t|is not|aren(?:'|’)?t|are not|not)\s+(?:connected|enabled|turned on|set up|available)|no access to|unable to|not possible for me)\b/i,
    _LATER_RX: /\b(?:remind me|later|tomorrow|next (?:week|month|year)|this (?:weekend|evening)|i(?:'|’)?ll (?:decide|do|check|look|think|get back)|i will (?:decide|do|check|look|think)|let me (?:think|check)|once i|when i (?:get|have|find))\b/i,

    /**
     * T1: is there any sign this turn left something open? Returns the
     * reasons (for the review), empty when the turn should not be examined.
     */
    signals({ userText, answerText, toolLog, toolLimit, isError }) {
        const reasons = [];
        if (isError) reasons.push('turn errored');
        if (toolLimit) reasons.push('tool budget ran out');
        const failed = (toolLog || []).filter(t => !t.ok);
        if (failed.length) reasons.push(`${failed.length} tool${failed.length === 1 ? '' : 's'} failed`);
        if (this._CANT_RX.test(String(answerText || ''))) reasons.push('answer says it could not');
        if (this._LATER_RX.test(String(userText || ''))) reasons.push('user stated a plan for later');
        return reasons;
    },

    _norm(s) {
        return String(s || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
    },

    /** Verbatim (normalized) substring of the user's message, at least 3 chars. */
    _quoted(quote, userText) {
        const q = this._norm(quote);
        return q.length >= 3 && this._norm(userText).includes(q);
    },

    /**
     * T2: the model's answer → a thread, or null. `snapshot` is the setup
     * state right now (see snapshot()); a blocker that is not currently true
     * is dropped (the thread stays, without one).
     */
    validate(raw, { userText, snapshot }) {
        const t = raw && typeof raw === 'object' ? (raw.thread === undefined ? raw : raw.thread) : null;
        if (!t || typeof t !== 'object') return null;
        if (!this.OUTCOMES.includes(t.outcome)) return null;
        if (typeof t.asked !== 'string' || !this._quoted(t.asked, userText)) return null;
        const summary = typeof t.summary === 'string' ? t.summary.trim().slice(0, 200) : '';
        if (!summary) return null;

        let blocker = typeof t.blocker === 'string' && this.BLOCKERS[t.blocker] ? t.blocker : null;
        let feature = blocker === 'feature_off' && typeof t.feature === 'string' && this.USER_FLAGS.includes(t.feature) ? t.feature : null;
        if (blocker && !(snapshot && this.BLOCKERS[blocker](snapshot, feature))) { blocker = null; feature = null; }

        let next = null;
        if (t.next && typeof t.next === 'object' && typeof t.next.quote === 'string' && this._quoted(t.next.quote, userText)) {
            next = { quote: t.next.quote.trim().slice(0, 200), when: typeof t.next.when === 'string' ? t.next.when.trim().slice(0, 40) || null : null };
        }
        // A "later" thread is about the person's own plan; without the plan
        // in their words there is nothing to come back to.
        if (t.outcome === 'later' && !next) return null;

        return { outcome: t.outcome, asked: t.asked.trim().slice(0, 300), summary, blocker, feature, next };
    },

    /** T5: one thread per user message. */
    identity(convId, msgIndex) {
        return `${convId}:${msgIndex}`;
    },

    /** Is the thread's blocker still in place, by the app's own checks? */
    blockerHolds(thread, snapshot) {
        if (!thread || !thread.blocker || !this.BLOCKERS[thread.blocker] || !snapshot) return false;
        return this.BLOCKERS[thread.blocker](snapshot, thread.feature);
    },

    /* ---------- the app's own checks ---------- */

    /** What is set up right now — the same signals get_setup_status reads. */
    async snapshot() {
        const s = { googleAccounts: 0, mail: false, calendar: false, webSearch: false, vision: false, featuresOff: [] };
        try {
            const accounts = (typeof AccountsManager !== 'undefined' ? AccountsManager.getAll() : []) || [];
            s.googleAccounts = accounts.length;
            s.mail = accounts.some(a => a.services?.mail === true);
            s.calendar = accounts.some(a => a.services?.calendar === true);
        } catch { /* none */ }
        try {
            const st = await window.electronSearch?.getStatus?.();
            s.webSearch = !!(st && st.enabled);
        } catch { /* off */ }
        try {
            if (typeof AgentService !== 'undefined' && AgentService.supportsVision) {
                await AgentService.ensureVisionInfo?.();
                s.vision = !!AgentService.supportsVision();
            }
        } catch { /* unknown → treated as no vision */ }
        try {
            if (typeof FEATURES !== 'undefined') s.featuresOff = this.USER_FLAGS.filter(f => !FEATURES.isEnabled(f));
        } catch { /* none */ }
        return s;
    },

    enabled() {
        try { return typeof FEATURES !== 'undefined' && FEATURES.isEnabled('openthreads'); } catch { return false; }
    },

    /* ---------- storage ---------- */

    _blob() {
        let d = null;
        try { d = StorageManager.get(this.KEY); } catch { /* first run */ }
        return (d && Array.isArray(d.threads)) ? d : { threads: [] };
    },

    _save(blob) {
        blob.threads = blob.threads.slice(-this.MAX_THREADS);
        try { StorageManager.set(this.KEY, blob); } catch (e) { console.warn('[open-threads] save failed:', e?.message); }
    },

    threads() {
        return this._blob().threads;
    },

    /* ---------- capture ---------- */

    _examining: new Set(),

    /**
     * Called by AgentService at the end of every saved chat turn. Cheap when
     * nothing is open (T1); fire-and-forget, never throws.
     */
    async captureTurn({ conv, userText, answerText, toolLog, toolLimit, isError, untrusted }) {
        try {
            if (!this.enabled() || !conv || !conv.id) return;
            // T3
            if (untrusted || conv.contextMode === 'simple') return;
            if (typeof PrivateChat !== 'undefined' && PrivateChat.isPrivate(conv)) return;
            const text = String(userText || '').trim();
            if (text.length < 8) return;

            const reasons = this.signals({ userText: text, answerText, toolLog, toolLimit, isError });
            if (!reasons.length) return;

            const msgIndex = (conv.messages || []).map(m => m.role).lastIndexOf('user');
            const id = this.identity(conv.id, msgIndex);
            if (this._examining.has(id) || this.threads().some(t => t.id === id)) return;
            this._examining.add(id);

            const snapshot = await this.snapshot();
            const raw = await this._ask({ userText: text, answerText, toolLog, toolLimit, isError, snapshot });
            const thread = this.validate(raw, { userText: text, snapshot });
            this._examining.delete(id);
            if (!thread) return;

            const blob = this._blob();
            if (blob.threads.some(t => t.id === id)) return;
            blob.threads.push({
                id, convId: conv.id, msgIndex,
                at: new Date().toISOString(),
                status: 'open',
                reasons,
                ...thread
            });
            this._save(blob);
        } catch (e) {
            console.warn('[open-threads] capture failed:', e?.message || e);
        }
    },

    async _ask({ userText, answerText, toolLog, toolLimit, isError, snapshot }) {
        if (typeof LLMLogger === 'undefined' || typeof AgentService === 'undefined') return null;
        const failed = (toolLog || []).filter(t => !t.ok).slice(0, 6)
            .map(t => `- ${t.tool}: ${String(t.error || 'failed').slice(0, 140)}`).join('\n');
        const setup = [
            `no_google_account: ${snapshot.googleAccounts === 0}`,
            `no_mail: ${!snapshot.mail}`,
            `no_calendar: ${!snapshot.calendar}`,
            `no_web_search: ${!snapshot.webSearch}`,
            `no_vision (the model cannot look at images): ${!snapshot.vision}`,
            `feature_off (experimental features that are off): ${(snapshot.featuresOff || []).join(', ') || 'none'}`
        ].join('\n');
        const res = await LLMLogger.call(this.SOURCE, {
            model: AgentService.model,
            messages: [
                { role: 'system', content: 'You read one exchange between a person and their assistant and say whether the person\'s request was left open. You answer with JSON only. Most requests were simply answered, and {"thread": null} is then the right answer.' },
                { role: 'user', content: `PERSON:
"""
${String(userText).slice(0, 1500)}
"""

ASSISTANT'S ANSWER:
"""
${String(answerText || '(no answer)').slice(0, 1500)}
"""

WHAT THE APP RECORDED:
${failed ? `Tools that failed:\n${failed}` : 'No tool failed.'}
${toolLimit ? 'The assistant ran out of tool budget before finishing.' : ''}${isError ? 'The turn ended in an error.' : ''}

SETUP RIGHT NOW (true means missing):
${setup}

Was the request left open? Outcomes:
- "partly": some of it was done, some was not.
- "couldnt": the assistant could not do it.
- "waiting": it needs something from the person first (an answer, a login, a file).
- "later": the person said they will decide or do something later.
If it was fully handled, answer {"thread": null}.

Rules:
- "asked" must be a phrase COPIED EXACTLY from the PERSON's message.
- "blocker": only if the ASSISTANT'S ANSWER says it could not because of one of the setup items that is true above. Use that item's name, else null. For feature_off also give "feature" (one name from the list).
- "next": only when the PERSON said what they will do or when; its "quote" copied exactly from their message, "when" as they said it (or null).
- A plan is never done: "I'll decide next week" is "later".
- "summary": what is still open, in at most 20 words.

Answer with exactly this shape:
{"thread": {"outcome": "...", "asked": "...", "summary": "...", "blocker": null, "feature": null, "next": null}}` }
            ],
            format: 'json',
            think: false,
            maxTokens: 300,
            options: { temperature: 0.1, num_ctx: AgentService.numCtx || 8192 },
            stream: false,
            jobClass: 'background',
            logTag: 'open-threads'
        });
        if (res?.error) return null;
        const out = String(res?.message?.content || '').replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
        try { return JSON.parse(out); } catch { return null; }
    },

    /* ---------- Phase 0 review (console only — no UI by design) ---------- */

    /**
     * What the captures look like, newest first, with whether each blocker
     * still holds right now — the "could I do it now?" Phase 1 will act on.
     */
    async review() {
        const snapshot = await this.snapshot();
        const rows = this.threads().slice().reverse().map(t => ({
            when: String(t.at || '').slice(0, 16).replace('T', ' '),
            outcome: t.outcome,
            asked: t.asked,
            open: t.summary,
            blocker: t.blocker ? (t.feature ? `${t.blocker}:${t.feature}` : t.blocker) : '',
            canNow: t.blocker ? !this.blockerHolds(t, snapshot) : '',
            next: t.next ? `${t.next.quote}${t.next.when ? ` (${t.next.when})` : ''}` : '',
            why: (t.reasons || []).join('; ')
        }));
        console.log(`[open-threads] ${rows.length} open thread${rows.length === 1 ? '' : 's'} on this Mac`);
        if (console.table) console.table(rows); else console.log(rows);
        return rows;
    },

    /** Wipe every captured thread on this Mac (Phase 0 housekeeping). */
    forget() {
        this._save({ threads: [] });
        return 0;
    }
};

if (typeof window !== 'undefined') window.OpenThreads = OpenThreads;
if (typeof module !== 'undefined' && module.exports) module.exports = OpenThreads;
