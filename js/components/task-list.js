/**
 * TaskListUI — the ONE task related-list, shared by every surface that
 * embeds a list of linked tasks (the Goals page's goal detail and goal
 * cards). One renderer + one wiring function means the features, sort
 * order, and editing behavior can't drift apart again.
 *
 * Every row offers the same interactions everywhere:
 *   - checkbox SELECTS the row for bulk actions ("N selected · Delete" bar
 *     at the top of the list). Checking OFF a task lives in the Actions app
 *     alone (2026-08-05, by request) — here completion is menu-only
 *     (opts.completeInMenu), because this list is a planning surface
 *   - date pill opens the native date picker (repeat label for repeating)
 *   - clicking the row (title included) opens the task — where it opens is
 *     the host's choice via opts.onOpenTask; renaming is menu-only (a title
 *     that turns into an input on click made rows too easy to edit by
 *     accident on the way to opening them)
 *   - the ⋯ button (or right-clicking the row) opens a small menu:
 *     Open, Mark done, Rename, Set date, Delete — Delete confirms first,
 *     then the toast still offers Undo
 *   - "+ New Task" creates inline and drops into rename — never navigates
 *
 * Rows sort action-first: overdue, then pending (by date, then time),
 * completed last.
 *
 * opts (one object shared by render + attach):
 *   onChanged()          host re-render after any mutation
 *   onOpenTask(taskId)   open the task's detail (host navigation)
 *   allowDelete          true — offer Delete in the row menu; omit to hide it
 *   completeInMenu       true — offer Mark done / Mark not done / Restore in
 *                        the row menu (there is no completion checkbox)
 *   newTask              {links: [{app, id}, …]} — links for "+ New Task"; omit to hide
 *   linkExisting         {app, id} — owner for "+ Add Existing"; omit to hide
 *   aiBreakdown          {goalId} — show "Suggest tasks" (GoalBreakdown)
 *   title                section header label (default 'Tasks')
 *   emptyText            empty-state copy
 */

const TaskListUI = {

    _esc(s) { return UIUtils.escapeHtml(s == null ? '' : String(s)); },

    _today() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },

    _ensureScheduleLoaded() {
        if (typeof ScheduleApp === 'undefined') return false;
        if (!Array.isArray(ScheduleApp.scheduleItems) || ScheduleApp.scheduleItems.length === 0) {
            ScheduleApp.loadData();
        }
        return true;
    },

    _scheduleItem(taskId) {
        this._ensureScheduleLoaded();
        return (ScheduleApp.scheduleItems || []).find(i => i.id === taskId);
    },

    // --- Task state (matches how the Schedule app groups items) ---

    isCompleted(task, today = this._today()) {
        const repeating = task.repeat && task.repeat !== 'none';
        if (repeating) return task.lastCompletedDate === today;
        return !!task.lastCompletedDate;
    },

    /** Deliberately not done ('abandoned' in history) — resolved, same as
     *  completed: never pending, never overdue. */
    isAbandoned(task, today = this._today()) {
        const h = (task.history && typeof task.history === 'object') ? task.history : {};
        const repeating = task.repeat && task.repeat !== 'none';
        if (repeating) return h[today] === 'abandoned';
        return Object.values(h).includes('abandoned');
    },

    /** 'overdue' | 'pending' | 'completed' | 'abandoned' — abandoned sorts
     *  and styles with completed, it just keeps the honest label. */
    stateOf(task, today = this._today()) {
        if (this.isCompleted(task, today)) return 'completed';
        if (this.isAbandoned(task, today)) return 'abandoned';
        const repeating = task.repeat && task.repeat !== 'none';
        if (!repeating && task.scheduledDate && task.scheduledDate < today) return 'overdue';
        return 'pending';
    },

    /** "Every Mon" / "Tomorrow" / "Jul 20" (+ " · 2:00 PM" when timed). */
    dateLabel(task, today = this._today()) {
        const parts = [];
        if (task.repeat && task.repeat !== 'none') {
            parts.push(ScheduleUI.getRepeatLabel(task));
        } else if (task.scheduledDate) {
            parts.push(ScheduleUI.formatRelativeDate(task.scheduledDate, today));
        }
        const time = ScheduleUI.formatTime(task.startTime);
        if (time) parts.push(time);
        return parts.join(' &middot; ');
    },

    /** Action-first order: overdue, pending, completed — then date, then time. */
    sort(tasks) {
        const today = this._today();
        const order = { overdue: 0, pending: 1, completed: 2, abandoned: 2 };
        return [...tasks].sort((a, b) =>
            (order[this.stateOf(a, today)] - order[this.stateOf(b, today)])
            || (a.scheduledDate || '9999').localeCompare(b.scheduledDate || '9999')
            || (a.startTime || '').localeCompare(b.startTime || '')
            || (a.title || '').localeCompare(b.title || ''));
    },

    // --- Rendering ---

    /**
     * Full section: header row ("Tasks · n/m done" + actions) above the list.
     */
    renderSection(tasks, opts = {}) {
        const done = tasks.filter(t => this.isCompleted(t) || this.isAbandoned(t)).length;
        const actions = [
            opts.aiBreakdown ? `<button type="button" class="secondary-btn task-list-ai-btn" title="Ask the assistant to break this goal into tasks">&#10022; Suggest tasks</button>` : '',
            opts.newTask ? `<button type="button" class="secondary-btn task-list-new-btn">+ New Task</button>` : '',
            opts.linkExisting ? `<button type="button" class="secondary-btn task-list-link-btn">+ Add Existing</button>` : ''
        ].join('');
        return `<div class="task-list-section">
            <div class="detail-section-header-row">
                <span class="detail-section-header">${this._esc(opts.title || 'Tasks')}${tasks.length ? ` <span class="detail-section-count">${done}/${tasks.length} done</span>` : ''}</span>
                ${actions ? `<div class="detail-section-actions">${actions}</div>` : ''}
            </div>
            ${this.renderList(tasks, opts)}
        </div>`;
    },

    /** Per-window toggle for the folded completed rows — shared across
     *  lists (like GoalsPageUI._showLinkedNotes) so a re-render mid-look
     *  doesn't snap an expanded section shut. */
    _showCompleted: false,

    /** Selected task ids for bulk actions — module-level so a host
     *  re-render (which rebuilds the DOM) restores the checkmarks. Stale
     *  ids (deleted tasks, other lists) are harmless: only ids with a
     *  visible row render checked or count toward a list's bulk bar. */
    _selected: new Set(),

    /**
     * Just the list (or the empty state) — used bare inside the focus-area
     * detail's goal cards, which bring their own chrome. Resolved rows
     * (completed/abandoned) fold behind a collapsed "Completed (n)" toggle,
     * the app-wide pattern: done work stays reachable, never clutters.
     */
    renderList(tasks, opts = {}) {
        if (!tasks.length) {
            return `<div class="task-list-empty">${opts.emptyText || 'No tasks yet &mdash; break this into concrete steps.'}</div>`;
        }
        const today = this._today();
        // Tags live on the schedule record, not on every caller's mapped
        // shape — one lookup map per render, rows read from it by id.
        const tagsById = new Map();
        if (typeof ScheduleApp !== 'undefined' && Array.isArray(ScheduleApp.scheduleItems)) {
            for (const it of ScheduleApp.scheduleItems) {
                if (Array.isArray(it.tags) && it.tags.length) tagsById.set(it.id, it.tags);
            }
        }
        const row = (t) => {
            const state = this.stateOf(t, today);
            const resolved = state === 'completed' || state === 'abandoned';
            const label = state === 'abandoned'
                ? ['Abandoned', this.dateLabel(t, today)].filter(Boolean).join(' &middot; ')
                : this.dateLabel(t, today);
            const tags = tagsById.get(t.itemId) || [];
            const tagsHtml = tags.length
                ? `<span class="task-row-tags">${tags.map(tag => `<span class="task-tag">${this._esc(tag)}</span>`).join('')}</span>`
                : '';
            return `<div class="task-row${resolved ? ' task-row--completed' : ''}" data-task-id="${t.itemId}" title="Open task">
                <input type="checkbox" class="task-row-select" data-task-id="${t.itemId}"
                       ${this._selected.has(t.itemId) ? 'checked' : ''} title="Select task">
                <span class="task-row-title" data-edit-title="${t.itemId}">${this._esc(t.title)}</span>${tagsHtml}
                <span class="task-row-date${state === 'overdue' ? ' is-overdue' : ''}${label ? '' : ' is-empty'}" data-edit-date="${t.itemId}"
                      title="Click to set date">${label || 'Set date'}</span>
                <button type="button" class="task-row-menu" data-task-id="${t.itemId}" title="More actions">&#8943;</button>
            </div>`;
        };
        const sorted = this.sort(tasks);
        const open = sorted.filter(t => { const s = this.stateOf(t, today); return s !== 'completed' && s !== 'abandoned'; });
        const resolved = sorted.filter(t => { const s = this.stateOf(t, today); return s === 'completed' || s === 'abandoned'; });
        let html = open.map(row).join('');
        if (resolved.length) {
            html += `<button type="button" class="task-list-completed-toggle" aria-expanded="${this._showCompleted}">
                <span class="task-list-completed-arrow">${this._showCompleted ? '&#9662;' : '&#9656;'}</span>
                Completed (${resolved.length})
            </button>
            <div class="task-list-completed"${this._showCompleted ? '' : ' hidden'}>${resolved.map(row).join('')}</div>`;
        }
        // Bulk bar — hidden until a row is checked; attach() keeps it in
        // step with the selection without re-rendering the list.
        const bulkbar = `<div class="task-list-bulkbar" hidden>
            <span class="task-list-bulkbar-count"></span>
            <button type="button" class="task-list-bulkbar-delete">Delete</button>
            <button type="button" class="task-list-bulkbar-clear">Clear</button>
        </div>`;
        return `<div class="task-list">${bulkbar}${html}</div>`;
    },

    // --- Wiring ---

    /**
     * Wire every task row (and any section action buttons) under `root`.
     * Call once per list instance so per-instance context (new-task links,
     * owner ids) stays unambiguous.
     */
    attach(root, opts = {}) {
        if (!root) return;
        const changed = () => { if (opts.onChanged) opts.onChanged(); };

        // Selection + bulk bar. Toggling a checkbox mutates no data, so it
        // must NOT re-render the host (that would close menus, drop scroll);
        // the bar is updated in place instead, and a real re-render rebuilds
        // the checkmarks from _selected.
        const selectedHere = () =>
            [...root.querySelectorAll('.task-row-select')]
                .map(cb => cb.dataset.taskId)
                .filter(id => this._selected.has(id));
        const syncBulkBar = () => {
            const bar = root.querySelector('.task-list-bulkbar');
            if (!bar) return;
            const n = selectedHere().length;
            bar.hidden = n === 0;
            const count = bar.querySelector('.task-list-bulkbar-count');
            if (count) count.textContent = `${n} selected`;
        };
        root.querySelectorAll('.task-row-select').forEach(cb => {
            cb.addEventListener('click', (e) => e.stopPropagation());
            cb.addEventListener('change', () => {
                if (cb.checked) this._selected.add(cb.dataset.taskId);
                else this._selected.delete(cb.dataset.taskId);
                syncBulkBar();
            });
        });
        root.querySelectorAll('.task-list-bulkbar-delete').forEach(btn =>
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteManyWithUndo(selectedHere(), opts);
            }));
        root.querySelectorAll('.task-list-bulkbar-clear').forEach(btn =>
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                root.querySelectorAll('.task-row-select').forEach(cb => {
                    cb.checked = false;
                    this._selected.delete(cb.dataset.taskId);
                });
                syncBulkBar();
            }));
        syncBulkBar();

        root.querySelectorAll('.task-row-date').forEach(el =>
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                this.beginDateEdit(el.dataset.editDate, el, opts);
            }));

        root.querySelectorAll('.task-row-menu').forEach(btn =>
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const r = btn.getBoundingClientRect();
                this.openMenu(btn.dataset.taskId, { x: r.right, y: r.bottom + 2 }, opts);
            }));

        // Completed fold — toggles in place (no re-render), remembers the
        // choice for this window via _showCompleted.
        root.querySelectorAll('.task-list-completed-toggle').forEach(btn =>
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                TaskListUI._showCompleted = !TaskListUI._showCompleted;
                const body = btn.nextElementSibling;
                if (body) body.hidden = !TaskListUI._showCompleted;
                btn.setAttribute('aria-expanded', TaskListUI._showCompleted);
                const arrow = btn.querySelector('.task-list-completed-arrow');
                if (arrow) arrow.innerHTML = TaskListUI._showCompleted ? '&#9662;' : '&#9656;';
            }));

        // The whole row (title included) opens the task; inner controls
        // stopPropagation. Right-click anywhere on the row opens the same
        // actions menu.
        root.querySelectorAll('.task-row').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.closest('.task-row-select, .task-row-date, .task-row-menu')) return;
                if (opts.onOpenTask) opts.onOpenTask(row.dataset.taskId);
            });
            row.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.openMenu(row.dataset.taskId, { x: e.clientX, y: e.clientY }, opts);
            });
        });

        if (opts.newTask) {
            root.querySelectorAll('.task-list-new-btn').forEach(btn =>
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.createLinkedTask(opts.newTask.links || [], opts);
                }));
        }

        // "Suggest tasks" — GoalBreakdown runs the LLM pass and its
        // confirm-before-add modal; accepted rows land via the same
        // goal+area links as "+ New Task".
        if (opts.aiBreakdown && typeof GoalBreakdown !== 'undefined') {
            root.querySelectorAll('.task-list-ai-btn').forEach(btn =>
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    GoalBreakdown.suggest(opts.aiBreakdown, opts);
                }));
        }

        if (opts.linkExisting) {
            root.querySelectorAll('.task-list-link-btn').forEach(btn =>
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const { app, id } = opts.linkExisting;
                    const excludeIds = LinkManager.getLinksForApp(app, id, 'schedule').map(l => l.itemId);
                    LinkPicker.show({
                        targetApp: 'schedule',
                        exclude: excludeIds,
                        onSelect: (item) => {
                            LinkManager.addLink(app, id, 'schedule', item.id);
                            changed();
                        }
                    });
                }));
        }
    },

    /**
     * Small anchored actions menu for a row — one menu at a time, closed
     * by any outside click, Escape, or picking an action.
     */
    openMenu(taskId, at, opts = {}) {
        this.closeMenu();
        // Completion, where the host asks for it (the Goals page — its
        // rows' checkboxes are selection, and check-off belongs to the
        // Actions app). An abandoned row's entry restores instead: marking
        // it done would silently overwrite the honest label.
        let completeItems = [];
        if (opts.completeInMenu) {
            const item = this._scheduleItem(taskId);
            const state = item ? this.stateOf(item) : null;
            if (state === 'abandoned') {
                completeItems = [{ label: 'Restore', act: () => { ScheduleApp.toggleAbandoned(taskId); if (opts.onChanged) opts.onChanged(); } }];
            } else if (state) {
                completeItems = [{
                    label: state === 'completed' ? 'Mark not done' : 'Mark done',
                    act: () => { ScheduleApp.toggleComplete(taskId); if (opts.onChanged) opts.onChanged(); }
                }];
            }
        }
        const items = [
            { label: 'Open', act: () => { if (opts.onOpenTask) opts.onOpenTask(taskId); } },
            ...completeItems,
            // Renaming lives here, not on a title click — list titles are
            // for reading and opening, never accidental editing.
            { label: 'Rename', act: () => this.beginTitleEdit(taskId, null, opts) },
            { label: 'Set date', act: () => this.beginDateEdit(taskId, null, opts) },
            ...(opts.extraItems || []),
            ...(opts.allowDelete ? [{ label: 'Delete', danger: true, act: () => this.deleteWithUndo(taskId, opts) }] : [])
        ];
        const menu = document.createElement('div');
        menu.className = 'task-menu';
        menu.innerHTML = items.map((it, i) =>
            `<button type="button" class="task-menu-item${it.danger ? ' task-menu-item--danger' : ''}" data-idx="${i}">${it.label}</button>`
        ).join('');
        document.body.appendChild(menu);
        this._menu = menu;

        // Position: below-left of the anchor point, clamped to the viewport.
        const mw = menu.offsetWidth, mh = menu.offsetHeight;
        menu.style.left = `${Math.max(8, Math.min(at.x - mw, window.innerWidth - mw - 8))}px`;
        menu.style.top = `${Math.min(at.y, window.innerHeight - mh - 8)}px`;

        menu.addEventListener('click', (e) => {
            const btn = e.target.closest('.task-menu-item');
            if (!btn) return;
            e.stopPropagation();
            this.closeMenu();
            items[Number(btn.dataset.idx)].act();
        });
        this._menuDismiss = (e) => {
            if (e.type === 'keydown' && e.key !== 'Escape') return;
            if (e.type === 'mousedown' && e.target.closest('.task-menu')) return;
            this.closeMenu();
        };
        document.addEventListener('mousedown', this._menuDismiss, true);
        document.addEventListener('keydown', this._menuDismiss, true);
    },

    closeMenu() {
        if (this._menu && this._menu.parentNode) this._menu.parentNode.removeChild(this._menu);
        this._menu = null;
        if (this._menuDismiss) {
            document.removeEventListener('mousedown', this._menuDismiss, true);
            document.removeEventListener('keydown', this._menuDismiss, true);
            this._menuDismiss = null;
        }
    },

    /**
     * Confirm, delete, then still offer Undo in the toast. The snapshot
     * keeps the task object and every link it had, so Undo restores both.
     */
    async deleteWithUndo(taskId, opts = {}) {
        this._ensureScheduleLoaded();
        const item = this._scheduleItem(taskId);
        if (!item) return;
        const confirmed = await UIUtils.confirm(
            'Delete Task',
            'Are you sure you want to delete this task?',
            '🗑️'
        );
        if (!confirmed) return;
        const links = LinkManager.loadLinks().filter(l =>
            (l.sourceApp === 'schedule' && l.sourceId === taskId) ||
            (l.targetApp === 'schedule' && l.targetId === taskId));
        ScheduleApp.deleteTask(taskId);
        this._selected.delete(taskId);
        if (opts.onChanged) opts.onChanged();
        UIUtils.showToast('Task deleted', 'success', 6000, {
            actionLabel: 'Undo',
            onAction: () => {
                this._ensureScheduleLoaded();
                if (!ScheduleApp.scheduleItems.find(i => i.id === taskId)) {
                    item.modifiedAt = new Date().toISOString();
                    ScheduleApp.scheduleItems.push(item);
                    ScheduleApp.saveData();
                }
                links.forEach(l => LinkManager.addLink(l.sourceApp, l.sourceId, l.targetApp, l.targetId));
                if (opts.onChanged) opts.onChanged();
            }
        });
    },

    /**
     * Bulk delete for the multi-select bar: one confirm naming the count,
     * one delete, one toast whose Undo restores every task AND every link
     * each one had — the same snapshot shape as deleteWithUndo, plural.
     */
    async deleteManyWithUndo(taskIds, opts = {}) {
        this._ensureScheduleLoaded();
        const items = (taskIds || []).map(id => this._scheduleItem(id)).filter(Boolean);
        if (!items.length) return;
        if (items.length === 1) return this.deleteWithUndo(items[0].id, opts);
        const confirmed = await UIUtils.confirm(
            'Delete Tasks',
            `Are you sure you want to delete these ${items.length} tasks?`,
            '🗑️'
        );
        if (!confirmed) return;
        const ids = new Set(items.map(i => i.id));
        const links = LinkManager.loadLinks().filter(l =>
            (l.sourceApp === 'schedule' && ids.has(l.sourceId)) ||
            (l.targetApp === 'schedule' && ids.has(l.targetId)));
        items.forEach(i => ScheduleApp.deleteTask(i.id));
        ids.forEach(id => this._selected.delete(id));
        if (opts.onChanged) opts.onChanged();
        UIUtils.showToast(`${items.length} tasks deleted`, 'success', 6000, {
            actionLabel: 'Undo',
            onAction: () => {
                this._ensureScheduleLoaded();
                const now = new Date().toISOString();
                for (const item of items) {
                    if (!ScheduleApp.scheduleItems.find(i => i.id === item.id)) {
                        item.modifiedAt = now;
                        ScheduleApp.scheduleItems.push(item);
                    }
                }
                ScheduleApp.saveData();
                links.forEach(l => LinkManager.addLink(l.sourceApp, l.sourceId, l.targetApp, l.targetId));
                if (opts.onChanged) opts.onChanged();
            }
        });
    },

    /**
     * Create a task inline (dated today), link it to each {app, id} given,
     * re-render the host, then drop straight into renaming the new row.
     */
    createLinkedTask(links, opts = {}) {
        this._ensureScheduleLoaded();
        const newId = ScheduleApp.createTask('New task');
        if (!newId) return;
        for (const l of links) {
            if (l && l.app && l.id) LinkManager.addLink(l.app, l.id, 'schedule', newId);
        }
        if (opts.onChanged) opts.onChanged();
        setTimeout(() => this.beginTitleEdit(newId, null, opts), 0);
    },

    /** The same task can have a row in several views' DOM at once (the
     *  Actions page and a Goals list both render it; inactive views keep
     *  their markup) — the fallback lookup must land in the view the user
     *  is looking at, or the edit happens invisibly in a hidden one. */
    _findAnchor(attr, taskId) {
        return document.querySelector(`.view.active [${attr}="${taskId}"]`)
            || document.querySelector(`[${attr}="${taskId}"]`);
    },

    /** Swap the title span for an input; Enter/blur commits, Escape cancels. */
    beginTitleEdit(taskId, spanEl, opts = {}) {
        const el = spanEl || this._findAnchor('data-edit-title', taskId);
        if (!el) return;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'task-row-input';
        input.value = el.textContent;
        el.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        const finish = (commit) => {
            if (done) return;
            done = true;
            if (commit) {
                const item = this._scheduleItem(taskId);
                const clean = (input.value || '').trim();
                if (item && clean && item.title !== clean) {
                    item.title = clean;
                    item.modifiedAt = new Date().toISOString();
                    ScheduleApp.saveData();
                }
            }
            if (opts.onChanged) opts.onChanged();
        };
        input.addEventListener('blur', () => finish(true));
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
            else if (ev.key === 'Escape') finish(false);
        });
    },

    /**
     * Open the native date picker anchored to the pill via an invisible
     * proxy input — the pill itself never turns into a form field.
     */
    beginDateEdit(taskId, chipEl, opts = {}) {
        const el = chipEl || this._findAnchor('data-edit-date', taskId);
        if (!el) return;
        const item = this._scheduleItem(taskId);
        const input = document.createElement('input');
        input.type = 'date';
        input.className = 'task-row-date-proxy';
        input.value = (item && item.scheduledDate) || '';
        ['click', 'mousedown'].forEach(t => input.addEventListener(t, (e) => e.stopPropagation()));
        el.style.position = 'relative';
        el.appendChild(input);

        let done = false;
        const cleanup = () => { if (input.parentNode) input.parentNode.removeChild(input); };
        const commit = () => {
            if (done) return;
            done = true;
            cleanup();
            const it = this._scheduleItem(taskId);
            const next = input.value || null;
            if (it && it.scheduledDate !== next) {
                it.scheduledDate = next;
                it.modifiedAt = new Date().toISOString();
                ScheduleApp.saveData();
            }
            if (opts.onChanged) opts.onChanged();
        };
        const cancel = () => { if (done) return; done = true; cleanup(); };
        input.addEventListener('change', commit);
        input.addEventListener('blur', cancel);

        input.focus({ preventScroll: true });
        if (input.showPicker) { try { input.showPicker(); } catch (_) { cancel(); } }
        else { cancel(); }
    },

    /**
     * Inline TIME editor in the gutter — a VISIBLE input, unlike the date
     * pill's invisible proxy. The proxy trick relies on the native picker
     * closing itself after one click with a single change event, which is
     * how the DATE picker behaves; the TIME picker stays open across the
     * hour, minute and AM/PM picks and fires change as soon as the value
     * first completes — committing (and removing the input) there tore the
     * picker down mid-selection, with nothing visible to explain why.
     * Standard inline-edit semantics instead: the value assembles in view,
     * Enter or clicking away commits, Esc cancels, emptying it clears the
     * time.
     */
    beginTimeEdit(taskId, anchorEl, opts = {}) {
        const el = anchorEl;
        if (!el || el.querySelector('input')) return;
        const item = this._scheduleItem(taskId);
        const input = document.createElement('input');
        input.type = 'time';
        input.className = 'task-row-time-input';
        input.value = (item && item.startTime) || '';
        ['click', 'mousedown'].forEach(t => input.addEventListener(t, (e) => e.stopPropagation()));
        const priorText = el.textContent;
        el.textContent = '';
        el.appendChild(input);

        let done = false;
        const restore = () => {
            if (input.parentNode) input.parentNode.removeChild(input);
            el.textContent = priorText;
        };
        const commit = () => {
            if (done) return;
            done = true;
            const next = input.value || null;
            restore();
            const it = this._scheduleItem(taskId);
            if (it && it.startTime !== next) {
                it.startTime = next;
                it.modifiedAt = new Date().toISOString();
                ScheduleApp.saveData();
            }
            if (opts.onChanged) opts.onChanged();
        };
        const cancel = () => { if (done) return; done = true; restore(); };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
        });

        input.focus({ preventScroll: true });
        // The dropdown is a convenience on top of the visible input, not the
        // whole interaction — typing and arrow keys work without it.
        if (input.showPicker) { try { input.showPicker(); } catch (_) { /* typing still works */ } }
    }
};
