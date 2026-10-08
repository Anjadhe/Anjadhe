/**
 * Calendar App — Google Calendar integration
 * Connects via OAuth, displays events in month/week/day views,
 * supports create, edit, and delete operations.
 */

const CalendarApp = {
    events: [],
    accounts: [],
    calendars: [],
    currentDate: new Date(),
    isSyncing: false,
    lastSyncTime: null,
    syncTimer: null,
    // The page's account scope is gone with the page (2026-10-05); every
    // read is every account. Kept null so old readers of it see "all".
    currentAccount: null,

    // Google Calendar's liveness (2026-10-05, reported: an event made in
    // Google never reached Now until the Calendar page was opened). The
    // poll and the focus refresh used to start in init(), which runs only
    // when the Calendar page opens, so on a Mac that lives on Now nothing
    // ever synced after the connect. Started from AppManager.init, never a
    // view (AppleImport's rule); safe to call again.
    startBackground() {
        if (!this._backgroundStarted) {
            this._backgroundStarted = true;
            if (!this.accounts.length) { try { this.loadData(); } catch { /* the timer reloads nothing; the page's init will */ } }
            // Coming back to nenva from Google Calendar in the browser is
            // when the person expects it current. Google has no push channel
            // a local desktop app can subscribe to, so re-focus is the signal.
            const onFocus = () => {
                if (document.visibilityState === 'hidden') return;
                this.syncIfStale(this._watching() ? 15 * 1000 : 60 * 1000, { quiet: !this._onPage() });
            };
            window.addEventListener('focus', onFocus);
            document.addEventListener('visibilitychange', onFocus);
        }
        if (!this.syncTimer) this.startAutoSync();
    },

    /** The Calendar page is gone (2026-10-05): nothing is "on the page" any more. */
    _onPage() { return false; },

    // Is the person looking at something that shows meetings: Now
    // (currentApp null), with Today and Coming up.
    _watching() {
        return typeof AppManager !== 'undefined' && AppManager.currentApp === null && !document.hidden;
    },

    // Sync from Google unless the cache is fresher than maxAgeMs. Used by
    // app-open (above) and the agent's calendar tools so on-demand reads
    // reflect what's actually on Google, not a stale local cache.
    syncIfStale(maxAgeMs = 60 * 1000, opts) {
        if (this.isSyncing || this.getAccounts().length === 0) return Promise.resolve();
        const last = this.lastSyncTime ? new Date(this.lastSyncTime).getTime() : 0;
        if (Date.now() - last < maxAgeMs) return Promise.resolve();
        return this.syncEvents(opts);
    },

    loadData() {
        const data = StorageManager.get('calendar') || {};
        this.accounts = data.accounts || [];
        this.events = this._dedupEvents((data.events || []).map(e => ({
            ...e,
            start: e.start ? new Date(e.start) : null,
            end: e.end ? new Date(e.end) : null
        })));
        this.calendars = data.calendars || [];
        this.lastSyncTime = data.lastSyncTime || null;
    },

    // All-day events arrive from Google as date-only strings ("2026-07-16").
    // new Date("2026-07-16") parses as UTC midnight — the previous *evening*
    // in western timezones — so a tomorrow all-day event rendered on today.
    // Date-only values must be parsed as LOCAL midnight.
    _parseEventDate(value) {
        if (!value) return null;
        if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
            const [y, m, d] = value.split('-').map(Number);
            return new Date(y, m - 1, d);
        }
        return new Date(value);
    },

    // Shape a synced Google event into the local store's event record.
    _toLocalEvent(ev, accountEmail) {
        return {
            id: ev.id,
            calendarId: ev.calendarId || 'primary',
            summary: ev.summary || '(No title)',
            description: ev.description || '',
            location: ev.location || '',
            start: this._parseEventDate(ev.start),
            end: this._parseEventDate(ev.end),
            allDay: ev.allDay || false,
            account: accountEmail,
            htmlLink: ev.htmlLink || '',
            meeting: ev.meeting || null,
            status: ev.status || 'confirmed',
            colorId: ev.colorId || null,
            attendees: ev.attendees || [],
            recurrence: ev.recurrence || null,
            recurringEventId: ev.recurringEventId || null,
            // The rest of what Google says (2026-09-22); EventDetails reads it.
            organizer: ev.organizer || null,
            creator: ev.creator || null,
            showAs: ev.showAs || '',
            visibility: ev.visibility || '',
            eventType: ev.eventType || '',
            workingLocation: ev.workingLocation || '',
            reminders: ev.reminders || null,
            attachments: ev.attachments || [],
            sourceLink: ev.sourceLink || null,
            timeZone: ev.timeZone || '',
            created: ev.created || '',
            updated: ev.updated || '',
            guestsCanSeeOtherGuests: ev.guestsCanSeeOtherGuests !== false
        };
    },

    // Collapse any duplicate rows that share the same (account, id) pair.
    // Duplicates can slip in if a previous sync filtered by a stale account
    // string (e.g., before an account rename) and failed to clear the old
    // rows before pushing fresh ones. Keep the last occurrence so the most
    // recently synced version wins.
    _dedupEvents(events) {
        const byKey = new Map();
        for (const ev of events) {
            if (!ev?.id) continue;
            byKey.set(`${ev.account || ''}::${ev.id}`, ev);
        }
        return Array.from(byKey.values());
    },

    saveData() {
        StorageManager.set('calendar', {
            accounts: this.accounts,
            events: this.events.map(e => ({
                ...e,
                start: e.start ? e.start.toISOString() : null,
                end: e.end ? e.end.toISOString() : null
            })),
            calendars: this.calendars,
            lastSyncTime: this.lastSyncTime
        });
        // Announce the write (2026-10-02, reported: a meeting moved in
        // Calendar.app showed its old time on Now for about a minute). The
        // focus refresh brought the new time in at once, but nothing told
        // Now, which waited for its 30-second timer. Schedule does the same.
        document.dispatchEvent(new CustomEvent('anjadhe:data-changed', { detail: { key: 'calendar' } }));
    },

    // --- Navigation ---

    // --- Google Calendar OAuth ---

    // Called by AccountsManager.remove when a Google account is removed from
    // Settings → Connected Accounts. Operates directly on stored data so it
    // works whether or not the Calendar view has been opened in this session.
    cleanupAccountData(email) {
        const data = StorageManager.get('calendar') || {};
        const events = (data.events || []).filter(e => e.account !== email);
        const calendars = (data.calendars || []).filter(c => c.account !== email);

        StorageManager.set('calendar', { ...data, events, calendars });

        if (Array.isArray(this.events)) {
            this.events = events;
            this.calendars = calendars;
        }
    },

    // --- Sync ---

    startAutoSync() {
        if (this.syncTimer) clearInterval(this.syncTimer);
        // Incremental sync (syncToken) makes a no-change poll a few hundred
        // bytes, so poll every minute while the user is looking at the
        // calendar or at Now; back off to every 5 minutes in the background.
        this._autoSyncTick = 0;
        this.syncTimer = setInterval(() => {
            if (this.accounts.length === 0) return;
            this._autoSyncTick++;
            if (this._watching() || this._autoSyncTick % 5 === 0) this.syncEvents({ quiet: !this._onPage() });
        }, 60 * 1000);
    },

    // `quiet` (2026-10-05): a poll or focus refresh away from the Calendar
    // page reports in the page's status line only. Offline on Now must not
    // raise a red toast every minute.
    async syncEvents({ quiet = false } = {}) {
        if (this.isSyncing || this.accounts.length === 0) return;
        this.isSyncing = true;
        const syncBtn = document.getElementById('calendar-sync-btn');
        const doneBtn = UIUtils.setButtonLoading(syncBtn, 'Syncing...');

        // Track which accounts succeeded and which failed so we can show
        // a meaningful status (and not silently mark "synced" when nothing
        // actually came back).
        const failedAccounts = [];
        const reconnectAccounts = [];
        let totalEventCount = 0;
        let successfulAccountCount = 0;

        try {
            for (const account of this.accounts) {
                // Fetch calendar list
                const calResult = await window.electronCalendar.listCalendars(account.email);
                if (calResult?.error) {
                    console.error('[calendar] listCalendars error for', account.email, ':', calResult.error);
                    if (calResult.error.includes('reconnect') || calResult.error.includes('authent')) {
                        reconnectAccounts.push(account.email);
                    } else {
                        failedAccounts.push({ email: account.email, error: calResult.error });
                    }
                    continue; // skip event fetch for this account, no point
                }
                if (calResult?.calendars) {
                    // Remove old calendars for this account and add new
                    this.calendars = this.calendars.filter(c => c.account !== account.email);
                    calResult.calendars.forEach(cal => {
                        this.calendars.push({
                            id: cal.id,
                            summary: cal.summary,
                            backgroundColor: cal.backgroundColor,
                            primary: cal.primary || false,
                            selected: cal.selected || false,
                            accessRole: cal.accessRole || 'reader',
                            account: account.email
                        });
                    });
                }

                // Sync every calendar the user has visible in Google's UI
                // (`selected`), not just primary — family/shared/classroom
                // calendars were invisible here otherwise. Primary is always
                // included as a safety net.
                const calendarIds = (calResult?.calendars || [])
                    .filter(c => c.primary || c.selected)
                    .map(c => c.id);
                if (calendarIds.length === 0) calendarIds.push('primary');

                // Fetch events for next 90 days and past 30 days
                const now = new Date();
                const timeMin = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
                const timeMax = new Date(now.getFullYear(), now.getMonth() + 3, 0).toISOString();

                const evResult = await window.electronCalendar.syncEvents(account.email, { timeMin, timeMax, calendarIds });
                console.log('[calendar] syncEvents result:', evResult?.error || (evResult?.calendars || []).map(c => `${c.calendarId}: ${c.failed ? 'failed' : `${c.mode} ${c.events.length}`}`).join(', '));

                if (evResult?.error) {
                    console.error('[calendar] syncEvents error for', account.email, ':', evResult.error);
                    if (evResult.error.includes('reconnect') || evResult.error.includes('authent')) {
                        if (!reconnectAccounts.includes(account.email)) reconnectAccounts.push(account.email);
                    } else {
                        failedAccounts.push({ email: account.email, error: evResult.error });
                    }
                    continue;
                }

                if (evResult?.calendars) {
                    // Drop cached events from calendars no longer in the
                    // synced set (unchecked in Google's UI, revoked share) —
                    // with per-calendar merging below they'd linger forever.
                    const syncedCals = new Set(calendarIds);
                    this.events = this.events.filter(e =>
                        e.account !== account.email || syncedCals.has(e.calendarId));

                    for (const cal of evResult.calendars) {
                        if (cal.failed) continue; // keep this calendar's cache
                        if (cal.mode === 'full') {
                            // Full window fetch: replace this calendar wholesale
                            this.events = this.events.filter(e =>
                                e.account !== account.email || e.calendarId !== cal.calendarId);
                            cal.events
                                .filter(ev => ev.status !== 'cancelled')
                                .forEach(ev => this.events.push(this._toLocalEvent(ev, account.email)));
                        } else {
                            // Incremental: apply the delta — upsert changes,
                            // remove cancellations.
                            for (const ev of cal.events) {
                                const idx = this.events.findIndex(e =>
                                    e.account === account.email && e.calendarId === cal.calendarId && e.id === ev.id);
                                if (ev.status === 'cancelled') {
                                    if (idx >= 0) this.events.splice(idx, 1);
                                } else if (idx >= 0) {
                                    this.events[idx] = this._toLocalEvent(ev, account.email);
                                } else {
                                    this.events.push(this._toLocalEvent(ev, account.email));
                                }
                            }
                        }
                    }
                    totalEventCount += this.events.filter(e => e.account === account.email).length;
                    successfulAccountCount++;
                }
            }

            // Only mark "lastSyncTime" if at least one account actually succeeded.
            // Otherwise the user sees "Synced just now" while nothing happened.
            if (successfulAccountCount > 0) {
                this.lastSyncTime = new Date().toISOString();
            }

            // Defensive: collapse any duplicate rows (same account+id).
            // Drop rows whose account is no longer connected so stale copies
            // from a renamed/removed account can't linger forever. The rule
            // lives on AppleImport because the Apple mirror's rows (account
            // 'apple') are the one non-Google thing in this blob: a plain
            // live-email test wiped them on every sync (2026-09-09 fix).
            const liveAccounts = new Set(this.accounts.map(a => a.email));
            this.events = this._dedupEvents(
                AppleImport.pruneStaleAccountRows(this.events, liveAccounts)
            );

            this.saveData();

            // Report status. Reconnect failures take priority since they're
            // actionable; other errors come next; success last.
            if (reconnectAccounts.length > 0) {
                const list = reconnectAccounts.join(', ');
                if (!quiet && typeof UIUtils !== 'undefined') {
                    UIUtils.showToast(`Calendar account needs reconnection: ${list}`, 'error');
                }
            } else if (failedAccounts.length > 0) {
                if (!quiet && typeof UIUtils !== 'undefined') {
                    UIUtils.showToast(`Calendar sync failed: ${failedAccounts[0].error}`, 'error');
                }
            }
        } catch (err) {
            console.error('Calendar sync failed:', err);
            if (!quiet && typeof UIUtils !== 'undefined') {
                UIUtils.showToast(`Calendar sync error: ${err.message}`, 'error');
            }
        } finally {
            this.isSyncing = false;
            doneBtn();
        }
    },

    // --- Event CRUD ---

    // ── Apple Calendar write-through (2026-09-09) ───────────────────────
    // Apple events save and delete through AppleImport.writeEvent; the
    // mirror is re-read right after, so nothing here patches local rows.
    // The scope conversation is the same one Google has (instance / all
    // for edits, instance / following / all for deletes); EventKit's span
    // does "following" natively, and "all" edits the series master with
    // the Google rule that only the CLOCK travels to a series, never a date.

    _nextYMD(ymd) {
        const [y, m, d] = String(ymd).split('-').map(Number);
        const next = new Date(y, m - 1, d + 1);
        const p = (n) => String(n).padStart(2, '0');
        return `${next.getFullYear()}-${p(next.getMonth() + 1)}-${p(next.getDate())}`;
    },

    // The Repeat presets, shared by the form (create), _repeatFromRecurrence
    // (recognize) and describeRecurrence (display). Weekly anchors to the
    // event's start weekday, monthly to its month-day — Google infers both
    // from DTSTART, so the rules stay this small.
    RRULES: {
        daily: 'RRULE:FREQ=DAILY',
        weekdays: 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
        weekly: 'RRULE:FREQ=WEEKLY',
        monthly: 'RRULE:FREQ=MONTHLY',
        annually: 'RRULE:FREQ=YEARLY'
    },

    /**
     * Map a Google recurrence array back to a Repeat preset key.
     * Returns 'none' for no recurrence, the preset key for an exact match,
     * or null for any rule the presets can't express (multiple rules,
     * RDATE, INTERVAL, UNTIL, …) — callers treat null as "don't offer the
     * Repeat control".
     */
    _repeatFromRecurrence(recurrence) {
        if (!recurrence || recurrence.length === 0) return 'none';
        if (recurrence.length !== 1) return null;
        const rule = recurrence[0];
        if (!rule.startsWith('RRULE:')) return null;
        const parts = new Set(rule.slice(6).split(';').filter(Boolean));
        const match = Object.entries(this.RRULES).find(([, r]) => {
            const rp = r.slice(6).split(';');
            return parts.size === rp.length && rp.every(p => parts.has(p));
        });
        return match ? match[0] : null;
    },

    // Human text for a series' rule, fetched lazily from the master (an
    // instance never carries the RRULE) and cached per series for the
    // session. Falls back to null so the detail row keeps its placeholder.
    _recurrenceCache: {},

    /**
     * Trim a recurring series so it ends before `event.start`. Fetches the
     * master to read its RRULE, rewrites the UNTIL clause, and PATCHes the
     * master. If the instance being deleted is the very first occurrence
     * (or the master has no RRULE), falls back to deleting the whole series.
     */
    async _deleteFollowingOccurrences(event, calendarId, masterId) {
        const masterResult = await window.electronCalendar.getEvent(
            event.account, calendarId, masterId
        );
        if (masterResult?.error || !masterResult?.event) {
            return { error: masterResult?.error || 'Failed to fetch master event' };
        }
        const master = masterResult.event;
        const recurrence = Array.isArray(master.recurrence) ? master.recurrence : [];

        // If the master start is at or after this instance, trimming would
        // leave an empty (or backwards) series — just delete the whole thing.
        const masterStart = master.start?.dateTime || master.start?.date;
        if (masterStart) {
            const masterStartDate = new Date(masterStart);
            if (masterStartDate >= event.start) {
                return await window.electronCalendar.deleteEvent(
                    event.account, calendarId, masterId
                );
            }
        }

        if (recurrence.length === 0) {
            return await window.electronCalendar.deleteEvent(
                event.account, calendarId, masterId
            );
        }

        // UNTIL is inclusive in RFC 5545, so subtract 1 second to ensure
        // this instance and all after are excluded.
        const untilMoment = new Date(event.start.getTime() - 1000);
        const untilStr = event.allDay
            ? this._formatRruleDate(untilMoment)
            : this._formatRruleDateTime(untilMoment);

        let modified = false;
        const newRecurrence = recurrence.map(rule => {
            if (!rule.startsWith('RRULE:')) return rule;
            const parts = rule.substring(6).split(';').filter(p => p.length > 0);
            // Drop any existing UNTIL / COUNT (they're mutually exclusive
            // with each other and with the new UNTIL we're adding).
            const filtered = parts.filter(p => !p.startsWith('UNTIL=') && !p.startsWith('COUNT='));
            filtered.push(`UNTIL=${untilStr}`);
            modified = true;
            return `RRULE:${filtered.join(';')}`;
        });

        if (!modified) {
            // No RRULE found (e.g., series defined only by RDATE). Fall back.
            return await window.electronCalendar.deleteEvent(
                event.account, calendarId, masterId
            );
        }

        return await window.electronCalendar.updateEvent(
            event.account, calendarId, masterId,
            { recurrence: newRecurrence }
        );
    },

    _formatRruleDate(date) {
        // YYYYMMDD (used for DATE-valued UNTIL on all-day events)
        return `${date.getUTCFullYear()}` +
            `${String(date.getUTCMonth() + 1).padStart(2, '0')}` +
            `${String(date.getUTCDate()).padStart(2, '0')}`;
    },

    _formatRruleDateTime(date) {
        // YYYYMMDDTHHMMSSZ (UTC, used for DATE-TIME UNTIL)
        return `${date.getUTCFullYear()}` +
            `${String(date.getUTCMonth() + 1).padStart(2, '0')}` +
            `${String(date.getUTCDate()).padStart(2, '0')}` +
            `T${String(date.getUTCHours()).padStart(2, '0')}` +
            `${String(date.getUTCMinutes()).padStart(2, '0')}` +
            `${String(date.getUTCSeconds()).padStart(2, '0')}Z`;
    },

    // --- Helpers ---

    getAccounts() {
        return this.accounts;
    },

    // --- Accounts rail ---

    getEventsForDate(date) {
        const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const dayEnd = new Date(dayStart.getTime() + 86400000);
        // Scoped, not just profile-filtered — this is what narrows the grid to
        // one account. Schedule tasks below are local and account-less, so they
        // keep answering to their own Tasks toggle instead.
        const profileEmails = new Set(this.getScopedAccounts().map(a => a.email));

        // Imported Apple Calendar events (account 'apple', AppleImport) show
        // under the all-accounts scope AND under their own sidebar row
        // (currentAccount === 'apple'); picking a Google account scopes
        // them away like any other account's events. When scoped to
        // 'apple', profileEmails is empty (no real account matches), so
        // Google events drop out symmetrically.
        const includeApple = !this.currentAccount || this.currentAccount === 'apple';

        const googleEvents = this.events.filter(e => {
            if (!e.start) return false;
            if (!profileEmails.has(e.account) && !(includeApple && e.account === 'apple')) return false;
            if (e.allDay) {
                const eStart = new Date(e.start.getFullYear(), e.start.getMonth(), e.start.getDate());
                const eEnd = e.end ? new Date(e.end.getFullYear(), e.end.getMonth(), e.end.getDate()) : new Date(eStart.getTime() + 86400000);
                return eStart < dayEnd && eEnd > dayStart;
            }
            return e.start < dayEnd && (e.end || e.start) > dayStart;
        });

        const scheduleEvents = this.getScheduleEventsForDate(date);

        return [...googleEvents, ...scheduleEvents].sort((a, b) => {
            if (a.allDay && !b.allDay) return -1;
            if (!a.allDay && b.allDay) return 1;
            return a.start - b.start;
        });
    },

    // Expands Schedule-app tasks into calendar-event-shaped records for a given date.
    // Schedule items are local-wall-clock tasks (no timezone) — we snap their
    // HH:MM startTime onto the requested date. One-time items match scheduledDate;
    // recurring items reuse ScheduleApp's own repeat helpers.
    getScheduleEventsForDate(date) {
        if (typeof ScheduleApp === 'undefined' || !Array.isArray(ScheduleApp.scheduleItems)) return [];

        const y = date.getFullYear();
        const m = date.getMonth();
        const d = date.getDate();
        const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

        const items = ScheduleApp.scheduleItems;

        const results = [];
        for (const item of items) {
            const isRepeating = item.repeat && item.repeat !== 'none';
            // occursOn handles one-time (own date), recurring (day/date match),
            // and the start-date bound (no occurrences before the anchor).
            if (!ScheduleApp.occursOn(item, dateStr)) continue;

            // Hide resolved tasks — completed OR abandoned (deliberately not
            // done counts as done). For recurring tasks resolution is per-day
            // (lastCompletedDate === dateStr / abandoned mark on that day);
            // for one-time tasks any completion or abandonment resolves the
            // task, so drop it from every date including its scheduled one.
            if (isRepeating) {
                if (item.lastCompletedDate === dateStr) continue;
                if (ScheduleApp.isAbandonedOn(item, dateStr)) continue;
            } else {
                if (item.lastCompletedDate) continue;
                if (ScheduleApp.lastAbandonedDate(item)) continue;
            }

            // Timed tasks land in their hour slot; timeless tasks (a date but
            // no clock time — the common case for quick-added items) surface as
            // all-day chips instead of being dropped from the calendar.
            const timed = this.parseScheduleTime(dateStr, item.startTime);
            const allDay = !timed;
            const start = timed || new Date(y, m, d, 0, 0, 0, 0);
            const end = timed && item.endTime ? this.parseScheduleTime(dateStr, item.endTime) : null;

            results.push({
                id: `sched:${item.id}`,
                scheduleId: item.id,
                source: 'schedule',
                summary: item.title,
                start,
                end,
                allDay,
                account: null
            });
        }
        return results;
    },

    parseScheduleTime(dateStr, hhmm) {
        if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
        const [h, m] = hhmm.split(':').map(Number);
        const [y, mo, da] = dateStr.split('-').map(Number);
        return new Date(y, mo - 1, da, h, m, 0, 0);
    },

    /**
     * The one door to an event since the Calendar page left (2026-10-05):
     * it opens where it lives — Google Calendar's own page, or the event in
     * Calendar.app for an Apple one — the same way Now's rows do. A task
     * row that the old calendar drew (`sched:<id>`) opens its sheet.
     */
    openEvent(eventId, { account = null } = {}) {
        if (!eventId) return false;
        if (String(eventId).startsWith('sched:')) { if (typeof ScheduleApp !== 'undefined') ScheduleApp.openEditor(String(eventId).slice(6)); return true; }
        const ev = this._findEvent(eventId, account);
        if (!ev) return false;
        if (ev.source === 'apple' && ev.appleEventId) { window.electronAuth?.openAppleCalendarEvent?.(ev.appleEventId); return true; }
        if (ev.htmlLink && /^https:\/\//i.test(ev.htmlLink)) { AppManager.openExternal(ev.htmlLink); return true; }
        return false;
    },

    // An id alone is not an event: Google hands every attendee's copy of a
    // shared event the SAME id, so a meeting on two connected accounts is two
    // rows here. The account the caller was looking at disambiguates; without
    // one, first match (the old behaviour).
    _findEvent(eventId, account = null) {
        if (!eventId) return null;
        const matches = this.events.filter(ev => ev && String(ev.id) === String(eventId));
        if (matches.length < 2) return matches[0] || null;
        return matches.find(ev => ev.account === account) || matches[0];
    },

    formatTime(date) {
        if (!date) return '';
        const d = date instanceof Date ? date : new Date(date);
        const h = d.getHours();
        const m = d.getMinutes();
        const ampm = h >= 12 ? 'PM' : 'AM';
        const h12 = h % 12 || 12;
        return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
    },

    // Google (and the booking tools that write into it) put HTML in an
    // event's description — <b>, <br>, <a href>. Every surface that shows
    // one renders TEXT, so the tags used to read out literally ("<b>Booked
    // by</b>"). One converter, used by the detail card, the edit form and
    // the assistant's context block; links keep their URL.
    descriptionToText(desc) {
        let s = String(desc || '');
        if (!/<[a-z!/][^>]*>|&[a-z#][a-z0-9]{1,7};/i.test(s)) return s;
        s = s.replace(/<a\b[^>]*href=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) => {
            const t = text.replace(/<[^>]+>/g, '').trim();
            return (!t || t === href) ? href : `${t} (${href})`;
        });
        s = s.replace(/<br\s*\/?>/gi, '\n')
            .replace(/<(p|div|tr|ul|ol|h[1-6])\b[^>]*>/gi, '\n')
            .replace(/<li[^>]*>/gi, '\u2022 ')
            .replace(/<\/(p|div|li|tr|h[1-6]|ul|ol)\s*>/gi, '\n')
            .replace(/<[^>]+>/g, '');
        // A textarea decodes entities as RCDATA — nothing in it is parsed
        // as markup, so this is safe for text from an outside organizer.
        const ta = document.createElement('textarea');
        ta.innerHTML = s;
        s = ta.value;
        return s.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    },

};

// No page to register since 2026-10-05: AppManager.openApp('calendar') lands on Now.

// A chat ABOUT an event (recordKey `calendar:<calendarId>:<eventId>`, the
// "Open event" pills and the conversation banner) resolves the event's
// facts here. Calendar events are mostly user-authored, but invitation
// descriptions can include arbitrary text from external organizers — the
// event is still treated as trusted (the user accepted the invite to see it)
// and framing, not tool-blocking, carries that. The old page's "current
// event" provider went with the page (2026-10-05).
if (typeof AgentContext !== 'undefined') {
    AgentContext.registerRecord('calendar', (rest) => {
        const sep = String(rest || '').indexOf(':');
        const eventId = sep >= 0 ? rest.slice(sep + 1) : rest;
        const ev = CalendarApp._findEvent(eventId);
        if (!ev) return null;

        const start = ev.start || '';
        const end = ev.end || '';
        const desc = CalendarApp.descriptionToText(ev.description).slice(0, 1500);
        const evId = ev.id || '';
        const calendarId = ev.calendarId || 'primary';
        // Organizer, guests and their replies, the call, reminders, files…
        // one line per fact the event actually has (EventDetails.facts).
        const LABELS = { videoCall: 'Video call', dialIn: 'Dial in', url: 'Link', organizer: 'Organizer',
            attendees: 'Attendees', yourResponse: 'Your response', showAs: 'Show as', eventType: 'Type',
            visibility: 'Visibility', status: 'Status', reminders: 'Reminders', attachments: 'Attachments',
            timeZone: 'Time zone', openInGoogleCalendar: 'Google Calendar link' };
        const facts = typeof EventDetails !== 'undefined'
            ? EventDetails.facts(ev, CalendarApp.descriptionToText(ev.description), {
                localZone: Intl.DateTimeFormat().resolvedOptions().timeZone, withLinks: true }) : {};
        const extra = Object.entries(facts).map(([k, v]) =>
            `\n${LABELS[k] || k}: ${Array.isArray(v) ? v.join('; ') : v}`).join('');

        return {
            recordKey: 'calendar:' + calendarId + ':' + evId,
            recordLabel: ev.summary || '(event)',
            title: 'THIS CHAT\'S CALENDAR EVENT',
            body: `This chat is about the calendar event below. The event is available as context, not a constraint:

- When the user's question is about "this event", "this meeting", "this invite", or asks to reschedule / update / delete it, work with the data below. To modify it, call update_calendar_event with id: "${eventId}" (for one occurrence of a series, scope "this" or "all"). To delete, delete_calendar_event with the same id (mode "single", "following" or "all").
- For general questions, answer normally.

Title: ${ev.summary || '(untitled)'}
Start: ${start}
End: ${end}
Location: ${ev.location || '(none)'}${extra}
Calendar: ${calendarId}
Event id: ${evId}

Description:
${desc || '(none)'}`,
            suggestedPrompts: [
                'What is this meeting about?',
                'Help me prepare for this',
                'Draft an agenda'
            ]
        };
    });
}

// ⌘K + search_all rows. Reads the stored blob, not CalendarApp.events, so a
// search before the Calendar page has ever opened still finds events. A
// recurring series is ONE row (every expanded instance carries the same
// title and would otherwise fill the list): the next upcoming occurrence,
// else the most recent one. The same event on two connected accounts is
// one row too.
if (typeof GlobalSearch !== 'undefined' && GlobalSearch.registerSource) {
    GlobalSearch.registerSource('calendar', {
        label: 'Event',
        index(push, get) {
            const now = Date.now();
            const best = new Map();
            for (const e of get('calendar', 'events')) {
                if (!e || !e.id || !e.start) continue;
                const t = (typeof CalendarApp._parseEventDate === 'function')
                    ? CalendarApp._parseEventDate(e.start) : new Date(e.start);
                const ms = t ? t.getTime() : NaN;
                if (!Number.isFinite(ms)) continue;
                const key = e.recurringEventId ? `r:${e.recurringEventId}` : `e:${e.id}`;
                const cur = best.get(key);
                // Upcoming beats past; among upcoming the soonest, among
                // past the latest.
                const better = !cur
                    || (ms >= now && (cur.ms < now || ms < cur.ms))
                    || (ms < now && cur.ms < now && ms > cur.ms);
                if (better) best.set(key, { e, ms, t });
            }
            for (const { e, ms, t } of best.values()) {
                const desc = String(e.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
                const body = [e.location, desc].filter(Boolean).join(' ');
                const allDay = typeof e.start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.start);
                const sub = t.toLocaleDateString(undefined, {
                    weekday: 'short', month: 'short', day: 'numeric',
                    ...(t.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {})
                }) + (allDay ? '' : ' · ' + t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
                push(e.id, e.summary || '(untitled)', body, {
                    sub, account: e.account || null,
                    meta: { kind: 'event', start: new Date(ms).toISOString(),
                        ...(e.location ? { location: e.location } : {}),
                        ...(e.recurringEventId ? { recurring: true } : {}) }
                });
            }
        },
        open(hit) { CalendarApp.openEvent(hit.id, { account: hit.account }); }
    });
}
