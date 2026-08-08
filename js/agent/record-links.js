/**
 * RecordLinks — inline deep links in AI-written content (2026-08-05).
 *
 * The model cites a record it read through a tool as a plain markdown link
 * with the app's own scheme — [Pay water bill](anjadhe://task/abc123) — and
 * every surface that renders model markdown through AgentUI.formatContent
 * (assistant chat, routine digest posts on the Home feed, News summaries,
 * assistant-written notes, plus the Run history <pre> via
 * linkifyEscapedText) shows it as a clickable inline link (plain text
 * geometry — see .record-link in components.css) that opens the record
 * itself: the task in Actions, the event in Calendar, the insight in
 * Email AI, the message in the Inbox.
 *
 * Division of labor, the HelpActions split applied to inline content:
 *  - The MENTION is the model's — it decides what to cite and links it, so
 *    the grammar has to be one a 12B model already knows (a markdown link;
 *    no new syntax). Ids must come from tool results — the system prompt
 *    says so, and a link whose id resolves to nothing gets a "no longer
 *    here" toast rather than stranding the user in the wrong app.
 *  - The NAVIGATION is this registry's, one entry per type, each reusing
 *    the app's own deep-link door (the openApp + consume-once idiom, or
 *    the same editors AgentUI._openRecord drives).
 *  - Links NAVIGATE, never mutate (HelpActions rule 1 verbatim): a link in
 *    a digest takes you to the task; completing it happens on the page.
 *
 * Rendering happens inside AgentUI.formatContent's escape pipeline: label
 * and id arrive HTML-escaped and the id rides a data attribute on an
 * <a href="#">, which ONE document-level delegated handler (init) resolves.
 * That is what makes this horizontal: feed notes bake their HTML at post
 * time, the Notes viewer re-renders stored HTML, chat re-renders on every
 * open — the anchors survive all of it and no surface needs its own wiring.
 * (The existing http(s) click handlers in agent-ui/prompt-feed ignore
 * these anchors — their /^https?:/ test returns before preventDefault —
 * so the two delegations cannot fight over a click.)
 */
const RecordLinks = {

    // The app's navigation idiom: switch views, then run the deep-link on a
    // later tick (openApp renders synchronously, but each app's own page
    // render can queue work behind it). Same shape as HelpActions._into.
    _into(appName, then) {
        if (typeof AppManager === 'undefined') return;
        AppManager.openApp(appName, false);
        if (then) setTimeout(() => { try { then(); } catch { /* view not ready */ } }, 50);
    },

    /**
     * One entry per linkable type. `exists` is tri-state: true/false when
     * the answer is knowable synchronously from the store, null when it
     * isn't (email/insight before EmailApp.loadData; a calendar cache that
     * hasn't filled) — null navigates anyway and lets the app's own
     * missing-id handling degrade to its list view. Only a definite false
     * blocks the click, because "that task is gone" is better said in a
     * toast than by dumping the user on an unrelated page.
     */
    TYPES: {
        task: {
            label: 'task',
            exists: (id) => ((StorageManager.get('schedule')?.scheduleItems) || [])
                .some(i => i && String(i.id) === String(id)),
            open(id) { RecordLinks._into('schedule', () => typeof ScheduleApp !== 'undefined' && ScheduleApp.openEditor?.(id)); }
        },
        event: {
            label: 'event',
            // Calendar events live in memory, not a blob — an unloaded or
            // legitimately empty cache reads as unknown, never as missing.
            exists: (id) => (typeof CalendarApp !== 'undefined' && (CalendarApp.events || []).length)
                ? CalendarApp.events.some(e => e && String(e.id) === String(id))
                : null,
            open(id) { RecordLinks._into('calendar', () => typeof CalendarApp !== 'undefined' && CalendarApp.openEventById?.(id)); }
        },
        note: {
            label: 'note',
            exists: (id) => ((StorageManager.get('notes')?.notes) || [])
                .some(n => n && String(n.id) === String(id)),
            open(id) { RecordLinks._into('notes', () => typeof NotesApp !== 'undefined' && NotesApp.openEditor?.(id)); }
        },
        goal: {
            label: 'goal',
            exists: (id) => ((StorageManager.get('goals')?.goals) || [])
                .some(g => g && String(g.id) === String(id)),
            open(id) { RecordLinks._into('goals', () => typeof GoalsPage !== 'undefined' && GoalsPage.selectNode?.('goal', id)); }
        },
        // A routine is a prompt note in the notes blob (see NotePrompts) —
        // existence is a note lookup, the door is the Routines page.
        routine: {
            label: 'routine',
            exists: (id) => ((StorageManager.get('notes')?.notes) || [])
                .some(n => n && String(n.id) === String(id)),
            open(id) { RecordLinks._into('prompts', () => typeof PromptsApp !== 'undefined' && PromptsApp.openPrompt?.(id)); }
        },
        bookmark: {
            label: 'bookmark',
            exists: (id) => ((StorageManager.get('bookmarks')?.bookmarks) || [])
                .some(b => b && String(b.id) === String(id)),
            open(id) { RecordLinks._into('bookmarks', () => typeof BookmarksApp !== 'undefined' && BookmarksApp.openEditor?.(id)); }
        },
        journal: {
            label: 'journal entry',
            exists: (id) => ((StorageManager.get('journal')?.entries) || [])
                .some(e => e && String(e.id) === String(id)),
            open(id) { RecordLinks._into('journal', () => typeof JournalApp !== 'undefined' && JournalApp.openEditor?.(id)); }
        },
        // The mailbox is SQLite, loaded async — before loadData has run the
        // only honest answer is "unknown". Both doors are consume-once
        // deep-link flags that call openApp themselves (the setTimeout
        // idiom loses the race with Email's async init — see
        // navigateToSourceEmail's history in CLAUDE.md).
        email: {
            label: 'email',
            exists: (id) => (typeof EmailApp !== 'undefined' && EmailApp._dataLoaded)
                ? !!EmailApp.emailById?.(id)
                : null,
            open(id) { if (typeof EmailApp !== 'undefined') EmailApp.openMessageFrom?.(id); }
        },
        insight: {
            label: 'email insight',
            exists: (id) => (typeof EmailApp !== 'undefined' && EmailApp._dataLoaded)
                ? !!((EmailApp.getProfileAnalyses?.() || {})[id])
                : null,
            open(id) { if (typeof FyiPage !== 'undefined') FyiPage.openTo?.(id); }
        }
    },

    /** anjadhe://<type>/<id> → {type, id}, or null for anything else
     *  (including an unknown type — the caller falls back to the dead-#
     *  anchor every other non-http scheme gets).
     *
     *  Deliberately forgiving about the exact spelling: the 2026-08-06
     *  morning briefing linked four overdue tasks that all baked as dead
     *  anchors because the model mangled the URL shape while getting the
     *  grammar right elsewhere in the same post. Navigation-only links are
     *  safe to salvage, so tolerate the manglings a small model actually
     *  produces: <angle-bracket> URL wrappers (legal markdown, arriving
     *  HTML-escaped), a missing slash after the scheme, a pluralized type
     *  ("tasks"), and trailing prose punctuation glued onto the URL. */
    parse(url) {
        const u = String(url || '').trim()
            .replace(/^&lt;/, '').replace(/&gt;$/, '')
            .replace(/[.,;:!]+$/, '');
        const m = /^anjadhe:\/{0,2}([a-z]+)\/+(.+)$/i.exec(u);
        if (!m) return null;
        let type = m[1].toLowerCase();
        if (!this.TYPES[type] && this.TYPES[type.replace(/s$/, '')]) type = type.replace(/s$/, '');
        return this.TYPES[type] ? { type, id: m[2] } : null;
    },

    /**
     * The anchor markup. Called from inside formatContent's pipeline, so
     * type/id/label are ALREADY HTML-escaped (quotes included — the H4
     * escape pass runs before any inline substitution); entities in a data
     * attribute decode on parse, so dataset reads give the literal id back.
     */
    anchorHtml(type, id, label) {
        const t = this.TYPES[type];
        return `<a href="#" class="record-link" data-record-link="${type}" data-record-id="${id}"` +
            ` title="Open ${t ? t.label : 'record'}">${label}</a>`;
    },

    /**
     * Record links inside text that is escaped but NOT markdown-rendered —
     * the Run history <pre> on the Routines detail page. Converts only the
     * link grammar; everything else stays verbatim log text.
     */
    linkifyEscapedText(escaped) {
        return String(escaped || '').replace(
            /\[([^\]\n]+)\]\((anjadhe:\/\/[^()\s]+)\)/g,
            (m, label, url) => {
                const p = this.parse(url);
                return p ? this.anchorHtml(p.type, p.id, label) : m;
            });
    },

    /** Click → navigate. A definite "gone" gets a toast; unknown existence
     *  navigates and lets the app degrade to its own list view. */
    open(type, id) {
        const t = this.TYPES[type];
        if (!t || !id) return;
        let exists = null;
        try { exists = t.exists ? t.exists(id) : null; } catch { exists = null; }
        if (exists === false) {
            if (typeof UIUtils !== 'undefined') UIUtils.showToast(`That ${t.label} is no longer here.`, 'error');
            return;
        }
        // Same as HelpActions' buttons: a floating chat panel left hovering
        // over the page the user just asked to see defeats the link. Doors
        // that route through openApp dismiss it themselves, but the
        // consume-once flags (email, insight) go around it.
        if (typeof AgentUI !== 'undefined' && AgentUI.isOpen) AgentUI.close();
        try { t.open(id); } catch (e) { console.warn('[record-links] open failed:', e?.message); }
    },

    // ONE delegated listener for every surface, wired from bootstrap. The
    // anchors carry href="#" purely so they read as links (cursor, a11y);
    // preventDefault keeps the "#" from scrolling the view.
    _wired: false,
    init() {
        if (this._wired) return;
        this._wired = true;
        document.addEventListener('click', (e) => {
            const a = e.target && e.target.closest && e.target.closest('a[data-record-link]');
            if (!a) return;
            e.preventDefault();
            this.open(a.dataset.recordLink, a.dataset.recordId || '');
        });
    }
};
