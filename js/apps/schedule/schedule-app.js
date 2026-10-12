/**
 * Schedule App
 * Manages time-based daily schedule items with repeat options
 * Items are grouped: Today, This Week, Later
 */

const ScheduleApp = {
    scheduleItems: [],
    currentItemId: null,
    searchQuery: '',
    autoLinkContext: null, // [{app, itemId}, ...] — auto-link new tasks to these items
    activeFilter: { type: 'all', id: null }, // sidebar filter: 'all'|'unassigned'|'goal'
    viewMode: 'agenda',                      // right-pane mode: 'agenda' (date-grouped) | 'list' (status-grouped backlog)

    // Draggable width of the Tasks filter sidebar (px). Persisted per-machine
    // in localStorage — screen sizes differ across Macs, so this preference is
    // intentionally kept out of the sync journal.
    NAV_WIDTH_KEY: 'schedule-nav-width',
    NAV_WIDTH_DEFAULT: 216,
    NAV_WIDTH_MIN: 160,
    NAV_WIDTH_MAX: 420,

    init() {
        this.loadData();
    },

    /** The list page is gone (phase 5b); data methods still call this after a write. */
    render() {
        if (typeof CommitmentsPage !== 'undefined' && AppManager.currentApp === 'commitments') { try { CommitmentsPage.render(); } catch { /* repaint is best effort */ } }
    },

    loadData() {
        const data = StorageManager.get('schedule');
        // Normalize so records created on other devices (e.g. the phone) that
        // omit fields can't crash the renderer — coerce strings and default
        // arrays/repeat that the render/search/sort paths access unguarded.
        this.scheduleItems = (data?.scheduleItems || []).map(t => ({
            ...t,
            title: typeof t.title === 'string' ? t.title : '',
            description: typeof t.description === 'string' ? t.description : '',
            startTime: typeof t.startTime === 'string' ? t.startTime : '',
            repeat: t.repeat || 'none',
            repeatDays: Array.isArray(t.repeatDays) ? t.repeatDays : [],
            reminderDaysBefore: Array.isArray(t.reminderDaysBefore) ? t.reminderDaysBefore : [],
            // Per-occurrence record: { 'YYYY-MM-DD': 'done' | 'abandoned' }.
            // Written going forward by toggleComplete / toggleAbandoned.
            history: (t.history && typeof t.history === 'object' && !Array.isArray(t.history)) ? t.history : {},
        }));
    },

    saveData() {
        // Merge into the existing blob rather than replacing it — the schedule
        // key also holds emailActionLedger (dedup ledger for email-derived
        // tasks). A bare { scheduleItems } write would wipe it on every edit,
        // letting deleted email tasks resurrect on the next email sync.
        const data = StorageManager.get('schedule') || {};
        StorageManager.set('schedule', { ...data, scheduleItems: this.scheduleItems });
        AppManager.updateStats();
        // Home's widgets read this blob. Announcing the write is what makes
        // "Done" from a home card — and the Undo toast that reverses it —
        // repaint the card, without the widget knowing who changed what.
        document.dispatchEvent(new CustomEvent('anjadhe:data-changed', { detail: { key: 'schedule' } }));
    },

    // --- Date helpers ---

    getLocalToday() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },

    getLocalDate(offset) {
        const d = new Date();
        d.setDate(d.getDate() + offset);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },

    getEndOfWeek() {
        const d = new Date();
        const daysUntilSun = 7 - d.getDay();
        d.setDate(d.getDate() + daysUntilSun);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },

    isCompletedToday(item) {
        if (!item.lastCompletedDate) return false;
        return item.lastCompletedDate === this.getLocalToday();
    },

    /** Was this occurrence deliberately skipped? (history: date → 'abandoned') */
    isAbandonedOn(item, dateStr) {
        return !!(item.history && item.history[dateStr] === 'abandoned');
    },

    isAbandonedToday(item) {
        return this.isAbandonedOn(item, this.getLocalToday());
    },

    /** Most recent abandoned date, or null. (One-time tasks have at most one.) */
    lastAbandonedDate(item) {
        const dates = Object.keys(item.history || {}).filter(d => item.history[d] === 'abandoned').sort();
        return dates[dates.length - 1] || null;
    },

    /**
     * Check if a repeating item fires on a given day-of-week
     */
    repeatsOnDay(item, dayOfWeek) {
        switch (item.repeat) {
            case 'daily': return true;
            case 'weekdays': return dayOfWeek >= 1 && dayOfWeek <= 5;
            case 'weekly': return item.dayOfWeek === dayOfWeek;
            case 'custom': return (item.repeatDays || []).includes(dayOfWeek);
            default: return false;
        }
    },

    /**
     * Check if a monthly/annual item fires on a given date string (YYYY-MM-DD)
     */
    repeatsOnDate(item, dateStr) {
        if (!item.scheduledDate) return false;
        const refParts = item.scheduledDate.split('-');
        const dateParts = dateStr.split('-');
        if (item.repeat === 'monthly') {
            return refParts[2] === dateParts[2]; // same day of month
        }
        if (item.repeat === 'annually') {
            return refParts[1] === dateParts[1] && refParts[2] === dateParts[2]; // same month+day
        }
        return false;
    },

    /**
     * Does an item occur on a given YYYY-MM-DD date? Single source of truth for
     * "is this task on this day" across the app (agenda, calendar, actions,
     * agent). `scheduledDate` is the anchor/START date: a recurring task never
     * occurs before it. One-time tasks occur only on their own date. Legacy
     * recurring tasks with no stored date stay unbounded (start check skipped).
     */
    occursOn(item, dateStr) {
        if (!item.repeat || item.repeat === 'none') {
            return (item.scheduledDate || '') === dateStr;
        }
        // Start-date bound — a recurrence never fires before its anchor.
        if (item.scheduledDate && dateStr < item.scheduledDate) return false;
        // End bound: a stage of a plan repeats until its last day
        // (`repeatUntil`, projected from a commitment's `until`, 2026-10-09).
        if (item.repeatUntil && dateStr > item.repeatUntil) return false;
        if (item.repeat === 'monthly' || item.repeat === 'annually') {
            return this.repeatsOnDate(item, dateStr);
        }
        const dow = new Date(dateStr + 'T00:00:00').getDay();
        return this.repeatsOnDay(item, dow);
    },

    _iso(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },

    /**
     * The next date on/after `fromISO` on which a recurring monthly/annual task
     * occurs, derived from its anchor's day-of-month (or month+day). Non-recurring
     * items just return their scheduledDate. This is what a recurring task should
     * DISPLAY as — its stored scheduledDate is only the original anchor and never
     * advances, so showing it directly leaks a stale past date into Upcoming.
     */
    nextOccurrenceDate(item, fromISO) {
        if (!item.scheduledDate) return item.scheduledDate;
        // Never advance to a date before the anchor/start date.
        const effISO = fromISO < item.scheduledDate ? item.scheduledDate : fromISO;
        const from = new Date(effISO + 'T00:00:00');
        if (item.repeat === 'monthly') {
            const day = parseInt(item.scheduledDate.split('-')[2], 10);
            let y = from.getFullYear(), m = from.getMonth();
            for (let i = 0; i < 25; i++) {
                const dim = new Date(y, m + 1, 0).getDate();
                const cand = new Date(y, m, Math.min(day, dim));
                if (cand >= from) return this._iso(cand);
                m++; if (m > 11) { m = 0; y++; }
            }
        } else if (item.repeat === 'annually') {
            const [, mo, dd] = item.scheduledDate.split('-').map(Number);
            let y = from.getFullYear();
            for (let i = 0; i < 4; i++) {
                const dim = new Date(y, mo, 0).getDate();
                const cand = new Date(y, mo - 1, Math.min(dd, dim));
                if (cand >= from) return this._iso(cand);
                y++;
            }
        }
        return item.scheduledDate;
    },

    /**
     * The date an item should sort/group under in the agenda: the next
     * occurrence for recurring monthly/annual tasks, else its own date.
     */
    _agendaDateFor(item) {
        if (item.repeat === 'monthly' || item.repeat === 'annually') {
            return this.nextOccurrenceDate(item, this.getLocalToday());
        }
        return item.scheduledDate || item.createdAt?.slice(0, 10) || '';
    },

    /**
     * Check if item is relevant for today (for today section only)
     */
    isItemForToday(item) {
        const todayDate = this.getLocalToday();

        // Recurring items — occurrence-tested (respects the start-date anchor)
        if (item.repeat && item.repeat !== 'none') {
            return this.occursOn(item, todayDate);
        }

        // One-time items: completed on a previous day = done
        if (item.lastCompletedDate && item.lastCompletedDate !== todayDate) {
            return false;
        }

        const itemDate = item.scheduledDate || (item.createdAt ? item.createdAt.slice(0, 10) : todayDate);
        return itemDate === todayDate;
    },

    // --- Grouped items ---

    /**
     * Get items grouped into today, this week, later
     */
    showOverdue: true,
    showToday: true,
    showTodayCompleted: false,
    showTomorrow: false,
    showLater: false,
    showListCompleted: false,

    // ===================================
    // Tasks sidebar filter (goals)
    // ===================================

    /**
     * Index every task by the goals it links to, reading the link table
     * once instead of querying per-task.
     * @returns {{ taskGoals: Map<string,Set> }}
     */
    buildTaskLinkIndex() {
        const taskGoals = new Map();
        const add = (map, key, val) => {
            if (!map.has(key)) map.set(key, new Set());
            map.get(key).add(val);
        };
        const links = (typeof LinkManager !== 'undefined') ? LinkManager.loadLinks() : [];
        for (const l of links) {
            if (l.sourceApp === 'schedule' && l.targetApp === 'goals') add(taskGoals, l.sourceId, l.targetId);
            else if (l.targetApp === 'schedule' && l.sourceApp === 'goals') add(taskGoals, l.targetId, l.sourceId);
        }
        return { taskGoals };
    },

    /**
     * Whether a task passes the active sidebar filter.
     */
    _taskPassesFilter(taskId, index) {
        const f = this.activeFilter || { type: 'all' };
        if (f.type === 'all') return true;

        const goalSet = index.taskGoals.get(taskId);

        if (f.type === 'unassigned') {
            return !goalSet || goalSet.size === 0;
        }
        if (f.type === 'goal') {
            return !!goalSet && goalSet.has(f.id);
        }
        return true;
    },

    /**
     * Get items grouped into today/overdue/etc.
     * @param {object} [opts]
     * @param {boolean} [opts.applySidebarFilter=false] - when true, also
     *   restrict to the active focus/goal sidebar filter. Off by default so
     *   other callers (e.g. the agent's daily briefing) see every task.
     * @param {boolean} [opts.applySearch=true] - when false, ignore the
     *   search box (used to compute sidebar counts independent of search).
     */
    getGroupedItems({ applySidebarFilter = false, applySearch = true } = {}) {
        const todayDate = this.getLocalToday();
        const tomorrowDate = this.getLocalDate(1);
        const query = applySearch ? this.searchQuery : '';

        const overdue = [];
        const todayActive = [];
        const todayCompleted = [];
        const tomorrow = [];
        const later = [];
        const noDate = [];   // one-time tasks with no scheduled date ("someday")

        const profiledItems = this.scheduleItems;
        const linkIndex = applySidebarFilter ? this.buildTaskLinkIndex() : null;
        for (const item of profiledItems) {
            // Search filter
            if (query && !item.title.toLowerCase().includes(query)) {
                continue;
            }

            // Sidebar goal filter
            if (applySidebarFilter && !this._taskPassesFilter(item.id, linkIndex)) {
                continue;
            }

            // One-time items resolved (completed or abandoned) on a previous
            // day — fully done, hide
            if (!item.repeat || item.repeat === 'none') {
                const resolvedOn = item.lastCompletedDate || this.lastAbandonedDate(item);
                if (resolvedOn && resolvedOn !== todayDate) continue;
            }

            // Recurring items — occurrence-tested against the actual dates so
            // the start-date anchor is respected (no occurrences before it).
            if (item.repeat && item.repeat !== 'none') {
                const dueToday = this.occursOn(item, todayDate);
                const dueTomorrow = this.occursOn(item, tomorrowDate);
                if (dueToday) {
                    if (this.isCompletedToday(item) || this.isAbandonedToday(item)) {
                        todayCompleted.push(item);
                    } else {
                        todayActive.push(item);
                    }
                }
                if (dueTomorrow) {
                    tomorrow.push(item);
                }
                // Monthly/annual tasks not due in the next day still surface in
                // Upcoming under their next occurrence; day-based ones simply
                // wait until their day comes around.
                const isDateBased = item.repeat === 'monthly' || item.repeat === 'annually';
                if (isDateBased && !dueToday && !dueTomorrow) {
                    later.push(item);
                }
                continue;
            }

            // One-time items completed (or abandoned) today
            if (this.isCompletedToday(item) || this.isAbandonedToday(item)) {
                todayCompleted.push(item);
                continue;
            }

            // Undated one-time tasks ("someday") get their own bucket instead of
            // being forced into Overdue/Today via a creation-date fallback.
            if (!item.scheduledDate) {
                noDate.push(item);
                continue;
            }

            const itemDate = item.scheduledDate;

            if (itemDate < todayDate) {
                overdue.push(item);
            } else if (itemDate === todayDate) {
                todayActive.push(item);
            } else if (itemDate === tomorrowDate) {
                tomorrow.push(item);
            } else {
                later.push(item);
            }
        }

        // Untimed tasks sort after timed ones within a day ('99:99' sentinel).
        const sortByTime = (a, b) => (a.startTime || '99:99').localeCompare(b.startTime || '99:99');
        const sortByDate = (a, b) => {
            const da = this._agendaDateFor(a);
            const db = this._agendaDateFor(b);
            return da.localeCompare(db) || sortByTime(a, b);
        };

        todayActive.sort(sortByTime);
        todayCompleted.sort(sortByTime);
        overdue.sort(sortByDate);
        tomorrow.sort(sortByTime);
        later.sort(sortByDate);
        // Undated tasks: timed ones first, then by title for a stable order.
        noDate.sort((a, b) => sortByTime(a, b) || (a.title || '').localeCompare(b.title || ''));

        // Group later items by date for better display. Recurring monthly/annual
        // tasks group under their NEXT occurrence, not their stale anchor.
        const laterByDate = {};
        for (const item of later) {
            const d = this._agendaDateFor(item);
            if (!laterByDate[d]) laterByDate[d] = [];
            laterByDate[d].push(item);
        }
        // Sort each group by time
        for (const d of Object.keys(laterByDate)) {
            laterByDate[d].sort(sortByTime);
        }
        const laterDates = Object.keys(laterByDate).sort();

        return { overdue, todayActive, todayCompleted, tomorrow, later, laterByDate, laterDates, noDate };
    },

    /**
     * Get items for the List view — the full backlog, grouped by status
     * rather than by date. Unlike getGroupedItems, this keeps completed
     * one-time tasks from previous days, so a focus area or goal shows its
     * whole history of work instead of just what is due in the next day.
     * @param {object} [opts]
     * @param {boolean} [opts.applySidebarFilter=true] - restrict to the
     *   active focus/goal sidebar filter.
     * @param {boolean} [opts.applySearch=true] - apply the search box.
     * @returns {{ todo: object[], completed: object[] }}
     */
    getListItems({ applySidebarFilter = true, applySearch = true } = {}) {
        const query = applySearch ? this.searchQuery : '';
        const profiledItems = this.scheduleItems;
        const linkIndex = applySidebarFilter ? this.buildTaskLinkIndex() : null;

        const todo = [];
        const completed = [];

        for (const item of profiledItems) {
            if (query && !item.title.toLowerCase().includes(query)) continue;
            if (applySidebarFilter && !this._taskPassesFilter(item.id, linkIndex)) continue;

            const isOneTime = !item.repeat || item.repeat === 'none';
            // One-time tasks with a completion date are "done". Repeating
            // tasks are ongoing commitments and stay in the active list —
            // their per-day completion shows on the card checkbox.
            if (isOneTime && (item.lastCompletedDate || this.lastAbandonedDate(item))) {
                completed.push(item);
            } else {
                todo.push(item);
            }
        }

        // To Do: dated tasks chronologically (overdue first), recurring last.
        const dateKey = (it) => it.scheduledDate || it.createdAt?.slice(0, 10) || '';
        const todoSortKey = (it) => {
            const isOneTime = !it.repeat || it.repeat === 'none';
            return (isOneTime || it.repeat === 'monthly' || it.repeat === 'annually')
                ? dateKey(it) : '9999-99-99';
        };
        todo.sort((a, b) =>
            todoSortKey(a).localeCompare(todoSortKey(b)) ||
            (a.startTime || '99:99').localeCompare(b.startTime || '99:99'));

        // Completed: most recently finished first.
        completed.sort((a, b) => (b.lastCompletedDate || '').localeCompare(a.lastCompletedDate || ''));

        return { todo, completed };
    },

    /**
     * Flat list of today items (used by dashboard preview + notifications)
     */
    getTodayItems() {
        return this.scheduleItems
            .filter(item => this.isItemForToday(item))
            .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
    },

    // --- Actions ---

    /**
     * Is this task done, in the sense the checkbox means? A one-time task is
     * done if it carries ANY completion date, so unchecking one finished on
     * an earlier day works; a repeating task is done only for today, because
     * it resets tomorrow. Extracted 2026-09-22 so a caller that wants a
     * DIRECTION ("complete this") rather than a toggle — the phone taps a
     * checkbox over the channel — asks the same question this funnel does.
     */
    isDone(item) {
        if (!item) return false;
        const isOneTime = !item.repeat || item.repeat === 'none';
        return isOneTime ? !!item.lastCompletedDate : this.isCompletedToday(item);
    },

    /** `quiet`: the change did not come from a gesture on this Mac. */
    toggleComplete(id, { quiet = false } = {}) {
        const item = this.scheduleItems.find(i => i.id === id);
        if (!item) return;

        const today = this.getLocalToday();
        const isOneTime = !item.repeat || item.repeat === 'none';
        const done = this.isDone(item);

        item.history = item.history || {};
        if (done) {
            item.lastCompletedDate = null;
            if (item.history[today] === 'done') delete item.history[today];
        } else {
            item.lastCompletedDate = today;
            // Completing overwrites an abandoned mark for the day — and for
            // one-time tasks clears older abandoned marks too, so the task
            // can't read as both completed and abandoned at once.
            item.history[today] = 'done';
            if (isOneTime) {
                for (const d of Object.keys(item.history)) {
                    if (item.history[d] === 'abandoned') delete item.history[d];
                }
            }
            // Auto-stop timer when completing
            if (item.timerStartedAt) {
                const elapsed = Date.now() - new Date(item.timerStartedAt).getTime();
                item.totalTimeSpent = (item.totalTimeSpent || 0) + Math.max(0, elapsed);
                item.timerStartedAt = null;
            }
            if (typeof AnalyticsManager !== 'undefined') {
                AnalyticsManager.record('schedule.task_completed');
            }
        }

        this.saveData();

        this.render();

        // Completing a task removes it from the active list — offer a one-tap
        // Undo so an accidental check has a safety net. Re-running toggleComplete
        // is the faithful inverse.
        if (!done && !quiet) {
            // Confetti and an Undo toast belong to a gesture ON THIS MAC
            // (Actions checkbox, detail button, row menus, widget, Pomodoro).
            // A phone ticking the box over the channel passes `quiet`: the
            // list still repaints, but the Mac does not celebrate something
            // that happened somewhere else, and an Undo nobody is looking at
            // is not a safety net. The agent's writers stay quiet too.
            if (typeof Celebration !== 'undefined') Celebration.burst();
            UIUtils.showToast('Task completed', 'success', 5000, {
                actionLabel: 'Undo',
                onAction: () => this.toggleComplete(id)
            });
        }
    },

    /**
     * Mark today's occurrence as deliberately not done ('abandoned'). For
     * recurring tasks this records the day in `history` (visible in the
     * detail page's History section); for one-time tasks it resolves the
     * task like completing does, just with the honest label. Toggling again
     * clears the mark.
     */
    toggleAbandoned(id) {
        const item = this.scheduleItems.find(i => i.id === id);
        if (!item) return;

        const today = this.getLocalToday();
        const isOneTime = !item.repeat || item.repeat === 'none';
        item.history = item.history || {};
        // Mirror toggleComplete's asymmetry: a one-time task is "abandoned"
        // if ANY abandoned mark exists (so restoring works on a later day);
        // a repeating task only for today's occurrence.
        const wasAbandoned = isOneTime
            ? !!this.lastAbandonedDate(item)
            : item.history[today] === 'abandoned';

        if (wasAbandoned) {
            if (isOneTime) {
                for (const d of Object.keys(item.history)) {
                    if (item.history[d] === 'abandoned') delete item.history[d];
                }
            } else {
                delete item.history[today];
            }
        } else {
            item.history[today] = 'abandoned';
            // Abandoning replaces a same-day completion.
            if (item.lastCompletedDate === today) item.lastCompletedDate = null;
        }
        item.modifiedAt = new Date().toISOString();
        this.saveData();
        this.render();

        if (!wasAbandoned) {
            UIUtils.showToast('Ignored', 'success', 5000, {
                actionLabel: 'Undo',
                onAction: () => this.toggleAbandoned(id)
            });
        }
    },

    /**
     * Resolve a reschedule keyword to a concrete date (or null for "no date"),
     * reusing the quick-add parser's date math. Keywords: today, tomorrow,
     * weekend (coming Saturday), nextweek (+7), none.
     */
    _resolveRescheduleDate(when) {
        const today = this.getLocalToday();
        const P = ScheduleQuickParse;
        switch (when) {
            case 'today': return today;
            case 'tomorrow': return P._addDays(today, 1);
            case 'weekend': return P._addDays(today, P._deltaToWeekday(today, 6, false));
            case 'nextweek': return P._addDays(today, 7);
            case 'none': return null;
            default: return today;
        }
    },

    /**
     * Move a single task to a new date without opening the editor. `when` is a
     * reschedule keyword (see _resolveRescheduleDate) or an explicit YYYY-MM-DD.
     */
    rescheduleTask(id, when) {
        const item = this.scheduleItems.find(i => i.id === id);
        if (!item) return;
        const date = /^\d{4}-\d{2}-\d{2}$/.test(when) ? when : this._resolveRescheduleDate(when);
        item.scheduledDate = date;
        item.modifiedAt = new Date().toISOString();
        this.saveData();
        this.render();
        const label = date
            ? ScheduleUI.formatRelativeDate(date, this.getLocalToday())
            : 'No date';
        UIUtils.showToast(date ? `Rescheduled to ${label}` : 'Moved to No date', 'success');
    },

    /**
     * Clear the overdue backlog in one action: push every currently-overdue
     * task (within the active sidebar filter) to today. This is the common
     * "start the day fresh" move that otherwise takes N editor round-trips.
     * Actions Today calls it with applySidebarFilter:false — the Tasks
     * sidebar filter is invisible from there and must not apply.
     */
    rescheduleAllOverdue({ applySidebarFilter = true } = {}) {
        const { overdue } = this.getGroupedItems({ applySidebarFilter });
        if (!overdue.length) return;
        const today = this.getLocalToday();
        const stamp = new Date().toISOString();
        for (const item of overdue) {
            item.scheduledDate = today;
            item.modifiedAt = stamp;
        }
        const n = overdue.length;
        this.saveData();
        this.render();
        UIUtils.showToast(`Moved ${n} task${n === 1 ? '' : 's'} to today`, 'success');
    },

    // --- Embedded editor hosting ---
    // The full editor's DOM can be moved INTO another view's pane (the
    // Tasks tab's right pane, Plan's detail pane) so opening a task keeps
    // that page's left nav — no view switch, no flicker. One host at a
    // time; every populate/wire path uses getElementById, so the editor
    // works wherever its nodes live. Hosts MUST call restoreEditorHome()
    // before wiping their pane, or the editor markup would be destroyed.

    /**
     * A task opens as its commitment's sheet; a new one starts in the capture
     * line (docs/COMMITMENTS.md phase 5b). The old editor sheet is gone; every
     * caller that used to open it lands here.
     */
    openEditor(itemId = null, opts = {}) {
        if (typeof CommitmentsPage === 'undefined' || !CommitmentsPage.takesOver()) return;
        if (itemId) CommitmentsPage.open(itemId);
        else CommitmentsPage.open(null, { text: opts.title || '' });
    },

    /**
     * Render linked items in the schedule editor
     */

    // --- Editor tag pills (the notes editor's recipe, shared TagPicker) ---

    /* ------------------------------------------------------------------
     * Save status (js/components/save-status.js, 2026-09-10)
     * ------------------------------------------------------------------ */

    /**
     * Create a task from the quick-add bar: title only, scheduled for today,
     * no time. When a focus area or goal is selected in the sidebar, the new
     * task is auto-linked to it so it lands in the bucket the user is in.
     */
    /**
     * Programmatic task creation for other apps (e.g., the Pomodoro timer
     * turns free-text session labels into real tasks). Same shape as
     * quickAddTask minus the sidebar auto-link and toast; returns the new id.
     */
    createTask(titleOrFields) {
        const fields = (titleOrFields && typeof titleOrFields === 'object') ? titleOrFields : { title: titleOrFields };
        const title = String(fields.title || '').trim();
        if (!title) return null;
        // Callers may run before this view has ever been opened — load
        // first so the push below doesn't clobber stored tasks on save.
        if (this.scheduleItems.length === 0) this.loadData();

        const newId = UIUtils.generateId();
        this.scheduleItems.push({
            id: newId,
            title,
            description: '',
            startTime: '',
            endTime: null,
            notifyBefore: 0,
            repeat: 'none',
            dayOfWeek: null,
            repeatDays: [],
            scheduledDate: this.getLocalToday(),
            reminderDaysBefore: [0],
            lastCompletedDate: null,
            createdAt: new Date().toISOString(),
            modifiedAt: new Date().toISOString(),
            // Provenance + timing a caller may set (News's "add this event";
            // Email's action items) — never the fields the app derives.
            ...Object.fromEntries(['description', 'startTime', 'scheduledDate', 'source', 'sourceNewsUrl', 'sourceNewsTitle', 'reminderStrategy']
                .filter(k => fields[k] != null).map(k => [k, fields[k]]))
        });

        this.saveData();
        this.render();
        return newId;
    },

    /**
     * Create a task from the quick-add bar. The raw string is run through the
     * natural-language parser, so "Call dentist tomorrow 3pm" lands as a task
     * named "Call dentist" dated tomorrow at 3:00 PM. Returns the new id on
     * success, or null when there is nothing to create (blank, or the input
     * was only date/time words with no task name left).
     */
    // defaultDate: where the task goes when the text names no date — the
    // caller's view context (Actions "Tomorrow" page → tomorrow; its "Later"
    // page → '' for the undated backlog). A date typed in the text always
    // wins. Omitted → today, unchanged.
    quickAddTask(raw, { silent = false, defaultDate } = {}) {
        raw = (raw || '').trim();
        if (!raw) return null;

        const parsed = ScheduleQuickParse.parse(raw, this.getLocalToday());
        const title = parsed.title.trim();
        if (!title) {
            // Everything parsed away (e.g. just "tomorrow 3pm") — nothing to name.
            UIUtils.showToast('Add a task name', 'error');
            return null;
        }
        const f = parsed.fields;
        const scheduledDate = f.scheduledDate || (defaultDate ?? this.getLocalToday());

        const newId = UIUtils.generateId();
        this.scheduleItems.push({
            id: newId,
            title,
            description: '',
            startTime: f.startTime || '',
            endTime: f.endTime || null,
            notifyBefore: 0,
            repeat: f.repeat || 'none',
            dayOfWeek: f.dayOfWeek,
            repeatDays: f.repeatDays || [],
            scheduledDate: scheduledDate,
            reminderDaysBefore: [0],
            lastCompletedDate: null,
            createdAt: new Date().toISOString(),
            modifiedAt: new Date().toISOString()
        });

        // Auto-link to whatever goal is selected in the sidebar.
        const filter = this.activeFilter || { type: 'all' };
        if (filter.type === 'goal' && filter.id) {
            LinkManager.addLink('goals', filter.id, 'schedule', newId);
        }

        this.saveData();
        this.render();
        if (!silent) {
            // Name the date when it isn't today — from the Actions Today view
            // a future-dated task vanishes from the list the moment it's
            // created, so the toast must say where it went.
            const today = this.getLocalToday();
            let msg = 'Task added';
            if (!scheduledDate) {
                msg = 'Added to Later (no date)';
            } else if (scheduledDate !== today) {
                const label = ScheduleUI.formatRelativeDate(scheduledDate, today);
                msg = `Added for ${label === 'Tomorrow' ? 'tomorrow' : label}`;
            }
            UIUtils.showToast(msg, 'success');
        }
        return newId;
    },

    /**
     * Context-DETACHED quick capture — for callers outside the Tasks view
     * (Actions Today, the global capture modal). Two safety wrappers around
     * quickAddTask:
     *   1. Load guard: quickAddTask has no hydration check, and saving over an
     *      unhydrated (empty) list would clobber the user's tasks.
     *   2. activeFilter neutralization: quickAddTask auto-links new tasks to
     *      the Tasks app's last sidebar filter — invisible from anywhere else,
     *      so it must not apply. Callers that want a link add it explicitly.
     */
    quickAddDetached(raw, opts) {
        if (this.scheduleItems.length === 0) this.loadData();
        const savedFilter = this.activeFilter;
        this.activeFilter = { type: 'all', id: null };
        try {
            return this.quickAddTask(raw, opts);
        } finally {
            this.activeFilter = savedFilter;
        }
    },

    /** Delete a task by id, including all its goal/focus links. */
    deleteTask(taskId) {
        LinkManager.removeAllLinksForItem('schedule', taskId);
        this.scheduleItems = this.scheduleItems.filter(i => i.id !== taskId);
        this.saveData();
    },

    /**
     * Which message-shaped source a task came from: 'imessage' | 'email' |
     * null. The ONE reader of a task's provenance (the Tasks nav's "Other
     * filters", the sheet's source banner): `source` is the stamp, and the
     * `imsg:` id prefix is the fallback for text-born tasks stamped 'email'
     * before the insight "Add task" door learned to name texts (2026-09-10).
     */
    messageSourceKind(item) {
        if (!item || !item.sourceEmailId) return null;
        if (item.source === 'imessage' || String(item.sourceEmailId).startsWith('imsg:')) return 'imessage';
        return 'email';
    },

    // --- Editor reminders management ---

    /**
     * The Remind row (2026-10-01): ONE choice over two stored fields — a
     * minutes value writes notifyBefore, a day value writes one advance day
     * (reminderDaysBefore; day-of 0 is always added on save). A stored
     * combination the row can't show (several advance days, or minutes AND
     * a day) is offered as "Keep current" and saved untouched unless the
     * user picks something else.
     */
    /**
     * Get the current task based on current time
     * Returns the first non-completed today item whose time window contains now
     */
    getCurrentTask() {
        const now = new Date();
        const nowMinutes = now.getHours() * 60 + now.getMinutes();
        const todayItems = this.getTodayItems().filter(i => !this.isCompletedToday(i) && !this.isAbandonedToday(i));

        for (let idx = 0; idx < todayItems.length; idx++) {
            const item = todayItems[idx];
            if (!item.startTime) continue;

            const [sh, sm] = item.startTime.split(':').map(Number);
            const startMin = sh * 60 + sm;

            let endMin;
            if (item.endTime) {
                const [eh, em] = item.endTime.split(':').map(Number);
                endMin = eh * 60 + em;
            } else {
                // No end time — use next task's start time, or +30min
                const next = todayItems[idx + 1];
                if (next && next.startTime) {
                    const [nh, nm] = next.startTime.split(':').map(Number);
                    endMin = nh * 60 + nm;
                } else {
                    endMin = startMin + 30;
                }
            }

            if (nowMinutes >= startMin && nowMinutes < endMin) {
                return { item, startMin, endMin, nowMinutes };
            }
        }
        return null;
    },

    // --- Timer ---

    getRunningTimerId() {
        const item = this.scheduleItems.find(i => i.timerStartedAt);
        return item ? item.id : null;
    },

    getElapsedMs(item) {
        let total = item.totalTimeSpent || 0;
        if (item.timerStartedAt) {
            total += Date.now() - new Date(item.timerStartedAt).getTime();
        }
        return Math.max(0, total);
    },

    formatDuration(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        if (hours > 0) return `${hours}h ${minutes}m`;
        if (minutes > 0) return `${minutes}m`;
        if (totalSeconds > 0) return `${totalSeconds}s`;
        return '0m';
    },

    formatDurationLive(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        return `${minutes}:${String(seconds).padStart(2, '0')}`;
    },

    startTimer(id) {
        const runningId = this.getRunningTimerId();
        if (runningId && runningId !== id) {
            this._stopTimerSilent(runningId);
        }
        const item = this.scheduleItems.find(i => i.id === id);
        if (!item || item.timerStartedAt) return;
        item.timerStartedAt = new Date().toISOString();
        item.modifiedAt = new Date().toISOString();
        this.saveData();
        this.render();
    },

    _stopTimerSilent(id) {
        const item = this.scheduleItems.find(i => i.id === id);
        if (!item || !item.timerStartedAt) return;
        const elapsed = Date.now() - new Date(item.timerStartedAt).getTime();
        item.totalTimeSpent = (item.totalTimeSpent || 0) + Math.max(0, elapsed);
        item.timerStartedAt = null;
        item.modifiedAt = new Date().toISOString();
    },

    stopTimer(id) {
        this._stopTimerSilent(id);
        this.saveData();
        this.render();
    },

    toggleTimer(id) {
        const item = this.scheduleItems.find(i => i.id === id);
        if (!item) return;
        if (item.timerStartedAt) {
            this.stopTimer(id);
        } else {
            this.startTimer(id);
        }
    },

    resetTimer(id) {
        const item = this.scheduleItems.find(i => i.id === id);
        if (!item) return;
        item.timerStartedAt = null;
        item.totalTimeSpent = 0;
        item.modifiedAt = new Date().toISOString();
        this.saveData();
    },

};

AppManager.register('schedule', ScheduleApp);

// The Schedule API other packages act through (Anjadhe.expose — see the
// SDK). Pomodoro is the first consumer: a focus session's task IS a
// schedule item, and it drives the item's built-in timer. Keep this
// surface small and stable; it is the contract, ScheduleApp is not.
if (typeof Anjadhe !== 'undefined') {
    Anjadhe.expose('schedule', {
        _ready() {
            if (!Array.isArray(ScheduleApp.scheduleItems) || ScheduleApp.scheduleItems.length === 0) {
                try { ScheduleApp.loadData(); } catch (_) { return false; }
            }
            return true;
        },
        /** Completed or abandoned today, or a one-time task already done. */
        isResolved(item) {
            if (!item) return true;
            if (ScheduleApp.isCompletedToday(item) || ScheduleApp.isAbandonedToday(item)) return true;
            const isOneTime = !item.repeat || item.repeat === 'none';
            return isOneTime && !!(item.lastCompletedDate || ScheduleApp.lastAbandonedDate(item));
        },
        /** Today's open items: [{ id, title, startTime, timerStartedAt }]. */
        todayTasks() {
            if (!this._ready()) return [];
            return ScheduleApp.getTodayItems()
                .filter(t => !this.isResolved(t))
                .map(t => ({ id: t.id, title: t.title || '(untitled)', startTime: t.startTime || '', timerStartedAt: t.timerStartedAt || null }));
        },
        /** One item by id (a read-only view), or null. */
        getTask(id) {
            if (!id || !this._ready()) return null;
            const t = ScheduleApp.scheduleItems.find(i => i.id === id);
            if (!t) return null;
            // A goal link is core data (LinkManager), so the project's name
            // rides along for pages that frame the task (the focus timer).
            let project = null;
            try { project = (typeof LinkManager !== 'undefined' && LinkManager.getGoalForTask(t.id)?.title) || null; } catch { project = null; }
            return { id: t.id, title: t.title || '', startTime: t.startTime || '', timerStartedAt: t.timerStartedAt || null,
                     repeat: t.repeat || 'none', lastCompletedDate: t.lastCompletedDate || null, resolved: this.isResolved(t),
                     description: t.description || '', scheduledDate: t.scheduledDate || null, tags: Array.isArray(t.tags) ? t.tags.slice() : [],
                     totalTimeSpent: t.totalTimeSpent || 0, project };
        },
        formatTime(s) { return (typeof ScheduleUI !== 'undefined' && ScheduleUI.formatTime) ? ScheduleUI.formatTime(s) : (s || ''); },
        /** Create a one-time task (a title, or { title, description,
         *  startTime, scheduledDate, source, sourceNewsUrl, … }); returns its id. */
        createTask(titleOrFields) { if (!this._ready()) return null; return ScheduleApp.createTask(titleOrFields); },
        /** Every item (read-only copies) — for callers that dedupe on provenance. */
        allTasks() { if (!this._ready()) return []; return ScheduleApp.scheduleItems.map(t => ({ ...t })); },
        startTimer(id) { if (this._ready()) ScheduleApp.startTimer(id); },
        stopTimer(id) { if (this._ready()) ScheduleApp.stopTimer(id); },
        /** Stop the item's timer as of a past instant (a session that ended while the app was closed). */
        stopTimerAt(id, endMs) {
            if (!this._ready()) return;
            const item = ScheduleApp.scheduleItems.find(i => i.id === id);
            if (!item || !item.timerStartedAt) return;
            const startedMs = new Date(item.timerStartedAt).getTime();
            item.totalTimeSpent = (item.totalTimeSpent || 0) + Math.max(0, endMs - startedMs);
            item.timerStartedAt = null;
            item.modifiedAt = new Date().toISOString();
            ScheduleApp.saveData();
        },
        completeTask(id) { if (this._ready()) ScheduleApp.toggleComplete(id); },
        /** Open the task's detail in the Tasks page (navigation only). */
        openTask(id) {
            if (!id) return;
            ScheduleApp.openEditor(id);
        }
    });
}



// The usual reminder for new tasks (docs/AI_NATIVE.md phase 4): a Memory
// sentence the assistant reads too, learned from the picker (_learnRemind).
if (typeof PrefAsks !== 'undefined') {
    const say = { m0: 'at their start time', m10: '10 minutes before', m30: '30 minutes before', d1: 'the day before', d2: 'two days before', d7: 'a week before' };
    const label = { m0: 'At start time', m10: '10 min before', m30: '30 min before', d1: '1 day before', d2: '2 days before', d7: '1 week before' };
    PrefAsks.register({
        id: 'reminder-default', order: 60, default: 'm0',
        question: 'When should I remind you about new tasks?',
        choices: Object.keys(say).map(v => ({ value: v, label: label[v], sentence: `Remind me about new tasks ${say[v]}.` }))
    });
}
