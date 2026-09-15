/**
 * Calendar on home — what is still ahead of you today.
 *
 * Not a day grid, not a count. Only the events that have not finished yet,
 * each with the one thing that makes it actionable: how soon it starts. The
 * card empties across the day and is gone by evening, which is the widget
 * rule doing its job (js/core/widgets.js).
 *
 * Two deliberate exclusions:
 *
 *  - **Schedule-derived events.** CalendarApp.getEventsForDate folds
 *    ScheduleApp tasks in as calendar-shaped records (`source: 'schedule'`)
 *    so the grid shows them. On home that would duplicate the Actions Today
 *    card, so this widget reads Google events only and does its own date
 *    filtering rather than calling getEventsForDate.
 *
 *  - **The accounts-rail scope.** getScopedAccounts() narrows to whichever
 *    account is selected in the calendar's rail. That is a view preference
 *    inside the app; home should not silently hide a profile's other
 *    calendars because of it, so this uses getAccounts().
 *
 * Rows are deliberately inert — you cannot "complete" a meeting, and a fake
 * action would be worse than none. The value here is knowing, so the meta
 * column carries a live "in 20 min" instead.
 */
(function () {
    const MAX_ROWS = 3;

    function label(ev, now) {
        if (ev.allDay) return 'All day';
        const start = ev.start;
        const end = ev.end || start;
        if (start <= now && now < end) return 'now';
        const mins = Math.round((start - now) / 60000);
        if (mins <= 0) return 'now';
        if (mins < 60) return `in ${mins} min`;
        if (mins < 180) {
            const h = Math.floor(mins / 60);
            const m = mins % 60;
            return m ? `in ${h}h ${m}m` : `in ${h}h`;
        }
        return CalendarApp.formatTime(start);
    }

    Widgets.register('calendar-today', {
        kind: 'attention',
        // A meeting has a hard start you can miss, so it sits above the day's
        // tasks (order 30) and the email queue (20) — but under anything
        // already overdue (10).
        order: 15,
        title: 'Coming up',
        app: 'calendar',
        load() {
            if (typeof CalendarApp === 'undefined') return null;
            // Synchronous — the calendar blob is already in StorageManager, so
            // unlike Email there is nothing to wait for.
            CalendarApp.loadData();

            const accounts = new Set(CalendarApp.getAccounts().map(a => a.email));
            if (!accounts.size) return null;

            const now = new Date();
            const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const dayEnd = new Date(dayStart.getTime() + 86400000);

            const upcoming = (CalendarApp.events || []).filter(ev => {
                if (!ev.start || !accounts.has(ev.account)) return false;
                if (ev.allDay) {
                    const s = new Date(ev.start.getFullYear(), ev.start.getMonth(), ev.start.getDate());
                    const e = ev.end
                        ? new Date(ev.end.getFullYear(), ev.end.getMonth(), ev.end.getDate())
                        : new Date(s.getTime() + 86400000);
                    return s < dayEnd && e > dayStart;
                }
                if (ev.start >= dayEnd) return false;              // not today
                return (ev.end || ev.start) > now;                 // not already over
            }).sort((a, b) => {
                if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
                return a.start - b.start;
            });

            if (!upcoming.length) return null;

            const shown = upcoming.slice(0, MAX_ROWS);
            return {
                count: upcoming.length,
                body: Widgets.rows(shown.map(ev => ({
                    text: ev.summary || '(no title)',
                    sub: label(ev, now)
                }))),
                footer: Widgets.more(upcoming.length - shown.length, 'later today')
            };
        }
    });
})();
