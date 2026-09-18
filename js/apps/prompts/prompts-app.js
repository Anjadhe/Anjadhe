/**
 * Routines App — the standalone page for routines (scheduled prompts that
 * run in the background and post results to the Home feed).
 *
 * Since 2026-07-31 this page is routines-ONLY: non-scheduled prompt notes
 * ("saved prompts") live in the Notes app like any other note, with the
 * editor's prompt config panel. Scheduling a saved prompt there turns it
 * into a routine and moves it here; the app id stays 'prompts' so deep
 * links and tools keep working. The BACKEND IS UNCHANGED: a routine is
 * still a note in the shared `notes` blob, read and written through
 * NotePrompts — so sync, the assistant's scheduled-prompt tools, and the
 * PromptFeed scheduler keep working untouched. This file is UI only.
 *
 * Three in-page views:
 *  - list:   every routine
 *  - detail: one routine — body, config chips, actions, recent feed posts
 *  - form:   create/edit (always a routine; reuses the old modal's
 *            .prompt-mgr-* classes so the styling carries)
 *
 * Entry points: the launcher tile, Home feed's "Manage routines" button,
 * the feed post overlay's routine link (all via
 * AppManager.openApp('prompts') / PromptsApp.open()).
 */

const PromptsApp = {
    _view: 'list',      // 'list' | 'detail' | 'form'
    _openId: null,      // detail target; form target (null = create)
    _bound: false,
    // List-table state. Sort persists per-machine (localStorage, same as
    // Portfolio's tables); search and the schedule filter reset per visit.
    _table: { q: '', interval: 'all', sort: null },

    init() {
        if (this._bound) return;
        this._bound = true;
        document.getElementById('prompts-add-btn')?.addEventListener('click', () => {
            this._view = 'form';
            this._openId = null;
            this.render();
        });
    },

    /** External entry: open the page on the list, a detail, or the create form. */
    open(opts = {}) {
        if (opts.create) { this._view = 'form'; this._openId = null; }
        else if (opts.id) { this._view = 'detail'; this._openId = opts.id; }
        else { this._view = 'list'; this._openId = null; }
        AppManager.openApp('prompts');
        this.render();
    },

    /**
     * The "Help me set up a routine" prompt pill — opens the assistant's
     * routine interview (start_routine_interview; the goals pattern). The
     * pill's wording contains "routine" on purpose: that word is what ships
     * the prompts tool group into the turn.
     */
    /* The first-time card's examples (2026-09-17). Three ideas, one per
       shape the engine actually has — a clock digest, a clock digest that
       reads another app, and an email trigger in task mode — so the first
       thing a new user sees is what a routine CAN be rather than a
       definition. Each pill opens the interview on that idea; U2 still
       makes them try it before it arms. Deliberately not persona-labelled:
       the labels are the work, and a student reading "at work" learns
       nothing. */
    EMPTY_IDEAS: [
        { label: 'What\u2019s due in the next ten days',
          ask: 'Help me set up a routine that tells me what is due in the next ten days \u2014 across my tasks, projects and calendar, with anything already overdue called out first. Ask me what you need, then set it up.' },
        { label: 'Prep me for today\u2019s meetings',
          ask: 'Help me set up a routine that runs on weekday mornings and prepares me for the day\u2019s meetings: for each event on my calendar, the project it belongs to and the last email thread with those people. Ask me what you need, then set it up.' },
        { label: 'Turn school or billing email into tasks',
          ask: 'Help me set up a routine that watches for email from a particular sender \u2014 my kids\u2019 school, or a biller \u2014 and turns each one into a dated task with the deadline and amount pulled out. Ask me which senders and what you need, then set it up.' }
    ],

    _emptyIdeasHtml() {
        if (typeof AgentUI === 'undefined' || !AgentUI.askWithPrompt) return '';
        const esc = UIUtils.escapeHtml;
        return `<div class="prompt-mgr-empty-ideas">
            <span class="prompt-mgr-empty-ideas-label">For example</span>
            ${this.EMPTY_IDEAS.map(i =>
                `<button type="button" class="ask-prompt-btn" data-ask="${esc(i.ask)}">&ldquo;${esc(i.label)}&rdquo;</button>`).join('')}
        </div>`;
    },

    askNewRoutine() {
        if (typeof AgentUI === 'undefined' || !AgentUI.askWithPrompt) return;
        AgentUI.askWithPrompt(
            'Help me set up a routine — something Anjadhe does for me on its own. ' +
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

    // --- Drafts (2026-09-15) ---
    // The form saves explicitly — Create routine ARMS a job, so writing a
    // half-typed prompt as a routine on leave would schedule something
    // nobody confirmed. What auto-saves instead is a DRAFT: every change
    // lands in localStorage (per-Mac, `new` or the routine's id), leaving
    // the page flushes it through SaveStatus, and the form reopens on it.
    // Before this, going to another page mid-description re-rendered the
    // form blank on return and the text was gone.

    _DRAFTS_KEY: 'routine-form-drafts',
    DRAFT_FIELDS: ['title', 'body', 'trigType', 'interval', 'time', 'from', 'subject',
                   'contains', 'folder', 'pattern', 'runMode', 'web', 'context'],

    _readDrafts() {
        try {
            const d = JSON.parse(localStorage.getItem(this._DRAFTS_KEY) || '{}');
            return (d && typeof d === 'object') ? d : {};
        } catch (e) { return {}; }
    },

    _writeDrafts(d) {
        try { localStorage.setItem(this._DRAFTS_KEY, JSON.stringify(d)); }
        catch (e) { console.warn('[routines] could not keep draft', e); }
    },

    _getDraft(noteId) {
        const d = this._readDrafts()[noteId || 'new'];
        return (d && d.fields) ? d : null;
    },

    _putDraft(noteId, fields, savedAt) {
        const all = this._readDrafts();
        all[noteId || 'new'] = { fields, savedAt: savedAt || new Date().toISOString() };
        this._writeDrafts(all);
    },

    _dropDraft(noteId) {
        const all = this._readDrafts();
        if (!all[noteId || 'new']) return;
        delete all[noteId || 'new'];
        this._writeDrafts(all);
    },

    _draftSer(fields) {
        return JSON.stringify(this.DRAFT_FIELDS.map(k => fields[k]));
    },

    /** Discard a draft, with an Undo that puts it back and reopens the form. */
    _discardDraft(noteId) {
        const kept = this._getDraft(noteId);
        this._dropDraft(noteId);
        if (typeof SaveStatus !== 'undefined') SaveStatus.unregister('routine');
        if (!kept) return;
        UIUtils.showToast('Draft discarded', 'info', 6000, {
            actionLabel: 'Undo',
            onAction: () => {
                this._putDraft(noteId, kept.fields, kept.savedAt);
                this._view = 'form';
                this._openId = noteId || null;
                AppManager.openApp('prompts');
                this.render();
            }
        });
    },

    /** The quiet "you have a draft" line: on the list (new), a detail (its edits), the form (restored). */
    _draftNoteHtml(noteId, where) {
        const d = this._getDraft(noteId);
        if (!d) return '';
        const esc = UIUtils.escapeHtml;
        const ago = (d.savedAt && typeof PromptFeed !== 'undefined' && PromptFeed._timeAgo) ? PromptFeed._timeAgo(d.savedAt) : '';
        const name = (d.fields.title || '').trim()
            || (d.fields.body || '').trim().replace(/\s+/g, ' ').slice(0, 60);
        let text;
        if (where === 'form') text = `Restored your unsaved ${noteId ? 'edits' : 'draft'}`;
        else if (noteId) text = 'You have unsaved edits to this routine';
        else text = `Unsaved draft of a new routine${name ? `: &ldquo;${esc(name)}&rdquo;` : ''}`;
        return `
            <div class="routines-draft-note" role="status">
                <span class="routines-draft-note-text">${text}${ago ? ` <span class="routines-draft-note-when">&middot; kept ${esc(ago)}</span>` : ''}</span>
                ${where === 'form' ? '' : `<button type="button" class="secondary-btn" data-draft-continue>${noteId ? 'Continue editing' : 'Continue'}</button>`}
                <button type="button" class="secondary-btn" data-draft-discard>Discard</button>
            </div>`;
    },

    _wireDraftNote(container, noteId) {
        const box = container.querySelector('.routines-draft-note');
        if (!box) return;
        box.querySelector('[data-draft-continue]')?.addEventListener('click', () => {
            this._view = 'form';
            this._openId = noteId || null;
            this.render();
        });
        box.querySelector('[data-draft-discard]')?.addEventListener('click', () => {
            this._discardDraft(noteId);
            this.render();
        });
    },

    /** Feed posts generated by this prompt, newest first. */
    _outputs(promptId) {
        const d = StorageManager.get('notes');
        const notes = (d && Array.isArray(d.notes)) ? d.notes : [];
        return notes
            .filter(n => NoteTemplates.resolve(n) === 'feed' && n.feed && n.feed.promptId === promptId)
            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
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
                : `<span class="prompt-mgr-chip">${cfg.target === 'browser' ? 'runs in Browser' : 'runs in Assistant'}</span>`,
            cfg.web ? '<span class="prompt-mgr-chip">&#127760; web</span>' : '',
            cfg.useContext ? '<span class="prompt-mgr-chip">&#10024; my context</span>' : ''
        ].filter(Boolean).join('');
    },

    // --- Render ---

    // Deep-link to one prompt's detail page — used by the assistant's record
    // pills ("Prompt · Market Close Review" under an answer) and any other
    // cross-app link. Safe before init: render() falls back to the list if
    // the id is unknown.
    /**
     * Open the new-routine form already filled in — the "More options…"
     * escape from the Repeat-this modal (docs/ROUTINES_UX.md P3). It rides
     * the DRAFT store rather than a second pre-fill channel, so what lands
     * here is indistinguishable from something the user typed: it survives
     * leaving the page, the list names it as a kept draft, and Cancel
     * throws it away with Undo like any other.
     *
     * U2 applies normally from here on — the form it opens has no arm
     * button until the prompt has been tried.
     */
    openWithDraft(fields = {}) {
        this._putDraft(null, {
            title: fields.title || '',
            body: fields.body || '',
            trigType: 'time',
            interval: fields.interval || 'daily',
            time: fields.time || '',
            from: '', subject: '', contains: '', folder: '', pattern: '',
            runMode: 'digest',
            web: false,
            context: true
        });
        this._view = 'form';
        this._openId = null;
        this.render();
    },

    /* ── One detail, rendered wherever it is needed ──────────────────────
       The routine's page, opened OVER the post that its run produced —
       `docs/ROUTINES_UX.md`'s held item, in the form that does not need the
       held item's false assumption (one routine ↔ one series) to be true.

       It is the `embedEditor` law: there is ONE routine detail and ONE
       repaint path. `render()` paints into `_embedHost` when it is set, so
       every `this.render()` inside the detail's own handlers — Run now,
       Test trigger, the prune offer, a decision — repaints the embedded
       copy correctly without a single call site knowing where it lives.

       What is deliberately NOT embedded is the FORM: a full edit is a page
       job (U2's preview, the draft, the trigger line), so Edit leaves. ── */
    _embedHost: null,

    embedDetail(host, id) {
        if (!host || !this._note(id)) return false;
        this._embedHost = host;
        this._view = 'detail';
        this._openId = id;
        this.render();
        return true;
    },

    detachDetail() {
        if (!this._embedHost) return;
        this._embedHost = null;
        // Repaint the real page only if it is mounted — the user was on
        // Home when this opened, and the Routines view may never have been.
        if (document.getElementById('prompts-main')) this.render();
    },

    openPrompt(id) {
        this._view = 'detail';
        this._openId = id;
        this.render();
    },

    render() {
        // An embedded host shows ONE routine, and lets go the moment there
        // is not one. The check is HERE, before anything is painted,
        // because the callers that end an embed do not agree on what they
        // leave behind: `_delete` clears `_openId` before repainting, so a
        // guard keyed on "the open id vanished" never fired and the
        // Routines LIST was painted into a panel over a post.
        if (this._embedHost && !this._note(this._openId)) {
            this._embedHost = null;
            document.dispatchEvent(new CustomEvent('anjadhe:routine-embed-closed'));
        }
        const container = this._embedHost || document.getElementById('prompts-main');
        if (!container) return;
        // The open prompt may have been deleted (or synced away).
        if (this._openId && !this._note(this._openId)) {
            this._view = 'list';
            this._openId = null;
        }
        // An embedded host shows the DETAIL and nothing else; a list or a
        // form painted into a panel over a post is a page in the wrong room.
        if (this._embedHost && this._view !== 'detail') this._view = 'detail';
        // Only an open form is an editor; its draft is already kept.
        if (this._view !== 'form' && typeof SaveStatus !== 'undefined') SaveStatus.unregister('routine');
        this._renderCrumbs();
        this._renderWaiting();
        if (this._view === 'form') this._renderForm(container, this._openId ? this._note(this._openId) : null);
        else if (this._view === 'detail') this._renderDetail(container, this._note(this._openId));
        else this._renderList(container);
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
        const toList = () => { this._view = 'list'; this._openId = null; this.render(); };
        const note = this._openId ? this._note(this._openId) : null;
        if (this._view === 'detail' && note) {
            Breadcrumb.render('prompts-breadcrumb', [
                { label: 'Routines', action: toList },
                { label: note.title || 'Untitled routine' }
            ]);
        } else if (this._view === 'form') {
            Breadcrumb.render('prompts-breadcrumb', [
                { label: 'Routines', action: toList },
                { label: note ? 'Edit routine' : 'New routine' }
            ]);
        } else {
            Breadcrumb.render('prompts-breadcrumb', [{ label: 'Routines' }]);
        }
    },

    /**
     * C10: "Waiting on you" — task-mode runs that stopped at an approval
     * while nobody was here. It sits ABOVE the routines list on every view of
     * this page, because it is the only thing here that is blocked on the
     * user; everything else is either running or idle.
     *
     * Resuming from here is a human decision, so TaskService marks the run
     * attended and its next `ask` opens the normal dialog instead of pausing
     * again.
     */
    _renderWaiting() {
        const section = document.getElementById('prompts-waiting-section');
        const box = document.getElementById('prompts-waiting');
        if (!section || !box) return;
        if (typeof TaskService === 'undefined' || typeof TaskService._all !== 'function') {
            section.hidden = true;
            return;
        }
        const waiting = TaskService._all().filter(t => t && ['awaiting_user', 'paused'].includes(t.status));
        section.hidden = waiting.length === 0;
        if (!waiting.length) return;
        const esc = UIUtils.escapeHtml;
        const countEl = document.getElementById('prompts-waiting-count');
        if (countEl) countEl.textContent = waiting.length > 0 ? String(waiting.length) : '';
        box.innerHTML = waiting.map(t => `
            <div class="routines-waiting-row" data-task="${esc(t.id)}">
                <div class="routines-waiting-main">
                    <div class="routines-waiting-title">${esc(t.goal)}</div>
                    <div class="routines-waiting-sub">${esc(t.note || t.status)}</div>
                </div>
                <span class="routines-waiting-actions">
                    <button class="secondary-btn routines-act" data-act="${t.status === 'paused' ? 'resume' : 'approve'}" type="button">${t.status === 'paused' ? 'Resume' : 'Review &amp; run'}</button>
                    <button class="secondary-btn routines-act" data-act="cancel" type="button">Cancel</button>
                </span>
            </div>`).join('');
        box.onclick = async (e) => {
            const btn = e.target.closest('button[data-act]');
            if (!btn) return;
            const id = btn.closest('[data-task]')?.dataset.task;
            if (!id) return;
            const act = btn.dataset.act;
            if (act === 'resume') await TaskService.resume(id);
            else if (act === 'approve') await TaskService.approve(id);
            else if (act === 'cancel') TaskService.cancel(id);
            this.render();
        };
    },

    // Table sort: which columns open ascending on first click.
    _TEXT_COLS: ['title', 'schedule'],

    _tableSort() {
        if (!this._table.sort) {
            let stored = null;
            try { stored = JSON.parse(localStorage.getItem('routines-sort') || 'null'); } catch (e) { /* default stands */ }
            this._table.sort = (stored && stored.col) ? stored : { col: 'schedule', dir: 'asc' };
        }
        return this._table.sort;
    },

    _setTableSort(col) {
        const s = this._tableSort();
        if (s.col === col) s.dir = s.dir === 'asc' ? 'desc' : 'asc';
        else { s.col = col; s.dir = this._TEXT_COLS.includes(col) ? 'asc' : 'desc'; }
        try { localStorage.setItem('routines-sort', JSON.stringify(s)); } catch (e) { /* ignore */ }
        this.render();
    },

    _renderList(container) {
        // Routines only — saved (non-scheduled) prompt notes live in Notes.
        const all = this._prompts().filter(p => NotePrompts.config(p).offline);
        const esc = UIUtils.escapeHtml;

        if (!all.length) {
            container.innerHTML = `${this._draftNoteHtml(null, 'list')}
                <div class="prompt-mgr-list prompts-page-list">
                    <div class="prompt-mgr-empty">
                        <span class="prompt-mgr-empty-icon" aria-hidden="true">&#9201;</span>
                        <p class="prompt-mgr-empty-text">No routines yet. A routine is work Anjadhe does on its own &mdash; each<br>morning, or the moment an email or a file arrives. It writes you an<br>answer on your Home feed, or takes the actions and reports back.</p>
                        ${this._emptyIdeasHtml()}
                        <button class="ask-prompt-btn primary routines-ask-ai" type="button">&ldquo;Help me set up a routine&rdquo;</button>
                        <button class="secondary-btn prompt-mgr-empty-add" type="button">Create one by hand</button>
                    </div>
                </div>`;
            container.querySelector('.prompt-mgr-empty-add')?.addEventListener('click', () => {
                this._view = 'form'; this._openId = null; this.render();
            });
            container.querySelector('.routines-ask-ai')?.addEventListener('click', () => this.askNewRoutine());
            container.querySelectorAll('.prompt-mgr-empty-ideas [data-ask]').forEach(b =>
                b.addEventListener('click', () => AgentUI.askWithPrompt(b.dataset.ask, { newChat: true })));
            this._wireDraftNote(container, null);
            return;
        }

        const t = this._table;
        const sort = this._tableSort();
        const runs = (typeof RoutineEngine !== 'undefined' && RoutineEngine.state.runs) || {};

        let rows = all.map(p => {
            const cfg = NotePrompts.config(p);
            return { p, cfg, body: NotePrompts.bodyText(p), last: runs[p.id] || null,
                     stats: this._readStats(p.id) };
        });
        const q = t.q.trim().toLowerCase();
        if (q) rows = rows.filter(r =>
            (r.p.title || '').toLowerCase().includes(q) || r.body.toLowerCase().includes(q));
        if (t.interval !== 'all') rows = rows.filter(r => r.cfg.interval === t.interval);

        const ORDER = { hourly: 0, '6h': 1, daily: 2, weekdays: 3, weekly: 4 };
        const dir = sort.dir === 'asc' ? 1 : -1;
        const cmp = {
            title: (a, b) => (a.p.title || '').localeCompare(b.p.title || ''),
            schedule: (a, b) => (ORDER[a.cfg.interval] - ORDER[b.cfg.interval])
                || String(a.cfg.time || '99:99').localeCompare(String(b.cfg.time || '99:99')),
            web: (a, b) => (a.cfg.web ? 1 : 0) - (b.cfg.web ? 1 : 0),
            context: (a, b) => (a.cfg.useContext ? 1 : 0) - (b.cfg.useContext ? 1 : 0),
            lastRun: (a, b) => (Date.parse(a.last) || 0) - (Date.parse(b.last) || 0)
        }[sort.col] || (() => 0);
        rows.sort((a, b) => dir * cmp(a, b) || (a.p.title || '').localeCompare(b.p.title || ''));

        // U9: a list of six is READ, not queried. Sorting and filtering
        // appear only once there are enough routines to need them — the
        // same call the old left rail lost (176px of furniture for four
        // entries). Search stays at every size: it is a keyboard path, not
        // furniture.
        const dense = all.length >= this.LIST_DENSE_MIN;
        const th = (col, label, cls = '') => {
            if (!dense) return `<th class="routines-th ${cls}">${label}</th>`;
            const active = sort.col === col;
            const arrow = active ? (sort.dir === 'asc' ? '&#9650;' : '&#9660;') : '';
            return `<th class="routines-th ${cls}" data-col="${col}" role="button" tabindex="0"
                        aria-sort="${active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"
                    >${label}${arrow ? `<span class="routines-sort-arrow">${arrow}</span>` : ''}</th>`;
        };
        const errors = (typeof RoutineEngine !== 'undefined' && RoutineEngine.state.errors) || {};
        // Colour as data (2026-09-09): the routine's hue and kind tile, the
        // same marks its editions carry on the home feed and its detail.
        const hue = (id) => (typeof PromptFeed !== 'undefined' && PromptFeed.routineHue) ? PromptFeed.routineHue(id) : '#9CA3AF';
        const kindIcon = (kind) => (typeof PromptFeed !== 'undefined' && PromptFeed.kindIcon) ? PromptFeed.kindIcon(kind, 15) : '';
        const ICON_RUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
        const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
        const ICON_DEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
        const tr = (r) => {
            const kind = r.cfg.runMode === 'task' ? 'task' : 'report';
            const running = this._runningNow(r.p.id);
            const err = errors[r.p.id];
            const ranState = running ? 'running' : err ? 'error' : r.last ? 'ok' : 'never';
            return `
            <tr class="routines-row" data-open-prompt="${esc(r.p.id)}" tabindex="0" style="--rt-hue:${hue(r.p.id)}">
                <td class="routines-td-title" title="${esc(r.p.title || 'Untitled routine')}">
                    <span class="routines-td-tile" aria-hidden="true">${kindIcon(kind)}</span>
                    <span class="routines-td-titlewrap">
                        <span class="routines-td-title-text">${esc(r.p.title || 'Untitled routine')}</span>
                        <span class="routines-td-chips">
                            ${kind === 'task' ? '<span class="routines-mode-chip" title="This routine can make changes">acts</span>' : ''}
                            ${running ? '<span class="routines-mode-chip is-live" title="This routine is running right now">running</span>' : ''}
                            ${err ? `<span class="routines-err-chip" title="${esc(err)}">needs attention</span>` : ''}
                        </span>
                    </span>
                </td>
                <td class="routines-td-sched">${esc(NotePrompts.triggerLabel(r.cfg))}</td>
                <td class="routines-td-uses">
                    ${r.cfg.web ? '<span class="routines-use-chip">Web</span>' : ''}
                    ${r.cfg.useContext ? '<span class="routines-use-chip">Context</span>' : ''}
                </td>
                <td class="routines-td-ran"><span class="routines-ran-dot is-${ranState}" aria-hidden="true"></span>${r.last && typeof PromptFeed !== 'undefined' ? esc(PromptFeed._timeAgo(r.last)) : 'never'}</td>
                <td class="routines-td-read">${r.stats.shown
                    ? `<span class="${r.stats.rarely ? 'routines-read-low' : 'routines-read'}" title="Editions you opened, of the last ${r.stats.shown}">opened ${r.stats.opened} of ${r.stats.shown}</span>`
                    : ''}</td>
                <td class="routines-td-actions">
                    <button class="prompt-mgr-iconbtn" data-run="${esc(r.p.id)}" type="button" title="Run now" aria-label="Run now">${ICON_RUN}</button>
                    <button class="prompt-mgr-iconbtn" data-edit="${esc(r.p.id)}" type="button" title="Edit" aria-label="Edit">${ICON_EDIT}</button>
                    <button class="prompt-mgr-iconbtn prompt-mgr-del" data-del="${esc(r.p.id)}" type="button" title="Delete" aria-label="Delete">${ICON_DEL}</button>
                </td>
            </tr>`;
        };

        const INTERVALS = [['all', 'All schedules'], ['hourly', 'Hourly'], ['6h', 'Every 6h'],
                           ['daily', 'Daily'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly']];
        container.innerHTML = `${this._draftNoteHtml(null, 'list')}
            <div class="routines-toolbar">
                <span class="routines-search-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg><input id="routines-search" class="routines-search" type="search"
                       placeholder="Search routines" value="${esc(t.q)}" spellcheck="false"></span>
                ${dense ? `<select id="routines-filter" class="routines-filter" aria-label="Filter by schedule">
                    ${INTERVALS.map(([v, l]) => `<option value="${v}" ${t.interval === v ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
                <span class="routines-count">${rows.length} of ${all.length}</span>` : ''}
            </div>
            <table class="routines-table">
                <thead><tr>
                    ${th('title', 'Routine')}
                    ${th('schedule', 'Runs when')}
                    ${th('web', 'Uses')}
                    ${th('lastRun', 'Last run')}
                    <th class="routines-th">Read</th>
                    <th class="routines-th-actions"></th>
                </tr></thead>
                <tbody>
                    ${rows.length ? rows.map(tr).join('')
                        : `<tr><td class="routines-table-empty" colspan="6">No routines match.</td></tr>`}
                </tbody>
            </table>`;

        // Search re-renders the table on each keystroke; the input is
        // rebuilt with it, so focus and caret are put back by hand.
        const search = container.querySelector('#routines-search');
        search.addEventListener('input', () => {
            this._table.q = search.value;
            const pos = search.selectionStart;
            this._renderList(container);
            const again = container.querySelector('#routines-search');
            again.focus();
            try { again.setSelectionRange(pos, pos); } catch (e) { /* type=search quirk */ }
        });
        container.querySelector('#routines-filter')?.addEventListener('change', (e) => {
            this._table.interval = e.target.value;
            this._renderList(container);
        });
        container.querySelectorAll('th[data-col]').forEach(h => {
            h.addEventListener('click', () => this._setTableSort(h.dataset.col));
            h.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._setTableSort(h.dataset.col); }
            });
        });
        container.querySelectorAll('[data-open-prompt]').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                this._view = 'detail'; this._openId = row.dataset.openPrompt; this.render();
            });
            row.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.target.closest('button')) {
                    this._view = 'detail'; this._openId = row.dataset.openPrompt; this.render();
                }
            });
        });
        container.querySelectorAll('[data-run]').forEach(b =>
            b.addEventListener('click', () => this._runNow(b.dataset.run, b)));
        container.querySelectorAll('[data-edit]').forEach(b =>
            b.addEventListener('click', () => {
                this._view = 'form'; this._openId = b.dataset.edit; this.render();
            }));
        container.querySelectorAll('[data-del]').forEach(b =>
            b.addEventListener('click', () => this._delete(b.dataset.del)));
        this._wireDraftNote(container, null);
    },

    /**
     * Change it by talking to it (docs/ROUTINES_UX.md U1/P4). Quoted
     * questions that hand THIS routine to the assistant — the
     * Portfolio-strategy pattern, and the right one here because a routine
     * is the most prompt-shaped record in the app: "make it weekly" is one
     * sentence and a trip through a form otherwise.
     *
     * The pills never mutate (the HelpActions law): each one opens a chat
     * attached to this routine, the model calls `update_routine`, and the
     * consent dialog shows the change as a diff before anything is written.
     *
     * Which pills appear is arithmetic over the routine's own state — an
     * offer to make something quieter is noise on a routine that has never
     * said anything.
     */
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
        if (!note) { this._view = 'list'; this._renderList(container); return; }
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
            const tmp = document.createElement('div');
            tmp.innerHTML = o.content || '';
            const text = o.feed && o.feed.error
                ? o.feed.error
                : (tmp.textContent || '').replace(/\s+/g, ' ').trim();
            const preview = text.length > 160 ? text.slice(0, 160).trimEnd() + '…' : text;
            return {
                at: o.createdAt || '',
                html: `
                <button class="routines-post-row${o.feed && o.feed.error ? ' is-error' : ''}" data-open-post="${o.id}" type="button">
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
        // the compiled report TaskService._report stored on it.
        const runs = (cfg.runMode === 'task' && typeof TaskService !== 'undefined')
            ? (TaskService._all() || []).filter(t => t && t.routineId === note.id
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
            : (cfg.target === 'browser' ? 'runs in Browser' : 'runs in Assistant');
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

        // Colour as data (2026-09-09): the routine's own hue and kind mark,
        // the same ones its editions carry on the home feed.
        const kind = cfg.runMode === 'task' ? 'task' : 'report';
        const hue = (typeof PromptFeed !== 'undefined' && PromptFeed.routineHue) ? PromptFeed.routineHue(note.id) : '#9CA3AF';
        const kindIcon = (typeof PromptFeed !== 'undefined' && PromptFeed.kindIcon) ? PromptFeed.kindIcon(kind, 20) : '';
        container.dataset.rtKind = kind;
        container.style.setProperty('--rt-hue', hue);
        container.innerHTML = `${this._draftNoteHtml(note.id, 'detail')}
            <div class="routines-detail-head">
                <span class="routines-detail-tile" aria-hidden="true">${kindIcon}</span>
                <div class="routines-detail-headtext">
                    <div class="routines-detail-eyebrow">
                        <span class="routines-kind-chip">${cfg.runMode === 'task' ? 'Takes actions' : 'Writes an answer'}</span>
                        ${running ? '<span class="routines-mode-chip is-live">running</span>' : ''}
                        ${lastError ? '<span class="routines-err-chip">needs attention</span>' : ''}
                    </div>
                    <h3 class="routines-detail-title">${esc(note.title || 'Untitled routine')}</h3>
                </div>
                <div class="routines-detail-actions">
                    <button class="primary-btn routines-act routines-act-run" data-run="${note.id}" type="button" title="Run this routine now">&#9654; Run now</button>
                    ${cfg.offline ? `<button class="secondary-btn routines-act" data-test="${note.id}" type="button" title="See what this trigger would fire on right now — nothing runs, nothing is recorded">Test trigger</button>` : ''}
                    <button class="secondary-btn routines-act" data-edit="${note.id}" type="button">Edit</button>
                    <button class="secondary-btn routines-act routines-act-delete" data-del="${note.id}" type="button">Delete</button>
                </div>
            </div>
            <div class="routines-props">
                ${prop('Runs when', scheduleValue)}
                ${cfg.offline ? prop('Does', modeValue) : ''}
                ${aboutRow}
                ${uses ? prop('Uses', uses) : ''}
                ${running ? prop('Running now', `for ${esc(running)} <button class="secondary-btn routines-act routines-stop" data-stop="${esc(note.id)}" type="button" title="Stop this run">Stop</button>`) : ''}
                ${cfg.offline ? prop('Last run', esc(this._lastRunLabel(note))) : ''}
                ${stats.shown ? prop('Read', `You opened <strong>${stats.opened}</strong> of the last ${stats.shown}.`) : ''}
                ${quietStreak >= this.QUIET_STREAK_HINT
                    ? prop('Nothing to report', `The last ${quietStreak} runs had nothing to say, so nothing was posted. If that seems wrong, check the prompt &mdash; a routine that can never find anything says this every time.`)
                    : ''}
                ${cfg.offline ? prop('Last checked', esc(checkedLabel)) : ''}
                ${cfg.offline ? prop('Last matched', esc(matchedLabel)) : ''}
                ${status.queued ? prop('Queued', `${status.queued} run${status.queued > 1 ? 's' : ''} waiting for the task slot`) : ''}
                ${elsewhere ? prop('Runs on', 'Another Mac &mdash; it is armed there, not here') : ''}
                ${lastError ? prop('Last problem', `<span class="routines-err-text">${esc(lastError)}</span>`) : ''}
            </div>
            ${offerPrune ? `
            <div class="routines-prune">
                <p class="routines-prune-text">This has run ${stats.shown} times lately and you opened ${stats.opened === 0 ? 'none of them' : `${stats.opened} of them`}. Want it less often, or not at all?</p>
                <div class="routines-prune-actions">
                    ${cfg.interval !== 'weekly' && (cfg.trigger || {}).type === 'time'
                        ? `<button class="secondary-btn" type="button" data-prune="weekly">Make it weekly</button>` : ''}
                    <button class="secondary-btn routines-act-delete" type="button" data-prune="delete">Delete it</button>
                    <button class="secondary-btn" type="button" data-prune="keep">Keep it</button>
                </div>
            </div>` : ''}
            <div class="routines-trigtest" hidden></div>
            <div class="routines-prompt-section">
                <div class="detail-section-header">Prompt</div>
                <div class="routines-prompt-text">${esc(body) || '<span class="routines-empty">No prompt text yet — edit to add one.</span>'}</div>
            </div>
            ${cfg.offline ? this._askPillsHtml(note, cfg, quietStreak) : ''}
            ${typeof DecisionsUI !== 'undefined' ? DecisionsUI.renderSection(`routine:${note.id}`) : ''}
            ${runRows ? `
                <div class="routines-outputs">
                    <div class="detail-section-header">Run history</div>
                    ${runRows}
                </div>` : ''}
            ${postRows ? `
                <div class="routines-outputs">
                    <div class="detail-section-header">Run history</div>
                    ${postRows}
                </div>` : ''}
            ${!runRows && !postRows && cfg.offline ? `<p class="routines-empty">${cfg.runMode === 'task'
                ? 'No runs yet — each run&rsquo;s log will appear here.'
                : 'No runs yet — results will appear here and on your Home feed.'}</p>` : ''}
        `;

        if (typeof DecisionsUI !== 'undefined') {
            DecisionsUI.attachListeners(container, `routine:${note.id}`, () => this.render());
        }
        container.querySelector('[data-run]')?.addEventListener('click', (e) => this._runNow(note.id, e.currentTarget));
        container.querySelector('[data-stop]')?.addEventListener('click', (e) => {
            e.currentTarget.disabled = true;
            const ok = typeof PromptFeed !== 'undefined' && PromptFeed.stopCurrent && PromptFeed.stopCurrent();
            UIUtils.showToast(ok ? 'Stopping…' : 'Nothing to stop — the run already ended', 'info');
            setTimeout(() => this.render(), 400);
        });
        container.querySelector('[data-test]')?.addEventListener('click', (e) => this._testTrigger(note, e.currentTarget));
        container.querySelector('[data-edit]')?.addEventListener('click', () => {
            // The form is a page job (U2's preview, the draft, the written
            // trigger) — leave the post for it rather than shrinking it
            // into a panel.
            if (this._embedHost) {
                this._embedHost = null;
                document.dispatchEvent(new CustomEvent('anjadhe:routine-embed-closed'));
                if (typeof PromptFeed !== 'undefined') PromptFeed.closePost();
                AppManager.openApp('prompts');
                this._openId = note.id;
            }
            this._view = 'form'; this.render();
        });
        container.querySelector('[data-del]')?.addEventListener('click', () => this._delete(note.id));
        this._wireDraftNote(container, note.id);
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
            // on a named change, which is consent (the StarterPrompts.seed
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

    _renderForm(container, note) {
        const savedCfg = note ? NotePrompts.config(note) : NotePrompts.config({ prompt: { ...NotePrompts.DEFAULTS } });
        const savedTrig = savedCfg.trigger || { type: 'time' };
        const esc0 = UIUtils.escapeHtml;
        // What the record holds, in the draft's shape — and what the form
        // shows: a kept draft over it (see Drafts above).
        const initial = {
            title: note ? (note.title || '') : '',
            body: note ? NotePrompts.bodyText(note) : '',
            trigType: savedTrig.type || 'time',
            interval: savedCfg.interval,
            time: savedCfg.time || '',
            from: savedTrig.from || '', subject: savedTrig.subject || '', contains: savedTrig.contains || '',
            folder: savedTrig.folder || '', pattern: savedTrig.pattern || '',
            runMode: savedCfg.runMode,
            web: !!savedCfg.web,
            context: !!savedCfg.useContext
        };
        const draftFor = note ? note.id : null;
        const draft = this._getDraft(draftFor);
        const f = draft ? { ...initial, ...draft.fields } : initial;
        const cfg = { ...savedCfg, interval: f.interval, time: f.time, runMode: f.runMode, web: f.web, useContext: f.context };
        const title = f.title;
        const body = f.body;
        // C10: one form for all three triggers. The panes are all in the DOM
        // and toggled by `hidden`, so switching type never loses what was
        // typed into another one.
        const trig = { type: f.trigType, from: f.from, subject: f.subject, contains: f.contains, folder: f.folder, pattern: f.pattern };
        const trigType = f.trigType;

        // The routine's own hue and kind tile lead the form, as on its
        // detail — a new routine wears the neutral tile until it is saved.
        const formKind = cfg.runMode === 'task' ? 'task' : 'report';
        const formHue = (note && typeof PromptFeed !== 'undefined' && PromptFeed.routineHue) ? PromptFeed.routineHue(note.id) : '#9CA3AF';
        const formIcon = (kind) => (typeof PromptFeed !== 'undefined' && PromptFeed.kindIcon) ? PromptFeed.kindIcon(kind, 20) : '';
        container.style.setProperty('--rt-hue', formHue);
        container.innerHTML = `
            <div class="routines-form">
                ${draft ? this._draftNoteHtml(draftFor, 'form') : ''}
                ${!note ? `
                <!-- Creation is a conversation first (the goals pattern): the
                     pill opens the assistant's routine interview, which knows
                     what routines can do and asks one question at a time. The
                     form below stays first-class for people who know what
                     they want. -->
                <div class="routines-ask-row">
                    <button type="button" class="ask-prompt-btn primary routines-ask-ai">&ldquo;Help me set up a routine&rdquo;</button>
                    <span class="routines-ask-or">or fill it in yourself:</span>
                </div>` : ''}
                <div class="routines-form-head">
                    <span class="routines-detail-tile routines-form-tile" aria-hidden="true">${formIcon(formKind)}</span>
                    <div class="routines-form-headtext">
                        <div class="routines-form-eyebrow">${note ? 'Edit routine' : 'New routine'}</div>
                        <input id="prompt-mgr-title" class="detail-title-input routines-title-input" type="text"
                               placeholder="Name this routine..." value="${UIUtils.escapeHtml(title)}" autocomplete="off" spellcheck="false">
                    </div>
                </div>

                <div class="routines-form-section">
                    <div class="routines-form-section-head">
                        <div class="detail-section-header">Prompt</div>
                        <span class="routines-form-kbd">&#8984;&#8629; saves</span>
                    </div>
                    <textarea id="prompt-mgr-body" class="routines-body-input" rows="5"
                              placeholder="What should run each time? Write it as a request to your assistant.">${UIUtils.escapeHtml(body)}</textarea>
                </div>

                <div class="detail-section-header">Settings</div>

                <div class="routines-props routines-form-props">
                    <input type="hidden" id="prompt-mgr-interval" value="${cfg.interval}">
                    <input type="hidden" id="prompt-mgr-trigtype" value="${trigType}">
                    <input type="hidden" id="prompt-mgr-runmode" value="${cfg.runMode}">

                    <!-- U7: say it, then see it. The segmented panes below
                         stay — they are the fields the record actually
                         holds and the way to correct a misread — but they
                         are no longer the only way in. -->
                    <div class="routines-prop routines-when-said">
                        <label class="routines-prop-label" for="prompt-mgr-when">Runs when</label>
                        <div class="routines-when-row">
                            <input type="text" id="prompt-mgr-when" class="routines-trig-input"
                                   placeholder="Every weekday at 7am — or when an email from billing@ mentions an invoice"
                                   autocomplete="off" spellcheck="false">
                            <button type="button" class="secondary-btn routines-when-go">Set</button>
                        </div>
                        <p class="routines-when-echo" hidden></p>
                    </div>

                    <div class="routines-prop">
                        <span class="routines-prop-label routines-when-detail-label">Or pick it</span>
                        <div class="prompt-mgr-seg" role="group" aria-label="What starts this routine">
                            ${[['time', 'On a schedule'], ['email', 'An email arrives'], ['file', 'A file appears']].map(([v, l]) => `
                                <button type="button" class="prompt-mgr-seg-btn prompt-mgr-trig-btn ${trigType === v ? 'active' : ''}" data-trig="${v}" aria-pressed="${trigType === v}">${l}</button>`).join('')}
                        </div>
                    </div>

                    <div class="routines-trig-pane" data-trig-pane="time" ${trigType === 'time' ? '' : 'hidden'}>
                        <div class="routines-prop">
                            <span class="routines-prop-label">Every</span>
                            <div class="prompt-mgr-seg" role="group" aria-label="Run every">
                                ${['hourly', '6h', 'daily', 'weekdays', 'weekly'].map(v => `
                                    <button type="button" class="prompt-mgr-seg-btn ${cfg.interval === v ? 'active' : ''}" data-value="${v}" aria-pressed="${cfg.interval === v}">${NotePrompts.intervalLabel(v)}</button>`).join('')}
                            </div>
                        </div>
                        <div class="routines-prop prompt-mgr-time-row" ${['daily', 'weekdays', 'weekly'].includes(cfg.interval) ? '' : 'hidden'}>
                            <label class="routines-prop-label" for="prompt-mgr-time">At</label>
                            <input type="time" id="prompt-mgr-time" class="routines-time" value="${cfg.time || ''}">
                        </div>
                    </div>

                    <div class="routines-trig-pane" data-trig-pane="email" ${trigType === 'email' ? '' : 'hidden'}>
                        <div class="routines-prop">
                            <label class="routines-prop-label" for="prompt-mgr-trig-from">From contains</label>
                            <input type="text" id="prompt-mgr-trig-from" class="routines-trig-input"
                                   placeholder="billing@acme.com" value="${esc0(trig.from || '')}" spellcheck="false">
                        </div>
                        <div class="routines-prop">
                            <label class="routines-prop-label" for="prompt-mgr-trig-subject">Subject contains</label>
                            <input type="text" id="prompt-mgr-trig-subject" class="routines-trig-input"
                                   placeholder="invoice" value="${esc0(trig.subject || '')}" spellcheck="false">
                        </div>
                        <div class="routines-prop">
                            <label class="routines-prop-label" for="prompt-mgr-trig-contains">Message contains</label>
                            <input type="text" id="prompt-mgr-trig-contains" class="routines-trig-input"
                                   placeholder="invoice" value="${esc0(trig.contains || '')}" spellcheck="false">
                        </div>
                        <p class="routines-form-hint">Fill in at least one. &ldquo;Message contains&rdquo; searches the whole email, not just the subject line. Checked against mail already fetched to this Mac.</p>
                    </div>

                    <div class="routines-trig-pane" data-trig-pane="file" ${trigType === 'file' ? '' : 'hidden'}>
                        <div class="routines-prop">
                            <label class="routines-prop-label" for="prompt-mgr-trig-folder">Folder</label>
                            <input type="text" id="prompt-mgr-trig-folder" class="routines-trig-input"
                                   placeholder="~/Downloads" value="${esc0(trig.folder || '')}" spellcheck="false">
                        </div>
                        <div class="routines-prop">
                            <label class="routines-prop-label" for="prompt-mgr-trig-pattern">Matching</label>
                            <input type="text" id="prompt-mgr-trig-pattern" class="routines-trig-input"
                                   placeholder="*.pdf (optional)" value="${esc0(trig.pattern || '')}" spellcheck="false">
                        </div>
                        <p class="routines-form-hint">The folder has to be one you have already let the assistant read.</p>
                    </div>

                    <div class="routines-prop">
                        <span class="routines-prop-label">Does</span>
                        <div class="prompt-mgr-seg" role="group" aria-label="What this routine may do">
                            ${[['digest', 'Writes me an answer'], ['task', 'Takes actions']].map(([v, l]) => `
                                <button type="button" class="prompt-mgr-seg-btn prompt-mgr-mode-btn ${cfg.runMode === v ? 'active' : ''}" data-mode="${v}" aria-pressed="${cfg.runMode === v}">${l}</button>`).join('')}
                        </div>
                    </div>

                    <div class="routines-prop routines-uses-row" ${cfg.runMode === 'task' ? 'hidden' : ''}>
                        <span class="routines-prop-label">Uses</span>
                        <div class="routines-uses">
                            <label class="prompt-mgr-optchip" title="Let the model search the web during the run">
                                <input type="checkbox" id="prompt-mgr-web" ${cfg.web ? 'checked' : ''}>
                                <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/></svg>Web search</span>
                            </label>
                            <label class="prompt-mgr-optchip" title="Run through the AI Assistant with your memory, projects, and schedule">
                                <input type="checkbox" id="prompt-mgr-context" ${cfg.useContext ? 'checked' : ''}>
                                <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v3"/><path d="M12 18v3"/><path d="M3 12h3"/><path d="M18 12h3"/><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/></svg>My context</span>
                            </label>
                        </div>
                    </div>

                </div>
                <p class="routines-form-hint routines-mode-hint">${cfg.runMode === 'task'
                    ? 'Runs a multi-step task on its own. It can change your data; any step needing permission pauses and notifies you. Each run keeps its log here, under Run history.'
                    : 'Runs on your local model and posts each result to the Home feed. It cannot change anything.'}</p>

                <!-- Try it before Arm it (docs/ROUTINES_UX.md U2). For a NEW
                     routine the arm button is not on the page at all until a
                     run has happened in front of the user: arming something
                     nobody has seen run is the thing this phase removes.
                     Editing an existing routine keeps Save primary — it has
                     run before, and forcing a re-run to change one word
                     would be friction charging for nothing. -->
                <div class="routines-preview" hidden></div>

                <div class="routines-form-actions">
                    ${typeof SaveStatus !== 'undefined' ? SaveStatus.html('routine-draft-status', 'idle', 'routines-draft-status') : ''}
                    <button class="secondary-btn prompt-mgr-cancel" type="button">Cancel</button>
                    <button class="${note ? 'secondary-btn' : 'primary-btn'} prompt-mgr-try" type="button">Try it</button>
                    <button class="primary-btn prompt-mgr-save" type="button" ${note ? '' : 'hidden'}>${note ? 'Save changes' : 'Arm it'}</button>
                </div>
            </div>`;

        const back = () => {
            this._view = this._openId ? 'detail' : 'list';
            this.render();
        };
        // Cancel is the one way to throw a draft away (with Undo).
        container.querySelector('.prompt-mgr-cancel')?.addEventListener('click', () => {
            this._discardDraft(draftFor);
            back();
        });

        // Keep the draft on every change. Writes are synchronous, so there
        // is never a pending timer holding the only copy; SaveStatus calls
        // keep() again when the user leaves, which is then a no-op.
        const q = (sel) => container.querySelector(sel);
        const formNow = () => {
            if (!q('#prompt-mgr-title')) return null; // the form is gone
            return {
                title: q('#prompt-mgr-title').value,
                body: q('#prompt-mgr-body').value,
                trigType: q('#prompt-mgr-trigtype').value,
                interval: q('#prompt-mgr-interval').value,
                time: q('#prompt-mgr-time').value,
                from: q('#prompt-mgr-trig-from').value,
                subject: q('#prompt-mgr-trig-subject').value,
                contains: q('#prompt-mgr-trig-contains').value,
                folder: q('#prompt-mgr-trig-folder').value,
                pattern: q('#prompt-mgr-trig-pattern').value,
                runMode: q('#prompt-mgr-runmode').value,
                web: q('#prompt-mgr-web').checked,
                context: q('#prompt-mgr-context').checked
            };
        };
        const initialSer = this._draftSer(initial);
        let keptSer = this._draftSer(f);
        const indicator = q('#routine-draft-status');
        const hasSaveStatus = typeof SaveStatus !== 'undefined';
        if (draft && hasSaveStatus) SaveStatus.mark(indicator, 'saved', '', { quiet: true, text: 'Draft kept' });
        const keep = () => {
            const now = formNow();
            if (!now) return { ok: true };
            const ser = this._draftSer(now);
            if (ser === keptSer) return { ok: true };
            keptSer = ser;
            if (ser === initialSer) {
                // Back to exactly what is saved: nothing to keep.
                this._dropDraft(draftFor);
                if (hasSaveStatus) SaveStatus.mark(indicator, 'idle');
            } else {
                this._putDraft(draftFor, now);
                if (hasSaveStatus) SaveStatus.mark(indicator, 'saved', '', { text: 'Draft kept' });
            }
            return { ok: true };
        };
        const formEl = q('.routines-form');
        formEl?.addEventListener('input', keep);
        formEl?.addEventListener('change', keep);
        // Segmented controls write hidden inputs, which fire no events; this
        // bubbles up after each button's own handler has written its value.
        formEl?.addEventListener('click', (e) => { if (e.target.closest('.prompt-mgr-seg-btn')) keep(); });
        if (hasSaveStatus) {
            SaveStatus.register('routine', {
                isDirty: () => { const now = formNow(); return !!now && this._draftSer(now) !== keptSer; },
                flush: keep,
                label: note ? `Routine “${note.title || 'Untitled routine'}”` : 'New routine'
            });
        }
        container.querySelector('.routines-draft-note [data-draft-discard]')?.addEventListener('click', () => {
            this._discardDraft(draftFor);
            this.render();
        });

        container.querySelector('.routines-ask-ai')?.addEventListener('click', () => this.askNewRoutine());

        // Each segmented control writes into its own hidden input so the save
        // handler reads plain fields (same recipe as the old modal form).
        // NOTE the selectors are scoped per group: there are three segmented
        // controls on this form now, and one shared `.prompt-mgr-seg-btn`
        // handler would have every click rewrite the interval.
        const pressGroup = (buttons, chosen) => buttons.forEach(x => {
            x.classList.toggle('active', x === chosen);
            x.setAttribute('aria-pressed', String(x === chosen));
        });

        const intervalBtns = [...container.querySelectorAll('[data-trig-pane="time"] .prompt-mgr-seg-btn[data-value]')];
        intervalBtns.forEach(b => b.addEventListener('click', () => {
            container.querySelector('#prompt-mgr-interval').value = b.dataset.value;
            pressGroup(intervalBtns, b);
            // A run time only makes sense for wall-clock intervals.
            container.querySelector('.prompt-mgr-time-row').hidden =
                !['daily', 'weekdays', 'weekly'].includes(b.dataset.value);
        }));

        const trigBtns = [...container.querySelectorAll('.prompt-mgr-trig-btn')];
        trigBtns.forEach(b => b.addEventListener('click', () => {
            container.querySelector('#prompt-mgr-trigtype').value = b.dataset.trig;
            pressGroup(trigBtns, b);
            container.querySelectorAll('[data-trig-pane]').forEach(p => {
                p.hidden = p.dataset.trigPane !== b.dataset.trig;
            });
        }));

        // Switching to "Takes actions" hides web/context: those options
        // belong to the single-turn digest path, and a task run decides its
        // own tools.
        const modeBtns = [...container.querySelectorAll('.prompt-mgr-mode-btn')];
        modeBtns.forEach(b => b.addEventListener('click', () => {
            container.querySelector('#prompt-mgr-runmode').value = b.dataset.mode;
            pressGroup(modeBtns, b);
            const isTask = b.dataset.mode === 'task';
            const usesRow = container.querySelector('.routines-uses-row');
            if (usesRow) usesRow.hidden = isTask;
            const tile = container.querySelector('.routines-form-tile');
            if (tile) tile.innerHTML = formIcon(isTask ? 'task' : 'report');
            const hint = container.querySelector('.routines-mode-hint');
            if (hint) {
                hint.textContent = isTask
                    ? 'Runs a multi-step task on its own. It can change your data; any step needing permission pauses and notifies you. Each run keeps its log here, under Run history.'
                    : 'Runs on your local model and posts each result to the Home feed. It cannot change anything.';
            }
        }));

        /* ── The trigger, written (U7) ────────────────────────────────────
           The line parses to the SAME hidden inputs and panes the form has
           always used, then says back what it understood. Nothing new is
           stored, and correcting a misread is picking the right pane —
           which is why they stay on the page. ─────────────────────────── */
        const whenInput = q('#prompt-mgr-when');
        const whenEcho = q('.routines-when-echo');
        const whenGo = q('.routines-when-go');

        const applyTrigger = (trig) => {
            q('#prompt-mgr-trigtype').value = trig.type;
            container.querySelectorAll('.prompt-mgr-trig-btn').forEach(b => {
                const on = b.dataset.trig === trig.type;
                b.classList.toggle('active', on);
                b.setAttribute('aria-pressed', String(on));
            });
            container.querySelectorAll('[data-trig-pane]').forEach(pane => {
                pane.hidden = pane.dataset.trigPane !== trig.type;
            });
            if (trig.type === 'time') {
                q('#prompt-mgr-interval').value = trig.interval;
                container.querySelectorAll('[data-trig-pane="time"] .prompt-mgr-seg-btn[data-value]').forEach(b => {
                    const on = b.dataset.value === trig.interval;
                    b.classList.toggle('active', on);
                    b.setAttribute('aria-pressed', String(on));
                });
                const clock = ['daily', 'weekdays', 'weekly'].includes(trig.interval);
                q('.prompt-mgr-time-row').hidden = !clock;
                if (clock && trig.time) q('#prompt-mgr-time').value = trig.time;
            } else if (trig.type === 'email') {
                q('#prompt-mgr-trig-from').value = trig.from || '';
                q('#prompt-mgr-trig-subject').value = trig.subject || '';
                q('#prompt-mgr-trig-contains').value = trig.contains || '';
            } else {
                q('#prompt-mgr-trig-folder').value = trig.folder || '';
                q('#prompt-mgr-trig-pattern').value = trig.pattern || '';
            }
            keep();
        };

        const readWhen = async () => {
            const said = (whenInput?.value || '').trim();
            if (!said) { whenInput?.focus(); return; }
            whenGo.disabled = true;
            whenGo.textContent = 'Reading…';
            whenEcho.hidden = false;
            whenEcho.className = 'routines-when-echo';
            whenEcho.textContent = 'Working out when that is…';
            const res = await PromptFeed.parseTrigger(said);
            whenGo.disabled = false;
            whenGo.textContent = 'Set';
            if (res.error) {
                whenEcho.className = 'routines-when-echo is-error';
                whenEcho.textContent = res.error;
                return;
            }
            applyTrigger(res.trigger);
            const label = NotePrompts.triggerLabel(NotePrompts.config({ prompt: {
                trigger: res.trigger,
                interval: res.trigger.type === 'time' ? res.trigger.interval : undefined,
                time: res.trigger.type === 'time' ? res.trigger.time : undefined
            } }));
            // U7: what it cannot express is NAMED. The nearest thing is
            // applied and the user is told what was dropped, because the
            // alternative — a routine quietly running daily when they said
            // "the first Monday of the month" — is the failure this line
            // would otherwise introduce.
            if (res.unsupported) {
                whenEcho.className = 'routines-when-echo is-warn';
                whenEcho.innerHTML = `I can&rsquo;t do <strong>${UIUtils.escapeHtml(res.unsupported)}</strong> &mdash; routines run on a clock, on arriving mail, or on a new file. Closest: <strong>${UIUtils.escapeHtml(label)}</strong>, set below.`;
            } else {
                whenEcho.className = 'routines-when-echo is-ok';
                whenEcho.innerHTML = `Set: <strong>${UIUtils.escapeHtml(label)}</strong>. Correct it below if that is not it.`;
            }
            // A trigger change invalidates the run the user saw (U2).
            staleRun();
        };

        whenGo?.addEventListener('click', readWhen);
        whenInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); readWhen(); }
        });

        /* ── Try it (U2) ──────────────────────────────────────────────────
           The preview runs the prompt as it stands in the form — not what
           is saved — so what the user reads is what arming would produce.
           Everything below is presentation; PromptFeed.preview owns the
           "changes nothing" half. ─────────────────────────────────────── */
        const panel = q('.routines-preview');
        const tryBtn = q('.prompt-mgr-try');
        const armBtn = q('.prompt-mgr-save');
        let lastOutput = '';       // what the repair loop reasons about
        let undoBody = null;       // the prompt text a rewrite replaced
        // The exact form contents the visible Arm button was earned by, so
        // an edit after the run can take it away again (U2).
        let armedFrom = null;
        let armExempt = false;     // no brain: arming is allowed untried

        // A prompt-note SHAPE built from the live form — the generators read
        // nothing else, so no record has to exist to try one.
        const formPrompt = () => {
            const now = formNow();
            if (!now) return null;
            return {
                id: note ? note.id : 'preview',
                title: now.title || 'Untitled routine',
                content: NotePrompts._bodyToHtml(now.body),
                prompt: {
                    ...NotePrompts.DEFAULTS,
                    target: cfg.target,
                    offline: true,
                    runMode: now.runMode === 'task' ? 'task' : 'digest',
                    interval: now.interval,
                    time: now.time || null,
                    web: now.runMode !== 'task' && now.web,
                    useContext: now.runMode !== 'task' && now.context
                }
            };
        };

        const showPanel = (html) => { panel.hidden = false; panel.innerHTML = html; };

        // The run the user saw no longer describes the form in front of
        // them, so the Arm button it earned goes away (U2). Called from the
        // form's own events AND from the repair loop, which changes the
        // prompt programmatically and therefore fires no input event — that
        // was a hole straight through the law.
        const staleRun = () => {
            if (armExempt || armBtn.hidden) return;
            armBtn.hidden = true;
            armedFrom = null;
            tryBtn.classList.replace('secondary-btn', 'primary-btn');
            const eyebrow = panel.querySelector('.routines-preview-eyebrow');
            if (eyebrow && !panel.hidden) eyebrow.textContent = 'That was the previous version';
        };

        const repairRow = () => `
            <div class="routines-preview-repair">
                <label class="routines-preview-repair-label" for="routine-repair-input">What should be different?</label>
                <div class="routines-preview-repair-row">
                    <input id="routine-repair-input" class="routines-trig-input" type="text" autocomplete="off"
                           placeholder="Shorter. Just the headlines. Skip the weather.">
                    <button class="secondary-btn routines-repair-go" type="button">Rewrite the prompt</button>
                </div>
                <p class="routines-form-hint">This edits the routine&rsquo;s instructions, not this one answer &mdash; then try it again.</p>
            </div>`;

        const renderResult = (res) => {
            const esc1 = UIUtils.escapeHtml;
            if (res.kind === 'error') {
                // No brain configured is the one case where U2 cannot be
                // satisfied at all, and a user who cannot try must still be
                // able to arm — otherwise the law bans routines outright.
                if (res.noBrain) { armBtn.hidden = false; armExempt = true; }
                showPanel(`
                    <div class="routines-preview-head"><span class="routines-preview-eyebrow">Did not run</span></div>
                    <p class="routines-preview-error">${esc1(res.error)}</p>
                    ${res.noBrain ? '<p class="routines-form-hint">You can still arm it &mdash; it will run once a model is set up.</p>' : ''}
                    <div class="routines-preview-actions"><button class="secondary-btn routines-try-again" type="button">Try again</button></div>`);
                return;
            }
            // A run happened in front of the user: arming is now allowed,
            // for exactly the form contents that produced it.
            armBtn.hidden = false;
            const nowSer = formNow();
            armedFrom = nowSer ? this._draftSer(nowSer) : null;
            if (res.kind === 'plan') {
                showPanel(`
                    <div class="routines-preview-head">
                        <span class="routines-preview-eyebrow">What it would do</span>
                        <span class="routines-preview-note">A plan only &mdash; nothing was run, nothing changed.</span>
                    </div>
                    <ol class="routines-preview-plan">${res.steps.map(st =>
                        `<li>${esc1(st.step)}${st.kind === 'foreach' ? ' <span class="routines-preview-each">for each item</span>' : ''}</li>`).join('')}</ol>
                    ${repairRow()}
                    <div class="routines-preview-actions"><button class="secondary-btn routines-try-again" type="button">Plan it again</button></div>`);
                lastOutput = res.steps.map(st => st.step).join('\n');
                return;
            }
            if (res.kind === 'quiet') {
                showPanel(`
                    <div class="routines-preview-head">
                        <span class="routines-preview-eyebrow">Nothing to report</span>
                    </div>
                    <p class="routines-preview-quiet">This run found nothing worth telling you${res.reason ? ' &mdash; ' + esc1(res.reason) : ''}, so it would post nothing. That is a working routine on a quiet day; try it again when there is something to find, or change the prompt.</p>
                    ${repairRow()}
                    <div class="routines-preview-actions"><button class="secondary-btn routines-try-again" type="button">Try again</button></div>`);
                lastOutput = '(the run had nothing to report)';
                return;
            }
            lastOutput = res.content;
            showPanel(`
                <div class="routines-preview-head">
                    <span class="routines-preview-eyebrow">What it wrote</span>
                    <span class="routines-preview-note">Not posted &mdash; this was a try.${res.model ? ' &middot; ' + esc1(PromptFeed._displayModel(res.model) || res.model) : ''}</span>
                </div>
                <div class="routines-preview-body ai-prose">${PromptFeed._format(res.content)}</div>
                ${repairRow()}
                <div class="routines-preview-actions"><button class="secondary-btn routines-try-again" type="button">Try again</button></div>`);
        };

        let previewing = false;
        const runPreview = async () => {
            const p = formPrompt();
            if (!p || !NotePrompts.bodyText(p).trim()) {
                UIUtils.showToast('Write the prompt first', 'error');
                q('#prompt-mgr-body')?.focus();
                return;
            }
            if (previewing) return;
            previewing = true;
            tryBtn.disabled = true;
            const isTask = NotePrompts.config(p).runMode === 'task';
            const started = Date.now();
            showPanel(`
                <div class="routines-preview-head">
                    <span class="routines-preview-eyebrow">${isTask ? 'Planning…' : 'Running…'}</span>
                    <span class="routines-preview-note routines-preview-elapsed">0s</span>
                </div>
                <p class="routines-form-hint">${isTask
                    ? 'Working out the steps it would take. Nothing is being run.'
                    : 'Running the prompt for real. Nothing is posted and nothing is armed yet.'}</p>
                ${isTask ? '' : '<div class="routines-preview-actions"><button class="secondary-btn routines-preview-stop" type="button">Stop</button></div>'}`);
            const tick = setInterval(() => {
                const el = panel.querySelector('.routines-preview-elapsed');
                if (el) el.textContent = Math.round((Date.now() - started) / 1000) + 's';
            }, 1000);
            panel.querySelector('.routines-preview-stop')?.addEventListener('click', () => {
                PromptFeed.stopCurrent?.();
            });
            let res;
            try { res = await PromptFeed.preview(p); }
            catch (e) { res = { kind: 'error', error: e?.message || 'The run failed' }; }
            clearInterval(tick);
            previewing = false;
            tryBtn.disabled = false;
            tryBtn.textContent = 'Try it again';
            if (!note) tryBtn.classList.replace('primary-btn', 'secondary-btn');
            renderResult(res);
        };

        tryBtn?.addEventListener('click', runPreview);
        panel?.addEventListener('click', (e) => {
            if (e.target.closest('.routines-try-again')) { runPreview(); return; }
            if (e.target.closest('.routines-repair-undo')) {
                if (undoBody == null) return;
                q('#prompt-mgr-body').value = undoBody;
                undoBody = null;
                keep();
                staleRun();
                e.target.closest('.routines-repair-done')?.remove();
                return;
            }
            if (e.target.closest('.routines-repair-go')) {
                const input = panel.querySelector('#routine-repair-input');
                const said = (input?.value || '').trim();
                if (!said) { input?.focus(); return; }
                const btn = e.target.closest('.routines-repair-go');
                btn.disabled = true;
                btn.textContent = 'Rewriting…';
                const before = q('#prompt-mgr-body').value;
                PromptFeed.repairPrompt({ body: before, output: lastOutput, note: said, title: q('#prompt-mgr-title').value })
                    .then(r => {
                        btn.disabled = false;
                        btn.textContent = 'Rewrite the prompt';
                        if (r.error) { UIUtils.showToast(r.error, 'error'); return; }
                        undoBody = before;
                        q('#prompt-mgr-body').value = r.body;
                        keep();
                        staleRun();
                        // U11: the change is visible (it is in the box the
                        // user is looking at) and undoable.
                        const row = panel.querySelector('.routines-preview-repair');
                        if (row) row.innerHTML = `
                            <div class="routines-repair-done">
                                <span>Prompt rewritten &mdash; read it above, then try it again.</span>
                                <button class="secondary-btn routines-repair-undo" type="button">Undo</button>
                            </div>`;
                        q('#prompt-mgr-body').scrollIntoView({ block: 'center', behavior: 'smooth' });
                    });
            }
        });
        panel?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.id === 'routine-repair-input') {
                e.preventDefault();
                panel.querySelector('.routines-repair-go')?.click();
            }
        });

        // Changing the prompt or the settings invalidates the run the user
        // saw, so a NEW routine has to be tried again before it can be
        // armed — otherwise "tried once, edited, armed" walks straight
        // around U2.
        if (!note) {
            const invalidate = () => {
                if (armBtn.hidden || armExempt || armedFrom == null) return;
                const now = formNow();
                if (!now) return;
                if (this._draftSer(now) !== armedFrom) staleRun();
            };
            formEl?.addEventListener('input', invalidate);
            formEl?.addEventListener('change', invalidate);
            formEl?.addEventListener('click', (e) => { if (e.target.closest('.prompt-mgr-seg-btn')) invalidate(); });
        }

        // Cmd/Ctrl+Enter from the prompt body saves — same muscle memory as
        // the assistant composer.
        container.querySelector('#prompt-mgr-body')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                // Before a run there is nothing to arm (U2), so the shortcut
                // does the thing the page is actually asking for.
                const save = container.querySelector('.prompt-mgr-save');
                if (save && !save.hidden) save.click();
                else container.querySelector('.prompt-mgr-try')?.click();
            }
        });

        container.querySelector('.prompt-mgr-save')?.addEventListener('click', () => {
            const t = container.querySelector('#prompt-mgr-title').value.trim();
            const b = container.querySelector('#prompt-mgr-body').value.trim();
            if (!b) { UIUtils.showToast('Add a prompt first', 'error'); return; }
            const interval = container.querySelector('#prompt-mgr-interval').value;
            const trigType = container.querySelector('#prompt-mgr-trigtype').value;
            const runMode = container.querySelector('#prompt-mgr-runmode').value === 'task' ? 'task' : 'digest';

            // Build the trigger from the pane that is showing. Refuse an
            // empty rule rather than silently falling back to a schedule —
            // the fallback exists for READING old records, and using it here
            // would hand someone a daily routine they never asked for.
            let trigger;
            if (trigType === 'email') {
                const from = container.querySelector('#prompt-mgr-trig-from').value.trim();
                const subject = container.querySelector('#prompt-mgr-trig-subject').value.trim();
                const contains = container.querySelector('#prompt-mgr-trig-contains').value.trim();
                if (!from && !subject && !contains) {
                    UIUtils.showToast('Add a sender, subject or message text to match', 'error');
                    return;
                }
                trigger = { type: 'email', from, subject, contains };
            } else if (trigType === 'file') {
                const folder = container.querySelector('#prompt-mgr-trig-folder').value.trim();
                if (!folder) {
                    UIUtils.showToast('Add a folder to watch', 'error');
                    return;
                }
                trigger = { type: 'file', folder, pattern: container.querySelector('#prompt-mgr-trig-pattern').value.trim() };
            } else {
                trigger = { type: 'time', interval };
            }

            if (runMode === 'task' && (typeof FEATURES === 'undefined' || !FEATURES.isEnabled('taskmode'))) {
                UIUtils.showToast('Task mode is off — this routine can only write you an answer', 'error');
                return;
            }

            // Everything created or edited on this page is a routine; the
            // run target only matters for saved prompts (edited in Notes),
            // so an existing one is carried through untouched.
            const config = {
                target: cfg.target,
                offline: true,
                runMode,
                trigger,
                interval,
                time: trigType === 'time' && ['daily', 'weekdays', 'weekly'].includes(interval)
                    ? (container.querySelector('#prompt-mgr-time').value || null) : null,
                web: runMode === 'digest' && container.querySelector('#prompt-mgr-web').checked,
                useContext: runMode === 'digest' && container.querySelector('#prompt-mgr-context').checked,
                // Creating a routine HERE arms it on this Mac; editing one
                // leaves its existing home alone (that is what the detail
                // page's "runs on another Mac" line reports).
                homeMachineId: note ? cfg.homeMachineId
                    : ((typeof RoutineEngine !== 'undefined' && RoutineEngine._machineId) || null)
            };
            const saved = note
                ? NotePrompts.update(note.id, { title: t, body: b, config })
                : NotePrompts.create({ title: t, body: b, config });
            // Nudge the scheduler so a newly created/enabled routine runs
            // soon instead of waiting for the next poll.
            if (typeof RoutineEngine !== 'undefined') {
                RoutineEngine.onRoutinesChanged();
            }
            // Saved for real: the draft has done its job.
            this._dropDraft(draftFor);
            if (typeof SaveStatus !== 'undefined') SaveStatus.unregister('routine');
            UIUtils.showToast(note ? 'Routine updated' : 'Routine created', 'success');
            this._view = 'detail';
            this._openId = saved ? saved.id : this._openId;
            this.render();
        });

        setTimeout(() => container.querySelector('#prompt-mgr-title')?.focus(), 0);
    },

    // --- Actions ---

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
    async _testTrigger(note, btn) {
        const box = document.querySelector('#prompts-main .routines-trigtest');
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
            `Delete &ldquo;${UIUtils.escapeHtml(note?.title || `this ${noun}`)}&rdquo;? This removes the ${noun} and stops its scheduled runs. Past feed posts stay.`,
            '🗑️',
            { confirmText: 'Delete' }
        );
        if (!ok) return;
        NotePrompts.remove(id);
        this._dropDraft(id);
        if (typeof PromptFeed !== 'undefined' && PromptFeed.render) PromptFeed.render();
        if (this._openId === id) { this._view = 'list'; this._openId = null; }
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
            `Mode: ${cfg.runMode === 'task' ? 'task (may act)' : 'digest (read-only post to the feed)'}\n` +
            `Prompt: ${body.slice(0, 400)}${body.length > 400 ? '…' : ''}\n` +
            `Use update_routine / delete_routine with this id for changes the user asks for.`
    };
};

if (typeof AgentContext !== 'undefined') {
    AgentContext.register('prompts', () => {
        if (PromptsApp._view !== 'detail' || !PromptsApp._openId) return null;
        return PromptsApp.routineContextBlock(PromptsApp._openId);
    });

    // Record resolver — rebuilds the CURRENT ROUTINE block from a
    // conversation's 'prompts:<id>' attachment when the chat is continued
    // away from the Routines page.
    AgentContext.registerRecord('prompts', (id) => PromptsApp.routineContextBlock(id, { attached: true }));
}

if (typeof module !== 'undefined' && module.exports) module.exports = PromptsApp;
