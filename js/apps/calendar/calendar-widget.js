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
 * Rows carry no fake action — you cannot "complete" a meeting — so the meta
 * column carries a live "in 20 min" instead. The one real action is Join
 * (2026-09-22): an event with a call link (EventDetails.meetingOf — Google's
 * conference data, or a Meet/Zoom/Teams link in the URL, location or notes)
 * gets a button that opens it in the default browser.
 *
 * Apple Calendar events count too (2026-09-22): the mirror holds real
 * events, and a meeting you can miss is one whichever calendar it lives in.
 */
(function () {
    const MAX_ROWS = 3;
    // Call links of the rows last rendered, by row index (see onAction).
    let joinUrls = [];

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
            const hasApple = (CalendarApp.events || []).some(ev => ev.source === 'apple');
            if (!accounts.size && !hasApple) return null;

            const now = new Date();
            const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const dayEnd = new Date(dayStart.getTime() + 86400000);

            const upcoming = (CalendarApp.events || []).filter(ev => {
                if (!ev.start || !(accounts.has(ev.account) || ev.source === 'apple')) return false;
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
            joinUrls = [];
            return {
                count: upcoming.length,
                body: Widgets.rows(shown.map(ev => {
                    const meeting = typeof EventDetails !== 'undefined'
                        ? EventDetails.meetingOf(ev, CalendarApp.descriptionToText(ev.description)) : null;
                    let actions;
                    if (meeting) {
                        joinUrls.push(meeting.url);
                        actions = [{ action: 'join', id: joinUrls.length - 1, label: 'Join',
                            title: meeting.label ? `Join ${meeting.label}` : 'Join the call' }];
                    }
                    return { text: ev.summary || '(no title)', sub: label(ev, now), actions };
                })),
                footer: Widgets.more(upcoming.length - shown.length, 'later today')
            };
        },

        // The URL is looked up by row index from the last render rather than
        // carried in the markup, so nothing but an index crosses the DOM.
        onAction(action, data) {
            if (action !== 'join') return;
            const url = joinUrls[Number(data?.id)];
            if (url) AppManager.openExternal(url);
        }
    });
})();
