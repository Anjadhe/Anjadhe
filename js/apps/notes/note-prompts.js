/**
 * Note Prompts — prompt-template helpers shared across the app.
 *
 * A "prompt" is a note with `template === 'prompt'`. Its prompt *body* is the
 * note's rich-text content (read as plain text when run), and its run config
 * lives in a nested `note.prompt = { target, offline, interval, time, web }` object
 * — analogous to how the book template stores `bookNumbered`/`bookLayout`.
 *
 * This module centralizes everything prompt-specific that more than one caller
 * needs (the Notes editor, the background PromptFeed scheduler, and the Browse
 * prompts shelf) so the logic isn't re-implemented three times:
 *   - detecting prompt notes and reading their config
 *   - extracting the runnable body text from the note's HTML
 *   - listing prompt notes straight from the `notes` storage blob
 *   - the Run-in-Agent / Run-in-Browser actions (ported from the old
 *     standalone PromptsApp)
 */

const NotePrompts = {
    DEFAULTS: {
        target: 'agent', offline: false, interval: 'daily', time: null, web: false, useContext: false,
        // C10 (the Automations merge). See config() for what each means.
        trigger: null, runMode: 'digest', homeMachineId: null
    },

    isPrompt(note) {
        return !!note && NoteTemplates.resolve(note) === 'prompt';
    },

    /** A routine is a prompt note armed to run in the background. */
    isRoutine(note) {
        return this.isPrompt(note) && this.config(note).offline;
    },

    /**
     * Normalized run config for a note. Always returns a full object with
     * defaults so callers can read fields without guarding.
     */
    config(note) {
        const p = (note && note.prompt && typeof note.prompt === 'object') ? note.prompt : {};
        const interval = ['hourly', '6h', 'daily', 'weekdays', 'weekly'].includes(p.interval) ? p.interval : 'daily';
        // Optional preferred run time (24h "HH:MM") for daily/weekdays/
        // weekly schedules — "every morning" means 08:00, not "24h since
        // the last run". Null = interval-only (legacy behavior).
        const time = /^([01]?\d|2[0-3]):[0-5]\d$/.test(p.time || '') ? p.time : null;
        return {
            target: p.target === 'browser' ? 'browser' : 'agent',
            offline: !!p.offline,
            interval,
            time,
            web: !!p.web,
            // When on, scheduled offline runs go through the AI Assistant with
            // the user's full personalized context (memory, goals, schedule…)
            // instead of the bare prompt. See PromptFeed._generateWithAssistant.
            useContext: !!p.useContext,
            // C10: what STARTS the run. Time is the original (and only)
            // trigger routines had, and it stays represented by the flat
            // interval/time fields above — so every routine written before
            // this change derives a valid trigger with no migration. Email
            // and file arrived with Automations (C8.5) and are stored as an
            // explicit object.
            trigger: this._trigger(p, interval, time),
            // C10: what the run is allowed to DO. 'digest' is a single
            // read-only turn that posts its answer to the feed; 'task' is a
            // full unattended TaskService run that may write, each step
            // still going through the permission gates. Default 'digest' —
            // an unreadable or half-written record must not become one that
            // can act.
            runMode: p.runMode === 'task' ? 'task' : 'digest',
            // C10: the Mac that runs it. The record syncs so every Mac can
            // SEE and edit the routine; only its home Mac ticks it, because
            // merge happens on startup/refresh and two Macs awake at 07:00
            // would otherwise both fire. Null = unpinned (runs anywhere) —
            // the state every pre-C10 routine is in.
            // (`voiceId` — a digest's Writing Voice — was dropped 2026-09-02
            // with custom voices; a stored value is simply ignored.)
            homeMachineId: typeof p.homeMachineId === 'string' && p.homeMachineId ? p.homeMachineId : null
        };
    },

    /** Normalize the stored trigger, falling back to the flat time fields. */
    _trigger(p, interval, time) {
        const t = (p && p.trigger && typeof p.trigger === 'object') ? p.trigger : null;
        if (t && t.type === 'email') {
            const from = String(t.from || '').trim().slice(0, 120);
            const subject = String(t.subject || '').trim().slice(0, 120);
            // `contains` searches the whole message — subject, snippet, body.
            // "an email with an invoice in it" is how people describe an
            // email trigger, and from/subject alone could not express it.
            const contains = String(t.contains || '').trim().slice(0, 120);
            // A match rule with nothing to match fires on every incoming
            // email. Fall through to the schedule rather than doing that.
            if (from || subject || contains) {
                const clean = { type: 'email' };
                if (from) clean.from = from;
                if (subject) clean.subject = subject;
                if (contains) clean.contains = contains;
                return clean;
            }
        } else if (t && t.type === 'file') {
            const folder = String(t.folder || '').trim();
            if (folder) {
                const clean = { type: 'file', folder: folder.slice(0, 300) };
                if (t.pattern) clean.pattern = String(t.pattern).trim().slice(0, 80);
                return clean;
            }
        }
        return { type: 'time', interval, time };
    },

    /** Human sentence for any trigger: what makes this routine run. */
    triggerLabel(cfg) {
        const t = (cfg && cfg.trigger) || { type: 'time' };
        if (t.type === 'email') {
            const bits = [];
            if (t.from) bits.push(`from "${t.from}"`);
            if (t.subject) bits.push(`subject "${t.subject}"`);
            if (t.contains) bits.push(`mentioning "${t.contains}"`);
            return `new email ${bits.join(', ')}`;
        }
        if (t.type === 'file') {
            return `new file in ${t.folder}${t.pattern ? ` (${t.pattern})` : ''}`;
        }
        return this.scheduleLabel(cfg);
    },

    /**
     * Plain-text prompt body from the note's HTML content, whitespace
     * collapsed. This is what actually gets run / searched / pasted.
     */
    bodyText(note) {
        const html = note && note.content;
        if (!html) return '';
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        // Treat block boundaries as line breaks before flattening so
        // multi-paragraph prompts don't run together into one line.
        tmp.querySelectorAll('p, div, br, h1, h2, h3, li').forEach(el => {
            el.appendChild(document.createTextNode('\n'));
        });
        return (tmp.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    },

    /** All prompt notes straight from the `notes` blob (storage source of truth). */
    list() {
        const d = (typeof StorageManager !== 'undefined') ? StorageManager.get('notes') : null;
        const notes = (d && Array.isArray(d.notes)) ? d.notes : [];
        return notes.filter(n => this.isPrompt(n));
    },

    intervalLabel(interval) {
        return ({ hourly: 'hourly', '6h': 'every 6h', daily: 'daily', weekdays: 'weekdays', weekly: 'weekly' })[interval] || 'daily';
    },

    /** "8:00 AM" from a 24h "HH:MM" string (empty string if invalid). */
    timeLabel(hhmm) {
        const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm || '');
        if (!m) return '';
        const h = parseInt(m[1], 10);
        return `${h % 12 || 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
    },

    /** Full human schedule for a config: "daily at 8:00 AM" / "every 6h". */
    scheduleLabel(cfg) {
        const base = this.intervalLabel(cfg && cfg.interval);
        const timed = cfg && ['daily', 'weekdays', 'weekly'].includes(cfg.interval);
        const t = timed ? this.timeLabel(cfg.time) : '';
        return t ? `${base} at ${t}` : base;
    },

    /* ---------- Run ---------- */

    /**
     * Pre-run compose dialog. Shows the stored prompt body and a textarea
     * for an optional extra message — so a prompt can hold reusable context
     * and the user asks the actual question at run time. Resolves with the
     * final text to run (body, plus the extra appended after a blank line)
     * or null if the user cancels.
     */
    composeRun(note, target) {
        const body = this.bodyText(note);
        if (!body) return Promise.resolve(null);
        return new Promise((resolve) => {
            let settled = false;
            const finish = (val) => { if (!settled) { settled = true; resolve(val); } };

            const wrap = document.createElement('div');
            wrap.className = 'note-prompt-compose';
            wrap.innerHTML = `
                <div class="note-prompt-compose-preview"></div>
                <label class="note-prompt-compose-label" for="note-prompt-compose-extra">Add a message (optional)</label>
                <textarea id="note-prompt-compose-extra" class="note-prompt-compose-extra" rows="3"
                          placeholder="Appended after the prompt — e.g. a question about this context"></textarea>
            `;
            wrap.querySelector('.note-prompt-compose-preview').textContent = body;

            const run = () => {
                const extra = wrap.querySelector('textarea').value.trim();
                finish(extra ? `${body}\n\n${extra}` : body);
                modal.close();
            };
            const modal = Modal.create({
                title: note.title || 'Run Prompt',
                className: 'note-prompt-compose-dialog',
                content: wrap,
                onClose: () => finish(null),
                buttons: [
                    { text: 'Cancel', className: 'secondary-btn', onClick: () => modal.close() },
                    {
                        text: target === 'browser' ? 'Run in Browser' : 'Run in Assistant',
                        className: 'primary-btn',
                        onClick: run
                    }
                ]
            });

            const ta = wrap.querySelector('textarea');
            ta.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); }
            });
            setTimeout(() => ta.focus(), 0);
        });
    },

    // Submit the prompt through the browser's address bar so the
    // configured search engine + history recording all happen.
    async runInBrowser(note) {
        const text = await this.composeRun(note, 'browser');
        if (!text) return;
        AppManager.openApp('browse');
        setTimeout(() => {
            if (typeof BrowseApp !== 'undefined' && BrowseApp._submitUrl) {
                BrowseApp._submitUrl(text);
            }
        }, 50);
    },

    // Open the docked agent panel and paste the prompt. We don't auto-send
    // so the user can tweak before hitting Enter.
    async runInAgent(note) {
        const text = await this.composeRun(note, 'agent');
        if (!text) return;
        if (typeof AgentUI === 'undefined' || !AgentUI.open) return;
        AgentUI.open();
        setTimeout(() => {
            const input = document.getElementById('agent-input');
            if (!input) return;
            input.value = text;
            input.focus();
            input.dispatchEvent(new Event('input', { bubbles: true }));
            try {
                const end = text.length;
                input.setSelectionRange(end, end);
            } catch {}
        }, 320);
    },

    // Run the default target for a note (used by list/shelf single-click).
    runDefault(note) {
        if (this.config(note).target === 'browser') this.runInBrowser(note);
        else this.runInAgent(note);
    },

    /* ---------- Create / update / delete ----------
     *
     * Prompt notes are part of the shared `notes` blob, so these read it as the
     * source of truth (matching list()), mutate, and write back — then sync the
     * Notes app's in-memory copy if it's been loaded so the editor doesn't go
     * stale. This lets the Prompt Feed's "Manage prompts" UI create and edit
     * prompts without bouncing the user into the Notes app.
     */

    _readNotes() {
        const d = (typeof StorageManager !== 'undefined') ? StorageManager.get('notes') : null;
        return (d && Array.isArray(d.notes)) ? d.notes : [];
    },

    /**
     * Persist the notes array. `tombstones` ({id: deletedAtISO}) marks notes
     * REMOVED by this write — sync merges notes per record across Macs, so a
     * removal without a tombstone simply resurrects from the other copy (or
     * from this Mac's own store, since writes union with what is stored).
     * The store layer carries earlier tombstones forward; each writer only
     * declares the ids it deletes now.
     */
    _writeNotes(notes, tombstones = null) {
        StorageManager.set('notes', tombstones ? { notes, tombstones } : { notes });
        // Keep the Notes app coherent if it has already loaded its list.
        if (typeof NotesApp !== 'undefined' && Array.isArray(NotesApp.notes)) {
            NotesApp.notes = notes;
        }
        if (typeof AppManager !== 'undefined' && AppManager.updateStats) AppManager.updateStats();
    },

    // Plain text → minimal paragraph HTML for the note body (mirrors the
    // prompts→notes migration so feed-authored prompts match editor-authored
    // ones). Blank-safe.
    _bodyToHtml(body) {
        const esc = (s) => String(s || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const text = String(body || '').trim();
        if (!text) return '';
        return text.split(/\n{2,}/)
            .map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
            .join('');
    },

    /**
     * Create a new prompt note. `config` is merged over DEFAULTS and normalized.
     * Returns the created note.
     */
    create({ title, body, config } = {}) {
        const cfg = this.config({ prompt: { ...this.DEFAULTS, ...(config || {}) } });
        const now = new Date().toISOString();
        const note = {
            id: (typeof UIUtils !== 'undefined') ? UIUtils.generateId() : ('note_' + Date.now()),
            title: (title || '').trim() || 'Untitled prompt',
            content: this._bodyToHtml(body),
            tags: [],
            template: 'prompt',
            prompt: cfg,
            pinned: false,
            createdAt: now,
            modifiedAt: now
        };
        const notes = this._readNotes();
        notes.unshift(note);
        this._writeNotes(notes);
        return note;
    },

    /**
     * Update an existing prompt note in place. Any of title/body/config may be
     * omitted to leave them unchanged. Returns the updated note, or null if not
     * found.
     */
    update(id, { title, body, config } = {}) {
        const notes = this._readNotes();
        const note = notes.find(n => n && n.id === id);
        if (!note) return null;
        if (typeof title === 'string') note.title = title.trim() || 'Untitled prompt';
        if (typeof body === 'string') note.content = this._bodyToHtml(body);
        if (config) note.prompt = this.config({ prompt: { ...this.config(note), ...config } });
        note.modifiedAt = new Date().toISOString();
        this._writeNotes(notes);
        return note;
    },

    /** Delete a prompt note by id. Returns true if one was removed. */
    remove(id) {
        const notes = this._readNotes();
        const next = notes.filter(n => !(n && n.id === id));
        if (next.length === notes.length) return false;
        this._writeNotes(next, { [id]: new Date().toISOString() });
        return true;
    }
};
