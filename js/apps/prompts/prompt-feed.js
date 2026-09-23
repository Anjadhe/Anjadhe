/**
 * Prompt Feed
 *
 * RUNS a fired routine (prompt-template notes marked "Run offline on a
 * schedule") against the LOCAL model, and surfaces the generated output as
 * a feed on the Home page (the "Feed" tab). Deciding WHEN one fires lives
 * in RoutineEngine — see the R5 section below.
 *
 * Prompts live as notes (`template === 'prompt'`) in the `notes` blob and
 * are read through the shared NotePrompts helper — `promptId` here is the
 * note's id. (This module predates the merge and kept its name + storage.)
 *
 * Storage: run OUTPUTS are notes (`template === 'feed'`) in the shared
 * `notes` blob — one note per run, with the generated markdown converted to
 * sanitized note HTML once at save time and run metadata on
 * `note.feed = { promptId, model, error }`. The feed, the Routines page's
 * per-prompt "Feed posts" list, and the Notes app all render the exact same
 * stored content (posts stay out of the Notes lists unless pinned).
 *
 * Both the prompt notes and the feed notes sync across the user's Macs
 * automatically via the StorageManager journal, and so does the scheduler's
 * `runs` map (now owned by RoutineEngine, same `promptFeed` key): it
 * dedupes scheduled runs across devices so the same prompt isn't
 * independently re-run on every machine within one interval.
 *
 * ── C10 (2026-08-03): this is the ONE background runner. ──────────────────
 * Automations (C8.5) merged in here: what was a second 60s ticker over a
 * second store, arming triggered TASK runs, is now three more fields on a
 * routine (see NotePrompts.config — `trigger`, `runMode`, `homeMachineId`).
 * The two features answered the same user sentence — "do this for me on
 * your own" — and the split was an artifact of build order.
 *
 *   - A routine starts on a TIME schedule, a matching new EMAIL, or a new
 *     FILE in a folder. Time keeps using the flat interval/time fields, so
 *     nothing written before C10 needed migrating.
 *   - `runMode: 'task'` runs it through TaskService unattended (it may
 *     write, each step still gated); 'digest' is the original read-only
 *     turn. BOTH report to the feed — one surface answers "what did my
 *     assistant do?".
 *
 * ── R5 (2026-08-03): the trigger engine moved out. ────────────────────────
 * Deciding WHEN a routine runs, what fired it, and what is queued now lives
 * in **`js/agent/routine-engine.js`** (`RoutineEngine`), bootstrapped from
 * `AppManager.init` — see docs/ROUTINE_TRIGGERS.md R5 and defect D5: a
 * trigger's liveness must not depend on a UI surface, and it depended on
 * this one. Scheduler state (`runs`, `errors`) lives there too.
 *
 * What is left here is the feed's own job: RUNNING a fired routine
 * (`runRoutine` is the seam the engine calls), generating its content, and
 * rendering the stream.
 */

const PromptFeed = {
    _busy: false,
    // Manual runs requested while another run (or a scheduled pass) is in
    // progress wait here instead of being dropped; drained when it ends.
    _queue: [],
    _overlay: null,
    _published: null,   // posts published by nenva (remote-config feedPosts)

    // Editions kept per series. A daily prompt keeps about a fortnight;
    // pinned posts are exempt (see _prune), which is the escape hatch for
    // an edition worth keeping forever. Pruning runs when a series posts,
    // so an over-long history shortens on its next run rather than all at
    // once.
    MAX_PER_PROMPT: 10,

    // Tick-spaced retries for an unattended run that failed TRANSIENTLY
    // (server rebooting, stream cut, empty completion) before an error card
    // is posted to the feed. The retry rides the engine's queue — the item
    // stays queued and the next 5-minute tick re-runs it — because the
    // observed failures (ECONNREFUSED against a just-woken server) outlive
    // any immediate retry. Manual "Run now" never waits: a present user
    // should see the failure now.
    RETRY_MAX: 2,

    // Tool ROUNDS a web-grounded digest may spend researching before the
    // loop hands over to its tools-free synthesis pass (_webSynthesis).
    // Rounds, not model calls: the last round is never the one that has to
    // write the answer, so a routine can spend its whole budget searching
    // and still post an answer. Four (with the fourth silently tool-less)
    // was the entire budget until 2026-09-18, when a three-rule market
    // watch spent it on research and posted "Let me verify the 52-week
    // high…" as its edition. The run's clock (RUN_BUDGET_MS) is the real
    // guard; this only bounds a model that would search happily forever.
    WEB_TOOL_ROUNDS: 8,

    // Wall clock for one digest run, the same figure task mode gives a run
    // (TaskService.MAX_WALL_CLOCK_MS). Past it the assistant loop stops
    // calling tools and writes up what it has; a call still running 10
    // minutes after that is aborted (AgentService.runHeadless). Before this
    // a digest had only call-count caps and ran 100+ minutes on a slow
    // remote brain with nothing able to stop it but quitting the app
    // (2026-09-04).
    RUN_BUDGET_MS: 30 * 60 * 1000,

    // The run in flight: { promptId, title, startedAt, convId, cancelled }.
    // Read by the Routines page ("Running now · Stop"), the reload guard
    // (BackgroundWork names the routine) and AIActivity.stop; null when idle.
    _current: null,

    // The card is visibility, not the settlement (2026-08-19): after it
    // posts, the item KEEPS riding the queue on the engine's backoff ladder
    // (15m → 30m → hourly) until the brain answers or this many total
    // attempts are spent — a batch of "This run didn't finish" cards from
    // one server outage used to consume every fire until the next scheduled
    // day. 10 attempts ≈ 6 hours of cover; a longer outage falls back to
    // the next scheduled time, which is what the card promises.
    REDO_MAX: 10,

    /* ── Silence (docs/ROUTINES_UX.md U3) ────────────────────────────────
       A run may say nothing, and saying nothing posts nothing. Every
       digest's system prompt carries `quietClause()`; an answer that is
       nothing but the token settles the run as QUIET — `runs` and `seen`
       stamp exactly as they do for a posted edition, no feed note is
       written, and the routine's detail says "ran, nothing to report".
       Silence is a SUCCESSFUL run, never an error and never a gap.

       This is the widget contract ("a widget with nothing to say does not
       render at all") and Noticing's N7 applied to the one surface that
       broke both: a morning where nothing changed used to read exactly
       like a morning where something did, unread dot and all, which is
       how a feed teaches its reader to stop looking.

       ONE author of the sentence, on purpose — the clause reaches the
       assistant path through `source.quietClause` rather than being
       written a second time in agent-service.js, because two copies of a
       token contract drift and the drift is silent (the model answers
       with a token nothing parses). ────────────────────────────────────── */
    QUIET_TOKEN: 'NOTHING_NEW',

    // The schedule vocabulary a chat-born routine may be suggested with
    // (docs/ROUTINES_UX.md P3) — the same set the form offers.
    QUIET_INTERVALS: ['daily', 'weekdays', 'weekly', 'hourly', '6h'],

    // A reason may ride along on the SAME line ("NOTHING_NEW — no new
    // invoices since Tuesday"): it is worth recording and worth showing on
    // the detail. Anything longer, or anything with a line break in it, is
    // an answer that merely MENTIONS the token and must post as normal —
    // the strictness is the whole safety of this feature.
    QUIET_REASON_MAX: 200,

    // The clause has to OVERRIDE, not merely add. Both long system prompts
    // this is appended to already tell the model to write a complete post
    // and to "say so briefly" when data is missing — so the first live run
    // of a watch routine over a mailbox with no match wrote a tidy summary
    // of everything it had searched and found nothing in, which is the post
    // U3 exists to delete. The override sentence and the watch-routine
    // example are both load-bearing; verified against the cloud brain
    // before and after (docs/ROUTINES_UX.md P1).
    quietClause() {
        return ` SILENCE IS AN ALLOWED OUTCOME, and it overrides any instruction above to write a complete answer or to report what you could not find: if there is genuinely nothing new or nothing worth telling the user this run, begin your reply with exactly ${this.QUIET_TOKEN} and write nothing else (optionally a short reason on the same line, after the token). Nothing is posted for such a run, which is the right outcome for a quiet day. A routine that watches for something and finds no match replies ${this.QUIET_TOKEN} — never a summary of where you looked. But never use it to avoid a question you can answer, and never use it when you have anything the user actually asked for.`;
    },

    /* ── Silence as a VERB, not as suppressed prose ──────────────────────
       The clause alone is not enough on the CONTEXT path. Measured against
       the cloud brain three times: a watch routine over a mailbox with no
       match wrote "Reviewed the full inbox — nothing from a landlord…",
       sometimes with the token buried mid-answer. The surrounding system
       block is entirely about producing a post, and a model asked to write
       nothing will still write something; a model given a TOOL for "there
       is nothing to report" calls it, because calling a tool is the thing
       it is good at.

       So `report_nothing` exists for exactly those runs: registered into a
       group no chat vocabulary can reach, offered only to a run that
       carries the clause (AgentService: `conv.quietAllowed`), read-only,
       and its whole effect is to set `_quietSignal`. Whatever prose the
       model writes afterwards is discarded — it already said the one thing
       that mattered. Downstream nothing changes: the signal becomes the
       token, and `readQuiet` stays the single parser. ─────────────────── */
    _quietSignal: null,

    QUIET_TOOL: {
        type: 'function',
        function: {
            name: 'report_nothing',
            description: 'Call this INSTEAD of writing an answer when this run found nothing worth telling the user — no new matches, no change, a quiet day. The run is recorded and nothing is posted. Do not also write a summary of where you looked: calling this IS the answer.',
            parameters: {
                type: 'object',
                properties: {
                    reason: {
                        type: 'string',
                        description: 'Optional, one short line: why there was nothing (e.g. "no new invoices since Tuesday"). Shown on the routine\'s own page, never posted.'
                    }
                },
                required: []
            }
        }
    },

    registerQuietTool() {
        if (typeof AgentTools === 'undefined' || typeof AgentTools.register !== 'function') return;
        if (AgentTools.handlers && AgentTools.handlers.report_nothing) return;
        AgentTools.register(this.QUIET_TOOL, async (args) => {
            this._quietSignal = { reason: String((args && args.reason) || '').slice(0, this.QUIET_REASON_MAX) };
            return { ok: true, recorded: true, note: 'Recorded: nothing to report. Stop now — do not write an answer.' };
        }, {
            source: 'routines',
            // A group no `_domainsForMessage` can yield, so this never ships
            // in chat; AgentService hands it to a quiet-capable run directly.
            group: 'routine-quiet',
            readOnly: true,
            blockUntrusted: false
        });
    },

    /* ── The headline (docs/ROUTINES_UX.md U4) ───────────────────────────
       Every digest opens with ONE short line saying the single thing this
       run found. It is what the series summary shows in place, and it is
       what the day's line above the feed is a JOIN of — which is why the
       brief needs no model call of its own and can never author a sentence
       about other sentences.

       Without it the brief was a join of first PARAGRAPHS: four clauses of
       forty words each, every one repeating verbatim the card six pixels
       below it. A summary that restates what it sits on top of is the
       duplication this app keeps removing. ──────────────────────────────── */
    headlineClause() {
        return ' Your answer BEGINS with one short line — under ten words — stating the single most important thing this run found, as a statement a person could read on its own ("Two model releases and a bond auction", "Nothing moved in the portfolio"). No heading marks, no label, never the routine\'s own name, never a question, and never a preamble before it: no "Let me…", no describing what you are about to write, no thinking out loud. Then leave a blank line and write the rest.';
    },

    /**
     * Is this answer silence? Returns null for a normal answer, or
     * `{ reason }` (possibly empty) when the whole answer is the token.
     *
     * The token may come FIRST ("NOTHING_NEW — no new invoices") or LAST
     * ("Nothing from the landlord about a rent increase. NOTHING_NEW"),
     * because a live brain writes it both ways and which one it picks is
     * not something a prompt reliably decides. What keeps the trailing
     * form safe is LENGTH: silence is a short answer that is nothing but
     * the token and at most a one-line reason. A real digest ending in the
     * literal token is a digest that is over QUIET_REASON_MAX characters
     * long, and it posts.
     *
     * Pure — pinned by tests/routine-quiet-test.js.
     */
    readQuiet(content) {
        let t = String(content == null ? '' : content).trim();
        if (!t) return null;
        // Strip what a small model wraps a bare token in: code fences,
        // backticks, bold/italic markers, quotes. Not a markdown parser —
        // just the shapes seen in practice.
        t = t.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim();
        t = t.replace(/^[>\s]*/, '').trim();
        t = t.replace(/^[*_`"'\u201c\u2018]+/, '').replace(/[*_`"'\u201d\u2019]+$/, '').trim();
        const m = t.match(new RegExp('^' + this.QUIET_TOKEN + '\\b', 'i'));
        if (!m) {
            // The token last, with the reason written before it. Allowed
            // only while the whole answer stays inside a reason's length —
            // that cap is the entire safety of this branch.
            const tail = t.match(new RegExp('(^|[\\s.:,\\u2014\\u2013-])' + this.QUIET_TOKEN + '[\\s.!*_`"\'\\u201d\\u2019]*$', 'i'));
            if (!tail) return null;
            const before = t.slice(0, t.length - tail[0].length + (tail[1] ? tail[1].length : 0));
            if (/[\r\n]/.test(before) || before.length > this.QUIET_REASON_MAX) return null;
            return { reason: before.replace(/[\s.:,*_`"'\u2014\u2013-]+$/, '').trim() };
        }
        let rest = t.slice(m[0].length);
        // A line break after the token means prose follows: not silence.
        if (/[\r\n]/.test(rest)) return null;
        // The closing half of an emphasis pair ("**NOTHING_NEW** — …") sits
        // between the token and the reason, so it is stripped here too.
        rest = rest.replace(/^[*_`\s:.,\u2014\u2013-]+/, '').replace(/[*_`"'\u201d\u2019.\s]+$/, '').trim();
        if (rest.length > this.QUIET_REASON_MAX) return null;
        return { reason: rest };
    },

    init() {
        this.registerQuietTool();
        // The engine owns the scheduler and its state, and AppManager.init
        // starts it directly (D5). Calling it here too is belt and braces:
        // whichever of the two runs first, the engine is up and its state is
        // loaded before the migrations below touch it.
        if (typeof RoutineEngine !== 'undefined') RoutineEngine.init();
        this._migrateLegacyItems();
        // The migration stamps this Mac as the new routines' home, so it has
        // to wait for the machine id rather than race it.
        const ready = (typeof RoutineEngine !== 'undefined' && RoutineEngine._ready)
            || Promise.resolve();
        ready.then(() => this._migrateAutomations());
        this.render();
        // Posts we publish (release notes, tips) arrive via remote config;
        // repaint once they load so they join the stream.
        this._loadPublished().then(() => this.render());
        // Feed-header entry point routes to the Routines page (the standalone
        // home of prompt notes; creation lives on that page's + New Prompt).
        // The dashboard markup is static, so wiring once here is safe.
        document.getElementById('prompt-feed-config')
            ?.addEventListener('click', () => PromptsApp.open());
        this._setupLinkHandler();
    },

    // Delegated click handler for links inside feed content — cards and the
    // full-post overlay both render `.feed-card-body`. The HTML comes from
    // AgentUI.formatContent, whose anchors are target-less; without this,
    // a click tries to navigate the app's BrowserWindow, which main.js
    // blocks (will-navigate), so links silently do nothing. Links open in
    // the in-app Browse tab, iOS-style: a "‹ Back to Feed" strip returns
    // to the exact post that was being read (external browser only as a
    // fallback when Browse isn't available).
    _setupLinkHandler() {
        if (this._linkHandlerWired) return;
        this._linkHandlerWired = true;
        document.addEventListener('click', (e) => {
            const a = e.target && e.target.closest && e.target.closest('.feed-card-body a[href]');
            if (!a) return;
            const href = a.getAttribute('href');
            // Authored feed posts can open the existing feedback form.
            if (href === '#send-feedback') {
                e.preventDefault();
                e.stopPropagation();
                this.closePost();
                AppManager.showFeedback();
                return;
            }
            if (!href || !/^https?:/i.test(href)) return;
            e.preventDefault();
            // The default browser opens beside the app, so the post stays
            // open behind it — nothing to restore on the way back.
            AppManager.openExternal(href);
        });
    },

    /* ---------- Feed notes (run outputs) ----------
     *
     * Outputs live in the shared `notes` blob as 'feed'-template notes, read
     * and written through NotePrompts' blob helpers so the Notes app's
     * in-memory copy stays coherent.
     */

    _isFeedNote(n) {
        return !!n && (typeof NoteTemplates !== 'undefined'
            ? NoteTemplates.resolve(n) === 'feed'
            : n.template === 'feed');
    },

    _feedNotes() {
        if (typeof NotePrompts === 'undefined') return [];
        return NotePrompts._readNotes().filter(n => this._isFeedNote(n));
    },

    // Render model the feed cards/post view consume. `html` is the stored,
    // already-formatted note content — no per-render markdown pass.
    _cardModel(n) {
        return {
            id: n.id,
            promptId: (n.feed && n.feed.promptId) || null,
            promptTitle: n.title || 'Untitled prompt',
            html: n.content || '',
            error: (n.feed && n.feed.error) || null,
            model: (n.feed && n.feed.model) || null,
            read: !!(n.feed && n.feed.readAt),
            createdAt: n.createdAt
        };
    },

    // Opening a prompt post marks it read — the same lifecycle email
    // insights have. Stored on the feed note itself (synced with the notes
    // blob), so read status follows the user across Macs. modifiedAt is
    // deliberately untouched: reading isn't an edit and shouldn't reorder
    // the note in the Notes app.
    _markNoteRead(id) {
        if (typeof NotePrompts === 'undefined') return;
        const notes = NotePrompts._readNotes();
        const n = notes.find(x => x.id === id);
        if (!n || !this._isFeedNote(n) || (n.feed && n.feed.readAt)) return;
        n.feed = { ...(n.feed || {}), readAt: new Date().toISOString() };
        NotePrompts._writeNotes(notes);
        this.render();
    },

    _item(id) {
        if (String(id).startsWith('pub-')) {
            return this._publishedModels().find(x => x.id === id) || null;
        }
        const n = this._feedNotes().find(x => x.id === id);
        return n ? this._cardModel(n) : null;
    },

    // If the user is looking at the Notes app while a scheduled run posts,
    // repaint it so the new feed note shows up without a manual refresh.
    _refreshNotesApp() {
        if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'notes'
            && typeof NotesApp !== 'undefined' && NotesApp.render) {
            NotesApp.render();
        }
    },

    // One-time migration: fold pre-notes feed posts (`promptFeed.items`)
    // into feed notes so existing history keeps rendering. Item ids are
    // reused as note ids, so a re-run (or a second Mac migrating the same
    // synced items concurrently) cannot duplicate posts.
    _migrateLegacyItems() {
        const state = (typeof RoutineEngine !== 'undefined') ? RoutineEngine.state : null;
        if (!state || !state.items.length || typeof NotePrompts === 'undefined') return;
        const notes = NotePrompts._readNotes();
        const existing = new Set(notes.map(n => n.id));
        // items is newest-first; prepending preserves that order.
        const migrated = state.items
            .filter(it => it && it.id && !existing.has(it.id))
            .map(it => ({
                id: it.id,
                title: it.promptTitle || 'Untitled prompt',
                content: it.error ? '' : this._format(it.content),
                tags: [],
                template: 'feed',
                feed: {
                    promptId: it.promptId || null,
                    model: it.model || null,
                    error: it.error || null
                },
                pinned: false,
                createdAt: it.createdAt || new Date().toISOString(),
                modifiedAt: it.createdAt || new Date().toISOString()
            }));
        if (migrated.length) NotePrompts._writeNotes([...migrated, ...notes]);
        state.items = [];
        RoutineEngine.save();
    },

    /**
     * C10 one-shot: fold armed Automations (C8.5's `agent-automations`) into
     * routine notes. Each becomes a `runMode:'task'` routine carrying its own
     * trigger, homed to THIS Mac — which is where it already ran, since the
     * old store was machine-local and never synced.
     *
     * Idempotent by clearing the source key: nothing else writes it after
     * this release, and it never synced, so there is no second copy to
     * resurrect from another Mac.
     *
     * A DISABLED automation becomes an unarmed prompt note (a "saved prompt"
     * in Notes) rather than an armed routine. Migrating it armed would start
     * running something the user had switched off; that is the one outcome
     * worth a small loss of discoverability, and re-arming is a schedule
     * away.
     */
    async _migrateAutomations() {
        if (typeof StorageManager === 'undefined' || typeof NotePrompts === 'undefined') return;
        const list = StorageManager.get('agent-automations');
        if (!Array.isArray(list) || !list.length) return;

        let migrated = 0;
        for (const a of list) {
            if (!a || !a.goal) continue;
            const trig = (a.trigger && typeof a.trigger === 'object') ? a.trigger : { type: 'time', interval: 'daily' };
            // The goal was one blob of text; a routine has a title and a
            // body. Take the first line/sentence as the title and keep the
            // whole goal as the body — truncating what the task runs would
            // change what it does.
            const firstLine = String(a.goal).split('\n')[0].trim();
            const title = (firstLine.length > 70 ? firstLine.slice(0, 67).trimEnd() + '…' : firstLine) || 'Automation';
            const note = NotePrompts.create({
                title,
                body: String(a.goal),
                config: {
                    offline: !!a.enabled,
                    runMode: 'task',
                    trigger: trig,
                    // Flat time fields stay the source of truth for a time
                    // trigger (config._trigger reads them back).
                    interval: trig.type === 'time' ? (trig.interval || 'daily') : 'daily',
                    time: trig.type === 'time' ? (trig.time || null) : null,
                    homeMachineId: RoutineEngine._machineId || null
                }
            });
            // Carry the last-run stamp so a daily automation migrated at
            // 09:00 doesn't immediately fire again for today's slot.
            if (note && a.lastRunAt) RoutineEngine.state.runs[note.id] = a.lastRunAt;
            if (note && a.lastError) RoutineEngine.noteError(note.id, a.lastError);
            migrated++;
        }
        RoutineEngine.save();
        StorageManager.set('agent-automations', []);
        if (migrated) console.log(`[routines] migrated ${migrated} automation(s) into routines (C10)`);
    },

    // Manual trigger from a prompt card's "Run now" button. Bypasses the
    // due check. Only one generation runs at a time (one local model, one
    // server) — a click landing mid-run is queued and runs right after,
    // rather than being dropped. Stamping the run time also shifts the
    // next scheduled run, which is the expected behaviour.
    async runNow(promptId) {
        const p = (typeof NotePrompts !== 'undefined')
            ? NotePrompts.list().find(x => x.id === promptId)
            : null;
        if (!p || !NotePrompts.bodyText(p).trim()) {
            UIUtils.showToast('Nothing to run', 'error');
            return;
        }
        if (this._busy) {
            if (this._queue.includes(promptId)) {
                UIUtils.showToast(`"${p.title || 'Prompt'}" is already queued`, 'info');
            } else {
                this._queue.push(promptId);
                UIUtils.showToast(`Queued "${p.title || 'prompt'}" — runs after the current one`, 'info');
            }
            return;
        }
        this._busy = true;
        const isTask = NotePrompts.config(p).runMode === 'task';
        UIUtils.showToast(isTask
            ? `Starting "${p.title || 'routine'}"…`
            : `Running "${p.title || 'prompt'}" offline…`, 'info');
        try {
            const note = await this._runPrompt(p);
            // A task-mode routine only STARTS here — it reports to the feed
            // when it settles, which can be minutes later.
            if (note && note.task) {
                if (note.error) UIUtils.showToast(note.error, 'error');
                else if (note.deferred) UIUtils.showToast('Another task is running — this one starts after it', 'info');
                else UIUtils.showToast('Task started — it will post to your feed when done', 'success');
            }
            else if (note && note.quiet) UIUtils.showToast(note.reason
                ? `Nothing to report — ${note.reason}`
                : 'Nothing to report — nothing was posted', 'info');
            else if (note && note.stopped) UIUtils.showToast(note.error || 'Stopped', 'info');
            else if (note && note.feed && !note.feed.error) UIUtils.showToast('Added to Feed', 'success');
            else UIUtils.showToast(note?.feed?.error || note?.error || 'Run failed', 'error');
        } catch (e) {
            UIUtils.showToast(e?.message || 'Run failed', 'error');
        } finally {
            this._busy = false;
            this._drainQueue();
        }
    },

    // Run the next queued manual request, if any. Each runNow drains again
    // on completion, so a burst of clicks works through in click order.
    _drainQueue() {
        if (this._busy || !this._queue.length) return;
        this.runNow(this._queue.shift());
    },

    /* The old "Manage prompts" modal (list + form) moved to the standalone
     * Routines page — see js/apps/prompts/prompts-app.js. runNow/openPost are
     * what that page calls back into; the scheduler moved to RoutineEngine. */

    /**
     * R5 seam: RoutineEngine decided this routine should run and hands it
     * over. Everything about HOW it runs — the digest generation, the task
     * hand-off, where the result is posted — stays here, because that is the
     * feed's job. `context` is what fired it ({suffix, identity}).
     */
    async runRoutine(prompt, context = null) {
        this._busy = true;
        try { return await this._runPrompt(prompt, context); }
        finally { this._busy = false; }
    },

    /**
     * Stop the digest run in flight (the Routines page's Stop, AI Activity's
     * Stop). `convId`, when given, must match the run's headless conversation
     * — AIActivity.stop passes the row's own. The run settles as "Stopped by
     * you" on the routine (no error card on the feed) and its fire is
     * consumed like any settled run. Returns false when nothing is running.
     */
    stopCurrent(convId = null) {
        const cur = this._current;
        if (!cur) return false;
        if (convId && cur.convId && cur.convId !== convId) return false;
        cur.cancelled = true;
        if (cur.convId && typeof AgentService !== 'undefined') {
            try { AgentService.abortConversation(cur.convId); } catch { /* already ended */ }
        }
        return true;
    },

    /**
     * What actually fired, folded into the prompt the model sees. Returns a
     * shallow clone rather than changing three generate() signatures — the
     * stored note is never touched.
     */
    _withContext(prompt, context) {
        const esc = (s) => String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        // What the routine is ABOUT rides into every run (RoutineAbout):
        // a routine about a ticker gets that ticker's own context block —
        // the same one a chat attached to it would get — without the prompt
        // naming it and without `useContext` dragging in the whole
        // briefing. Blocks come from the record's ONE builder, so this adds
        // no second description of any record.
        let about = '';
        if (typeof RoutineAbout !== 'undefined') {
            try { about = RoutineAbout.contextText(NotePrompts.config(prompt).about); }
            catch { about = ''; }
        }
        const suffix = context && context.suffix;
        if (!suffix && !about) return prompt;
        return {
            ...prompt,
            content: `${prompt.content || ''}`
                + (about ? `<p>${esc(about)}</p>` : '')
                + (suffix ? `<p>${esc(suffix)}</p>` : '')
        };
    },

    /**
     * C10 `runMode: 'task'` — hand the routine to the task engine as an
     * unattended run. Everything that made C8.5 safe still applies: the
     * arming was the consent, each step goes through its own permission
     * gate, and an `ask` with nobody present PAUSES and notifies instead of
     * opening a dialog nobody can click.
     *
     * Nothing lands on the feed for this run (2026-08-03, reversing C10's
     * "both post there"): an action run's report is an execution LOG, not
     * content. TaskService._report stores it on the task record when the
     * run settles, and the routine detail's Run history is where it is
     * read; failures surface as the routine's "Last problem" line.
     */
    async _runAsTask(prompt, context) {
        if (typeof TaskService === 'undefined' || typeof TaskService.start !== 'function') {
            RoutineEngine.noteError(prompt.id, 'Task mode is off in this build — this routine cannot run.');
            return { task: true, error: 'Task mode unavailable' };
        }
        const base = NotePrompts.bodyText(prompt);
        // A task-mode run gets the records it is about too — same builder,
        // same one description per record as the digest path.
        let about = '';
        if (typeof RoutineAbout !== 'undefined') {
            try { about = RoutineAbout.contextText(NotePrompts.config(prompt).about); }
            catch { about = ''; }
        }
        const goal = [base, about, context && context.suffix]
            .filter(Boolean).join('\n\n');
        // An email- or file-triggered run is started BY attacker-supplied
        // content and will go on to read more of it (the message body, its
        // attachments, the dropped file). Mark it so every step runs without
        // the irreversible tool classes — the prompt-injection backstop chat
        // has had all along, which keyed on the foreground app and so never
        // covered a headless run.
        const trig = (NotePrompts.config(prompt).trigger || {}).type;
        const res = await TaskService.start(goal, null, {
            unattended: true,
            routineId: prompt.id,
            untrustedInput: trig === 'email' || trig === 'file'
        });

        if (res && res.error) {
            // One task at a time. Leaving this UNSTAMPED is the point: the
            // trigger retries on the next tick instead of silently losing a
            // run (same call AutomationService made).
            if (/already running/i.test(res.error)) return { task: true, deferred: true };
            RoutineEngine.noteError(prompt.id, res.error);
            RoutineEngine.stampRun(prompt.id);
            return { task: true, error: res.error };
        }

        RoutineEngine.clearError(prompt.id);
        RoutineEngine.stampRun(prompt.id);
        return { task: true, taskId: res && res.taskId };
    },

    async _runPrompt(prompt, context = null) {
        const cfg0 = NotePrompts.config(prompt);
        if (cfg0.runMode === 'task') return await this._runAsTask(prompt, context);
        this._current = { promptId: prompt.id, title: prompt.title || 'Untitled routine', startedAt: Date.now(), convId: null, cancelled: false };
        try { return await this._runDigest(prompt, context); }
        finally { this._current = null; }
    },

    async _runDigest(prompt, context = null) {

        // Stamp the run time up front so a failing or slow prompt waits a
        // full interval before retrying instead of spinning every poll.
        RoutineEngine.clearError(prompt.id);
        RoutineEngine.stampRun(prompt.id);

        let content = '';
        let error = null;
        let model = (typeof AgentService !== 'undefined' && AgentService.model) || null;
        try {
            if (typeof LLMLogger === 'undefined' || !window.electronLLM) {
                throw new Error('Local model unavailable');
            }
            const cfg = NotePrompts.config(prompt);
            // What fired the run (the email's subject, the new file's name)
            // rides along with the prompt so the answer can refer to it.
            const pctx = this._withContext(prompt, context);
            const generate = () => cfg.useContext
                ? this._generateWithAssistant(pctx, model)
                : cfg.web
                    ? this._generateWithWeb(pctx, model)
                    : this._generatePlain(pctx, model);
            let out = await generate();
            // An empty response with no error is almost always transient (a
            // thinking model burning its token cap, a truncated stream) —
            // retry once before posting an error card to the feed. An answer
            // that is a research PLAN counts as no answer here (the web path
            // asks for the post itself before giving up; this is the net
            // under the assistant and plain paths too), because posting one
            // is how a feed teaches its reader to stop opening it.
            if (!out.error && (!String(out.content || '').trim() || this._looksUnfinished(out.content))) {
                out = await generate();
            }
            content = out.content;
            error = out.error;
            if (out.model) model = out.model;
            if (!error && !content) error = 'Model returned an empty response';
            if (!error && this._looksUnfinished(content)) { error = this.UNFINISHED_ERROR; content = ''; }
            // Stopped by the user: not a failure of the run, so no error
            // card on the feed — the routine's "Last problem" line says
            // what happened, and the fire is consumed (a settled run).
            if (out.stoppedByUser) {
                RoutineEngine.noteError(prompt.id, error);
                return { error, stopped: true };
            }
        } catch (e) {
            error = e?.message || 'Run failed';
        }

        // U3: silence SETTLES the run. `runs` was stamped at the top of this
        // function and the identity is stamped by the drain (this returns a
        // settled, non-retry result) — the only difference from a posted
        // edition is that nothing is written to the feed. Deliberately after
        // the catch and before the transient ladder: an error is never
        // silence, and silence is never retried.
        const quiet = error ? null : this.readQuiet(content);
        if (quiet) {
            RoutineEngine.stampQuiet(prompt.id, quiet.reason);
            this.render();
            return { quiet: true, reason: quiet.reason };
        }

        // Engine-driven run + transient failure → hand the item back to the
        // queue instead of consuming the fire (T7: a fire is consumed when
        // the run SETTLES, and an outage is not a settlement). Two rungs:
        // tick-spaced quick retries first (RETRY_MAX, silent); when those
        // are spent the error card posts ONCE for visibility and the item
        // keeps riding the queue on the engine's backoff ladder — so a
        // brain outage DELAYS a digest instead of eating it until the next
        // scheduled day. A later success folds the card away on its own
        // (the series shows its newest edition). The routine's "Last
        // problem" line carries the story throughout; success clears it
        // (clearError above).
        if (error && this._isTransient(error) && context && context.attempts != null) {
            if (context.attempts < this.RETRY_MAX) {
                RoutineEngine.noteError(prompt.id, `${error} — retrying on the next check`);
                return { retry: true, error };
            }
            if (context.attempts < this.REDO_MAX) {
                if (!context.carded) {
                    this._postToFeed(prompt, { content, error, model });
                    this.render();
                }
                RoutineEngine.noteError(prompt.id, `${error} — retrying in the background`);
                return { retry: true, card: true, error };
            }
            // Ladder spent. The card posted when the ladder started — settle
            // the fire without posting a second one for the same run.
            if (context.carded) {
                RoutineEngine.noteError(prompt.id, error);
                return { error, exhausted: true };
            }
        }

        const note = this._postToFeed(prompt, { content, error, model });
        // A Project Review's post is also that project's newest update
        // (GoalInterview decides whether this routine is one).
        if (!error && typeof GoalInterview !== 'undefined' && GoalInterview.mirrorReviewPost) {
            try { GoalInterview.mirrorReviewPost(prompt, note); } catch (e) { console.warn('[feed] review mirror failed:', e); }
        }
        this.render();
        return note;
    },

    /* ── Try it before Arm it (docs/ROUTINES_UX.md U2) ───────────────────
       A preview is a REAL run of the prompt the user is looking at, with
       every side effect removed: it stamps no `runs`, consumes no fire,
       posts no edition, writes no error and touches no ledger. Same law as
       `RoutineEngine.testTrigger({probe:true})` — a rehearsal that changes
       state is not a rehearsal.

       The routine being previewed need not exist yet; the caller passes a
       prompt-note SHAPE (`{title, content, prompt: config}`), which is all
       the generators read.

       A task-mode preview is a DRY RUN — `TaskService.dryRun` plans with
       the real planner and executes nothing — because the honest preview
       of a run that ACTS cannot be the run itself. ───────────────────── */
    async preview(promptLike) {
        const cfg = NotePrompts.config(promptLike);
        const title = promptLike.title || 'Untitled routine';
        if (cfg.runMode === 'task') {
            if (typeof TaskService === 'undefined' || typeof TaskService.dryRun !== 'function') {
                return { kind: 'error', error: 'Task mode is off in this build, so there is nothing to try.' };
            }
            const plan = await TaskService.dryRun(NotePrompts.bodyText(promptLike));
            if (plan.error) return { kind: 'error', error: plan.error };
            return { kind: 'plan', steps: plan.steps };
        }

        if (typeof LLMLogger === 'undefined' || !window.electronLLM) {
            return { kind: 'error', error: 'No model is set up yet, so this cannot be tried.', noBrain: true };
        }
        // The Stop button and the reload guard both read `_current`; a
        // preview is a run in flight like any other, and must be stoppable.
        this._current = { promptId: promptLike.id || 'preview', title, startedAt: Date.now(), convId: null, cancelled: false, preview: true };
        try {
            const out = cfg.useContext
                ? await this._generateWithAssistant(promptLike, (typeof AgentService !== 'undefined' && AgentService.model) || null)
                : cfg.web
                    ? await this._generateWithWeb(promptLike, (typeof AgentService !== 'undefined' && AgentService.model) || null)
                    : await this._generatePlain(promptLike, (typeof AgentService !== 'undefined' && AgentService.model) || null);
            if (out.error) return { kind: 'error', error: out.error, stopped: !!out.stoppedByUser, noBrain: /unavailable|not running|no server|no model/i.test(out.error) };
            const content = String(out.content || '').trim();
            if (!content) return { kind: 'error', error: 'The model returned an empty answer. Try again.' };
            // U3: a preview that would post nothing says so — which is the
            // single most useful thing a preview of a watch routine can
            // report, and it cannot be learned any other way.
            const q = this.readQuiet(content);
            if (q) return { kind: 'quiet', reason: q.reason, model: out.model };
            return { kind: 'text', content, model: out.model };
        } catch (e) {
            return { kind: 'error', error: e?.message || 'The run failed' };
        } finally {
            this._current = null;
        }
    },

    /**
     * The repair loop (U2): the user says what should be different about
     * the OUTPUT, and the model rewrites the INSTRUCTION. Returns the new
     * prompt text only — the caller shows it, and `Undo` restores the old
     * one (U11: an edit to a routine is a diff the user sees).
     *
     * Deliberately not a tool call and not a conversation: one turn, one
     * string back, no memory. A rewrite that quietly dropped what the user
     * originally asked for would be worse than no rewrite, so the system
     * prompt's first rule is to keep the intent.
     */
    async repairPrompt({ body, output, note, title }) {
        const said = String(note || '').trim();
        if (!said) return { error: 'Say what should be different' };
        if (typeof LLMLogger === 'undefined' || !window.electronLLM) return { error: 'No model is set up yet' };
        const res = await LLMLogger.call('routine-repair', {
            model: (typeof AgentService !== 'undefined' && AgentService.model) || null,
            activitySubject: title || 'Routine prompt',
            messages: [
                { role: 'system', content:
                    'You rewrite the INSTRUCTION for a recurring routine that an assistant runs unattended. ' +
                    'The user has just read one run\'s output and said what should be different about it. ' +
                    'Rules, in order: (1) keep everything the original instruction asked for unless the user\'s note clearly drops it; ' +
                    '(2) apply the note as a durable rule for EVERY future run, not as a one-off edit of the output you were shown; ' +
                    '(3) stay an instruction addressed to the assistant — never write the output itself; ' +
                    '(4) keep it short and concrete. ' +
                    'Reply with the rewritten instruction and NOTHING else: no preamble, no quotes, no markdown fences, no explanation.' },
                { role: 'user', content:
                    `CURRENT INSTRUCTION:\n${String(body || '').trim()}\n\n` +
                    `WHAT ONE RUN PRODUCED:\n${String(output || '').replace(/\s+/g, ' ').slice(0, 2000)}\n\n` +
                    `WHAT SHOULD BE DIFFERENT:\n${said}` }
            ],
            options: { temperature: 0.3 }
        });
        if (res?.error) return { error: String(res.error) };
        const text = this._cleanRewrite(res?.message?.content);
        if (!text) return { error: 'The model returned nothing to use' };
        return { body: text };
    },

    /**
     * "Repeat this…" (U1 door 1): turn a one-off question the user asked in
     * chat — and the answer they liked — into a STANDING instruction.
     *
     * The answer is in the prompt because the question alone underspecifies
     * what made it good: "how did my day go" answered with a task-by-task
     * walk-through should become a routine that walks through tasks, not one
     * that free-associates about the day.
     */
    async standingInstruction({ question, answer }) {
        if (typeof LLMLogger === 'undefined' || !window.electronLLM) return { error: 'No model is set up yet' };
        const res = await LLMLogger.call('routine-from-chat', {
            model: (typeof AgentService !== 'undefined' && AgentService.model) || null,
            activitySubject: 'Repeat this',
            messages: [
                { role: 'system', content:
                    'The user liked an answer their assistant gave and wants it to happen again on a schedule. ' +
                    'Rewrite their one-off question as a STANDING INSTRUCTION for an unattended recurring run. ' +
                    'Rules: keep what they actually asked for; make it work on any future day (never refer to "today\'s" answer, ' +
                    'this conversation, a previous run, or "the format you used before" — a future run has none of them, so DESCRIBE the format in words instead of pointing at it); match the SHAPE of the answer they liked ' +
                    '(if it walked through their tasks, say to walk through their tasks); address the assistant, not the user; ' +
                    'one or two sentences, concrete. ' +
                    // A chat answer ends by offering to help — that is what
                    // chat answers do — and the first live rewrite carried
                    // "end by asking which overdue item to tackle first"
                    // into a STANDING instruction for a run nobody attends.
                    'The answer you were shown may end with a follow-up question or an offer to do more: never carry that into the instruction. ' +
                    'The run is unattended and nobody can reply, so the instruction must never ask the user anything or offer to do something next. ' +
                    'Never state WHEN it runs ("at the end of each day", "every morning") \u2014 the schedule the user picks owns that, and the two would contradict each other. ' +
                    'Write ONLY the instruction itself: never restate these rules inside it ("without asking the user anything" is a rule, not part of the job). ' +
                    'Also give it a short name of two to four words. ' +
                    'If their question names a cadence ("this week", "every morning"), say which of daily/weekdays/weekly/hourly/6h it implies; otherwise use daily. ' +
                    'Reply with JSON only: {"title":"…","instruction":"…","every":"daily|weekdays|weekly|hourly|6h"}' },
                { role: 'user', content:
                    (question ? `THEY ASKED:\n${question.slice(0, 1000)}\n\n` : '') +
                    `THE ANSWER THEY LIKED:\n${String(answer || '').replace(/\s+/g, ' ').slice(0, 2500)}` }
            ],
            options: { temperature: 0.3 }
        });
        if (res?.error) return { error: String(res.error) };
        const raw = String(res?.message?.content || '').trim();
        // JSON when it obliges, the cleaned text when it does not — the
        // caller falls back to the user's own question if even that is empty,
        // because this door must never dead-end on a formatting failure.
        try {
            const j = JSON.parse(raw.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim());
            const body = this._cleanRewrite(j.instruction);
            // The cadence is a SUGGESTION from a fixed vocabulary, never a
            // free-form field: the user confirms it with one click, and an
            // unrecognised value simply falls back to the default rather
            // than arming something nobody can read off the sheet.
            const every = this.QUIET_INTERVALS.includes(String(j.every || '').trim()) ? String(j.every).trim() : '';
            if (body) return { body, title: String(j.title || '').trim().slice(0, 60), every };
        } catch { /* not JSON — fall through */ }
        const body = this._cleanRewrite(raw);
        return body ? { body, title: '' } : { error: 'The model returned nothing to use' };
    },

    /* ── The trigger, written (docs/ROUTINES_UX.md U7) ───────────────────
       "Every weekday at 7" / "when an email from billing@ has invoice in
       it" / "when a PDF lands in ~/Downloads" — said once, parsed into the
       structured trigger the record has always held, and echoed back as a
       sentence with the fields still editable underneath.

       The schema stays canonical. What the model produces is CHECKED
       against the same five intervals and three types the form offers, and
       anything it cannot express is NAMED rather than silently degraded —
       the Calendar repeat row's law ("hide the row rather than clobber a
       rule we cannot represent"), stated positively. A routine that
       quietly runs daily when the user said "the first Monday of the
       month" is worse than one that says it cannot do that. ───────────── */
    TRIGGER_TYPES: ['time', 'email', 'file'],

    async parseTrigger(text) {
        const said = String(text || '').trim();
        if (!said) return { error: 'Say when it should run' };
        if (typeof LLMLogger === 'undefined' || !window.electronLLM) return { error: 'No model is set up yet' };
        const res = await LLMLogger.call('routine-trigger', {
            model: (typeof AgentService !== 'undefined' && AgentService.model) || null,
            activitySubject: 'When a routine runs',
            messages: [
                { role: 'system', content:
                    'Turn a sentence about WHEN something should happen into JSON. Reply with JSON only.\n' +
                    'A clock schedule: {"type":"time","interval":"hourly|6h|daily|weekdays|weekly","time":"HH:MM"} ' +
                    '(24-hour; omit time for hourly and 6h; "weekdays" means Monday to Friday).\n' +
                    'An arriving email: {"type":"email","from":"","subject":"","contains":""} — fill only what was said; ' +
                    '"contains" searches the whole message, so put a word like "invoice" there rather than in subject unless they said subject.\n' +
                    'A new file: {"type":"file","folder":"~/Downloads","pattern":"*.pdf"} — pattern optional.\n' +
                    'If what they asked for cannot be said in exactly those shapes — a specific weekday, a day of the month, ' +
                    'twice a day, a date range, anything conditional — reply ' +
                    '{"unsupported":"<what you could not express, in the user\'s own terms>","nearest":{…one of the shapes above…}} ' +
                    'with the closest thing that IS expressible. Never invent a schedule they did not ask for.' },
                { role: 'user', content: said }
            ],
            options: { temperature: 0.1 }
        });
        if (res?.error) return { error: String(res.error) };
        let raw = String(res?.message?.content || '').trim();
        raw = raw.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim();
        let j;
        try { j = JSON.parse(raw); } catch { return { error: 'Could not read that as a schedule — try the fields below.' }; }
        const trigger = this._validTrigger(j.unsupported ? j.nearest : j);
        if (!trigger) return { error: 'Could not read that as a schedule — try the fields below.' };
        return j.unsupported ? { trigger, unsupported: String(j.unsupported).slice(0, 160) } : { trigger };
    },

    /**
     * The model's answer, checked against what the record can actually
     * hold. Returns null for anything else — no partial trust.
     * Pure — pinned by tests/routine-quiet-test.js.
     */
    _validTrigger(j) {
        if (!j || typeof j !== 'object') return null;
        const type = String(j.type || '').trim();
        if (!this.TRIGGER_TYPES.includes(type)) return null;
        if (type === 'time') {
            const interval = String(j.interval || '').trim();
            if (!this.QUIET_INTERVALS.includes(interval)) return null;
            const clock = ['daily', 'weekdays', 'weekly'].includes(interval);
            const time = /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(j.time || '').trim())
                ? String(j.time).trim().padStart(5, '0') : '';
            return { type, interval, time: clock ? time : '' };
        }
        const str = (v) => String(v == null ? '' : v).trim().slice(0, 200);
        if (type === 'email') {
            const t = { type, from: str(j.from), subject: str(j.subject), contains: str(j.contains) };
            return (t.from || t.subject || t.contains) ? t : null;   // the form's own rule
        }
        const folder = str(j.folder);
        return folder ? { type, folder, pattern: str(j.pattern) } : null;
    },

    /**
     * A rewritten instruction, unwrapped. Models hand these back inside
     * code fences or quotes, and a prompt that begins with ``` is a prompt
     * that reads as a code block for the rest of the routine's life.
     * A leading "Here is the rewritten instruction:" is dropped for the
     * same reason — it would become part of what the model is told to do.
     * Pure — pinned by tests/routine-quiet-test.js.
     */
    _cleanRewrite(raw) {
        let text = String(raw == null ? '' : raw).trim();
        text = text.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim();
        text = text.replace(/^(here(?:'s| is)[^:\n]{0,60}:|rewritten instruction:|new instruction:|updated instruction:)\s*/i, '').trim();
        text = text.replace(/^["'\u201c\u2018]+/, '').replace(/["'\u201d\u2019]+$/, '').trim();
        return text;
    },

    // A failure worth retrying is one where the MODEL never really answered:
    // the server was unreachable or mid-restart, the stream died, or the
    // completion came back empty (a thinking model burning its cap). A
    // deliberate answer, a config problem ("Local model unavailable") or a
    // tool-loop overrun is final — retrying it re-buys the same failure.
    // "rate limit" / "too many concurrent" are nenva Connect's 429 bodies
    // ("Rate limit: too many AI requests this minute", "Too many concurrent
    // AI requests") — neither carries a bare "429" or the literal "too many
    // requests", so they posted error cards instead of retrying.
    _isTransient(error) {
        return /empty response|socket hang up|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|timed out|timeout|premature close|fetch failed|network error|temporarily unavailable|overloaded|rate limit|too many concurrent|too many requests|\b(429|502|503|504)\b/i
            .test(String(error || ''));
    },

    // Persist a run's output as a 'feed'-template note in the shared `notes`
    // blob. The markdown → HTML conversion happens once here, through the
    // same sanitizing formatter the assistant's create_note uses, so the
    // feed and the Notes app render identical stored content.
    _postToFeed(prompt, { content, error, model }) {
        const now = new Date().toISOString();
        const note = {
            id: UIUtils.generateId(),
            title: prompt.title || 'Untitled prompt',
            content: error ? '' : this._format(content),
            tags: [],
            template: 'feed',
            feed: { promptId: prompt.id, model: model || null, error: error || null },
            pinned: false,
            createdAt: now,
            modifiedAt: now
        };
        const notes = NotePrompts._readNotes();
        notes.unshift(note);
        // Pruned editions must leave tombstones — sync merges notes per
        // record, and an untombstoned removal would resurrect from the
        // other Mac (and grow the feed right back).
        const pruned = this._prune(notes, prompt.id);
        let tombstones = null;
        if (pruned.length < notes.length) {
            const keep = new Set(pruned.map(n => n.id));
            const at = new Date().toISOString();
            tombstones = {};
            for (const n of notes) if (!keep.has(n.id)) tombstones[n.id] = at;
        }
        NotePrompts._writeNotes(pruned, tombstones);
        this._refreshNotesApp();
        return note;
    },

    // Personalized run: route the prompt through the AI Assistant so it gets
    // the full user briefing (memory, goals, schedule, notes…) and read-only
    // tools, then return the final answer. Headless — no chat history is
    // touched. Forced onto the local model so the schedule stays offline.
    // Degrades to a plain run if the assistant path is unavailable.
    async _generateWithAssistant(prompt, model) {
        if (typeof AgentService === 'undefined' || typeof AgentService.runHeadless !== 'function') {
            return this._generatePlain(prompt, model);
        }
        const trig = (NotePrompts.config(prompt).trigger || {}).type;
        this._quietSignal = null;
        const res = await AgentService.runHeadless(NotePrompts.bodyText(prompt), {
            contextMode: 'full',
            readOnly: true,
            // The run's clock (RUN_BUDGET_MS) and its handle: the headless
            // conversation id is what Stop aborts.
            budgetMs: this.RUN_BUDGET_MS,
            onStart: (convId) => { if (this._current) this._current.convId = convId; },
            // Same call _runAsTask makes for task-mode runs: an email- or
            // file-triggered digest reads attacker-supplied content, so it
            // loses the irreversible tool classes and egress (read_url /
            // web_search) denies instead of auto-allowing unattended.
            untrustedInput: trig === 'email' || trig === 'file',
            // Provenance for the BACKGROUND RUN system-prompt block: the
            // model should know it's an unattended scheduled run (write a
            // feed post, ask nothing) and its cadence.
            source: {
                title: prompt.title || '',
                schedule: NotePrompts.scheduleLabel(NotePrompts.config(prompt)),
                // U3: the clause is authored HERE and travels; agent-service
                // appends it verbatim to the BACKGROUND RUN block.
                quietClause: this.quietClause(),
                headlineClause: this.headlineClause()
            }
        });
        // The tool fired: this run said nothing, whatever it wrote after.
        if (this._quietSignal) {
            const reason = this._quietSignal.reason || '';
            this._quietSignal = null;
            return {
                content: this.QUIET_TOKEN + (reason ? ' — ' + reason : ''),
                error: null,
                model: (res && res.model) || (AgentService.getActiveModel && AgentService.getActiveModel()) || model
            };
        }
        if (res && res.type === 'stopped') {
            const mins = Math.round((Date.now() - ((this._current && this._current.startedAt) || Date.now())) / 60000);
            const byUser = !!(this._current && this._current.cancelled) && res.stopReason !== 'budget';
            // Neither message may match _isTransient's vocabulary ("timed
            // out", "timeout") — a stop is a settlement, not an outage.
            return {
                content: '',
                error: byUser
                    ? `Stopped by you after ${mins} min`
                    : `Stopped after ${mins} min — the run's ${Math.round(this.RUN_BUDGET_MS / 60000)}-minute budget was spent without finishing`,
                stoppedByUser: byUser,
                model: (res && res.model) || (AgentService.getActiveModel && AgentService.getActiveModel()) || model
            };
        }
        return {
            content: (res && res.type === 'text') ? (res.content || '').trim() : '',
            error: (res && res.type === 'error') ? (res.content || 'Run failed') : null,
            // Prefer the model that actually ANSWERED (res.model — when the
            // provider is the user's own server, that's the server model, not
            // the local model selection getActiveModel would report).
            model: (res && res.model) || (AgentService.getActiveModel && AgentService.getActiveModel()) || model
        };
    },

    // Plain offline run: local model, no tools.
    async _generatePlain(prompt, model) {
        const res = await LLMLogger.call('prompt-feed', {
            model,
            activitySubject: prompt.title || null,
            messages: [
                { role: 'system', content: `You are running the user's routine unattended (runs ${NotePrompts.scheduleLabel(NotePrompts.config(prompt))}); the result is posted to their feed to read later. No one is present to reply — never ask questions or offer follow-ups. Respond directly and concisely with a self-contained answer.` + this.headlineClause() + this.quietClause() },
                { role: 'user', content: NotePrompts.bodyText(prompt) }
            ],
            options: { temperature: 0.4 }
        });
        return {
            content: (res?.message?.content || '').trim(),
            error: res?.error ? String(res.error) : null,
            model: res?.model || null
        };
    },

    // Web-grounded run: local model with the agent's `web_search` and
    // `get_news` tools available. Runs a small tool loop — the model
    // decides whether to search (via the user's configured Tavily/Brave
    // provider) or read the followed-topic headlines, then writes the
    // final answer. No browser tab involved.
    // get_news is here because the Morning News starter's body says "Call
    // get_news" while running web-without-context — this path shipped
    // web_search alone from birth, so that starter never once reached the
    // tool it is built on (found 2026-08-06 driving the demo instance:
    // the model answered "there is no get_news tool" and degraded to
    // general web headlines instead of the user's topics).
    async _generateWithWeb(prompt, model) {
        const defs = (typeof AgentTools !== 'undefined' && Array.isArray(AgentTools.definitions))
            ? AgentTools.definitions : [];
        // web_search plus whatever packages flagged `webRun` (News's
        // get_news — the Morning News starter is built on it).
        const extra = (AgentTools._webRunTools instanceof Set) ? [...AgentTools._webRunTools] : [];
        const toolDefs = ['web_search', ...extra]
            .map(n => defs.find(d => d?.function?.name === n))
            .filter(Boolean);
        const toolNames = new Set(toolDefs.map(d => d.function.name));
        if (!toolNames.has('web_search') || typeof AgentTools.execute !== 'function') {
            // Tooling unavailable — degrade to a plain run rather than fail.
            return this._generatePlain(prompt, model);
        }

        const messages = [
            { role: 'system', content: `You are a research assistant running the user's routine unattended (runs ${NotePrompts.scheduleLabel(NotePrompts.config(prompt))}); the result is posted to their feed to read later. ${toolNames.has('get_news') ? 'Use the get_news tool for the headlines of the topics the user follows in their News app; use the web_search tool when other' : 'Use the web_search tool when'} current or external information would improve the answer; otherwise answer directly. After searching, synthesize a clear, self-contained answer in markdown and cite source URLs inline. Do not ask the user questions or offer follow-ups — no one is present to reply.` + this.headlineClause() + this.quietClause() },
            { role: 'user', content: NotePrompts.bodyText(prompt) }
        ];

        const MAX_ROUNDS = this.WEB_TOOL_ROUNDS;
        let lastModel = null;
        const startedAt = Date.now();
        const stopped = () => !!(this._current && this._current.cancelled);
        const stopResult = () => ({
            content: '',
            error: `Stopped by you after ${Math.round((Date.now() - startedAt) / 60000)} min`,
            stoppedByUser: true,
            model: lastModel
        });

        for (let i = 0; i < MAX_ROUNDS; i++) {
            if (stopped()) return stopResult();
            // The run's clock ends research the same way a spent round
            // count does — through the synthesis pass below, never by
            // returning whatever the model happened to be saying.
            if (Date.now() - startedAt >= this.RUN_BUDGET_MS) break;

            const res = await LLMLogger.call('prompt-feed', {
                model,
                activitySubject: prompt.title || null,
                messages,
                tools: toolDefs,
                options: { temperature: 0.4 }
            });
            if (res?.error) return { content: '', error: String(res.error), model: lastModel };
            if (res?.model) lastModel = res.model;

            const msg = res?.message || {};
            const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
            if (!calls.length) {
                const text = (msg.content || '').trim();
                // An ANSWER ends the run. A plan does not: a model that
                // narrates its next step has not written the post, and a
                // run that returns the narration posts it as the edition.
                if (text && !this._looksUnfinished(text)) {
                    return { content: text, error: null, model: lastModel };
                }
                messages.push(msg);
                break;
            }

            // Echo the assistant turn (with its tool_calls) then append a
            // role:'tool' result per call — the message shape the engine's
            // chat template expects, mirroring AgentService's loop.
            messages.push(msg);
            for (const tc of calls) {
                const name = toolNames.has(tc?.function?.name) ? tc.function.name : 'web_search';
                // A result names the CALL it answers. Every other tool loop
                // in the app carries `tool_call_id`; this one didn't, and the
                // official APIs are the ones that check: Anthropic answered
                // 400 "unexpected tool_use_id found in tool_result blocks:
                // tool_2 — each tool_result block must have a corresponding
                // tool_use block" (2026-09-18), because main's converter had
                // nothing to pair and fell back to a positional id while the
                // assistant turn carried the API's own `toolu_…`. llama.cpp
                // and the cloud proxy never minded, which is why a routine
                // that worked on every local brain failed on a real key.
                // The id is written back onto the call so the echoed
                // assistant turn and the result always name each other.
                if (tc && !tc.id) tc.id = `call_${i}_${calls.indexOf(tc)}`;
                let args = tc?.function?.arguments;
                if (typeof args === 'string') {
                    try { args = JSON.parse(args); } catch { args = {}; }
                }
                if (name === 'web_search' && args && args.maxResults == null) args.maxResults = 5;
                let result;
                try {
                    // A routine run is ambient: the user is not in the loop
                    // for this turn (CloudPrivacy's data-class gate reads it).
                    // `source` names the surface this run's model calls
                    // carry, so the tool gate and the send gate agree about
                    // where this routine's work goes (model-routing.js R4).
                    result = await AgentTools.execute(name, args || {}, { ambient: true, source: 'prompt-feed' });
                } catch (e) {
                    result = { error: e?.message || name + ' failed' };
                }
                messages.push({
                    role: 'tool',
                    name,
                    tool_call_id: tc && tc.id,
                    content: JSON.stringify(result).slice(0, 6000)
                });
            }
        }

        if (stopped()) return stopResult();
        return await this._webSynthesis(prompt, messages, model, lastModel);
    },

    /* ── The answer is ASKED for (2026-09-18) ────────────────────────────
       Withholding the tools is not an instruction. This loop used to drop
       `tools` on its last iteration and take whatever came back; a model
       mid-research simply kept writing in its research voice — "Let me
       verify the exact 52-week high for SMH and check the 200-day MA" —
       and that plan became the user's edition, three days running.

       So the research loop never writes the answer: it ends here, with one
       tools-free call that SAYS the run is over and asks for the post. It
       is the same automatic-recovery turn AgentService pushes when its own
       tool budget is spent ("forcing a tools-free synthesis pass"), which
       the web path never got because it grew up separately.

       The turn is not a second copy of the digest contract: how to begin
       (headlineClause) and how to say nothing (quietClause) are authored
       once, in the system prompt, and this only points back at them. ──── */
    SYNTHESIS_TURN: '(Automatic — not a message from the user.) Research time is up and there are no more tools. Write the finished post NOW, from the tool results already above, in the format the routine asked for. Do not describe what you were about to look up and do not say what you would do next — if something stayed unverified, say so in one short line inside the answer itself. How to begin, and the silence rule, still apply.',

    async _webSynthesis(prompt, messages, model, lastModel) {
        messages.push({ role: 'user', content: this.SYNTHESIS_TURN });
        const res = await LLMLogger.call('prompt-feed', {
            model,
            activitySubject: prompt.title || null,
            messages,
            options: { temperature: 0.4 }
        });
        if (res?.error) return { content: '', error: String(res.error), model: res?.model || lastModel };
        const text = ((res?.message?.content) || '').trim();
        const m = res?.model || lastModel;
        // Asked for the answer and told the plan again. Better an honest
        // error card (the routine's "Last problem" line carries it) than an
        // edition of someone's thinking — a feed that posts reasoning is a
        // feed its reader stops opening.
        if (this._looksUnfinished(text)) return { content: '', error: this.UNFINISHED_ERROR, model: m };
        return { content: text, error: null, model: m };
    },

    /* ── A plan is not an answer (2026-09-18) ────────────────────────────
       Vocabulary, never a model verdict: the shapes below are the research
       voice a brain writes between tool calls, and nothing else is read as
       unfinished. STRICT on purpose, in the readQuiet direction — a false
       positive turns a real digest into an error card, so a planning verb
       must be there ("let me CHECK", "I'll VERIFY"), an intention on its
       own ("I'll keep an eye on this") is not one, and "let me know" is a
       follow-up offer, which the prompt already forbids for other reasons.

       Only the first line and the closing sentence are read: that is where
       the voice shows, and a headline that is a plan already breaks U4's
       "no 'Let me…', no thinking out loud".

       Pure — pinned by tests/routine-unfinished-test.js. ───────────────── */
    UNFINISHED_ERROR: 'The model wrote its research plan instead of the answer',

    PLAN_RX: /\b(?:let me(?! know\b)|let(?:'|\u2019)s|let us|i(?:'|\u2019)ll|i will|i(?:'|\u2019)m going to|i am going to|i need to|i should|i have to|next,? i)\s+(?:also\s+|now\s+|first\s+|then\s+|quickly\s+|just\s+|try to\s+)*(?:check|verify|confirm|search|look|get|find|fetch|read|pull|scan|review|see|do|run|calculate|compute|gather|dig|start|begin|continue|take a look|gather)\b/i,

    _looksUnfinished(text) {
        const t = String(text == null ? '' : text)
            .replace(/```[\s\S]*?```/g, ' ')   // a fenced block is content, not voice
            .replace(/[*_`#>]+/g, '')
            .trim();
        if (!t) return false;
        const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
        const sentences = (line) => String(line)
            .split(/(?<=[.!?])\s+/)
            .map(x => x.replace(/^[-\u2013\u2014\u2022\d.)\s]+/, '').trim())
            .filter(Boolean);
        const opening = sentences(lines[0]).slice(0, 3);
        const closing = sentences(lines[lines.length - 1]).pop() || '';
        return opening.some(s => this.PLAN_RX.test(s)) || this.PLAN_RX.test(closing);
    },

    // Keep a rolling history per prompt so the user can see how the
    // output changed over time, without unbounded growth. Operates on a
    // notes array (newest feed notes first — runs unshift) and returns the
    // pruned copy. Pinned posts are the user's keepers — never pruned.
    _prune(notes, promptId) {
        let seen = 0;
        return notes.filter(n => {
            if (!this._isFeedNote(n) || !n.feed || n.feed.promptId !== promptId) return true;
            if (n.pinned) return true;
            seen += 1;
            return seen <= this.MAX_PER_PROMPT;
        });
    },

    /* ---------- Published posts (remote-config `feedPosts`) ----------
     *
     * Messages nenva publishes for users — release notes, tips — ride the
     * same remote-config channel the model catalog uses (bundled fallback →
     * cached → remote). Each post: { id, title, date, body, link? }. They
     * render as regular feed cards with a provenance chip; a dismissed
     * post's id is stored (synced) so it stays gone on every Mac.
     */

    async _loadPublished() {
        try {
            const cfg = await window.electronConfig.get();
            this._published = (Array.isArray(cfg?.feedPosts) ? cfg.feedPosts : [])
                .filter(p => p && p.id && p.title);
        } catch {
            this._published = [];
        }
    },

    _publishedModels() {
        if (!this._published || !this._published.length) return [];
        const dismissed = new Set((StorageManager.get('dismissed-feed-posts')?.ids) || []);
        return this._published
            .filter(p => !dismissed.has(p.id))
            .map(p => ({
                id: 'pub-' + p.id,
                promptId: null,
                promptTitle: p.title,
                html: this._format(p.body || '') + ((p.link && p.link.url && p.link.label)
                    ? `<p><a href="${UIUtils.escapeHtml(p.link.url)}">${UIUtils.escapeHtml(p.link.label)}</a></p>`
                    : ''),
                error: null,
                model: null,
                createdAt: p.date || null,
                published: true
            }));
    },

    _dismissPublished(pubId) {
        const id = String(pubId).replace(/^pub-/, '');
        const current = StorageManager.get('dismissed-feed-posts') || {};
        const ids = Array.isArray(current.ids) ? current.ids.slice() : [];
        if (!ids.includes(id)) ids.push(id);
        StorageManager.set('dismissed-feed-posts', { ids });
    },

    /* ---------- Feed preferences ----------
     *
     * Only `hideRead` survives, surfaced as the Unread/All toggle in the
     * feed header. The Feed-preferences modal (sliders button) was removed
     * 2026-07-31: its last remaining row was a "Routine results" on/off
     * whose only real effect was hiding the entire feed — managing the
     * routines themselves is the honest lever. The stored `prompts` field
     * is deliberately IGNORED (not just unsurfaced) so a Mac that once
     * switched it off gets its feed back. The key is unchanged so the
     * Unread/All choice still syncs.
     */

    PREFS_KEY: 'feed-prefs',

    prefs() {
        const p = StorageManager.get(this.PREFS_KEY) || {};
        return {
            // `insights` was dropped 2026-07-29 with the feed's insight
            // cards, `prompts` on 2026-07-31 with the prefs modal. Stale
            // values stay harmlessly in the synced blob.
            hideRead: p.hideRead !== false
        };
    },

    /* ---------- Email insights: not here any more ----------
     *
     * Unread insights used to render as feed cards. They now live only in
     * home's Email widget (js/apps/email/email-widget.js), which sits above
     * the feed and was showing the same insights a second time. The widget
     * is the better home: capped, sorted action-first, and above the fold
     * where something actionable belongs — while the feed is a reading
     * surface for what the assistant wrote.
     *
     * The email bootstrap that used to live here (_ensureEmailData: load the
     * mailbox at launch and start sync + the analysis pipeline, so insights
     * appear without ever opening the Email app) moved to the widget with
     * them. It is load-bearing — without it a session that never opens Email
     * does no analysis at all.
     */

    /* ---------- Rendering ---------- */

    /** The series an item belongs to. */
    _sourceKey(it) {
        // Team announcements are distinct posts, not editions of a routine.
        if (it.published) return 'published:' + it.id;
        // promptId is absent on posts migrated from the pre-notes feed, so
        // fall back to the title — those group correctly, just by name.
        return it.promptId ? 'prompt:' + it.promptId : 'title:' + it.promptTitle;
    },

    /**
     * Everything in scope for the read toggle, before source filtering.
     * `unreadOnly` is a parameter rather than a prefs read so render() can
     * ask for both views in one pass — the alternative (flipping the pref,
     * recomputing, flipping it back) writes to StorageManager twice on
     * every render, and that key syncs.
     */
    _scopedItems(unreadOnly = this.prefs().hideRead, notes = null) {
        // `notes` lets render() read the blob once and derive both views
        // from it — each read is a full marshal of every note the user has.
        const feedNotes = notes ? notes.filter(n => this._isFeedNote(n)) : this._feedNotes();
        let cards = feedNotes.map(n => this._cardModel(n));
        // Read prompt posts leave the feed while the toggle says Unread —
        // error cards are exempt (they can't be opened, so they can never
        // be read; only × removes them).
        if (unreadOnly) cards = cards.filter(c => !c.read);
        return [...this._publishedModels(), ...cards]
            .sort((a, b) =>
                new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    },

    /**
     * Group the feed into series: one per routine, plus a separate card for
     * each post published by nenva. Newest edition first within a series;
     * series ordered by how recently they posted.
     *
     * This is the shape the content actually has. Each prompt is a
     * newsletter producing dated editions, so a flat stream shows the same
     * masthead ten times and puts this morning's portfolio snapshot next to
     * an identical one from last night.
     */
    _series(items) {
        const by = new Map();
        for (const it of items) {
            const key = this._sourceKey(it);
            if (!by.has(key)) by.set(key, { key, title: it.promptTitle, published: !!it.published, editions: [] });
            by.get(key).editions.push(it);
        }
        const out = [...by.values()];
        for (const sc of out) {
            sc.editions.sort((a, b) =>
                new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
            sc.latest = sc.editions[0];
            sc.earlier = sc.editions.slice(1);
            sc.unread = sc.editions.some(e => !e.read && !e.published);
        }
        return out.sort((a, b) =>
            new Date(b.latest.createdAt || 0).getTime() - new Date(a.latest.createdAt || 0).getTime());
    },

    /**
     * Drop a leading heading that just restates the post's title. Shared
     * intent with _summaryFor's first skip rule, but it edits the DOM in
     * place rather than reading text out, so the full post loses the
     * duplicate too.
     */
    _stripLeadingTitle(host, title) {
        const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const want = norm(title);
        if (!want) return;
        for (const el of [...host.children]) {
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!text) { el.remove(); continue; }        // leading blank block
            if (!/^H[1-6]$|^P$/.test(el.tagName)) return;
            const n = norm(text);
            // Same rule as the digest: an exact restatement, or the title
            // plus a short tail like an em-dashed date.
            if (n === want || (n.startsWith(want) && text.length < title.length + 24)) {
                el.remove();
                return;
            }
            return;
        }
    },

    /**
     * A couple of lines describing an edition, pulled from the post itself.
     * No model involved — the digest must work with the engine off, and a
     * summary of a summary is a place for a small model to invent things.
     *
     * Two things it has to get right:
     *  - Drop a leading heading that just repeats the series name. Posts
     *    routinely open with "Portfolio Watch & Rebalancing — July 30",
     *    which the block already says directly above.
     *  - Skip tables. Half these posts lead with one, and its cell text
     *    reads as word salad in a summary line.
     */
    _summaryFor(it) {
        if (it.error) return this._friendlyError(it.error);
        const host = document.createElement('div');
        host.innerHTML = it.html || '';
        const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const title = norm(it.promptTitle);
        const parts = [];
        for (const el of host.children) {
            if (/^(TABLE|UL|OL|PRE|HR)$/.test(el.tagName)) continue;
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!text) continue;
            const n = norm(text);
            // A heading that restates the series name, with or without a
            // trailing date, carries nothing the block hasn't said.
            if (n === title || (title && n.startsWith(title) && text.length < title.length + 24)) continue;
            parts.push(text);
            if (parts.join(' ').length > 150) break;
        }
        const summary = parts.join(' ').trim();
        if (summary) return summary.length > 190 ? summary.slice(0, 187).trimEnd() + '…' : summary;
        // All table, no prose — say what it is rather than nothing.
        const rows = host.querySelectorAll('tr').length;
        return rows ? `A table of ${rows - 1} row${rows === 2 ? '' : 's'}.` : 'Open to read.';
    },

    /** Which series have their earlier editions open. In memory: this is
     *  where you are looking, not a setting. */
    _expanded: new Set(),

    render() {
        const list = document.getElementById('prompt-feed-list');
        if (!list) return;

        const unreadOnly = this.prefs().hideRead;
        // ONE read of the notes blob per render. It used to be read twice
        // here and once more per series in _kindOf — fourteen marshals of
        // every note (images included) to paint twelve rows.
        const notes = (typeof NotePrompts !== 'undefined') ? NotePrompts._readNotes() : [];
        const prompts = new Map();
        if (typeof NotePrompts !== 'undefined') {
            for (const n of notes) if (NotePrompts.isPrompt(n)) prompts.set(n.id, n);
        }
        const items = this._scopedItems(unreadOnly, notes);
        const everything = unreadOnly ? this._scopedItems(false, notes) : items;

        this._renderScopeToggle();

        const series = this._series(items);

        const clearBtn = document.getElementById('prompt-feed-clear');
        // Clear all only removes the user's own run posts — published posts
        // are dismissed per-card — so key its visibility off those.
        if (clearBtn) clearBtn.style.display = items.some(i => !i.published) ? '' : 'none';

        if (!series.length) {
            let html;
            if (unreadOnly && everything.length > 0) {
                html = `<h3>You're all caught up</h3>
                    <p>Switch to <strong>All</strong> to read back through the feed.</p>`;
            } else {
                const anyOffline = (typeof RoutineEngine !== 'undefined')
                    && RoutineEngine.armedRoutines().length > 0;
                html = `<h3>No feed entries yet</h3>
                    <p>${anyOffline
                        ? 'Routines post here when they have something to say. A run with nothing to report posts nothing — its routine&rsquo;s page records it either way.'
                        : 'Create a routine in <strong>Manage routines</strong> — a prompt that runs on a schedule. Its results land here automatically.'}</p>`;
            }
            // The day's line still belongs here: "all caught up" and "your
            // routines did these three things today" are different facts.
            list.innerHTML = this._renderBrief(everything) + `<div class="empty-state">${html}</div>`;
            this._wireList(list);
            return;
        }

        // No global "show everything" control: each series folds on its own,
        // and one button that dumps every edition back onto the page undoes
        // the point of a digest.
        // The brief reads today's items, not the filtered view: "what did
        // my assistant do today" does not change because the reader is
        // looking at unread only.
        list.innerHTML = this._renderBrief(everything) + series.map(sc => this._renderSeries(sc, prompts)).join('');
        this._wireList(list);
    },

    /* ── Colour as data (2026-09-09, by request): one stable hue per
       ROUTINE, hashed into the Portfolio palette and carried as an inline
       `--rt-hue` on the feed series, the result page and the routine's
       detail, so an edition is recognisable as "the Morning News one"
       before its title is read. Published nenva posts stay neutral. ── */
    ROUTINE_HUES: ['#4F6BED', '#F97316', '#14B8A6', '#EC4899', '#65A30D', '#8B5CF6', '#F59E0B', '#0EA5E9', '#EF4444', '#0891B2', '#B45309', '#6366F1'],
    routineHue(key) {
        const k = String(key || '').trim().toLowerCase();
        if (!k) return '#9CA3AF';
        let h = 0;
        for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
        return this.ROUTINE_HUES[h % this.ROUTINE_HUES.length];
    },
    // What kind of routine wrote an item: 'published' (nenva's own
    // posts), 'task' (a routine that acts) or 'report' (one that writes).
    // `prompts` (id → prompt note) is render()'s one-read index; without
    // it (the post overlay) the prompt is looked up from storage.
    _kindOf(it, prompts = null) {
        if (it.published) return 'published';
        if (!it.promptId || typeof NotePrompts === 'undefined') return 'report';
        const note = prompts
            ? (prompts.get(it.promptId) || null)
            : (NotePrompts.list().find(p => p.id === it.promptId) || null);
        return (note && NotePrompts.config(note).runMode === 'task') ? 'task' : 'report';
    },
    KIND_ICONS: {
        report: '<path d="M4 4h16v16H4z" opacity="0"/><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/>',
        task: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
        published: '<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15 9a3 3 0 0 1 0 6"/><path d="M18 6a7 7 0 0 1 0 12"/>',
    },
    kindIcon(kind, size = 14) {
        return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${this.KIND_ICONS[kind] || this.KIND_ICONS.report}</svg>`;
    },
    KIND_LABELS: { report: 'Routine', task: 'Routine \u00b7 takes actions', published: 'From nenva' },

    /* ── The day in one line (docs/ROUTINES_UX.md U4) ────────────────────
       Above the series, one sentence for what the app did on its own
       today: "Market review flagged one drop · News had nothing · Daily
       briefing: three things".

       ASSEMBLED, NEVER WRITTEN. Each clause is a routine's own name plus
       its own first words (`_summaryFor`, already extracted from the post
       and already not model-written) or, for a run that settled quiet, the
       fixed phrase "had nothing". No second model call, nothing here can
       author a sentence about other sentences, and the line cannot say
       something the editions do not.

       Two or more clauses, or it does not render: one routine's headline is
       already on its own card directly below, and repeating it as a summary
       of itself is the duplication this app keeps removing. ────────────── */
    /* A clause is said WHOLE or not at all — there are no ellipses in this
       line. Clipping both halves to fit produced "latest trends in
       consumer… — did not finish · Identify new investment… — One caveat up
       front: this run's live market-news…", which reads as truncated junk
       rather than as a summary, and a summary nobody can read is worse than
       no summary.

       So: a routine whose TITLE is a sentence (a prompt used as a name) is
       dropped, and a headline is taken as its first SENTENCE, or its first
       CLAUSE if that sentence is long, or the routine is dropped. Old posts
       written before the headline clause fall out of the line on their own
       as a result, which is the right answer — they have no headline to
       join. */
    BRIEF_NAME_MAX: 32,
    BRIEF_TEXT_MAX: 56,
    BRIEF_MIN_WORDS: 2,
    BRIEF_CLAUSES_MAX: 4,

    /**
     * The short, whole form of a headline, or '' when there isn't one.
     * Pure — pinned by tests/routine-quiet-test.js.
     */
    _briefText(headline) {
        const whole = String(headline || '').replace(/\s+/g, ' ').trim();
        if (!whole) return '';
        const ok = (t) => {
            const trimmed = t.replace(/[\s,;:.\u2014\u2013-]+$/, '').trim();
            return trimmed.length <= this.BRIEF_TEXT_MAX
                && trimmed.split(/\s+/).length >= this.BRIEF_MIN_WORDS
                ? trimmed : '';
        };
        // The whole thing, then its first sentence, then its first clause.
        const sentence = whole.split(/(?<=[.!?])\s+/)[0] || '';
        // A COLON introduces what follows, so the part before one is a
        // lead-in, not a headline: "One caveat up front: this run's live
        // market-news feed was unavailable" must not become "One caveat up
        // front". A comma splits a sentence that has already said
        // something ("Two came in from teachers today, both already…").
        const clause = /:/.test(sentence) ? '' : (sentence.split(/[,;\u2014\u2013]/)[0] || '');
        return ok(whole) || ok(sentence) || ok(clause) || '';
    },

    /**
     * The run's own headline: the first line of the post, which the
     * headline clause asks for. Posts written before that clause existed
     * have no short first line, so this falls back to the summary — hence
     * the clip, which is what keeps an old post from eating the line.
     */
    /**
     * How often this routine's editions actually get opened
     * (docs/ROUTINES_UX.md U8): `{ shown, opened }` over its most recent
     * editions. Arithmetic over `feed.readAt`, which the post overlay
     * already stamps — there is no new state here, which is the point:
     * the app has always known this and never said it.
     *
     * ERROR cards are excluded. They cannot be opened, so counting them
     * would manufacture a low rate for a routine whose brain was down.
     */
    readRate(promptId) {
        if (!promptId || typeof NotePrompts === 'undefined') return { shown: 0, opened: 0 };
        const notes = NotePrompts._readNotes()
            .filter(n => this._isFeedNote(n) && n.feed && n.feed.promptId === promptId && !n.feed.error)
            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
            .slice(0, this.MAX_PER_PROMPT);
        return { shown: notes.length, opened: notes.filter(n => !!n.feed.readAt).length };
    },

    _headlineOf(it) {
        if (it.error) return 'did not finish';
        const host = document.createElement('div');
        host.innerHTML = it.html || '';
        const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const title = norm(it.promptTitle);
        for (const el of host.children) {
            if (/^(TABLE|UL|OL|PRE|HR)$/.test(el.tagName)) continue;
            // A HEADING is a title, not a fact. Posts written before the
            // headline clause existed open with one — "Investment
            // Opportunity Report — Wed, Sep 16, 2026" — and a line of those
            // says only that the routines ran, which the feed below it
            // already says. The name-matching skip below catches a heading
            // that repeats the routine's name; this catches the rest.
            if (/^H[1-6]$/.test(el.tagName)) continue;
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!text) continue;
            // A paragraph that is ENTIRELY bold, with the post continuing
            // after it, is a heading wearing a paragraph's clothes — which
            // is how "Emails from Stratford schools — Wednesday, September
            // 16" became a routine's headline for the day.
            const onlyChild = el.children.length === 1 ? el.children[0] : null;
            if (onlyChild && /^(STRONG|B)$/.test(onlyChild.tagName)
                && (onlyChild.textContent || '').trim() === text
                && el.nextElementSibling) continue;
            const n = norm(text);
            if (n === title || (title && n.startsWith(title) && text.length < title.length + 24)) continue;
            // A model that ignored the clause and opened with a paragraph
            // still has a usable first SENTENCE, and the brief must never
            // be a paragraph — the clause makes this good, it does not make
            // it work.
            if (text.length > 110) {
                const first = text.split(/(?<=[.!?])\s+/)[0] || text;
                return first;
            }
            return text;
        }
        return this._summaryFor(it);
    },

    _startOfToday() {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    },

    /**
     * Clauses for today, newest first: `{ label, kind, id }` where kind is
     * 'post' (id opens the edition) or 'quiet' (id opens the routine).
     * Pure enough to read at a glance; the DOM work is `_summaryFor`'s.
     */
    _briefClauses(items) {
        const floor = this._startOfToday();
        const out = [];
        const seen = new Set();
        // Two routines may carry the same name (the demo seed ships two
        // "Morning News"), and a line that says it twice reads as a bug.
        const seenName = new Set();
        const name = (t) => {
            const s2 = String(t || '').replace(/\s+/g, ' ').trim();
            // A title longer than this is a PROMPT being used as a name.
            // It cannot be said in a line, so its routine sits this out.
            return s2 && s2.length <= this.BRIEF_NAME_MAX ? s2 : '';
        };

        for (const it of items) {
            if (it.published) continue;                       // nenva's own posts are not "what my routines did"
            if ((Date.parse(it.createdAt) || 0) < floor) continue;
            const key = it.promptId || it.id;
            if (seen.has(key)) continue;                      // one clause per routine, its newest edition
            seen.add(key);
            const title = name(it.promptTitle || 'A routine');
            if (!title || seenName.has(title.toLowerCase())) continue;
            const text = it.error ? 'did not finish' : this._briefText(this._headlineOf(it));
            if (!text) continue;                      // nothing sayable — its card says it
            seenName.add(title.toLowerCase());
            out.push({ name: title, text, kind: 'post', id: it.id, at: Date.parse(it.createdAt) || 0 });
        }

        // Silence is part of the day (U3): a routine that ran and had
        // nothing to say posts no card, and this is the one place that says
        // so — a clause, never a card.
        const quiet = (typeof RoutineEngine !== 'undefined' && RoutineEngine.state && RoutineEngine.state.quiet) || {};
        for (const [routineId, list] of Object.entries(quiet)) {
            if (seen.has(routineId) || !Array.isArray(list) || !list.length) continue;
            const newest = list[0];
            const at = Date.parse(newest && newest.at) || 0;
            if (at < floor) continue;
            seen.add(routineId);
            const note = (typeof NotePrompts !== 'undefined')
                ? NotePrompts.list().find(n => n.id === routineId) : null;
            if (!note) continue;
            const qTitle = name(note.title || 'A routine');
            if (!qTitle || seenName.has(qTitle.toLowerCase())) continue;
            seenName.add(qTitle.toLowerCase());
            out.push({ name: qTitle, text: 'nothing to report', kind: 'quiet', id: routineId, at });
        }

        return out.sort((a, b) => b.at - a.at).slice(0, this.BRIEF_CLAUSES_MAX);
    },

    _renderBrief(items) {
        const clauses = this._briefClauses(items);
        if (clauses.length < 2) return '';
        const esc = UIUtils.escapeHtml.bind(UIUtils);
        // ONE ROW PER ROUTINE, not a flowing sentence. Four clauses joined
        // with dots read as a continuous blob however short each one got —
        // the eye had nothing to land on. Rows give it the app's own
        // anatomy: a name column to scan and the statement beside it.
        return `
        <div class="feed-brief">
            <span class="feed-brief-label">Today</span>
            <ul class="feed-brief-rows">${clauses.map(c => `
                <li class="feed-brief-clause" role="button" tabindex="0"
                    data-brief-kind="${c.kind}" data-brief-id="${esc(c.id)}">
                    <span class="feed-brief-name">${esc(c.name)}</span>
                    <span class="feed-brief-text">${esc(c.text)}</span>
                </li>`).join('')}</ul>
        </div>`;
    },

    /**
     * One series: the newest edition described in place, everything older
     * folded behind a disclosure. The block IS the navigation — which is
     * why there is no source nav any more.
     */
    _renderSeries(sc, prompts = null) {
        const esc = UIUtils.escapeHtml.bind(UIUtils);
        const it = sc.latest;
        const open = this._expanded.has(sc.key);
        const unread = !it.read && !it.published;
        const model = this._displayModel(it.model);

        const earlier = sc.earlier.length
            ? `<button type="button" class="feed-series-toggle" data-feed-series="${esc(sc.key)}"
                       aria-expanded="${open}">${open ? 'Hide' : 'Show'} ${sc.earlier.length} earlier</button>`
            : '';

        const rows = open ? `<ul class="feed-earlier">${sc.earlier.map(e => `
            <li class="feed-earlier-row${e.read || e.published ? '' : ' is-unread'}"
                data-feed-open="${esc(e.id)}" role="button" tabindex="0">
                <span class="feed-earlier-when">${esc(this._timeAgo(e.createdAt))}</span>
                <span class="feed-earlier-text">${esc(this._summaryFor(e))}</span>
                <button class="feed-card-del" type="button" data-feed-del="${esc(e.id)}"
                        title="Remove">&times;</button>
            </li>`).join('')}</ul>` : '';

        const kind = this._kindOf(it, prompts);
        const hue = sc.published ? '#9CA3AF' : this.routineHue(it.promptId || sc.key);
        return `
        <article class="feed-series${sc.published ? ' feed-series--published' : ''}${unread ? ' is-unread' : ''}" data-rt-kind="${kind}" style="--rt-hue:${hue}">
            <header class="feed-series-head" data-feed-open="${esc(it.id)}" role="button" tabindex="0">
                <span class="feed-series-tile" aria-hidden="true">${this.kindIcon(kind)}</span>
                <h3 class="feed-series-title">${esc(sc.title)}</h3>
                ${unread ? '<span class="feed-series-dot" title="Unread" aria-label="Unread"></span>' : ''}
                <span class="feed-series-meta">${esc(this._timeAgo(it.createdAt))}${model ? ' &middot; ' + esc(model) : ''}</span>
                <button class="feed-card-del" type="button" data-feed-del="${esc(it.id)}"
                        title="${sc.published ? 'Dismiss' : 'Remove'}">&times;</button>
            </header>
            <p class="feed-series-summary${it.error ? ' is-error' : ''}"
               data-feed-open="${esc(it.id)}" role="button" tabindex="0">${esc(this._summaryFor(it))}</p>
            ${earlier ? `<div class="feed-series-foot">${earlier}</div>` : ''}
            ${rows}
        </article>`;
    },

    _wireList(list) {
        // A clause is a door to the thing it describes: the edition it was
        // taken from, or — for a quiet run, which has no edition — the
        // routine whose page records it.
        const openClause = (el) => {
            const id = el.dataset.briefId;
            if (!id) return;
            if (el.dataset.briefKind === 'quiet') {
                AppManager.openApp('prompts');
                if (typeof PromptsApp !== 'undefined') PromptsApp.open({ id });
            } else {
                this.openPost(id);
            }
        };
        list.querySelectorAll('.feed-brief-clause').forEach(el => {
            el.addEventListener('click', () => openClause(el));
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openClause(el); }
            });
        });
        list.querySelectorAll('[data-feed-del]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteItem(btn.dataset.feedDel);
            });
        });
        list.querySelectorAll('[data-feed-series]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const key = btn.dataset.feedSeries;
                if (this._expanded.has(key)) this._expanded.delete(key);
                else this._expanded.add(key);
                this.render();
            });
        });
        const open = (el) => {
            const id = el.dataset.feedOpen;
            if (id) this.openPost(id);
        };
        list.querySelectorAll('[data-feed-open]').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('a') || e.target.closest('[data-feed-del]')
                    || e.target.closest('[data-feed-series]')) return;
                open(el);
            });
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(el); }
            });
        });
    },

    /**
     * Unread / All. This used to be a checkbox buried in the preferences
     * modal, which is the wrong home for something you flip while reading.
     * It still writes the same synced `hideRead` key — only the surface
     * moved, so the choice still follows the user between Macs.
     */
    _renderScopeToggle() {
        const host = document.getElementById('feed-scope');
        if (!host) return;
        const unread = this.prefs().hideRead;
        host.innerHTML = `
            <button type="button" class="feed-scope-btn${unread ? ' is-current' : ''}"
                    data-feed-scope="unread"${unread ? ' aria-current="true"' : ''}>Unread</button>
            <button type="button" class="feed-scope-btn${unread ? '' : ' is-current'}"
                    data-feed-scope="all"${unread ? '' : ' aria-current="true"'}>All</button>`;
        if (host.dataset.wired) return;
        host.dataset.wired = '1';
        host.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-feed-scope]');
            if (!btn) return;
            const next = this.prefs();
            next.hideRead = btn.dataset.feedScope === 'unread';
            StorageManager.set(this.PREFS_KEY, next);
            this.render();
        });
    },

    // Human-readable copy for a failed run. The raw error (an engine or
    // pipeline string) is for diagnosis, not the feed — say what happened
    // and what happens next instead.
    _friendlyError(error) {
        const e = String(error || '');
        let reason;
        if (/empty response/i.test(e)) reason = 'The model came up empty this time.';
        else if (/model unavailable|no model/i.test(e)) reason = 'No AI model was ready to run it.';
        else reason = 'This run didn’t finish.';
        // A transient failure keeps riding the engine's backoff ladder after
        // this card posts, so its promise is broader. Rendered live from the
        // stored raw error, so a card written before the ladder existed says
        // the right thing too.
        const next = this._isTransient(e)
            ? 'It will keep retrying on its own'
            : 'It will try again at its next scheduled time';
        return `${reason} ${next} — or run it now from the Routines page.`;
    },

    // A model id can be a full GGUF path on llama.cpp — show just the model
    // name, the path is noise on a feed card. nenva Cloud ids get their
    // catalog label via the same helper Settings and the model chip use —
    // no other surface shows a raw model id for that engine.
    _displayModel(model) {
        if (!model) return '';
        if (/^anjadhe-cloud/.test(model)) {
            try { return AgentService.anjadheEntryLabel(model); } catch { return 'nenva Cloud'; }
        }
        return String(model).split('/').pop().replace(/\.gguf$/i, '');
    },

    // "2026-07-29" → { label: "Jul 29", overdue } (local time; a bare
    // YYYY-MM-DD parsed via Date() would land on UTC midnight and shift a
    // day). Non-date strings pass through as-is.
    _dueChip(due) {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(due));
        if (!m) return { label: String(due), overdue: false };
        const d = new Date(+m[1], +m[2] - 1, +m[3]);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return {
            label: d.toLocaleDateString([], { month: 'short', day: 'numeric' }),
            overdue: d < today
        };
    },

    /* ---------- Full-page post (social-media style detail view) ---------- */

    _ensureOverlay() {
        if (this._overlay) return this._overlay;
        const ov = document.createElement('div');
        ov.className = 'feed-post-overlay';
        ov.hidden = true;
        ov.innerHTML = `
            <div class="feed-post-bar">
                <button class="feed-post-back" type="button">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"
                         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
                    <span>Feed</span>
                </button>
                <span class="feed-post-bar-title"></span>
            </div>
            <article class="feed-post-main">
                <header class="feed-post-header">
                    <div class="feed-post-eyebrow">
                        <span class="feed-post-tile" aria-hidden="true"></span>
                        <span class="feed-post-kind"></span>
                        <span class="feed-post-source" hidden></span>
                    </div>
                    <h1 class="feed-post-title"></h1>
                    <div class="feed-post-meta">
                        <span class="feed-post-time"></span>
                        <button class="feed-post-prompt-toggle" type="button" hidden
                                aria-expanded="false">What I asked for</button>
                        <button class="feed-post-prompt-link" type="button" hidden
                                title="Open the routine behind this result, here">The routine</button>
                    </div>
                    <blockquote class="feed-post-prompt" hidden></blockquote>
                </header>
                <div class="feed-post-body feed-card-body"></div>
                <!-- Change the routine from where its output is read
                     (docs/ROUTINES_UX.md P4): the feedback a user has about
                     a routine arrives while they are reading it, not while
                     they are on a settings page. Same builder as the
                     routine detail's pills — one place decides which
                     changes are worth offering. -->
                <div class="feed-post-tune" hidden></div>
            </article>
            <!-- The routine's own page, over the post it wrote (P4/held
                 item). PromptsApp renders its ONE detail into this host;
                 nothing here knows what a routine detail looks like. -->
            <section class="feed-post-routine" hidden aria-label="The routine behind this">
                <div class="feed-post-routine-bar">
                    <span class="feed-post-routine-label">The routine</span>
                    <button class="feed-post-routine-close" type="button" aria-label="Back to the result">Back to the result</button>
                </div>
                <div class="feed-post-routine-host"></div>
            </section>
            <button class="feed-post-discuss" type="button" title="Start a chat about this result">
                <span class="feed-post-discuss-icon">&#x2728;</span>
                <span class="feed-post-discuss-label">Ask about this result</span>
            </button>`;
        ov.querySelector('.feed-post-back').addEventListener('click', () => this.closePost());
        // "What I asked for" — the instruction that produced this result,
        // folded away by default. Reading the output usually comes first;
        // the question behind it is what you reach for when the output
        // surprises you.
        ov.querySelector('.feed-post-prompt-toggle').addEventListener('click', (e) => {
            const quote = ov.querySelector('.feed-post-prompt');
            const open = quote.hidden;
            quote.hidden = !open;
            e.currentTarget.setAttribute('aria-expanded', String(open));
        });
        ov.querySelector('.feed-post-discuss').addEventListener('click', () => {
            if (ov._itemId) this.discussInAssistant(ov._itemId);
        });
        ov.querySelector('.feed-post-tune').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-ask]');
            if (!btn || typeof AgentUI === 'undefined' || !AgentUI.askWithPrompt) return;
            // Leave the reading surface first: the answer arrives in the
            // assistant, and a chat behind a full-screen post is a reply
            // nobody sees.
            this.closePost();
            AgentUI.askWithPrompt(btn.dataset.ask, { newChat: true });
        });
        // A feed post is a note generated BY a prompt note — the meta line
        // links back to that routine's detail on the Routines page (which
        // lists this and its other runs).
        // It used to close the post and jump to another app — the seam the
        // held item was really about. The routine now opens HERE.
        ov.querySelector('.feed-post-prompt-link').addEventListener('click', () => {
            const pid = ov._promptId;
            if (!pid || typeof PromptsApp === 'undefined') return;
            this.openRoutinePanel(pid);
        });
        ov.querySelector('.feed-post-routine-close').addEventListener('click', () => this.closeRoutinePanel());
        // The panel can also close itself: deleting the routine from inside
        // it leaves nothing to show, and PromptsApp says so.
        document.addEventListener('anjadhe:routine-embed-closed', () => this.closeRoutinePanel({ detached: true }));
        // The bar's title fades in once the real heading has scrolled away,
        // so the bar stays quiet while you can still see the h1.
        ov.addEventListener('scroll', () => {
            ov.classList.toggle('is-scrolled', ov.scrollTop > 56);
        }, { passive: true });
        document.body.appendChild(ov);
        // Select-a-word → "Define" lookup while reading a post — the same pill
        // and popover the Notes editor uses. The body element persists across
        // posts, so attaching once here covers every post opened later.
        if (typeof WordLookup !== 'undefined') {
            WordLookup.attachSelectionTrigger(ov.querySelector('.feed-post-body'));
        }
        this._overlay = ov;
        return ov;
    },

    // Bound once (PromptFeed is a singleton) so it can be added/removed by
    // reference. Escape closes the open post.
    _onKey(e) {
        if (e.key !== 'Escape') return;
        // Innermost first: the routine opened OVER the post, so Escape puts
        // the post back before it closes the post (the Email AI Esc ladder,
        // applied to the one place that had a child surface and no rung).
        if (PromptFeed.isRoutinePanelOpen()) PromptFeed.closeRoutinePanel();
        else PromptFeed.closePost();
    },

    /**
     * `back` names where the reader came from. The overlay is body-level and
     * fixed, so a post opens over any page — the Simple home's routine rows
     * open one, and "Feed" there would name a surface that shell does not
     * have. Default unchanged for every existing caller.
     */
    openPost(id, { back = 'Feed' } = {}) {
        const it = this._item(id);
        if (!it) return;
        // Reading a prompt post consumes its unread state (error posts have
        // no open path, published posts use the dismiss model instead).
        if (!it.published && !it.error) this._markNoteRead(id);
        const ov = this._ensureOverlay();
        ov._itemId = id;
        ov.querySelector('.feed-post-back span').textContent = back;
        // Nothing to discuss on an errored run.
        const discuss = ov.querySelector('.feed-post-discuss');
        if (discuss) discuss.hidden = !!it.error;
        // "From nenva" earns its line; "From your feed" did not — you
        // arrived from the feed, so it was labelling the room you were
        // standing in.
        const source = ov.querySelector('.feed-post-source');
        source.hidden = true;
        // The eyebrow: a tile in the routine's hue and what kind of thing
        // wrote this (the same marks the feed series carry).
        const kind = this._kindOf(it);
        ov.style.setProperty('--rt-hue', it.published ? '#9CA3AF' : this.routineHue(it.promptId || it.promptTitle));
        ov.dataset.rtKind = kind;
        ov.querySelector('.feed-post-tile').innerHTML = this.kindIcon(kind, 16);
        ov.querySelector('.feed-post-kind').textContent = this.KIND_LABELS[kind] || 'Routine';
        const title = it.promptTitle || 'Prompt';
        ov.querySelector('.feed-post-title').textContent = title;
        ov.querySelector('.feed-post-bar-title').textContent = title;
        const when = this._timeAgo(it.createdAt);
        const modelName = this._displayModel(it.model);
        ov.querySelector('.feed-post-time').innerHTML =
            `${UIUtils.escapeHtml(when)}${modelName ? ' &middot; ' + UIUtils.escapeHtml(modelName) : ''}`;

        // Link back to the prompt note that generated this post (feed posts
        // ARE notes; the prompt is a sibling note). Hidden for published
        // posts and orphaned runs whose prompt was deleted.
        const promptLink = ov.querySelector('.feed-post-prompt-link');
        const promptNote = (it.promptId && typeof NotePrompts !== 'undefined')
            ? NotePrompts.list().find(p => p.id === it.promptId)
            : null;
        ov._promptId = promptNote ? promptNote.id : null;
        // The link used to read "Prompt: Morning News" directly under a
        // heading that already said Morning News. It names the action now,
        // and the instruction itself sits behind the toggle beside it.
        const promptToggle = ov.querySelector('.feed-post-prompt-toggle');
        const promptQuote = ov.querySelector('.feed-post-prompt');
        promptQuote.hidden = true;
        promptToggle.setAttribute('aria-expanded', 'false');
        const instruction = (promptNote && typeof NotePrompts !== 'undefined')
            ? NotePrompts.bodyText(promptNote).trim() : '';
        promptToggle.hidden = !instruction;
        promptQuote.textContent = instruction;
        if (promptLink) promptLink.hidden = !promptNote;

        // The tuning pills, from the ONE builder the routine detail uses —
        // a second list here would drift from it within a month. Hidden for
        // a published post or an orphaned run: there is no routine to tune.
        this.closeRoutinePanel();
        const tune = ov.querySelector('.feed-post-tune');
        if (tune) {
            let html = '';
            if (promptNote && typeof PromptsApp !== 'undefined' && PromptsApp._askPillsHtml) {
                const cfg = NotePrompts.config(promptNote);
                const streak = (typeof RoutineEngine !== 'undefined' && RoutineEngine.quietStreak)
                    ? RoutineEngine.quietStreak(promptNote.id, it.createdAt) : 0;
                html = PromptsApp._askPillsHtml(promptNote, cfg, streak);
            }
            tune.innerHTML = html ? `<span class="feed-post-tune-label">Change this routine</span>${html}` : '';
            tune.hidden = !html;
        }

        const body = ov.querySelector('.feed-post-body');
        body.innerHTML = it.error
            ? `<div class="feed-card-skipnote">${UIUtils.escapeHtml(this._friendlyError(it.error))}</div>`
            : it.html;
        // Posts routinely open with their own title ("Morning News —
        // July 30"), which the <h1> two lines above already says. Drop the
        // repeat here the same way _summaryFor does for the digest.
        if (!it.error) this._stripLeadingTitle(body, title);
        ov.scrollTop = 0;
        ov.classList.remove('is-scrolled');
        ov.hidden = false;
        document.addEventListener('keydown', this._onKey);
        // Move focus into the overlay (not onto the Back button — that
        // painted a focus ring on every open) so Escape and tabbing land
        // in the post.
        ov.setAttribute('tabindex', '-1');
        ov.focus({ preventScroll: true });
    },

    /** Open the routine behind this post, over the post (the held item's
     *  cheap half). PromptsApp owns what is rendered; this owns where. */
    openRoutinePanel(promptId) {
        const ov = this._ensureOverlay();
        const panel = ov.querySelector('.feed-post-routine');
        const host = ov.querySelector('.feed-post-routine-host');
        if (!panel || !host) return;
        if (!PromptsApp.embedDetail(host, promptId)) return;
        panel.hidden = false;
        ov.classList.add('is-routine-open');
        // The post's own bar is STICKY, so scrolling the panel to the top of
        // the overlay parked it UNDER that bar — 48 of the panel bar's 52px,
        // which is the whole "The routine · Back to the result" row. What
        // was left read as a page the app had navigated to, with no visible
        // way back (2026-09-18). `--feed-post-bar-h` is what the CSS uses to
        // land the scroll below the bar and to pin the way back there; it is
        // declared in core.css and the bar is held to it, so this only
        // REFINES it — and only when layout is live, since an occluded
        // window measures every box as 0.
        const barH = ov.querySelector('.feed-post-bar')?.offsetHeight || 0;
        if (barH > 0) ov.style.setProperty('--feed-post-bar-h', barH + 'px');
        panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
    },

    /** Is the routine open over the post? (Escape closes the innermost
     *  thing first — the panel is a child of the post, not a peer.) */
    isRoutinePanelOpen() {
        return !!(this._overlay && this._overlay.classList.contains('is-routine-open'));
    },

    closeRoutinePanel(opts = {}) {
        const ov = this._overlay;
        if (!ov) return;
        const panel = ov.querySelector('.feed-post-routine');
        if (panel) { panel.hidden = true; panel.querySelector('.feed-post-routine-host').innerHTML = ''; }
        ov.classList.remove('is-routine-open');
        // `detached` means PromptsApp let go first (a delete) — calling back
        // into it would fight its own repaint.
        if (!opts.detached && typeof PromptsApp !== 'undefined') PromptsApp.detachDetail();
    },

    closePost() {
        if (this._overlay) this._overlay.hidden = true;
        this.closeRoutinePanel();
        document.removeEventListener('keydown', this._onKey);
        if (typeof WordLookup !== 'undefined') WordLookup.dismiss();
    },

    // "Discuss with Assistant" on a post: open a fresh chat whose system
    // context carries the prompt + generated result (the conv.extraContext
    // channel, same as record chats), so follow-up questions land on a model
    // that has actually read what the user is looking at.
    discussInAssistant(id) {
        const it = this._item(id);
        if (!it || typeof AgentService === 'undefined') return;
        this.closePost();
        const title = it.promptTitle || 'Prompt result';

        // Enter the assistant FIRST — its entry logic may reuse or mint the
        // active conversation — then seed whatever conversation settled as
        // active. Seeding before entry raced that logic.
        AppManager.openApp('agent');
        const conv = AgentService.openFreshConversation?.()
            || AgentService.conversations.find(c => c.id === AgentService.activeConversationId);
        if (!conv) return;

        conv.title = `Re: ${title}`;
        // The note stores rendered HTML — hand the model plain text
        // (NotePrompts.bodyText flattens block boundaries to newlines).
        const plain = (typeof NotePrompts !== 'undefined')
            ? NotePrompts.bodyText({ content: it.html })
            : String(it.html || '');
        conv.extraContext =
            `This conversation is about a scheduled-prompt result the user just read in their feed. ` +
            `Prompt: "${title}". Generated ${it.createdAt}${it.model ? ` by ${it.model}` : ''}.\n\n` +
            `THE RESULT (answer follow-up questions about this content):\n${plain.slice(0, 6000)}`;
        // A visible anchor in the thread — the user sees the chat is about
        // this post, and the model sees the same commitment in its history.
        conv.messages.push({
            role: 'assistant',
            content: `Let’s discuss **${title}** from your feed — I have the full result in my context. What would you like to know?`,
            metadata: {}
        });
        // renderMessages reads the load-time snapshot (AgentService
        // .conversation), not conv.messages — refresh the mirror or the
        // anchor won't paint.
        if (AgentService.activeConversationId === conv.id) {
            AgentService.conversation = [...conv.messages];
        }
        AgentService._saveConversations?.();
        if (typeof AgentUI !== 'undefined') {
            AgentUI.renderMessages?.();
            AgentUI.renderHistorySidebar?.();
        }
    },

    deleteItem(id) {
        // Published posts aren't notes — dismissing hides them (synced).
        if (String(id).startsWith('pub-')) {
            this._dismissPublished(id);
            this.render();
            return;
        }
        if (typeof NotePrompts !== 'undefined') NotePrompts.remove(id);
        this._refreshNotesApp();
        this.render();
    },

    clearAll() {
        if (!confirm('Clear all feed entries? This deletes the generated posts (their notes) but not the prompts themselves.')) return;
        if (typeof NotePrompts !== 'undefined') {
            // Removal needs tombstones: notes merge per record on write, so
            // an untombstoned delete just unions the posts right back in.
            const all = NotePrompts._readNotes();
            const now = new Date().toISOString();
            const tombstones = {};
            for (const n of all) {
                if (this._isFeedNote(n)) tombstones[n.id] = now;
            }
            NotePrompts._writeNotes(
                all.filter(n => !this._isFeedNote(n)), tombstones);
        }
        this._refreshNotesApp();
        this.render();
    },

    _timeAgo(iso) {
        const t = new Date(iso).getTime();
        if (!t) return '';
        const s = Math.max(0, Math.round((Date.now() - t) / 1000));
        if (s < 60) return 'just now';
        const m = Math.round(s / 60);
        if (m < 60) return `${m}m ago`;
        const h = Math.round(m / 60);
        if (h < 24) return `${h}h ago`;
        const d = Math.round(h / 24);
        return d === 1 ? 'yesterday' : `${d}d ago`;
    },

    // Model markdown → note HTML, done ONCE when a run is saved as a feed
    // note (and when legacy items migrate) — renders read the stored HTML.
    // Uses the SAME sanitizing markdown formatter the AI Assistant uses
    // (AgentUI.formatContent) so numbered/nested lists, tables, headers and
    // inline formatting render properly, and so feed notes match
    // assistant-written notes. The block elements it emits are styled by
    // the .feed-card-body rules in core.css and the Notes viewer alike.
    // Falls back to a minimal inline-escape if AgentUI hasn't loaded yet
    // (it loads after this module in index.html, but runs only happen after
    // startup, so the global is available in practice).
    _format(text) {
        if (!text) return '';
        if (typeof AgentUI !== 'undefined' && typeof AgentUI.formatContent === 'function') {
            return AgentUI.formatContent(text);
        }
        return `<p>${UIUtils.escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = PromptFeed;
