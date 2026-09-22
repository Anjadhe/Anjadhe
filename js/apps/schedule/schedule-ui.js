/**
 * Schedule UI
 * Renders the schedule with grouped sections: Overdue, Today, This Week, Later
 */

const ScheduleUI = {
    /**
     * Render the Agenda view — tasks grouped by day (Overdue / Today /
     * Tomorrow / Upcoming).
     */
    renderAgenda(groups, app) {
        const container = document.getElementById('schedule-container');
        const emptyState = document.getElementById('schedule-empty');

        if (!container) return;

        const totalCount = groups.overdue.length + groups.todayActive.length +
                           groups.todayCompleted.length + groups.tomorrow.length + groups.later.length +
                           (groups.noDate ? groups.noDate.length : 0);

        if (totalCount === 0) {
            container.innerHTML = '';
            container.style.display = 'none';
            if (emptyState) {
                emptyState.style.display = '';
                this.renderEmptyState(emptyState, app);
            }
            return;
        }

        container.style.display = '';
        if (emptyState) emptyState.style.display = 'none';

        let html = '';

        if (groups.overdue.length > 0) {
            html += this.renderOverdueSection(groups.overdue, app);
        }

        // Today section with inline completed
        if (groups.todayActive.length > 0 || groups.todayCompleted.length > 0) {
            html += this.renderTodaySection(groups.todayActive, groups.todayCompleted, app);
        }

        if (groups.tomorrow.length > 0) {
            html += this.renderCollapsibleSection('Tomorrow', groups.tomorrow, app, 'tomorrow', app.showTomorrow);
        }

        // Later items — collapsible, grouped by date
        if (groups.later.length > 0) {
            html += this.renderLaterSection(groups, app);
        }

        // Undated "someday" tasks — collapsible, shown last.
        if (groups.noDate && groups.noDate.length > 0) {
            html += this.renderCollapsibleSection('No date', groups.noDate, app, 'nodate', app.showNoDate !== false);
        }

        container.innerHTML = html;
        this.attachEventListeners(app);

        // Overdue section toggle
        const overdueToggle = container.querySelector('.schedule-overdue-toggle');
        if (overdueToggle) {
            overdueToggle.addEventListener('click', () => {
                app.showOverdue = !app.showOverdue;
                const body = container.querySelector('.schedule-overdue-body');
                const arrow = overdueToggle.querySelector('.schedule-completed-arrow');
                body.style.display = app.showOverdue ? 'block' : 'none';
                arrow.innerHTML = app.showOverdue ? '&#9652;' : '&#9662;';
                overdueToggle.setAttribute('aria-expanded', app.showOverdue);
            });
        }

        // Overdue bulk action — push the whole backlog to today at once.
        const overduePushAll = container.querySelector('.schedule-overdue-pushall');
        if (overduePushAll) {
            overduePushAll.addEventListener('click', (e) => {
                e.stopPropagation();
                app.rescheduleAllOverdue();
            });
        }

        // Today section toggle
        const todayToggle = container.querySelector('.schedule-today-toggle');
        if (todayToggle) {
            todayToggle.addEventListener('click', () => {
                app.showToday = !app.showToday;
                const body = container.querySelector('.schedule-today-body');
                const arrow = todayToggle.querySelector('.schedule-completed-arrow');
                body.style.display = app.showToday ? 'block' : 'none';
                arrow.innerHTML = app.showToday ? '&#9652;' : '&#9662;';
                todayToggle.setAttribute('aria-expanded', app.showToday);
            });
        }

        // Today completed toggle
        const todayCompletedToggle = container.querySelector('.schedule-today-completed-toggle');
        if (todayCompletedToggle) {
            todayCompletedToggle.addEventListener('click', () => {
                app.showTodayCompleted = !app.showTodayCompleted;
                const cards = container.querySelector('.schedule-today-completed-cards');
                const arrow = todayCompletedToggle.querySelector('.schedule-completed-arrow');
                cards.style.display = app.showTodayCompleted ? 'block' : 'none';
                arrow.innerHTML = app.showTodayCompleted ? '&#9652;' : '&#9662;';
                todayCompletedToggle.setAttribute('aria-expanded', app.showTodayCompleted);
            });
        }

        // Tomorrow section toggle
        const tomorrowToggle = container.querySelector('.schedule-tomorrow-toggle');
        if (tomorrowToggle) {
            tomorrowToggle.addEventListener('click', () => {
                app.showTomorrow = !app.showTomorrow;
                const body = container.querySelector('.schedule-tomorrow-body');
                const arrow = tomorrowToggle.querySelector('.schedule-completed-arrow');
                body.style.display = app.showTomorrow ? 'block' : 'none';
                arrow.innerHTML = app.showTomorrow ? '&#9652;' : '&#9662;';
                tomorrowToggle.setAttribute('aria-expanded', app.showTomorrow);
            });
        }

        // Later section toggle
        const laterToggle = container.querySelector('.schedule-later-toggle');
        if (laterToggle) {
            laterToggle.addEventListener('click', () => {
                app.showLater = !app.showLater;
                const body = container.querySelector('.schedule-later-body');
                const arrow = laterToggle.querySelector('.schedule-later-arrow');
                body.style.display = app.showLater ? 'block' : 'none';
                arrow.innerHTML = app.showLater ? '&#9652;' : '&#9662;';
                laterToggle.setAttribute('aria-expanded', app.showLater);
            });
        }

        // No-date section toggle
        const noDateToggle = container.querySelector('.schedule-nodate-toggle');
        if (noDateToggle) {
            noDateToggle.addEventListener('click', () => {
                app.showNoDate = app.showNoDate === false ? true : false;
                const body = container.querySelector('.schedule-nodate-body');
                const arrow = noDateToggle.querySelector('.schedule-completed-arrow');
                body.style.display = app.showNoDate === false ? 'none' : 'block';
                arrow.innerHTML = app.showNoDate === false ? '&#9662;' : '&#9652;';
                noDateToggle.setAttribute('aria-expanded', app.showNoDate !== false);
            });
        }
    },

    /**
     * Render the List view — the full backlog for the current filter,
     * grouped by status (To Do / Completed) rather than by day. This is
     * the natural view for a focus area or goal, where the user wants the
     * whole picture rather than just what is due today.
     */
    renderListView(data, app) {
        const container = document.getElementById('schedule-container');
        const emptyState = document.getElementById('schedule-empty');
        if (!container) return;

        const total = data.todo.length + data.completed.length;
        if (total === 0) {
            container.innerHTML = '';
            container.style.display = 'none';
            if (emptyState) {
                emptyState.style.display = '';
                this.renderEmptyState(emptyState, app);
            }
            return;
        }

        container.style.display = '';
        if (emptyState) emptyState.style.display = 'none';

        let html = '';

        if (data.todo.length > 0) {
            html += `
                <div class="schedule-section">
                    <div class="schedule-section-header">
                        <span class="schedule-section-title">To Do</span>
                        <span class="schedule-section-count">${data.todo.length}</span>
                    </div>
                    <div class="schedule-section-cards">
                        ${data.todo.map(item => this.renderTaskCard(item, app, 'list')).join('')}
                    </div>
                </div>`;
        }

        if (data.completed.length > 0) {
            const expanded = app.showListCompleted;
            html += `
                <div class="schedule-section">
                    <button class="schedule-list-completed-toggle schedule-completed-toggle" aria-expanded="${expanded}">
                        <span class="schedule-section-title">Completed</span>
                        <span class="schedule-section-count">${data.completed.length}</span>
                        <span class="schedule-completed-arrow">${expanded ? '&#9652;' : '&#9662;'}</span>
                    </button>
                    <div class="schedule-list-completed-body schedule-section-cards schedule-section-completed" style="display: ${expanded ? 'block' : 'none'};">
                        ${data.completed.map(item => this.renderTaskCard(item, app, 'list-done')).join('')}
                    </div>
                </div>`;
        }

        container.innerHTML = html;
        this.attachEventListeners(app);

        const completedToggle = container.querySelector('.schedule-list-completed-toggle');
        if (completedToggle) {
            completedToggle.addEventListener('click', () => {
                app.showListCompleted = !app.showListCompleted;
                const body = container.querySelector('.schedule-list-completed-body');
                const arrow = completedToggle.querySelector('.schedule-completed-arrow');
                body.style.display = app.showListCompleted ? 'block' : 'none';
                arrow.innerHTML = app.showListCompleted ? '&#9652;' : '&#9662;';
                completedToggle.setAttribute('aria-expanded', app.showListCompleted);
            });
        }
    },

    /**
     * Sync the Agenda/List segmented control to the active view mode.
     */
    updateViewToggle(app) {
        const toggle = document.getElementById('schedule-view-toggle');
        if (!toggle) return;
        toggle.querySelectorAll('.schedule-view-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === app.viewMode);
        });
    },

    /**
     * Render Today section with inline completed subsection
     */
    renderTodaySection(active, completed, app) {
        const totalCount = active.length + completed.length;
        const countLabel = completed.length > 0
            ? `${completed.length}/${totalCount} done`
            : `${totalCount}`;
        const expanded = app.showToday;

        let html = `
            <div class="schedule-section schedule-section-today">
                <button class="schedule-today-toggle schedule-completed-toggle" aria-expanded="${expanded}">
                    <span class="schedule-section-title">Today</span>
                    <span class="schedule-section-count">${countLabel}</span>
                    <span class="schedule-completed-arrow">${expanded ? '&#9652;' : '&#9662;'}</span>
                </button>
                <div class="schedule-today-body" style="display: ${expanded ? 'block' : 'none'};">
                <div class="schedule-section-cards">
        `;

        for (const item of active) {
            html += this.renderTaskCard(item, app, 'today');
        }

        html += `</div>`;

        // Completed subsection within today
        if (completed.length > 0) {
            const completedExpanded = app.showTodayCompleted;
            html += `
                <button class="schedule-today-completed-toggle schedule-completed-toggle" aria-expanded="${completedExpanded}">
                    <span class="schedule-section-title">Completed</span>
                    <span class="schedule-section-count">${completed.length}</span>
                    <span class="schedule-completed-arrow">${completedExpanded ? '&#9652;' : '&#9662;'}</span>
                </button>
                <div class="schedule-today-completed-cards schedule-section-cards schedule-section-completed" style="display: ${completedExpanded ? 'block' : 'none'};">
                    ${completed.map(item => this.renderTaskCard(item, app, 'completed')).join('')}
                </div>
            `;
        }

        html += `</div></div>`;
        return html;
    },

    /**
     * Render a section with header and cards
     */
    renderSection(title, items, app, sectionType) {
        let html = `
            <div class="schedule-section schedule-section-${sectionType}">
                <div class="schedule-section-header">
                    <span class="schedule-section-title">${title}</span>
                    <span class="schedule-section-count">${items.length}</span>
                </div>
                <div class="schedule-section-cards">
        `;

        for (const item of items) {
            html += this.renderTaskCard(item, app, sectionType);
        }

        html += `
                </div>
            </div>
        `;
        return html;
    },

    /**
     * Render the Overdue section — like a collapsible section, but its header
     * carries a "Push to today" bulk action next to the collapse toggle. The
     * toggle keeps the same classes the agenda wiring expects.
     */
    renderOverdueSection(items, app) {
        const expanded = app.showOverdue;
        let html = `
            <div class="schedule-section schedule-section-overdue">
                <div class="schedule-overdue-header">
                    <button class="schedule-overdue-toggle schedule-completed-toggle" aria-expanded="${expanded}">
                        <span class="schedule-section-title">Overdue</span>
                        <span class="schedule-section-count">${items.length}</span>
                        <span class="schedule-completed-arrow">${expanded ? '&#9652;' : '&#9662;'}</span>
                    </button>
                    <button class="schedule-overdue-pushall" title="Move all overdue tasks to today">Push to today</button>
                </div>
                <div class="schedule-overdue-body" style="display: ${expanded ? 'block' : 'none'};">
                    <div class="schedule-section-cards">
        `;
        for (const item of items) html += this.renderTaskCard(item, app, 'overdue');
        html += `
                    </div>
                </div>
            </div>
        `;
        return html;
    },

    /**
     * Render a collapsible section (default collapsed)
     */
    renderCollapsibleSection(title, items, app, sectionType, expanded) {
        let html = `
            <div class="schedule-section schedule-section-${sectionType}">
                <button class="schedule-${sectionType}-toggle schedule-completed-toggle" aria-expanded="${expanded}">
                    <span class="schedule-section-title">${title}</span>
                    <span class="schedule-section-count">${items.length}</span>
                    <span class="schedule-completed-arrow">${expanded ? '&#9652;' : '&#9662;'}</span>
                </button>
                <div class="schedule-${sectionType}-body" style="display: ${expanded ? 'block' : 'none'};">
                    <div class="schedule-section-cards">
        `;
        for (const item of items) {
            html += this.renderTaskCard(item, app, sectionType);
        }
        html += `
                    </div>
                </div>
            </div>
        `;
        return html;
    },

    /**
     * Render the Later section — collapsible header with items grouped by date
     */
    renderLaterSection(groups, app) {
        const expanded = app.showLater;
        const count = groups.later.length;
        const todayStr = app.getLocalToday();

        // Build a compact summary of upcoming dates for the collapsed state
        const dateCount = groups.laterDates.length;
        const summaryDates = groups.laterDates.slice(0, 3).map(d => this.formatRelativeDate(d, todayStr));
        const summaryText = dateCount > 3
            ? summaryDates.join(', ') + ` +${dateCount - 3} more`
            : summaryDates.join(', ');

        let html = `
            <div class="schedule-section schedule-section-later">
                <button class="schedule-later-toggle" aria-expanded="${expanded}">
                    <span class="schedule-section-title">Upcoming</span>
                    <span class="schedule-section-count">${count}</span>
                    <span class="schedule-later-summary">${summaryText}</span>
                    <span class="schedule-later-arrow">${expanded ? '&#9652;' : '&#9662;'}</span>
                </button>
                <div class="schedule-later-body" style="display: ${expanded ? 'block' : 'none'};">
        `;

        for (const dateStr of groups.laterDates) {
            const items = groups.laterByDate[dateStr];
            const dateLabel = this.formatLaterDateHeading(dateStr, todayStr);

            html += `<div class="schedule-later-date-group">`;
            html += `<div class="schedule-later-date-heading">${dateLabel}</div>`;
            html += `<div class="schedule-section-cards">`;
            for (const item of items) {
                html += this.renderTaskCard(item, app, 'later');
            }
            html += `</div></div>`;
        }

        html += `</div></div>`;
        return html;
    },

    /**
     * Format a date heading for the later section (more descriptive than the card label)
     */
    formatLaterDateHeading(dateStr, todayStr) {
        const date = new Date(dateStr + 'T00:00:00');
        const today = new Date(todayStr + 'T00:00:00');
        const diffDays = Math.round((date - today) / (1000 * 60 * 60 * 24));

        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                           'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

        const dayOfWeek = dayNames[date.getDay()];
        const monthDay = `${monthNames[date.getMonth()]} ${date.getDate()}`;

        if (diffDays <= 6) {
            return `${dayOfWeek}, ${monthDay}`;
        }

        // Check if same year
        if (date.getFullYear() === today.getFullYear()) {
            return `${dayOfWeek}, ${monthDay}`;
        }

        return `${dayOfWeek}, ${monthDay}, ${date.getFullYear()}`;
    },

    /**
     * Render a single task card
     */
    renderTaskCard(item, app, sectionType) {
        const isOneTime = !item.repeat || item.repeat === 'none';
        const isRecurring = !isOneTime;
        // A recurring task shown ahead of its occurrence (Upcoming / Overdue /
        // No-date) reflects a FUTURE occurrence, which can't be "done today" —
        // completing it on a non-occurrence day must not strike it out there.
        const futureSection = sectionType === 'later' || sectionType === 'overdue' || sectionType === 'nodate';
        // Abandoned = deliberately not done. Resolved exactly like completed
        // (checked, struck, no reschedule) — it just keeps an honest badge.
        const abandoned = (sectionType === 'tomorrow' || (isRecurring && futureSection)) ? false
            : (isOneTime
                ? (!item.lastCompletedDate && !!app.lastAbandonedDate(item))
                : app.isAbandonedToday(item));
        const completed = sectionType === 'tomorrow' ? false
            : sectionType === 'list-done' ? true
            : (isRecurring && futureSection) ? false
            : (app.isCompletedToday(item) || abandoned);
        const timeDisplay = this.formatTimeRange(item.startTime, item.endTime);
        const repeatLabel = this.getRepeatLabel(item);
        const isEmailSource = item.source === 'email';
        const reminderLabel = this.getReminderLabel(item);
        const todayDate = app.getLocalToday();

        // The date to show. Recurring monthly/annual tasks display their NEXT
        // occurrence, not their never-advancing anchor date.
        const shownDate = isRecurring ? app.nextOccurrenceDate(item, todayDate) : item.scheduledDate;

        // Date context for non-today items
        let dateLabel = '';
        if (sectionType !== 'today' && sectionType !== 'tomorrow' && sectionType !== 'completed' && shownDate) {
            dateLabel = this.formatRelativeDate(shownDate, todayDate);
        }

        // Urgency: the Overdue agenda section, or a past-due one-time task
        // surfaced in the List view (which has no separate Overdue group).
        const listOverdue = sectionType === 'list' && !completed && isOneTime &&
            item.scheduledDate && item.scheduledDate < todayDate;
        const overdueClass = (sectionType === 'overdue' || listOverdue) ? 'schedule-card-overdue' : '';

        // Highlight task with active timer
        const currentClass = item.timerStartedAt ? 'schedule-card-current' : '';

        // Linked goal badge
        const linkedGoal = LinkManager.getGoalForTask(item.id);
        const goalBadgeHtml = linkedGoal
            ? `<span class="schedule-goal-badge" data-goal-id="${linkedGoal.itemId}" title="Project: ${UIUtils.escapeHtml(linkedGoal.title)}">${UIUtils.escapeHtml(linkedGoal.title)}</span>`
            : '';

        // Timer
        const elapsed = app.getElapsedMs(item);
        const isRunning = !!item.timerStartedAt;
        let timerHtml = '';

        if (!completed) {
            if (isRunning) {
                timerHtml = `<button class="schedule-timer-btn schedule-timer-running" data-item-id="${item.id}" onclick="event.stopPropagation()">
                    <span class="schedule-timer-display" data-item-id="${item.id}" data-timer-running="true">${app.formatDurationLive(elapsed)}</span>
                    <span class="schedule-timer-icon">&#9632;</span>
                </button>`;
            } else if (elapsed > 0) {
                timerHtml = `<button class="schedule-timer-btn" data-item-id="${item.id}" onclick="event.stopPropagation()">
                    <span class="schedule-timer-display" data-item-id="${item.id}">${app.formatDuration(elapsed)}</span>
                    <span class="schedule-timer-icon">&#9654;</span>
                </button>`;
            } else {
                timerHtml = `<button class="schedule-timer-btn schedule-timer-idle" data-item-id="${item.id}" onclick="event.stopPropagation()">
                    <span class="schedule-timer-icon">&#9654;</span>
                </button>`;
            }
        } else if (elapsed > 0) {
            timerHtml = `<span class="schedule-timer-badge-static">${app.formatDuration(elapsed)}</span>`;
        }

        // Time/date column — omitted entirely for an untimed task with no
        // date context, so the card collapses to just checkbox + title.
        let timeBlock = '';
        if (timeDisplay || dateLabel) {
            timeBlock = `<div class="schedule-card-time">
                    ${timeDisplay ? `<span class="schedule-time-text">${timeDisplay}</span>` : ''}
                    ${dateLabel ? `<span class="schedule-date-label">${timeDisplay ? '&middot; ' : ''}${dateLabel}</span>` : ''}
                </div>`;
        }

        return `
            <div class="schedule-card ${completed ? 'completed' : ''} ${isEmailSource ? 'schedule-card-email' : ''} ${overdueClass} ${currentClass}" data-item-id="${item.id}">
                <label class="schedule-checkbox-label" onclick="event.stopPropagation()">
                    <input type="checkbox" class="schedule-checkbox" data-item-id="${item.id}" ${completed ? 'checked' : ''}${abandoned ? ' data-abandoned="1"' : ''}${abandoned ? ' title="Abandoned — uncheck to restore"' : ''}>
                </label>
                ${timeBlock}
                <span class="schedule-task-title">${UIUtils.escapeHtml(item.title)}</span>
                <div class="schedule-card-badges">
                    ${abandoned ? '<span class="schedule-abandoned-badge">Abandoned</span>' : ''}
                    ${goalBadgeHtml}
                    ${isEmailSource ? '<span class="schedule-email-badge">Email</span>' : ''}
                    ${repeatLabel ? `<span class="schedule-repeat-badge">${repeatLabel}</span>` : ''}
                    ${reminderLabel ? `<span class="schedule-notify-badge">${reminderLabel}</span>` : ''}
                    ${!reminderLabel && item.notifyBefore ? `<span class="schedule-notify-badge">${item.notifyBefore}min before</span>` : ''}
                </div>
                ${!completed ? `<button class="schedule-reschedule-btn" data-item-id="${item.id}" title="Reschedule" aria-label="Reschedule" onclick="event.stopPropagation()">&#8943;</button>` : ''}
                ${timerHtml}
            </div>
        `;
    },

    // --- Formatters ---

    formatTime(timeStr) {
        if (!timeStr || typeof timeStr !== 'string') return '';
        const parts = timeStr.split(':').map(Number);
        const h = parts[0];
        const m = Number.isFinite(parts[1]) ? parts[1] : 0;
        if (!Number.isFinite(h)) return '';
        const period = h >= 12 ? 'PM' : 'AM';
        const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
        return `${hour12}:${m.toString().padStart(2, '0')} ${period}`;
    },

    // Compact, four-case time text: "8:30–9:00 AM" (shared meridiem said
    // once), "9:00 AM–12:00 PM", "9:00 AM" (start only), "by 12:00 PM"
    // (end only — reads as a deadline), '' (untimed).
    formatTimeRange(startTime, endTime) {
        const start = this.formatTime(startTime);
        const end = this.formatTime(endTime);
        if (!end) return start;
        if (!start) return `by ${end}`;
        const sameMeridiem = start.slice(-2) === end.slice(-2);
        return `${sameMeridiem ? start.slice(0, -3) : start}–${end}`;
    },

    formatRelativeDate(dateStr, todayStr) {
        const date = new Date(dateStr + 'T00:00:00');
        const today = new Date(todayStr + 'T00:00:00');
        const diffDays = Math.round((date - today) / (1000 * 60 * 60 * 24));

        if (diffDays === 0) return 'Today';
        if (diffDays === 1) return 'Tomorrow';
        if (diffDays === -1) return 'Yesterday';
        if (diffDays < -1) return `${Math.abs(diffDays)} days ago`;

        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        if (diffDays <= 6) return dayNames[date.getDay()];

        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                           'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const monthDay = `${monthNames[date.getMonth()]} ${date.getDate()}`;
        return date.getFullYear() === today.getFullYear()
            ? monthDay
            : `${monthDay}, ${date.getFullYear()}`;
    },

    getRepeatLabel(item) {
        switch (item.repeat) {
            case 'daily': return 'Daily';
            case 'weekdays': return 'Weekdays';
            case 'weekly': {
                const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                return `Every ${days[item.dayOfWeek || 0]}`;
            }
            case 'custom': {
                const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                return (item.repeatDays || []).map(d => days[d]).join(', ');
            }
            case 'monthly': {
                if (item.scheduledDate) {
                    const day = parseInt(item.scheduledDate.split('-')[2]);
                    const suffix = day === 1 || day === 21 || day === 31 ? 'st' : day === 2 || day === 22 ? 'nd' : day === 3 || day === 23 ? 'rd' : 'th';
                    return `Monthly (${day}${suffix})`;
                }
                return 'Monthly';
            }
            case 'annually': {
                if (item.scheduledDate) {
                    const parts = item.scheduledDate.split('-');
                    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                                       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                    return `Annually (${monthNames[parseInt(parts[1]) - 1]} ${parseInt(parts[2])})`;
                }
                return 'Annually';
            }
            default: return '';
        }
    },

    getReminderLabel(item) {
        if (!item.reminderDaysBefore?.length) return '';
        const days = item.reminderDaysBefore.filter(d => d > 0).sort((a, b) => b - a);
        if (days.length === 0) return '';
        if (days.length === 1) return `${days[0]}d before`;
        return `${days[0]}d, ${days.slice(1).join('d, ')}d before`;
    },

    // --- Event listeners ---

    attachEventListeners(app) {
        document.querySelectorAll('#schedule-container .schedule-card').forEach(card => {
            card.addEventListener('click', () => {
                app.openEditor(card.dataset.itemId);
            });
            // Right-click anywhere on an open task opens the quick reschedule
            // menu (completed cards are excluded — they aren't reschedulable).
            if (!card.classList.contains('completed')) {
                card.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    this.showRescheduleMenu(e.clientX, e.clientY, card.dataset.itemId, app);
                });
            }
        });

        // Reschedule button (⋯) — hover-revealed on each open card.
        document.querySelectorAll('#schedule-container .schedule-reschedule-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const r = btn.getBoundingClientRect();
                this.showRescheduleMenu(r.right, r.bottom + 4, btn.dataset.itemId, app);
            });
        });

        document.querySelectorAll('#schedule-container .schedule-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                e.stopPropagation();
                // An abandoned card's checkbox restores the task (clears the
                // abandoned mark); toggleComplete would mark it done instead.
                if (checkbox.dataset.abandoned) app.toggleAbandoned(checkbox.dataset.itemId);
                else app.toggleComplete(checkbox.dataset.itemId);
            });
        });

        // Goal badge click — navigate to goal viewer
        document.querySelectorAll('#schedule-container .schedule-goal-badge').forEach(badge => {
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                const goalId = badge.dataset.goalId;
                LinkedItemsUI.navigateToItem('goals', goalId);
            });
        });

        // Timer buttons — time tracking goes through Pomodoro now. Play
        // starts a focus session for the task; stop pauses that session so
        // the pomodoro and the task timer stay in step. A timer started
        // outside a session (legacy state) still stops directly.
        document.querySelectorAll('#schedule-container .schedule-timer-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.dataset.itemId;
                const item = app.scheduleItems.find(i => i.id === id);
                // Whatever package exposes 'focusTimer' (Pomodoro) — none
                // installed means the plain task timer.
                const focus = (typeof Anjadhe !== 'undefined') ? Anjadhe.use('focusTimer') : null;
                if (!item?.timerStartedAt && focus) {
                    focus.startForTask(id);
                } else if (item?.timerStartedAt && focus && focus.isFocusing(id)) {
                    focus.pause();
                } else {
                    app.toggleTimer(id);
                }
            });
        });

        // Email source links — navigate to the source email
        document.querySelectorAll('#schedule-container .schedule-email-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.stopPropagation();
                app.navigateToSourceEmail(link.dataset.emailId);
            });
        });
    },

    /**
     * Fill the empty state with a message appropriate to why the list is
     * empty — no tasks at all, none matching the search, or none under the
     * selected focus/goal sidebar filter.
     */
    renderEmptyState(el, app) {
        const hasAnyTasks = (app.scheduleItems || []).length > 0;
        const filter = app.activeFilter || { type: 'all' };
        let icon = '🕐';
        let heading = 'No scheduled tasks yet';
        let body = 'Click "New Task" to add your first scheduled task';

        if (hasAnyTasks && app.searchQuery) {
            icon = '🔍';
            heading = 'No matching tasks';
            body = 'No tasks match your search.';
        } else if (hasAnyTasks && filter.type === 'unassigned') {
            heading = 'Nothing unassigned';
            body = 'Every task is linked to a project.';
        } else if (hasAnyTasks && filter.type === 'goal') {
            heading = 'No tasks here yet';
            body = 'No tasks are linked to this project.';
        }

        el.innerHTML = `<span class="empty-icon">${icon}</span>
            <h3>${UIUtils.escapeHtml(heading)}</h3>
            <p>${UIUtils.escapeHtml(body)}</p>`;
    },

    // ===================================
    // Quick reschedule menu
    // ===================================

    /**
     * Pop up the reschedule menu for a task at viewport coords (x, y). Options
     * move the task without opening the editor; "Pick date…" opens a native
     * date picker. Closes on outside click, Escape, or after a choice.
     */
    showRescheduleMenu(x, y, itemId, app) {
        this.closeRescheduleMenu();
        const item = app.scheduleItems.find(i => i.id === itemId);
        if (!item) return;

        const rows = [
            { key: 'today', label: 'Today' },
            { key: 'tomorrow', label: 'Tomorrow' },
            { key: 'weekend', label: 'This weekend' },
            { key: 'nextweek', label: 'Next week' },
            { key: 'pick', label: 'Pick date&hellip;' },
            { sep: true },
            { key: 'none', label: 'No date' }
        ];
        const menu = document.createElement('div');
        menu.className = 'schedule-menu';
        menu.innerHTML = rows.map(r => r.sep
            ? '<div class="schedule-menu-sep"></div>'
            : `<button type="button" class="schedule-menu-item" data-key="${r.key}">${r.label}</button>`
        ).join('');
        document.body.appendChild(menu);

        // Clamp to viewport.
        const rect = menu.getBoundingClientRect();
        const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
        const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;

        menu.querySelectorAll('.schedule-menu-item').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const key = btn.dataset.key;
                if (key === 'pick') { this._pickRescheduleDate(itemId, app, item, left, top); this.closeRescheduleMenu(); return; }
                app.rescheduleTask(itemId, key);
                this.closeRescheduleMenu();
            });
        });

        // Defer outside-click/Esc binding so the opening click doesn't close it.
        const onDoc = (e) => { if (!menu.contains(e.target)) this.closeRescheduleMenu(); };
        const onKey = (e) => { if (e.key === 'Escape') this.closeRescheduleMenu(); };
        this._menuCleanup = () => {
            document.removeEventListener('mousedown', onDoc, true);
            document.removeEventListener('keydown', onKey, true);
        };
        setTimeout(() => {
            document.addEventListener('mousedown', onDoc, true);
            document.addEventListener('keydown', onKey, true);
        }, 0);
        this._rescheduleMenu = menu;
    },

    closeRescheduleMenu() {
        if (this._menuCleanup) { this._menuCleanup(); this._menuCleanup = null; }
        if (this._rescheduleMenu && this._rescheduleMenu.parentNode) {
            this._rescheduleMenu.parentNode.removeChild(this._rescheduleMenu);
        }
        this._rescheduleMenu = null;
    },

    /**
     * Open a native date picker for "Pick date…". The input is placed at the
     * menu's position (visually transparent) so the picker anchors sensibly.
     */
    _pickRescheduleDate(itemId, app, item, left, top) {
        const input = document.createElement('input');
        input.type = 'date';
        input.value = item.scheduledDate || app.getLocalToday();
        input.className = 'schedule-pickdate-hidden';
        input.style.left = `${left}px`;
        input.style.top = `${top}px`;
        document.body.appendChild(input);

        const cleanup = () => { if (input.parentNode) input.parentNode.removeChild(input); };
        input.addEventListener('change', () => {
            if (input.value) app.rescheduleTask(itemId, input.value);
            cleanup();
        });
        input.addEventListener('blur', () => setTimeout(cleanup, 200));
        if (input.showPicker) { try { input.showPicker(); } catch { input.focus(); } }
        else input.focus();
    }
};
