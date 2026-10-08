/**
 * Routines App — ONE routine's detail page (app id `prompts`).
 *
 * A routine is a Standing conversation since 2026-10-07 (its definition
 * on `conv.standing`, its results as messages in it), read and written
 * through the NotePrompts facade — so sync, the assistant's routine tools
 * and the PromptFeed runner keep working untouched. This file is UI only.
 * A result row here opens the routine's chat at that message.
 */

/*
 * Folded into Chats (2026-10-06, the simplification, docs/VISION.md): there
 * is no Routines page, list or form any more. A routine is a STANDING chat:
 * the Chats page lists every routine with its trigger and last run
 * (SimpleExperience.renderHistory), this file keeps ONE routine's detail
 * (run history, Run now, Test trigger, the waiting approvals, Delete), and
 * every change to a routine is a conversation: Edit opens the routine's chat
 * (update_routine's diff dialog is the confirmation), "Set up a routine"
 * opens the interview (start_routine_interview → create_routine, whose ask
 * shows a dry run first, so nothing is armed untried).
 */
const PromptsApp = {
    _view: 'detail',    // the detail is the only view left
    _openId: null,
    _bound: false,

    init() {
        this._bound = true;
    },

    /** External entry: a routine's detail; with no id, the Chats page (where the routines are listed); `create` is the interview. */
    open(opts = {}) {
        if (opts.create) { this.askNewRoutine(); return; }
        if (!opts.id || !this._note(opts.id)) { this.toChats(); return; }
        this._view = 'detail'; this._openId = opts.id;
        AppManager.openApp('prompts');
        this.render();
    },

    /** The way back: the Chats page, Standing section. */
    toChats() {
        this._openId = null;
        if (typeof SimpleExperience !== 'undefined' && SimpleExperience.showHistoryTab) SimpleExperience.showHistoryTab('standing');
        if (typeof AppManager !== 'undefined') AppManager.openAppFromLauncher('conversations');
    },

    /** Change a routine in its chat (2026-10-06): update_routine's diff dialog is the confirmation. */
    askChange(id) {
        const note = this._note(id);
        if (!note || typeof AgentUI === 'undefined' || !AgentUI.askWithPrompt) return;
        AgentUI.askWithPrompt(`I want to change my routine "${note.title || 'Untitled routine'}". Ask me what should be different, then make the change.`,
            { newChat: true, todayKey: `routine:${id}`, recordKey: `prompts:${id}`, recordLabel: note.title || 'Untitled routine' });
    },

    /**
     * The "Help me set up a routine" prompt pill — opens the assistant's
     * routine interview (start_routine_interview; the goals pattern). The
     * pill's wording contains "routine" on purpose: that word is what ships
     * the prompts tool group into the turn.
     */
    askNewRoutine() {
        if (typeof AgentUI === 'undefined' || !AgentUI.askWithPrompt) return;
        AgentUI.askWithPrompt(
            'Help me set up a routine — something nenva does for me on its own. ' +
            'Walk me through it one question at a time: what it should do, when it should run, ' +
            'and whether it writes me an answer or takes actions.',
            { newChat: true }
        );
    },

    // --- Data (all reads go through the notes blob — storage source of truth) ---

    _prompts() {
        const list = NotePrompts.list();
        return list.sort((a, b) =>
            new Date(b.modifiedAt || 0).getTime() - new Date(a.modifiedAt || 0).getTime());
    },

    _note(id) {
        return NotePrompts.list().find(n => n.id === id) || null;
    },

    /** This routine's runs (NotePrompts.runCard), newest first. */
    _outputs(promptId) {
        return NotePrompts.runs(promptId);
    },

    /** R4 observability: everything the engine knows about one routine. */
    _status(id) {
        return (typeof RoutineEngine !== 'undefined')
            ? RoutineEngine.statusFor(id)
            : { lastCheckedAt: null, lastMatchedAt: null, lastRun: null, lastError: null, queued: 0 };
    },

    _ago(iso) {
        return (iso && typeof PromptFeed !== 'undefined') ? PromptFeed._timeAgo(iso) : null;
    },

    /** "12 min" while this routine's digest run is in flight, else null. */
    _runningNow(id) {
        const cur = (typeof PromptFeed !== 'undefined') ? PromptFeed._current : null;
        if (!cur || cur.promptId !== id) return null;
        const mins = Math.round((Date.now() - cur.startedAt) / 60000);
        return mins < 1 ? 'under a minute' : `${mins} min`;
    },

    _lastRunLabel(p) {
        const last = this._status(p.id).lastRun;
        return last ? `ran ${this._ago(last)}` : 'not run yet';
    },

    _chips(cfg) {
        return [
            cfg.offline
                ? `<span class="prompt-mgr-chip">${UIUtils.escapeHtml(NotePrompts.scheduleLabel(cfg))}</span>`
                : `<span class="prompt-mgr-chip">${cfg.target === 'browser' ? 'runs as web search' : 'runs in Assistant'}</span>`,
            cfg.web ? '<span class="prompt-mgr-chip">&#127760; web</span>' : '',
            cfg.useContext ? '<span class="prompt-mgr-chip">&#10024; my context</span>' : ''
        ].filter(Boolean).join('');
    },

    // --- Render ---

    openPrompt(id) {
        this._view = 'detail';
        this._openId = id;
        this.render();
    },

    render() {
        const container = document.getElementById('prompts-main');
        if (!container) return;
        // The open routine may have been deleted (or synced away): there is
        // no list here any more, the Chats page is where routines live.
        if (!this._openId || !this._note(this._openId)) {
            if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'prompts') this.toChats();
            return;
        }
        this._view = 'detail';
        this._renderCrumbs();
        this._renderWaiting();
        this._renderDetail(container, this._note(this._openId));
    },

    /**
     * The page title, through Breadcrumb like every other app page. It used
     * to be a bare text node in index.html, which meant it missed the
     * `.breadcrumb-current` styling every other title gets (600 weight, and
     * the padding that puts the first glyph on the shared left edge) — so
     * this one page's heading sat lighter and 8px to the left of Actions,
     * Notes and the rest. The trail also names where you are inside the app,
     * which is what the detail and form states were missing.
     */
    _renderCrumbs() {
        if (typeof Breadcrumb === 'undefined') return;
        const note = this._openId ? this._note(this._openId) : null;
        Breadcrumb.render('prompts-breadcrumb', [
            { label: 'Chats', action: () => this.toChats() },
            { label: note ? (note.title || 'Untitled routine') : 'Routine' }
        ]);
    },

    /**
     * C10: "Waiting on you" — task-mode runs that stopped at an approval
     * while nobody was here. It sits ABOVE the routines list on every view of
     * this page, because it is the only thing here that is blocked on the
     * user; everything else is either running or idle.
     *
     * Answering here is the human decision a waiting routine job needs (TeamJobs J2); it marks the run
     * attended and its next `ask` opens the normal dialog instead of pausing
     * again.
     */
    _renderWaiting() {
        const section = document.getElementById('prompts-waiting-section');
        const box = document.getElementById('prompts-waiting');
        if (!section || !box) return;
        if (typeof TeamJobs === 'undefined') {
            section.hidden = true;
            return;
        }
        // A routine's team job waiting on an answer, or paused (2026-10-02).
        // This routine's only (2026-10-07): the list it once sat above is
        // gone, and another routine's ask on this page reads as this one's.
        const waiting = TeamJobs.all().filter(t => t && t.engine === 'team' && t.routineId && t.routineId === this._openId && ['awaiting_user', 'paused'].includes(t.status));
        section.hidden = waiting.length === 0;
        if (!waiting.length) return;
        const esc = UIUtils.escapeHtml;
        const countEl = document.getElementById('prompts-waiting-count');
        if (countEl) countEl.textContent = waiting.length > 0 ? String(waiting.length) : '';
        box.innerHTML = waiting.map(t => `
            <div class="routines-waiting-row" data-task="${esc(t.id)}">
                <div class="routines-waiting-main">
                    <div class="routines-waiting-title">${esc(t.note || t.status)}</div>
                </div>
                <span class="routines-waiting-actions">
                    ${t.status === 'paused'
                        ? '<button class="secondary-btn routines-act" data-act="resume" type="button">Continue</button>'
                        : '<button class="primary-btn routines-act" data-act="approve" type="button">Allow</button><button class="secondary-btn routines-act" data-act="deny" type="button">Don&rsquo;t allow</button>'}
                    <button class="secondary-btn routines-act" data-act="cancel" type="button">Stop</button>
                </span>
            </div>`).join('');
        box.onclick = async (e) => {
            const btn = e.target.closest('button[data-act]');
            if (!btn) return;
            const id = btn.closest('[data-task]')?.dataset.task;
            if (!id) return;
            const act = btn.dataset.act;
            if (act === 'resume') await TeamJobs.resume(id);
            else if (act === 'approve') TeamJobs.answer(id, true);
            else if (act === 'deny') TeamJobs.answer(id, false);
            else if (act === 'cancel') await TeamJobs.stop(id);
            this.render();
        };
    },

    _askPillsHtml(note, cfg, quietStreak) {
        if (typeof AgentUI === 'undefined' || !AgentUI.askWithPrompt) return '';
        const esc = UIUtils.escapeHtml;
        const title = note.title || 'this routine';
        const btn = (label, prompt) =>
            `<button type="button" class="ask-prompt-btn" data-ask="${esc(prompt)}">&ldquo;${esc(label)}&rdquo;</button>`;
        const ref = `the routine “${title}”`;
        const pills = [];

        if (cfg.interval !== 'weekly' && (cfg.trigger || {}).type === 'time') {
            pills.push(btn('Make it weekly', `Change ${ref} to run once a week instead.`));
        }
        pills.push(btn('Make it shorter', `Change ${ref} so its answers are much shorter — a few lines, the essentials only.`));
        // NOT "only tell me when there's something": since U3 every digest
        // already stays quiet on a run with nothing to say, and a pill
        // offering what the routine already does teaches the user it does
        // the opposite.
        if (cfg.runMode !== 'task' && !cfg.web) {
            pills.push(btn('Let it search the web',
                `Turn on web search for ${ref} so it can look things up while it runs.`));
        }
        // A routine that has been silent run after run is either working
        // perfectly on a quiet stretch or looking for something it can
        // never find, and the difference is a question about the prompt —
        // which is exactly what the streak line above says out loud.
        if (quietStreak >= this.QUIET_STREAK_HINT) {
            pills.push(btn('Why does it never find anything?',
                `${ref} has had nothing to report for its last ${quietStreak} runs. Read its prompt and tell me whether it is looking for something it can never find here, and what to change.`));
        }
        pills.push(btn('Change what it does…',
            `I want to change what ${ref} does. Ask me what should be different, then update it.`));
        return `<div class="routines-ask-row routines-detail-ask">${pills.join('')}</div>`;
    },

    /* ── Measured by whether it is read (docs/ROUTINES_UX.md U8) ─────────
       The list used to headline LAST RUN, which says a routine is alive,
       not that it is wanted. Nobody deletes a routine that quietly wastes
       a model call every morning; they just stop opening it — and the app
       has always known that and never said it.

       The app may SAY SO and OFFER to slow it down. It may never disarm a
       routine the user armed: deciding for them is the same class of
       mistake as letting a model decide a routine is safe. Declining is
       remembered (per-Mac — a nudge is a moment, and the other Mac's user
       has not been offered anything yet). ──────────────────────────────── */
    // Sorting and filtering earn their place at this many routines.
    LIST_DENSE_MIN: 20,
    RARELY_MIN_EDITIONS: 5,
    RARELY_MAX_RATIO: 0.2,
    PRUNE_DISMISS_KEY: 'routine-prune-dismissed',

    _readStats(id) {
        const r = (typeof PromptFeed !== 'undefined' && PromptFeed.readRate)
            ? PromptFeed.readRate(id) : { shown: 0, opened: 0 };
        return {
            ...r,
            rarely: r.shown >= this.RARELY_MIN_EDITIONS
                && (r.opened / r.shown) <= this.RARELY_MAX_RATIO
        };
    },

    _pruneDismissed() {
        try { return JSON.parse(localStorage.getItem(this.PRUNE_DISMISS_KEY) || '{}') || {}; }
        catch { return {}; }
    },

    _dismissPrune(id) {
        const d = this._pruneDismissed();
        d[id] = new Date().toISOString();
        try { localStorage.setItem(this.PRUNE_DISMISS_KEY, JSON.stringify(d)); } catch { /* private window */ }
    },

    // How many silent runs in a row are worth saying out loud on the
    // detail. Below this, silence is just a quiet week (U3).
    QUIET_STREAK_HINT: 5,

    _renderDetail(container, note) {
        if (!note) { this.toChats(); return; }
        const cfg = NotePrompts.config(note);
        const body = NotePrompts.bodyText(note);
        const outputs = this._outputs(note.id).slice(0, 20);
        const esc = UIUtils.escapeHtml;
        // Record links ([title](anjadhe://task/<id>)) in a run report become
        // clickable links even inside the <pre> — the log stays verbatim
        // otherwise. See RecordLinks.
        const linkify = (s) => (typeof RecordLinks !== 'undefined') ? RecordLinks.linkifyEscapedText(s) : s;

        // U3 (docs/ROUTINES_UX.md): runs that settled with nothing to say
        // post no edition, so the history has to carry them or "quiet" and
        // "never ran" look identical — which is exactly the confusion that
        // makes silence feel like breakage. Newest first, interleaved with
        // the posted editions by time.
        const quietRuns = (typeof RoutineEngine !== 'undefined' && RoutineEngine.quietRuns)
            ? RoutineEngine.quietRuns(note.id) : [];
        const quietStreak = (typeof RoutineEngine !== 'undefined' && RoutineEngine.quietStreak)
            ? RoutineEngine.quietStreak(note.id, (outputs[0] || {}).createdAt || null) : 0;
        // U8: the offer to slow it down or stop it. The app asks; the user
        // decides; declining is remembered. A routine going quiet is NOT
        // the same as one being ignored — a run with nothing to report was
        // never shown, so it cannot have been skipped, and offering to
        // delete a routine that is working perfectly on a quiet stretch is
        // the worst version of this feature.
        const stats = this._readStats(note.id);
        const offerPrune = cfg.offline && stats.rarely && !quietStreak && !this._pruneDismissed()[note.id];

        const postRows = outputs.map(o => {
            const when = o.createdAt
                ? new Date(o.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                : '';
            // The run's own first words (Markdown stripped), never a sentence about it.
            const text = o.error
                ? o.error
                : String(o.content || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`#>|]+/g, '').replace(/\s+/g, ' ').trim();
            const preview = text.length > 160 ? text.slice(0, 160).trimEnd() + '…' : text;
            return {
                at: o.createdAt || '',
                html: `
                <button class="routines-post-row${o.error ? ' is-error' : ''}" data-open-post="${o.id}" type="button">
                    <span class="routines-post-when">${when}</span>
                    <span class="routines-post-preview">${esc(preview)}</span>
                </button>`
            };
        }).concat(quietRuns.map(q => {
            const when = q.at
                ? new Date(q.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                : '';
            // Not a button: there is nothing to open. A quiet run is a
            // successful run, so it wears no error styling either.
            return {
                at: q.at || '',
                html: `
                <div class="routines-post-row is-quiet">
                    <span class="routines-post-when">${when}</span>
                    <span class="routines-post-preview">Nothing to report${q.reason ? ' &middot; ' + esc(q.reason) : ''}</span>
                </div>`
            };
        })).sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))
          .slice(0, 20).map(r => r.html).join('');

        // An action routine's runs, newest first — the execution log lives
        // HERE, on the routine, never on the home feed (2026-08-03): the
        // feed is a reading surface for content, and a step transcript is a
        // log. Each run is the task record the engine already keeps, with
        // its report, built by TeamJobs from the run's own events.
        const runs = (cfg.runMode === 'task' && typeof TeamJobs !== 'undefined')
            ? TeamJobs.all().filter(t => t && t.routineId === note.id
                && (t.status === 'done' || t.status === 'failed')).slice(0, 20)
            : [];
        const runRows = runs.map(t => {
            const when = t.updatedAt
                ? new Date(t.updatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                : '';
            const ok = t.status === 'done';
            return `
                <details class="routines-run${ok ? '' : ' is-error'}">
                    <summary class="routines-run-row">
                        <span class="routines-run-mark" aria-label="${ok ? 'Done' : 'Failed'}">${ok ? '&#10003;' : '&#10007;'}</span>
                        <span class="routines-post-when">${when}</span>
                        <span class="routines-post-preview">${esc(t.note || (ok ? 'Done.' : 'Did not finish.'))}</span>
                    </summary>
                    <pre class="routines-run-report">${linkify(esc(t.report || t.activity || 'No log was recorded for this run.'))}</pre>
                </details>`;
        }).join('');

        // What the routine draws on, as one quiet value line.
        const uses = [cfg.web ? 'Web search' : '', cfg.useContext ? 'My context' : '']
            .filter(Boolean).join(' &middot; ');
        const scheduleValue = cfg.offline
            ? esc(NotePrompts.triggerLabel(cfg))
            : (cfg.target === 'browser' ? 'runs as web search' : 'runs in Assistant');
        // C10: what this routine is allowed to DO, stated rather than implied.
        // "Can it change my data" is the question the merge made worth asking
        // on every routine, because the answer is no longer given by which
        // page you found it on.
        const modeValue = cfg.runMode === 'task'
            ? 'Takes actions &mdash; can change things, and pauses for permission'
            : 'Writes an answer &mdash; cannot change anything';
        const status = this._status(note.id);
        const lastError = status.lastError || '';
        // R4 (D4/T6): "nothing matched" and "this has been broken since the
        // day you armed it" looked identical, which is the only reason the D0
        // outage survived from C8.5 through C10. A checked stamp that is
        // absent says the engine has never evaluated this routine at all —
        // a different problem from one that evaluates and never matches.
        const checkedLabel = status.lastCheckedAt
            ? this._ago(status.lastCheckedAt)
            : 'not yet — the engine has not evaluated this routine';
        const matchedLabel = status.lastMatchedAt
            ? this._ago(status.lastMatchedAt)
            : (status.lastCheckedAt ? 'never matched anything yet' : 'never');
        // Only worth showing when it is NOT this Mac: naming the local
        // machine on every routine is noise on a single-Mac install.
        const elsewhere = cfg.homeMachineId
            && typeof RoutineEngine !== 'undefined' && RoutineEngine._machineId
            && cfg.homeMachineId !== RoutineEngine._machineId;
        // The Stop row (alpha.65) read `running` without ever defining it, so
        // every routine detail threw a ReferenceError before painting — the
        // list stayed on screen and "Edit routine" / record links seemed to
        // land on the wrong page (2026-09-09).
        const running = this._runningNow(note.id);
        const prop = (label, value) => `
            <div class="routines-prop">
                <span class="routines-prop-label">${label}</span>
                <span class="routines-prop-value">${value}</span>
            </div>`;

        // What it is ABOUT (RoutineAbout) — the records it reviews or
        // watches, as links. Built HERE, after `prop`: a const read before
        // its declaration throws, and a detail that throws paints nothing
        // at all (the alpha.65 lesson, 2026-09-09).
        //
        // A reference whose record the app cannot speak for right now is
        // NOT treated as gone (A2's tri-state) — it is named and simply not
        // struck, because a record whose app has not loaded is not a
        // deleted record.
        const aboutRefs = (typeof RoutineAbout !== 'undefined') ? RoutineAbout.resolve(cfg.about) : [];
        const aboutRow = aboutRefs.length ? prop('About', aboutRefs.map((r, i) =>
            `<button type="button" class="routines-about-link${r.exists === false ? ' is-gone' : ''}"
                     data-about="${i}"${r.exists === false ? ' disabled title="This record no longer exists"' : ''}
                ><span class="routines-about-type">${esc(r.typeLabel)}</span>${esc(r.label
                    || (r.exists === false ? 'deleted' : 'not loaded'))}${r.label && r.exists === false ? ' (deleted)' : ''}</button>`).join(' ')) : '';

        // The routine's hue is still set for anything that reads it, but
        // the Routines app shows no routine colour (2026-10-01, by request);
        // only its results on Now and the result page wear it.
        const kind = cfg.runMode === 'task' ? 'task' : 'report';
        const hue = (typeof PromptFeed !== 'undefined' && PromptFeed.routineHue) ? PromptFeed.routineHue(note.id) : '#9CA3AF';
        container.dataset.rtKind = kind;
        container.style.setProperty('--rt-hue', hue);
        // Calm pass (2026-10-07, by request: "use the new design language to
        // make the UI calmer and simpler", Finance and Documents' shape). A
        // masthead (the kind as a lede with its state as words, the serif
        // title, Run now beside a ⋯ menu that holds Edit, Test trigger, Help
        // and Delete), the facts as Settings rows on one white panel, the
        // prompt as prose, the run history as rows on one panel.
        const evented = cfg.offline && (cfg.trigger || {}).type && cfg.trigger.type !== 'time';
        const lede = [
            `${cfg.runMode === 'task' ? 'Takes actions' : 'Writes an answer'}`,
            running ? '<span class="routines-lede-live">Running</span>' : '',
            lastError ? '<span class="routines-lede-err">Needs attention</span>' : ''
        ].filter(Boolean).join('<span class="routines-lede-sep">&middot;</span>');
        const history = runRows || postRows;
        container.innerHTML = `
            <div class="routines-sheet">
            <header class="routines-masthead">
                <div class="routines-masthead-top">
                    <p class="routines-lede">${lede}</p>
                    <div class="routines-detail-actions">
                        <button class="routines-linklike routines-open-chat" data-chat type="button" title="Its results and anything you said to it">Open chat</button>
                        <button class="primary-btn routines-act routines-act-run" data-run="${note.id}" type="button" title="Run this routine now">Run now</button>
                        <button class="routines-more-btn" data-more type="button" title="More actions" aria-label="More actions" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg></button>
                    </div>
                </div>
                <h3 class="routines-detail-title">${esc(note.title || 'Untitled routine')}</h3>
            </header>
            <div class="routines-props">
                ${prop('Runs when', scheduleValue)}
                ${aboutRow}
                ${uses ? prop('Uses', uses) : ''}
                ${running ? prop('Running now', `for ${esc(running)} <button class="routines-linklike routines-stop" data-stop="${esc(note.id)}" type="button" title="Stop this run">Stop</button>`) : ''}
                ${cfg.offline ? prop('Last run', esc(this._lastRunLabel(note))) : ''}
                ${stats.shown ? prop('Read', `You opened ${stats.opened} of the last ${stats.shown}`) : ''}
                ${quietStreak >= this.QUIET_STREAK_HINT
                    ? prop('Nothing to report', `The last ${quietStreak} runs had nothing to say, so nothing was posted. If that seems wrong, check the prompt &mdash; a routine that can never find anything says this every time.`)
                    : ''}
                ${cfg.offline && !status.lastCheckedAt ? prop('Last checked', esc(checkedLabel)) : ''}
                ${evented ? prop('Last matched', esc(matchedLabel)) : ''}
                ${status.queued ? prop('Queued', `${status.queued} run${status.queued > 1 ? 's' : ''} waiting for the task slot`) : ''}
                ${elsewhere ? prop('Runs on', 'Another Mac &mdash; it is armed there, not here') : ''}
                ${lastError ? prop('Last problem', `<span class="routines-err-text">${esc(lastError)}</span>`) : ''}
            </div>
            ${offerPrune ? `
            <div class="routines-prune">
                <p class="routines-prune-text">This has run ${stats.shown} times lately and you opened ${stats.opened === 0 ? 'none of them' : `${stats.opened} of them`}. Want it less often, or not at all?</p>
                <div class="routines-prune-actions">
                    ${cfg.interval !== 'weekly' && (cfg.trigger || {}).type === 'time'
                        ? `<button class="routines-linklike" type="button" data-prune="weekly">Make it weekly</button>` : ''}
                    <button class="routines-linklike" type="button" data-prune="keep">Keep it</button>
                    <button class="routines-linklike routines-act-delete" type="button" data-prune="delete">Delete it</button>
                </div>
            </div>` : ''}
            <div class="routines-trigtest" hidden></div>
            <section class="routines-prompt-section">
                <h4 class="routines-eyebrow">Prompt</h4>
                <div class="routines-prompt-text">${esc(body) || '<span class="routines-empty">No prompt text yet &mdash; ask in its chat to add one.</span>'}</div>
            </section>
            </div>
            ${history ? `
                <section class="routines-outputs">
                    <h4 class="routines-eyebrow">Run history</h4>
                    <div class="routines-outputs-panel">${history}</div>
                </section>` : ''}
            ${!history && cfg.offline ? `<p class="routines-empty">${cfg.runMode === 'task'
                ? 'No runs yet &mdash; each run&rsquo;s log will appear here.'
                : 'No runs yet &mdash; results will appear here.'}</p>` : ''}
        `;

        container.querySelector('[data-more]')?.addEventListener('click', (e) => {
            const items = [{ action: 'edit', label: 'Edit in a chat' }];
            if (evented) items.push({ action: 'test', label: 'Test trigger' });
            items.push({ sep: true }, { action: 'delete', label: 'Delete routine&hellip;' });
            UIUtils.anchoredMenu(e.currentTarget, 'routines-more-menu', items, (act) => {
                if (act === 'edit') this._edit(note.id);
                else if (act === 'test') this._testTrigger(note, null, container);
                else if (act === 'delete') this._delete(note.id);
            });
        });
        container.querySelector('[data-chat]')?.addEventListener('click', () => this.openChat(note.id));
        container.querySelector('[data-run]')?.addEventListener('click', (e) => this._runNow(note.id, e.currentTarget));
        container.querySelector('[data-stop]')?.addEventListener('click', (e) => {
            e.currentTarget.disabled = true;
            const ok = typeof PromptFeed !== 'undefined' && PromptFeed.stopCurrent && PromptFeed.stopCurrent();
            UIUtils.showToast(ok ? 'Stopping…' : 'Nothing to stop — the run already ended', 'info');
            setTimeout(() => this.render(), 400);
        });
        container.querySelectorAll('[data-about]').forEach(btn =>
            btn.addEventListener('click', () => {
                const ref = aboutRefs[Number(btn.dataset.about)];
                if (ref && typeof RoutineAbout !== 'undefined') RoutineAbout.open(ref);
            }));
        container.querySelector('[data-prune="keep"]')?.addEventListener('click', () => {
            this._dismissPrune(note.id);
            UIUtils.showToast('Kept — I won\'t ask about this one again', 'info');
            this.render();
        });
        container.querySelector('[data-prune="delete"]')?.addEventListener('click', () => this._delete(note.id));
        container.querySelector('[data-prune="weekly"]')?.addEventListener('click', () => {
            // The one write this card makes itself: it is the user's click
            // on a named change, which is consent (the old StarterPrompts.seed
            // rule), and the alternative — routing a one-word schedule
            // change through a chat turn — is slower than the form it
            // replaces.
            const next = { ...cfg, interval: 'weekly', trigger: { type: 'time', interval: 'weekly' } };
            NotePrompts.update(note.id, { config: next });
            this._dismissPrune(note.id);
            if (typeof RoutineEngine !== 'undefined') RoutineEngine.onRoutinesChanged();
            UIUtils.showToast('Now runs weekly', 'success');
            this.render();
        });
        container.querySelectorAll('.routines-detail-ask [data-ask]').forEach(b =>
            b.addEventListener('click', () => AgentUI.askWithPrompt(b.dataset.ask, { newChat: true })));
        container.querySelectorAll('[data-open-post]').forEach(b =>
            b.addEventListener('click', () => {
                if (typeof PromptFeed !== 'undefined' && PromptFeed.openPost) PromptFeed.openPost(b.dataset.openPost);
            }));
    },

    /** The routine's own Standing chat. */
    openChat(id) {
        if (typeof SimpleExperience !== 'undefined' && SimpleExperience.openStanding) SimpleExperience.openStanding(id);
    },

    // A change is a conversation (2026-10-06): the routine's chat, where
    // update_routine's diff dialog is the confirmation.
    _edit(id) {
        this.askChange(id);
    },

    async _runNow(id, btn) {
        const note = this._note(id);
        if (!note) return;
        const cfg = NotePrompts.config(note);
        if (cfg.offline) {
            if (typeof PromptFeed === 'undefined' || !PromptFeed.runNow) return;
            if (btn) btn.disabled = true;
            await PromptFeed.runNow(id);
            this.render();
        } else {
            NotePrompts.runDefault(note);
        }
    },

    /**
     * R4 — "Test trigger". Reports what the matcher WOULD fire on, right
     * now, and stamps nothing: no run, no marker moved, no error recorded.
     * The cheapest thing in docs/ROUTINE_TRIGGERS.md's plan and the one that
     * would have caught D0 in under a minute.
     */
    async _testTrigger(note, btn, host) {
        const box = (host || document.getElementById('prompts-main'))?.querySelector('.routines-trigtest');
        if (!box) return;
        const esc = UIUtils.escapeHtml;
        if (btn) btn.disabled = true;
        box.hidden = false;
        box.innerHTML = '<span class="routines-empty">Checking…</span>';
        let r;
        try { r = await RoutineEngine.testTrigger(note); }
        catch (e) { r = { error: e?.message || 'the check could not run' }; }
        if (btn) btn.disabled = false;

        const lines = [];
        if (r.error) {
            lines.push(`<span class="routines-err-text">Cannot check: ${esc(r.error)}</span>`);
        } else if (r.fired) {
            lines.push(`<strong>Would fire now.</strong> ${esc(r.suffix || 'The schedule slot is due.')}`);
            if (r.matches && r.matches.length > 1) {
                lines.push(`${r.matches.length} things match right now: ${esc(r.matches.slice(0, 5).join('; '))}${r.matches.length > 5 ? '…' : ''}`);
            }
        } else {
            lines.push('<strong>Would not fire now.</strong> Nothing matches since its last run.');
            if (r.scanned != null) {
                // `scanned` is the candidate window, not the whole mailbox:
                // mail since this routine was armed (R1's floor), or every
                // file in the watched folder.
                lines.push(r.type === 'email'
                    ? `${r.scanned} message${r.scanned === 1 ? '' : 's'} since this routine was armed ${r.scanned === 1 ? 'was' : 'were'} there to check.`
                    : `${r.scanned} file${r.scanned === 1 ? '' : 's'} in the watched folder ${r.scanned === 1 ? 'was' : 'were'} there to check.`);
            }
        }
        if (r.otherMachine) lines.push('This routine is armed on another Mac, so this one will not run it.');
        lines.push('<span class="routines-empty">Nothing was run and nothing was recorded.</span>');
        box.innerHTML = lines.map(l => `<p class="routines-trigtest-line">${l}</p>`).join('');
    },

    async _delete(id) {
        const note = this._note(id);
        const noun = note && NotePrompts.config(note).offline ? 'routine' : 'prompt';
        const ok = await UIUtils.confirm(
            `Delete ${noun}`,
            `Delete &ldquo;${UIUtils.escapeHtml(note?.title || `this ${noun}`)}&rdquo;? This removes the ${noun}, its chat and its past results, and stops its scheduled runs.`,
            '🗑️',
            { confirmText: 'Delete' }
        );
        if (!ok) return;
        NotePrompts.remove(id);
        if (typeof PromptFeed !== 'undefined' && PromptFeed.render) PromptFeed.render();
        if (typeof RoutineEngine !== 'undefined') RoutineEngine.onRoutinesChanged();
        if (this._openId === id) this._openId = null;
        this.render();
    }
};

AppManager.register('prompts', PromptsApp);

// One builder for the CURRENT ROUTINE block, used by the page provider (the
// routine open in the detail view) and the 'prompts' record resolver (a
// conversation attached to a routine, continued away from this page) — one
// builder so "this routine" cannot drift. Routines had no provider at all
// before the Decisions feature (2026-08-06), which meant no CURRENT ROUTINE
// block and no per-record conversation reattach; the recordKey
// ('prompts:<noteId>') is also what routes a routine's saved decisions into
// the ambient context (DecisionStore.fromRecordKey).
PromptsApp.routineContextBlock = function (noteId, opts = {}) {
    if (!noteId) return null;
    const note = PromptsApp._note(noteId);
    if (!note) return null;
    const cfg = NotePrompts.config(note);
    const body = NotePrompts.bodyText(note) || '';
    const lead = opts.attached
        ? 'This conversation is attached to this routine (the user may not have it open right now)'
        : 'The user is viewing this routine';
    return {
        recordKey: 'prompts:' + note.id,
        recordLabel: note.title || 'Untitled routine',
        title: 'CURRENT ROUTINE',
        body: `${lead} (id: ${note.id}):\n` +
            `Title: ${note.title || 'Untitled routine'}\n` +
            `Trigger: ${NotePrompts.triggerLabel(cfg)}\n` +
            `Mode: ${cfg.runMode === 'task' ? 'task (may act)' : 'digest (writes an answer into this chat, changes nothing)'}\n` +
            `Prompt: ${body.slice(0, 400)}${body.length > 400 ? '…' : ''}\n` +
            `Use update_routine / delete_routine with this id for changes the user asks for.`
    };
};

if (typeof AgentContext !== 'undefined') {
    AgentContext.register('prompts', () => {
        if (PromptsApp._view !== 'detail' || !PromptsApp._openId) return null;
        // The page's own "Open chat" is the door (the routine IS a chat).
        const block = PromptsApp.routineContextBlock(PromptsApp._openId);
        return block ? { ...block, cta: false } : null;
    });

    // Record resolver — rebuilds the CURRENT ROUTINE block from a
    // conversation's 'prompts:<id>' attachment when the chat is continued
    // away from the Routines page.
    AgentContext.registerRecord('prompts', (id) => PromptsApp.routineContextBlock(id, { attached: true }));
}

if (typeof module !== 'undefined' && module.exports) module.exports = PromptsApp;
