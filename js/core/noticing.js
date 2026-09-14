/**
 * Noticing — P0 (docs/NOTICING.md).
 *
 * The app reads what the user writes about their own life and records a
 * MOMENT when something in it is worth a quiet follow-up later. This phase
 * deliberately RENDERS NOTHING: moments are written to storage and every
 * call appears in AI Activity under the `noticing` tag, so a week of real
 * moments can be read (`Noticing.review()` in the console) before anything
 * reaches the home page. That review is what decides whether P1 is built —
 * see the doc's decision log, "P0 renders nothing on purpose".
 *
 * Source for P0: JOURNAL entries only (docs/NOTICING.md open question 2).
 *
 * The laws that shape this file, with the code that carries each:
 *
 *   N1  noticed, never inferred    `_validate` drops a moment whose quote is
 *                                  not verbatim in the entry
 *   N2  the finished thought       `SETTLE_MS` — an entry untouched for 20
 *                                  minutes; the journal autosaves every 1 s
 *   N3  never answer immediately   nothing here surfaces at all; the delay
 *                                  is structural in P0
 *   N7  silence has a budget       `_budgeted` — over the weekly cap a
 *                                  moment is still RECORDED (P0 is a review
 *                                  phase) but marked `budgeted: false`
 *   N8  the brain decides          CloudPrivacy's `noticing` → `journal`
 *                                  class guard, plus metered-brain skip
 *   N9  a moment is not a fact     nothing here writes to MemoryManager
 *   N10 dismissal travels          `app_noticing` is record-merged with
 *                                  per-moment `updatedAt` + tombstones
 *   N11 the journal is private     no render path exists in this file
 *
 * Trigger discipline is ROUTINE_TRIGGERS.md's, because the same two failure
 * directions apply (T3): turning noticing on must not replay the user's
 * whole journal, and a gap must not lose the present. The floor
 * (`local.floorMs`, stamped once on first run) defends the first; the
 * examined-identity ledger — identity, never a timestamp (T1, T4) — defends
 * the second. A moment's ID IS its identity, so a second Mac that notices
 * the same entry writes the SAME record and the union merge folds them into
 * one (T7: a duplicate is cheap, silence is not).
 *
 * Storage: synced `noticing` = { moments: [], tombstones: {} } (in
 * RECORD_MERGED_KEYS); machine-local `noticing-local` in localStorage =
 * { floorMs, examined: {identity: ms} } — the ledger must never sync, for
 * the same reason `routine-state` and `app-usage` do not.
 */
const Noticing = {
    KEY: 'noticing',
    LOCAL_KEY: 'noticing-local',

    // N2: a journal entry saves every second while it is being written, so
    // "saved" is not "finished". Twenty minutes untouched is a thought the
    // user has walked away from.
    SETTLE_MS: 20 * 60 * 1000,
    SCAN_MS: 10 * 60 * 1000,
    START_DELAY_MS: 45 * 1000,
    // T3, the replay direction: an entry older than this is never a
    // candidate, whatever the ledger says.
    HORIZON_MS: 7 * 24 * 60 * 60 * 1000,

    // The shortlist gate is about COST, not about substance: one small call
    // per finished entry is affordable, so this only has to exclude "ok" and
    // "test". A length floor big enough to be interesting would have dropped
    // "I miss my puppy" (16 characters), which is the entry this whole
    // feature exists for.
    MIN_CHARS: 12,
    MIN_WORDS: 3,
    MAX_TEXT: 4000,

    BUDGET_PER_WEEK: 2,
    BUDGET_WINDOW_MS: 7 * 24 * 60 * 60 * 1000,

    CALLS_PER_SCAN: 3,      // a batch of settled entries must not hammer a local engine
    MOMENT_MAX: 200,        // ledger bound (the R1 lesson: every set needs a cap)
    EXAMINED_MAX: 500,
    QUOTE_MAX: 300,
    KIND_MAX: 40,
    CONFIDENCE: ['low', 'medium', 'high'],

    _timer: null,
    _busy: false,
    _local: null,

    /* ---------- Pure core (Node-testable; pinned by tests/noticing-test.js) ---------- */

    /**
     * Journal entries are rich-editor HTML. This is the same conversion the
     * journal's own AgentContext provider does — block tags become newlines,
     * everything else falls away.
     */
    plainText(html) {
        return String(html || '')
            .replace(/<\/?(p|div|br|h[1-6]|li)[^>]*>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    },

    substantial(text) {
        const t = String(text || '').trim();
        if (t.length < this.MIN_CHARS) return false;
        return t.split(/\s+/).filter(Boolean).length >= this.MIN_WORDS;
    },

    // Two 32-bit hashes, the news-summary cache's trick: one 32-bit key makes
    // a collision improbable, the pair makes it negligible. A collision here
    // would mean an entry silently never noticed.
    hash(s) {
        const str = String(s || '');
        let h1 = 5381, h2 = 0;
        for (let i = 0; i < str.length; i++) {
            h1 = ((h1 << 5) + h1 + str.charCodeAt(i)) >>> 0;
            h2 = (str.charCodeAt(i) + ((h2 << 6) >>> 0) + ((h2 << 16) >>> 0) - h2) >>> 0;
        }
        return h1.toString(36) + '-' + h2.toString(36);
    },

    /**
     * The identity of a thing-to-notice: the source record AND its content.
     * An edited entry is a new thing (the user changed what they said); a
     * re-saved identical entry is not. T1/T4 — never a timestamp.
     */
    identity(source, recordId, text) {
        return `${source}:${recordId}:${this.hash(text)}`;
    },

    /**
     * Is this entry ready to be looked at? Pure over plain data so the two
     * failure directions can be tested without a clock or a journal.
     * Returns a reason string instead of false, because "not yet" and
     * "never" are different answers (T6).
     */
    dueState(entry, now, opts = {}) {
        const floorMs = Number(opts.floorMs) || 0;
        const text = String(entry?.text || '');
        if (!this.substantial(text)) return 'thin';
        const edited = Date.parse(entry?.modifiedAt || entry?.date || '') || 0;
        if (!edited) return 'undated';
        if (edited <= floorMs) return 'before-floor';          // T3, replay direction
        if (now - edited > this.HORIZON_MS) return 'stale';
        if (now - edited < this.SETTLE_MS) return 'unsettled';  // N2
        return 'due';
    },

    /**
     * Model answer -> moment, or null. Everything the model says is checked
     * against the entry it was given: the quote must be VERBATIM (N1), the
     * kind is slugged to a few plain words, and the confidence must be one of
     * three words. A moment that fails any of these is not softened — it is
     * dropped, because an unanchored claim about a person cannot be fixed
     * later.
     */
    validate(raw, ctx = {}) {
        const m = raw && typeof raw === 'object' ? (raw.moment || raw) : null;
        if (!m || typeof m !== 'object') return null;
        const quote = String(m.quote || '').replace(/\s+/g, ' ').trim();
        if (quote.length < 3 || quote.length > this.QUOTE_MAX) return null;
        const hay = String(ctx.text || '').replace(/\s+/g, ' ').toLowerCase();
        if (!hay.includes(quote.toLowerCase())) return null;   // N1: verbatim or nothing
        const kind = String(m.kind || '').toLowerCase()
            .replace(/[^a-z0-9 -]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, this.KIND_MAX);
        if (!kind) return null;
        const conf = this.CONFIDENCE.includes(String(m.confidence || '').toLowerCase())
            ? String(m.confidence).toLowerCase() : 'low';
        const at = ctx.now ? new Date(ctx.now).toISOString() : new Date().toISOString();
        return {
            id: ctx.id || this.identity(ctx.source || 'journal', ctx.recordId || '', ctx.text || ''),
            source: ctx.source || 'journal',
            recordId: String(ctx.recordId || ''),
            kind,
            quote: quote.slice(0, this.QUOTE_MAX),
            confidence: conf,
            sourceDate: ctx.sourceDate || null,
            noticedAt: at,
            // P1 owns 'shown' and 'dismissed'; P0 only ever writes 'new'.
            state: 'new',
            budgeted: !!ctx.budgeted,
            createdAt: at,
            updatedAt: at
        };
    },

    /**
     * N7 — would this one be allowed to speak? Counts only moments that were
     * themselves budgeted, in the trailing week. P0 records the rest anyway
     * (with `budgeted: false`) precisely so the review can see what a cap of
     * two per week would have silenced.
     */
    budgeted(moments, now) {
        const since = now - this.BUDGET_WINDOW_MS;
        const used = (Array.isArray(moments) ? moments : []).filter(m =>
            m && m.budgeted && (Date.parse(m.noticedAt || '') || 0) >= since).length;
        return used < this.BUDGET_PER_WEEK;
    },

    /** Ledger bound: newest MOMENT_MAX kept, the rest named for tombstoning. */
    overflow(moments) {
        const list = (Array.isArray(moments) ? moments : []).slice()
            .sort((a, b) => (Date.parse(b?.noticedAt || '') || 0) - (Date.parse(a?.noticedAt || '') || 0));
        return list.slice(this.MOMENT_MAX).map(m => m.id).filter(Boolean);
    },

    /* ---------- Storage ---------- */

    _blob() {
        let d = null;
        try { d = StorageManager.get(this.KEY); } catch { /* first run */ }
        if (!d || typeof d !== 'object') d = {};
        if (!Array.isArray(d.moments)) d.moments = [];
        if (!d.tombstones || typeof d.tombstones !== 'object') d.tombstones = {};
        return d;
    },

    moments() { return this._blob().moments; },

    _save(blob) {
        try { StorageManager.set(this.KEY, blob); } catch (e) { console.warn('[noticing] save failed:', e?.message); }
    },

    // Record-merged key: a removal MUST tombstone or the union resurrects it
    // on the next merge (the portfolio lesson).
    _tombstone(blob, id) {
        if (!id) return;
        blob.tombstones[id] = new Date().toISOString();
    },

    local() {
        if (this._local) return this._local;
        let d = null;
        try { d = JSON.parse(localStorage.getItem(this.LOCAL_KEY) || 'null'); } catch { /* corrupt */ }
        this._local = (d && typeof d === 'object') ? d : {};
        if (!this._local.examined || typeof this._local.examined !== 'object') this._local.examined = {};
        return this._local;
    },

    _saveLocal() {
        try { localStorage.setItem(this.LOCAL_KEY, JSON.stringify(this._local || {})); } catch { /* quota */ }
    },

    _markExamined(id) {
        const l = this.local();
        l.examined[id] = Date.now();
        const ids = Object.keys(l.examined);
        if (ids.length > this.EXAMINED_MAX) {
            ids.sort((a, b) => (l.examined[a] || 0) - (l.examined[b] || 0));
            for (const k of ids.slice(0, ids.length - this.EXAMINED_MAX)) delete l.examined[k];
        }
        this._saveLocal();
    },

    /* ---------- The pass ---------- */

    /**
     * Started from AppManager.init behind the `noticing` flag — never from a
     * view (defect D5: an engine's liveness must not depend on a page being
     * visited). The first run stamps the floor, which is what stops turning
     * the feature on from replaying a year of journal entries (T3).
     */
    init() {
        if (this._timer) return;
        const l = this.local();
        if (!l.floorMs) {
            l.floorMs = Date.now();
            this._saveLocal();
            console.log('[noticing] armed; entries written before now are not candidates');
        }
        this._timer = setInterval(() => this.scan(), this.SCAN_MS);
        setTimeout(() => this.scan(), this.START_DELAY_MS);
    },

    stop() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
    },

    /** Why a scan would do nothing, as a sentence, or null when it can run. */
    blockedReason() {
        if (typeof AgentService === 'undefined' || !AgentService.model) return 'no model chosen';
        if (!window.electronLLM?.chat || typeof LLMLogger === 'undefined') return 'no LLM bridge';
        // N8, second half: nobody should pay per token to be noticed.
        if (AgentService.isMeteredBrain?.()) return 'metered brain';
        // N8, first half. The LLMLogger guard would refuse the call anyway;
        // checking here keeps a blocked Mac from reading the journal at all.
        if (typeof CloudPrivacy !== 'undefined' && !CloudPrivacy.allows('journal')) {
            return 'journal may not leave this Mac with the current brain';
        }
        return null;
    },

    async scan() {
        if (this._busy) return;
        const why = this.blockedReason();
        if (why) return;
        // Yield to the person: a background pass must never sit in front of
        // a chat the user is waiting on (the portfolio sweep's rule).
        try {
            if (AgentService.getActiveStreamingConvIds?.().length) return;
        } catch { /* not fatal */ }

        this._busy = true;
        try {
            const now = Date.now();
            const floorMs = this.local().floorMs || 0;
            const entries = this._journalEntries();
            const blob = this._blob();
            const known = new Set(blob.moments.map(m => m && m.id));
            const examined = this.local().examined;
            let calls = 0;

            for (const e of entries) {
                if (calls >= this.CALLS_PER_SCAN) break;
                const text = this.plainText(e.content).slice(0, this.MAX_TEXT);
                const state = this.dueState({ text, modifiedAt: e.modifiedAt, date: e.date }, now, { floorMs });
                if (state !== 'due') continue;
                const id = this.identity('journal', e.id, text);
                // Already looked at here, or already noticed on the other Mac
                // (the record union means the id is the dedupe — T7).
                if (examined[id] || known.has(id)) continue;

                calls++;
                let raw = null;
                try { raw = await this._ask(text, e); } catch { /* the pass is optional */ }
                // Marked whether or not anything came back: an entry that
                // says nothing must not be re-asked every ten minutes.
                this._markExamined(id);
                if (!raw) continue;

                const fresh = this._blob();   // re-read: the call took time
                const moment = this.validate(raw, {
                    id, text, source: 'journal', recordId: e.id,
                    sourceDate: e.date || e.modifiedAt || null,
                    budgeted: this.budgeted(fresh.moments, now),
                    now
                });
                if (!moment) continue;
                if (fresh.moments.some(m => m && m.id === moment.id)) continue;
                fresh.moments.push(moment);
                for (const gone of this.overflow(fresh.moments)) {
                    const i = fresh.moments.findIndex(m => m && m.id === gone);
                    if (i >= 0) { this._tombstone(fresh, gone); fresh.moments.splice(i, 1); }
                }
                this._save(fresh);
                console.log(`[noticing] moment (${moment.kind}${moment.budgeted ? '' : ', over budget'}): "${moment.quote}"`);
            }
        } catch (e) {
            console.warn('[noticing] scan failed:', e?.message);
        } finally {
            this._busy = false;
        }
    },

    _journalEntries() {
        let d = null;
        try { d = StorageManager.get('journal'); } catch { /* none */ }
        const list = (d && Array.isArray(d.entries)) ? d.entries : [];
        return list.filter(e => e && e.id);
    },

    /**
     * The one call. Narrow on purpose: it may answer null, it may not read
     * emotions into the text, and it must copy a sentence rather than write
     * one (N1). Null is the expected answer for most entries and the prompt
     * says so — a model that thinks it is being graded on finding something
     * will find something in a grocery list.
     */
    async _ask(text, entry) {
        const when = entry?.date ? String(entry.date).slice(0, 10) : 'recently';
        const res = await LLMLogger.call('noticing', {
            model: AgentService.model,
            messages: [
                { role: 'system', content: 'You read one private journal entry and decide whether it holds something a good friend would quietly follow up on a day or two later. You answer with JSON only, no prose. Most entries hold nothing, and saying so is the right answer.' },
                { role: 'user', content: `JOURNAL ENTRY (written ${when}):
"""
${text}
"""

Is there something here that a friend who cared about this person would gently come back to later — something they are missing, carrying, looking forward to, stuck on, or deciding?

Rules:
- If it is not clearly there, answer {"moment": null}. Most entries are ordinary and null is the honest answer.
- Do not read emotions into the text, do not diagnose, do not summarise the entry, do not give advice.
- The quote must be a sentence COPIED EXACTLY from the entry above, word for word. If you cannot copy one, answer {"moment": null}.

Answer with exactly this shape:
{"moment": {"kind": "<two or three plain words for what it is, like: missing someone, a decision, a trip coming up, something stuck>", "quote": "<the exact sentence from the entry>", "confidence": "low|medium|high"}}` }
            ],
            format: 'json',
            // Capped call: think:false or a thinking model burns the cap.
            think: false,
            maxTokens: 200,
            options: { temperature: 0.1, num_ctx: AgentService.numCtx || 8192 },
            stream: false,
            jobClass: 'background',
            logTag: 'noticing'
        });
        if (res?.error) return null;
        const out = String(res?.message?.content || '')
            .replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
        try { return JSON.parse(out); } catch { return null; }
    },

    /* ---------- P0 review (console only — there is no UI by design) ---------- */

    /**
     * What a week of noticing produced, newest first. The question to ask of
     * each row is the one in the doc: would a friend have said this?
     */
    review() {
        const rows = this.moments().slice()
            .sort((a, b) => (Date.parse(b?.noticedAt || '') || 0) - (Date.parse(a?.noticedAt || '') || 0))
            .map(m => ({
                when: String(m.noticedAt || '').slice(0, 16).replace('T', ' '),
                kind: m.kind,
                confidence: m.confidence,
                wouldShow: !!m.budgeted,
                quote: m.quote,
                entry: m.recordId
            }));
        const l = this.local();
        console.log(`[noticing] ${rows.length} moments; ${Object.keys(l.examined || {}).length} entries examined; armed ${l.floorMs ? new Date(l.floorMs).toLocaleString() : 'never'}`);
        if (console.table) console.table(rows); else console.log(rows);
        return rows;
    },

    /** Wipe this Mac's ledger and every moment (P0 housekeeping). */
    forget() {
        const blob = this._blob();
        for (const m of blob.moments) this._tombstone(blob, m.id);
        blob.moments = [];
        this._save(blob);
        this._local = { floorMs: Date.now(), examined: {} };
        this._saveLocal();
        return 'forgotten';
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = Noticing;
