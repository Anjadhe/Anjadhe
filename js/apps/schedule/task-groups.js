/**
 * TaskGroups — the old Tasks page's slicing of the schedule, kept as DATA
 * (2026-10-05, docs/COMMITMENTS.md phase 5b): the group / tag / source
 * predicates, the Today / Tomorrow / This week / This month / Later
 * slices and the nav counts. The page is gone; the phone's Tasks screens
 * (js/agent/mobile-views.js `_tasks`) and the parity golden
 * (tests/task-list-parity-test.js) still read these over the `schedule`
 * blob the commitments bridge projects. Lifted verbatim from actions-app.js.
 */
const TaskGroups = {
    DAY_REPEATS: ['daily', 'weekdays', 'weekly', 'custom'],

    /** Done or deliberately not done: never pending, never overdue (the old TaskListUI rule). */
    _resolved(item) {
        if (!item) return false;
        const repeating = item.repeat && item.repeat !== 'none';
        if (ScheduleApp.isDone(item)) return true;
        return repeating ? ScheduleApp.isAbandonedToday(item) : !!ScheduleApp.lastAbandonedDate(item);
    },

    groupPredicateFor(f) {
        if (!f) return null;
        // Source scopes read the item's own provenance — 'src:email' is
        // every task the Insights pipeline created from MAIL, 'src:imessage'
        // every one it created from a TEXT conversation (sourceEmailId +
        // source, stamped by syncActionItemsToSchedule and the insight
        // "Add task" door; ScheduleApp.messageSourceKind is the one reader,
        // so a task sits in exactly one of the two).
        if (f === 'src:email') return (i) => ScheduleApp.messageSourceKind(i) === 'email';
        if (f === 'src:imessage') return (i) => ScheduleApp.messageSourceKind(i) === 'imessage';
        // Tag scopes read the item's own tags — no link index involved.
        if (f === 't:*') return (i) => Array.isArray(i.tags) && i.tags.length > 0;
        if (f.startsWith('t:')) {
            const name = f.slice(2);
            return (i) => Array.isArray(i.tags) && i.tags.includes(name);
        }
        const { taskGoals } = ScheduleApp.buildTaskLinkIndex();
        if (f === 'unassigned') {
            return (i) => !(taskGoals.get(i.id)?.size);
        }
        // A group scope = any linked goal carries the group's label.
        const groupGoalIds = new Set(this._groupGoals(f.startsWith('g:') ? f.slice(2) : null).map(g => g.id));
        return (i) => {
            const set = taskGoals.get(i.id);
            if (!set) return false;
            for (const gid of set) if (groupGoalIds.has(gid)) return true;
            return false;
        };
    },

    _allGoals() {
        return (StorageManager.get('goals')?.goals) || [];
    },

    _goalGroupOf(goal) {
        return (typeof goal.group === 'string' && goal.group.trim()) || '';
    },

    _groupGoals(name) {
        return this._allGoals().filter(g => this._goalGroupOf(g) === name);
    },

    _navCounts() {
        const groups = ScheduleApp.getGroupedItems({ applySidebarFilter: false, applySearch: false });
        const later = this._laterItems();
        const counts = {
            today: groups.overdue.length + groups.todayActive.length,
            tomorrow: this._rangeItems('tomorrow').total,
            week: this._rangeItems('week').total,
            month: this._rangeItems('month').total,
            later: later.total,
            all: 0,
            groups: new Map(),
            unassigned: 0,
            tags: new Map(),
            anyTag: 0,
            fromEmail: 0,
            fromTexts: 0,
        };
        // Per-group open-task counts via each task's linked goals; unassigned
        // = no goal link (same definition as _groupPredicate).
        const { taskGoals } = ScheduleApp.buildTaskLinkIndex();
        const groupByGoalId = new Map(this._allGoals().map(g => [g.id, this._goalGroupOf(g)]));
        for (const item of ScheduleApp.scheduleItems) {
            if (!item.title || this._resolved(item)) continue;
            counts.all++;
            // Tag counts must run before the no-goal `continue` below —
            // an untagged dimension is independent of goal links.
            if (Array.isArray(item.tags) && item.tags.length) {
                counts.anyTag++;
                for (const t of new Set(item.tags)) {
                    counts.tags.set(t, (counts.tags.get(t) || 0) + 1);
                }
            }
            // Same rule for provenance — a message-born task with no goal
            // link must still count.
            const kind = ScheduleApp.messageSourceKind(item);
            if (kind === 'email') counts.fromEmail++;
            else if (kind === 'imessage') counts.fromTexts++;
            const set = taskGoals.get(item.id);
            if (!set || set.size === 0) { counts.unassigned++; continue; }
            const seen = new Set();
            for (const gid of set) {
                const name = groupByGoalId.get(gid);
                if (name === undefined || seen.has(name)) continue;
                seen.add(name);
                counts.groups.set(name, (counts.groups.get(name) || 0) + 1);
            }
        }
        return counts;
    },

    _isoOf(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },

    _isoAddDays(iso, n) {
        const d = new Date(iso + 'T00:00:00');
        d.setDate(d.getDate() + n);
        return this._isoOf(d);
    },

    _rangeDates(id) {
        const today = ScheduleApp.getLocalToday();
        if (id === 'tomorrow') return [this._isoAddDays(today, 1)];
        const d = new Date(today + 'T00:00:00');
        let end;
        if (id === 'week') {
            end = this._isoAddDays(today, (7 - d.getDay()) % 7);
        } else {
            end = this._isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0));
        }
        const dates = [];
        for (let iso = today; iso <= end; iso = this._isoAddDays(iso, 1)) dates.push(iso);
        return dates;
    },

    _openItemsOn(dateStr, { includeDayRepeats = true } = {}) {
        const today = ScheduleApp.getLocalToday();
        return ScheduleApp.scheduleItems.filter(item => {
            if (!item.title) return false;
            const repeating = item.repeat && item.repeat !== 'none';
            if (!repeating) {
                return item.scheduledDate === dateStr
                    && !item.lastCompletedDate
                    && !ScheduleApp.lastAbandonedDate(item);
            }
            if (!includeDayRepeats && this.DAY_REPEATS.includes(item.repeat)) return false;
            if (!ScheduleApp.occursOn(item, dateStr)) return false;
            if (dateStr === today && (ScheduleApp.isCompletedToday(item) || ScheduleApp.isAbandonedToday(item))) return false;
            return true;
        }).sort((a, b) => this._startMins(a) - this._startMins(b));
    },

    _rangeItems(id, pred = null) {
        const includeDayRepeats = id !== 'month';
        const days = this._rangeDates(id)
            .map(date => ({ date, items: this._openItemsOn(date, { includeDayRepeats }).filter(i => !pred || pred(i)) }))
            .filter(d => d.items.length > 0);
        return { days, total: days.reduce((n, d) => n + d.items.length, 0) };
    },

    _resolvedItemsOn(dateStr, { includeDayRepeats = true } = {}) {
        return ScheduleApp.scheduleItems.filter(item => {
            if (!item.title) return false;
            const repeating = item.repeat && item.repeat !== 'none';
            if (!repeating) {
                return item.scheduledDate === dateStr
                    && !!(item.lastCompletedDate || ScheduleApp.lastAbandonedDate(item));
            }
            if (!includeDayRepeats && this.DAY_REPEATS.includes(item.repeat)) return false;
            if (!ScheduleApp.occursOn(item, dateStr)) return false;
            return !!(item.history && item.history[dateStr]);
        });
    },

    _laterItems(pred = null) {
        const today = ScheduleApp.getLocalToday();
        const d = new Date(today + 'T00:00:00');
        const monthEnd = this._isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0));

        const dated = [];
        const noDate = [];
        const done = [];
        for (const item of ScheduleApp.scheduleItems) {
            if (!item.title) continue;
            if (pred && !pred(item)) continue;
            const repeating = item.repeat && item.repeat !== 'none';
            if (repeating) {
                if (this.DAY_REPEATS.includes(item.repeat)) continue;
                const next = ScheduleApp.nextOccurrenceDate(item, today);
                if (next && next > monthEnd) dated.push({ item, date: next });
                continue;
            }
            if (item.lastCompletedDate || ScheduleApp.lastAbandonedDate(item)) {
                // Resolved tasks that belonged to this horizon (beyond the
                // month, or the undated backlog).
                if (!item.scheduledDate || item.scheduledDate > monthEnd) done.push(item);
                continue;
            }
            if (!item.scheduledDate) noDate.push(item);
            else if (item.scheduledDate > monthEnd) dated.push({ item, date: item.scheduledDate });
        }
        dated.sort((a, b) => a.date.localeCompare(b.date) || this._startMins(a.item) - this._startMins(b.item));
        noDate.sort((a, b) => (a.title || '').localeCompare(b.title || ''));

        // Group the dated ones by month for scannable headings.
        const months = [];
        for (const entry of dated) {
            const key = entry.date.slice(0, 7);
            let bucket = months[months.length - 1];
            if (!bucket || bucket.key !== key) {
                const md = new Date(entry.date + 'T00:00:00');
                bucket = { key, label: md.toLocaleDateString([], { month: 'long', year: 'numeric' }), entries: [] };
                months.push(bucket);
            }
            bucket.entries.push(entry);
        }
        return { months, noDate, done, total: dated.length + noDate.length };
    },

    _startMins(item) {
        const t = item.startTime || item.endTime;
        if (!t) return -1;
        const [h, m] = String(t).split(':').map(Number);
        return (h || 0) * 60 + (m || 0);
    },
};

if (typeof module !== 'undefined') module.exports = TaskGroups;
