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
    _published: null,   // posts published by Anjadhe (remote-config feedPosts)

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

    // The card is visibility, not the settlement (2026-08-19): after it
    // posts, the item KEEPS riding the queue on the engine's backoff ladder
    // (15m → 30m → hourly) until the brain answers or this many total
    // attempts are spent — a batch of "This run didn't finish" cards from
    // one server outage used to consume every fire until the next scheduled
    // day. 10 attempts ≈ 6 hours of cover; a longer outage falls back to
    // the next scheduled time, which is what the card promises.
    REDO_MAX: 10,

    init() {
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
            if (!href || !/^https?:/i.test(href)) return;
            e.preventDefault();
            // Capture the open post BEFORE openApp('browse') closes it.
            const ov = this._overlay;
            const postId = (ov && !ov.hidden) ? ov._itemId : null;
            if (typeof AppManager !== 'undefined' && AppManager.openInBrowse) {
                AppManager.openInBrowse(href, {
                    label: 'Back to Feed',
                    onBack: () => {
                        AppManager.showDashboard();
                        if (postId) setTimeout(() => this.openPost(postId), 60);
                    }
                });
            } else if (window.electronAuth?.openExternal) {
                window.electronAuth.openExternal(href);
            } else {
                window.open(href, '_blank');
            }
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
            else if (note && !note.feed.error) UIUtils.showToast('Added to Feed', 'success');
            else UIUtils.showToast(note?.feed?.error || 'Run failed', 'error');
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
     * What actually fired, folded into the prompt the model sees. Returns a
     * shallow clone rather than changing three generate() signatures — the
     * stored note is never touched.
     */
    _withContext(prompt, context) {
        const suffix = context && context.suffix;
        if (!suffix) return prompt;
        const esc = (s) => String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return { ...prompt, content: `${prompt.content || ''}<p>${esc(suffix)}</p>` };
    },

    /**
     * A digest routine can carry a Writing Voice (cfg.voiceId): its style
     * block rides the prompt itself, so all three generate paths (plain,
     * web, assistant) speak it without depending on the model choosing to
     * fetch a kit. Degrades silently to the assistant's own voice when the
     * flag is off or the voice is gone/unstudied — a routine must keep
     * running after its voice is deleted.
     */
    _withVoice(prompt, cfg) {
        if (!cfg || cfg.runMode === 'task' || !cfg.voiceId) return prompt;
        if (typeof VoiceStore === 'undefined') return prompt;
        let block = '';
        try { block = VoiceStore.promptBlock(cfg.voiceId); } catch { /* degrade */ }
        if (!block) return prompt;
        const esc = (s) => String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        // Paragraph-per-blank-line so bodyText() flattens it back with the
        // structure intact (it inserts \n at block boundaries).
        const html = block.split('\n\n')
            .map(par => `<p>${esc(par).replace(/\n/g, '<br>')}</p>`).join('');
        return { ...prompt, content: `${prompt.content || ''}${html}` };
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
        const goal = context && context.suffix ? `${base}\n\n${context.suffix}` : base;
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
            const pctx = this._withVoice(this._withContext(prompt, context), cfg);
            const generate = () => cfg.useContext
                ? this._generateWithAssistant(pctx, model)
                : cfg.web
                    ? this._generateWithWeb(pctx, model)
                    : this._generatePlain(pctx, model);
            let out = await generate();
            // An empty response with no error is almost always transient (a
            // thinking model burning its token cap, a truncated stream) —
            // retry once before posting an error card to the feed.
            if (!out.error && !String(out.content || '').trim()) {
                out = await generate();
            }
            content = out.content;
            error = out.error;
            if (out.model) model = out.model;
            if (!error && !content) error = 'Model returned an empty response';
        } catch (e) {
            error = e?.message || 'Run failed';
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
        this.render();
        return note;
    },

    // A failure worth retrying is one where the MODEL never really answered:
    // the server was unreachable or mid-restart, the stream died, or the
    // completion came back empty (a thinking model burning its cap). A
    // deliberate answer, a config problem ("Local model unavailable") or a
    // tool-loop overrun is final — retrying it re-buys the same failure.
    // "rate limit" / "too many concurrent" are Anjadhe Connect's 429 bodies
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
        const res = await AgentService.runHeadless(NotePrompts.bodyText(prompt), {
            contextMode: 'full',
            readOnly: true,
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
                schedule: NotePrompts.scheduleLabel(NotePrompts.config(prompt))
            }
        });
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
            messages: [
                { role: 'system', content: `You are running the user's routine unattended (runs ${NotePrompts.scheduleLabel(NotePrompts.config(prompt))}); the result is posted to their feed to read later. No one is present to reply — never ask questions or offer follow-ups. Respond directly and concisely with a self-contained answer.` },
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
        const toolDefs = ['web_search', 'get_news']
            .map(n => defs.find(d => d?.function?.name === n))
            .filter(Boolean);
        const toolNames = new Set(toolDefs.map(d => d.function.name));
        if (!toolNames.has('web_search') || typeof AgentTools.execute !== 'function') {
            // Tooling unavailable — degrade to a plain run rather than fail.
            return this._generatePlain(prompt, model);
        }

        const messages = [
            { role: 'system', content: `You are a research assistant running the user's routine unattended (runs ${NotePrompts.scheduleLabel(NotePrompts.config(prompt))}); the result is posted to their feed to read later. Use the get_news tool for the headlines of the topics the user follows in their News app; use the web_search tool when other current or external information would improve the answer; otherwise answer directly. After searching, synthesize a clear, self-contained answer in markdown and cite source URLs inline. Do not ask the user questions or offer follow-ups — no one is present to reply.` },
            { role: 'user', content: NotePrompts.bodyText(prompt) }
        ];

        const MAX_ITERS = 4;
        let lastModel = null;
        for (let i = 0; i < MAX_ITERS; i++) {
            // On the final allowed iteration, drop tools so the model is
            // forced to produce a textual answer instead of another call.
            const allowTools = i < MAX_ITERS - 1;
            const res = await LLMLogger.call('prompt-feed', {
                model,
                messages,
                tools: allowTools ? toolDefs : undefined,
                options: { temperature: 0.4 }
            });
            if (res?.error) return { content: '', error: String(res.error), model: lastModel };
            if (res?.model) lastModel = res.model;

            const msg = res?.message || {};
            const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
            if (!calls.length || !allowTools) {
                return { content: (msg.content || '').trim(), error: null, model: lastModel };
            }

            // Echo the assistant turn (with its tool_calls) then append a
            // role:'tool' result per call — the message shape the engine's
            // chat template expects, mirroring AgentService's loop.
            messages.push(msg);
            for (const tc of calls) {
                const name = toolNames.has(tc?.function?.name) ? tc.function.name : 'web_search';
                let args = tc?.function?.arguments;
                if (typeof args === 'string') {
                    try { args = JSON.parse(args); } catch { args = {}; }
                }
                if (name === 'web_search' && args && args.maxResults == null) args.maxResults = 5;
                let result;
                try {
                    result = await AgentTools.execute(name, args || {});
                } catch (e) {
                    result = { error: e?.message || name + ' failed' };
                }
                messages.push({ role: 'tool', content: JSON.stringify(result).slice(0, 6000) });
            }
        }
        return { content: '', error: 'Stopped after too many tool calls without an answer', model: lastModel };
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
     * Messages Anjadhe publishes for users — release notes, tips — ride the
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
        if (it.published) return 'published';
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
    _scopedItems(unreadOnly = this.prefs().hideRead) {
        let cards = this._feedNotes().map(n => this._cardModel(n));
        // Read prompt posts leave the feed while the toggle says Unread —
        // error cards are exempt (they can't be opened, so they can never
        // be read; only × removes them).
        if (unreadOnly) cards = cards.filter(c => !c.read);
        return [...this._publishedModels(), ...cards]
            .sort((a, b) =>
                new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    },

    /**
     * Group the feed into series: one per routine, plus one for
     * posts published by Anjadhe. Newest edition first within a series;
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
        const items = this._scopedItems(unreadOnly);
        const everything = unreadOnly ? this._scopedItems(false) : items;

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
                        ? 'Routines will appear here after their next run.'
                        : 'Create a routine in <strong>Manage routines</strong> — a prompt that runs on a schedule. Its results land here automatically.'}</p>`;
            }
            list.innerHTML = `<div class="empty-state">${html}</div>`;
            return;
        }

        // No global "show everything" control: each series folds on its own,
        // and one button that dumps every edition back onto the page undoes
        // the point of a digest.
        list.innerHTML = series.map(sc => this._renderSeries(sc)).join('');
        this._wireList(list);
    },

    /**
     * One series: the newest edition described in place, everything older
     * folded behind a disclosure. The block IS the navigation — which is
     * why there is no source nav any more.
     */
    _renderSeries(sc) {
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

        return `
        <article class="feed-series${sc.published ? ' feed-series--published' : ''}${unread ? ' is-unread' : ''}">
            <header class="feed-series-head" data-feed-open="${esc(it.id)}" role="button" tabindex="0">
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
    // name, the path is noise on a feed card. Anjadhe Cloud's id gets the
    // product label, the same mapping Settings and the model chip use —
    // no other surface shows a raw model id for that engine.
    _displayModel(model) {
        if (!model) return '';
        if (model === 'anjadhe-cloud') return 'Anjadhe Cloud';
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
                    <span class="feed-post-source" hidden></span>
                    <h1 class="feed-post-title"></h1>
                    <div class="feed-post-meta">
                        <span class="feed-post-time"></span>
                        <button class="feed-post-prompt-toggle" type="button" hidden
                                aria-expanded="false">What I asked for</button>
                        <button class="feed-post-prompt-link" type="button" hidden
                                title="Open this routine on the Routines page">Edit routine</button>
                    </div>
                    <blockquote class="feed-post-prompt" hidden></blockquote>
                </header>
                <div class="feed-post-body feed-card-body"></div>
            </article>
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
        // A feed post is a note generated BY a prompt note — the meta line
        // links back to that routine's detail on the Routines page (which
        // lists this and its other runs).
        ov.querySelector('.feed-post-prompt-link').addEventListener('click', () => {
            const pid = ov._promptId;
            if (!pid) return;
            this.closePost();
            if (typeof PromptsApp !== 'undefined') PromptsApp.open({ id: pid });
        });
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
        if (e.key === 'Escape') PromptFeed.closePost();
    },

    openPost(id) {
        const it = this._item(id);
        if (!it) return;
        // Reading a prompt post consumes its unread state (error posts have
        // no open path, published posts use the dismiss model instead).
        if (!it.published && !it.error) this._markNoteRead(id);
        const ov = this._ensureOverlay();
        ov._itemId = id;
        // Nothing to discuss on an errored run.
        const discuss = ov.querySelector('.feed-post-discuss');
        if (discuss) discuss.hidden = !!it.error;
        // "From Anjadhe" earns its line; "From your feed" did not — you
        // arrived from the feed, so it was labelling the room you were
        // standing in.
        const source = ov.querySelector('.feed-post-source');
        source.hidden = !it.published;
        source.textContent = 'From Anjadhe';
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

    closePost() {
        if (this._overlay) this._overlay.hidden = true;
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
