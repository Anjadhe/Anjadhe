/**
 * Goals page controller — planning, reached from the Tasks page's Plan
 * button. It was the hub's third tab until 2026-08-03 (and "Plan" before
 * that); it is no longer in the tab strip at all.
 *
 * Goals are the main object: the left nav lists groups (the plain `group`
 * text field on each goal — GoalsApp owns the data) with their goals
 * beneath; the right pane shows ONE group at a time (no all-goals view —
 * removed 2026-07-31 as overwhelming), one goal (inline editor), or one
 * task (the embedded Schedule editor). There are no group management
 * pages — a group exists because a goal carries its name, and regrouping
 * is editing that field or dragging a goal onto a group row.
 *
 * Creation is a conversation: the "Set a new goal" prompt pill opens the
 * assistant, which runs the fixed goal interview (goal-interview.js) and
 * saves through the goals tools. Inline creation and editing stay —
 * the AI is the front door, not the only door.
 *
 * Because the page only ever shows ONE group, both doors inside a group
 * overview are scoped to that group. The nav's top row ("+ New goal")
 * opens the group-less **new-goal home** (`newGoalMode`) — the same two
 * doors over a free-text Group field, so a goal that belongs to a group
 * that does not exist yet can be created without first landing in the
 * wrong one. It is also what a fresh install opens on.
 */

const GoalsPage = {
    UNGROUPED: 'Ungrouped',

    // Workspace state (transient — resets on refresh; nav width persists in
    // localStorage, the rest in sessionStorage below). There is no
    // "all goals" home (removed 2026-07-31 — every goal on one page was
    // overwhelming): the page opens on one group at a time.
    currentGroup: null,            // active group; null = resolved on render
    selected: null,                // { type:'goal'|'task', id } in the pane
    newGoalMode: false,            // the group-less new-goal home is in the pane
    collapsedGoalIds: new Set(),   // goal cards with their task list hidden

    init() {
        GoalsApp.loadGoals();
        // One-shot per session: bring unmodified machine-authored review
        // bodies up to the current template (e.g. the ageDays instruction).
        if (!this._reviewsRefreshed) {
            this._reviewsRefreshed = true;
            try { GoalInterview.refreshReviewBodies(); } catch (_) {}
        }
        this._restoreViewState();
        this.setupEventListeners();
        NavResizer.attach({
            layoutSel: '#goals-view .goals-layout',
            resizerId: 'goals-nav-resizer',
            cssVar: '--actions-nav-width',
            storageKey: 'goals-nav-width',
            defaultW: 188,
        });
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
            this.newGoalMode = !!s.newGoalMode;
            if (Array.isArray(s.collapsedGoals)) this.collapsedGoalIds = new Set(s.collapsedGoals);
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
                newGoalMode: this.newGoalMode,
                collapsedGoals: [...this.collapsedGoalIds]
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
     * Resolve the active group, keeping currentGroup valid if goals move
     * underneath it.
     */
    resolveCurrentGroup() {
        const groups = GoalsApp.getGroups();
        if (groups.length === 0) { this.currentGroup = null; return null; }
        if (!this.currentGroup || !groups.includes(this.currentGroup)) {
            const sel = this.groupForSelection();
            this.currentGroup = (sel && groups.includes(sel)) ? sel : groups[0];
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

    /** Switch to one group's overview. */
    switchGroup(group) {
        this.currentGroup = group;
        this.selected = null;
        this.newGoalMode = false;
        AppManager.setDetailHash('goals', null, null);
        this.render();
    },

    /**
     * The page home: the current group's overview (there is no all-goals
     * view — one group at a time). Name kept for old callers/routes.
     */
    goToAllGroups() {
        this.selected = null;
        this.newGoalMode = false;
        AppManager.setDetailHash('goals', null, null);
        this.render();
    },

    /**
     * The new-goal home — the one screen that belongs to no group, so a
     * goal can be created into a group that does not exist yet (type the
     * name; the group exists because a goal carries it).
     */
    showNewGoal() {
        this.selected = null;
        this.newGoalMode = true;
        AppManager.setDetailHash('goals', null, null);
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
        this.newGoalMode = false;
        const group = this.groupForSelection();
        if (group) this.currentGroup = group;
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

    /** Collapse/expand a goal card's task list in the overviews. */
    toggleGoalCollapsed(goalId) {
        if (this.collapsedGoalIds.has(goalId)) this.collapsedGoalIds.delete(goalId);
        else this.collapsedGoalIds.add(goalId);
        this._persistViewState();
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

    /** Update a goal's status inline (detail pane status pills). */
    setGoalStatus(goalId, status) {
        this._ensureGoalsLoaded();
        const goal = (GoalsApp.goals || []).find(g => g.id === goalId);
        if (!goal || goal.status === status) return;
        goal.status = status;
        goal.modifiedAt = new Date().toISOString();
        GoalsApp.saveGoals();
        if (typeof AnalyticsManager !== 'undefined') {
            try { AnalyticsManager.record('goal.status_updated'); } catch (_) {}
        }
        this.render();
    },

    /**
     * Set a plain field on a goal from the embedded editor (title,
     * description, targetDate). Persists via GoalsApp and re-renders.
     * A title change carries the goal's review routine along.
     */
    setGoalField(goalId, field, value) {
        this._ensureGoalsLoaded();
        const goal = (GoalsApp.goals || []).find(g => g.id === goalId);
        if (!goal) return;
        let renamedFrom = null;
        if (field === 'title') {
            const clean = (value || '').trim();
            if (!clean || goal.title === clean) { this.render(); return; }
            renamedFrom = goal.title;
            goal.title = clean;
        } else if (goal[field] === value) {
            return;
        } else {
            goal[field] = value;
        }
        goal.modifiedAt = new Date().toISOString();
        GoalsApp.saveGoals();
        if (renamedFrom && typeof ReviewRoutines !== 'undefined') {
            const sync = ReviewRoutines.syncRename(GoalInterview.GOAL_REVIEW_PREFIX, renamedFrom, goal.title);
            if (sync.updated.length) {
                UIUtils.showToast(`Renamed ${sync.updated.length === 1 ? 'its review routine' : sync.updated.length + ' routines'} to match`, 'success');
            }
            if (sync.mentions.length) {
                UIUtils.showToast(`${sync.mentions.length} routine${sync.mentions.length === 1 ? ' still mentions' : 's still mention'} the old name — see Routines`, 'info');
            }
        }
        this.render();
    },

    /**
     * Set a goal's group — from the detail input or a drag onto a group
     * row. Follows the goal to its new group so it stays on screen.
     */
    setGoalGroup(goalId, group, opts = {}) {
        this._ensureGoalsLoaded();
        const changed = GoalsApp.setGoalGroup(goalId, group);
        const goal = (GoalsApp.goals || []).find(g => g.id === goalId);
        if (goal && this.selected && this.selected.type === 'goal' && this.selected.id === goalId) {
            this.currentGroup = GoalsApp.groupOf(goal);
        }
        this.render();
        if (changed && opts.toast && goal) {
            UIUtils.showToast(`Moved to ${GoalsApp.groupOf(goal)}`, 'success');
        }
    },

    /**
     * Delete a goal from the embedded editor. Refuses while tasks are
     * still linked (strict parent-child, no cascade), then returns to the
     * group home.
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
            'Delete Goal',
            `Are you sure you want to delete "${goal.title}"?`,
            '🗑️'
        );
        if (!confirmed) return;

        LinkManager.removeAllLinksForItem('goals', goalId);
        GoalsApp.goals = GoalsApp.goals.filter(g => g.id !== goalId);
        GoalsApp.saveGoals();

        this.selected = null;
        AppManager.setDetailHash('goals', null, null);
        this.render();
        UIUtils.showToast('Goal deleted', 'success');
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
            title: 'New goal',
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

    /** The "Set a new goal" prompt pill — opens the assistant's interview. */
    askNewGoal(group) {
        if (typeof AgentUI === 'undefined' || !AgentUI.askWithPrompt) return;
        let prompt = 'Help me set a new goal and plan it out. Walk me through it one question at a time — ' +
            'what I want to accomplish, what done looks like, by when — then propose the steps as tasks with dates.';
        if (group && group !== this.UNGROUPED) {
            prompt += ` This goal belongs in my "${group}" group.`;
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

// AgentContext provider — exposes the goal currently open in the detail
// pane. Per-item context is for asks like "make this goal more measurable";
// active goals already appear in the global briefing.
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
        const goal = (GoalsApp.goals || []).find(g => g && g.id === sel.id);
        if (!goal) return null;

        return {
            recordKey: 'goals:' + goal.id,
            recordLabel: goal.title || '(untitled goal)',
            title: 'CURRENT GOAL',
            body: `The user is viewing or editing the goal below. The goal is available as context, not a constraint:

- When the user's question is about "this goal", "the goal", or asks to update / refine it, work with the data below. To modify it, call save_goal (it merges) or update_goal with id: "${goal.id}".
- For general questions, answer normally.

Title: ${goal.title || '(untitled)'}
Group: ${goal.group || 'none'}
Target date: ${goal.targetDate || 'none'}
Status: ${goal.status || 'unspecified'}
Goal id: ${goal.id}

Description (what done looks like):
${goal.description || '(none)'}${goal.why ? `

Why it matters:
${goal.why}` : ''}${goal.obstacles ? `

Likely obstacles:
${goal.obstacles}` : ''}`,
            suggestedPrompts: [
                'Make this more measurable',
                'Suggest milestones',
                'Identify likely obstacles'
            ]
        };
    });
}
