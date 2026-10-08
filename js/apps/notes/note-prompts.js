/**
 * NotePrompts — the routine store, as a facade over Standing chats.
 *
 * Since 2026-10-07 a routine is NOT a note. Its definition lives on its
 * Standing conversation in the synced `agent-conversations` blob:
 *
 *   conv.standing = { body, config }     // the prompt text and the run config
 *   conv.title                           // the routine's name
 *   conv.id                              // the routine's id (the old note id
 *                                        //   for migrated ones, so every
 *                                        //   `routine:<id>` / `prompts:<id>`
 *                                        //   key, raise and job still resolves)
 *
 * and a run's result is an assistant message in that chat carrying
 * `metadata.routineRun = { id, at, error, readAt }` (see `appendRun`).
 * Unread is the chat's: a run message with no `readAt`.
 *
 * Why: every reader of `notes` had to know two reserved templates, and the
 * Markdown projection (ContentFiles) did not, so routine prompts and run
 * posts were written to ~/nenva/Documents as if they were the person's
 * writing. A routine's prompt is what its chat is ABOUT; a run's result is
 * something the routine SAID — both are chat-shaped.
 *
 * The name and the API are kept on purpose: RoutineEngine, the routine
 * tools, the interview, ReviewRoutines, GoalInterview, Portfolio's strategy
 * page and VoiceService all read routines as records through `list()` /
 * `config()` / `bodyText()` and write them through `create()` / `update()`
 * / `remove()`. A record handed out here is a VIEW of the conversation
 * (`{ id, title, body, content, prompt, … }`), never the conversation
 * itself; every write goes through this module and the one save funnel
 * (AgentService._saveConversations), which stamps and tombstones.
 *
 * `migrateFromNotes` moves what the `notes` blob still holds (prompt notes
 * → conversations, feed notes → run messages, read marks kept) and
 * tombstones the notes out, so the projection removes their .md files by
 * its own deletion rule. It is idempotent by id and runs on every start.
 */

const NotePrompts = {
    DEFAULTS: {
        target: 'agent', offline: false, interval: 'daily', time: null, web: false, useContext: false,
        // C10 (the Automations merge). See config() for what each means.
        trigger: null, runMode: 'digest', homeMachineId: null, about: []
    },

    /** Run messages kept per routine (the feed's MAX_PER_PROMPT). */
    RUN_KEEP: 10,

    /* ───────────────────────── the store ───────────────────────── */

    _convs() {
        return (typeof AgentService !== 'undefined' && Array.isArray(AgentService.conversations))
            ? AgentService.conversations : [];
    },

    isStanding(conv) {
        return !!(conv && conv.standing && typeof conv.standing === 'object');
    },

    conversationOf(id) {
        return this._convs().find(c => c && c.id === id && this.isStanding(c)) || null;
    },

    /** The routine record a conversation stands for. */
    _record(conv) {
        const st = conv.standing || {};
        const body = typeof st.body === 'string' ? st.body : '';
        return {
            id: conv.id,
            title: conv.title || '',
            body,
            content: this._bodyToHtml(body),
            tags: [],
            template: 'prompt',
            prompt: st.config || {},
            pinned: false,
            createdAt: conv.createdAt || null,
            modifiedAt: conv.updatedAt || conv.createdAt || null
        };
    },

    /** Every routine (and saved prompt), as records. */
    list() {
        return this._convs().filter(c => this.isStanding(c)).map(c => this._record(c));
    },

    get(id) {
        const c = this.conversationOf(id);
        return c ? this._record(c) : null;
    },

    // One write per batch: the migration posts many runs and saves once.
    _hold: false,
    _save() {
        if (this._hold) { this._held = true; return; }
        if (typeof AgentService !== 'undefined' && AgentService._saveConversations) AgentService._saveConversations();
    },

    _newId() {
        return (typeof UIUtils !== 'undefined' && UIUtils.generateId) ? UIUtils.generateId()
            : ('routine_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
    },

    isPrompt(note) {
        return !!note && (note.template === 'prompt' || this.isStanding(note));
    },

    /** A routine is a prompt armed to run in the background. */
    isRoutine(note) {
        return this.isPrompt(note) && this.config(note).offline;
    },

    /**
     * Normalized run config for a record. Always returns a full object with
     * defaults so callers can read fields without guarding.
     */
    config(note) {
        const src = (note && note.standing && typeof note.standing === 'object') ? note.standing.config : (note && note.prompt);
        const p = (src && typeof src === 'object') ? src : {};
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
            // Dedicated consumer of the shared Slack observations. Preserved
            // even if malformed so execution fails closed, never as plain AI.
            slackWatch: p.slackWatch ? structuredClone(p.slackWatch) : null,
            // C10: what STARTS the run. Time is the original (and only)
            // trigger routines had, and it stays represented by the flat
            // interval/time fields above — so every routine written before
            // this change derives a valid trigger with no migration. Email
            // and file arrived with Automations (C8.5) and are stored as an
            // explicit object.
            trigger: this._trigger(p, interval, time),
            // C10: what the run is allowed to DO. 'digest' is a single
            // read-only turn that posts its answer to the chat; 'task' is a
            // full unattended team job that may write, each step
            // still going through the permission gates. Default 'digest' —
            // an unreadable or half-written record must not become one that
            // can act.
            runMode: p.runMode === 'task' ? 'task' : 'digest',
            // C10: the Mac that runs it. Null = unpinned (runs anywhere).
            homeMachineId: typeof p.homeMachineId === 'string' && p.homeMachineId ? p.homeMachineId : null,
            // What the routine is ABOUT: [{type, id}] in the same
            // '<type>:<id>' vocabulary RecordTypes and DecisionStore speak
            // (js/apps/prompts/routine-about.js).
            about: (typeof RoutineAbout !== 'undefined')
                ? RoutineAbout.normalize(p.about)
                : (Array.isArray(p.about) ? p.about.slice(0, 5) : [])
        };
    },

    /** Normalize the stored trigger, falling back to the flat time fields. */
    _trigger(p, interval, time) {
        const t = (p && p.trigger && typeof p.trigger === 'object') ? p.trigger : null;
        if (t && t.type === 'email') {
            const from = String(t.from || '').trim().slice(0, 120);
            const subject = String(t.subject || '').trim().slice(0, 120);
            // `contains` searches the whole message — subject, snippet, body.
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
     * Plain-text prompt body. A record from `list()` carries `body`; a
     * prompt-note shape (the preview's `{title, content, prompt}`, an old
     * note) is read from its HTML, whitespace collapsed.
     */
    bodyText(note) {
        if (!note) return '';
        if (typeof note.body === 'string') return note.body.trim();
        if (note.standing && typeof note.standing.body === 'string') return note.standing.body.trim();
        const html = note.content;
        if (!html) return '';
        if (typeof document === 'undefined') return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        // Treat block boundaries as line breaks before flattening so
        // multi-paragraph prompts don't run together into one line.
        tmp.querySelectorAll('p, div, br, h1, h2, h3, li').forEach(el => {
            el.appendChild(document.createTextNode('\n'));
        });
        return (tmp.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
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

    /* ---------- Run (a saved prompt, by hand) ---------- */

    /**
     * Pre-run compose dialog. Shows the stored prompt body and a textarea
     * for an optional extra message. Resolves with the final text to run
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
                        text: target === 'browser' ? 'Run as web search' : 'Run in Assistant',
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

    // Run the composed prompt as a web search in the user's own browser
    // (nenva has no browser of its own since 2026-09-20).
    async runInBrowser(note) {
        const text = (await this.composeRun(note, 'browser') || '').trim();
        if (!text) return;
        const url = /^https?:\/\//i.test(text)
            ? text
            : 'https://duckduckgo.com/?q=' + encodeURIComponent(text);
        AppManager.openExternal(url);
    },

    // Open the docked agent panel and paste the prompt. Not auto-sent so
    // the user can tweak before hitting Enter.
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

    runDefault(note) {
        if (this.config(note).target === 'browser') this.runInBrowser(note);
        else this.runInAgent(note);
    },

    /* ---------- Create / update / delete ---------- */

    // Plain text → minimal paragraph HTML, for readers that still want the
    // prompt as note-shaped `content`. Blank-safe.
    _bodyToHtml(body) {
        const esc = (s) => String(s || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const text = String(body || '').trim();
        if (!text) return '';
        return text.split(/\n{2,}/)
            .map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
            .join('');
    },

    _keys(title, id) {
        return { todayKey: `routine:${id}`, recordKey: `prompts:${id}`, recordLabel: title };
    },

    /**
     * Create a routine: a new Standing conversation. `config` is merged over
     * DEFAULTS and normalized. Returns the routine record.
     */
    create({ title, body, config, id = null, createdAt = null } = {}) {
        const cfg = this.config({ prompt: { ...this.DEFAULTS, ...(config || {}) } });
        const now = new Date().toISOString();
        const name = (title || '').trim() || 'Untitled prompt';
        const conv = {
            id: id || this._newId(),
            title: name,
            createdAt: createdAt || now,
            updatedAt: now,
            messages: [],
            standing: { body: String(body || '').trim(), config: cfg }
        };
        // The keys name the id, which may have just been minted.
        Object.assign(conv, this._keys(name, conv.id));
        const convs = this._convs();
        if (convs.some(c => c && c.id === conv.id)) return this.get(conv.id);
        convs.unshift(conv);
        this._save();
        return this._record(conv);
    },

    /**
     * Update a routine in place. Any of title/body/config may be omitted.
     * Returns the updated record, or null if not found.
     */
    update(id, { title, body, config } = {}) {
        const conv = this.conversationOf(id);
        if (!conv) return null;
        if (typeof title === 'string') {
            conv.title = title.trim() || 'Untitled prompt';
            conv.recordLabel = conv.title;
        }
        if (typeof body === 'string') conv.standing.body = body.trim();
        if (config) conv.standing.config = this.config({ prompt: { ...this.config(conv), ...config } });
        this._save();
        return this._record(conv);
    },

    /** Delete a routine (its chat and every run with it). True if one was removed. */
    remove(id) {
        const conv = this.conversationOf(id);
        if (!conv) return false;
        if (typeof AgentService !== 'undefined' && AgentService.deleteConversation) AgentService.deleteConversation(id);
        else {
            const convs = this._convs();
            const i = convs.indexOf(conv);
            if (i >= 0) convs.splice(i, 1);
            this._save();
        }
        return true;
    },

    /* ───────────────────────── runs ─────────────────────────
       A run's result is an assistant message in the routine's chat:
         { role: 'assistant', content: <markdown>, timestamp,
           metadata: { model, routineRun: { id, at, error, readAt } } }
       The card shape below is what the feed, Now and the detail read. */

    isRun(msg) {
        return !!(msg && msg.role === 'assistant' && msg.metadata && msg.metadata.routineRun
            && typeof msg.metadata.routineRun === 'object');
    },

    runCard(conv, msg) {
        const r = msg.metadata.routineRun;
        return {
            id: r.id,
            promptId: conv.id,
            promptTitle: conv.title || 'Untitled prompt',
            content: r.error ? '' : (msg.content || ''),
            error: r.error || null,
            model: (msg.metadata && msg.metadata.model) || null,
            read: !!r.readAt,
            readAt: r.readAt || null,
            createdAt: r.at || msg.timestamp || conv.updatedAt || null
        };
    },

    /** One routine's runs, newest first. */
    runs(id) {
        const conv = this.conversationOf(id);
        if (!conv) return [];
        return (conv.messages || []).filter(m => this.isRun(m)).map(m => this.runCard(conv, m))
            .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
    },

    /** Every run of every routine, newest first. */
    allRuns() {
        const out = [];
        for (const conv of this._convs()) {
            if (!this.isStanding(conv)) continue;
            for (const m of conv.messages || []) if (this.isRun(m)) out.push(this.runCard(conv, m));
        }
        return out.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
    },

    /** Where a run is: { conv, msg, index, card }, or null. */
    findRun(runId) {
        if (!runId) return null;
        for (const conv of this._convs()) {
            if (!this.isStanding(conv)) continue;
            const index = (conv.messages || []).findIndex(m => this.isRun(m) && m.metadata.routineRun.id === runId);
            if (index >= 0) return { conv, msg: conv.messages[index], index, card: this.runCard(conv, conv.messages[index]) };
        }
        return null;
    },

    /** Unread runs of a conversation (a failed run cannot be read, only cleared — it counts). */
    unreadRuns(conv) {
        return (conv && conv.messages || []).filter(m => this.isRun(m) && !m.metadata.routineRun.readAt).length;
    },

    /**
     * Keep the newest `keep` run messages; everything the person or the
     * assistant said in the chat stays. Pure: returns the kept messages and
     * the keys of the dropped ones (for `removedMessages`, so a stale copy
     * elsewhere cannot bring them back through the message union).
     */
    pruneRuns(messages, keep = this.RUN_KEEP) {
        const list = Array.isArray(messages) ? messages : [];
        const runs = list.filter(m => this.isRun(m))
            .sort((a, b) => (Date.parse(b.metadata.routineRun.at || b.timestamp || 0) || 0) - (Date.parse(a.metadata.routineRun.at || a.timestamp || 0) || 0));
        if (runs.length <= keep) return { messages: list, removed: [] };
        const drop = new Set(runs.slice(keep));
        const keys = this._messageKeys(list);
        const removed = [];
        const kept = list.filter((m, i) => { if (drop.has(m)) { removed.push(keys[i]); return false; } return true; });
        return { messages: kept, removed };
    },

    /** main's `_messageKeys`, the same identity: role + content + occurrence. */
    _messageKeys(messages) {
        const seen = new Map();
        return (Array.isArray(messages) ? messages : []).map(m => {
            const c = m && m.content;
            const base = (m && m.role || '') + '\u0000' + (typeof c === 'string' ? c : JSON.stringify(c ?? ''));
            const n = (seen.get(base) || 0) + 1;
            seen.set(base, n);
            return base + '\u0000' + n;
        });
    },

    /** A failed run's one line in the chat — code's, never the model's. */
    errorLine(error) {
        return `This run didn’t finish — ${String(error || 'the run failed').trim()}`;
    },

    /**
     * Post a run's result into the routine's chat. Prunes to RUN_KEEP,
     * saves through the funnel and repaints the chat if it is open.
     * Returns the run card, or null when the routine is gone.
     */
    appendRun(id, { content, error, model, at = null, runId = null, readAt = null } = {}) {
        const conv = this.conversationOf(id);
        if (!conv) return null;
        const now = at || new Date().toISOString();
        const run = { id: runId || this._newId(), at: now, error: error || null, readAt: readAt || null };
        const msg = {
            role: 'assistant',
            content: error ? this.errorLine(error) : String(content || ''),
            timestamp: now,
            metadata: { ...(model ? { model } : {}), routineRun: run }
        };
        conv.messages = Array.isArray(conv.messages) ? conv.messages : [];
        // A migrated run lands in time order; a live one is the newest.
        const stamp = Date.parse(now) || 0;
        let i = conv.messages.length;
        if (at) {
            while (i > 0) {
                const prev = conv.messages[i - 1];
                const pt = Date.parse((prev.metadata && prev.metadata.routineRun && prev.metadata.routineRun.at) || prev.timestamp || '') || 0;
                if (pt <= stamp) break;
                i--;
            }
        }
        conv.messages.splice(i, 0, msg);
        const pruned = this.pruneRuns(conv.messages);
        if (pruned.removed.length) {
            conv.messages = pruned.messages;
            conv.removedMessages = [...(conv.removedMessages || []), ...pruned.removed].slice(-200);
        }
        this._save();
        this._repaint(conv.id);
        return this.runCard(conv, msg);
    },

    _repaint(convId) {
        if (typeof AgentService === 'undefined' || AgentService.activeConversationId !== convId) return;
        AgentService.conversation = [...(this.conversationOf(convId) || { messages: [] }).messages];
        if (typeof AgentUI !== 'undefined' && AgentUI.renderMessages) { try { AgentUI.renderMessages(); } catch { /* not mounted */ } }
    },

    /** Opening a run reads it. Returns true if a mark was written. */
    markRunRead(runId) {
        const hit = this.findRun(runId);
        if (!hit || hit.msg.metadata.routineRun.readAt) return false;
        hit.msg.metadata.routineRun.readAt = new Date().toISOString();
        this._save();
        return true;
    },

    /** Opening the chat reads every run in it. */
    markRunsRead(convId) {
        const conv = this.conversationOf(convId);
        if (!conv) return 0;
        const now = new Date().toISOString();
        let n = 0;
        for (const m of conv.messages || []) {
            if (this.isRun(m) && !m.metadata.routineRun.readAt) { m.metadata.routineRun.readAt = now; n++; }
        }
        if (n) this._save();
        return n;
    },

    /** Remove one run from its chat (an error card's ×). */
    removeRun(runId) {
        const hit = this.findRun(runId);
        if (!hit) return false;
        const keys = this._messageKeys(hit.conv.messages);
        hit.conv.messages.splice(hit.index, 1);
        hit.conv.removedMessages = [...(hit.conv.removedMessages || []), keys[hit.index]].slice(-200);
        this._save();
        this._repaint(hit.conv.id);
        return true;
    },

    /* ───────────────────── migration from notes ─────────────────────
       Prompt notes → Standing conversations (same id), feed notes → run
       messages (readAt kept), the notes tombstoned out of `notes` so the
       Markdown projection removes their files by its own deletion rule.
       A backup of every moved note is written first (`routines-move-
       backup`). Idempotent by id; safe to run on every start. */

    BACKUP_KEY: 'routines-move-backup',

    migrateFromNotes() {
        if (typeof StorageManager === 'undefined' || typeof AgentService === 'undefined') return { moved: 0 };
        const d = StorageManager.get('notes');
        const notes = (d && Array.isArray(d.notes)) ? d.notes : [];
        const isPromptNote = (n) => n && n.template === 'prompt';
        const isFeedNote = (n) => n && (n.template === 'feed' || (n.feed && typeof n.feed === 'object'));
        const moving = notes.filter(n => isPromptNote(n) || isFeedNote(n));
        if (!moving.length) return { moved: 0 };

        // Backup first — every record, verbatim, once per note id.
        try {
            const prev = StorageManager.get(this.BACKUP_KEY) || {};
            const have = new Set((prev.notes || []).map(n => n && n.id));
            const add = moving.filter(n => !have.has(n.id));
            if (add.length) StorageManager.set(this.BACKUP_KEY, { at: new Date().toISOString(), notes: [...(prev.notes || []), ...add] });
        } catch (e) { console.warn('[routines] backup failed, not moving:', e?.message || e); return { moved: 0, error: 'backup' }; }

        const convs = this._convs();
        const report = { moved: 0, routines: 0, runs: 0, orphans: 0, unverified: 0 };
        const adopted = new Set();
        this._hold = true;
        try {

        // 1. Prompt notes → Standing conversations, same id. A saved prompt
        //    that was never scheduled and never ran does NOT become a
        //    routine (2026-10-07, Ram: "those prompts can go away"): it
        //    leaves Notes like the rest, and the backup above keeps its
        //    words, but it is not listed anywhere. One with past results
        //    keeps its chat, so its runs are not orphaned.
        const hasRuns = new Set(moving.filter(isFeedNote).map(n => n.feed && n.feed.promptId).filter(Boolean));
        for (const n of moving.filter(isPromptNote)) {
            if (convs.some(c => c && c.id === n.id)) continue;
            if (!this.config(n).offline && !hasRuns.has(n.id)) { report.dropped = (report.dropped || 0) + 1; continue; }
            const body = this._promptText(n.content || '');
            const conv = {
                id: n.id, title: (n.title || '').trim() || 'Untitled prompt',
                createdAt: n.createdAt || new Date().toISOString(), updatedAt: n.modifiedAt || n.createdAt || new Date().toISOString(),
                messages: [], standing: { body, config: this.config(n) }, ...this._keys((n.title || '').trim() || 'Untitled prompt', n.id)
            };
            // An edit chat already tied to this routine IS its chat: its
            // turns come along, and it leaves the list (tombstoned by the
            // funnel) so one routine has one conversation.
            const edit = convs.filter(c => c && c.todayKey === `routine:${n.id}` && !this.isStanding(c) && !c.private);
            for (const e of edit) {
                conv.messages.push(...(e.messages || []));
                adopted.add(e.id);
            }
            convs.unshift(conv);
            report.routines++;
        }
        if (adopted.size) {
            for (let i = convs.length - 1; i >= 0; i--) if (adopted.has(convs[i].id)) convs.splice(i, 1);
        }

        // 2. Feed notes → run messages on their routine's chat (or, for a
        //    routine already deleted, a quiet unarmed one named by the title).
        const have = new Set(this.allRuns().map(r => r.id));
        for (const n of moving.filter(isFeedNote).sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0))) {
            if (have.has(n.id)) continue;
            const f = n.feed || {};
            let routineId = f.promptId && this.conversationOf(f.promptId) ? f.promptId : null;
            if (!routineId) {
                const title = (n.title || '').trim() || 'Untitled prompt';
                routineId = 'routine_past_' + this._slug(title);
                if (!this.conversationOf(routineId)) {
                    this.create({ id: routineId, title, body: '', config: { offline: false }, createdAt: n.createdAt || null });
                    report.orphans++;
                }
            }
            let content = '';
            let unverified = false;
            if (!f.error) {
                content = this.htmlToMarkdown(n.content || '');
                if (!this.roundTrips(n.content || '', content)) { unverified = true; report.unverified++; }
            }
            const card = this.appendRun(routineId, {
                content, error: f.error || null, model: f.model || null,
                at: n.createdAt || null, runId: n.id, readAt: f.readAt || null
            });
            // The words did not all survive the conversion: keep the original
            // beside the message so nothing is lost (the backup holds it too).
            if (card && unverified) {
                const hit = this.findRun(n.id);
                if (hit) hit.msg.metadata.routineRun.html = n.content || '';
            }
            have.add(n.id);
            report.runs++;
        }

        } finally { this._hold = false; }

        // 3. Out of the notes blob, with tombstones.
        const gone = new Set(moving.map(n => n.id));
        const at = new Date().toISOString();
        const tombstones = {};
        for (const id of gone) tombstones[id] = at;
        StorageManager.set('notes', { notes: notes.filter(n => !gone.has(n.id)), tombstones });
        if (typeof NotesApp !== 'undefined' && Array.isArray(NotesApp.notes)) NotesApp.notes = NotesApp.notes.filter(n => !gone.has(n.id));
        this._save();
        report.moved = moving.length;
        console.log(`[routines] moved ${report.routines} routine(s) and ${report.runs} run(s) out of notes` + (report.unverified ? ` (${report.unverified} kept their original text)` : '')
            + (report.dropped ? `; ${report.dropped} unscheduled saved prompt(s) left to the backup` : ''));
        return report;
    },

    /**
     * A prompt note's HTML as the plain text it was written as: paragraphs
     * apart by a blank line, a line break kept as one, entities decoded.
     * (bodyText flattens every block to one newline, which is fine for
     * running a prompt and wrong for keeping one.)
     */
    _promptText(html) {
        if (!html) return '';
        if (typeof document === 'undefined') return String(html).replace(/<\/p>/gi, '\n\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
        const root = document.createElement('div');
        root.innerHTML = html;
        const blocks = [];
        const text = (el) => {
            let out = '';
            for (const c of el.childNodes) {
                if (c.nodeType === 3) out += c.nodeValue;
                else if (c.nodeType === 1 && c.tagName === 'BR') out += '\n';
                else if (c.nodeType === 1) out += text(c);
            }
            return out;
        };
        for (const c of root.childNodes) {
            if (c.nodeType === 1 && /^(P|DIV|H[1-6]|BLOCKQUOTE|PRE)$/.test(c.tagName)) blocks.push(text(c).trim());
            else if (c.nodeType === 1 && /^(UL|OL)$/.test(c.tagName)) blocks.push([...c.children].map(li => '- ' + text(li).trim()).join('\n'));
            else { const t = (c.nodeType === 3 ? c.nodeValue : text(c)).trim(); if (t) blocks.push(t); }
        }
        return blocks.filter(Boolean).join('\n\n').trim();
    },

    _slug(s) {
        let h = 0;
        const t = String(s || '').toLowerCase();
        for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
        return t.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + h.toString(36);
    },

    /** Every word of the HTML's text is in the Markdown's. */
    roundTrips(html, md) {
        const words = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
        // Text nodes one by one: `textContent` glues adjacent cells and list
        // items into one word ("TickerMove"), which no Markdown contains.
        const htmlText = typeof document !== 'undefined'
            ? (() => {
                const t = document.createElement('div');
                t.innerHTML = html;
                const parts = [];
                const walker = document.createTreeWalker(t, 4 /* NodeFilter.SHOW_TEXT */);
                for (let node = walker.nextNode(); node; node = walker.nextNode()) parts.push(node.nodeValue);
                return parts.join(' ');
            })()
            : String(html).replace(/<[^>]+>/g, ' ');
        const want = words(htmlText);
        if (!want.length) return true;
        const got = new Set(words(md));
        return want.every(w => got.has(w));
    },

    /**
     * Stored note HTML (what AgentUI.formatContent wrote once at post time)
     * back to Markdown, so the chat renders it through the same formatter
     * every answer goes through. Headings, paragraphs, lists (nested),
     * emphasis, links, code, quotes, rules and tables are carried; the
     * text of anything else is kept as a paragraph.
     */
    htmlToMarkdown(html) {
        if (!html) return '';
        if (typeof document === 'undefined') return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const root = document.createElement('div');
        root.innerHTML = html;
        const inline = (node) => {
            let out = '';
            for (const c of node.childNodes) {
                if (c.nodeType === 3) { out += c.textContent.replace(/\s+/g, ' '); continue; }
                if (c.nodeType !== 1) continue;
                const tag = c.tagName.toLowerCase();
                const inner = inline(c);
                if (tag === 'br') out += '\n';
                else if (tag === 'strong' || tag === 'b') out += inner.trim() ? `**${inner.trim()}**` : inner;
                else if (tag === 'em' || tag === 'i') out += inner.trim() ? `*${inner.trim()}*` : inner;
                else if (tag === 'code') out += '`' + c.textContent + '`';
                else if (tag === 'a') { const href = c.getAttribute('href') || ''; out += href && /^https?:|^anjadhe:|^mailto:/i.test(href) ? `[${inner.trim() || href}](${href})` : inner; }
                else if (tag === 'del' || tag === 's') out += `~~${inner}~~`;
                else out += inner;
            }
            return out;
        };
        const blocks = [];
        const walk = (node, depth = 0) => {
            for (const c of node.childNodes) {
                if (c.nodeType === 3) { const t = c.textContent.trim(); if (t) blocks.push(t); continue; }
                if (c.nodeType !== 1) continue;
                const tag = c.tagName.toLowerCase();
                if (/^h[1-6]$/.test(tag)) blocks.push('#'.repeat(Number(tag[1])) + ' ' + inline(c).trim());
                else if (tag === 'p') { const t = inline(c).trim(); if (t) blocks.push(t); }
                else if (tag === 'ul' || tag === 'ol') blocks.push(this._listMd(c, depth, inline));
                else if (tag === 'pre') blocks.push('```\n' + c.textContent.replace(/\n$/, '') + '\n```');
                else if (tag === 'blockquote') blocks.push(this.htmlToMarkdown(c.innerHTML).split('\n').map(l => '> ' + l).join('\n'));
                else if (tag === 'hr') blocks.push('---');
                else if (tag === 'table') blocks.push(this._tableMd(c, inline));
                else if (tag === 'div' || tag === 'section' || tag === 'article' || tag === 'body') walk(c, depth);
                else { const t = inline(c).trim(); if (t) blocks.push(t); }
            }
        };
        walk(root);
        return blocks.filter(Boolean).join('\n\n').replace(/[ \t]+\n/g, '\n').trim();
    },

    _listMd(list, depth, inline) {
        const ordered = list.tagName.toLowerCase() === 'ol';
        const lines = [];
        let n = 0;
        for (const li of list.children) {
            if (li.tagName.toLowerCase() !== 'li') continue;
            n++;
            const own = document.createElement('span');
            const subs = [];
            for (const c of li.childNodes) {
                if (c.nodeType === 1 && /^(ul|ol)$/i.test(c.tagName)) subs.push(c);
                else own.appendChild(c.cloneNode(true));
            }
            const text = inline(own).replace(/\s*\n\s*/g, ' ').trim();
            lines.push('  '.repeat(depth) + (ordered ? `${n}. ` : '- ') + text);
            for (const s of subs) lines.push(this._listMd(s, depth + 1, inline));
        }
        return lines.join('\n');
    },

    _tableMd(table, inline) {
        const rows = [...table.querySelectorAll('tr')].map(tr =>
            [...tr.children].map(td => inline(td).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()));
        if (!rows.length) return '';
        const width = Math.max(...rows.map(r => r.length));
        const pad = (r) => { while (r.length < width) r.push(''); return r; };
        const line = (r) => '| ' + pad(r).join(' | ') + ' |';
        const [head, ...body] = rows;
        return [line(head), '| ' + Array(width).fill('---').join(' | ') + ' |', ...body.map(line)].join('\n');
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = NotePrompts;
