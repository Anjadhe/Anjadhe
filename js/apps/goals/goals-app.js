/**
 * Goals — the data layer for the Goals page.
 *
 * A goal is an outcome with a measurable finish line (`description`), an
 * optional `why` and `obstacles` (captured by the goal interview — see
 * goal-interview.js), a target date, a status, and a plain `group` text
 * field ("Work", "Health") the page groups by. Groups are labels, nothing
 * more: no group records, no management pages — renaming happens by
 * editing the field on the goals themselves.
 *
 * Tasks are ordinary schedule items joined to the goal by `links` records
 * (LinkManager.getTasksForGoal). The page controller/renderer live in
 * goals-page.js / goals-page-ui.js; this module owns storage and the
 * migrations.
 */

const GoalsApp = {
    UNGROUPED: 'Ungrouped',        // label for goals with no group assigned
    goals: [],

    /**
     * Load goals from storage. Normalizes missing fields (phone-created
     * records) and migrates legacy shapes on load:
     *   - `completed` bool → folded into `status`;
     *   - `type` buckets (today/week/month/year) → `targetDate` (the bucket
     *     always meant "due within this horizon, measured from now").
     * `group` is deliberately NOT defaulted here: undefined marks a record
     * migrateFromFocus() has not yet stamped, and persisting '' early would
     * hide it from that migration.
     */
    // The only statuses since 2026-07-31: a goal is completed or it is not
    // (plus the interview's machine-set 'draft'). Progress lives in the
    // linked tasks; the honest read comes from the weekly AI review.
    STATUSES: ['draft', 'not-started', 'completed'],

    loadGoals() {
        const data = StorageManager.get('goals');
        let migrated = false;
        this.goals = (data?.goals || []).map(g => {
            const { completed, ...rest } = g;
            if (completed !== undefined) migrated = true;
            return {
                ...rest,
                title: typeof g.title === 'string' ? g.title : '',
                description: typeof g.description === 'string' ? g.description : '',
                status: completed ? 'completed' : (g.status || 'not-started'),
            };
        });
        for (const g of this.goals) {
            if (g.targetDate === undefined) {
                g.targetDate = g.type ? this._horizonEnd(g.type) : null;
                migrated = true;
            }
            // The old four-way working statuses (in-progress / no-progress /
            // need-help) collapse to "not completed" (2026-07-31).
            if (!this.STATUSES.includes(g.status)) {
                g.status = 'not-started';
                migrated = true;
            }
        }
        if (migrated) this.saveGoals();
    },

    // End date of a legacy type bucket, measured from today.
    _horizonEnd(type) {
        const d = new Date();
        if (type === 'today') {
            // keep d
        } else if (type === 'week') {
            d.setDate(d.getDate() + (7 - d.getDay()) % 7); // upcoming Sunday
        } else if (type === 'month') {
            d.setMonth(d.getMonth() + 1, 0); // last day of this month
        } else if (type === 'year') {
            d.setMonth(11, 31);
        } else {
            return null;
        }
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear()}-${m}-${day}`;
    },

    saveGoals() {
        StorageManager.set('goals', { goals: this.goals });
        AppManager.updateStats();
    },

    // ── Groups (a plain text field on each goal) ─────────────────────────

    /** The group a goal belongs to, mapping blank/missing to UNGROUPED. */
    groupOf(goal) {
        const g = (goal && typeof goal.group === 'string') ? goal.group.trim() : '';
        return g || this.UNGROUPED;
    },

    /**
     * Distinct group names in first-seen order, with Ungrouped always last
     * (only present if it has goals).
     */
    getGroups() {
        const named = [];
        let hasUngrouped = false;
        for (const g of this.goals) {
            const name = this.groupOf(g);
            if (name === this.UNGROUPED) { hasUngrouped = true; continue; }
            if (!named.includes(name)) named.push(name);
        }
        if (hasUngrouped) named.push(this.UNGROUPED);
        return named;
    },

    /** Goals within the given group, preserving stored order. */
    getGoalsInGroup(group) {
        return this.goals.filter(g => this.groupOf(g) === group);
    },

    /** Set a goal's group ('' or UNGROUPED = ungrouped). Persists. */
    setGoalGroup(goalId, group) {
        const goal = this.goals.find(g => g.id === goalId);
        if (!goal) return false;
        const clean = (group || '').trim();
        const next = clean === this.UNGROUPED ? '' : clean;
        if ((goal.group || '') === next) return false;
        goal.group = next;
        goal.modifiedAt = new Date().toISOString();
        this.saveGoals();
        return true;
    },

    // ── Migration: focus areas → group labels (2026-07-31) ───────────────

    /**
     * One-shot, idempotent, convergent: goals that predate the `group`
     * field get it stamped from the title of the focus area they were
     * linked to (focus areas were the old grouping layer — removed as
     * records, kept as a label). Then every link touching the retired
     * `focus` app is purged. The old `focus` blob stays in storage, dead
     * (same precedent as `profiles`).
     *
     * Sync note: `goals` is whole-key LWW, but this is one guarded write
     * per machine derived from the same synced `links` + `focus` blobs, so
     * a two-Mac race converges on identical output. Steady-state startups
     * write nothing.
     */
    migrateFromFocus() {
        const data = StorageManager.get('goals') || {};
        const goals = data.goals || [];
        const needs = goals.filter(g => g.group === undefined);
        if (needs.length) {
            const links = (StorageManager.get('links')?.links) || [];
            const areas = (StorageManager.get('focus')?.focusItems) || [];
            const areaTitle = new Map(areas.map(a => [a.id, (a.title || '').trim()]));
            const focusOf = new Map();   // goalId → focusId, first link wins
            for (const l of links) {
                if (l.sourceApp === 'goals' && l.targetApp === 'focus' && !focusOf.has(l.sourceId)) {
                    focusOf.set(l.sourceId, l.targetId);
                }
                if (l.sourceApp === 'focus' && l.targetApp === 'goals' && !focusOf.has(l.targetId)) {
                    focusOf.set(l.targetId, l.sourceId);
                }
            }
            const now = new Date().toISOString();
            for (const g of needs) {
                g.group = areaTitle.get(focusOf.get(g.id)) || '';
                g.modifiedAt = now;
            }
            StorageManager.set('goals', { goals });
            this.goals = goals;
        }
        LinkManager.purgeFocusLinks();
    },

    // ── Formatting ───────────────────────────────────────────────────────

    /**
     * Legacy type label — old records may still carry `type`; link-picker
     * and old data paths call this. New goals have targetDate instead.
     */
    formatType(type) {
        const typeMap = {
            'today': 'Today',
            'week': 'This Week',
            'month': 'This Month',
            'year': 'This Year'
        };
        return typeMap[type] || '';
    },

    formatStatus(status) {
        if (status === 'completed') return 'Completed';
        if (status === 'draft') return 'Draft';
        return 'Active';
    }
};
