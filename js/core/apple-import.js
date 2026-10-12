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
        if (typeof Commitments !== 'undefined' && Commitments.onWrite && !this._writeBackOn) {
            this._writeBackOn = true;
            Commitments.onWrite(e => this.writeBack(e));
        }
        if (this.eventsEnabled()) {
            setTimeout(() => {
                this.importEvents().catch(e => console.warn('[apple-import] startup events import failed:', e));
            }, 11000);
        }
        this.startEventsAutoRefresh();
    },

    /**
     * Fetch + apply. Returns {created, updated, completed, skippedLists} or
     * {error}. Errors are also recorded in state so the Settings card can
     * show the last problem without re-running.
     */
    // ── Reminders write-back (2026-10-06, docs/VISION.md "Sources") ─────
    // A mirrored task source stays the truth, so what the person does to a
    // commitment born from a reminder reaches Reminders: done (or a day of
    // a repeat done) completes it, dropped completes it too (it leaves the
    // active list either way; nothing is deleted on a drop), reopen
    // reopens, a new title or date updates, remove deletes (else the next
    // import would bring it back), undo reverses. Runs off Commitments'
    // write ledger (never the bridge's own writes). The next import sees
    // Reminders agreeing with the local copy, so no field conflicts.
    writeBackEnabled() { return this.enabled() && !!window.electronAppleImport?.writeReminder; },
    _writeBackOp(e, c) {
        const one = typeof Commitments !== 'undefined' && !Commitments.repeats(c);
        const op = e.op === 'undo' ? e.undoneOp : e.op;
        const undo = e.op === 'undo';
        if (op === 'done' || op === 'dropped') return undo ? { op: 'reopen' } : { op: 'complete' };
        if (op === 'report') {
            const h = e.after && e.after.history ? Object.values(e.after.history)[0] : null;
            if (!h) return null;
            return undo ? { op: 'reopen' } : { op: 'complete' };
        }
        if (op === 'reopen') return undo ? { op: 'complete' } : { op: 'reopen' };
        if (op === 'remove') return undo ? null : { op: 'delete' };
        if (op === 'change') {
            const w = c.when || {};
            const due = one && w.date ? (w.time ? `${w.date}T${w.time}:00` : w.date) : null;
            return { op: 'update', title: c.title, ...(one ? { due: due || '' } : {}), notes: c.note || '' };
        }
        return null;
    },
    async writeBack(e) {
        if (!this.writeBackEnabled() || typeof Commitments === 'undefined' || e.by === 'reminders') return;
        const c = Commitments.get(e.target) || (e.op === 'remove' || (e.op === 'undo' && e.undoneOp === 'create') ? e.before : null);
        const ref = c && c.origin && c.origin.kind === 'apple' ? c.origin.ref : null;
        if (!ref) return;
        const w = this._writeBackOp(e, c);
        if (!w) return;
        try {
            const res = await window.electronAppleImport.writeReminder({ externalId: ref, ...w });
            if (res && res.error) {
                console.warn(`[apple-import] write-back ${w.op} failed: ${res.error}`);
                if (typeof UIUtils !== 'undefined' && !/not found/.test(res.error)) UIUtils.showToast(`Could not update Reminders: ${res.error}`, 'error');
                return;
            }
            this._saveState({ lastWriteAt: new Date().toISOString(), lastWrite: `${w.op} · ${c.title || ''}`.slice(0, 120) });
        } catch (err) { console.warn('[apple-import] write-back failed:', err && err.message); }
    },

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

        // Commitments are the truth (2026-10-11): they are read into the
        // planner's field view, and its creates and updates are written back
        // through Commitments' door, marked by 'reminders' so the write-back
        // does not echo them to Reminders.
        const nowISO = new Date().toISOString();
        const today = Commitments.today();
        const views = Commitments.all().filter(c => c.origin && c.origin.kind === 'apple' && c.origin.ref).map(c => this.asTaskView(c, today));
        const plan = this.planImport(rows, views, nowISO);
        const by = { by: 'reminders', why: 'from Apple Reminders' };
        for (const fields of plan.creates) {
            Commitments.create({ ...this.commitmentFields(fields, Object.keys(this.FIELD_DEFAULTS)), kind: fields.repeat && fields.repeat !== 'none' ? 'habit' : 'task', sourceSnapshot: fields.reminderSnapshot },
                { ...by, origin: { kind: 'apple', ref: fields.sourceReminderId, list: fields.sourceReminderList || null } });
        }
        for (const u of plan.updates) {
            const view = views.find(v => v.id === u.id);
            if (!view) continue;
            const keys = Object.keys(u.set).filter(k => k !== 'lastCompletedDate');
            Commitments.change(u.id, { ...this.commitmentFields({ ...view, ...u.set }, keys), sourceSnapshot: u.snapshot }, by);
            if ('lastCompletedDate' in u.set) {
                if (u.set.lastCompletedDate) Commitments.resolve(u.id, 'done', { ...by, date: u.set.lastCompletedDate });
                else Commitments.reopen(u.id, { by: 'reminders' });
            }
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

    // ── Automatic refresh (2026-09-08, by request) ──────────────────────
    // The mirror used to refresh only at startup and on "Import now", so an
    // event added in Calendar.app mid-session stayed invisible until the
    // next launch. It now rides the same cadence as the Google auto-sync
    // (`CalendarApp.startAutoSync`): every minute while the user is looking
    // at the Calendar, every fifth tick otherwise. This is the ONE Apple
    // import that polls — it is a wholesale-replace mirror, so a refresh
    // can never overwrite a local edit (there are none), the helper reads
    // the Mac's own EventKit store in well under a second with no network,
    // and `importEvents` skips the save + re-render when the store is
    // unchanged, so the timer costs nothing while nothing happens.
    // Reminders keeps startup + "Import now": it carries local-edit rules
    // where a poll would have real consequences.
    EVENTS_REFRESH_MS: 60 * 1000,
    EVENTS_BACKGROUND_EVERY: 5,
    EVENTS_FOCUS_MIN_MS: 10 * 1000,
    _eventsLastFocusRefresh: 0,
    _focusBound: false,
    _eventsTimer: null,
    _eventsTick: 0,
    _eventsInFlight: null,

    startEventsAutoRefresh() {
        if (this._eventsTimer) clearInterval(this._eventsTimer);
        this._eventsTick = 0;
        this._eventsTimer = setInterval(() => {
            // Read the switch on every tick so the toggle needs no wiring.
            if (!this.eventsEnabled()) return;
            this._eventsTick++;
            // Now shows today and the week; the Calendar page is gone (2026-10-05).
            const watching = typeof AppManager !== 'undefined' && AppManager.currentApp === null && !document.hidden;
            if (!watching && this._eventsTick % this.EVENTS_BACKGROUND_EVERY !== 0) return;
            this.importEvents().catch(e => console.warn('[apple-import] calendar refresh failed:', e));
        }, this.EVENTS_REFRESH_MS);

        // Focus refresh (2026-09-09, by request): coming back to nenva
        // from Calendar.app is exactly when the user expects the grid to be
        // current, so the window regaining focus refreshes at once. Rate-
        // limited: bouncing between windows must not spawn the helper on
        // every switch, and importEvents is single-flight and a no-op
        // write when the store is unchanged, so a refresh costs one
        // sub-second local read.
        if (!this._focusBound) {
            this._focusBound = true;
            const onFocus = () => {
                if (!this.eventsEnabled()) return;
                if (document.visibilityState === 'hidden') return;
                const now = Date.now();
                if (now - this._eventsLastFocusRefresh < this.EVENTS_FOCUS_MIN_MS) return;
                this._eventsLastFocusRefresh = now;
                this.importEvents().catch(e => console.warn('[apple-import] focus refresh failed:', e));
            };
            window.addEventListener('focus', onFocus);
            document.addEventListener('visibilitychange', onFocus);
        }
    },

    async importEvents() {
        // Single-flight: a tick landing on a running "Import now" (or the
        // startup import) joins it instead of spawning a second helper.
        if (this._eventsInFlight) return this._eventsInFlight;
        this._eventsInFlight = this._importEvents().finally(() => { this._eventsInFlight = null; });
        return this._eventsInFlight;
    },

    async _importEvents() {
        if (!window.electronAppleImport?.fetchEvents) return { error: 'bridge unavailable' };
        const res = await window.electronAppleImport.fetchEvents();
        if (res.error) {
            this._saveState({ eventsLastError: res.message || res.error });
            return { error: res.message || res.error };
        }

        CalendarApp.loadData();
        const records = this.buildCalendarEvents(res.events || [], res.calendars || []);
        const nextEvents = records.map(r => ({
            ...r,
            start: CalendarApp._parseEventDate(r.start),
            end: CalendarApp._parseEventDate(r.end),
        }));
        const nextCalendars = (res.calendars || []).map(c => ({
            id: `apple:${c.id}`,
            summary: c.title || 'Apple Calendar',
            backgroundColor: c.color || '',
            primary: false,
            selected: true,
            accessRole: c.writable === false ? 'reader' : 'writer',
            writable: c.writable !== false,
            account: 'apple',
        }));

        // Unchanged store → no blob write, no grid repaint. The builder's
        // output is sorted, so "same events" serializes identically; the
        // main process would drop an identical write anyway, but skipping
        // here also spares the user a redraw every minute.
        const counts = { events: records.length, calendars: nextCalendars.length };
        const prevEvents = CalendarApp.events.filter(e => e.account === 'apple');
        const prevCalendars = CalendarApp.calendars.filter(c => c.account === 'apple');
        if (this._mirrorSignature(prevEvents, prevCalendars) === this._mirrorSignature(nextEvents, nextCalendars)) {
            this._saveState({ eventsLastAt: new Date().toISOString(), eventsCounts: counts, eventsLastError: null });
            return counts;
        }

        CalendarApp.events = CalendarApp.events.filter(e => e.account !== 'apple').concat(nextEvents);
        CalendarApp.calendars = CalendarApp.calendars.filter(c => c.account !== 'apple').concat(nextCalendars);
        CalendarApp.saveData();

        this._saveState({ eventsLastAt: new Date().toISOString(), eventsCounts: counts, eventsLastError: null });
        return counts;
    },

    // ── Calendar write-through (2026-09-09, by request) ─────────────────
    // Apple stays the source of truth, exactly as Google is: a write goes
    // to EventKit through the helper and the mirror is re-read at once, so
    // the app never holds an edit the calendar does not. No optimistic row,
    // no local edit state, no conflict policy — the same laws as before,
    // now with a pen. Only iCloud + local calendars that allow
    // modifications are offered; the helper refuses anything else.

    /** Apple calendars the user may write into (for the event form). */
    writableCalendars() {
        if (typeof CalendarApp === 'undefined') return [];
        if (!this.eventsEnabled()) return [];
        if (!CalendarApp.calendars || CalendarApp.calendars.length === 0) { try { CalendarApp.loadData(); } catch (e) { /* not ready */ } }
        return (CalendarApp.calendars || []).filter(c => c.account === 'apple' && c.writable !== false);
    },

    /**
     * op: 'create' | 'update' | 'delete'. Resolves {ok, ...} or {error}.
     * A successful write is followed by a mirror refresh so the grid shows
     * what Apple Calendar now holds.
     */
    async writeEvent(op, payload) {
        if (!window.electronAppleImport?.writeEvent) return { error: 'bridge unavailable' };
        let res;
        try { res = await window.electronAppleImport.writeEvent(op, payload); }
        catch (e) { return { error: e?.message || String(e) }; }
        if (!res || res.error) return { error: res?.message || res?.error || 'write failed' };
        try { await this.importEvents(); } catch (e) { console.warn('[apple-import] refresh after write failed:', e); }
        return res;
    },

    /**
     * Google's sync ends by pruning rows whose account is no longer
     * connected (a removed or renamed Google account). The mirror's rows
     * carry the sentinel account 'apple', which is never a connected
     * account, so a plain "is it a live email" test deleted every Apple
     * event on every Google sync — and once the mirror polled
     * (2026-09-08) the next tick put them back, so the grid blinked. Pure;
     * the ONE rule for what survives that prune. Rows with no account
     * (local, account-less) survive too, as before.
     */
    MIRROR_ACCOUNT: 'apple',
    pruneStaleAccountRows(events, liveAccountEmails) {
        const live = liveAccountEmails instanceof Set ? liveAccountEmails : new Set(liveAccountEmails || []);
        return (events || []).filter(e => !e.account || e.account === this.MIRROR_ACCOUNT || live.has(e.account));
    },

    // The same shape saveData() writes, so rows loaded from the blob and
    // rows fresh from the builder compare equal when they describe the
    // same occurrences.
    _mirrorSignature(events, calendars) {
        const iso = (d) => (d instanceof Date ? d.toISOString() : (d || null));
        return JSON.stringify({
            events: events.map(e => ({ ...e, start: iso(e.start), end: iso(e.end) })),
            calendars,
        });
    },

    // ── Toggle-off removal (2026-08-20, by request) ─────────────────────
    // The Gmail model: Apple is the source of truth, so disabling an
    // import REMOVES what it brought in — the data still lives in the
    // Apple app, and re-enabling re-imports it. Local edits made to
    // imported items go with them; the Settings copy says so.

    removeImportedReminders() {
        let removed = 0;
        for (const c of Commitments.all().filter(x => x.origin && x.origin.kind === 'apple')) {
            if (Commitments.remove(c.id, { by: 'reminders', why: 'Apple Reminders turned off' }).ok) removed++;
        }
        this._saveState({ lastAt: null, counts: null, lastError: null });
        return removed;
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
this._saveState({ eventsLastAt: null, eventsCounts: null, eventsLastError: null });
        return removed;
    },

    // ── Pure planner (Node-exported for tests) ──────────────────────────

    /**
     * Decide creates/updates from the helper's rows against current tasks.
     * Pure: no clock reads (nowISO is a parameter), no id minting (the
     * applier adds ids and stamps).
     */
    STALE_UNTOUCHED_DAYS: 90,   // not edited in Reminders for this long
    STALE_DUE_DAYS: 30,         // and not due, or due more than this long ago
    /**
     * A reminder nobody has touched in months and that is not coming up:
     * imported, but parked (2026-10-05: connecting Reminders brought
     * three-year-old open items in as overdue tasks). Never a repeating
     * one, never one with a day still ahead or just passed. Pure.
     */
    isStale(r, inc, nowISO) {
        const now = Date.parse(nowISO);
        const touched = Date.parse(r.lastModified || '');
        if (!Number.isFinite(now) || !Number.isFinite(touched)) return false;
        if (inc.repeat && inc.repeat !== 'none') return false;
        if (now - touched < this.STALE_UNTOUCHED_DAYS * 86400000) return false;
        const due = r.due ? Date.parse(r.due) : NaN;
        return !Number.isFinite(due) || now - due > this.STALE_DUE_DAYS * 86400000;
    },

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
                const stale = this.isStale(r, inc, nowISO);
                creates.push({
                    // Left open in Reminders for months: it comes in undated,
                    // not as an overdue task on day one (the parked "someday"
                    // state it used to get was retired 2026-10-06). Apple's
                    // own date is still in the snapshot.
                    title: inc.title || 'Untitled reminder',
                    description: inc.description,
                    tags: inc.tags,
                    startTime: stale ? '' : inc.startTime,
                    endTime: null,
                    notifyBefore: 0,
                    repeat: inc.repeat,
                    dayOfWeek: inc.dayOfWeek,
                    repeatDays: inc.repeatDays,
                    scheduledDate: stale ? '' : inc.scheduledDate,   // '' = the undated Later bucket
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
    /** A commitment in the planner's field vocabulary. Pure. */
    asTaskView(c, today) {
        const w = c.when || {}, r = c.repeat || { rule: 'none', days: [] };
        const rule = r.rule || 'none';
        const doneDays = Object.entries(c.history || {}).filter(([, h]) => h === 'done').map(([d]) => d).sort();
        const lastDone = rule !== 'none' ? (doneDays.pop() || null) : (c.state === 'done' ? (String(c.doneAt || '').slice(0, 10) || today) : null);
        return { id: c.id, title: c.title || '', description: c.note || '', scheduledDate: w.date || '', startTime: w.time || '',
            repeat: rule === 'yearly' ? 'annually' : rule, dayOfWeek: rule === 'weekly' ? ((r.days || [])[0] ?? null) : null,
            repeatDays: rule === 'custom' ? (r.days || []) : [], tags: c.tags || [],
            sourceReminderId: c.origin && c.origin.ref, reminderSnapshot: c.sourceSnapshot || null, lastCompletedDate: lastDone };
    },
    /** The planner's fields (`keys` of them changed) as a commitment's. Pure. */
    commitmentFields(f, keys) {
        const has = k => keys.includes(k);
        const out = {};
        if (has('title')) out.title = f.title || 'Untitled reminder';
        if (has('description')) out.note = f.description || '';
        if (has('tags')) out.tags = f.tags || [];
        if (has('scheduledDate') || has('startTime')) out.when = f.scheduledDate ? { date: f.scheduledDate, time: f.startTime || null, end: null } : null;
        if (has('repeat') || has('dayOfWeek') || has('repeatDays')) {
            const rep = f.repeat || 'none';
            const dow = Number.isInteger(f.dayOfWeek) ? f.dayOfWeek : (f.scheduledDate ? new Date(`${f.scheduledDate}T12:00:00`).getDay() : 0);
            out.repeat = rep === 'weekly' ? { rule: 'weekly', days: [dow] }
                : rep === 'custom' ? { rule: 'custom', days: f.repeatDays || [] }
                : { rule: rep === 'annually' ? 'yearly' : rep, days: [] };
        }
        return out;
    },

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
    buildCalendarEvents(rows, calendars = []) {
        const out = [];
        const seen = new Set();
        const writable = new Map((calendars || []).map(c => [c.id, c.writable !== false]));
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
                status: r.status === 'tentative' ? 'tentative' : 'confirmed',
                colorId: null,
                // A series occurrence points at its series like a Google
                // instance does (the scope prompts key off this); the id
                // is the shared external identifier, and the rule rides
                // every occurrence so "Repeats" needs no second fetch.
                recurrence: r.rrule ? [r.rrule] : null,
                recurringEventId: r.hasRecurrence ? r.externalId : null,
                source: 'apple',
                appleCalendar: r.calendarTitle || '',
                // Write-through handles (2026-09-09): what the helper needs
                // to find this exact occurrence again.
                appleExternalId: r.externalId,
                appleEventId: r.eventId || '',
                appleOccurrenceStart: r.start,
                appleWritable: writable.has(r.calendarId) ? writable.get(r.calendarId) : true,
                // The rest of what EventKit says (2026-09-22), in the same
                // shape the Google sync stores so EventDetails reads both.
                ...this._appleEventExtras(r),
            });
        }
        // Deterministic order regardless of how EventKit handed the rows
        // over: an unchanged store must serialize identically run to run,
        // which is what lets the auto-refresh (and main's no-op write
        // check) tell "nothing happened" from "something changed".
        out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        return out;
    },

    _appleEventExtras(r) {
        const person = (p) => p ? {
            email: p.email || '',
            displayName: p.name || '',
            self: !!p.self,
        } : null;
        const organizer = person(r.organizer);
        const orgEmail = organizer?.email?.toLowerCase() || '';
        const attendees = (Array.isArray(r.attendees) ? r.attendees : []).map(a => ({
            email: a.email || '',
            displayName: a.name || '',
            responseStatus: a.status || '',
            organizer: !!orgEmail && (a.email || '').toLowerCase() === orgEmail,
            self: !!a.self,
            optional: a.role === 'optional',
            resource: a.type === 'room' || a.type === 'resource',
            type: a.type || '',
        }));
        const alarms = Array.isArray(r.alarms) ? r.alarms : [];
        const geo = r.geo && Number.isFinite(r.geo.lat) && Number.isFinite(r.geo.lng)
            ? { title: r.geo.title || '', lat: r.geo.lat, lng: r.geo.lng } : null;
        return {
            attendees,
            organizer,
            url: /^https?:\/\//i.test(r.url || '') ? r.url : '',
            showAs: r.availability && r.availability !== 'busy' ? r.availability : '',
            reminders: alarms.length ? {
                useDefault: false,
                overrides: alarms.map(a => (a.at ? { at: a.at } : { minutes: Number(a.minutes) || 0 })),
            } : null,
            geo,
            timeZone: r.timeZone || '',
            created: r.created || '',
            updated: r.updated || '',
            appleDetached: !!r.isDetached,
        };
    },

    _nextYMD(ymd) {
        const [y, m, d] = String(ymd).split('-').map(Number);
        const next = new Date(y, m - 1, d + 1);
        const p = (n) => String(n).padStart(2, '0');
        return `${next.getFullYear()}-${p(next.getMonth() + 1)}-${p(next.getDate())}`;
    },
};

if (typeof module !== 'undefined' && module.exports) module.exports = AppleImport;
