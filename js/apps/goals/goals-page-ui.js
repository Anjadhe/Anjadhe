/**
 * Goals page UI — one pane: the HOME (every active project as one quiet
 * table, a group filter row above it, completed folded beneath), one
 * project (the sheet), or one task (the embedded Schedule editor). The
 * left rail went 2026-09-10 by request — the table says everything it
 * did. Inline edits
 * persist straight through GoalsPage to GoalsApp / ScheduleApp /
 * LinkManager / UpdateStore.
 *
 * Monochrome by design: the only colour on this page is semantic — a
 * target date that has passed (red), a completed pill (green), the
 * accent focus ring the kit gives every input.
 */

const GoalsPageUI = {
    _showMore: false,   // the sheet's folded More block, per window

    _esc(s) { return UIUtils.escapeHtml(s == null ? '' : String(s)); },

    // ── Colour as data (2026-09-10, by request — the Portfolio / Ticker
    // recipe): ONE stable hue per GROUP, hashed into Portfolio's palette
    // with the News collision rule (two groups never share a hue while
    // there are free slots), carried as an inline --gh on rows, pills,
    // chips and the sheet. It colours the progress fill, the group chip
    // and the sheet's group crumb — data, never chrome; titles stay ink.
    GROUP_HUES: ['#4F6BED', '#0EA5E9', '#14B8A6', '#65A30D', '#F59E0B', '#F97316', '#EF4444', '#EC4899', '#8B5CF6', '#6366F1', '#0891B2', '#B45309'],
    groupHue(group) {
        const key = String(group || '').trim().toLowerCase();
        if (!key || group === GoalsApp.UNGROUPED) return '';
        if (!this._hueMap) this._hueMap = this._buildHueMap();
        return this._hueMap.get(key) || this.GROUP_HUES[this._hueSlot(key)];
    },
    _hueSlot(key) {
        let h = 0;
        for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
        return h % this.GROUP_HUES.length;
    },
    _buildHueMap() {
        const map = new Map();
        const taken = new Set();
        const n = this.GROUP_HUES.length;
        for (const g of GoalsApp.getGroups()) {
            if (g === GoalsApp.UNGROUPED) continue;
            const key = g.trim().toLowerCase();
            if (!key || map.has(key)) continue;
            let slot = this._hueSlot(key);
            if (taken.size < n) { while (taken.has(slot)) slot = (slot + 1) % n; }
            taken.add(slot);
            map.set(key, this.GROUP_HUES[slot]);
        }
        return map;
    },
    _hueStyle(group) {
        const h = this.groupHue(group);
        return h ? ` style="--gh:${h}"` : '';
    },

    // ===================================================================
    //  WORKSPACE SHELL
    // ===================================================================

    renderWorkspace() {
        this._hueMap = null;
        this.renderBreadcrumb();
        this._populateGroupOptions();
        this.renderDetailPane();
    },

    /**
     * No breadcrumb TRAIL in the header: the sheet's own eyebrow links back
     * to the home (and to its group), so a chrome trail would repeat what
     * the page already says. The app title itself stays.
     */
    renderBreadcrumb() {
        Breadcrumb.render('goals-breadcrumb', [{ label: 'Projects' }]);
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
        // The pane may currently host the embedded schedule editor — flush
        // it and hand its DOM back BEFORE any innerHTML write, or it would
        // be destroyed. The project sheet's own pending edits go first.
        this._flushGoalEdits({ final: true });
        this._goalEditor = null;
        if (typeof SaveStatus !== 'undefined') SaveStatus.unregister('goal');
        ScheduleApp.detachEditor();
        const sel = GoalsPage.selected;
        if (!sel) { this.renderHome(pane); return; }
        if (sel.type === 'goal') this.renderGoalDetail(sel.id, pane);
        else if (sel.type === 'task') this.renderTaskDetail(sel.id, pane);
    },

    /**
     * ONE creation door: the interview pill, with "add one by hand" as its
     * quiet second. Scoped to the group in view when there is one.
     */
    _newGoalAskRow(group) {
        const scope = group && group !== GoalsApp.UNGROUPED ? ` data-ask-group="${this._esc(group)}"` : '';
        return `<div class="ask-prompt-row goals-ask-row">
            <button type="button" class="ask-prompt-btn primary" data-ask-new-goal${scope}>&ldquo;Help me plan a new project&rdquo;</button>
            <button type="button" class="quiet-link-btn goals-manual-add" data-new-goal${scope}>or add one by hand</button>
        </div>`;
    },

    // ── Facts for the home (pure arithmetic over the blobs, ONE read each) ──

    _todayStr() { return LinkManager._todayStr(); },

    /**
     * Per-goal task facts in one pass: total / completed, the next open
     * step (earliest dated one-time task, else a repeating one, else an
     * undated one), and the most recent completion date.
     */
    _taskIndex(goals) {
        const wanted = new Set(goals.map(g => g.id));
        const byId = new Map(((StorageManager.get('schedule')?.scheduleItems) || []).map(s => [s.id, s]));
        const today = this._todayStr();
        const idx = new Map();
        for (const id of wanted) idx.set(id, { total: 0, completed: 0, open: [], lastDone: null });
        for (const link of LinkManager.loadLinks()) {
            let goalId, taskId;
            if (link.sourceApp === 'goals' && link.targetApp === 'schedule') { goalId = link.sourceId; taskId = link.targetId; }
            else if (link.sourceApp === 'schedule' && link.targetApp === 'goals') { goalId = link.targetId; taskId = link.sourceId; }
            else continue;
            if (!wanted.has(goalId)) continue;
            const t = byId.get(taskId);
            if (!t) continue;
            const f = idx.get(goalId);
            f.total++;
            if (LinkManager._taskResolved(t, today)) f.completed++;
            else f.open.push(t);
            if (t.lastCompletedDate && (!f.lastDone || t.lastCompletedDate > f.lastDone)) f.lastDone = t.lastCompletedDate;
        }
        for (const f of idx.values()) {
            const repeating = (t) => t.repeat && t.repeat !== 'none';
            const dated = f.open.filter(t => !repeating(t) && t.scheduledDate).sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
            f.next = dated[0] || f.open.find(repeating) || f.open.find(t => !repeating(t)) || null;
            f.openCount = f.open.length;
            delete f.open;
        }
        return idx;
    },

    /** The row facts for one goal: progress, next step, last update, target, quiet. */
    _factsFor(goal, idx, latestUpdates, today) {
        const f = idx.get(goal.id) || { total: 0, completed: 0, next: null, lastDone: null, openCount: 0 };
        const upd = latestUpdates.get(`goal:${goal.id}`) || null;
        const target = this._parseTarget(goal.targetDate);
        const targetDays = target ? Math.round((target - today) / 86400000) : null;
        // Movement = the newest of: an update, a task completion, the
        // project's own creation. Quiet = nothing for QUIET_DAYS.
        const stamps = [upd?.createdAt, f.lastDone ? `${f.lastDone}T12:00:00` : null, goal.createdAt].filter(Boolean)
            .map(s => Date.parse(s) || 0);
        const lastMove = stamps.length ? Math.max(...stamps) : 0;
        const quietDays = lastMove ? UpdateStore.daysSince(new Date(lastMove).toISOString(), today) : null;
        return {
            ...f,
            update: upd,
            target,
            targetDays,
            targetOver: targetDays !== null && targetDays < 0,
            quietDays,
            quiet: quietDays !== null && quietDays >= UpdateStore.QUIET_DAYS && goal.status !== 'draft'
        };
    },

    /**
     * The home — every active project as one table (or one group's), the
     * attention briefing above it, completed projects folded beneath, the
     * creation doors at the foot. A fresh install opens as a conversation.
     */
    renderHome(pane) {
        GoalsPage._ensureGoalsLoaded();
        if (typeof UpdateStore !== 'undefined') UpdateStore.init();
        const group = GoalsPage.currentGroup;
        const all = GoalsApp.goals || [];
        const scoped = group ? GoalsApp.getGoalsInGroup(group) : all;

        if (all.length === 0) {
            pane.innerHTML = `<div class="goals-overview goals-blank">
                <div class="goals-detail-eyebrow"><span>Projects</span></div>
                <h2 class="goals-detail-title">Start a project</h2>
                <p class="goals-blank-lede">A project here is an outcome with a finish line, a date, and
                the first steps on your calendar. The assistant builds it with you: a few questions,
                then a task timeline you approve.</p>
                ${this._newGoalAskRow(null)}
            </div>`;
            this._wireHome(pane);
            return;
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const idx = this._taskIndex(scoped);
        const latest = (typeof UpdateStore !== 'undefined')
            ? UpdateStore.latestForKeys(scoped.map(g => `goal:${g.id}`)) : new Map();
        const facts = new Map(scoped.map(g => [g.id, this._factsFor(g, idx, latest, today)]));

        const active = scoped.filter(g => g.status !== 'completed');
        const done = scoped.filter(g => g.status === 'completed')
            .sort((a, b) => (Date.parse(b.completedAt || b.modifiedAt || 0) || 0) - (Date.parse(a.completedAt || a.modifiedAt || 0) || 0));
        // Soonest target first; undated after; drafts last.
        active.sort((a, b) => {
            const fa = facts.get(a.id), fb = facts.get(b.id);
            const da = a.status === 'draft' ? 2 : (fa.target ? 0 : 1);
            const db = b.status === 'draft' ? 2 : (fb.target ? 0 : 1);
            if (da !== db) return da - db;
            if (fa.target && fb.target) return fa.target - fb.target;
            return (a.title || '').localeCompare(b.title || '');
        });

        const label = group ? (group === GoalsApp.UNGROUPED ? 'No group' : group) : 'All projects';
        const sub = `${active.length} active${done.length ? ` &middot; ${done.length} completed` : ''}`;
        let html = `<div class="goals-overview goals-home">
            <div class="goals-detail-eyebrow">${group ? `<button type="button" class="goals-crumb-btn" data-open-all>All projects</button><span class="breadcrumb-separator">&#8250;</span>` : ''}<span>${group ? this._esc(label) : 'Projects'}</span></div>
            <div class="goals-head">
                <h2 class="goals-detail-title"${group && group !== GoalsApp.UNGROUPED ? ' data-rename-group title="Click to rename"' : ''}>${this._esc(label)}</h2>
                <span class="goals-overview-sub">${sub}</span>
                ${group && group !== GoalsApp.UNGROUPED ? `<span class="goals-group-actions">
                    <button type="button" class="quiet-link-btn" data-rename-group>Rename</button>
                    <button type="button" class="quiet-link-btn" data-remove-group>Remove group</button>
                </span>` : ''}
            </div>`;

        html += this._groupFilterHtml(group);
        html += this._attnBriefing(active, facts, today);

        if (active.length) {
            html += this._tableHtml(active, facts, { showGroup: !group, today });
        } else {
            html += `<div class="goals-empty-line">${done.length ? 'Every project here is completed.' : 'No projects yet.'}</div>`;
        }

        if (done.length) {
            const open = GoalsPage.showCompleted;
            html += `<div class="goals-completed-fold">
                <button type="button" class="goals-fold-toggle schedule-completed-toggle" data-toggle-completed aria-expanded="${open}">
                    <span class="schedule-section-title">Completed (${done.length})</span>
                    <span class="schedule-completed-arrow">${open ? '&#9652;' : '&#9662;'}</span>
                </button>
                ${open ? this._tableHtml(done, facts, { showGroup: !group, completed: true, today }) : ''}
            </div>`;
        }

        html += this._newGoalAskRow(group);
        html += '</div>';

        pane.innerHTML = html;
        this._wireHome(pane);
    },

    /**
     * The group filter row (the rail's one job, 2026-09-10): "All" then a
     * pill per group with its active count. Rendered only when there is
     * more than one group to choose between. The chip on a row is the
     * same door.
     */
    _groupFilterHtml(current) {
        const groups = GoalsApp.getGroups();
        if (groups.length < 2) return '';
        const all = GoalsApp.goals || [];
        const activeIn = (g) => GoalsApp.getGoalsInGroup(g).filter(x => x.status !== 'completed').length;
        const pill = (value, label, n, on) =>
            `<button type="button" class="goals-filter-pill${on ? ' is-active' : ''}" data-filter-group="${this._esc(value)}"${this._hueStyle(value)}>${value && this.groupHue(value) ? '<span class="goals-hue-dot" aria-hidden="true"></span>' : ''}${this._esc(label)}${n ? ` <span class="goals-filter-count">${n}</span>` : ''}</button>`;
        let html = '<div class="goals-filter-row" role="tablist">';
        html += pill('', 'All', all.filter(g => g.status !== 'completed').length, !current);
        for (const g of groups) html += pill(g, g === GoalsApp.UNGROUPED ? 'No group' : g, activeIn(g), current === g);
        html += '</div>';
        return html;
    },

    /**
     * The table: one row per project — title (+ draft / group chips),
     * progress track + n/m, next open step, last update, target. Rows are
     * doors to the sheet and drag onto group rows. Completed rows swap the
     * next/target columns for the completion date.
     */
    _tableHtml(goals, facts, { showGroup, completed = false, today }) {
        let html = `<div class="goals-table${completed ? ' is-completed' : ''}" role="table">
            <div class="goals-tr goals-th" role="row">
                <span>Project</span><span>Progress</span><span>${completed ? 'Completed' : 'Next step'}</span><span>Last update</span><span>${completed ? '' : 'Target'}</span>
            </div>`;
        for (const g of goals) {
            const f = facts.get(g.id);
            const grp = GoalsApp.groupOf(g);
            const progress = f.total
                ? `<span class="goals-track" style="--gp:${(f.completed / f.total).toFixed(3)}" aria-hidden="true"></span><span class="goals-td-count">${f.completed}/${f.total}</span>`
                : `<span class="goals-td-empty">no tasks</span>`;
            let next;
            if (completed) {
                const at = g.completedAt || g.modifiedAt;
                next = at ? `<span class="goals-td-sub">${this._esc(this._fmtTarget(new Date(at), today))}</span>` : '';
            } else if (f.next) {
                const when = (typeof TaskListUI !== 'undefined') ? TaskListUI.dateLabel(f.next) : '';
                next = `<span class="goals-td-nexttitle">${this._esc(f.next.title)}</span>${when ? `<span class="goals-td-sub">${when}</span>` : ''}`;
            } else {
                next = `<span class="goals-td-empty">${g.status === 'draft' ? 'Finish planning' : 'No next step'}</span>`;
            }
            const updated = f.update
                ? `<span class="goals-td-ago${f.update.source === 'ai' ? ' is-ai' : ''}" title="${this._esc(new Date(f.update.createdAt).toLocaleString())}">${this._esc(UpdateStore.ago(f.update.createdAt))}</span>`
                : `<span class="goals-td-empty">&mdash;</span>`;
            let target = '';
            if (!completed) {
                target = f.target
                    ? `<span class="goals-td-target${f.targetOver ? ' is-over' : (f.targetDays <= 7 ? ' is-soon' : '')}" title="${this._esc(this._fmtTarget(f.target, today, true))}">${f.targetOver ? 'passed' : this._relDays(f.target, today)}</span>`
                    : `<span class="goals-td-empty">no date</span>`;
            }
            html += `<button type="button" class="goals-tr${completed ? ' completed' : ''}${f.quiet && !completed ? ' is-quiet' : ''}" role="row" data-open-goal="${g.id}"${this._hueStyle(grp)}>
                <span class="goals-td-title">
                    <span class="goals-td-name">${this._esc(g.title)}</span>
                    ${g.status === 'draft' ? '<span class="goals-draft-chip">draft</span>' : ''}
                    ${showGroup && grp !== GoalsApp.UNGROUPED ? `<span class="goals-group-chip" data-filter-group="${this._esc(grp)}" title="Only ${this._esc(grp)}">${this._esc(grp)}</span>` : ''}
                </span>
                <span class="goals-td-progress">${progress}</span>
                <span class="goals-td-next">${next}</span>
                <span class="goals-td-updated">${updated}</span>
                <span class="goals-td-targetcell">${target}</span>
            </button>`;
        }
        html += '</div>';
        return html;
    },

    /**
     * Needs attention — above the table, the Email AI Overview idiom:
     * hairline rows, a when-gutter, a note. Target passed or due within a
     * week, no open next step, quiet for QUIET_DAYS (no update, no task
     * completed). Pure arithmetic; the weekly AI review owns judgment.
     * Nothing to say → nothing renders.
     */
    _attnBriefing(goals, facts, today) {
        const rows = [];
        for (const g of goals) {
            if (g.status === 'draft') continue;
            const f = facts.get(g.id);
            if (f.target && f.targetDays <= 7) {
                rows.push({ g, when: this._fmtTarget(f.target, today), note: f.targetOver ? 'target passed' : (f.targetDays === 0 ? 'due today' : `due ${this._relDays(f.target, today)}`), over: f.targetOver, order: f.targetOver ? 0 : 1 });
            } else if (f.total > 0 && f.openCount === 0) {
                rows.push({ g, when: '', note: 'no open next step', order: 2 });
            } else if (f.total === 0) {
                rows.push({ g, when: '', note: 'no tasks yet', order: 3 });
            } else if (f.quiet) {
                rows.push({ g, when: '', note: `quiet for ${f.quietDays} days`, order: 4 });
            }
        }
        if (!rows.length) return '';
        rows.sort((a, b) => a.order - b.order);
        let html = '<div class="goals-attn"><div class="goals-attn-head">Needs attention</div>';
        for (const r of rows) {
            const tone = r.over ? ' is-over' : (r.order === 1 || r.order === 4 ? ' is-soon' : '');
            html += `<button type="button" class="goals-attn-row" data-open-goal="${r.g.id}"${this._hueStyle(GoalsApp.groupOf(r.g))}>
                <span class="goals-attn-when${tone}">${this._esc(r.when)}</span>
                <span class="goals-attn-title"><span class="goals-hue-dot" aria-hidden="true"></span>${this._esc(r.g.title)}</span>
                <span class="goals-attn-note${tone}">${this._esc(r.note)}</span>
            </button>`;
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

    _fmtTarget(d, today, withYear = false) {
        const opts = { month: 'short', day: 'numeric' };
        if (withYear || d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
        return d.toLocaleDateString('en-US', opts);
    },

    _relDays(d, today) {
        const days = Math.round((d - today) / 86400000);
        if (days < 0) return `${-days} day${days === -1 ? '' : 's'} ago`;
        if (days === 0) return 'today';
        if (days === 1) return 'tomorrow';
        if (days < 30) return `in ${days} days`;
        if (days < 90) return `in ${Math.round(days / 7)} weeks`;
        return `in ${Math.round(days / 30)} months`;
    },

    /** Wire the home's rows, fold, crumb, creation doors and drags. */
    _wireHome(pane) {
        pane.querySelectorAll('[data-open-goal]').forEach(el =>
            el.addEventListener('click', (e) => {
                if (e.target.closest('[data-filter-group]')) return;   // the chip owns that click
                GoalsPage.selectNode('goal', el.dataset.openGoal);
            }));
        pane.querySelector('[data-open-all]')
            ?.addEventListener('click', () => GoalsPage.goToAllGroups());
        pane.querySelector('[data-toggle-completed]')
            ?.addEventListener('click', () => GoalsPage.toggleShowCompleted());
        pane.querySelectorAll('[data-ask-new-goal]').forEach(btn =>
            btn.addEventListener('click', () => GoalsPage.askNewGoal(btn.dataset.askGroup || null)));
        pane.querySelectorAll('[data-new-goal]').forEach(btn =>
            btn.addEventListener('click', () => GoalsPage.createGoalInline(btn.dataset.askGroup || null)));
        pane.querySelectorAll('[data-filter-group]').forEach(btn =>
            btn.addEventListener('click', () => GoalsPage.switchGroup(btn.dataset.filterGroup || null)));
        // Group rename / remove — only on a group's own filtered page. Rename
        // swaps the title for an input in place: Enter commits, Esc cancels,
        // blur commits (the sheet's own quiet-write manner).
        const group = GoalsPage.currentGroup;
        pane.querySelectorAll('[data-rename-group]').forEach(el =>
            el.addEventListener('click', () => this._beginGroupRename(pane, group)));
        pane.querySelector('[data-remove-group]')
            ?.addEventListener('click', () => GoalsPage.removeGroup(group));
    },

    _beginGroupRename(pane, group) {
        const h2 = pane.querySelector('.goals-detail-title');
        if (!h2 || !group || pane.querySelector('.goals-group-rename-input')) return;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'goals-group-rename-input';
        input.value = group;
        input.setAttribute('list', 'goals-group-options');
        input.setAttribute('aria-label', 'Group name');
        h2.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        const commit = () => {
            if (done) return; done = true;
            const next = input.value.trim();
            if (!next || next === group) { GoalsPage.render(); return; }
            GoalsPage.renameGroup(group, next);
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { done = true; GoalsPage.render(); }
        });
        input.addEventListener('blur', commit);
    },

    /**
     * The quoted prompt-buttons for one goal. A draft's door is finishing
     * the interview; a live goal's doors are the status conversation —
     * whose read lands in the project's Updates log (post_update).
     */
    _goalAskButtons(goal) {
        if (goal.status === 'draft') {
            return `<button type="button" class="ask-prompt-btn primary" data-goal-ask="finish" data-goal-title="${this._esc(goal.title)}">&ldquo;Finish planning it&rdquo;</button>`;
        }
        if (goal.status === 'completed') return '';
        return `<button type="button" class="ask-prompt-btn" data-goal-ask="status" data-goal-title="${this._esc(goal.title)}">&ldquo;How is this going?&rdquo;</button>
            <button type="button" class="ask-prompt-btn" data-goal-ask="stuck" data-goal-title="${this._esc(goal.title)}">&ldquo;I&rsquo;m stuck&rdquo;</button>`;
    },

    /** The status prompt — shared by the pill and the Updates check-in door. */
    _statusPrompt(title) {
        return `How is my project "${title}" going? Ground your read in its linked tasks and its updates — what got done recently, what is scheduled next, how long since movement, how long since the last update — then tell me plainly, naming any risk to the target date. Finish by posting your read as an update on the project with post_update (kind "review"; kind "risk" if something threatens it).`;
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
                const title = btn.dataset.goalTitle || 'this project';
                const prompts = {
                    finish: `Let's finish planning my project "${title}". Check what is still missing with start_goal_interview and ask me the next question.`,
                    stuck: `I am stuck on my project "${title}". Ask me what is blocking it, then help me find the smallest next step and schedule it.`,
                    status: this._statusPrompt(title)
                };
                AgentUI.askWithPrompt(prompts[btn.dataset.goalAsk] || prompts.status, { newChat: true });
            });
        });
    },

    /**
     * Goal detail — the sheet, inline in the pane, ordered around the
     * work: head (crumb eyebrow, status pill, save state) → title → the
     * facts line (target, progress, last update) → ask pills → Tasks →
     * Updates → Details (what done means, group, target, why, obstacles)
     * → a folded More (review schedule, Decisions, Notes & Bookmarks,
     * Delete). Every field autosaves in place via GoalsPage → GoalsApp.
     */
    renderGoalDetail(goalId, pane) {
        GoalsPage._ensureGoalsLoaded();
        GoalsPage._ensureScheduleLoaded();
        if (typeof UpdateStore !== 'undefined') UpdateStore.init();
        const goal = (GoalsApp.goals || []).find(g => g.id === goalId);
        if (!goal) { pane.innerHTML = '<div class="goals-detail-empty">This project no longer exists.</div>'; return; }
        const status = goal.status || 'not-started';
        const completed = status === 'completed';
        const group = (goal.group || '').trim();

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tasks = LinkManager.getTasksForGoal(goalId);
        const count = LinkManager.getTaskCountForGoal(goalId, tasks);
        const target = this._parseTarget(goal.targetDate);
        const targetOver = target && target < today;
        const targetSoon = target && !targetOver && (target - today) / 86400000 <= 7;
        const latestUpd = (typeof UpdateStore !== 'undefined') ? UpdateStore.latestFor(`goal:${goalId}`) : null;

        const statusPill = completed
            ? `<span class="goals-status-pill is-done" title="${goal.completedAt ? this._esc(new Date(goal.completedAt).toLocaleString()) : ''}">&#10003; Completed${goal.completedAt ? ` &middot; ${this._esc(this._fmtTarget(new Date(goal.completedAt), today))}` : ''}</span>
               <button type="button" class="quiet-link-btn goals-reopen-btn" data-reopen-goal>Reopen</button>`
            : `<button type="button" class="goals-status-pill" data-mark-complete>Mark complete</button>`;

        const meta = [];
        if (target) meta.push(`<span class="goals-meta-target${targetOver ? ' is-over' : (targetSoon ? ' is-soon' : '')}" title="Target date">${this._esc(this._fmtTarget(target, today))} &middot; ${targetOver ? 'passed' : this._relDays(target, today)}</span>`);
        else if (!completed) meta.push(`<span class="goals-meta-empty">No target date</span>`);
        if (count.total) meta.push(`<span class="goals-meta-progress"><span class="goals-track" style="--gp:${(count.completed / count.total).toFixed(3)}" aria-hidden="true"></span>${count.completed}/${count.total} done</span>`);
        meta.push(`<span class="goals-meta-updated">${latestUpd ? `Last update ${this._esc(UpdateStore.ago(latestUpd.createdAt))}` : 'No updates yet'}</span>`);

        const askPills = `${this._goalAskButtons(goal)}<button type="button" class="ask-prompt-btn ask-prompt-open" data-ask-open-goal>Ask about this project…</button>`;

        const html = `<div class="goal-editor-main goals-goal-embed${completed ? ' is-completed' : ''}"${this._hueStyle(group)}>
            <div class="goals-sheet-head">
                <div class="goals-detail-crumbs">
                    <span class="breadcrumb-link" data-crumb-all>All projects</span><span class="breadcrumb-separator">&#8250;</span>${group ? `<span class="breadcrumb-link" data-crumb-group="${this._esc(group)}">${this._esc(group)}</span><span class="breadcrumb-separator">&#8250;</span>` : ''}<span class="breadcrumb-current">Project</span>
                    ${status === 'draft' ? '<span class="goals-draft-chip">draft</span>' : ''}
                </div>
                <div class="goals-sheet-head-right">
                    ${typeof SaveStatus !== 'undefined' ? SaveStatus.html('goal-embed-save-status', 'saved', 'goals-save-status is-quiet') : ''}
                    ${statusPill}
                </div>
            </div>
            <input type="text" class="detail-title-input goal-embed-title" value="${this._esc(goal.title)}" placeholder="Project title..." autocomplete="off">
            <div class="goals-sheet-meta">${meta.join('<span class="goals-meta-sep" aria-hidden="true"></span>')}</div>
            <div class="ask-prompt-row goals-detail-ask">${askPills}</div>
            ${TaskListUI.renderSection(tasks, this._goalTaskOpts(goalId))}
            <div class="goals-updates-host"></div>
            <div class="goal-editor-card">
            <div class="detail-section-header">Details</div>
            <div class="goal-description-wrapper">
                <label for="goal-embed-desc">Done means</label>
                <textarea id="goal-embed-desc" class="goal-description-input goal-embed-desc" placeholder="The finish line, measurably.">${this._esc(goal.description || '')}</textarea>
            </div>
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
            </div>
            ${goal.why ? `<div class="goals-prose-row"><span class="goals-prose-label">Why</span><p>${this._esc(goal.why)}</p></div>` : ''}
            ${goal.obstacles ? `<div class="goals-prose-row"><span class="goals-prose-label">Obstacles</span><p>${this._esc(goal.obstacles)}</p></div>` : ''}
            </div>
            <div class="goals-more">
                <button type="button" class="goals-more-toggle schedule-completed-toggle" data-toggle-more aria-expanded="${!!this._showMore}">
                    <span class="schedule-section-title">More</span>
                    <span class="goals-more-hint">${this._moreHint(goal, goalId)}</span>
                    <span class="schedule-completed-arrow">${this._showMore ? '&#9652;' : '&#9662;'}</span>
                </button>
                <div class="goals-more-body"${this._showMore ? '' : ' hidden'}>
                    <div class="goals-more-block goals-review-block">
                        <div class="detail-section-header">Weekly review</div>
                        ${this._goalReviewHtml(goal)}
                    </div>
                    ${typeof DecisionsUI !== 'undefined' ? DecisionsUI.renderSection(`goal:${goalId}`) : ''}
                    <div class="goal-linked-notes-section">
                        <div class="detail-section-header">Notes &amp; Bookmarks</div>
                        <div class="goal-linked-notes-body">
                            ${LinkedItemsUI.renderAll('goals', goalId, {
                                sections: [
                                    { targetApp: 'notes', label: 'Notes', buttonLabel: '+ Attach Note' },
                                    { targetApp: 'bookmarks', label: 'Bookmarks', buttonLabel: '+ Link Bookmark' }
                                ]
                            })}
                        </div>
                    </div>
                    <div class="goals-detail-actions">
                        <button type="button" class="secondary-btn goal-embed-delete">Delete project</button>
                    </div>
                </div>
            </div>
        </div>`;

        pane.innerHTML = html;
        this._attachGoalEmbedListeners(pane, goalId);
    },

    /** The folded More row's one-line summary of what is inside. */
    _moreHint(goal, goalId) {
        const bits = [];
        try {
            const routine = GoalInterview.findReview(goal.title);
            bits.push(routine ? 'reviewed weekly' : 'no weekly review');
        } catch (_) {}
        try {
            const n = (typeof DecisionStore !== 'undefined') ? DecisionStore.listFor(`goal:${goalId}`).length : 0;
            if (n) bits.push(`${n} decision${n === 1 ? '' : 's'}`);
        } catch (_) {}
        try {
            const n = LinkManager.getLinksForApp('goals', goalId, 'notes').length
                + LinkManager.getLinksForApp('goals', goalId, 'bookmarks').length;
            if (n) bits.push(`${n} linked`);
        } catch (_) {}
        return this._esc(bits.join(' · '));
    },

    /**
     * Write the project sheet's typed-but-uncommitted title / description
     * / group now, WITHOUT re-rendering (the caret stays where it is).
     * { ok:false } only for a blank title — the last real title stands.
     * Called by the debounce, by `change`, by every detail re-render and
     * by SaveStatus when the user leaves.
     */
    _flushGoalEdits({ final = false } = {}) {
        const ed = this._goalEditor;
        if (!ed) return { ok: true };
        if (ed.timer) { clearTimeout(ed.timer); ed.timer = null; }
        if (ed.dirty && ed.titleEl.isConnected) {
            const title = ed.titleEl.value.trim();
            if (!title) { SaveStatus.mark('goal-embed-save-status', 'error', 'needs a title'); return { ok: false, reason: 'it needs a title' }; }
            // Quiet writes carry no routine rename: a title typed letter by
            // letter would rename the review routine on every debounce.
            GoalsPage.setGoalField(ed.goalId, 'title', title, { render: false, syncRename: false });
            GoalsPage.setGoalField(ed.goalId, 'description', ed.descEl.value.trim(), { render: false });
            GoalsPage.setGoalGroup(ed.goalId, ed.groupEl.value, { render: false });
            ed.dirty = false;
            SaveStatus.mark('goal-embed-save-status', 'saved');
        }
        // The FINAL write (blur, leaving, a pane rebuild) settles the
        // rename once, from the title the sheet opened with.
        if (final && ed.titleEl.isConnected) {
            const title = ed.titleEl.value.trim();
            if (title && title !== ed.titleAtOpen) {
                GoalsPage.syncGoalRename(ed.titleAtOpen, title);
                ed.titleAtOpen = title;
            }
        }
        return { ok: true };
    },

    /** Wire the embedded goal editor's fields, tasks, updates and notes to persistence. */
    _attachGoalEmbedListeners(pane, goalId) {
        const goal = (GoalsApp.goals || []).find(g => g.id === goalId);
        pane.querySelector('[data-crumb-all]')?.addEventListener('click', () => GoalsPage.goToAllGroups());
        pane.querySelectorAll('.breadcrumb-link[data-crumb-group]').forEach(btn =>
            btn.addEventListener('click', () => GoalsPage.switchGroup(btn.dataset.crumbGroup)));

        pane.querySelector('[data-mark-complete]')?.addEventListener('click', () => GoalsPage.markComplete(goalId));
        pane.querySelector('[data-reopen-goal]')?.addEventListener('click', () => GoalsPage.reopenGoal(goalId));

        // Updates: the running log. The check-in door is the same status
        // conversation the pill opens — one prompt, two doors.
        const updatesHost = pane.querySelector('.goals-updates-host');
        if (updatesHost && typeof UpdatesUI !== 'undefined' && goal) {
            UpdatesUI.mount(updatesHost, `goal:${goalId}`, {
                since: goal.createdAt,
                checkIn: goal.status === 'completed' ? null : this._statusPrompt(goal.title),
                onChanged: () => {
                    // The facts line's "Last update" follows the log.
                    const latest = UpdateStore.latestFor(`goal:${goalId}`);
                    const el = pane.querySelector('.goals-meta-updated');
                    if (el) el.textContent = latest ? `Last update ${UpdateStore.ago(latest.createdAt)}` : 'No updates yet';
                }
            });
        }

        if (typeof DecisionsUI !== 'undefined') {
            DecisionsUI.attachListeners(pane, `goal:${goalId}`,
                () => this.renderGoalDetail(goalId, pane));
        }

        // Text fields auto-save while typing (debounced, quiet — no
        // re-render under the caret); `change` (blur / Enter) is the full
        // commit that repaints the rail. The head's indicator reads
        // Unsaved → Saved across both (SaveStatus, 2026-09-10).
        const titleEl = pane.querySelector('.goal-embed-title');
        const descEl = pane.querySelector('.goal-embed-desc');
        const groupEl = pane.querySelector('.goal-embed-group');
        this._goalEditor = { goalId, titleEl, descEl, groupEl, dirty: false, timer: null, titleAtOpen: titleEl.value.trim() };
        const onType = () => {
            const ed = this._goalEditor;
            if (!ed || ed.goalId !== goalId) return;
            ed.dirty = true;
            SaveStatus.mark('goal-embed-save-status', 'dirty');
            if (ed.timer) clearTimeout(ed.timer);
            ed.timer = setTimeout(() => { ed.timer = null; this._flushGoalEdits(); }, 800);
        };
        [titleEl, descEl, groupEl].forEach(el => el.addEventListener('input', onType));
        if (typeof SaveStatus !== 'undefined') {
            SaveStatus.register('goal', {
                isDirty: () => !!this._goalEditor?.dirty,
                flush: () => this._flushGoalEdits({ final: true }),
                label: () => {
                    const t = this._goalEditor?.titleEl?.value.trim();
                    return t ? `Project "${t}"` : 'This project';
                },
                reopen: () => { AppManager.openApp('goals'); setTimeout(() => GoalsPage.selectNode('goal', goalId), 0); }
            });
        }

        titleEl.addEventListener('change', () => { this._flushGoalEdits({ final: true }); GoalsPage.setGoalField(goalId, 'title', titleEl.value); });

        groupEl.addEventListener('change', (e) => { this._flushGoalEdits({ final: true }); GoalsPage.setGoalGroup(goalId, e.target.value); });

        pane.querySelector('.goal-embed-target').addEventListener('change', (e) =>
            GoalsPage.setGoalField(goalId, 'targetDate', e.target.value || null));

        descEl.addEventListener('change', () => { this._flushGoalEdits({ final: true }); GoalsPage.setGoalField(goalId, 'description', descEl.value.trim()); });

        pane.querySelector('.goal-embed-delete')?.addEventListener('click', () => GoalsPage.deleteGoal(goalId));

        // The dashed open-composer door — the project is already the page's
        // selection, which the goals AgentContext provider emits as
        // CURRENT PROJECT, so opening the panel is all it takes.
        pane.querySelector('[data-ask-open-goal]')?.addEventListener('click', () => {
            if (typeof AgentUI !== 'undefined' && AgentUI.openComposer) AgentUI.openComposer();
        });

        this._attachGoalAskListeners(pane);
        this._attachGoalReviewListeners(pane);

        // Tasks list — the shared TaskListUI; edits persist in place and
        // re-render the workspace.
        TaskListUI.attach(pane.querySelector('.task-list-section'), this._goalTaskOpts(goalId));

        // The folded More block
        const toggle = pane.querySelector('[data-toggle-more]');
        if (toggle) {
            toggle.addEventListener('click', () => {
                this._showMore = !this._showMore;
                const body = pane.querySelector('.goals-more-body');
                const arrow = toggle.querySelector('.schedule-completed-arrow');
                body.hidden = !this._showMore;
                arrow.innerHTML = this._showMore ? '&#9652;' : '&#9662;';
                toggle.setAttribute('aria-expanded', this._showMore);
            });
        }
        const notesBody = pane.querySelector('.goal-linked-notes-body');
        if (notesBody) LinkedItemsUI.attachListeners(notesBody, () => this.renderDetailPane());
    },

    /**
     * Task detail — the FULL schedule editor (repeat, reminders, timer,
     * links, updates, history), embedded in the pane so the Goals page
     * keeps its nav. Back/delete return to the goal the task was opened
     * from (origin 'plan').
     */
    renderTaskDetail(taskId, pane) {
        const item = GoalsPage._scheduleItem(taskId);
        if (!item) { pane.innerHTML = '<div class="goals-detail-empty">This task no longer exists.</div>'; return; }
        // The editor arrives as one sheet with its own prompt pills and
        // breadcrumb; the host div only positions it (restoreEditorHome()
        // sweeps every host child back into the schedule editor view).
        pane.innerHTML = '<div class="goals-task-editor-host"></div>';
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
    // "Review it weekly" creates a routine titled "Project Review: <title>"
    // (GoalInterview.startWeeklyReview — the same recipe the save_goal tool
    // uses). Its posts go to the Home feed AND are mirrored into the
    // project's Updates log (GoalInterview.mirrorReviewPost), so the sheet
    // no longer quotes the newest post separately — the log is the quote.

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
    },

    _goalReviewHtml(goal) {
        if (typeof ReviewRoutines === 'undefined' || !goal.title) return '';
        const esc = (s) => this._esc(s);
        const routine = GoalInterview.findReview(goal.title);
        if (routine) {
            return `
                <div class="ai-review-foot goals-review-foot">
                    Anjadhe reviews this project ${esc(NotePrompts.scheduleLabel(NotePrompts.config(routine)))} and posts its read to the Updates above and the Home feed.
                    <button type="button" class="quiet-link-btn" data-goal-review-run="${esc(routine.id)}">Run it now</button>
                    <button type="button" class="quiet-link-btn" data-goal-review-stop="${esc(routine.id)}">Stop</button>
                </div>`;
        }
        return `
            <div class="ai-review-foot goals-review-foot">
                Not reviewed automatically.
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
