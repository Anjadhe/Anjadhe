/**
 * Actions on home — two attention widgets over the same schedule data.
 *
 * Split deliberately: overdue and "today's remaining" are different
 * urgencies, and splitting them means the Overdue card disappears the
 * moment overdue is clear, even while today still has work in it. One
 * merged card would linger all day and stop meaning anything.
 *
 * Both obey the widget rule — empty list, no card. See js/core/widgets.js.
 */
(function () {
    const MAX_ROWS = 5;

    /** Days late, as words, for the row's meta line. */
    function overdueLabel(item) {
        if (!item.scheduledDate) return '';
        const today = ScheduleApp.getLocalToday();
        const days = Math.round(
            (new Date(today + 'T00:00:00') - new Date(item.scheduledDate + 'T00:00:00'))
            / 86400000
        );
        if (days <= 0) return '';
        if (days === 1) return 'yesterday';
        if (days < 7) return `${days} days ago`;
        if (days < 14) return 'last week';
        return `${Math.floor(days / 7)} weeks ago`;
    }

    /**
     * Completing from home. ScheduleApp.render() no-ops while the schedule
     * view is absent, and its own Undo toast re-toggles — the repaint comes
     * from the 'anjadhe:data-changed' event ScheduleApp.saveData fires, so
     * Undo restores the row here too.
     */
    function complete(action, data) {
        if (action !== 'complete' || !data.id) return;
        ScheduleApp.toggleComplete(data.id);
    }

    function groups() {
        if (typeof ScheduleApp === 'undefined') return null;
        ScheduleApp.loadData();
        // No sidebar filter and no search — home is not a filtered view of
        // the Tasks page, it is the whole picture.
        return ScheduleApp.getGroupedItems({ applySidebarFilter: false, applySearch: false });
    }

    Widgets.register('actions-overdue', {
        kind: 'attention',
        title: 'Overdue',
        app: 'actions',
        order: 10,                     // blocking — nothing sorts above this
        load() {
            const g = groups();
            const overdue = g?.overdue || [];
            if (!overdue.length) return null;

            const shown = overdue.slice(0, MAX_ROWS);
            return {
                tone: 'warn',          // late work — the card exists because something slipped
                count: overdue.length,
                body: Widgets.rows(shown.map(i => ({
                    text: i.title,
                    sub: overdueLabel(i),
                    actions: [{ label: 'Done', action: 'complete', id: i.id, title: 'Mark complete' }]
                }))),
                footer: Widgets.more(overdue.length - shown.length)
            };
        },
        onAction: complete
    });

    Widgets.register('actions-today', {
        kind: 'attention',
        title: 'Today',
        app: 'actions',
        order: 30,                     // time-sensitive, but not late yet
        load() {
            const g = groups();
            const today = g?.todayActive || [];
            if (!today.length) return null;

            // Timed items first and in clock order; untimed follow in their
            // existing order — the same reading order as the Tasks page.
            const sorted = [...today].sort((a, b) => {
                if (!!a.startTime !== !!b.startTime) return a.startTime ? -1 : 1;
                return (a.startTime || '').localeCompare(b.startTime || '');
            });
            const shown = sorted.slice(0, MAX_ROWS);
            return {
                tone: 'good',          // on schedule — today has work, none of it late
                count: today.length,
                body: Widgets.rows(shown.map(i => ({
                    text: i.title,
                    // Untimed tasks say so — an empty time gutter reads as a
                    // rendering mistake, not a choice.
                    sub: i.startTime ? ScheduleUI.formatTime(i.startTime) : 'anytime',
                    subQuiet: !i.startTime,
                    actions: [{ label: 'Done', action: 'complete', id: i.id, title: 'Mark complete' }]
                }))),
                footer: Widgets.more(today.length - shown.length)
            };
        },
        onAction: complete
    });
})();
