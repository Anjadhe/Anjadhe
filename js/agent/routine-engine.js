/**
 * RoutineEngine — what decides that a routine should run, and queues it.
 *
 * A peer of TaskService (docs/ROUTINE_TRIGGERS.md R5), extracted out of
 * PromptFeed on 2026-08-03. The split is by JOB, not by file size:
 *
 *   RoutineEngine   decides WHEN and WHAT fired — trigger evaluation,
 *                   per-routine state, the run queue, observability.
 *   PromptFeed      decides HOW a fired routine runs and WHERE its result
 *                   goes — generation, task hand-off, the feed itself.
 *   EmailApp        stays the mail source, and is PUSHED from (R3, later).
 *
 * Why it is its own module, bootstrapped from `AppManager.init`: D5. A
 * routine's liveness used to depend on surfaces it has nothing to do with —
 * the scheduler started inside the Home feed's init, and the email sync that
 * feeds the email trigger is bootstrapped by the Home *widget*. Background
 * work whose liveness depends on a view is work that silently stops; that is
 * the same lesson `EmailApp.resumeAnalysisBacklog()` moving into
 * `AppManager.init` taught, applied structurally instead of by another call
 * site.
 *
 * ── State, and which half of it is allowed to sync ────────────────────────
 *
 * `state` is the SYNCED `promptFeed` blob and keeps exactly what it always
 * kept: `runs` (per-routine last-run stamp, merged newest-stamp-per-id by
 * main.js RECORD_MERGED_KEYS — that merge is why a daily routine stopped
 * firing three times a day) and `errors` (last trigger-level failure).
 *
 * `local` is MACHINE-LOCAL (localStorage) and holds what must never ride a
 * synced key: the observability stamps, which are rewritten on every 5-minute
 * tick, and the run queue, which is volatile execution state. Re-stamping a
 * synced blob every five minutes is the exact defect CLAUDE.md records
 * against the portfolio price cache — a Mac that merely LOOKED at the data
 * outranking another Mac's real edits.
 *
 * ── The queue ─────────────────────────────────────────────────────────────
 *
 * `tick()` used to start ONE task-mode routine and `break`, with nothing
 * queueing the rest (D1's compounding half). Fired triggers now enqueue
 * `(routineId, identity)` and drain in arrival order: task-mode runs go
 * serially through TaskService's single slot, digests interleave past a
 * task-mode item that is waiting for it. `identity` is what fired — a
 * messageId, a file path, a schedule slot — and it dedupes the queue, which
 * matters right now because a queued item has not stamped `runs` yet and
 * would otherwise be re-enqueued on every tick while it waited.
 *
 * ── R1: the identity ledger (2026-08-03) ──────────────────────────────────
 *
 * A trigger is a difference, and the difference is computed against
 * IDENTITY, not time (T1). `state.seen[routineId] = { ids, floorMs, sig }`
 * is the per-routine processed-set: `ids` maps identity keys (`mail:<id>`,
 * `file:<path>|<size>`) to the ms this Mac first acted on them — an ARRIVAL
 * record, ours, which is the only clock T4 lets us trust. What follows from
 * it:
 *
 *  - EVERY unprocessed match fires, not just the newest (T2/D1): three
 *    invoices in one poll window are three queue items, each carrying the
 *    identity that fired it.
 *  - `floorMs` is fixed at arm time and NEVER advances with runs. Its job
 *    is T3's replay defense (pre-arming mail must not fire) and the
 *    degrade-path when a ledger is lost; it is no longer the dedupe. So a
 *    message SENT after arming but FETCHED late — the fullSyncAccount
 *    re-pull, D2 — fires when it lands, because its id is not in the set.
 *  - Files are identified by name+size, never mtime (T4): a file copied in
 *    with `cp -p` and a 2019 timestamp is still a new thing. The folder's
 *    contents at arm time are SEEDED into the set — without that, R1 would
 *    turn "don't replay history" into "replay all of it" (the seeding half
 *    of T3 the doc warns about). A changed folder/pattern re-seeds (`sig`).
 *  - The set is BOUNDED (newest SEEN_MAX_IDS by stamp) and unions across
 *    Macs with no tie-break — nothing ever un-processes a thing — which is
 *    what makes T7's fail-open duplicate on a second Mac a no-op. The cap
 *    is enforced in main.js's merge too, because every renderer write of
 *    the key passes through that union.
 *  - Non-matching scanned mail is stamped as seen as well: "seen" means
 *    EVALUATED, so a `contains` rule fetches a body at most once per
 *    message ever, and editing a rule does not replay mail the old rule
 *    already considered.
 */

const RoutineEngine = {
    LOCAL_KEY: 'routine-state',

    // Poll cadence — how often we check whether any routine is due. The
    // actual run frequency is governed per-routine by its trigger.
    POLL_MS: 5 * 60 * 1000,

    // How many fresh messages an email trigger will look at in one tick.
    // Only mail newer than `_sinceMs` is ever a candidate, so this bites
    // solely on a first poll after a long sleep — and a rule that matched
    // 40 messages ago has newer matches too.
    EMAIL_TRIGGER_SCAN: 60,

    // A queue this long means something is wrong (a routine matching every
    // message); dropping the OLDEST keeps the newest work moving. A dropped
    // item is not lost — its identity was never stamped, so the next tick
    // re-notices it.
    QUEUE_MAX: 50,

    // R1 bounds on the per-routine processed-set. The cap works because the
    // email scan window is the newest EMAIL_TRIGGER_SCAN messages — an
    // evicted stamp belongs to a message hundreds of newer stamps deep,
    // which can no longer re-enter candidacy. (A folder holding more than
    // SEEN_MAX_IDS matching files is the one place eviction could re-fire
    // an old identity; documented trade.)
    SEEN_MAX_IDS: 500,
    SEEN_MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000,

    INTERVAL_MS: {
        hourly: 60 * 60 * 1000,
        '6h':   6 * 60 * 60 * 1000,
        daily:  24 * 60 * 60 * 1000,
        weekdays: 24 * 60 * 60 * 1000,
        weekly: 7 * 24 * 60 * 60 * 1000
    },

    // The synced promptFeed blob (see the header for the split).
    state: { items: [], runs: {}, errors: {} },
    // Machine-local: observability stamps + the run queue.
    local: { checks: {}, queue: [] },

    _timer: null,
    _nudgeTimer: null,
    _busy: false,
    _draining: false,
    _inited: false,
    _ready: null,
    _machineId: null,

    /* ---------- Lifecycle ---------- */

    init() {
        if (this._inited) return this._ready;
        this._inited = true;
        this.load();
        this.loadLocal();
        this._ready = this._loadMachineId().then(() => { this._ensureMailSync(); });
        this.startScheduler();
        return this._ready;
    },

    /* ---------- State ---------- */

    load() {
        const d = StorageManager.get('promptFeed');
        this.state = {
            // Legacy pre-notes posts. PromptFeed._migrateLegacyItems folds
            // them into feed notes and empties this; carried here so the
            // engine's own saves can never drop unmigrated posts.
            items: (d && Array.isArray(d.items)) ? d.items : [],
            runs: (d && d.runs && typeof d.runs === 'object') ? d.runs : {},
            errors: (d && d.errors && typeof d.errors === 'object') ? d.errors : {},
            // R1: per-routine processed-identity sets (see the header).
            seen: (d && d.seen && typeof d.seen === 'object') ? d.seen : {}
        };
        return this.state;
    },

    save() {
        StorageManager.set('promptFeed', this.state);
    },

    loadLocal() {
        let v = null;
        try { v = JSON.parse(localStorage.getItem(this.LOCAL_KEY) || 'null'); } catch { v = null; }
        this.local = {
            checks: (v && v.checks && typeof v.checks === 'object') ? v.checks : {},
            queue: (v && Array.isArray(v.queue)) ? v.queue : []
        };
        return this.local;
    },

    saveLocal() {
        try { localStorage.setItem(this.LOCAL_KEY, JSON.stringify(this.local)); }
        catch { /* observability is best-effort — never break a run */ }
    },

    /* ---------- Per-routine state (R4 observability) ---------- */

    /** Everything the Routines page needs to tell "has not matched" apart
     *  from "has been broken since the day you armed it" (T6, D4). */
    statusFor(routineId) {
        const c = (this.local.checks || {})[routineId] || {};
        return {
            lastCheckedAt: c.checkedAt || null,
            lastMatchedAt: c.matchedAt || null,
            lastRun: this.state.runs[routineId] || null,
            lastError: (this.state.errors || {})[routineId] || null,
            queued: (this.local.queue || []).filter(q => q && q.routineId === routineId).length
        };
    },

    _stamp(routineId, field, value) {
        const checks = this.local.checks || (this.local.checks = {});
        checks[routineId] = { ...(checks[routineId] || {}), [field]: value };
        this.saveLocal();
    },

    noteChecked(routineId) { this._stamp(routineId, 'checkedAt', new Date().toISOString()); },
    noteMatched(routineId) { this._stamp(routineId, 'matchedAt', new Date().toISOString()); },

    lastRun(routineId) { return this.state.runs[routineId] || null; },

    stampRun(routineId, at) {
        this.state.runs[routineId] = at || new Date().toISOString();
        this.save();
    },

    // A trigger-level failure (unreadable folder) is not a run, so it must
    // not stamp `runs` — but it does need somewhere to show. Kept on the
    // scheduler blob beside the run stamps, cleared by the next good run.
    noteError(routineId, error) {
        const msg = String(error || '').slice(0, 200);
        this.state.errors = this.state.errors || {};
        if (this.state.errors[routineId] === msg) return;   // don't spin the store
        this.state.errors[routineId] = msg;
        this.save();
    },

    clearError(routineId) {
        if (this.state.errors && this.state.errors[routineId]) delete this.state.errors[routineId];
    },

    /* ---------- Machine identity (C10 home-Mac pinning) ---------- */

    async _loadMachineId() {
        if (this._machineId) return this._machineId;
        try {
            const st = await window.electronSync?.getStatus?.();
            if (st && st.machineId) this._machineId = st.machineId;
        } catch { /* stays null — see _runsHere */ }
        return this._machineId;
    },

    /**
     * Does this Mac run the given routine?
     *
     * Fails OPEN on purpose (T7). An unpinned routine (every one written
     * before C10) runs anywhere, and so does one whose id we could not read —
     * a routine that never runs because an IPC call failed is a total outage,
     * while the cost of failing open is a duplicate post on a multi-Mac
     * install. The pin is dedupe, not a safety gate: safety is the arming
     * consent plus the per-step permission checks.
     */
    _runsHere(cfg) {
        if (!cfg.homeMachineId) return true;
        if (!this._machineId) return true;
        return cfg.homeMachineId === this._machineId;
    },

    /* ---------- The routines this Mac is responsible for ---------- */

    armedRoutines() {
        if (typeof NotePrompts === 'undefined') return [];
        return NotePrompts.list().filter(n => {
            const cfg = NotePrompts.config(n);
            return cfg.offline && this._runsHere(cfg) && NotePrompts.bodyText(n).trim();
        });
    },

    /**
     * D5's other half: the email trigger reads a mailbox that something else
     * has to keep fetching. That "something else" was the Home widget, so a
     * user who never saw Home had armed email routines against a mailbox
     * nothing was updating. If any armed routine carries an email trigger,
     * the engine owns starting the sync.
     */
    async _ensureMailSync() {
        try {
            if (typeof EmailApp === 'undefined') return;
            const wantsMail = this.armedRoutines().some(n =>
                (NotePrompts.config(n).trigger || {}).type === 'email');
            if (!wantsMail) return;
            const accounts = StorageManager.get('email')?.accounts;
            if (!Array.isArray(accounts) || !accounts.length) return;
            if (!EmailApp._dataLoaded) await EmailApp.loadData();
            if (!EmailApp.syncTimer && typeof EmailApp.startSmartSync === 'function') {
                EmailApp.startSmartSync();
                console.log('[routines] started mail sync for an armed email trigger');
            }
        } catch (e) {
            console.warn('[routines] could not ensure mail sync:', e?.message);
        }
    },

    /* ---------- Trigger evaluation ---------- */

    /**
     * Everything this routine's trigger has fired on, per R1: an ARRAY of
     * contexts, one per unprocessed thing — `suffix` (what fired it, in
     * words the run can use), `identity` (the thing itself — a messageId, a
     * file, a schedule slot), `label` (short name for the probe report).
     * Empty array = nothing fired; `{ error }` = the trigger could not be
     * evaluated at all.
     *
     * `opts.probe` evaluates without any side effect: no ledger init, no
     * stamps, no error notes. That is what makes "Test trigger" (R4)
     * honest — it reports what WOULD fire and changes nothing.
     */
    async _firedFor(prompt, now, opts = {}) {
        const cfg = NotePrompts.config(prompt);
        const t = cfg.trigger || { type: 'time' };
        if (t.type === 'email') return await this._dueForEmail(prompt, t, now, opts);
        if (t.type === 'file') return await this._dueForFile(prompt, t, now, opts);
        if (!this._isDue(prompt, now)) return { fired: [] };
        if (this._retroBlocked(prompt, cfg, now)) return { fired: [] };
        return { fired: [{ suffix: null, identity: this._timeIdentity(cfg, now) }] };
    },

    /** First-fired compatibility wrapper: null or one context. The probe
     *  variant carries the full picture (`matches`, `scanned`) so the Test
     *  trigger report can say "3 things match", not just name one. */
    async _dueFor(prompt, now, opts = {}) {
        const r = await this._firedFor(prompt, now, opts);
        if (r.error) return opts.probe ? { error: r.error } : null;
        if (!r.fired.length) return null;
        const first = r.fired[0];
        return {
            suffix: first.suffix, identity: first.identity,
            ...(opts.probe ? {
                matches: r.fired.map(f => f.label || f.suffix).filter(Boolean),
                ...(r.scanned != null ? { scanned: r.scanned } : {})
            } : {})
        };
    },

    /** A stable name for the schedule slot that fired, so a queued run is
     *  not re-enqueued on every tick while it waits for the task slot. */
    _timeIdentity(cfg, now) {
        if (cfg.time && ['daily', 'weekdays', 'weekly'].includes(cfg.interval)) {
            const [h, m] = String(cfg.time).split(':').map(Number);
            const occ = new Date(now);
            occ.setHours(h, m, 0, 0);
            if (occ.getTime() > now) occ.setDate(occ.getDate() - 1);
            return `slot:${occ.toISOString()}`;
        }
        const span = this.INTERVAL_MS[cfg.interval] || this.INTERVAL_MS.daily;
        return `span:${Math.floor(now / span)}`;
    },

    /**
     * Should a first run be suppressed because its slot had already passed
     * when the routine was armed?
     *
     * A digest's first run happens immediately on creation — long-standing
     * routine behaviour, and welcome: you get your first post right away. A
     * run that can WRITE is different. Arming "file invoices every morning at
     * 7" at 9am must not immediately file this morning's, because the user
     * was describing tomorrow.
     *
     * Only applies to the FIRST run (no stamp yet) of an anchored time
     * trigger. Email and file triggers get the same protection for free from
     * `_sinceMs`, which never looks back past `createdAt`.
     */
    _retroBlocked(prompt, cfg, now) {
        if (cfg.runMode !== 'task') return false;
        if (this.state.runs[prompt.id]) return false;
        const t = cfg.trigger;
        if (!t || t.type !== 'time' || !t.time) return false;
        const armedMs = Date.parse(prompt.createdAt) || 0;
        if (!armedMs) return false;
        const [h, m] = String(t.time).split(':').map(Number);
        const occ = new Date(now);
        occ.setHours(h, m, 0, 0);
        if (occ.getTime() > now) occ.setDate(occ.getDate() - 1);
        return occ.getTime() < armedMs;
    },

    // DEMOTED by R1 (T1): no longer the dedupe — that is the identity
    // ledger's job — this now only sets a new ledger's INITIAL floor. For a
    // brand-new routine that is "armed at"; for a routine that predates R1
    // it is the old marker (max of last run and armed), which preserves the
    // pre-R1 semantics exactly at the migration boundary: mail the old
    // engine had already passed over stays passed-over. After init, the
    // floor never moves again — that immobility is what fixes D2.
    _sinceMs(prompt) {
        const last = this.state.runs[prompt.id];
        const lastMs = last ? Date.parse(last) : 0;
        const armedMs = Date.parse(prompt.createdAt) || 0;
        return Math.max(lastMs || 0, armedMs);
    },

    /* ---------- R1: the per-routine processed-identity set ---------- */

    /**
     * The routine's ledger entry, created on first evaluation. `sig` names
     * the trigger the ids were recorded against — when it changes (a file
     * trigger pointed at a different folder), the old ids are about a
     * different watch and the entry re-initializes rather than firing on
     * everything in the new one. `probe` computes without persisting, so
     * "Test trigger" stays side-effect-free.
     */
    _seenEntry(prompt, sig, probe) {
        const cur = (this.state.seen || {})[prompt.id];
        if (cur && cur.sig === sig && cur.ids && typeof cur.ids === 'object') return cur;
        const entry = { ids: {}, floorMs: this._sinceMs(prompt), sig };
        if (!probe) {
            (this.state.seen = this.state.seen || {})[prompt.id] = entry;
            this.save();
        }
        return entry;
    },

    /** Record identities as processed/evaluated. Stamp ms is Date.now() —
     *  when THIS Mac first acted, the arrival clock T4 asks for (R2b). */
    stampSeen(routineId, keys) {
        const entry = (this.state.seen || {})[routineId];
        if (!entry) return;
        const now = Date.now();
        for (const k of (Array.isArray(keys) ? keys : [keys])) {
            if (k) entry.ids[k] = now;
        }
        this._pruneSeen(entry);
        this.save();
    },

    _pruneSeen(entry) {
        const cutoff = Date.now() - this.SEEN_MAX_AGE_MS;
        const ids = Object.keys(entry.ids);
        for (const k of ids) { if (entry.ids[k] < cutoff) delete entry.ids[k]; }
        const left = Object.keys(entry.ids);
        if (left.length > this.SEEN_MAX_IDS) {
            left.sort((x, y) => entry.ids[y] - entry.ids[x] || x.localeCompare(y));
            for (const k of left.slice(this.SEEN_MAX_IDS)) delete entry.ids[k];
        }
    },

    /**
     * The mailbox an email trigger reads.
     *
     * NOT `StorageManager.get('email').emails` — that field has not existed
     * since messages moved into the SQLite `emails` table, and reading it is
     * why NO email-triggered routine ever fired between C8.5 and C10 (D0).
     * EmailApp.emails is the loaded mailbox, and loading it is exactly what
     * an armed email routine needs — `loadData` dedupes in-flight callers, so
     * this cannot race the Email app or the home widget's bootstrap.
     */
    async _mailbox() {
        if (typeof EmailApp === 'undefined') return [];
        if (!EmailApp._dataLoaded) {
            const accounts = StorageManager.get('email')?.accounts;
            if (!Array.isArray(accounts) || !accounts.length) return [];
            try { await EmailApp.loadData(); }
            catch (e) { console.warn('[routines] mailbox load failed:', e?.message); return []; }
        }
        return Array.isArray(EmailApp.emails) ? EmailApp.emails : [];
    },

    _emailMs(e) {
        if (typeof EmailApp !== 'undefined' && EmailApp._emailTime) return EmailApp._emailTime(e);
        const raw = e.internalDate != null ? parseInt(e.internalDate, 10) : NaN;
        return Number.isNaN(raw) ? (Date.parse(e.date) || 0) : raw;
    },

    /**
     * Does this message mention `needle` anywhere the user would call "the
     * text"? Subject and snippet first (already in memory), then the body,
     * which lives in its own table and is fetched on demand — the candidate
     * set here is only mail newer than the last run, so that is a handful of
     * lookups, not a mailbox scan.
     */
    async _emailMentions(e, needle) {
        const hay = `${e.subject || ''}\n${e.snippet || ''}`.toLowerCase();
        if (hay.includes(needle)) return true;
        if (typeof EmailApp === 'undefined' || !EmailApp._ensureBody) return false;
        try {
            await EmailApp._ensureBody(e);
            return String(e.bodyText || '').toLowerCase().includes(needle);
        } catch { return false; }
    },

    async _dueForEmail(prompt, t, now, opts = {}) {
        const emails = await this._mailbox();
        if (!emails.length) return { fired: [], scanned: 0 };
        const entry = this._seenEntry(prompt, 'email', opts.probe);
        const from = (t.from || '').toLowerCase();
        const subject = (t.subject || '').toLowerCase();
        const contains = (t.contains || '').toLowerCase();

        // Incoming only: without this a rule matching "invoice" fires on the
        // user's own sent mail about an invoice, which is not "an email
        // arrived". Same NON_INCOMING_LABELS the insight sweep uses.
        //
        // ORDER IS LOAD-BEARING: slice the newest-N window BEFORE dropping
        // seen ids. Filtering seen first would make the window slide 60
        // messages deeper into the backlog each tick — a crawl that stamps
        // the whole mailbox, evicts the stamps of the NEWEST messages (they
        // were stamped first), and re-fires them. Sliced first, the scan set
        // is pinned to the mailbox's newest edge, an evicted stamp is always
        // hundreds of messages below it, and the pre-R1 property ("a rule
        // that matched 40 messages ago has newer matches too") is kept.
        const win = emails
            .filter(e => this._emailMs(e) > entry.floorMs
                && (typeof EmailApp === 'undefined' || EmailApp._isIncoming(e)))
            .sort((a, b) => this._emailMs(b) - this._emailMs(a))
            .slice(0, this.EMAIL_TRIGGER_SCAN);
        const candidates = win.filter(e => !entry.ids[`mail:${e.messageId || e.id}`]);

        const fired = [];
        const evaluated = [];
        for (const e of candidates) {
            const key = `mail:${e.messageId || e.id}`;
            const hit = (!from || String(e.from || '').toLowerCase().includes(from))
                && (!subject || String(e.subject || '').toLowerCase().includes(subject))
                && (!contains || await this._emailMentions(e, contains));
            if (hit) {
                // R6: the run is ABOUT this message, and its context says so
                // by ID — not just a subject line. The old wording left the
                // run to find its own mail, and a model whose trigger fired
                // "because an invoice arrived" rationally searched the whole
                // mailbox for invoices, redoing every earlier match's work
                // (D6). Each match is its own run now, so the compensation is
                // pure duplication.
                fired.push({
                    suffix: `Triggered by a new email — subject: "${e.subject || '(no subject)'}", from: ${e.from || 'unknown'}, email id: ${e.messageId || e.id}. This run is about THIS one email only — read it by that id. Do not search the mailbox for other matching emails: each match starts its own run, and earlier matches were already handled.`,
                    identity: key,
                    label: e.subject || '(no subject)'
                });
            } else {
                // Seen = EVALUATED, not matched: a `contains` body fetch
                // happens at most once per message ever, and a later rule
                // edit does not replay mail the old rule already considered.
                evaluated.push(key);
            }
        }
        // MATCHED identities are deliberately NOT stamped here — the drain
        // stamps them when it hands the run over, so a queue lost before the
        // run means the message fires again rather than being silently
        // swallowed (T7: duplicate beats silence).
        if (!opts.probe && evaluated.length) this.stampSeen(prompt.id, evaluated);
        return { fired, scanned: win.length };
    },

    async _dueForFile(prompt, t, now, opts = {}) {
        if (!window.electronAgentFS?.list) return { fired: [] };
        const r = await window.electronAgentFS.list(t.folder, t.pattern || undefined);
        if (r.error) {
            // Folder not granted or gone. Surface it on the routine and stop
            // — a timer must never raise a permission prompt. A PROBE reports
            // the error to its caller instead of writing it anywhere.
            if (opts.probe) return { error: r.error };
            this.noteError(prompt.id, r.error);
            return { fired: [] };
        }
        const sep = t.folder.endsWith('/') ? '' : '/';
        // Identity is name + size, never mtime (T4): mtime is whatever the
        // copier says it is — `cp -p` lands a brand-new file wearing a 2019
        // timestamp, and that file IS "a file appeared". Size rides along so
        // a same-named file re-landing with new content counts as new.
        const key = (f) => `file:${t.folder}${sep}${f.name}|${f.size ?? ''}`;
        const files = (r.entries || []).filter(f => !f.dir);

        // Seeding (T3's other half): the ledger's first sight of the folder
        // records what is ALREADY there, so arming can never replay it —
        // without this, pure identity would fire once per existing file the
        // moment the rule was armed. The mtime≤floor split is trusted for
        // this ONE job — deciding, in the seconds between arming and the
        // first tick, whether a file predates the arm — where being wrong
        // costs one fire, not a replay of the folder. `sig` re-seeds when
        // the folder or pattern changes: ids recorded against a different
        // watch say nothing about this one.
        const sig = `file|${t.folder}|${t.pattern || ''}`;
        let entry = (this.state.seen || {})[prompt.id];
        if (!entry || entry.sig !== sig || !entry.ids || typeof entry.ids !== 'object') {
            const floorMs = this._sinceMs(prompt);
            entry = { ids: {}, floorMs, sig };
            const stamp = Date.now();
            for (const f of files) {
                const ms = f.mtime ? (Date.parse(f.mtime) || 0) : 0;
                if (ms <= floorMs) entry.ids[key(f)] = stamp;
            }
            this._pruneSeen(entry);
            if (!opts.probe) {
                (this.state.seen = this.state.seen || {})[prompt.id] = entry;
                this.save();
            }
        }

        const fired = files
            .filter(f => !entry.ids[key(f)])
            .map(f => ({
                // R6: scoped to THIS file, same reasoning as the email side.
                suffix: `Triggered by a new file: ${t.folder}${sep}${f.name}. This run is about THIS one file only — do not scan the folder for others: each new file starts its own run, and earlier ones were already handled.`,
                identity: key(f),
                label: f.name
            }));
        return { fired, scanned: files.length };
    },

    _isDue(prompt, now) {
        const last = this.state.runs[prompt.id];
        if (!last) return true;
        const cfg = NotePrompts.config(prompt);
        const lastMs = new Date(last).getTime();
        // Daily/weekdays/weekly routines with a preferred run time anchor to
        // the wall clock ("every morning at 8") instead of drifting from the
        // last run. Due when the most recent HH:MM occurrence hasn't been run
        // yet — weekly additionally waits out most of its interval so the
        // 6-day guard tolerates the run landing at the anchor time, not
        // 7×24h later. 'weekdays' = daily minus Sat/Sun: its most recent
        // occurrence walks back over the weekend, so Friday's run keeps it
        // quiet until Monday.
        if (cfg.time && ['daily', 'weekdays', 'weekly'].includes(cfg.interval)) {
            const [h, m] = cfg.time.split(':').map(Number);
            const occ = new Date(now);
            occ.setHours(h, m, 0, 0);
            if (occ.getTime() > now) occ.setDate(occ.getDate() - 1);
            if (cfg.interval === 'weekdays') {
                while (occ.getDay() === 0 || occ.getDay() === 6) occ.setDate(occ.getDate() - 1);
            }
            if (lastMs >= occ.getTime()) return false;
            if (cfg.interval === 'weekly') return (now - lastMs) >= 6 * this.INTERVAL_MS.daily;
            return true;
        }
        // Interval-only 'weekdays' (no anchor time) still skips the weekend.
        if (cfg.interval === 'weekdays') {
            const day = new Date(now).getDay();
            if (day === 0 || day === 6) return false;
        }
        const span = this.INTERVAL_MS[cfg.interval] || this.INTERVAL_MS.daily;
        return (now - lastMs) >= span;
    },

    /**
     * Ownership (decided by Ram, 2026-08-03): when an armed TASK-MODE email
     * routine and the ambient insight sweep both watch the same mail, the
     * ROUTINE owns acting on it — a routine is something the user created
     * explicitly, with their own instruction for exactly this mail; the
     * sweep is ambient help. The sweep still reads it (the insight is
     * unchanged, and its "Add task" button — an explicit click — still
     * works); it just leaves the WRITING to the routine, so one invoice
     * stops becoming two tasks from two subsystems.
     *
     * Membership is ARITHMETIC, never a model verdict — the same law as
     * thread membership and strategy adherence. Deliberately:
     *  - runMode 'task' only. A digest cannot write, so suppressing the
     *    sweep for one would silently remove auto-tasks with no replacement.
     *  - `_runsHere` is IGNORED: a routine armed on another Mac still owns
     *    the mail (its task syncs over; this Mac's sweep writing too would
     *    recreate the very duplicate this exists to prevent).
     *  - Synchronous by contract (the sweep calls it inline), so `contains`
     *    checks subject/snippet/bodyText already in memory and never
     *    fetches. At sweep time the analysis has just read the message, so
     *    the body is normally present; a missed body-only match costs one
     *    duplicate task — the exposure the sweep always had — never a
     *    silently lost one.
     *
     * Returns the claiming routine's {id, title}, or null.
     */
    claimsEmail(email) {
        if (!email) return null;
        try {
            if (typeof NotePrompts === 'undefined') return null;
            for (const n of NotePrompts.list()) {
                const cfg = NotePrompts.config(n);
                if (!cfg.offline || cfg.runMode !== 'task') continue;
                const t = cfg.trigger;
                if (!t || t.type !== 'email') continue;
                if (!NotePrompts.bodyText(n).trim()) continue;
                const from = (t.from || '').toLowerCase();
                const subject = (t.subject || '').toLowerCase();
                const contains = (t.contains || '').toLowerCase();
                if (from && !String(email.from || '').toLowerCase().includes(from)) continue;
                if (subject && !String(email.subject || '').toLowerCase().includes(subject)) continue;
                if (contains) {
                    const hay = `${email.subject || ''}\n${email.snippet || ''}\n${email.bodyText || ''}`.toLowerCase();
                    if (!hay.includes(contains)) continue;
                }
                return { id: n.id, title: n.title || 'Untitled routine' };
            }
        } catch { /* unreadable rules claim nothing */ }
        return null;
    },

    /**
     * R4 — "Test trigger": what WOULD fire, right now, stamping nothing.
     *
     * The cheapest item in the whole plan and the one that would have caught
     * D0 in under a minute: "nothing matched" and "this has been broken since
     * the day you armed it" are indistinguishable without it (T6).
     */
    async testTrigger(prompt) {
        if (!prompt) return { error: 'routine not found' };
        const cfg = NotePrompts.config(prompt);
        const t = cfg.trigger || { type: 'time' };
        const out = { type: t.type, label: NotePrompts.triggerLabel(cfg), fired: false };
        try {
            const r = await this._firedFor(prompt, Date.now(), { probe: true });
            if (r.error) return { ...out, error: r.error };
            if (r.scanned != null) out.scanned = r.scanned;
            else if (t.type === 'email') out.scanned = (await this._mailbox()).length;
            if (r.fired.length) {
                const first = r.fired[0];
                out.fired = true;
                out.suffix = first.suffix;
                out.identity = first.identity;
                out.matches = r.fired.map(f => f.label || f.suffix).filter(Boolean);
            }
            if (!this._runsHere(cfg)) out.otherMachine = true;
            return out;
        } catch (e) {
            return { ...out, error: e?.message || 'the trigger could not be evaluated' };
        }
    },

    /* ---------- The run queue ---------- */

    queue() { return this.local.queue || (this.local.queue = []); },

    /**
     * Enqueue what fired. Deduped on (routineId, identity): a queued item has
     * not stamped `runs` yet, so without this the same thing is re-enqueued
     * on every 5-minute tick for as long as it waits for the task slot.
     */
    enqueue(routineId, fired, mode) {
        const identity = (fired && fired.identity) || 'once';
        const q = this.queue();
        if (q.some(x => x && x.routineId === routineId && x.identity === identity)) return false;
        q.push({
            routineId, identity, mode: mode === 'task' ? 'task' : 'digest',
            suffix: (fired && fired.suffix) || null,
            at: new Date().toISOString()
        });
        while (q.length > this.QUEUE_MAX) q.shift();
        this.saveLocal();
        return true;
    },

    _dequeue(item) {
        const q = this.queue();
        const i = q.indexOf(item);
        if (i !== -1) q.splice(i, 1);
        this.saveLocal();
    },

    /** Re-drain shortly — called when the task slot frees up. */
    drainSoon(ms = 500) {
        setTimeout(() => { this.drain().catch(() => {}); }, ms);
    },

    /**
     * Run what is queued, in arrival order.
     *
     * Task-mode runs go serially through TaskService's ONE slot; a task-mode
     * item that cannot start yet stays put and the drain keeps walking, so a
     * digest never waits behind it. Nothing is dropped — an item that could
     * not run this pass is picked up by the next tick, or by `drainSoon` when
     * the running task settles.
     */
    async drain() {
        if (this._draining) return;
        this._draining = true;
        this._busy = true;
        try {
            // Snapshot: entries are removed as they succeed, and a run can
            // enqueue more (a routine that writes a file the file trigger
            // watches), which must wait for the next pass rather than extend
            // this one forever.
            for (const item of [...this.queue()]) {
                if (!this.queue().includes(item)) continue;
                const prompt = (typeof NotePrompts !== 'undefined')
                    ? NotePrompts.list().find(n => n.id === item.routineId) : null;
                if (!prompt) { this._dequeue(item); continue; }   // deleted mid-queue
                if (item.mode === 'task' && this._taskSlotBusy()) continue;
                let out = null;
                try {
                    out = await PromptFeed.runRoutine(prompt, {
                        suffix: item.suffix, identity: item.identity,
                        attempts: item.attempts || 0
                    });
                } catch (e) {
                    console.warn('[routines] run failed:', e?.message);
                    this.noteError(item.routineId, e?.message || 'Run failed');
                }
                // A task-mode start that was deferred (the slot filled between
                // the check and the call) stays queued — the same call the
                // old scheduler made, now with somewhere to wait.
                if (out && out.deferred) continue;
                // A transiently failed digest (server unreachable, empty
                // completion) stays queued for the next tick rather than
                // posting an error card — PromptFeed.RETRY_MAX bounds it.
                // The identity is deliberately NOT stamped yet: the fire is
                // consumed when the run settles, not while it retries (T7).
                if (out && out.retry) {
                    item.attempts = (item.attempts || 0) + 1;
                    this.saveLocal();
                    continue;
                }
                // R1: the identity is stamped processed exactly when its item
                // leaves the queue — after the run started (or errored, which
                // consumes the fire the way a failed digest always has).
                // Stamping any earlier would let a lost queue silently
                // swallow the message; stamped here, losing the queue means
                // the thing fires again (T7: duplicate beats silence).
                if (/^(mail|file):/.test(item.identity || '')) {
                    this.stampSeen(item.routineId, item.identity);
                }
                this._dequeue(item);
            }
        } finally {
            this._draining = false;
            this._busy = false;
        }
    },

    _taskSlotBusy() {
        if (typeof TaskService === 'undefined' || typeof TaskService._all !== 'function') return false;
        return TaskService._all().some(t => t && ['planning', 'running', 'verifying'].includes(t.status));
    },

    /* ---------- Scheduler ---------- */

    startScheduler() {
        if (this._timer) clearInterval(this._timer);
        // Catch-up pass for runs missed while the app was closed. Deferred
        // past first paint so it doesn't contend with model prewarm or
        // block launch on a cold local-model load.
        setTimeout(() => this.tick(), 8000);
        this._timer = setInterval(() => this.tick(), this.POLL_MS);
    },

    // Called when a routine note is saved so a newly armed one starts
    // producing without waiting for the next poll. Debounced so a flurry of
    // edits triggers one pass.
    onRoutinesChanged() {
        if (this._nudgeTimer) clearTimeout(this._nudgeTimer);
        this._nudgeTimer = setTimeout(() => {
            this._ensureMailSync();
            this.tick();
        }, 1500);
    },

    /**
     * R3 — event-driven delivery. EmailApp pushes the delta here the moment
     * a sync persists new mail, so an email trigger's latency is the Gmail
     * poll alone instead of Gmail poll + up-to-5-minutes of scheduler poll.
     *
     * One evaluation path, on purpose: this nudges the same `tick()` the
     * scheduler runs rather than matching the delta itself — a second
     * matcher is a second thing to drift, and R1's identity stamps already
     * make the tick a cheap set-difference over the newest-window (T5's
     * O(mailbox) rescan is gone). The delta payload gates the nudge: no new
     * mail, or no armed email routine on this Mac, costs nothing. The
     * 5-minute poll stays as reconciliation — deleting it would trade one
     * silent-failure mode for another.
     */
    onNewMail(newEmails) {
        if (!Array.isArray(newEmails) || !newEmails.length) return;
        let wantsMail = false;
        try {
            wantsMail = this.armedRoutines().some(n =>
                (NotePrompts.config(n).trigger || {}).type === 'email');
        } catch { wantsMail = false; }
        if (!wantsMail) return;
        // Debounced past the sync loop: one History batch (several accounts,
        // several messages) is one evaluation pass.
        if (this._mailNudgeTimer) clearTimeout(this._mailNudgeTimer);
        this._mailNudgeTimer = setTimeout(() => this.tick(), 1000);
    },

    async tick() {
        if (this._draining) return;
        // No model selected yet (fresh install, model removed): skip quietly
        // instead of posting an error card per routine. Nothing is stamped,
        // so the first pass after a model is chosen catches everything up.
        if (typeof AgentService === 'undefined' || !AgentService.model) return;
        const routines = this.armedRoutines();
        if (!routines.length) return this.drain();

        const now = Date.now();
        for (const p of routines) {
            // R4/T6: stamped whether or not anything matched, which is the
            // whole point — it is what tells "nothing matched" apart from
            // "this has not been evaluated since you armed it".
            this.noteChecked(p.id);
            let r = null;
            try { r = await this._firedFor(p, now); }
            catch (e) { this.noteError(p.id, e?.message || 'trigger check failed'); continue; }
            if (!r || !r.fired.length) continue;
            this.noteMatched(p.id);
            // R1/T2: EVERY unprocessed thing fires, each as its own queue
            // item — two invoices in one poll window are two runs, and a
            // tick is an implementation detail the output never shows.
            const mode = NotePrompts.config(p).runMode;
            for (const f of r.fired) this.enqueue(p.id, f, mode);
        }
        await this.drain();
    }
};

if (typeof window !== 'undefined') window.RoutineEngine = RoutineEngine;
