/**
 * AppleImport — iCloud Reminders → Tasks (one-way, read-only v1).
 *
 * The Mac already holds the user's iCloud Reminders; this reads them through
 * the EventKit helper (electronAppleImport bridge → apple-reminders IPC →
 * native/apple-reminders/reminders-helper.swift) and mirrors them into the
 * schedule blob. No Apple credentials, no network — the private-by-default
 * shape.
 *
 * Laws:
 * - Dedup key is `sourceReminderId` = EventKit's calendarItemExternalIdentifier,
 *   stable across devices for iCloud reminders — so both Macs may import and
 *   converge (the sourceEmailId shape).
 * - iCloud wins a field ONLY while the local copy is untouched. Each imported
 *   task carries `reminderSnapshot` (the last applied values, synced with the
 *   record): a field is updated only when the reminder side moved AND the
 *   local side still equals the snapshot. A local edit permanently wins that
 *   field — the snapshot deliberately stays stale so later reminder edits
 *   keep losing the comparison.
 * - Completion mirrors one-way (reminder done → task done). A recurring
 *   reminder keeps its id while Apple advances the due date, so a completed
 *   imported task whose reminder came back incomplete with a LATER date is a
 *   new occurrence: roll it forward (new date, completion cleared).
 * - Never deletes. A reminder deleted in iCloud leaves its task alone.
 * - The enable switch and import state are per-Mac (localStorage); only the
 *   list picker is a synced preference. planImport() is pure and
 *   Node-exported (tests/apple-import-test.js).
 */
const AppleImport = {
    ENABLED_KEY: 'apple-import-reminders',   // localStorage '1' = on (per-Mac)
    STATE_KEY: 'apple-import-state',         // localStorage: {lastAt, counts, lists, lastError}
    PREFS_KEY: 'apple-import-prefs',         // StorageManager (synced): {reminderLists: null|[names]}
    DESC_CAP: 2000,

    enabled() {
        try { return localStorage.getItem(this.ENABLED_KEY) === '1'; } catch (e) { return false; }
    },

    setEnabled(on) {
        try {
            if (on) localStorage.setItem(this.ENABLED_KEY, '1');
            else localStorage.removeItem(this.ENABLED_KEY);
        } catch (e) { /* private mode */ }
    },

    prefs() {
        const p = (typeof StorageManager !== 'undefined' && StorageManager.get(this.PREFS_KEY)) || {};
        return { reminderLists: Array.isArray(p.reminderLists) ? p.reminderLists : null };
    },

    savePrefs(prefs) {
        if (typeof StorageManager !== 'undefined') StorageManager.set(this.PREFS_KEY, prefs);
    },

    state() {
        try { return JSON.parse(localStorage.getItem(this.STATE_KEY)) || {}; } catch (e) { return {}; }
    },

    _saveState(patch) {
        try {
            localStorage.setItem(this.STATE_KEY, JSON.stringify({ ...this.state(), ...patch }));
        } catch (e) { /* best effort */ }
    },

    /**
     * Called from AppManager.init. Deferred past first paint like the email
     * backlog — an import is a background courtesy, never boot-blocking.
     */
    init() {
        if (this.enabled()) {
            setTimeout(() => {
                this.importReminders().catch(e => console.warn('[apple-import] startup import failed:', e));
            }, 5000);
        }
        if (this.notesEnabled()) {
            setTimeout(() => {
                this.importNotes().catch(e => console.warn('[apple-import] startup notes import failed:', e));
            }, 8000);
        }
        if (this.eventsEnabled()) {
            setTimeout(() => {
                this.importEvents().catch(e => console.warn('[apple-import] startup events import failed:', e));
            }, 11000);
        }
    },

    /**
     * Fetch + apply. Returns {created, updated, completed, skippedLists} or
     * {error}. Errors are also recorded in state so the Settings card can
     * show the last problem without re-running.
     */
    async importReminders() {
        if (!window.electronAppleImport) return { error: 'bridge unavailable' };
        const res = await window.electronAppleImport.fetchReminders();
        if (res.error) {
            this._saveState({ lastError: res.message || res.error });
            return { error: res.message || res.error };
        }

        const prefs = this.prefs();
        const wanted = prefs.reminderLists; // null = all lists
        const rows = (res.reminders || []).filter(r => !wanted || wanted.includes(r.list));

        // Callers may run before the Schedule view ever opened — load first
        // so the writes below don't clobber stored tasks (the createTask rule).
        if (ScheduleApp.scheduleItems.length === 0) ScheduleApp.loadData();

        const nowISO = new Date().toISOString();
        const plan = this.planImport(rows, ScheduleApp.scheduleItems, nowISO);

        for (const fields of plan.creates) {
            ScheduleApp.scheduleItems.push({
                id: UIUtils.generateId(),
                ...fields,
                createdAt: nowISO,
                modifiedAt: nowISO,
            });
        }
        for (const u of plan.updates) {
            const item = ScheduleApp.scheduleItems.find(t => t.id === u.id);
            if (!item) continue;
            Object.assign(item, u.set);
            item.reminderSnapshot = u.snapshot;
            item.modifiedAt = nowISO;
        }
        if (plan.creates.length || plan.updates.length) {
            ScheduleApp.saveData();
            ScheduleApp.render();
            if (typeof AppManager !== 'undefined') AppManager.updateStats();
        }

        const counts = plan.summary;
        this._saveState({
            lastAt: nowISO,
            counts,
            lists: (res.lists || []).map(l => l.title),
            lastError: null,
        });
        return counts;
    },

    // ── Apple Notes (Phase 2) ───────────────────────────────────────────
    // One-way, read-only, via fixed JXA scripts in main. UNLIKE reminders,
    // Apple Notes ids are per-Mac Core Data URIs (verified: the store UUID
    // differs between Macs), so there is NO stable cross-Mac dedup key —
    // notes import must be enabled on ONE Mac; the records reach the other
    // Macs through Anjadhe's own sync. The Settings copy says so.
    //
    // Untouched-detection needs no snapshot of the content: imported notes
    // are stamped modifiedAt = the Apple modification date (also kept as
    // sourceNoteModifiedAt), so any Anjadhe edit — which stamps now() —
    // makes the two differ, and that note is the user's forever after.
    // Locked (password-protected) notes are unreadable by scripting and are
    // skipped honestly, counted in the result.

    NOTES_ENABLED_KEY: 'apple-import-notes',
    NOTES_TAG: 'apple-notes',
    NOTE_BODY_BATCH: 25,

    notesEnabled() {
        try { return localStorage.getItem(this.NOTES_ENABLED_KEY) === '1'; } catch (e) { return false; }
    },

    setNotesEnabled(on) {
        try {
            if (on) localStorage.setItem(this.NOTES_ENABLED_KEY, '1');
            else localStorage.removeItem(this.NOTES_ENABLED_KEY);
        } catch (e) { /* private mode */ }
    },

    async importNotes() {
        if (!window.electronAppleImport?.notesMeta) return { error: 'bridge unavailable' };
        const meta = await window.electronAppleImport.notesMeta();
        if (meta.error) {
            this._saveState({ notesLastError: meta.message || meta.error });
            return { error: meta.message || meta.error };
        }

        if (NotesApp.notes.length === 0) NotesApp.loadNotes();
        if (!NotesApp.tags || NotesApp.tags.length === 0) NotesApp.loadTags();

        const plan = this.planNotesSync(meta.notes || [], NotesApp.notes);

        // Bodies only for what actually changed — the metadata pass is one
        // cheap sweep; each body is its own Apple event.
        const bodies = {};
        for (let i = 0; i < plan.needBodies.length; i += this.NOTE_BODY_BATCH) {
            const batch = plan.needBodies.slice(i, i + this.NOTE_BODY_BATCH);
            const r = await window.electronAppleImport.notesBodies(batch);
            if (r.error) {
                this._saveState({ notesLastError: r.message || r.error });
                return { error: r.message || r.error };
            }
            Object.assign(bodies, r.bodies || {});
        }

        const nowISO = new Date().toISOString();
        const ops = this.buildNoteOps(plan, bodies, nowISO);

        if (ops.creates.length || ops.updates.length) {
            // The visible marker tag — created once, then the notes carry it.
            if (!NotesApp.tags.some(t => t.name === this.NOTES_TAG)) {
                NotesApp.tags.push({ id: UIUtils.generateId(), name: this.NOTES_TAG, profile: 'default' });
                NotesApp.saveTags();
            }
            for (const fields of ops.creates) {
                NotesApp.notes.unshift({ id: UIUtils.generateId(), ...fields });
            }
            for (const u of ops.updates) {
                const note = NotesApp.notes.find(n => n.id === u.id);
                if (note) Object.assign(note, u.set);
            }
            NotesApp.saveNotes();
            if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'notes') NotesApp.render();
        }

        const counts = { ...ops.summary, skippedLocked: plan.skippedLocked, skippedEdited: plan.skippedEdited };
        this._saveState({ notesLastAt: nowISO, notesCounts: counts, notesLastError: null });
        return counts;
    },

    // ── Apple Calendar (Phase 3) ────────────────────────────────────────
    // iCloud + local calendar events into the Calendar app, as a MIRROR:
    // every import wholesale-replaces the `account === 'apple'` rows in the
    // calendar blob (iCloud is the source of truth; there is nothing to
    // merge because these events are read-only here — the detail view hides
    // Edit/Delete for source 'apple'). Riding the same blob is safe because
    // every Google sync path is already account-scoped, and the sentinel
    // 'apple' is never a Google account email. The helper only serves
    // iCloud/local SOURCES, so a Google account added to the Mac's Calendar
    // app can never double-import events the app syncs from Google itself.

    EVENTS_ENABLED_KEY: 'apple-import-events',

    eventsEnabled() {
        try { return localStorage.getItem(this.EVENTS_ENABLED_KEY) === '1'; } catch (e) { return false; }
    },

    setEventsEnabled(on) {
        try {
            if (on) localStorage.setItem(this.EVENTS_ENABLED_KEY, '1');
            else localStorage.removeItem(this.EVENTS_ENABLED_KEY);
        } catch (e) { /* private mode */ }
    },

    async importEvents() {
        if (!window.electronAppleImport?.fetchEvents) return { error: 'bridge unavailable' };
        const res = await window.electronAppleImport.fetchEvents();
        if (res.error) {
            this._saveState({ eventsLastError: res.message || res.error });
            return { error: res.message || res.error };
        }

        CalendarApp.loadData();
        const records = this.buildCalendarEvents(res.events || []);

        CalendarApp.events = CalendarApp.events
            .filter(e => e.account !== 'apple')
            .concat(records.map(r => ({
                ...r,
                start: CalendarApp._parseEventDate(r.start),
                end: CalendarApp._parseEventDate(r.end),
            })));
        CalendarApp.calendars = CalendarApp.calendars
            .filter(c => c.account !== 'apple')
            .concat((res.calendars || []).map(c => ({
                id: `apple:${c.id}`,
                summary: c.title || 'Apple Calendar',
                backgroundColor: c.color || '',
                primary: false,
                selected: true,
                accessRole: 'reader',
                account: 'apple',
            })));
        CalendarApp.saveData();
        if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'calendar') CalendarApp.render();

        const counts = { events: records.length, calendars: (res.calendars || []).length };
        this._saveState({ eventsLastAt: new Date().toISOString(), eventsCounts: counts, eventsLastError: null });
        return counts;
    },

    // ── Toggle-off removal (2026-08-20, by request) ─────────────────────
    // The Gmail model: Apple is the source of truth, so disabling an
    // import REMOVES what it brought in — the data still lives in the
    // Apple app, and re-enabling re-imports it. Local edits made to
    // imported items go with them; the Settings copy says so.

    removeImportedReminders() {
        if (ScheduleApp.scheduleItems.length === 0) ScheduleApp.loadData();
        const before = ScheduleApp.scheduleItems.length;
        ScheduleApp.scheduleItems = ScheduleApp.scheduleItems.filter(t => t.source !== 'reminders');
        const removed = before - ScheduleApp.scheduleItems.length;
        if (removed) {
            ScheduleApp.saveData();
            // Goal links pointing at removed tasks are now stale.
            if (typeof LinkManager !== 'undefined') LinkManager.cleanupStaleLinks();
            ScheduleApp.render();
            if (typeof AppManager !== 'undefined') AppManager.updateStats();
        }
        this._saveState({ lastAt: null, counts: null, lastError: null });
        return removed;
    },

    removeImportedNotes() {
        if (NotesApp.notes.length === 0) NotesApp.loadNotes();
        const gone = NotesApp.notes.filter(n => n.source === 'apple-notes');
        if (gone.length) {
            const now = new Date().toISOString();
            NotesApp.notes = NotesApp.notes.filter(n => n.source !== 'apple-notes');
            // The notes blob is record-merged across Macs — an undeclared
            // removal resurrects from the other Mac's copy. Tombstone every
            // removed note (the saveNotes contract).
            const tombstones = {};
            for (const n of gone) tombstones[n.id] = now;
            NotesApp.saveNotes(tombstones);
            if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'notes') NotesApp.render();
        }
        this._saveState({ notesLastAt: null, notesCounts: null, notesLastError: null });
        return gone.length;
    },

    removeImportedEvents() {
        CalendarApp.loadData();
        const before = CalendarApp.events.length;
        CalendarApp.events = CalendarApp.events.filter(e => e.account !== 'apple');
        CalendarApp.calendars = CalendarApp.calendars.filter(c => c.account !== 'apple');
        const removed = before - CalendarApp.events.length;
        // A scope pointing at the mirror we just emptied would strand the
        // grid on nothing — fall back to All accounts.
        if (CalendarApp.currentAccount === 'apple') CalendarApp.currentAccount = null;
        // Always save: the apple CALENDARS list may need clearing even when
        // the fetch window held no events.
        CalendarApp.saveData();
        if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'calendar') CalendarApp.render();
        this._saveState({ eventsLastAt: null, eventsCounts: null, eventsLastError: null });
        return removed;
    },

    // ── Pure planner (Node-exported for tests) ──────────────────────────

    /**
     * Decide creates/updates from the helper's rows against current tasks.
     * Pure: no clock reads (nowISO is a parameter), no id minting (the
     * applier adds ids and stamps).
     */
    planImport(reminders, tasks, nowISO) {
        const creates = [];
        const updates = [];
        const summary = { created: 0, updated: 0, completed: 0 };
        const byExternalId = new Map();
        for (const t of tasks) {
            if (t.sourceReminderId) byExternalId.set(t.sourceReminderId, t);
        }

        for (const r of reminders) {
            if (!r.externalId) continue;
            const existing = byExternalId.get(r.externalId);
            const inc = this._incomingFields(r);

            if (!existing) {
                // No history import: a reminder already completed that never
                // became a task stays in Apple's archive.
                if (r.completed) continue;
                creates.push({
                    title: inc.title || 'Untitled reminder',
                    description: inc.description,
                    tags: inc.tags,
                    startTime: inc.startTime,
                    endTime: null,
                    notifyBefore: 0,
                    repeat: inc.repeat,
                    dayOfWeek: inc.dayOfWeek,
                    repeatDays: inc.repeatDays,
                    scheduledDate: inc.scheduledDate,   // '' = the undated Later bucket
                    reminderDaysBefore: [0],
                    lastCompletedDate: null,
                    source: 'reminders',
                    sourceReminderId: r.externalId,
                    sourceReminderList: r.list || '',
                    reminderSnapshot: { ...inc },
                });
                summary.created++;
                continue;
            }

            const snap = existing.reminderSnapshot || {};
            const set = {};
            const newSnap = { ...snap };
            for (const k of Object.keys(this.FIELD_DEFAULTS)) {
                // Normalize against the creation default, not '' — snapshots
                // written before recurrence mapping existed carry no repeat
                // keys, and those must read as the old default ('none') so
                // the newly mapped rule flows in instead of looking like a
                // local edit. JSON compare because repeatDays is an array.
                const norm = (v) => JSON.stringify(v ?? this.FIELD_DEFAULTS[k]);
                // Reminder side moved AND local side untouched → apply.
                // Local divergence wins that field forever (snapshot stays).
                if (norm(inc[k]) !== norm(snap[k]) && norm(existing[k]) === norm(snap[k])) {
                    set[k] = inc[k];
                    newSnap[k] = inc[k];
                }
            }

            if (r.completed) {
                // For a repeating task lastCompletedDate is "last done day",
                // so a newer Apple completion advances it; an older one is
                // stale history and leaves the task alone.
                const doneYMD = this._localYMD(r.completionDate) || this._localYMD(nowISO);
                if (!existing.lastCompletedDate || doneYMD > existing.lastCompletedDate) {
                    set.lastCompletedDate = doneYMD;
                    summary.completed++;
                }
            } else if (inc.repeat === 'none' && existing.lastCompletedDate &&
                       inc.scheduledDate && inc.scheduledDate > (snap.scheduledDate || '') &&
                       existing.lastCompletedDate < inc.scheduledDate) {
                // Unmappable recurring reminder rolled to its next occurrence
                // (same id, later due date) after the task was completed
                // locally: the completion belonged to the previous cycle.
                // Mapped recurrences don't need this — occursOn computes
                // their occurrences and completion is per-day.
                set.lastCompletedDate = null;
            }

            if (Object.keys(set).length) {
                updates.push({ id: existing.id, set, snapshot: newSnap });
                summary.updated++;
            }
        }
        return { creates, updates, summary };
    },

    // The imported fields and their creation defaults — also the snapshot
    // comparison set (planImport's update loop iterates these keys).
    FIELD_DEFAULTS: {
        title: '', description: '', scheduledDate: '', startTime: '',
        repeat: 'none', dayOfWeek: null, repeatDays: [], tags: [],
    },

    REMINDERS_TAG: 'apple-reminders',

    _incomingFields(r) {
        const rep = this._mapRecurrence(r);
        const list = this._cleanText(r.list);
        return {
            title: this._cleanText(r.title),
            description: this._cleanText(r.notes).slice(0, this.DESC_CAP),
            scheduledDate: r.due ? this._localYMD(r.due) : '',
            startTime: (r.due && r.hasTime) ? this._localHM(r.due) : '',
            repeat: rep.repeat,
            dayOfWeek: rep.dayOfWeek,
            repeatDays: rep.repeatDays,
            // The list IS the tag — plus the marker tag, the notes-import
            // bargain. Tags are snapshot-compared like every field, so a
            // list rename in Apple flows through unless the user edited
            // the tags here (then their edit wins forever).
            tags: [this.REMINDERS_TAG, ...(list ? [list] : [])],
        };
    },

    /**
     * EventKit recurrence rule → the schedule's repeat vocabulary
     * (none/daily/weekdays/weekly/custom/monthly/annually). Anything the
     * vocabulary can't say honestly — interval > 1, an end date, positional
     * or multi-day-of-month rules — maps to 'none': those fall back to the
     * one-time task whose date rolls forward as Apple advances it, rather
     * than a rule that would invent occurrences Apple never scheduled.
     */
    _mapRecurrence(r) {
        const none = { repeat: 'none', dayOfWeek: null, repeatDays: [] };
        const rec = r.recurrence;
        if (!rec || !rec.freq) return none;
        if ((rec.interval || 1) > 1 || rec.hasEnd || rec.complex) return none;
        const days = Array.isArray(rec.days) ? [...rec.days].sort((a, b) => a - b) : [];
        switch (rec.freq) {
            case 'daily':
                return days.length ? none : { repeat: 'daily', dayOfWeek: null, repeatDays: [] };
            case 'weekly':
                if (days.length === 0) {
                    // No explicit weekday: the rule repeats on the due date's day.
                    if (!r.due) return none;
                    return { repeat: 'weekly', dayOfWeek: new Date(r.due).getDay(), repeatDays: [] };
                }
                if (days.length === 1) return { repeat: 'weekly', dayOfWeek: days[0], repeatDays: [] };
                if (days.join(',') === '1,2,3,4,5') return { repeat: 'weekdays', dayOfWeek: null, repeatDays: [] };
                return { repeat: 'custom', dayOfWeek: null, repeatDays: days };
            case 'monthly':
                // days present = by-weekday monthly ("first Monday") — the
                // schedule's monthly is day-of-month only.
                return days.length ? none : { repeat: 'monthly', dayOfWeek: null, repeatDays: [] };
            case 'yearly':
                return days.length ? none : { repeat: 'annually', dayOfWeek: null, repeatDays: [] };
            default:
                return none;
        }
    },

    // Reminders titles routinely carry zero-width characters (observed:
    // U+2060 word joiners pasted in from iOS). Strip them or dedup-by-title
    // surfaces elsewhere see two different strings render identically.
    // Also decode basic HTML entities: a real iCloud list is literally
    // named "Birthdays &amp; Anniversaries" (verified byte-level \u2014 an old
    // sync artifact on Apple's side), and rendered as a tag chip that
    // reads as OUR escaping bug. The user typed "&".
    _cleanText(s) {
        return String(s || '')
            .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
            .trim();
    },

    _localYMD(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d)) return '';
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    },

    _localHM(iso) {
        const d = new Date(iso);
        if (isNaN(d)) return '';
        const p = (n) => String(n).padStart(2, '0');
        return `${p(d.getHours())}:${p(d.getMinutes())}`;
    },

    // ── Pure calendar builder (Node-exported for tests) ─────────────────

    /**
     * Helper rows → local calendar-event records. Occurrence key is
     * externalId + start instant, since EventKit expands a recurring series
     * into occurrences that share the externalId. All-day events are
     * emitted as date-only strings — the calendar's own _parseEventDate
     * treats those as LOCAL midnight (the Google all-day rule) — with an
     * exclusive end at least one day after the start: EventKit ends an
     * all-day event inside its last day, while the renderer expects the
     * Google shape (end = the morning after).
     */
    buildCalendarEvents(rows) {
        const out = [];
        const seen = new Set();
        for (const r of rows) {
            if (!r.externalId || !r.start) continue;
            const key = `${r.externalId}:${r.start}`;
            if (seen.has(key)) continue;
            seen.add(key);
            let start = r.start;
            let end = r.end || '';
            if (r.allDay) {
                start = this._localYMD(r.start);
                end = this._localYMD(r.end);
                if (!end || end <= start) end = this._nextYMD(start);
            }
            out.push({
                id: key,
                calendarId: `apple:${r.calendarId || ''}`,
                summary: this._cleanText(r.title) || '(No title)',
                description: r.notes || '',
                location: r.location || '',
                start,
                end,
                allDay: !!r.allDay,
                account: 'apple',
                htmlLink: '',
                status: 'confirmed',
                colorId: null,
                attendees: [],
                recurrence: null,
                recurringEventId: null,
                source: 'apple',
                appleCalendar: r.calendarTitle || '',
            });
        }
        return out;
    },

    _nextYMD(ymd) {
        const [y, m, d] = String(ymd).split('-').map(Number);
        const next = new Date(y, m - 1, d + 1);
        const p = (n) => String(n).padStart(2, '0');
        return `${next.getFullYear()}-${p(next.getMonth() + 1)}-${p(next.getDate())}`;
    },

    // ── Pure notes planners (Node-exported for tests) ───────────────────

    /**
     * Phase 1: from the metadata sweep, decide which notes need their body
     * fetched. New notes and Apple-side changes on locally-untouched notes
     * qualify; locked notes and locally-edited notes never do.
     */
    planNotesSync(rows, notes) {
        const bySourceId = new Map();
        for (const n of notes) {
            if (n.sourceNoteId) bySourceId.set(n.sourceNoteId, n);
        }
        const plan = { creates: [], updates: [], needBodies: [], skippedLocked: 0, skippedEdited: 0 };
        for (const row of rows) {
            if (!row.id) continue;
            if (row.locked) { plan.skippedLocked++; continue; }
            const existing = bySourceId.get(row.id);
            if (!existing) {
                plan.creates.push(row);
                plan.needBodies.push(row.id);
                continue;
            }
            if (!row.modified || row.modified <= (existing.sourceNoteModifiedAt || '')) continue;
            if ((existing.modifiedAt || '') !== (existing.sourceNoteModifiedAt || '')) {
                // Edited in Anjadhe since import — the user's copy wins,
                // this run and every later one.
                plan.skippedEdited++;
                continue;
            }
            plan.updates.push({ row, id: existing.id });
            plan.needBodies.push(row.id);
        }
        return plan;
    },

    /**
     * Phase 2: turn planned rows + fetched bodies into record operations.
     * A body that came back null (locked mid-flight, deleted between the
     * two passes) drops that row rather than writing an empty note.
     */
    buildNoteOps(plan, bodies, nowISO) {
        const ops = { creates: [], updates: [], summary: { created: 0, updated: 0 } };
        for (const row of plan.creates) {
            const body = bodies[row.id];
            if (typeof body !== 'string') continue;
            const content = this._noteContent(body, row.title);
            ops.creates.push({
                title: this._cleanText(row.title) || 'Untitled',
                content,
                tags: [this.NOTES_TAG],
                template: 'blank',
                bookNumbered: true,
                bookLayout: 'scroll',
                pinned: false,
                source: 'apple-notes',
                sourceNoteId: row.id,
                sourceNoteFolder: row.folder || '',
                sourceNoteAccount: row.account || '',
                sourceNoteModifiedAt: row.modified || nowISO,
                createdAt: row.created || nowISO,
                // Apple's own stamp, matching sourceNoteModifiedAt — equality
                // of the two is the "untouched since import" signal, and a
                // real change is what bumps it for the record merge.
                modifiedAt: row.modified || nowISO,
            });
            ops.summary.created++;
        }
        for (const u of plan.updates) {
            const body = bodies[u.row.id];
            if (typeof body !== 'string') continue;
            ops.updates.push({
                id: u.id,
                set: {
                    title: this._cleanText(u.row.title) || 'Untitled',
                    content: this._noteContent(body, u.row.title),
                    sourceNoteModifiedAt: u.row.modified,
                    modifiedAt: u.row.modified,
                },
            });
            ops.summary.updated++;
        }
        return ops;
    },

    _noteContent(html, title) {
        return this._stripLeadingTitle(this._sanitizeNoteHtml(html), title);
    },

    /**
     * Defensive sanitize before storing into the notes blob (content is
     * rendered as HTML). Apple Notes bodies are simple div/br markup, but
     * strip the active classes anyway: script/style/iframe-alikes, inline
     * event handlers, javascript: URLs. Regex-based so it stays pure for
     * the Node tests.
     */
    _sanitizeNoteHtml(html) {
        html = String(html || '');
        // IMAP-account notes arrive as full documents (<html><head>…<body
        // style=…>) while iCloud notes are bare divs (measured). Unwrap to
        // the body's inner HTML so a document skeleton never nests inside
        // the note-content div.
        const bodyM = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        if (bodyM) html = bodyM[1];
        return html
            .replace(/<(script|style|iframe|object|embed|form)\b[\s\S]*?<\/\1\s*>/gi, '')
            .replace(/<(script|style|iframe|object|embed|form|link|meta)\b[^>]*\/?>/gi, '')
            .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
            .replace(/\s(href|src)\s*=\s*(["']?)\s*javascript:[^"'\s>]*\2/gi, '');
    },

    /**
     * Apple duplicates the note's title as the body's first line
     * (<div><h1>Title</h1></div> or a plain first div). Anjadhe shows the
     * title field separately, so drop that first block when its text equals
     * the title — plus one blank <div><br></div> spacer after it.
     */
    _stripLeadingTitle(html, title) {
        const want = this._cleanText(title).toLowerCase();
        if (!want) return html;
        const m = String(html).match(/^\s*<div[^>]*>([\s\S]*?)<\/div>\s*/i);
        if (!m) return html;
        const text = this._cleanText(m[1].replace(/<[^>]+>/g, '')).toLowerCase();
        if (text !== want) return html;
        let rest = String(html).slice(m[0].length);
        rest = rest.replace(/^\s*<div[^>]*>\s*<br\s*\/?\s*>\s*<\/div>\s*/i, '');
        return rest;
    },
};

if (typeof module !== 'undefined' && module.exports) module.exports = AppleImport;
