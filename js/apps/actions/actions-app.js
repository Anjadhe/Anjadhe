/**
 * Actions App — the front door of the Goals → Tasks framework.
 *
 * Two tabs only (docs/POSITIONING.md "Part 1: Actions"): TASKS — this view,
 * a left nav of time slices (Today / Tomorrow / This Week / This Month) and
 * goal groups, with the selected task list on the right — and GOALS (the
 * Goals page: groups → goals → tasks). Today keeps its role as the
 * front door: it is the default selection, and quick add, calendar events,
 * assistant filing suggestions, and the weekly review all live here.
 * Actions is a frontend over EXISTING synced data: it owns no storage key,
 * and the `schedule` / `goals` / `links` blobs are untouched
 * ("rename the surface, not the keys").
 *
 * Time-slice nav items are also drop targets: drag a task row onto Today /
 * Tomorrow to reschedule it.
 */

const ActionsApp = {
    _bound: false,
    _completedExpanded: false,   // in-memory only: "N done" disclosure
    _view: 'tasks',              // 'tasks' | 'review' (weekly review flow)
    // Left-nav selection: a time slice or a goal-group scope. Per-window
    // state (sessionStorage) so Cmd+R restores it, like the Goals view state.
    // Two INDEPENDENT filter dimensions — a time window and a group scope —
    // so "Today" and "Health" compose instead of replacing each other.
    // time: 'today'|'tomorrow'|'week'|'month'|'later'|null (null = any date)
    // group: 'g:<name>' ('g:' = Ungrouped) | 'unassigned' | null (null = any)
    // Both null is normalized back to the Today default.
    _sel: { time: 'today', group: null },
    _selKey: 'anjadhe.actions.selection',
    REVIEW_DUE_DAYS: 7,
    CALENDAR_STALE_MS: 15 * 60 * 1000,
    // Assistant filing: unfiled/undated actions per batched LLM call.
    FILING_AI_BATCH: 20,
    _filing: false,
    // Repeat kinds that recur on a day rhythm — expanded per-day in the
    // week view, but kept OUT of the month view (a daily habit × 25 rows
    // would drown the one-time work; same call schedule's Upcoming makes).
    DAY_REPEATS: ['daily', 'weekdays', 'weekly', 'custom'],

    init() {
        this._ensureData();
        this._restoreSel();
        this._bindOnce();
        NavResizer.attach({
            layoutSel: '#actions-view .actions-layout',
            resizerId: 'actions-nav-resizer',
            cssVar: '--actions-nav-width',
            storageKey: 'actions-nav-width',
            defaultW: 188,
        });
    },

    /**
     * Apps init lazily on first openApp, so when Actions is the first thing
     * opened, ScheduleApp/CalendarApp have never loaded. Both loadData()s are
     * cheap synchronous reads and idempotent, so hydrate on every render
     * (same defensive pattern CalendarApp.render uses for ScheduleApp).
     */
    _ensureData() {
        ScheduleApp.loadData();
        CalendarApp.loadData();
    },

    _openTaskId: null,   // inline task detail open in the right pane

    _restoreSel() {
        try {
            const raw = window.sessionStorage.getItem(this._selKey);
            if (!raw) return;
            const s = JSON.parse(raw);
            if (!s) return;
            if ('time' in s || 'group' in s || 'focus' in s) this._sel = this._normalizeSel(s);
        } catch (_) {}
    },

    // Normalizes the {time, group} shape and enforces the invariant: never
    // both null. Legacy persisted shapes (a focus-area id, 'group:<name>')
    // simply drop their scope — focus areas are gone.
    _normalizeSel(sel) {
        let group = sel?.group ?? null;
        if (group !== 'unassigned' && group !== null
            && !(typeof group === 'string' && (group.startsWith('g:') || group.startsWith('t:')))) {
            group = null;
        }
        // Old sessionStorage carried `focus` (area id / 'group:<name>' /
        // 'unassigned') — keep only what still means something.
        if (!group && sel?.focus === 'unassigned') group = 'unassigned';
        const s = { time: sel?.time ?? null, group };
        const TIMES = ['today', 'tomorrow', 'week', 'month', 'later', 'all'];
        if (s.time && !TIMES.includes(s.time)) s.time = 'today';
        // Time is never null internally: 'all' is the explicit no-window
        // value (its own nav row). No filters at all → the Today default.
        if (!s.time) s.time = s.group ? 'all' : 'today';
        return s;
    },

    select(sel) {
        this._closeInlineTask();
        this._sel = this._normalizeSel(sel);
        this._view = 'tasks';
        this._completedExpanded = false;
        this._persistSel();
        this.render();
    },

    _persistSel() {
        try { window.sessionStorage.setItem(this._selKey, JSON.stringify(this._sel)); } catch (_) {}
    },

    // Nav clicks toggle their own dimension and leave the other alone.
    // Re-clicking the active time window falls back to All time (= no
    // window); re-clicking All time is a no-op — it already is the fallback.
    // EXCEPT from the inline task detail: there, clicking the active item
    // means "back to that list", never "clear the filter".
    _toggleTime(id) {
        if (this._openTaskId && this._sel.time === id) { this.select({ ...this._sel }); return; }
        const next = (this._sel.time === id && id !== 'all') ? 'all' : id;
        this.select({ time: next, group: this._sel.group });
    },

    _toggleGroup(id) {
        if (this._openTaskId && this._sel.group === id) { this.select({ ...this._sel }); return; }
        this.select({ time: this._sel.time, group: this._sel.group === id ? null : id });
    },

    render() {
        this._ensureData();
        this._reconcileSuggestions();
        // The ask row belongs to Today alone; every other path leaves it
        // empty rather than showing prompts about a list that isn't shown.
        const askRow = document.getElementById('actions-ask-row');
        if (askRow) { askRow.innerHTML = ''; askRow.classList.remove('is-task'); }

        // A selected group may have emptied out (goals regrouped or synced away).
        if (this._isGroupSel() && this._groupGoals(this._selGroupName()).length === 0) {
            this._sel = this._normalizeSel({ time: this._sel.time, group: null });
        }

        this._syncViewChrome();

        if (this._view === 'review') {
            Breadcrumb.render('actions-breadcrumb', [
                { label: 'Tasks', action: () => this.showToday() },
                { label: 'Weekly Review' }
            ]);
            ActionsReview.render();
            return;
        }

        // Inline task detail: keep it up while the editor is genuinely open
        // in our host (renders fired by background passes must not tear it
        // down). Adopt whatever task the editor holds — Duplicate switches
        // it to the copy in place. When the editor closed (back crumb,
        // delete), fall through to the list.
        if (this._openTaskId) {
            const host = document.getElementById('actions-task-detail');
            if (ScheduleApp.currentItemId && ScheduleApp._embedHost === host) {
                this._openTaskId = ScheduleApp.currentItemId;
                // No breadcrumb here either: the left nav stays up, and
                // clicking any nav item closes the detail back to a list.
                this._renderNav();
                this._renderTaskAskRow();
                return;
            }
            this._closeInlineTask();
            this._syncViewChrome();
        }

        this._renderNav();
        // No breadcrumb on list views — the selection pill in the main pane
        // (see _renderSelLine) is the single statement of what's showing.
        // Review and the inline task detail keep theirs: there the trail IS
        // the way back.

        // All time → the all-dates views. With a real time window, the group
        // scope (if any) applies as a per-item predicate on top.
        const pred = this._groupPredicate();
        if (this._sel.time === 'all') {
            if (this._sel.group === 'unassigned') this._renderUnassignedView();
            else if (this._isGroupSel()) this._renderGroupView();
            else if (this._isTagSel()) this._renderTagView(pred);
            else this._renderAllView();
            return;
        }
        if (this._sel.time === 'later') {
            this._renderLaterView(pred);
            return;
        }
        if (this._sel.time !== 'today') {
            this._renderRangeView(pred);
            return;
        }

        // --- Today: the front door, unchanged in substance ---
        // Both flags false: the Tasks app keeps its sidebar filter and search
        // in memory, and Today must never silently inherit them.
        let groups = ScheduleApp.getGroupedItems({ applySidebarFilter: false, applySearch: false });
        if (pred) {
            groups = {
                ...groups,
                overdue: groups.overdue.filter(pred),
                todayActive: groups.todayActive.filter(pred),
                todayCompleted: groups.todayCompleted.filter(pred),
            };
        }
        // Calendar events aren't tasks and carry no goal links — they only
        // belong on the unscoped Today view.
        const events = pred ? [] : this._todayEvents();

        this._renderDateLine(groups, events);
        this._renderAskRow(groups);
        this._renderList(groups);
        this._renderEvents(events);
        this._maybeBackgroundSync();
        // Assistant filing runs behind the paint, like the email bundle pass.
        setTimeout(() => this._fileActions(), 800);
    },

    /**
     * Prompt-buttons under the date line (Today only — other views clear it
     * in render()). Quoted questions that open the assistant: planning is a
     * conversation; the assistant's schedule tools do any rescheduling with
     * the user's say-so. Conditional buttons appear only when their problem
     * does — a permanent "help me cut" row would just be furniture.
     */
    ASK_OVERDUE_MIN: 3,
    ASK_TOOMUCH_MIN: 8,

    _renderAskRow(groups) {
        const row = document.getElementById('actions-ask-row');
        if (!row) return;
        if (typeof AgentUI === 'undefined' || !AgentUI.askWithPrompt) { row.innerHTML = ''; return; }
        const open = groups.todayActive.length + groups.overdue.length;
        const btn = (label, prompt) =>
            `<button type="button" class="ask-prompt-btn" data-ask="${AppManager.escapeHtml(prompt)}">&ldquo;${AppManager.escapeHtml(label)}&rdquo;</button>`;
        const buttons = [
            btn('Plan my day',
                'Plan my day. Read my tasks for today including overdue ones, and today\'s calendar events, then give me an ordered plan for the rest of the day: what to do first, what fits where, and what to move if it does not fit. Be concrete and brief.'),
            btn('What should I do next?',
                'What should I do next right now? Look at my open tasks for today (including overdue) and my calendar, pick ONE, and say why in a sentence.'),
            groups.overdue.length >= this.ASK_OVERDUE_MIN ? btn('Help me clear the overdue',
                'Help me clear my overdue tasks. Go through them one at a time: for each, propose doing it today, a specific new date, or dropping it, and make the change when I agree.') : '',
            open >= this.ASK_TOOMUCH_MIN ? btn('Too much. Help me cut',
                'My task list for today is too long. Help me cut it down: propose which tasks to move or drop and to when, then reschedule the ones I agree to.') : ''
        ].filter(Boolean).join('');
        row.innerHTML = buttons;
        row.querySelectorAll('[data-ask]').forEach(b =>
            b.addEventListener('click', () => AgentUI.askWithPrompt(b.dataset.ask, { newChat: true })));
    },

    /**
     * Conversation doors for ONE task — shared by the Tasks tab's inline
     * detail and the Goals page's task embed. Quoted questions that hand
     * the task to the assistant; the day-level pills ("Plan my day") stay
     * on the Today list where they belong.
     */
    taskAskPillsHtml(title, taskId) {
        const t = String(title || '').trim();
        if (!t) return '';
        const btn = (label, prompt) =>
            `<button type="button" class="ask-prompt-btn" data-ask="${AppManager.escapeHtml(prompt)}">&ldquo;${AppManager.escapeHtml(label)}&rdquo;</button>`;
        const pills = [
            btn('Help me break this down',
                `Help me break my task "${t}" into smaller concrete steps. Propose them, and add the ones I agree to as tasks.`),
            btn('When should I do this?',
                `When should I do my task "${t}"? Look at my schedule for the coming days, propose a specific day and time, and reschedule it when I agree.`),
            btn('I keep putting this off',
                `I keep putting off my task "${t}". Ask me what is blocking it, then help me shrink it to something I will actually do — or decide honestly to drop it.`)
        ];
        // The dashed open-composer door (the strategy page's pattern):
        // quoted pills ask a question for you, this one hands you the
        // composer with the task as context. Only when the caller passes
        // the id — the id is what the AgentContext providers key on.
        if (taskId) {
            pills.push(`<button type="button" class="ask-prompt-btn ask-prompt-open" data-ask-open-task="${AppManager.escapeHtml(taskId)}">Ask about this task…</button>`);
        }
        return pills.join('');
    },

    /**
     * AgentContext block for ONE task — shared by the Actions provider
     * (inline task detail) and the Goals page provider (task embed), so
     * "this task" reads the same on both pages. recordKey scopes the
     * panel's conversation to the task (AgentUI.open attaches to it).
     */
    taskContextBlock(taskId, opts = {}) {
        if (!taskId || typeof ScheduleApp === 'undefined') return null;
        if (!Array.isArray(ScheduleApp.scheduleItems) || ScheduleApp.scheduleItems.length === 0) {
            ScheduleApp.loadData();
        }
        const item = (ScheduleApp.scheduleItems || []).find(i => i.id === taskId);
        if (!item) return null;

        const state = (typeof TaskListUI !== 'undefined') ? TaskListUI.stateOf(item) : null;
        let goalLine = '';
        try {
            const goalLink = LinkManager.getLinksForApp('schedule', item.id, 'goals')[0];
            if (goalLink) {
                const goal = ((StorageManager.get('goals')?.goals) || []).find(g => g.id === goalLink.itemId);
                if (goal) goalLine = `\nLinked goal: ${goal.title}`;
            }
        } catch (_) {}

        // attached: the conversation is tagged with this record but the user
        // isn't on its page right now (record-resolver fallback) — the lead
        // sentence must not claim they are looking at it.
        const lead = opts.attached
            ? 'This conversation is attached to the task below (the user may not have it open right now)'
            : 'The user is viewing the task below';
        return {
            recordKey: 'schedule:' + item.id,
            recordLabel: item.title || '(untitled task)',
            title: 'CURRENT TASK',
            body: `${lead}. The task is available as context, not a constraint:

- When the user's question is about "this task", work with the data below. To modify it, call update_schedule_item with id: "${item.id}"; complete_task marks it done.
- For general questions, answer normally.

Title: ${item.title || '(untitled)'}
Status: ${state || 'unknown'}
Date: ${item.scheduledDate || 'none'}${item.startTime ? `\nTime: ${item.startTime}` : ''}${item.repeat && item.repeat !== 'none' ? `\nRepeats: ${item.repeat}` : ''}${goalLine}
Task id: ${item.id}${item.description ? `\n\nNotes:\n${item.description}` : ''}`,
            suggestedPrompts: [
                'Help me break this down',
                'When should I do this?',
                'Does this still matter?'
            ]
        };
    },

    // The task detail replaces the Today pills with task-scoped ones,
    // aligned to the embedded editor's centered column (.is-task).
    _renderTaskAskRow() {
        const row = document.getElementById('actions-ask-row');
        if (!row) return;
        if (typeof AgentUI === 'undefined' || !AgentUI.askWithPrompt) { row.innerHTML = ''; return; }
        const item = ScheduleApp.scheduleItems.find(i => i.id === this._openTaskId);
        row.classList.toggle('is-task', !!item);
        row.innerHTML = item ? this.taskAskPillsHtml(item.title, item.id) : '';
        row.querySelectorAll('[data-ask]').forEach(b =>
            b.addEventListener('click', () => AgentUI.askWithPrompt(b.dataset.ask, { newChat: true })));
        // Empty composer, task as context — _openTaskId is already what the
        // AgentContext provider reads, so nothing to stamp here.
        row.querySelectorAll('[data-ask-open-task]').forEach(b =>
            b.addEventListener('click', () => AgentUI.openComposer()));
    },

    _timeLabel() {
        return { today: 'Today', tomorrow: 'Tomorrow', week: 'This Week', month: 'This Month', later: 'Later', all: 'All time' }[this._sel.time] || null;
    },

    _groupLabel() {
        if (!this._sel.group) return null;
        if (this._sel.group === 'unassigned') return 'No goal';
        if (this._sel.group === 't:*') return 'All tags';
        if (this._isTagSel()) return this._sel.group.slice(2);
        return this._selGroupName() || 'Ungrouped';
    },

    _selLabel() {
        return [this._timeLabel(), this._groupLabel()].filter(Boolean).join(' · ') || 'Today';
    },

    /** Per-item predicate for the group dimension; null when unscoped. */
    _groupPredicate() {
        const f = this._sel.group;
        if (!f) return null;
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
        const groupGoalIds = new Set(this._groupGoals(this._selGroupName()).map(g => g.id));
        return (i) => {
            const set = taskGoals.get(i.id);
            if (!set) return false;
            for (const gid of set) if (groupGoalIds.has(gid)) return true;
            return false;
        };
    },

    // Goals straight from storage so the nav works even if the Goals page
    // never initialized this session.
    _allGoals() {
        return (StorageManager.get('goals')?.goals) || [];
    },

    // --- Group scope ('g:<name>' in _sel.group; 'g:' = Ungrouped) ---

    _isGroupSel() {
        return typeof this._sel.group === 'string' && this._sel.group.startsWith('g:');
    },

    // --- Tag scope ('t:<name>' in _sel.group; 't:*' = any tag) ---

    /** Picking a tag is a FINDING move — jump the time window to All time
     *  so the whole tag shows, rather than intersecting with Today and
     *  reading as empty. Clicking the active tag clears it (the group
     *  toggle's contract). */
    _toggleTag(id) {
        if (this._openTaskId && this._sel.group === id) { this.select({ ...this._sel }); return; }
        if (this._sel.group === id) this.select({ time: this._sel.time, group: null });
        else this.select({ time: 'all', group: id });
    },

    _isTagSel() {
        return typeof this._sel.group === 'string' && this._sel.group.startsWith('t:');
    },

    /** Every tag name in use on any task, alphabetical — the nav's Tags
     *  section. Read from all items (not just open ones) so a tag doesn't
     *  vanish from the nav the moment its last task is completed. */
    _allTaskTags() {
        const names = new Set();
        for (const it of ScheduleApp.scheduleItems) {
            for (const t of (it.tags || [])) if (t) names.add(t);
        }
        return [...names].sort((a, b) => a.localeCompare(b));
    },

    _renderTagView(pred) {
        const items = ScheduleApp.scheduleItems.filter(i => i.title && pred(i));
        this._renderFlatView(items,
            '<div class="actions-empty">No tasks carry this tag.</div>');
    },

    _selGroupName() {
        return this._isGroupSel() ? this._sel.group.slice(2) : null;
    },

    /** The group key a goal belongs to (trimmed name, '' = Ungrouped). */
    _goalGroupOf(goal) {
        return (typeof goal.group === 'string' && goal.group.trim()) || '';
    },

    _groupGoals(name) {
        return this._allGoals().filter(g => this._goalGroupOf(g) === name);
    },

    // Show/hide the list vs task-detail vs review chrome. The left nav
    // stays up for the inline task detail — only the review hides it.
    _syncViewChrome() {
        const inReview = this._view === 'review';
        const inTask = !inReview && !!this._openTaskId;
        // The title slot is always occupied — every other app names itself in
        // the header, and Actions was the one page that didn't. What varies is
        // the DEPTH: list views and the task detail say just "Actions" (their
        // selection is stated by the pills in the main pane and by the left
        // nav, which stays up), while Review keeps the real trail because
        // there the crumb is the way back.
        const title = document.querySelector('#actions-view > .app-header-bar > .app-view-title');
        if (title) title.style.display = '';
        if (!inReview) Breadcrumb.render('actions-breadcrumb', [{ label: 'Tasks' }]);
        for (const id of ['actions-date-line', 'actions-today-container', 'actions-events-container']) {
            const el = document.getElementById(id);
            if (el) el.style.display = (inReview || inTask) ? 'none' : '';
        }
        const nav = document.getElementById('actions-nav');
        if (nav) nav.style.display = inReview ? 'none' : '';
        const quickAdd = document.querySelector('#actions-view .actions-quick-add-wrap');
        if (quickAdd) quickAdd.style.display = (inReview || inTask) ? 'none' : '';
        const review = document.getElementById('actions-review-container');
        if (review) review.style.display = inReview ? '' : 'none';
        const taskHost = document.getElementById('actions-task-detail');
        if (taskHost) taskHost.style.display = inTask ? '' : 'none';
        const taskBack = document.getElementById('actions-task-back');
        if (taskBack) taskBack.style.display = inTask ? '' : 'none';
    },

    // The Tasks tab, on the Today selection (the front door + review exit).
    showToday() {
        this._closeInlineTask();
        this._view = 'tasks';
        this._sel = { time: 'today', group: null };
        this._persistSel();
        this.render();
    },

    showTasks() {
        this._closeInlineTask();
        this._view = 'tasks';
        this.render();
    },

    showReview() {
        this._closeInlineTask();
        this._view = 'review';
        ActionsReview.start();
        this.render();
    },

    // Review is "due" after 7 days — surfaced as a quiet link, never a nag.
    _reviewDue() {
        const last = StorageManager.get('actionsSettings')?.lastReviewAt;
        if (!last) return true;
        return (Date.now() - new Date(last).getTime()) > this.REVIEW_DUE_DAYS * 86400000;
    },

    // --- Left nav (time slices + goal groups) ---

    _renderNav() {
        const nav = document.getElementById('actions-nav');
        if (!nav) return;
        const counts = this._navCounts();
        const isSel = (dim, id) => this._sel[dim] === id;

        const timeItems = [
            { id: 'today', label: 'Today', count: counts.today, drop: 'date:today' },
            { id: 'tomorrow', label: 'Tomorrow', count: counts.tomorrow, drop: 'date:tomorrow' },
            { id: 'week', label: 'This Week', count: counts.week, drop: null },
            { id: 'month', label: 'This Month', count: counts.month, drop: null },
            { id: 'later', label: 'Later', count: counts.later, drop: null },
            { id: 'all', label: 'All time', count: counts.all, drop: null },
        ];
        let html = '<div class="actions-nav-header">Dates</div>';
        // Two-tier counts (the Inbox rail's vocabulary): Today wears the
        // attention badge — its number, overdue included, is what wants you
        // now. Every other slice's count is inventory and stays quiet.
        html += '<div class="actions-nav-section">' + timeItems.map(t => `
            <button type="button" class="actions-nav-item${isSel('time', t.id) ? ' is-active' : ''}"
                    data-nav-time="${t.id}"${t.drop ? ` data-drop="${t.drop}"` : ''}>
                <span class="actions-nav-label">${t.label}</span>
                ${t.count ? `<span class="actions-nav-count${t.id === 'today' ? ' actions-nav-count--attn' : ''}">${t.count}</span>` : ''}
            </button>`).join('') + '</div>';

        // Goal groups, in first-seen goal order (matches the Goals page).
        // Reads straight from storage so the nav works even if the Goals
        // page never initialized this session.
        const goals = this._allGoals();
        if (goals.length > 0) {
            const named = [];
            let hasUngrouped = false;
            for (const g of goals) {
                const name = this._goalGroupOf(g);
                if (name === '') { hasUngrouped = true; continue; }
                if (!named.includes(name)) named.push(name);
            }
            const order = [...named, ...(hasUngrouped ? [''] : [])];

            html += '<div class="actions-nav-header">Groups</div>';
            html += order.map(g => `
                <button type="button" class="actions-nav-item${isSel('group', 'g:' + g) ? ' is-active' : ''}"
                        data-nav-group="${UIUtils.escapeHtml(g)}" title="Show tasks for every ${UIUtils.escapeHtml(g || 'Ungrouped')} goal">
                    <span class="actions-nav-label">${UIUtils.escapeHtml(g || 'Ungrouped')}</span>
                    ${counts.groups.get(g) ? `<span class="actions-nav-count">${counts.groups.get(g)}</span>` : ''}
                </button>`).join('');

            // The escape hatch: tasks linked to no goal are invisible in
            // every group view above — give them a row of their own so
            // nothing can hide.
            html += `
                <button type="button" class="actions-nav-item actions-nav-unfiled${isSel('group', 'unassigned') ? ' is-active' : ''}"
                        data-nav-unassigned="1" title="Tasks not linked to any goal">
                    <span class="actions-nav-label">No goal</span>
                    ${counts.unassigned ? `<span class="actions-nav-count">${counts.unassigned}</span>` : ''}
                </button>`;
        }

        // Tags — the task-tag dimension (Reminders lists arrive here via
        // the Apple import; user tags ride the same field). "All tags" is
        // the umbrella row; per-tag rows carry quiet open-task counts.
        const tagNames = this._allTaskTags();
        if (tagNames.length > 0) {
            html += '<div class="actions-nav-header">Tags</div>';
            html += `
                <button type="button" class="actions-nav-item${isSel('group', 't:*') ? ' is-active' : ''}"
                        data-nav-tag="*" title="Every task carrying any tag">
                    <span class="actions-nav-label">All tags</span>
                    ${counts.anyTag ? `<span class="actions-nav-count">${counts.anyTag}</span>` : ''}
                </button>`;
            html += tagNames.map(t => `
                <button type="button" class="actions-nav-item${isSel('group', 't:' + t) ? ' is-active' : ''}"
                        data-nav-tag="${UIUtils.escapeHtml(t)}" title="Tasks tagged ${UIUtils.escapeHtml(t)}">
                    <span class="actions-nav-label">${UIUtils.escapeHtml(t)}</span>
                    ${counts.tags.get(t) ? `<span class="actions-nav-count">${counts.tags.get(t)}</span>` : ''}
                </button>`).join('');
        }

        nav.innerHTML = html;
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
        };
        // Per-group open-task counts via each task's linked goals; unassigned
        // = no goal link (same definition as _groupPredicate).
        const { taskGoals } = ScheduleApp.buildTaskLinkIndex();
        const groupByGoalId = new Map(this._allGoals().map(g => [g.id, this._goalGroupOf(g)]));
        for (const item of ScheduleApp.scheduleItems) {
            if (!item.title || TaskListUI.isCompleted(item) || TaskListUI.isAbandoned(item)) continue;
            counts.all++;
            // Tag counts must run before the no-goal `continue` below —
            // an untagged dimension is independent of goal links.
            if (Array.isArray(item.tags) && item.tags.length) {
                counts.anyTag++;
                for (const t of new Set(item.tags)) {
                    counts.tags.set(t, (counts.tags.get(t) || 0) + 1);
                }
            }
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

    // --- Time-slice data (Tomorrow / This Week / This Month) ---

    _isoOf(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },

    _isoAddDays(iso, n) {
        const d = new Date(iso + 'T00:00:00');
        d.setDate(d.getDate() + n);
        return this._isoOf(d);
    },

    // The literal calendar reading: This Week = today through the coming
    // Sunday, This Month = today through the month's last day.
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

    // Open items occurring on a date: one-time tasks dated there (not yet
    // resolved) plus recurring occurrences (today's already-done ones drop).
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

    // Resolved counterpart of _openItemsOn: items whose occurrence on the
    // date ended done/abandoned (one-time tasks: resolved whenever).
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

    // The collapsed "N done" disclosure every list view shares.
    _doneSectionHtml(done) {
        if (!done.length) return '';
        return `
            <div class="actions-section">
                <button class="actions-completed-toggle" id="actions-completed-toggle" aria-expanded="${this._completedExpanded}">
                    ${this._completedExpanded ? '&#9662;' : '&#9656;'} ${done.length} done
                </button>
                ${this._completedExpanded ? done.map(item => this._renderRow(item, { completed: true })).join('') : ''}
            </div>`;
    },

    _renderRangeView(pred = null) {
        const { days, total } = this._rangeItems(this._sel.time, pred);
        const today = ScheduleApp.getLocalToday();
        const tomorrow = this._isoAddDays(today, 1);

        // Resolved tasks whose date falls in this window, deduped (a
        // repeating task can occur on several days of the range).
        const includeDayRepeats = this._sel.time !== 'month';
        const doneSeen = new Set();
        const done = [];
        for (const date of this._rangeDates(this._sel.time)) {
            for (const item of this._resolvedItemsOn(date, { includeDayRepeats })) {
                if (pred && !pred(item)) continue;
                if (doneSeen.has(item.id)) continue;
                doneSeen.add(item.id);
                done.push(item);
            }
        }

        const parts = [`${total} to do`];
        if (done.length) parts.push(`${done.length} done`);
        this._renderSelLine(parts);

        const container = document.getElementById('actions-today-container');
        if (container) {
            let html = '';
            for (const day of days) {
                const heading = day.date === today ? 'Today'
                    : day.date === tomorrow ? 'Tomorrow'
                    : ScheduleUI.formatLaterDateHeading(day.date, today);
                html += `
                    <div class="actions-section">
                        <div class="actions-section-header">${UIUtils.escapeHtml(heading)} <span class="actions-section-count">${day.items.length}</span></div>
                        ${day.items.map(item => this._renderRow(item, {})).join('')}
                    </div>`;
            }
            if (days.length === 0) {
                html = `<div class="actions-empty">Nothing scheduled for ${this._selLabel().toLowerCase()}. Add an action above, or hit Plan to line up your goals.</div>`;
            } else if (this._sel.time === 'month'
                && ScheduleApp.scheduleItems.some(i => this.DAY_REPEATS.includes(i.repeat))) {
                html += '<div class="actions-range-note">Daily and weekly repeating tasks show in Today and This Week.</div>';
            }
            html += this._doneSectionHtml(done);
            container.innerHTML = html;
        }
        const events = document.getElementById('actions-events-container');
        if (events) events.innerHTML = '';
    },

    // --- Later view (beyond this month + the undated backlog) ---

    // Dated beyond the current month: one-time tasks past month-end, plus
    // monthly/annual repeats whose next occurrence is past it (day-based
    // repeats stay in Today/This Week, as in the month view). Undated
    // one-time tasks form the "No date" backlog beneath.
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

    _renderLaterView(pred = null) {
        const { months, noDate, done, total } = this._laterItems(pred);
        const today = ScheduleApp.getLocalToday();
        const parts = [`${total} to do`];
        if (done.length) parts.push(`${done.length} done`);
        this._renderSelLine(parts);

        const container = document.getElementById('actions-today-container');
        if (container) {
            let html = '';
            for (const m of months) {
                html += `
                    <div class="actions-section">
                        <div class="actions-section-header">${UIUtils.escapeHtml(m.label)} <span class="actions-section-count">${m.entries.length}</span></div>
                        ${m.entries.map(({ item, date }) =>
                            this._renderRow(item, { dateLabel: ScheduleUI.formatRelativeDate(date, today) })).join('')}
                    </div>`;
            }
            if (noDate.length > 0) {
                html += `
                    <div class="actions-section">
                        <div class="actions-section-header">No date <span class="actions-section-count">${noDate.length}</span></div>
                        ${noDate.map(item => this._renderRow(item, { dateGutter: true })).join('')}
                    </div>`;
            }
            if (!html) {
                html = '<div class="actions-empty">Nothing scheduled beyond this month, and no undated backlog. Clean horizon.</div>';
            }
            html += this._doneSectionHtml(done);
            container.innerHTML = html;
        }
        const events = document.getElementById('actions-events-container');
        if (events) events.innerHTML = '';
    },

    // --- Group view (a nav group, at All time) ---

    // Open tasks across every goal in the group, sectioned per goal
    // (status-sorted, same order as the Goals page) so the view reads as a
    // mini plan, not a flat pile. A task linked to several of the group's
    // goals lands under the first one.
    _renderGroupView() {
        const name = this._selGroupName();
        // Active goals first, completed last; stored order otherwise.
        const goals = this._groupGoals(name)
            .sort((a, b) => (a.status === 'completed') - (b.status === 'completed'));
        const { taskGoals } = ScheduleApp.buildTaskLinkIndex();
        const today = ScheduleApp.getLocalToday();
        const isResolved = (i) => TaskListUI.isCompleted(i, today) || TaskListUI.isAbandoned(i, today);
        const byUrgency = (a, b) =>
            (a.scheduledDate || '9999').localeCompare(b.scheduledDate || '9999')
            || this._startMins(a) - this._startMins(b)
            || (a.title || '').localeCompare(b.title || '');

        const buckets = goals.map(g => ({ goal: g, items: [] }));
        const byGoalId = new Map(buckets.map(b => [b.goal.id, b]));
        const done = [];
        let openCount = 0;
        for (const item of ScheduleApp.scheduleItems) {
            if (!item.title) continue;
            const set = taskGoals.get(item.id);
            if (!set) continue;
            let placed = null;
            for (const gid of set) { if (byGoalId.has(gid)) { placed = byGoalId.get(gid); break; } }
            if (!placed) continue;
            if (isResolved(item)) { done.push(item); continue; }
            placed.items.push(item);
            openCount++;
        }
        const goalSections = buckets.filter(b => b.items.length > 0);

        this._renderSelLine([`${openCount} to do`]);

        const container = document.getElementById('actions-today-container');
        if (container) {
            const row = (item) => {
                const repeating = item.repeat && item.repeat !== 'none';
                // The section header already names the goal — a per-row goal
                // chip would repeat it down every line.
                return this._renderRow(item, {
                    dateLabel: repeating
                        ? ScheduleUI.getRepeatLabel(item)
                        : (item.scheduledDate ? ScheduleUI.formatRelativeDate(item.scheduledDate, today) : ''),
                    late: !repeating && item.scheduledDate && item.scheduledDate < today,
                    noGoalChip: true,
                    dateGutter: true,
                });
            };
            let html = '';
            for (const { goal, items } of goalSections) {
                items.sort(byUrgency);
                html += `
                    <div class="actions-section">
                        <button class="actions-section-header actions-goal-heading" data-open-goal="${goal.id}" title="Open this goal">
                            ${UIUtils.escapeHtml(goal.title)} <span class="actions-section-count">${items.length}</span>
                        </button>
                        ${items.map(row).join('')}
                    </div>`;
            }
            if (openCount === 0) {
                html += `<div class="actions-empty">No open tasks for the ${UIUtils.escapeHtml(name || 'Ungrouped')} goals. Hit Plan and open a goal to add some.</div>`;
            }
            html += this._doneSectionHtml(done);
            container.innerHTML = html;
        }
        const events = document.getElementById('actions-events-container');
        if (events) events.innerHTML = '';
    },

    // --- All-dates flat views (All time, and No goal) ---

    _renderUnassignedView() {
        const { taskGoals } = ScheduleApp.buildTaskLinkIndex();
        const unassigned = ScheduleApp.scheduleItems.filter(item =>
            item.title && !(taskGoals.get(item.id)?.size));
        this._renderFlatView(unassigned,
            '<div class="actions-empty">Every open task is linked to a goal. New tasks added here stay unlinked until you file them.</div>');
    },

    _renderAllView() {
        const items = ScheduleApp.scheduleItems.filter(i => i.title);
        this._renderFlatView(items,
            '<div class="actions-empty">No tasks yet. Add an action above to get started.</div>');
    },

    // Shared body: urgency-sorted open list + the collapsed done section.
    _renderFlatView(items, emptyHtml) {
        const today = ScheduleApp.getLocalToday();
        const byUrgency = (a, b) =>
            (a.scheduledDate || '9999').localeCompare(b.scheduledDate || '9999')
            || this._startMins(a) - this._startMins(b)
            || (a.title || '').localeCompare(b.title || '');
        const isResolved = (i) => TaskListUI.isCompleted(i, today) || TaskListUI.isAbandoned(i, today);
        const done = items.filter(isResolved);
        const todo = items.filter(i => !isResolved(i)).sort(byUrgency);

        const parts = [`${todo.length} to do`];
        if (done.length) parts.push(`${done.length} done`);
        this._renderSelLine(parts);

        const container = document.getElementById('actions-today-container');
        if (container) {
            let html = '';
            if (todo.length > 0) {
                html += `
                    <div class="actions-section">
                        <div class="actions-section-header">To do <span class="actions-section-count">${todo.length}</span></div>
                        ${todo.map(item => this._renderRow(item, {
                            dateLabel: (item.repeat && item.repeat !== 'none')
                                ? ScheduleUI.getRepeatLabel(item)
                                : (item.scheduledDate ? ScheduleUI.formatRelativeDate(item.scheduledDate, today) : ''),
                            late: !(item.repeat && item.repeat !== 'none') && item.scheduledDate && item.scheduledDate < today,
                            dateGutter: true,
                        })).join('')}
                    </div>`;
            } else {
                html += emptyHtml;
            }
            html += this._doneSectionHtml(done);
            container.innerHTML = html;
        }
        const events = document.getElementById('actions-events-container');
        if (events) events.innerHTML = '';
    },

    // --- Data helpers ---

    // Google events only: getEventsForDate also returns schedule-task
    // pseudo-events (source 'schedule', no account) — those are already
    // rendered as action rows, so keeping them here would duplicate tasks.
    _todayEvents() {
        if (CalendarApp.getAccounts().length === 0) return [];
        return CalendarApp.getEventsForDate(new Date()).filter(e => e.account);
    },

    // --- Rendering ---

    // The selection pills ARE the page heading: each active filter dimension
    // (time window, group scope) restated as its own dismissible chip at the
    // top of the main pane, so the pane always says what it's showing without
    // a breadcrumb and a title repeating each other. The × on a pill clears
    // just that dimension; the resting default (Today alone) has no ×.
    _renderSelLine(summaryParts) {
        const el = document.getElementById('actions-date-line');
        if (!el) return;
        const sel = this._sel;
        const pill = (label, { clear = null } = {}) =>
            `<span class="actions-sel-pill"><span class="actions-sel-pill-label">${UIUtils.escapeHtml(label)}</span>` +
            (clear ? `<button class="actions-sel-clear" data-sel-clear="${clear}" title="Remove this filter" aria-label="Remove ${UIUtils.escapeHtml(label)} filter">&times;</button>` : '') +
            `</span>`;

        let html = '';
        if (sel.time) {
            // No × on the resting default (Today alone) or on All time —
            // clearing the time dimension IS All time, so an × there would
            // be circular. Clearing a real window falls back to All time.
            const dismissible = sel.time !== 'all' && !(sel.time === 'today' && !sel.group);
            html += pill(this._timeLabel(), { clear: dismissible ? 'time' : null });
        }
        if (sel.group) {
            html += pill(this._groupLabel(), { clear: 'group' });
        }

        // Right-aligned action: open the group on the Goals page when one is
        // in scope; otherwise the weekly-review link on the plain Today view.
        let trailing = '';
        if (this._isGroupSel()) {
            trailing = '<button class="actions-review-nudge" id="actions-open-goals" title="Open this group on the Goals page">Open Goals</button>';
        } else if (sel.time === 'today' && !sel.group) {
            trailing = `<button class="actions-review-nudge${this._reviewDue() ? ' is-due' : ''}" id="actions-review-nudge">Weekly review &#8594;</button>`;
        }

        el.innerHTML = html +
            `<span class="actions-date-summary">${UIUtils.escapeHtml(summaryParts.join(' · '))}</span>` +
            trailing;
    },

    _renderDateLine(groups, events) {
        const today = new Date();
        const parts = [today.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })];
        const open = groups.todayActive.length + groups.overdue.length;
        parts.push(`${open} to do`);
        if (groups.todayCompleted.length) parts.push(`${groups.todayCompleted.length} done`);
        if (events.length) parts.push(`${events.length} event${events.length === 1 ? '' : 's'}`);
        this._renderSelLine(parts);
    },

    _renderList(groups) {
        const container = document.getElementById('actions-today-container');
        if (!container) return;
        const todayStr = ScheduleApp.getLocalToday();
        let html = '';

        if (groups.overdue.length > 0) {
            html += `
                <div class="actions-section">
                    <div class="actions-section-header actions-section-overdue">Overdue <span class="actions-section-count">${groups.overdue.length}</span>
                        <button class="actions-overdue-pushall" id="actions-overdue-pushall" title="Move all overdue tasks to today">Push to today</button>
                    </div>
                    ${this._renderOverdueGroups(groups.overdue, todayStr)}
                </div>`;
        }

        if (groups.todayActive.length > 0) {
            // Timed items read as a chronology (sorted by start, or end for
            // deadline-only items); untimed ones sink into their own quiet
            // "Anytime" block instead of interleaving.
            const timed = groups.todayActive
                .filter(i => i.startTime || i.endTime)
                .sort((a, b) => this._startMins(a) - this._startMins(b));
            const untimed = groups.todayActive.filter(i => !i.startTime && !i.endTime);
            if (timed.length > 0) {
                html += `
                <div class="actions-section">
                    <div class="actions-section-header">Today</div>
                    ${timed.map(item => this._renderRow(item, {})).join('')}
                </div>`;
            }
            if (untimed.length > 0) {
                html += `
                <div class="actions-section">
                    <div class="actions-section-header">${timed.length > 0 ? 'Anytime' : 'Today'} <span class="actions-section-count">${untimed.length}</span></div>
                    ${untimed.map(item => this._renderRow(item, {})).join('')}
                </div>`;
            }
        } else if (groups.overdue.length === 0) {
            const doneCount = groups.todayCompleted.length;
            html += `
                <div class="actions-empty">
                    ${doneCount > 0
                        ? `All clear for today &mdash; ${doneCount} action${doneCount === 1 ? '' : 's'} done. Well played.`
                        : 'Nothing scheduled for today. Add an action above, or hit Plan to line up your goals.'}
                </div>`;
        }

        if (groups.todayCompleted.length > 0) {
            const n = groups.todayCompleted.length;
            html += `
                <div class="actions-section">
                    <button class="actions-completed-toggle" id="actions-completed-toggle" aria-expanded="${this._completedExpanded}">
                        ${this._completedExpanded ? '&#9662;' : '&#9656;'} ${n} done today
                    </button>
                    ${this._completedExpanded
                        ? groups.todayCompleted.map(item => this._renderRow(item, { completed: true })).join('')
                        : ''}
                </div>`;
        }

        // No "Assistant suggestions" section here (removed 2026-08-03). It
        // listed every action with a pending suggestion that was NOT already
        // on screen — which meant undated backlog and things weeks out got
        // pulled into Today, reading as a list of random tasks the app wanted
        // doing now. A day view shows the day. Suggestions still reach the
        // user where the task already is: as chips on the rows above, in the
        // task editor, and in the weekly review's "No date" step, which is
        // the one place a whole undated backlog belongs.

        container.innerHTML = html;
    },

    // Numeric sort key — stored times aren't reliably zero-padded
    // ("2:00" vs "02:00"), so string comparison mis-orders them. Deadline-only
    // items sort by their end time.
    _startMins(item) {
        const t = item.startTime || item.endTime;
        if (!t) return -1;
        const [h, m] = String(t).split(':').map(Number);
        return (h || 0) * 60 + (m || 0);
    },

    // Overdue subgroups by the date each item was due, so the day is said once
    // as a heading instead of repeated down every row — and the row gutter is
    // free to hold the time alone. Oldest first; recurring items with no
    // scheduledDate sink to the bottom.
    _renderOverdueGroups(items, todayStr) {
        const byDate = new Map();
        for (const item of items) {
            const key = item.scheduledDate || '';
            if (!byDate.has(key)) byDate.set(key, []);
            byDate.get(key).push(item);
        }
        const dates = [...byDate.keys()].sort((a, b) =>
            a === '' ? 1 : b === '' ? -1 : a.localeCompare(b));

        return dates.map(date => {
            const rows = byDate.get(date).sort((a, b) => this._startMins(a) - this._startMins(b));
            const heading = date ? this._overdueHeading(date, todayStr) : 'No date';
            return `
                <div class="actions-date-group">
                    <div class="actions-date-heading">${UIUtils.escapeHtml(heading)}</div>
                    ${rows.map(item => this._renderRow(item, { overdue: true })).join('')}
                </div>`;
        }).join('');
    },

    // "Yesterday" for the common case, an explicit weekday+date beyond that —
    // "6 days ago" is harder to act on than "Friday, Jul 10" when replanning.
    _overdueHeading(dateStr, todayStr) {
        const date = new Date(dateStr + 'T00:00:00');
        const today = new Date(todayStr + 'T00:00:00');
        const diffDays = Math.round((date - today) / 86400000);
        if (diffDays === -1) return 'Yesterday';
        return ScheduleUI.formatLaterDateHeading(dateStr, todayStr);
    },

    // Pending assistant suggestions render as tentative "?" chips with
    // one-tap confirm/dismiss — filing is always explicit, never silent.
    _renderSuggestChips(item) {
        let html = '';
        if (item.suggestionState === 'pending' && item.suggestedGoalId) {
            const meta = LinkManager.getItemMeta('goals', item.suggestedGoalId);
            if (meta) {
                html += `<span class="actions-suggest-chip" title="Assistant suggestion: file under ${UIUtils.escapeHtml(meta.title)}">
                    <span class="actions-suggest-label">Suggested:</span> ${UIUtils.escapeHtml(meta.title)}?
                    <button class="actions-suggest-act" data-act="goal-yes" data-item-id="${item.id}" title="File under this goal">&#10003;</button>
                    <button class="actions-suggest-act" data-act="goal-no" data-item-id="${item.id}" title="Don't file">&#10005;</button>
                </span>`;
            }
        }
        if (item.dateSuggestionState === 'pending' && item.suggestedDate) {
            const label = ScheduleUI.formatRelativeDate(item.suggestedDate, ScheduleApp.getLocalToday());
            html += `<span class="actions-suggest-chip" title="Assistant suggestion: schedule for ${UIUtils.escapeHtml(item.suggestedDate)}">
                <span class="actions-suggest-label">Suggested:</span> ${UIUtils.escapeHtml(label)}?
                <button class="actions-suggest-act" data-act="date-yes" data-item-id="${item.id}" title="Schedule for this date">&#10003;</button>
                <button class="actions-suggest-act" data-act="date-no" data-item-id="${item.id}" title="Leave undated">&#10005;</button>
            </span>`;
        }
        return html;
    },

    // A list row shows when a thing STARTS. "by 4:00 PM" (deadline-only) keeps
    // its shape — there the end time is the whole meaning.
    _rowTime(item) {
        const start = ScheduleUI.formatTime(item.startTime);
        if (start) return start;
        const end = ScheduleUI.formatTime(item.endTime);
        return end ? `by ${end}` : '';
    },

    _renderRow(item, { dateLabel = '', completed = false, overdue = false, late = false, noGoalChip = false, dateGutter = false } = {}) {
        const goal = noGoalChip ? null : LinkManager.getGoalForTask(item.id);

        // The gutter holds exactly ONE atom and never wraps: two of them at
        // this width spill onto a second line, and the ragged row heights pull
        // the titles off a shared baseline. The date wins only where it IS the
        // point (area views, suggestions for off-screen items); everywhere
        // else the section or date heading already says the day, so the time
        // shows. Ranges collapse to the start — the end time lives in the
        // tooltip and the detail view, as in Todoist/Reminders.
        const time = this._rowTime(item);
        const fullTime = ScheduleUI.formatTimeRange(item.startTime, item.endTime);
        let metaHtml = '';
        if (dateLabel) {
            // Tooltip carries the full label — the fixed gutter truncates
            // anything wider than the column (e.g. a many-day custom repeat).
            metaHtml = `<span class="actions-row-date${late ? ' is-late' : ''}" title="${UIUtils.escapeHtml(dateLabel)}">${UIUtils.escapeHtml(dateLabel)}</span>`;
        } else if (time) {
            const tip = fullTime && fullTime !== time
                ? ` title="${UIUtils.escapeHtml(fullTime.replace('–', ' – '))}"` : '';
            metaHtml = `<span class="actions-row-time"${tip}>${UIUtils.escapeHtml(time)}</span>`;
        } else if (!completed && !dateGutter) {
            // Untimed tasks say so (same voice as the Home Today widget) —
            // an empty time gutter reads as a rendering mistake. The word is
            // also the affordance: clicking it opens the native time picker
            // (data-edit-time branch in the container's click delegation).
            // Suppressed where the gutter is a DATE column (dateGutter) and
            // on completed rows — timing finished work is meaningless.
            metaHtml = `<span class="actions-row-time is-anytime" data-edit-time="${item.id}" title="Set a time">anytime</span>`;
        }

        return `
            <div class="actions-row ${completed ? 'is-done' : ''}" data-item-id="${item.id}" draggable="true">
                <!-- No stopPropagation here: rows use ONE delegated container
                     listener, and its checkbox branch returns before the
                     row-open branch — stopping the event would kill the toggle. -->
                <label class="actions-check-label">
                    <input type="checkbox" class="actions-check" data-item-id="${item.id}" ${completed ? 'checked' : ''}>
                </label>
                <!-- Gutter always renders (even empty) — a fixed column keeps
                     every title starting at the same x across the list.
                     data-edit-date anchors the row menu's native date picker. -->
                <div class="actions-row-meta" data-edit-date="${item.id}">${metaHtml}</div>
                <span class="actions-row-title" data-edit-title="${item.id}">${UIUtils.escapeHtml(item.title)}</span>
                <div class="actions-row-badges">
                    ${overdue ? `<button class="actions-push-today" data-item-id="${item.id}" title="Move to today">&#8594; Today</button>` : ''}
                    ${goal ? `<button class="actions-goal-chip" data-goal-id="${goal.itemId}" title="Goal: ${UIUtils.escapeHtml(goal.title)}">${UIUtils.escapeHtml(goal.title)}</button>` : ''}
                    ${completed ? '' : this._renderSuggestChips(item)}
                    ${(item.tags || []).length ? `<span class="task-row-tags">${item.tags.map(t => `<span class="task-tag">${UIUtils.escapeHtml(t)}</span>`).join('')}</span>` : ''}
                    ${item.source === 'email' ? `<span class="actions-email-badge" title="From: ${UIUtils.escapeHtml(item.sourceEmailFrom || 'email')}">&#9993; Email</span>` : ''}
                    <button type="button" class="task-row-menu actions-row-menu" data-item-id="${item.id}" title="More actions">&#8943;</button>
                </div>
            </div>`;
    },

    _renderEvents(events) {
        const container = document.getElementById('actions-events-container');
        if (!container) return;
        if (CalendarApp.getAccounts().length === 0 || events.length === 0) {
            container.innerHTML = '';
            return;
        }
        container.innerHTML = `
            <div class="actions-section">
                <div class="actions-section-header">Today&rsquo;s events</div>
                ${events.map(e => `
                    <div class="actions-event-row">
                        <span class="actions-event-time">${UIUtils.escapeHtml(this._fmtEventTime(e))}</span>
                        <span class="actions-event-title">${UIUtils.escapeHtml(e.summary || '(no title)')}</span>
                    </div>`).join('')}
            </div>`;
    },

    _fmtEventTime(e) {
        if (e.allDay) return 'All day';
        const fmt = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        return e.end ? `${fmt(e.start)} – ${fmt(e.end)}` : fmt(e.start);
    },

    // Refresh the calendar cache in the background when it's stale, then
    // repaint events if the user is still here. Never blocks first paint —
    // render always draws from the local cache first.
    _maybeBackgroundSync() {
        if (CalendarApp.getAccounts().length === 0 || CalendarApp.isSyncing) return;
        const last = CalendarApp.lastSyncTime ? new Date(CalendarApp.lastSyncTime).getTime() : 0;
        if (Date.now() - last < this.CALENDAR_STALE_MS) return;
        CalendarApp.syncEvents().then(() => {
            if (AppManager.currentApp === 'actions' && this._view === 'tasks'
                && this._sel.time === 'today' && !this._sel.group) {
                this._renderEvents(this._todayEvents());
            }
        }).catch(() => { /* syncEvents toasts on its own */ });
    },

    // --- Assistant filing (goal-link + date suggestions) ---
    //
    // The assistant is the organizer, not the user: a background batched LLM
    // pass (same one-brain routing as email insights, template:
    // EmailApp.classifyBundlesWithAI) suggests a goal for unfiled actions and
    // a date for undated ones. Suggestions are chips the user confirms or
    // dismisses — never auto-applied, never invisible. Verdicts persist on
    // the item (suggestionState / dateSuggestionState) so nothing is re-asked.

    _filingEnabled() {
        return StorageManager.get('actionsSettings')?.aiFiling !== false;
    },

    // Open goals for the active profile, straight from storage so the pass
    // works even if GoalsApp never initialized this session.
    _openGoals() {
        const goals = StorageManager.get('goals')?.goals || [];
        return goals.filter(g => g.status !== 'completed');
    },

    // One link-index pass (never getGoalForTask per task — that re-reads the
    // link table every call). Only calm, one-time items are candidates.
    _filingCandidates() {
        const { taskGoals } = ScheduleApp.buildTaskLinkIndex();
        const items = ScheduleApp.scheduleItems
            .filter(i => i.title && (!i.repeat || i.repeat === 'none')
                && !i.lastCompletedDate && !ScheduleApp.lastAbandonedDate(i));
        const unlinked = (i) => !(taskGoals.get(i.id)?.size);
        return items.filter(i =>
            (i.suggestionState === undefined && unlinked(i)) ||
            (i.dateSuggestionState === undefined && !i.scheduledDate)
        ).map(i => ({
            item: i,
            wantGoal: i.suggestionState === undefined && unlinked(i),
            wantDate: i.dateSuggestionState === undefined && !i.scheduledDate,
        }));
    },

    async _fileActions() {
        if (this._filing || !this._filingEnabled()) return;
        // Circuit breaker (same as email bundles): a failing batch keeps its
        // suggestionState undefined, so it would be re-sent verbatim on every
        // render. Three consecutive failures parks the pass until next launch.
        if ((this._filingFailures || 0) >= 3) return;
        const goals = this._openGoals();
        const candidates = this._filingCandidates()
            // Without open goals only date suggestions make sense.
            .filter(c => (goals.length > 0 && c.wantGoal) || c.wantDate)
            .slice(0, this.FILING_AI_BATCH);
        if (candidates.length === 0) return;

        this._filing = true;
        let succeeded = false;
        try {
            const today = ScheduleApp.getLocalToday();
            const goalLines = goals.map((g, i) =>
                `G${i + 1}: ${g.title}${g.description ? ` — ${String(g.description).slice(0, 100)}` : ''}`
            ).join('\n');
            const taskLines = candidates.map((c, i) =>
                `${i + 1}. ${c.item.title}${c.item.scheduledDate ? ` (scheduled ${c.item.scheduledDate})` : ' (no date)'}`
            ).join('\n');

            const result = await LLMLogger.call('actions-filing', {
                model: AgentService.model,
                // JSON-constrained sampling (see email bundles) — prose-wrapped
                // output from small models must not kill the pass.
                format: 'json',
                // The verdict map is small; without a cap a thinking model ran
                // this pass 4096 tokens / 4+ minutes with nothing to show.
                maxTokens: 700,
                // No hidden reasoning — see email bundles: <think> overruns
                // the cap and content comes back empty every time.
                think: false,
                logTag: 'actions-filing',
                messages: [
                    {
                        role: 'system',
                        content: `You are a personal task-filing assistant. Today is ${today}.

The user's open goals:
${goalLines || '(none)'}

For each numbered task below, decide:
- "goal": the goal id (G1, G2, ...) the task CLEARLY serves, or "none". Most everyday tasks serve no listed goal — when unsure, use "none".
- "date": only for tasks marked (no date), and ONLY when the task text clearly implies a timeframe — a specific day, event, or deadline. Format YYYY-MM-DD. Omit "date" otherwise.

Respond ONLY with a JSON object mapping each task number to its verdict, e.g. {"1":{"goal":"G2"},"2":{"goal":"none","date":"${today}"}}.`
                    },
                    { role: 'user', content: taskLines }
                ],
                stream: false
            });

            if (result?.error) {
                console.warn('[actions] filing call failed:', result.error);
                return;
            }
            const content = result?.message?.content || '';
            const map = LLMLogger.extractJsonObject(content);
            if (!map) {
                console.warn(`[actions] filing returned unparseable output (${content.length} chars)`);
                return;
            }

            candidates.forEach((c, i) => {
                const v = map[String(i + 1)] || {};
                if (c.wantGoal) {
                    const goal = this._validGoalRef(v.goal, goals);
                    if (goal) {
                        c.item.suggestedGoalId = goal.id;
                        c.item.suggestionState = 'pending';
                    } else {
                        c.item.suggestionState = 'none';
                    }
                }
                if (c.wantDate) {
                    const date = this._validSuggestedDate(v.date, today);
                    if (date) {
                        c.item.suggestedDate = date;
                        c.item.dateSuggestionState = 'pending';
                    } else {
                        c.item.dateSuggestionState = 'none';
                    }
                }
            });
            ScheduleApp.saveData();
            succeeded = true;
            if (AppManager.currentApp === 'actions') this.render();
        } catch (err) {
            console.warn('[actions] filing pass failed:', err?.message);
        } finally {
            this._filing = false;
            this._filingFailures = succeeded ? 0 : (this._filingFailures || 0) + 1;
            if (this._filingFailures === 3) {
                console.warn('[actions] filing failed 3× in a row — pausing until next launch');
            }
        }

        // More candidates and this batch worked? Keep draining quietly.
        if (succeeded && this._filingCandidates().length > 0) {
            setTimeout(() => this._fileActions(), 3000);
        }
    },

    // Floor-model defense: only accept verdicts we can verify.
    _validGoalRef(ref, goals) {
        if (typeof ref !== 'string') return null;
        const m = ref.trim().match(/^[Gg](\d+)$/);
        if (!m) return null;
        return goals[parseInt(m[1], 10) - 1] || null;
    },

    _validSuggestedDate(date, today) {
        if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
        if (isNaN(new Date(date + 'T00:00:00'))) return null;
        const horizon = new Date(today + 'T00:00:00');
        horizon.setDate(horizon.getDate() + 365);
        const max = `${horizon.getFullYear()}-${String(horizon.getMonth() + 1).padStart(2, '0')}-${String(horizon.getDate()).padStart(2, '0')}`;
        return (date >= today && date <= max) ? date : null;
    },

    // A pending suggestion is void once the user has done the filing
    // themselves — linked a goal (any goal, via the detail page's picker
    // or a drag) or set a date. Mark it superseded so the chip disappears
    // and the filing pass never re-asks; the state persists on the item,
    // like accepted/dismissed. Without this, a stale "→ Goal?" chip sits
    // next to the real goal chip forever.
    _reconcileSuggestions() {
        const pending = ScheduleApp.scheduleItems.filter(i =>
            i.suggestionState === 'pending' || i.dateSuggestionState === 'pending');
        if (pending.length === 0) return;
        const { taskGoals } = ScheduleApp.buildTaskLinkIndex();
        let changed = false;
        for (const item of pending) {
            if (item.suggestionState === 'pending' && taskGoals.get(item.id)?.size) {
                item.suggestionState = 'superseded';
                changed = true;
            }
            if (item.dateSuggestionState === 'pending' && item.scheduledDate) {
                item.dateSuggestionState = 'superseded';
                changed = true;
            }
        }
        if (changed) ScheduleApp.saveData();
    },

    // --- Search (tasks + goals → their detail pages) ---

    SEARCH_CAP: 6,   // rows shown per group; the header count says the rest

    _searchMatches(q) {
        const tasks = ScheduleApp.scheduleItems
            .filter(i => i.title && i.title.toLowerCase().includes(q))
            .map(item => ({ item, done: TaskListUI.isCompleted(item) || TaskListUI.isAbandoned(item) }))
            .sort((a, b) => (a.done - b.done) || a.item.title.localeCompare(b.item.title));
        const goals = this._allGoals()
            .filter(g => g.title && g.title.toLowerCase().includes(q))
            .sort((a, b) => a.title.localeCompare(b.title));
        return { tasks, goals };
    },

    _renderSearchResults() {
        const input = document.getElementById('actions-search');
        const panel = document.getElementById('actions-search-results');
        if (!input || !panel) return;
        const q = input.value.trim().toLowerCase();
        if (!q) {
            panel.hidden = true;
            panel.innerHTML = '';
            return;
        }

        this._ensureData();
        const { tasks, goals } = this._searchMatches(q);
        const today = ScheduleApp.getLocalToday();

        const section = (label, total, rows) => rows.length === 0 ? '' : `
            <div class="actions-search-section">
                <div class="actions-search-header">${label}${total > rows.length ? ` <span class="actions-search-count">${total}</span>` : ''}</div>
                ${rows.join('')}
            </div>`;

        const taskRows = tasks.slice(0, this.SEARCH_CAP).map(({ item, done }) => {
            const repeating = item.repeat && item.repeat !== 'none';
            const meta = repeating ? ScheduleUI.getRepeatLabel(item)
                : (item.scheduledDate ? ScheduleUI.formatRelativeDate(item.scheduledDate, today) : '');
            return `
                <button type="button" class="actions-search-row${done ? ' is-done' : ''}" data-kind="task" data-id="${item.id}">
                    <span class="actions-search-title">${UIUtils.escapeHtml(item.title)}</span>
                    ${meta ? `<span class="actions-search-meta">${UIUtils.escapeHtml(meta)}</span>` : ''}
                </button>`;
        });
        const goalRows = goals.slice(0, this.SEARCH_CAP).map(g => `
            <button type="button" class="actions-search-row" data-kind="goal" data-id="${g.id}">
                <span class="actions-search-title">${UIUtils.escapeHtml(g.title)}</span>
            </button>`);

        panel.innerHTML =
            section('Tasks', tasks.length, taskRows) +
            section('Goals', goals.length, goalRows)
            || '<div class="actions-search-empty">No matches</div>';
        panel.hidden = false;
    },

    // Arrow-key highlight: move .is-active through the rows, wrapping at
    // the ends. A re-render (typing) rebuilds the panel, which clears it.
    _moveSearchActive(dir) {
        const panel = document.getElementById('actions-search-results');
        if (!panel || panel.hidden) return;
        const rows = [...panel.querySelectorAll('.actions-search-row')];
        if (rows.length === 0) return;
        const cur = rows.findIndex(r => r.classList.contains('is-active'));
        const next = cur === -1
            ? (dir > 0 ? 0 : rows.length - 1)
            : (cur + dir + rows.length) % rows.length;
        rows.forEach((r, i) => r.classList.toggle('is-active', i === next));
        rows[next].scrollIntoView({ block: 'nearest' });
    },

    _closeSearch({ clear = false } = {}) {
        const input = document.getElementById('actions-search');
        const panel = document.getElementById('actions-search-results');
        if (clear && input) input.value = '';
        if (panel) { panel.hidden = true; panel.innerHTML = ''; }
    },

    _openSearchResult(kind, id) {
        this._closeSearch({ clear: true });
        if (kind === 'task') {
            // Works from anywhere, including the review flow.
            this._view = 'tasks';
            this._openTaskEditor(id);
        } else if (kind === 'goal') {
            // Same route as the goal chips: the goal's page in Goals.
            AppManager.openApp('goals');
            setTimeout(() => GoalsPage.selectNode('goal', id), 0);
        }
    },

    // --- Interactions (all bound once; rows use delegation) ---

    _bindOnce() {
        if (this._bound) return;
        this._bound = true;

        // There is no hub tab strip any more (2026-08-03): Goals became a
        // door off this page and Email Insights became its own app, which
        // left "Tasks" alone in a strip — and a one-tab strip is furniture,
        // not navigation. Both doors are header buttons now.
        this._wirePlanButton();

        // Left nav: selection clicks + task-row drops (file / reschedule).
        const nav = document.getElementById('actions-nav');
        if (nav) {
            nav.addEventListener('click', (e) => {
                const time = e.target.closest('[data-nav-time]');
                if (time) { this._toggleTime(time.dataset.navTime); return; }
                const un = e.target.closest('[data-nav-unassigned]');
                if (un) { this._toggleGroup('unassigned'); return; }
                const tag = e.target.closest('[data-nav-tag]');
                if (tag) { this._toggleTag('t:' + tag.dataset.navTag); return; }
                const group = e.target.closest('[data-nav-group]');
                if (group) this._toggleGroup('g:' + group.dataset.navGroup);
            });
            nav.addEventListener('dragover', (e) => {
                const target = e.target.closest('[data-drop]');
                if (!target) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                nav.querySelectorAll('.is-drop').forEach(el => { if (el !== target) el.classList.remove('is-drop'); });
                target.classList.add('is-drop');
            });
            nav.addEventListener('dragleave', (e) => {
                const target = e.target.closest('[data-drop]');
                if (target && !target.contains(e.relatedTarget)) target.classList.remove('is-drop');
            });
            nav.addEventListener('drop', (e) => {
                const target = e.target.closest('[data-drop]');
                if (!target) return;
                e.preventDefault();
                target.classList.remove('is-drop');
                this._handleNavDrop(target.dataset.drop, e.dataTransfer.getData('text/plain'));
            });
        }

        // Back to the list from the inline task detail — same route as the
        // editor's own back paths (closeEditor with origin 'actions' lands
        // on the Actions list with the selection intact). Esc works too,
        // unless focus is in a form field.
        document.getElementById('actions-task-back')?.addEventListener('click', () => {
            ScheduleApp.closeEditor();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || !this._openTaskId || AppManager.currentApp !== 'actions') return;
            const t = e.target;
            if (t && (t.matches('input, textarea, select') || t.isContentEditable)) return;
            if (document.querySelector('.modal-overlay, .task-menu')) return;
            ScheduleApp.closeEditor();
        });

        // Review nudge / Open Goals / pill dismiss on the selection line
        // (re-rendered each paint, so delegate).
        document.getElementById('actions-date-line')?.addEventListener('click', (e) => {
            if (e.target.closest('#actions-review-nudge')) { this.showReview(); return; }
            const clear = e.target.closest('[data-sel-clear]');
            if (clear) {
                const dim = clear.dataset.selClear;
                this.select({ time: dim === 'time' ? null : this._sel.time, group: dim === 'group' ? null : this._sel.group });
                return;
            }
            if (e.target.closest('#actions-open-goals') && this._isGroupSel()) {
                const name = this._selGroupName();
                AppManager.openApp('goals');
                setTimeout(() => GoalsPage.switchGroup(name || GoalsPage.UNGROUPED), 0);
            }
        });

        // Weekly review: one delegated listener for nav + verdicts.
        document.getElementById('actions-review-container')?.addEventListener('click', (e) => {
            ActionsReview.handleClick(e);
        });

        // Header search: live dropdown; arrows move the highlight, Enter
        // opens the highlighted (or top) result, Escape clears, clicking
        // anywhere else dismisses.
        const search = document.getElementById('actions-search');
        const searchResults = document.getElementById('actions-search-results');
        if (search) {
            search.addEventListener('input', () => this._renderSearchResults());
            search.addEventListener('focus', () => this._renderSearchResults());
            search.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    this._closeSearch({ clear: true });
                    search.blur();
                } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();   // keep the caret still
                    this._moveSearchActive(e.key === 'ArrowDown' ? 1 : -1);
                } else if (e.key === 'Enter') {
                    const row = searchResults?.querySelector('.actions-search-row.is-active')
                        || searchResults?.querySelector('.actions-search-row');
                    if (row) this._openSearchResult(row.dataset.kind, row.dataset.id);
                }
            });
        }
        if (searchResults) {
            searchResults.addEventListener('click', (e) => {
                const row = e.target.closest('.actions-search-row');
                if (row) this._openSearchResult(row.dataset.kind, row.dataset.id);
            });
        }
        document.addEventListener('click', (e) => {
            if (searchResults && !searchResults.hidden && !e.target.closest('.actions-search-wrap')) {
                this._closeSearch();
            }
        });
        // Cmd/Ctrl+F focuses the search whenever Actions is the open app
        // (no Electron menu item claims the accelerator). Select any old
        // query so typing starts fresh.
        document.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey
                && e.key.toLowerCase() === 'f' && AppManager.currentApp === 'actions') {
                e.preventDefault();
                search?.focus();
                search?.select();
            }
        });

        // Quick-add with live parse preview. Enter is always the instant,
        // deterministic path; the AI split proposal (when open) takes over
        // Enter/Escape so confirming it doesn't need the mouse.
        const input = document.getElementById('actions-quick-add');
        if (input) {
            input.addEventListener('input', () => {
                this._captureProposal = null;   // editing the text voids the proposal
                this._updateQuickAddPreview(input.value);
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this._captureProposal) {
                    e.preventDefault();
                    this._cancelCapture();
                    return;
                }
                if (e.key !== 'Enter') return;
                if (this._captureProposal) this._confirmCapture(input);
                else this._quickAdd(input);
            });
        }
        // AI-capture controls live inside the (re-rendered) preview — one
        // delegated listener on the static container.
        const qaPreview = document.getElementById('actions-quick-add-preview');
        if (qaPreview) {
            qaPreview.addEventListener('click', (e) => {
                if (e.target.closest('[data-ai-split]')) { this._aiCapture(input); return; }
                if (e.target.closest('[data-cap-add]')) { this._confirmCapture(input); return; }
                if (e.target.closest('[data-cap-cancel]')) { this._cancelCapture(); return; }
                const rm = e.target.closest('[data-cap-remove]');
                if (rm && this._captureProposal) {
                    this._captureProposal.tasks.splice(Number(rm.dataset.capRemove), 1);
                    if (!this._captureProposal.tasks.length) this._cancelCapture();
                    else this._renderCaptureProposal();
                }
            });
        }

        // Delegated row interactions.
        const container = document.getElementById('actions-today-container');
        if (container) {
            container.addEventListener('dragstart', (e) => {
                const row = e.target.closest('.actions-row');
                if (!row) return;
                e.dataTransfer.setData('text/plain', row.dataset.itemId);
                e.dataTransfer.effectAllowed = 'move';
            });
            container.addEventListener('click', (e) => {
                // Push-to-today: per-row chip on overdue rows, and the bulk
                // button on the Overdue section header (the shared sidebar
                // filter must not apply from here).
                const pushToday = e.target.closest('.actions-push-today');
                if (pushToday) {
                    ScheduleApp.rescheduleTask(pushToday.dataset.itemId, 'today');
                    this.render();
                    return;
                }
                if (e.target.closest('#actions-overdue-pushall')) {
                    ScheduleApp.rescheduleAllOverdue({ applySidebarFilter: false });
                    this.render();
                    return;
                }
                const check = e.target.closest('.actions-check');
                if (check) {
                    ScheduleApp.toggleComplete(check.dataset.itemId);
                    this.render();
                    return;
                }
                const chip = e.target.closest('.actions-goal-chip');
                if (chip) {
                    const goalId = chip.dataset.goalId;
                    AppManager.openApp('goals');
                    setTimeout(() => GoalsPage.selectNode('goal', goalId), 0);
                    return;
                }
                // Goal section headings in the group view open the goal.
                const goalHeading = e.target.closest('[data-open-goal]');
                if (goalHeading) {
                    const goalId = goalHeading.dataset.openGoal;
                    AppManager.openApp('goals');
                    setTimeout(() => GoalsPage.selectNode('goal', goalId), 0);
                    return;
                }
                const toggle = e.target.closest('#actions-completed-toggle');
                if (toggle) {
                    this._completedExpanded = !this._completedExpanded;
                    this.render();
                    return;
                }
                const suggestBtn = e.target.closest('.actions-suggest-act');
                if (suggestBtn) {
                    this._handleSuggestAction(suggestBtn.dataset.act, suggestBtn.dataset.itemId);
                    return;
                }
                // ⋯ opens the same row menu as the Goals task lists — quick
                // edits (date, rename, delete) without leaving the list.
                const menuBtn = e.target.closest('.actions-row-menu');
                if (menuBtn) {
                    const rect = menuBtn.getBoundingClientRect();
                    this._openRowMenu(menuBtn.dataset.itemId, { x: rect.right, y: rect.bottom + 4 });
                    return;
                }
                // "anytime" gutter placeholder → native time picker in place
                // (the same proxy trick as the date pill; the row must not
                // open underneath it).
                const anytime = e.target.closest('[data-edit-time]');
                if (anytime) {
                    TaskListUI.beginTimeEdit(anytime.dataset.editTime, anytime, {
                        onChanged: () => { ScheduleApp.loadData(); this.render(); }
                    });
                    return;
                }
                const row = e.target.closest('.actions-row');
                if (row) this._openTaskEditor(row.dataset.itemId);
            });
            // Right-click anywhere on a row opens the same menu (parity with
            // the Goals task lists).
            container.addEventListener('contextmenu', (e) => {
                const row = e.target.closest('.actions-row');
                if (!row) return;
                e.preventDefault();
                this._openRowMenu(row.dataset.itemId, { x: e.clientX, y: e.clientY });
            });
        }
    },

    // TaskListUI's anchored row menu (Open · Rename · Set date · Delete),
    // wired to this page's editor and repaint. Rename now ships in the
    // shared menu itself (the title span carries data-edit-title).
    _openRowMenu(taskId, at) {
        if (typeof TaskListUI === 'undefined') return;
        TaskListUI.openMenu(taskId, at, {
            onOpenTask: (id) => this._openTaskEditor(id),
            allowDelete: true,
            extraItems: this._rowMenuExtras(taskId),
            onChanged: () => { ScheduleApp.loadData(); this.render(); },
        });
    },

    // "Move to tomorrow" appears only for the rows the Today section holds:
    // a one-time task dated today, still open. A repeat's date comes from
    // its recurrence rule, so moving one occurrence would mean editing the
    // rule — those keep Set date. Same reschedule path as dragging the row
    // onto the Tomorrow nav item.
    _rowMenuExtras(taskId) {
        const item = ScheduleApp.scheduleItems.find(i => i.id === taskId);
        if (!item) return [];
        const today = ScheduleApp.getLocalToday();
        if (item.repeat && item.repeat !== 'none') return [];
        if (item.scheduledDate !== today) return [];
        if (TaskListUI.isCompleted(item, today) || TaskListUI.isAbandoned(item, today)) return [];
        return [{
            label: 'Move to tomorrow',
            act: () => { ScheduleApp.rescheduleTask(taskId, 'tomorrow'); this.render(); }
        }];
    },

    // Open a task's FULL editor inline in the right pane — the left nav
    // stays put, no view switch, no flicker. The editor DOM is moved into
    // the host (ScheduleApp.embedEditor); init() is cheap and idempotent
    // (openApp runs it on every open too) and wires the editor's buttons
    // in sessions where the schedule view itself was never opened.
    _openTaskEditor(id) {
        ScheduleApp.init();
        this._openTaskId = id;
        const host = document.getElementById('actions-task-detail');
        // How to get BACK to this task detail from another app (the email a
        // task came from links here). The host element carries it because
        // the host is the only thing that knows the task detail is embedded
        // in a page rather than the standalone editor view — ScheduleApp
        // holds the host, not what it belongs to.
        if (host) host._reopenTask = (taskId) => { AppManager.openApp('actions'); this._openTaskEditor(taskId); };
        ScheduleApp.embedEditor(host);
        this._syncViewChrome();
        ScheduleApp.openEditor(id, { origin: 'actions', embedded: true });
        this._renderNav();
        this._renderTaskAskRow();
    },

    // Tear down the inline task detail (nav click, back, delete): hand the
    // editor DOM back to its own view so full-page opens still work.
    _closeInlineTask() {
        if (!this._openTaskId) return;
        this._openTaskId = null;
        ScheduleApp.restoreEditorHome();
    },

    // A row dropped on a nav item: Today / Tomorrow reschedule it.
    _handleNavDrop(drop, taskId) {
        if (!drop || !taskId) return;
        const item = ScheduleApp.scheduleItems.find(i => i.id === taskId);
        if (!item) return;
        const [kind, value] = drop.split(':');
        if (kind === 'date') {
            ScheduleApp.rescheduleTask(taskId, value);
            this.render();
        }
    },

    /**
     * The Tasks page's door to Goals. Idempotent — init runs per open.
     *
     * (`wireHubNav` lived here until 2026-08-03, wiring the hub tab strip
     * into the Goals and Email Insights headers. Goals became a door off
     * this page and Email Insights became its own app, so the strip — and
     * its last caller — went with them.)
     */
    _wirePlanButton() {
        const btn = document.getElementById('actions-plan-btn');
        if (!btn || btn._bound) return;
        btn._bound = true;
        btn.addEventListener('click', () => AppManager.openApp('goals'));
    },

    // Confirm/dismiss an assistant filing suggestion. Filing is always
    // explicit — accepting links the task to the suggested goal.
    _handleSuggestAction(act, itemId) {
        const item = ScheduleApp.scheduleItems.find(i => i.id === itemId);
        if (!item) return;

        if (act === 'goal-yes' && item.suggestedGoalId) {
            const meta = LinkManager.getItemMeta('goals', item.suggestedGoalId);
            LinkManager.addLink('goals', item.suggestedGoalId, 'schedule', item.id);
            item.suggestionState = 'accepted';
            if (meta) UIUtils.showToast(`Filed under ${meta.title}`, 'success');
        } else if (act === 'goal-no') {
            item.suggestionState = 'dismissed';
        } else if (act === 'date-yes' && item.suggestedDate) {
            item.scheduledDate = item.suggestedDate;
            item.modifiedAt = new Date().toISOString();
            item.dateSuggestionState = 'accepted';
            UIUtils.showToast(`Scheduled for ${ScheduleUI.formatRelativeDate(item.suggestedDate, ScheduleApp.getLocalToday())}`, 'success');
        } else if (act === 'date-no') {
            item.dateSuggestionState = 'dismissed';
        } else {
            return;
        }
        ScheduleApp.saveData();
        this.render();
    },

    _quickAdd(input) {
        const raw = input.value.trim();
        if (!raw) return;
        // The page being viewed is the date context: adding on the Tomorrow
        // page schedules for tomorrow, on Later for the undated backlog —
        // unless the text itself names a date, which always wins. Today,
        // This Week, and This Month keep the today default so the new task
        // stays visible in the view it was added from.
        const opts = {};
        if (this._sel.time === 'tomorrow') {
            opts.defaultDate = this._isoAddDays(ScheduleApp.getLocalToday(), 1);
        } else if (this._sel.time === 'later') {
            opts.defaultDate = '';
        }
        // quickAddDetached = load guard + sidebar-filter neutralization.
        const newId = ScheduleApp.quickAddDetached(raw, opts);
        if (newId) {
            input.value = '';
            this._updateQuickAddPreview('');
            // Land on the new task's detail page (origin: actions so the
            // breadcrumb/back returns here), same as opening a row.
            this._openTaskEditor(newId);
        }
    },

    // Same chip preview as the Tasks quick-add (reuses its CSS classes),
    // plus the AI-capture affordance: text that reads like MORE than one
    // action ("… and …", commas, a pasted brain-dump) offers "Split into
    // tasks". Enter never waits on a model — the split is opt-in.
    _updateQuickAddPreview(raw) {
        const el = document.getElementById('actions-quick-add-preview');
        if (!el) return;
        const trimmed = (raw || '').trim();
        if (!trimmed) { el.hidden = true; el.innerHTML = ''; return; }
        const parsed = ScheduleQuickParse.parse(trimmed, ScheduleApp.getLocalToday());
        let html = '';
        if (parsed.hasParse) {
            const chips = parsed.chips.map(c =>
                `<span class="schedule-parse-chip">${UIUtils.escapeHtml(c.label)}</span>`).join('');
            const title = parsed.title.trim()
                ? `<span class="schedule-parse-preview-title">&#8594; <strong>${UIUtils.escapeHtml(parsed.title.trim())}</strong></span>`
                : `<span class="schedule-parse-preview-title">Add a task name</span>`;
            html = chips + title;
        }
        if (this._looksCompound(trimmed) && this._filingEnabled()
            && typeof LLMLogger !== 'undefined' && typeof AgentService !== 'undefined') {
            html += `<button type="button" class="schedule-parse-chip actions-ai-split-btn" data-ai-split
                        title="Ask the assistant to split this into separate tasks">&#10022; Split into tasks</button>`;
        }
        el.innerHTML = html;
        el.hidden = !html;
    },

    // ── AI capture (quick-add → several structured tasks) ──

    _captureProposal: null,   // { tasks: [{title, date, time, goalId}] } while chips are up
    _capturing: false,

    /** Worth offering a split: joins, list separators, or a long paste. */
    _looksCompound(raw) {
        return /\b(and|then|also|after that)\b/i.test(raw) || /[,;]/.test(raw) || raw.length > 60;
    },

    async _aiCapture(input) {
        const raw = (input?.value || '').trim();
        if (!raw || this._capturing) return;
        this._capturing = true;
        const el = document.getElementById('actions-quick-add-preview');
        if (el) { el.innerHTML = '<span class="schedule-parse-preview-title">&#10022; Splitting into tasks&hellip;</span>'; el.hidden = false; }
        try {
            const today = ScheduleApp.getLocalToday();
            const goals = this._openGoals();
            const goalLines = goals.map((g, i) => `G${i + 1}: ${g.title}`).join('\n');
            const result = await LLMLogger.call('actions-capture', {
                model: AgentService.model,
                format: 'json',
                maxTokens: 600,
                think: false,
                logTag: 'actions-capture',
                messages: [
                    {
                        role: 'system',
                        content: `You split a user's quick note into separate actionable tasks. Today is ${today} (${new Date().toLocaleDateString('en-US', { weekday: 'long' })}).

The user's open goals:
${goalLines || '(none)'}

Rules:
- Extract every distinct action as its own task (1 to 6 tasks). Short imperative titles.
- "date": YYYY-MM-DD, ONLY when the text clearly implies a day for that task; else null.
- "time": 24h HH:MM, ONLY when a clock time is stated for that task; else null.
- "goal": the goal id (G1, G2, ...) the task CLEARLY serves, or "none". When unsure, "none".

Respond ONLY with JSON: {"tasks":[{"title":"...","date":null,"time":null,"goal":"none"}]}`
                    },
                    { role: 'user', content: raw }
                ],
                stream: false
            });
            if (result?.error) throw new Error(result.error);
            const parsed = LLMLogger.extractJsonObject(result?.message?.content || '');
            const tasks = (Array.isArray(parsed?.tasks) ? parsed.tasks : [])
                .map(t => ({
                    title: String(t?.title || '').trim().slice(0, 120),
                    date: this._validSuggestedDate(t?.date, today) || null,
                    time: /^([01]?\d|2[0-3]):[0-5]\d$/.test(t?.time || '') ? t.time : null,
                    goalId: this._validGoalRef(t?.goal, goals)?.id || null
                }))
                .filter(t => t.title)
                .slice(0, 6);
            if (!tasks.length) throw new Error('no tasks extracted');
            this._captureProposal = { tasks };
            this._renderCaptureProposal();
        } catch (e) {
            console.warn('[actions] AI capture failed:', e);
            this._captureProposal = null;
            UIUtils.showToast('Could not split that — press Enter to add it as one task', 'error');
            this._updateQuickAddPreview(raw);
        } finally {
            this._capturing = false;
        }
    },

    _renderCaptureProposal() {
        const el = document.getElementById('actions-quick-add-preview');
        const p = this._captureProposal;
        if (!el || !p) return;
        const esc = UIUtils.escapeHtml;
        const goalTitle = (id) => (StorageManager.get('goals')?.goals || []).find(g => g.id === id)?.title;
        const rows = p.tasks.map((t, i) => {
            const chips = [
                t.date ? `<span class="schedule-parse-chip">${esc(ScheduleUI.formatRelativeDate(t.date, ScheduleApp.getLocalToday()))}</span>` : '',
                t.time ? `<span class="schedule-parse-chip">${esc(t.time)}</span>` : '',
                t.goalId ? `<span class="schedule-parse-chip">&#9678; ${esc(goalTitle(t.goalId) || 'goal')}</span>` : ''
            ].filter(Boolean).join('');
            return `
                <div class="actions-capture-row">
                    <span class="actions-capture-title">${esc(t.title)}</span>${chips}
                    <button type="button" class="actions-capture-remove" data-cap-remove="${i}" title="Leave this one out" aria-label="Remove">&times;</button>
                </div>`;
        }).join('');
        el.innerHTML = `
            ${rows}
            <div class="actions-capture-actions">
                <button type="button" class="primary-btn actions-capture-add" data-cap-add>Add ${p.tasks.length} task${p.tasks.length === 1 ? '' : 's'}</button>
                <button type="button" class="secondary-btn" data-cap-cancel>Cancel</button>
            </div>`;
        el.hidden = false;
    },

    _confirmCapture(input) {
        const p = this._captureProposal;
        if (!p || !p.tasks.length) return;
        const today = ScheduleApp.getLocalToday();
        let added = 0;
        for (const t of p.tasks) {
            // Structured create: the title goes through the quick-add path
            // verbatim (parser left alone — dates were already extracted),
            // date via defaultDate, time set on the created item directly.
            const id = ScheduleApp.quickAddDetached(t.title, { silent: true, defaultDate: t.date || today });
            if (!id) continue;
            added++;
            const item = ScheduleApp.scheduleItems.find(i => i.id === id);
            if (item && t.time) { item.startTime = t.time; item.modifiedAt = new Date().toISOString(); }
            // Goal filing at capture — same recipe as accepting a filing
            // suggestion.
            if (t.goalId) {
                LinkManager.addLink('goals', t.goalId, 'schedule', id);
                if (item) item.suggestionState = 'accepted';
            }
        }
        ScheduleApp.saveData();
        this._captureProposal = null;
        if (input) input.value = '';
        this._updateQuickAddPreview('');
        UIUtils.showToast(`Added ${added} task${added === 1 ? '' : 's'}`, 'success');
        this.render();
    },

    _cancelCapture() {
        this._captureProposal = null;
        const input = document.getElementById('actions-quick-add');
        this._updateQuickAddPreview(input ? input.value : '');
    }
};

AppManager.register('actions', ActionsApp);

// AgentContext provider — a compact TODAY VIEW block. The global briefing
// already includes today's tasks in detail, so this stays at summary
// altitude: counts plus the open titles, to anchor "what should I do first"
// style asks while the user is looking at the Tasks tab.
if (typeof AgentContext !== 'undefined') {
    AgentContext.register('actions', () => {
        // The inline task detail outranks the day summary: with a task open,
        // "this" means that task, and the recordKey scopes the conversation.
        if (ActionsApp._openTaskId) {
            const block = ActionsApp.taskContextBlock(ActionsApp._openTaskId);
            if (block) return block;
        }
        if (!Array.isArray(ScheduleApp.scheduleItems) || ScheduleApp.scheduleItems.length === 0) return null;
        const g = ScheduleApp.getGroupedItems({ applySidebarFilter: false, applySearch: false });
        const open = [...g.overdue, ...g.todayActive];
        if (open.length === 0 && g.todayCompleted.length === 0) return null;

        const lines = open.slice(0, 15).map(i => {
            const time = i.startTime ? ` at ${i.startTime}` : '';
            const overdue = g.overdue.includes(i) ? ' (overdue)' : '';
            return `- ${i.title}${time}${overdue}`;
        }).join('\n');

        // Deliberately no pending-suggestion count: this block describes what
        // the user is LOOKING AT, and unanswered suggestions on off-screen
        // actions are no longer on this view.
        return {
            title: 'TODAY VIEW',
            body: `The user is looking at their Tasks view in Actions: ${g.overdue.length} overdue, ${g.todayActive.length} due today, ${g.todayCompleted.length} completed today.

Open actions:
${lines || '(none)'}`,
            suggestedPrompts: [
                'What should I do first today?',
                'Help me plan my day around these',
                'Which of these can wait until tomorrow?'
            ]
        };
    });

    // Record resolver — rebuilds the CURRENT TASK block from a conversation's
    // 'schedule:<id>' attachment when the user continues that chat away from
    // the task's page (e.g. the full Assistant view). Same builder as the
    // provider, so "this task" cannot drift.
    AgentContext.registerRecord('schedule', (id) => ActionsApp.taskContextBlock(id, { attached: true }));
}
