/**
 * Goals page UI — two panes: groups + their goals in the left nav, a
 * drill-down detail pane on the right (all goals › one group › one goal ›
 * one task). Inline edits persist straight through GoalsPage to
 * GoalsApp / ScheduleApp / LinkManager.
 *
 * Monochrome by design: the only color on this page is semantic goal
 * status (stuck red, completed green).
 */

const GoalsPageUI = {
    _showLinkedNotes: false,

    _esc(s) { return UIUtils.escapeHtml(s == null ? '' : String(s)); },

    // ===================================================================
    //  WORKSPACE SHELL
    // ===================================================================

    renderWorkspace() {
        this.renderBreadcrumb();
        this.renderNav();
        this._populateGroupOptions();
        this.renderDetailPane();
    },

    /**
     * Left nav — the group-less "+ New goal" row, then each group as a
     * clickable heading with its goals beneath. Reuses the Tasks tab's nav
     * classes so the two tabs read as one system. Group rows accept goal
     * drops; goal rows drag.
     */
    renderNav() {
        const nav = document.getElementById('goals-nav');
        if (!nav) return;
        const selGoal = GoalsPage.goalForSelection();
        const activeGroup = (!GoalsPage.selected && !GoalsPage.newGoalMode) ? GoalsPage.currentGroup : null;

        // Always first, always outside every group: the only door to a goal
        // whose group does not exist yet. It is also what a blank slate
        // shows, so mark it active then too.
        const newActive = GoalsPage.newGoalMode || (!GoalsPage.selected && !GoalsPage.currentGroup);
        let html = `<div class="gnav-new-row">
            <button type="button" class="actions-nav-item gnav-new${newActive ? ' is-active' : ''}"
                    data-new-goal-home title="Set a new goal">
                <span class="actions-nav-label">+ New goal</span>
            </button>
        </div>`;
        // One batched count query for every goal in the nav — per-goal
        // lookups here were two sync-IPC blob reads each.
        const groupGoals = GoalsApp.getGroups().map(g => [g, GoalsApp.getGoalsInGroup(g)]);
        const counts = LinkManager.getTaskCountsForGoals(
            groupGoals.flatMap(([, goals]) => goals.map(x => x.id)));
        for (const [g, goals] of groupGoals) {
            const active = goals.filter(x => x.status !== 'completed').length;
            html += `<button type="button" class="actions-nav-item gnav-group${activeGroup === g ? ' is-active' : ''}"
                             data-open-group="${this._esc(g)}" title="${this._esc(g)}">
                <span class="actions-nav-label">${this._esc(g)}</span>
                ${active ? `<span class="actions-nav-count">${active}</span>` : ''}
            </button>`;
            // Completed goals leave the nav — the group overview's cards
            // still list them, so they stay reachable. The one being read
            // is exempt (the Email AI list's rule: the row you are reading
            // is never filtered out from under you), so checking a goal
            // off doesn't yank the selection's own nav row.
            const shown = goals.filter(goal =>
                goal.status !== 'completed' || (selGoal && selGoal.id === goal.id));
            html += shown.map(goal => {
                const count = counts.get(goal.id) || { total: 0, completed: 0 };
                return `<button type="button" class="actions-nav-item gnav-goal${goal.status === 'completed' ? ' completed' : ''}${selGoal && selGoal.id === goal.id ? ' is-active' : ''}"
                                data-open-goal="${goal.id}" draggable="true" data-drag-goal="${goal.id}" title="${this._esc(goal.title)}">
                    <span class="actions-nav-label">${this._esc(goal.title)}</span>
                    ${count.total ? `<span class="actions-nav-count">${count.completed}/${count.total}</span>` : ''}
                </button>`;
            }).join('');
        }
        nav.innerHTML = html;

        nav.querySelector('[data-new-goal-home]')
            ?.addEventListener('click', () => GoalsPage.showNewGoal());
        nav.querySelectorAll('[data-open-group]').forEach(el =>
            el.addEventListener('click', () => GoalsPage.switchGroup(el.dataset.openGroup)));
        nav.querySelectorAll('[data-open-goal]').forEach(el =>
            el.addEventListener('click', () => GoalsPage.selectNode('goal', el.dataset.openGoal)));
        this._wireDragDrop(nav);
    },

    /**
     * No breadcrumb TRAIL: the left nav names the selection and is always
     * up, and the goal detail's in-pane eyebrow links back to its group —
     * a chrome trail would repeat what the page already says (same rule as
     * the Tasks tab). The app title itself stays.
     *
     * It reads "Goals", not "Actions" (2026-08-03): while this was a tab,
     * the strip underneath said which rung you were on and the title named
     * the room. With the strip gone, the title is the only thing that can
     * say where you are.
     */
    renderBreadcrumb() {
        Breadcrumb.render('goals-breadcrumb', [{ label: 'Goals' }]);
    },

    /** Fill the shared <datalist> with existing group names for reuse. */
    _populateGroupOptions() {
        const dl = document.getElementById('goals-group-options');
        if (!dl) return;
        const groups = GoalsApp.getGroups().filter(g => g !== GoalsApp.UNGROUPED);
        dl.innerHTML = groups.map(g => `<option value="${this._esc(g)}"></option>`).join('');
    },

    // ===================================================================
    //  DETAIL PANE
    // ===================================================================

    renderDetailPane() {
        const pane = document.getElementById('goals-detail-pane');
        if (!pane) return;
        // The pane may currently host the embedded schedule editor — hand
        // its DOM back BEFORE any innerHTML write, or it would be destroyed.
        ScheduleApp.restoreEditorHome();
        const sel = GoalsPage.selected;
        if (!sel) {
            if (GoalsPage.newGoalMode) this.renderNewGoalHome(pane);
            else this.renderGroupOverview(pane);
            return;
        }
        if (sel.type === 'goal') this.renderGoalDetail(sel.id, pane);
        else if (sel.type === 'task') this.renderTaskDetail(sel.id, pane);
    },

    /** The "Set a new goal" prompt pill (+ optional group scope). */
    _newGoalAskRow(group) {
        const scope = group && group !== GoalsApp.UNGROUPED ? ` data-ask-group="${this._esc(group)}"` : '';
        return `<div class="ask-prompt-row goals-ask-row">
            <button type="button" class="ask-prompt-btn primary" data-ask-new-goal${scope}>&ldquo;Help me set a new goal&rdquo;</button>
            <button type="button" class="quiet-link-btn goals-manual-add" data-new-goal${scope}>+ New goal by hand</button>
        </div>`;
    },

    /**
     * The new-goal home — the one screen that belongs to no group. Both
     * doors (the interview pill and the by-hand link) read the Group field
     * above them, so typing a name that no goal carries yet is how a new
     * group is made; leaving it blank files the goal under "Other goals".
     * A fresh install opens here too — the page opens as a conversation,
     * not an empty tree.
     */
    renderNewGoalHome(pane) {
        GoalsPage._ensureGoalsLoaded();
        const groups = GoalsApp.getGroups().filter(g => g !== GoalsApp.UNGROUPED);
        pane.innerHTML = `<div class="goals-overview goals-blank">
            <div class="goals-detail-eyebrow"><span>New goal</span></div>
            <h2 class="goals-detail-title">Set a goal</h2>
            <p class="goals-blank-lede">A goal here is an outcome with a finish line, a date, and
            the first steps on your calendar. The assistant builds it with you: a few questions,
            then a task timeline you approve.</p>
            <div class="goals-new-group">
                <label for="goals-new-group">Group</label>
                <input type="text" id="goals-new-group" class="goals-new-group-input" list="goals-group-options"
                       placeholder="${groups.length ? this._esc(groups.slice(0, 2).join(', ')) + ', or a new one' : 'e.g. Work, Health'}"
                       autocomplete="off">
                <span class="goals-new-group-hint">Type a name that does not exist yet to start a new group. Leave it blank for none.</span>
            </div>
            ${this._newGoalAskRow(null)}
        </div>`;

        // Both doors take the group typed here, live at click time.
        const groupInput = pane.querySelector('.goals-new-group-input');
        const typed = () => (groupInput ? groupInput.value.trim() : '') || null;
        pane.querySelectorAll('[data-ask-new-goal]').forEach(btn =>
            btn.addEventListener('click', () => GoalsPage.askNewGoal(typed())));
        pane.querySelectorAll('[data-new-goal]').forEach(btn =>
            btn.addEventListener('click', () => GoalsPage.createGoalInline(typed())));
    },

    /**
     * Group overview — the page home: one group's goals as cards, each
     * with its task list and conversation doors. One group at a time (the
     * all-goals view was removed 2026-07-31 — overwhelming). No group
     * management: a group is just the label its goals carry.
     */
    renderGroupOverview(pane) {
        GoalsPage._ensureGoalsLoaded();
        const group = GoalsPage.currentGroup;
        if (!group) { this.renderNewGoalHome(pane); return; }
        const goals = GoalsApp.getGoalsInGroup(group);
        const label = group === GoalsApp.UNGROUPED ? 'Other goals' : group;

        let html = `<div class="goals-overview">
            <div class="goals-detail-eyebrow"><span>Group</span></div>
            <div class="goals-head">
                <h2 class="goals-detail-title">${this._esc(label)}</h2>
            </div>
            <div class="goals-overview-sub">${goals.length} goal${goals.length === 1 ? '' : 's'} &mdash; rename or move goals to reshape the group</div>`;

        if (goals.length === 0) {
            html += '<div class="goals-empty-line">No goals in this group yet.</div>';
        } else {
            html += this._attnBriefing(goals);
            html += '<div class="goals-card-list">';
            for (const goal of goals) html += this._renderGoalCard(goal);
            html += '</div>';
        }
        html += this._newGoalAskRow(group);
        html += '</div>';

        pane.innerHTML = html;
        this._wireOverview(pane);
        this._attachGoalCardListeners(pane);
    },

    /**
     * Attention-first facts above the cards (the Email AI Overview
     * pattern): "Target dates" ordered by each goal's own clock, then
     * active goals with no open next step — minus goals the first list
     * already shows. Pure arithmetic; the weekly AI review owns judgment.
     * Nothing to say → nothing renders.
     */
    _attnBriefing(goals) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const dated = goals
            .filter(g => g.status !== 'completed' && g.targetDate)
            .map(g => ({ g, d: this._parseTarget(g.targetDate) }))
            .filter(x => x.d && !isNaN(x.d))
            .sort((a, b) => a.d - b.d);
        const datedIds = new Set(dated.map(x => x.g.id));
        const candidates = goals.filter(g =>
            g.status !== 'completed' && g.status !== 'draft' && !datedIds.has(g.id));
        const counts = LinkManager.getTaskCountsForGoals(candidates.map(g => g.id));
        const noStep = candidates.filter(g => {
            const c = counts.get(g.id) || { total: 0, completed: 0 };
            return c.total - c.completed <= 0;
        });
        if (dated.length === 0 && noStep.length === 0) return '';

        let html = '<div class="goals-attn">';
        if (dated.length) {
            html += '<div class="goals-attn-head">Target dates</div>';
            for (const { g, d } of dated) {
                const over = d < today;
                html += `<button type="button" class="goals-attn-row" data-open-goal="${g.id}">
                    <span class="goals-attn-when${over ? ' is-over' : ''}">${this._fmtTarget(d, today)}</span>
                    <span class="goals-attn-title">${this._esc(g.title)}</span>
                    <span class="goals-attn-note${over ? ' is-over' : ''}">${over ? 'target passed' : this._relDays(d, today)}</span>
                </button>`;
            }
        }
        if (noStep.length) {
            html += '<div class="goals-attn-head">No open next step</div>';
            for (const g of noStep) {
                html += `<button type="button" class="goals-attn-row" data-open-goal="${g.id}">
                    <span class="goals-attn-when"></span>
                    <span class="goals-attn-title">${this._esc(g.title)}</span>
                    <span class="goals-attn-note">no open tasks</span>
                </button>`;
            }
        }
        html += '</div>';
        return html;
    },

    // targetDate is a date-only string; parse as LOCAL midnight (the
    // calendar app's lesson — new Date('YYYY-MM-DD') is UTC midnight, the
    // previous evening in western timezones).
    _parseTarget(value) {
        if (typeof value !== 'string') return null;
        const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (!m) return null;
        return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    },

    _fmtTarget(d, today) {
        const opts = { month: 'short', day: 'numeric' };
        if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
        return d.toLocaleDateString('en-US', opts);
    },

    _relDays(d, today) {
        const days = Math.round((d - today) / 86400000);
        if (days <= 0) return 'today';
        if (days === 1) return 'tomorrow';
        if (days < 30) return `in ${days} days`;
        if (days < 90) return `in ${Math.round(days / 7)} weeks`;
        return `in ${Math.round(days / 30)} months`;
    },

    /**
     * A goal card for the group overview: header (collapse twisty, status,
     * title, n/m count — opens the goal) + the goal's task list and
     * prompt-buttons when expanded.
     */
    _renderGoalCard(goal) {
        const tasks = LinkManager.getTasksForGoal(goal.id);
        const taskCount = LinkManager.getTaskCountForGoal(goal.id, tasks);
        const expanded = !GoalsPage.collapsedGoalIds.has(goal.id);

        let html = `<div class="goals-card ${goal.status === 'completed' ? 'completed' : ''}" data-goal-id="${goal.id}">`;
        html += `<div class="goals-card-header" data-goal-id="${goal.id}">
                    <button type="button" class="goals-card-collapse" data-collapse-goal="${goal.id}"
                            aria-expanded="${expanded}" title="${expanded ? 'Hide tasks' : 'Show tasks'}">${expanded ? '&#9662;' : '&#9656;'}</button>
                    <span class="goals-card-title" draggable="true" data-drag-goal="${goal.id}">${this._esc(goal.title)}</span>
                    ${goal.status === 'draft' ? '<span class="goals-draft-chip">draft</span>' : ''}
                    ${taskCount.total > 0 ? `<span class="goals-card-task-count">${taskCount.completed}/${taskCount.total}</span>` : ''}
                    <span class="goals-card-nav" title="Open goal">&#8594;</span>
                 </div>`;
        if (expanded) {
            if (tasks.length > 0) {
                html += `<div class="goals-card-tasks">${TaskListUI.renderList(tasks, this._goalTaskOpts(goal.id))}</div>`;
            }
            html += `<button class="goals-card-add-task task-list-new-btn">+ New Task</button>`;
            html += `<div class="ask-prompt-row goals-card-ask">${this._goalAskButtons(goal)}</div>`;
        }
        html += '</div>';
        return html;
    },

    /**
     * The quoted prompt-buttons for one goal. A draft's door is finishing
     * the interview; a live goal's doors are the status conversation.
     */
    _goalAskButtons(goal) {
        if (goal.status === 'draft') {
            return `<button type="button" class="ask-prompt-btn primary" data-goal-ask="finish" data-goal-title="${this._esc(goal.title)}">&ldquo;Finish planning it&rdquo;</button>`;
        }
        return `<button type="button" class="ask-prompt-btn" data-goal-ask="status" data-goal-title="${this._esc(goal.title)}">&ldquo;How is this going?&rdquo;</button>
            <button type="button" class="ask-prompt-btn" data-goal-ask="stuck" data-goal-title="${this._esc(goal.title)}">&ldquo;I&rsquo;m stuck&rdquo;</button>`;
    },

    /** Wire goal/group opens, creation, and drags in an overview pane. */
    _wireOverview(pane) {
        pane.querySelectorAll('[data-open-goal]').forEach(el =>
            el.addEventListener('click', () => GoalsPage.selectNode('goal', el.dataset.openGoal)));
        pane.querySelectorAll('[data-open-group]').forEach(el =>
            el.addEventListener('click', () => GoalsPage.switchGroup(el.dataset.openGroup)));
        pane.querySelectorAll('[data-ask-new-goal]').forEach(btn =>
            btn.addEventListener('click', () => GoalsPage.askNewGoal(btn.dataset.askGroup || null)));
        pane.querySelectorAll('[data-new-goal]').forEach(btn =>
            btn.addEventListener('click', () => GoalsPage.createGoalInline(btn.dataset.askGroup || null)));
        this._wireDragDrop(pane);
    },

    // Custom MIME type so dragover can tell goal drags apart (dataTransfer
    // payloads are unreadable until drop).
    GOAL_MIME: 'application/x-anjadhe-goal',

    /**
     * Drag-and-drop regrouping: goal rows drag, anything that opens a
     * group accepts the drop and sets the goal's `group` field.
     */
    _wireDragDrop(pane) {
        pane.querySelectorAll('[data-drag-goal]').forEach(el =>
            el.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData(this.GOAL_MIME, el.dataset.dragGoal);
                e.dataTransfer.effectAllowed = 'move';
            }));

        pane.querySelectorAll('[data-open-group]').forEach(el => {
            el.addEventListener('dragover', (e) => {
                if (![...e.dataTransfer.types].includes(this.GOAL_MIME)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                el.classList.add('is-drop');
            });
            el.addEventListener('dragleave', (e) => {
                if (!el.contains(e.relatedTarget)) el.classList.remove('is-drop');
            });
            el.addEventListener('drop', (e) => {
                const id = e.dataTransfer.getData(this.GOAL_MIME);
                if (!id) return;
                e.preventDefault();
                e.stopPropagation();
                el.classList.remove('is-drop');
                GoalsPage.setGoalGroup(id, el.dataset.openGroup, { toast: true });
            });
        });
    },

    /** Wire goal-card headers, twisties, and prompt-buttons. */
    _attachGoalCardListeners(container) {
        container.querySelectorAll('.goals-card-header').forEach(header => {
            header.addEventListener('click', (e) => {
                if (e.target.closest('.goals-card-collapse')) return;   // twisty owns that click
                GoalsPage.selectNode('goal', header.dataset.goalId);
            });
        });
        container.querySelectorAll('.goals-card-collapse').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                GoalsPage.toggleGoalCollapsed(btn.dataset.collapseGoal);
            });
        });
        this._attachGoalAskListeners(container);

        // Task rows — the shared TaskListUI, wired per goal card so each
        // list's new-task context stays unambiguous.
        container.querySelectorAll('.goals-card[data-goal-id]').forEach(card =>
            TaskListUI.attach(card, this._goalTaskOpts(card.dataset.goalId)));
    },

    /**
     * Goal prompt-buttons: quoted questions that hand the goal to the
     * assistant (grounded in its linked tasks via the goals tools).
     */
    _attachGoalAskListeners(container) {
        container.querySelectorAll('[data-goal-ask]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (typeof AgentUI === 'undefined' || !AgentUI.askWithPrompt) return;
                const title = btn.dataset.goalTitle || 'this goal';
                const prompts = {
                    finish: `Let's finish planning my goal "${title}". Check what is still missing with start_goal_interview and ask me the next question.`,
                    stuck: `I am stuck on my goal "${title}". Ask me what is blocking it, then help me find the smallest next step and schedule it.`,
                    status: `How is my goal "${title}" going? Ground your read in its linked tasks - what got done recently, what is scheduled next, and how long it has been since movement - then tell me plainly.`
                };
                AgentUI.askWithPrompt(prompts[btn.dataset.goalAsk] || prompts.status, { newChat: true });
            });
        });
    },

    /**
     * Goal detail — the FULL goal editor, inline in the pane: title,
     * status, group, target date, description, the AI review block, the
     * task list, linked notes/bookmarks. Every field autosaves in place
     * via GoalsPage -> GoalsApp.
     */
    renderGoalDetail(goalId, pane) {
        GoalsPage._ensureGoalsLoaded();
        GoalsPage._ensureScheduleLoaded();
        const goal = (GoalsApp.goals || []).find(g => g.id === goalId);
        if (!goal) { pane.innerHTML = '<div class="goals-detail-empty">This goal no longer exists.</div>'; return; }
        const status = goal.status || 'not-started';
        const group = (goal.group || '').trim();

        const notesExpanded = this._showLinkedNotes;
        const html = `<div class="goal-editor-main goals-goal-embed">
            <div class="goals-detail-crumbs">
                ${group ? `<span class="breadcrumb-link" data-crumb-group="${this._esc(group)}">${this._esc(group)}</span><span class="breadcrumb-separator">&#8250;</span>` : ''}<span class="breadcrumb-current">Goal</span>
                ${status === 'draft' ? '<span class="goals-draft-chip">draft</span>' : ''}
            </div>
            <input type="text" class="detail-title-input goal-embed-title" value="${this._esc(goal.title)}" placeholder="Goal title..." autocomplete="off">
            <div class="goal-editor-card">
            <div class="detail-section-header">Details</div>
            <div class="goal-detail-row">
                <div class="goal-detail-field">
                    <label for="goal-embed-group">Group</label>
                    <input type="text" id="goal-embed-group" class="goal-embed-group" list="goals-group-options"
                           value="${this._esc(group)}" placeholder="e.g. Work, Health" autocomplete="off">
                </div>
                <div class="goal-detail-field">
                    <label for="goal-embed-target">Target</label>
                    <input type="date" id="goal-embed-target" class="goal-target-input goal-embed-target" value="${goal.targetDate || ''}">
                </div>
                <div class="goal-detail-field goal-detail-field--completed">
                    <label for="goal-embed-completed">Completed</label>
                    <input type="checkbox" id="goal-embed-completed" class="goal-completed-input goal-embed-completed" ${goal.status === 'completed' ? 'checked' : ''}>
                </div>
            </div>
            <div class="goal-description-wrapper">
                <label for="goal-embed-desc">Done means</label>
                <textarea id="goal-embed-desc" class="goal-description-input goal-embed-desc" placeholder="The finish line, measurably.">${this._esc(goal.description || '')}</textarea>
            </div>
            ${goal.why ? `<div class="goals-prose-row"><span class="goals-prose-label">Why</span><p>${this._esc(goal.why)}</p></div>` : ''}
            ${goal.obstacles ? `<div class="goals-prose-row"><span class="goals-prose-label">Obstacles</span><p>${this._esc(goal.obstacles)}</p></div>` : ''}
            </div>
            <div class="ask-prompt-row goals-detail-ask">${this._goalAskButtons(goal)}<button type="button" class="ask-prompt-btn ask-prompt-open" data-ask-open-goal>Ask about this goal…</button></div>
            ${this._goalReviewHtml(goal)}
            ${typeof DecisionsUI !== 'undefined' ? DecisionsUI.renderSection(`goal:${goalId}`) : ''}
            ${TaskListUI.renderSection(LinkManager.getTasksForGoal(goalId), this._goalTaskOpts(goalId))}
            <div class="goal-linked-notes-section">
                <button class="goals-linked-toggle schedule-completed-toggle" data-toggle="goal-linked-notes" aria-expanded="${!!notesExpanded}">
                    <span class="schedule-section-title">Notes &amp; Bookmarks</span>
                    <span class="schedule-completed-arrow">${notesExpanded ? '&#9652;' : '&#9662;'}</span>
                </button>
                <div class="goal-linked-notes-body" style="display:${notesExpanded ? 'block' : 'none'};">
                    ${LinkedItemsUI.renderAll('goals', goalId, {
                        sections: [
                            { targetApp: 'notes', label: 'Notes', buttonLabel: '+ Attach Note' },
                            { targetApp: 'bookmarks', label: 'Bookmarks', buttonLabel: '+ Link Bookmark' }
                        ]
                    })}
                </div>
            </div>
            <div class="goals-detail-actions">
                <button type="button" class="secondary-btn goal-embed-delete">Delete goal</button>
            </div>
        </div>`;

        pane.innerHTML = html;
        this._attachGoalEmbedListeners(pane, goalId);
    },

    /** Wire the embedded goal editor's fields, tasks, and notes to persistence. */
    _attachGoalEmbedListeners(pane, goalId) {
        pane.querySelectorAll('.breadcrumb-link[data-crumb-group]').forEach(btn =>
            btn.addEventListener('click', () => GoalsPage.switchGroup(btn.dataset.crumbGroup)));

        if (typeof DecisionsUI !== 'undefined') {
            DecisionsUI.attachListeners(pane, `goal:${goalId}`,
                () => this.renderGoalDetail(goalId, pane));
        }

        const titleEl = pane.querySelector('.goal-embed-title');
        titleEl.addEventListener('change', () => GoalsPage.setGoalField(goalId, 'title', titleEl.value));

        pane.querySelector('.goal-embed-group').addEventListener('change', (e) =>
            GoalsPage.setGoalGroup(goalId, e.target.value));

        pane.querySelector('.goal-embed-target').addEventListener('change', (e) =>
            GoalsPage.setGoalField(goalId, 'targetDate', e.target.value || null));

        pane.querySelector('.goal-embed-completed').addEventListener('change', (e) =>
            GoalsPage.setGoalStatus(goalId, e.target.checked ? 'completed' : 'not-started'));

        const descEl = pane.querySelector('.goal-embed-desc');
        descEl.addEventListener('change', () => GoalsPage.setGoalField(goalId, 'description', descEl.value.trim()));

        pane.querySelector('.goal-embed-delete')?.addEventListener('click', () => GoalsPage.deleteGoal(goalId));

        // The dashed open-composer door — the goal is already the page's
        // selection, which the goals AgentContext provider emits as
        // CURRENT GOAL, so opening the panel is all it takes.
        pane.querySelector('[data-ask-open-goal]')?.addEventListener('click', () => {
            if (typeof AgentUI !== 'undefined' && AgentUI.openComposer) AgentUI.openComposer();
        });

        this._attachGoalAskListeners(pane);
        this._attachGoalReviewListeners(pane);

        // Tasks list — the shared TaskListUI; edits persist in place and
        // re-render the workspace.
        TaskListUI.attach(pane.querySelector('.task-list-section'), this._goalTaskOpts(goalId));

        // Notes & Bookmarks collapsible
        const toggle = pane.querySelector('[data-toggle="goal-linked-notes"]');
        if (toggle) {
            toggle.addEventListener('click', () => {
                this._showLinkedNotes = !this._showLinkedNotes;
                const body = pane.querySelector('.goal-linked-notes-body');
                const arrow = toggle.querySelector('.schedule-completed-arrow');
                body.style.display = this._showLinkedNotes ? 'block' : 'none';
                arrow.innerHTML = this._showLinkedNotes ? '&#9652;' : '&#9662;';
                toggle.setAttribute('aria-expanded', this._showLinkedNotes);
            });
        }
        const notesBody = pane.querySelector('.goal-linked-notes-body');
        if (notesBody) LinkedItemsUI.attachListeners(notesBody, () => this.renderDetailPane());
    },

    /**
     * Task detail — the FULL schedule editor (repeat, reminders, timer,
     * links, history), embedded in the pane so the Goals page keeps its
     * nav. Back/delete return to the goal the task was opened from
     * (origin 'plan').
     */
    renderTaskDetail(taskId, pane) {
        const item = GoalsPage._scheduleItem(taskId);
        if (!item) { pane.innerHTML = '<div class="goals-detail-empty">This task no longer exists.</div>'; return; }
        // Conversation doors for the task, above the embedded editor — the
        // same pills the Tasks tab's inline detail shows. The editor gets
        // its OWN host div: restoreEditorHome() sweeps every host child
        // back into the schedule editor view, so the ask row must not
        // share the host with the borrowed editor DOM.
        const ask = (typeof AgentUI !== 'undefined' && AgentUI.askWithPrompt)
            ? `<div class="ask-prompt-row goals-task-ask">${ActionsApp.taskAskPillsHtml(item.title, item.id)}</div>`
            : '';
        pane.innerHTML = ask + '<div class="goals-task-editor-host"></div>';
        pane.querySelectorAll('[data-ask]').forEach(b =>
            b.addEventListener('click', () => AgentUI.askWithPrompt(b.dataset.ask, { newChat: true })));
        // Empty composer, this task as context — GoalsPage.selected is what
        // the goals AgentContext provider reads, so nothing to stamp.
        pane.querySelectorAll('[data-ask-open-task]').forEach(b =>
            b.addEventListener('click', () => AgentUI.openComposer()));
        ScheduleApp.init();
        const host = pane.querySelector('.goals-task-editor-host');
        // See ActionsApp._openTaskEditor: the way back to this embedded task
        // detail, for anything that navigates away from it (the source-email
        // card) and offers to return.
        host._reopenTask = (id) => { AppManager.openApp('goals'); GoalsPage.selectNode('task', id); };
        ScheduleApp.embedEditor(host);
        ScheduleApp.openEditor(taskId, { origin: 'plan', embedded: true });
    },

    // ── Weekly goal reviews (shared ReviewRoutines pattern) ──
    //
    // "Review it weekly" creates a routine titled "Goal Review: <title>"
    // (GoalInterview.startWeeklyReview — the same recipe the save_goal tool
    // uses); the goal detail quotes the newest feed post as the goal's
    // living explanation. Title-match linking: renaming the goal orphans
    // the routine, and the page simply offers to start again.

    _attachGoalReviewListeners(container) {
        container.querySelectorAll('[data-goal-review-start]').forEach(btn => {
            btn.addEventListener('click', () => {
                GoalInterview.startWeeklyReview(btn.dataset.goalReviewStart);
                UIUtils.showToast('Weekly reviews scheduled. Adjust anytime in Routines.', 'success');
                GoalsPage.render();
            });
        });
        container.querySelectorAll('[data-goal-review-stop]').forEach(btn => {
            btn.addEventListener('click', () => {
                if (typeof ReviewRoutines === 'undefined') return;
                ReviewRoutines.stop(btn.dataset.goalReviewStop);
                UIUtils.showToast('Weekly reviews stopped. Past reviews stay in the feed.', 'success');
                GoalsPage.render();
            });
        });
        container.querySelectorAll('[data-goal-review-run]').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (typeof PromptFeed === 'undefined' || !PromptFeed.runNow) return;
                btn.disabled = true;
                btn.textContent = 'Running…';
                await PromptFeed.runNow(btn.dataset.goalReviewRun);
                GoalsPage.render();
            });
        });
        container.querySelectorAll('[data-goal-review-open]').forEach(el => {
            const open = () => {
                if (typeof PromptFeed !== 'undefined') PromptFeed.openPost(el.dataset.goalReviewOpen);
            };
            el.addEventListener('click', open);
            el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
        });
    },

    _goalReviewHtml(goal) {
        if (typeof ReviewRoutines === 'undefined' || !goal.title) return '';
        const esc = (s) => this._esc(s);
        const routine = ReviewRoutines.find(GoalInterview.GOAL_REVIEW_PREFIX + goal.title);
        const post = routine ? ReviewRoutines.latestPost(routine.id) : null;
        if (post) {
            const when = (typeof PromptFeed !== 'undefined') ? PromptFeed._timeAgo(post.createdAt) : '';
            return `
                <div class="ai-review-quote goals-review" data-goal-review-open="${esc(post.id)}"
                     role="button" tabindex="0" title="Read the full review">
                    <div class="ai-review-meta">Anjadhe&rsquo;s review &middot; ${esc(when)}</div>
                    <p class="ai-review-text">${esc(ReviewRoutines.excerpt(post, 240))}</p>
                </div>
                <div class="ai-review-foot goals-review-foot">
                    Reviews run ${esc(NotePrompts.scheduleLabel(NotePrompts.config(routine)))}
                    <button type="button" class="quiet-link-btn" data-goal-review-stop="${esc(routine.id)}">Stop</button>
                </div>`;
        }
        if (routine) {
            return `
                <div class="ai-review-foot goals-review-foot">
                    Reviews scheduled ${esc(NotePrompts.scheduleLabel(NotePrompts.config(routine)))} &mdash; the first one posts to your Home feed after its run.
                    <button type="button" class="quiet-link-btn" data-goal-review-run="${esc(routine.id)}">Run it now</button>
                    <button type="button" class="quiet-link-btn" data-goal-review-stop="${esc(routine.id)}">Stop</button>
                </div>`;
        }
        return `
            <div class="ai-review-foot goals-review-foot">
                <button type="button" class="quiet-link-btn" data-goal-review-start="${esc(goal.title)}">Review it weekly</button>
            </div>`;
    },

    /**
     * TaskListUI context for a goal's task list — open in-pane, menu
     * deletes the task, "+ New Task" links to the goal. Row checkboxes are
     * multi-SELECT (bulk delete); check-off lives in the Actions app alone
     * (2026-08-05), so completion here is menu-only.
     */
    _goalTaskOpts(goalId) {
        return {
            onChanged: () => GoalsPage.render(),
            onOpenTask: (taskId) => GoalsPage.selectNode('task', taskId),
            allowDelete: true,
            completeInMenu: true,
            newTask: { links: [{ app: 'goals', id: goalId }] },
            linkExisting: { app: 'goals', id: goalId },
            aiBreakdown: { goalId }
        };
    }
};
