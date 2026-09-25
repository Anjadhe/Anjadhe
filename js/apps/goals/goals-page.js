/**
 * Goals page controller — planning, reached from the Tasks page's Plan
 * button (labelled "Projects" since 2026-08-30; app id, objects and keys
 * keep the goals name — docs/GOALS.md).
 *
 * The page has a HOME since 2026-09-10: one quiet table of every active
 * project (title, progress, next task, last update, target), completed
 * projects folded beneath it, and NO left rail (removed the same day, by
 * request — the table already lists everything the rail did). Groups (the
 * plain `group` text field on each goal — GoalsApp owns the data) are a
 * filter row above the table and a chip on each row; a group FILTERS the
 * same table rather than opening a page of its own. Groups are labels,
 * nothing more — no management pages; a group exists because a project
 * carries its name, and regrouping is editing that field on the sheet.
 *
 * The one pane shows the home (all, or one group), one project (the
 * sheet: head with the status pill, title, tasks, the Updates log,
 * details, a folded More block), or one task (the embedded Schedule
 * editor). Creation is a conversation: the "Help me plan a new project"
 * pill opens the assistant, which runs the fixed project interview
 * (goal-interview.js) and saves through the goals tools; "add one by
 * hand" creates a project in place and opens its sheet. The AI is the
 * front door, not the only door.
 */

const GoalsPage = {
    UNGROUPED: 'Ungrouped',

    // Workspace state (transient — resets on refresh; nav width persists in
    // localStorage, the rest in sessionStorage below).
    currentGroup: null,            // null = every project (the home); else one group as a filter
    selected: null,                // { type:'goal'|'task', id } in the pane
    showCompleted: false,          // the home's Completed fold

    init() {
        GoalsApp.loadGoals();
        // One-shot per session: bring unmodified machine-authored review
        // bodies up to the current template (e.g. the updates instruction).
        if (!this._reviewsRefreshed) {
            this._reviewsRefreshed = true;
            try { GoalInterview.refreshReviewBodies(); } catch (_) {}
        }
        this._restoreViewState();
        this.setupEventListeners();
        this.render();
    },

    // Per-window UI state — sessionStorage so a refresh (Cmd+R) restores
    // what the user was looking at, without syncing across windows or Macs.
    _viewStateKey: 'anjadhe.goals.viewState',

    _restoreViewState() {
        try {
            const raw = window.sessionStorage.getItem(this._viewStateKey);
            if (!raw) return;
            const s = JSON.parse(raw);
            if (typeof s.currentGroup === 'string') this.currentGroup = s.currentGroup;
            this.showCompleted = !!s.showCompleted;
            if (s.selected && s.selected.type && s.selected.id) {
                this.selected = { type: s.selected.type, id: s.selected.id };
                if (this.selected.type === 'goal'
                    && !(GoalsApp.goals || []).some(g => g.id === this.selected.id)) {
                    this.selected = null;
                }
            }
        } catch (_) {}
    },

    _persistViewState() {
        try {
            window.sessionStorage.setItem(this._viewStateKey, JSON.stringify({
                currentGroup: this.currentGroup,
                selected: this.selected,
                showCompleted: this.showCompleted
            }));
        } catch (_) {}
    },

    setupEventListeners() {
        // Goals left the Actions hub strip on 2026-08-03 — planning is a
        // different altitude from doing, and a peer tab claimed otherwise.
        // It is entered from the Tasks page's Plan button, so the way back
        // is a plain back button rather than a strip that would have to
        // exclude the page it sits on.
        const back = document.getElementById('goals-back-btn');
        if (back && !back._bound) {
            back._bound = true;
            back.addEventListener('click', () => {
                AppManager.openApp('actions');
                ActionsApp.showTasks();
            });
        }
    },

    // ── Navigation ───────────────────────────────────────────────────────

    /**
     * Keep currentGroup valid if goals move underneath it. A group that no
     * longer exists falls back to the home (every project) — never to some
     * other group the user did not pick.
     */
    resolveCurrentGroup() {
        if (this.currentGroup && !GoalsApp.getGroups().includes(this.currentGroup)) {
            this.currentGroup = null;
        }
        return this.currentGroup;
    },

    /**
     * The group of the current selection (the selected goal's, or the
     * selected task's via its goal link). Null if nothing resolvable.
     */
    groupForSelection() {
        const goal = this.goalForSelection();
        return goal ? GoalsApp.groupOf(goal) : null;
    },

    /** The goal that owns the current selection (itself, or the task's). */
    goalForSelection() {
        if (!this.selected) return null;
        if (this.selected.type === 'goal') {
            return (GoalsApp.goals || []).find(g => g.id === this.selected.id) || null;
        }
        if (this.selected.type === 'task') {
            const goalLinks = LinkManager.getLinksForApp('schedule', this.selected.id, 'goals');
            if (goalLinks[0]) {
                return (GoalsApp.goals || []).find(g => g.id === goalLinks[0].itemId) || null;
            }
        }
        return null;
    },

    /** Filter the home to one group (null = every project). */
    switchGroup(group) {
        this.currentGroup = group || null;
        this.selected = null;
        AppManager.setDetailHash('goals', null, null);
        this.render();
    },

    /** The page home: every project. Name kept for old callers/routes. */
    goToAllGroups() {
        this.currentGroup = null;
        this.selected = null;
        AppManager.setDetailHash('goals', null, null);
        this.render();
    },

    /** Old door (the group-less new-goal home): now the home itself. */
    showNewGoal() { this.goToAllGroups(); },

    /** The home with its Completed fold open — the nav's Completed row. */
    showCompletedProjects() {
        this.showCompleted = true;
        this.goToAllGroups();
    },

    toggleShowCompleted() {
        this.showCompleted = !this.showCompleted;
        this.render();
    },

    /** Select a goal or task to show in the detail pane. */
    selectNode(type, id) {
        // Where the inline task detail's back/close should land — the goal
        // or overview the user was on when they opened the task.
        if (type === 'task' && (!this.selected || this.selected.type !== 'task')) {
            this._taskReturnSel = this.selected ? { ...this.selected } : null;
        }
        this.selected = { type, id };
        // A group filter follows the record; the home (null) stays the home,
        // so backing out of a project opened from the table lands there.
        const group = this.groupForSelection();
        if (group && this.currentGroup && this.currentGroup !== group) this.currentGroup = group;
        AppManager.setDetailHash('goals', type === 'goal' ? 'view' : null, type === 'goal' ? id : null);
        this.render();
    },

    /**
     * Deep-link entry points (#goals/view/<id>, #goals/edit/<id>,
     * link-picker, agent chips). The detail page IS the editor.
     */
    openViewer(goalId) { this.selectNode('goal', goalId); },
    openEditor(goalId) { this.selectNode('goal', goalId); },

    /**
     * Close the inline task detail (embedded schedule editor) and return
     * to wherever the user opened it from. Called by ScheduleApp.closeEditor
     * for origin 'plan'.
     */
    closeTaskDetail() {
        this.selected = this._taskReturnSel || null;
        this._taskReturnSel = null;
        this.render();
    },

    // ── Inline task/goal mutations ───────────────────────────────────────

    // The pane reads via LinkManager (straight from storage), but inline
    // edits mutate ScheduleApp/GoalsApp in-memory arrays — which are only
    // populated once those apps have loaded.
    _ensureScheduleLoaded() {
        if (typeof ScheduleApp === 'undefined') return false;
        if (!Array.isArray(ScheduleApp.scheduleItems) || ScheduleApp.scheduleItems.length === 0) {
            ScheduleApp.loadData();
        }
        return true;
    },
    _ensureGoalsLoaded() {
        if (!Array.isArray(GoalsApp.goals) || GoalsApp.goals.length === 0) {
            GoalsApp.loadGoals();
        }
        return true;
    },

    _scheduleItem(taskId) {
        this._ensureScheduleLoaded();
        return (ScheduleApp.scheduleItems || []).find(i => i.id === taskId);
    },

    /** Inline-edit a task's title. Persists via ScheduleApp and re-renders. */
    setTaskTitle(taskId, title) {
        const item = this._scheduleItem(taskId);
        const clean = (title || '').trim();
        if (!item || !clean || item.title === clean) { this.render(); return; }
        item.title = clean;
        item.modifiedAt = new Date().toISOString();
        ScheduleApp.saveData();
        this.render();
    },

    /** Inline-edit a task's scheduled date (YYYY-MM-DD or '' to clear). */
    setTaskDate(taskId, date) {
        const item = this._scheduleItem(taskId);
        if (!item) return;
        const next = date || null;
        if (item.scheduledDate === next) { this.render(); return; }
        item.scheduledDate = next;
        item.modifiedAt = new Date().toISOString();
        ScheduleApp.saveData();
        this.render();
    },

    /** Inline-edit a task's start time (HH:MM or '' to clear). */
    setTaskTime(taskId, time) {
        const item = this._scheduleItem(taskId);
        if (!item) return;
        const next = time || '';
        if ((item.startTime || '') === next) { this.render(); return; }
        item.startTime = next;
        item.modifiedAt = new Date().toISOString();
        ScheduleApp.saveData();
        this.render();
    },

    /**
     * Update a goal's status. Completing stamps completedAt (the home's
     * Completed fold sorts and labels by it); reopening clears it.
     */
    setGoalStatus(goalId, status) {
        this._ensureGoalsLoaded();
        const goal = (GoalsApp.goals || []).find(g => g.id === goalId);
        if (!goal || goal.status === status) return;
        goal.status = status;
        goal.modifiedAt = new Date().toISOString();
        if (status === 'completed') goal.completedAt = goal.modifiedAt;
        else delete goal.completedAt;
        GoalsApp.saveGoals();
        if (typeof AnalyticsManager !== 'undefined') {
            try { AnalyticsManager.record('goal.status_updated'); } catch (_) {}
        }
        this.render();
    },

    /**
     * The sheet's "Mark complete" pill. A project with open tasks is asked
     * what to do with them — completing it used to strike the title and
     * leave live checkboxes underneath, which said two things at once.
     * One-time open tasks can be completed with it; repeating ones are
     * left alone either way (they are routines, not steps) and named.
     */
    async markComplete(goalId) {
        this._ensureGoalsLoaded();
        this._ensureScheduleLoaded();
        const goal = (GoalsApp.goals || []).find(g => g.id === goalId);
        if (!goal) return;
        const today = LinkManager._todayStr();
        const linked = LinkManager.getTasksForGoal(goalId);
        const openOnce = linked.filter(t => !(t.repeat && t.repeat !== 'none') && !LinkManager._taskResolved(t, today));
        const repeating = linked.filter(t => t.repeat && t.repeat !== 'none');
        if (openOnce.length) {
            const n = openOnce.length;
            const ok = await UIUtils.confirm(
                'Complete project',
                `&ldquo;${UIUtils.escapeHtml(goal.title)}&rdquo; still has ${n} open task${n === 1 ? '' : 's'}. Mark ${n === 1 ? 'it' : 'them'} done as well?${repeating.length ? `<br><span class="goals-confirm-note">${repeating.length} repeating task${repeating.length === 1 ? ' keeps' : 's keep'} running either way.</span>` : ''}`,
                '&#10003;',
                { confirmText: n === 1 ? 'Complete both' : 'Complete them all', cancelText: 'Keep tasks open' }
            );
            if (ok) {
                const now = new Date().toISOString();
                for (const t of openOnce) {
                    const item = (ScheduleApp.scheduleItems || []).find(i => i.id === t.itemId);
                    if (!item) continue;
                    item.lastCompletedDate = today;
                    item.modifiedAt = now;
                }
                ScheduleApp.saveData();
            }
        }
        this.setGoalStatus(goalId, 'completed');
        UIUtils.showToast('Project completed', 'success');
    },

    reopenGoal(goalId) {
        this.setGoalStatus(goalId, 'not-started');
    },

    /**
     * Set a plain field on a goal from the embedded editor (title,
     * description, targetDate). Persists via GoalsApp and re-renders.
     * A title change carries the goal's review routine along.
     */
    setGoalField(goalId, field, value, { render = true, syncRename = true } = {}) {
        this._ensureGoalsLoaded();
        const goal = (GoalsApp.goals || []).find(g => g.id === goalId);
        if (!goal) return;
        let renamedFrom = null;
        if (field === 'title') {
            const clean = (value || '').trim();
            if (!clean || goal.title === clean) { if (render) this.render(); return; }
            renamedFrom = goal.title;
            goal.title = clean;
        } else if (goal[field] === value) {
            return;
        } else {
            goal[field] = value;
        }
        goal.modifiedAt = new Date().toISOString();
        GoalsApp.saveGoals();
        if (renamedFrom && syncRename) this.syncGoalRename(renamedFrom, goal.title);
        // Quiet writes (typing) repaint nothing — the sheet is the only
        // thing on screen and rebuilding it would move the caret.
        if (render) this.render();
    },

    /**
     * Carry a project's review routine along with a rename (every rename
     * path calls this — docs/GOALS.md). Split out so the sheet's quiet,
     * per-keystroke writes can defer it to the final one.
     */
    syncGoalRename(renamedFrom, title) {
        if (!renamedFrom || !title || renamedFrom === title || typeof ReviewRoutines === 'undefined') return;
        GoalInterview._migrateReviewTitles();
        const sync = ReviewRoutines.syncRename(GoalInterview.GOAL_REVIEW_PREFIX, renamedFrom, title);
        if (sync.updated.length) {
            UIUtils.showToast(`Renamed ${sync.updated.length === 1 ? 'its review routine' : sync.updated.length + ' routines'} to match`, 'success');
        }
        if (sync.mentions.length) {
            UIUtils.showToast(`${sync.mentions.length} routine${sync.mentions.length === 1 ? ' still mentions' : 's still mention'} the old name — see Routines`, 'info');
        }
    },

    /**
     * Set a goal's group from the sheet's Group field. A group filter
     * follows the goal to its new group so it stays on screen; the home
     * stays the home.
     */
    setGoalGroup(goalId, group, opts = {}) {
        this._ensureGoalsLoaded();
        const changed = GoalsApp.setGoalGroup(goalId, group);
        const goal = (GoalsApp.goals || []).find(g => g.id === goalId);
        if (goal && this.currentGroup && this.selected && this.selected.type === 'goal' && this.selected.id === goalId) {
            this.currentGroup = GoalsApp.groupOf(goal);
        }
        if (opts.render === false) return;
        this.render();
        if (changed && opts.toast && goal) {
            UIUtils.showToast(`Moved to ${GoalsApp.groupOf(goal)}`, 'success');
        }
    },

    /**
     * Rename the group in view (the filtered home's Rename action). A name
     * another group already carries MERGES into it — which is also how
     * two spellings of one group are healed. Follows the group to its new
     * name so the page stays where the user was.
     */
    renameGroup(from, to) {
        this._ensureGoalsLoaded();
        const dst = (to || '').trim();
        if (!dst) { this.render(); return; }
        const existed = GoalsApp.getGroups().includes(dst) && dst !== from;
        const n = GoalsApp.renameGroup(from, dst);
        if (!n) { this.render(); return; }
        this.currentGroup = dst === GoalsApp.UNGROUPED ? null : dst;
        this.render();
        UIUtils.showToast(existed
            ? `Merged ${n} project${n === 1 ? '' : 's'} into ${dst}`
            : `Renamed to ${dst}`, 'success');
    },

    /**
     * Dissolve the group in view: its projects stay, with no group. A
     * confirm names the count — the label is cheap to retype, the
     * projects are not, and the dialog says which of the two goes.
     */
    async removeGroup(name) {
        this._ensureGoalsLoaded();
        const goals = GoalsApp.getGoalsInGroup(name);
        if (!goals.length) { this.goToAllGroups(); return; }
        const n = goals.length;
        const ok = await UIUtils.confirm(
            'Remove group',
            `Remove the group &ldquo;${UIUtils.escapeHtml(name)}&rdquo;? Its ${n} project${n === 1 ? ' stays' : 's stay'}, with no group.`,
            '&#128465;',
            { confirmText: 'Remove group', cancelText: 'Keep it' }
        );
        if (!ok) return;
        GoalsApp.renameGroup(name, '');
        this.currentGroup = null;
        this.render();
        UIUtils.showToast(`Group removed — ${n} project${n === 1 ? '' : 's'} now ungrouped`, 'success');
    },

    /**
     * Delete a goal from the embedded editor. Refuses while tasks are
     * still linked (strict parent-child, no cascade), then returns home.
     * Its updates go with it (the log has no page without the project).
     */
    async deleteGoal(goalId) {
        this._ensureGoalsLoaded();
        const goal = (GoalsApp.goals || []).find(g => g.id === goalId);
        if (!goal) return;

        const linked = LinkManager.countLinkedChildren('goals', goalId);
        if (linked.tasks > 0) {
            UIUtils.showToast(
                `Cannot delete "${goal.title}" — still has ${linked.tasks} task${linked.tasks === 1 ? '' : 's'} linked. Select them with their checkboxes to delete them first.`,
                'error'
            );
            return;
        }

        const confirmed = await UIUtils.confirm(
            'Delete Project',
            `Are you sure you want to delete "${goal.title}"?`,
            '🗑️'
        );
        if (!confirmed) return;

        LinkManager.removeAllLinksForItem('goals', goalId);
        if (typeof UpdateStore !== 'undefined') { try { UpdateStore.removeFor(`goal:${goalId}`); } catch (_) {} }
        GoalsApp.goals = GoalsApp.goals.filter(g => g.id !== goalId);
        GoalsApp.saveGoals();

        this.selected = null;
        AppManager.setDetailHash('goals', null, null);
        this.render();
        UIUtils.showToast('Project deleted', 'success');
    },

    /**
     * Create a goal in place and open it in the embedded editor — the
     * quiet manual path beside the interview pill. Title starts selected
     * for overtype.
     */
    createGoalInline(group) {
        this._ensureGoalsLoaded();
        const now = new Date().toISOString();
        const goal = {
            id: UIUtils.generateId(),
            title: 'New project',
            description: '',
            group: (group && group !== this.UNGROUPED) ? group : '',
            targetDate: null,
            status: 'not-started',
            createdAt: now,
            modifiedAt: now
        };
        GoalsApp.goals.unshift(goal);
        GoalsApp.saveGoals();
        this.selectNode('goal', goal.id);
        setTimeout(() => {
            const t = document.querySelector('#goals-detail-pane .goal-embed-title');
            if (t) { t.focus(); t.select(); }
        }, 0);
    },

    // ── Conversation doors ───────────────────────────────────────────────

    /** The "Help me plan a new project" pill — opens the assistant's interview. */
    askNewGoal(group) {
        if (typeof AgentUI === 'undefined' || !AgentUI.askWithPrompt) return;
        let prompt = 'Help me plan a new project. Walk me through it one question at a time — ' +
            'what I want to accomplish, what done looks like, by when — then propose the steps as tasks with dates.';
        if (group && group !== this.UNGROUPED) {
            prompt += ` This project belongs in my "${group}" group.`;
        }
        AgentUI.askWithPrompt(prompt, { newChat: true });
    },

    render() {
        this.resolveCurrentGroup();
        this._persistViewState();
        GoalsPageUI.renderWorkspace();
    }
};

// Register app
AppManager.register('goals', GoalsPage);

// One builder for the CURRENT GOAL block, used by the page provider (goal
// open in the detail pane) and the 'goals' record resolver (a conversation
// attached to a goal, continued away from this page) — one builder so
// "this goal" cannot drift between the two paths. Per-item context is for
// asks like "make this goal more measurable"; active goals already appear
// in the global briefing. Its decisions and updates ride the block through
// AgentService._decisionsBlockFor, keyed by recordKey.
GoalsPage.goalContextBlock = function (goalId, opts = {}) {
    if (!goalId) return null;
    if (!Array.isArray(GoalsApp.goals) || GoalsApp.goals.length === 0) {
        GoalsApp.loadGoals();
    }
    const goal = (GoalsApp.goals || []).find(g => g && g.id === goalId);
    if (!goal) return null;

    const lead = opts.attached
        ? 'This conversation is attached to the project below (the user may not have it open right now)'
        : 'The user is viewing or editing the project below';
    return {
        recordKey: 'goals:' + goal.id,
        recordLabel: goal.title || '(untitled project)',
        title: 'CURRENT PROJECT',
        body: `${lead}. The project is available as context, not a constraint:

- When the user's question is about "this project", "the project", or asks to update / refine it, work with the data below. To modify it, call save_goal (it merges) or update_goal with id: "${goal.id}". To log progress, a review, or a risk on it, call post_update with type "project" and this id.
- For general questions, answer normally.

Title: ${goal.title || '(untitled)'}
Group: ${goal.group || 'none'}
Target date: ${goal.targetDate || 'none'}
Status: ${goal.status || 'unspecified'}
Project id: ${goal.id}

Description (what done looks like):
${goal.description || '(none)'}${goal.why ? `

Why it matters:
${goal.why}` : ''}${goal.obstacles ? `

Likely obstacles:
${goal.obstacles}` : ''}`,
        suggestedPrompts: [
            'How is this going?',
            'Make this more measurable',
            'Suggest milestones'
        ]
    };
};

if (typeof AgentContext !== 'undefined') {
    AgentContext.register('goals', () => {
        const sel = GoalsPage.selected;
        // The embedded task detail: same CURRENT TASK block as the Actions
        // page's inline detail (one builder, so "this task" cannot drift
        // between the two surfaces).
        if (sel && sel.type === 'task' && typeof ActionsApp !== 'undefined') {
            return ActionsApp.taskContextBlock(sel.id);
        }
        if (!sel || sel.type !== 'goal') return null;
        return GoalsPage.goalContextBlock(sel.id);
    });

    // Record resolver — rebuilds the CURRENT GOAL block from a conversation's
    // 'goals:<id>' attachment when the chat is continued away from this page.
    AgentContext.registerRecord('goals', (id) => GoalsPage.goalContextBlock(id, { attached: true }));
}
