/**
 * Link Manager
 * Bidirectional cross-app linking between Goals, Schedule, Notes,
 * Bookmarks, and Portfolio. (Focus areas were retired 2026-07-31 — goals
 * carry a plain `group` field instead; purgeFocusLinks below cleans up
 * the old links once.)
 */

const LinkManager = {
    _storageKey: 'links',

    /**
     * Load all links from storage
     */
    loadLinks() {
        const data = StorageManager.get(this._storageKey);
        return data?.links || [];
    },

    /**
     * Save links to storage
     */
    saveLinks(links) {
        StorageManager.set(this._storageKey, { links });
    },

    /**
     * Add a link between two items (stored once, queried bidirectionally)
     * Returns the new link or null if duplicate
     */
    addLink(sourceApp, sourceId, targetApp, targetId) {
        const links = this.loadLinks();

        // Check for duplicate (either direction)
        const exists = links.some(l =>
            (l.sourceApp === sourceApp && l.sourceId === sourceId &&
             l.targetApp === targetApp && l.targetId === targetId) ||
            (l.sourceApp === targetApp && l.sourceId === targetId &&
             l.targetApp === sourceApp && l.targetId === sourceId)
        );

        if (exists) return null;

        const link = {
            id: UIUtils.generateId(),
            sourceApp,
            sourceId,
            targetApp,
            targetId,
            createdAt: new Date().toISOString()
        };

        links.push(link);
        this.saveLinks(links);
        return link;
    },

    /**
     * Remove a link between two items (checks both directions)
     */
    removeLink(sourceApp, sourceId, targetApp, targetId) {
        let links = this.loadLinks();
        links = links.filter(l => !(
            (l.sourceApp === sourceApp && l.sourceId === sourceId &&
             l.targetApp === targetApp && l.targetId === targetId) ||
            (l.sourceApp === targetApp && l.sourceId === targetId &&
             l.targetApp === sourceApp && l.targetId === sourceId)
        ));
        this.saveLinks(links);
    },

    /**
     * Remove a link by its ID
     */
    removeLinkById(linkId) {
        let links = this.loadLinks();
        links = links.filter(l => l.id !== linkId);
        this.saveLinks(links);
    },

    /**
     * One-shot cleanup for the focus-area retirement: drop every link
     * with a `focus` endpoint (goal→area filing and the denormalized
     * task→area links). Called from GoalsApp.migrateFromFocus at startup;
     * writes only when something actually shrinks, so steady-state boots
     * are a no-op.
     */
    purgeFocusLinks() {
        const links = this.loadLinks();
        const kept = links.filter(l => l.sourceApp !== 'focus' && l.targetApp !== 'focus');
        if (kept.length !== links.length) this.saveLinks(kept);
    },

    /**
     * Get all linked items for a given item, grouped by target app
     * Returns { goals: [{itemId, linkId}], schedule: [...], ... }
     */
    getLinksFor(app, itemId) {
        const links = this.loadLinks();
        const result = {};

        for (const link of links) {
            let otherApp, otherId;

            if (link.sourceApp === app && link.sourceId === itemId) {
                otherApp = link.targetApp;
                otherId = link.targetId;
            } else if (link.targetApp === app && link.targetId === itemId) {
                otherApp = link.sourceApp;
                otherId = link.sourceId;
            } else {
                continue;
            }

            if (!result[otherApp]) result[otherApp] = [];
            result[otherApp].push({ itemId: otherId, linkId: link.id });
        }

        return result;
    },

    /**
     * Get linked items from a specific target app
     */
    getLinksForApp(app, itemId, targetApp) {
        const grouped = this.getLinksFor(app, itemId);
        return grouped[targetApp] || [];
    },

    /**
     * Get item metadata from its app's storage
     * Returns { title, ...appSpecificFields } or null if not found
     */
    getItemMeta(app, itemId) {
        switch (app) {
            case 'goals': {
                const data = StorageManager.get('goals');
                const item = (data?.goals || []).find(g => g.id === itemId);
                if (!item) return null;
                return { title: item.title, status: item.status, group: item.group, type: item.type };
            }
            case 'schedule': {
                const data = StorageManager.get('schedule');
                const item = (data?.scheduleItems || []).find(s => s.id === itemId);
                if (!item) return null;
                return { title: item.title, startTime: item.startTime, endTime: item.endTime, scheduledDate: item.scheduledDate, lastCompletedDate: item.lastCompletedDate, repeat: item.repeat, dayOfWeek: item.dayOfWeek, repeatDays: item.repeatDays, history: item.history };
            }
            case 'notes': {
                const data = StorageManager.get('notes');
                const item = (data?.notes || []).find(n => n.id === itemId);
                if (!item) return null;
                return { title: item.title, tags: item.tags, pinned: item.pinned };
            }
            case 'bookmarks': {
                const data = StorageManager.get('bookmarks');
                const item = (data?.bookmarks || []).find(b => b.id === itemId);
                if (!item) return null;
                return { title: item.title, url: item.url, group: item.group };
            }
            case 'portfolio': {
                // 'overview' is a pseudo-item for the portfolio as a whole,
                // so a strategy note can attach to the overview rather than
                // one account. It always exists — never treat it as stale.
                if (itemId === 'overview') return { title: 'Portfolio', overview: true };
                const data = StorageManager.get('portfolio');
                const item = (data?.accounts || []).find(a => a.id === itemId);
                if (!item) return null;
                return { title: item.name, type: item.type };
            }
            default:
                return null;
        }
    },

    /**
     * Check if an item exists in its app's storage
     */
    itemExists(app, itemId) {
        return this.getItemMeta(app, itemId) !== null;
    },

    /**
     * Resolve all links for an item — returns enriched objects with metadata
     * Filters out stale links automatically
     */
    resolveLinks(app, itemId) {
        const grouped = this.getLinksFor(app, itemId);
        const resolved = {};

        for (const [targetApp, links] of Object.entries(grouped)) {
            resolved[targetApp] = [];
            for (const link of links) {
                const meta = this.getItemMeta(targetApp, link.itemId);
                if (meta) {
                    resolved[targetApp].push({
                        app: targetApp,
                        itemId: link.itemId,
                        linkId: link.linkId,
                        ...meta
                    });
                } else {
                    // Stale link — target was deleted
                    this.removeLinkById(link.linkId);
                }
            }
        }

        return resolved;
    },

    /**
     * Count the cross-app children that block deletion of this item.
     * Goal parents block on linked schedule items; schedule items are
     * leaves (no children).
     */
    countLinkedChildren(app, itemId) {
        if (app === 'goals') {
            return { tasks: this.getLinksForApp('goals', itemId, 'schedule').length };
        }
        return {};
    },

    /**
     * Throw CHILD_RECORDS_EXIST if this item has linked children that
     * would be orphaned by deletion. Callers catch and surface the
     * counts to the user so they can remove children first. Strict
     * parent-child model: no cascade, no silent data loss.
     */
    assertNoLinkedChildren(app, itemId) {
        const counts = this.countLinkedChildren(app, itemId);
        const blocking = Object.entries(counts).filter(([, n]) => n > 0);
        if (blocking.length === 0) return;
        const err = new Error(
            `Cannot delete ${app}:${itemId} — ${blocking.map(([k, n]) => `${n} ${k}`).join(', ')} still linked`
        );
        err.code = 'CHILD_RECORDS_EXIST';
        err.counts = counts;
        throw err;
    },

    /**
     * Remove all links for a given item (called when item is deleted)
     */
    removeAllLinksForItem(app, itemId) {
        let links = this.loadLinks();
        links = links.filter(l => !(
            (l.sourceApp === app && l.sourceId === itemId) ||
            (l.targetApp === app && l.targetId === itemId)
        ));
        this.saveLinks(links);
    },

    /**
     * Clean up stale links where either side no longer exists
     */
    cleanupStaleLinks() {
        const links = this.loadLinks();
        const valid = links.filter(l =>
            this.itemExists(l.sourceApp, l.sourceId) &&
            this.itemExists(l.targetApp, l.targetId)
        );
        if (valid.length !== links.length) {
            this.saveLinks(valid);
        }
    },

    /**
     * Get the first linked goal for a schedule/task item
     * @returns {Object|null} { title, status, group, type, itemId } or null
     */
    getGoalForTask(taskId) {
        const links = this.getLinksForApp('schedule', taskId, 'goals');
        if (links.length === 0) return null;
        const meta = this.getItemMeta('goals', links[0].itemId);
        if (!meta) return null;
        return { ...meta, itemId: links[0].itemId };
    },

    /**
     * Get all tasks linked to a goal, resolved with metadata
     * @returns {Array} [{ title, startTime, endTime, scheduledDate, lastCompletedDate, repeat, itemId, linkId }]
     */
    getTasksForGoal(goalId) {
        const links = this.getLinksForApp('goals', goalId, 'schedule');
        // StorageManager.get is a sync IPC round-trip + a full parse of the
        // blob — per-link getItemMeta calls made this O(tasks) blob reads,
        // which is what made the Goals page crawl once a goal carried a
        // real task list. One read, one Map.
        const byId = new Map(
            ((StorageManager.get('schedule')?.scheduleItems) || []).map(s => [s.id, s]));
        const results = [];
        for (const link of links) {
            const item = byId.get(link.itemId);
            if (item) {
                results.push({
                    title: item.title, startTime: item.startTime, endTime: item.endTime,
                    scheduledDate: item.scheduledDate, lastCompletedDate: item.lastCompletedDate,
                    repeat: item.repeat, dayOfWeek: item.dayOfWeek, repeatDays: item.repeatDays,
                    history: item.history, itemId: link.itemId, linkId: link.linkId
                });
            }
        }
        // Sort by start time
        results.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
        return results;
    },

    /**
     * Get task completion counts for a goal
     * @param {Array} [tasks] — pass the getTasksForGoal result you already
     *   hold to skip re-fetching it (each fetch is sync IPC).
     * @returns {{ total: number, completed: number }}
     */
    getTaskCountForGoal(goalId, tasks) {
        tasks = tasks || this.getTasksForGoal(goalId);
        const todayStr = this._todayStr();
        let completed = 0;
        for (const t of tasks) {
            if (this._taskResolved(t, todayStr)) completed++;
        }
        return { total: tasks.length, completed };
    },

    _todayStr() {
        const today = new Date();
        return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    },

    _taskResolved(t, todayStr) {
        const h = (t.history && typeof t.history === 'object') ? t.history : {};
        const repeating = t.repeat && t.repeat !== 'none';
        if (t.lastCompletedDate === todayStr) return true;
        if (!repeating && t.lastCompletedDate) return true;
        // Abandoned resolves like completing (repeating: today only)
        return repeating ? h[todayStr] === 'abandoned' : Object.values(h).includes('abandoned');
    },

    /**
     * Task counts for MANY goals in one pass — one links read + one
     * schedule read total, instead of two per goal. Per-goal
     * getTaskCountForGoal in a render loop is what made the Goals nav
     * slow (StorageManager.get is sync IPC + a full blob parse).
     * @returns {Map<string, {total: number, completed: number}>}
     */
    getTaskCountsForGoals(goalIds) {
        const wanted = new Set(goalIds);
        const counts = new Map();
        for (const id of wanted) counts.set(id, { total: 0, completed: 0 });
        const byId = new Map(
            ((StorageManager.get('schedule')?.scheduleItems) || []).map(s => [s.id, s]));
        const todayStr = this._todayStr();
        for (const link of this.loadLinks()) {
            let goalId, taskId;
            if (link.sourceApp === 'goals' && link.targetApp === 'schedule') {
                goalId = link.sourceId; taskId = link.targetId;
            } else if (link.sourceApp === 'schedule' && link.targetApp === 'goals') {
                goalId = link.targetId; taskId = link.sourceId;
            } else continue;
            if (!wanted.has(goalId)) continue;
            const task = byId.get(taskId);
            if (!task) continue;
            const c = counts.get(goalId);
            c.total++;
            if (this._taskResolved(task, todayStr)) c.completed++;
        }
        return counts;
    },

    /**
     * Get all items from a specific app (for picker)
     */
    getAppItems(app) {
        const pf = (items) => items;
        switch (app) {
            case 'goals': {
                const data = StorageManager.get('goals');
                return pf(data?.goals || []).filter(g => g.status !== 'completed').map(g => ({
                    id: g.id, title: g.title, status: g.status, group: g.group, type: g.type
                }));
            }
            case 'schedule': {
                const data = StorageManager.get('schedule');
                return pf(data?.scheduleItems || []).map(s => ({
                    id: s.id, title: s.title, startTime: s.startTime, endTime: s.endTime, repeat: s.repeat
                }));
            }
            case 'notes': {
                const data = StorageManager.get('notes');
                // Coerce like NotesApp.loadNotes(): a phone-created note can
                // carry a non-string title, and this read bypasses that layer.
                return pf(data?.notes || []).map(n => ({
                    id: n.id, title: typeof n.title === 'string' ? n.title : '', tags: n.tags, pinned: n.pinned
                }));
            }
            case 'bookmarks': {
                const data = StorageManager.get('bookmarks');
                return pf(data?.bookmarks || []).map(b => ({
                    id: b.id, title: b.title, url: b.url, group: b.group
                }));
            }
            case 'portfolio': {
                const data = StorageManager.get('portfolio');
                const accounts = pf(data?.accounts || []).map(a => ({
                    id: a.id, title: a.name, type: a.type
                }));
                return [{ id: 'overview', title: 'Portfolio (all accounts)' }, ...accounts];
            }
            default:
                return [];
        }
    }
};
