/**
 * Pomodoro App
 *
 * Classic Pomodoro timer with cycle-aware focus/short-break/long-break
 * progression, today's stats, recent sessions, and a rotating quote pulled
 * from the package's own QuotesLibrary (quotes-library.js).
 */

const PomodoroApp = {
    // Persisted state
    settings: null,
    sessions: [],
    currentTask: '',
    linkedTaskId: null,         // optional Schedule app item id linked to current task
    parkingLot: [],             // thoughts parked mid-session: [{ id, text, at }]

    // Active timer state (volatile)
    mode: 'focus',              // 'focus' | 'short' | 'long'
    customDurations: {},        // per-mode one-off duration overrides (ms), set by clicking the time
    _editingTime: false,
    durationMs: 0,
    remainingMs: 0,
    isRunning: false,
    tickHandle: null,
    endsAt: null,               // wall-clock ms when running; null when paused
    cycleCount: 0,              // focus sessions completed since last long break

    quote: null,
    settingsOpen: false,
    _initialized: false,
    _eventsBound: false,
    _keyHandler: null,
    _taskModal: null,

    DEFAULT_SETTINGS: {
        focusMin: 25,
        shortBreakMin: 5,
        longBreakMin: 15,
        sessionsPerCycle: 4,
        autoStartBreaks: true,
        autoStartFocus: false,
        soundEnabled: true,
        notificationEnabled: true,
    },

    MODE_LABELS: {
        focus: 'Focus',
        short: 'Short Break',
        long: 'Long Break',
    },

    init() {
        this.loadData();
        if (!this._initialized) {
            this._initialized = true;
            if (!this._restoreTimer()) this.resetTimer();
            this.refreshQuote();
            // A restored running session (or the break a retroactive
            // completion auto-started) needs the tick even if the Pomodoro
            // view is never opened.
            if (this.isRunning) this.startTickLoop();
            this._syncFocusMode();
        }
    },

    loadData() {
        const data = StorageManager.get('pomodoro') || {};
        this.settings = { ...this.DEFAULT_SETTINGS, ...(data.settings || {}) };
        this.sessions = Array.isArray(data.sessions) ? data.sessions : [];
        // The task is a single value again. It was keyed by profile until
        // 2026-07-30 (`tasksByProfile`) so switching profiles never surfaced
        // another profile's task; profiles are gone, so the top-level pair is
        // the whole story. A legacy blob's default-profile entry is read once
        // here and then written back flat by saveData.
        this.currentTask = data.currentTask || data.tasksByProfile?.default?.currentTask || '';
        this.linkedTaskId = data.linkedTaskId || data.tasksByProfile?.default?.linkedTaskId || null;
        this.parkingLot = Array.isArray(data.parkingLot) ? data.parkingLot : [];
        this._pendingTimer = (data.timer && typeof data.timer === 'object') ? data.timer : null;
        this.cycleCount = this.completedFocusToday() % this.settings.sessionsPerCycle;
    },

    saveData() {
        StorageManager.set('pomodoro', {
            settings: this.settings,
            sessions: this.sessions,
            currentTask: this.currentTask,
            linkedTaskId: this.linkedTaskId,
            parkingLot: this.parkingLot,
            // Running/paused timer survives a refresh; endsAt is the
            // authoritative wall-clock deadline while running.
            timer: {
                mode: this.mode,
                isRunning: this.isRunning,
                endsAt: this.endsAt,
                remainingMs: this.remainingMs,
                durationMs: this.durationMs,
            },
        });
    },

    /**
     * Restore the persisted timer after a refresh/restart. Returns true when
     * a usable state existed. A session that ran out while the app wasn't
     * running is completed retroactively at its actual end time.
     */
    _restoreTimer() {
        const t = this._pendingTimer;
        this._pendingTimer = null;
        if (!t || !['focus', 'short', 'long'].includes(t.mode)) return false;
        this.mode = t.mode;
        this.durationMs = (t.durationMs > 0) ? t.durationMs : this.durationMsForMode(t.mode);

        if (t.isRunning && t.endsAt > 0) {
            const left = t.endsAt - Date.now();
            if (left > 0) {
                this.isRunning = true;
                this.endsAt = t.endsAt;
                this.remainingMs = left;
                // The linked task's own timer persisted through the refresh;
                // this is a no-op then, but restarts it if it was lost.
                if (this.mode === 'focus') this._setTaskTimer(true);
                return true;
            }
            // Ran out while the app was closed — credit the task only up to
            // the session's actual end (Date.now() would over-credit the
            // gap), then complete retroactively.
            this.isRunning = false;
            this.endsAt = null;
            this.remainingMs = 0;
            if (this.mode === 'focus') this._closeTaskTimerAt(t.endsAt);
            this.completeTimer(t.endsAt);
            return true;
        }

        // Paused or ready
        this.isRunning = false;
        this.endsAt = null;
        this.remainingMs = (t.remainingMs > 0 && t.remainingMs <= this.durationMs)
            ? t.remainingMs : this.durationMs;
        return true;
    },

    // Bank time on the linked task up to a specific wall-clock moment.
    _closeTaskTimerAt(endMs) {
        const item = this.linkedTask();
        if (!item || !item.timerStartedAt) return;
        this._schedule()?.stopTimerAt(item.id, endMs);
    },

    // ---------- Tasks app integration ----------
    // Pomodoro has no task model of its own — a session's task IS a Schedule
    // item. Focus sessions drive the item's built-in timer (timerStartedAt /
    // totalTimeSpent), so start/stop and accumulated time show up on the
    // task card in the Tasks app. Free text in the input is only scratch
    // until a focus session starts, at which point it becomes a real task.
    //
    // Everything goes through the 'schedule' API another package exposes
    // (Anjadhe.use — docs/PLATFORM.md "App packages"): this file holds no
    // reference to ScheduleApp, and with no such package installed the
    // timer simply runs without a task link.

    _schedule() {
        return (typeof Anjadhe !== 'undefined') ? Anjadhe.use('schedule') : null;
    },

    /**
     * Today's open tasks from the Tasks app, used to populate the picker.
     */
    getScheduleTasks() {
        const S = this._schedule();
        if (!S) return [];
        try {
            return S.todayTasks().map(t => ({
                id: t.id,
                title: t.title || '(untitled)',
                startTime: S.formatTime(t.startTime),
            }));
        } catch (_) {
            return [];
        }
    },

    linkedTask() {
        const S = this._schedule();
        if (!this.linkedTaskId || !S) return null;
        return S.getTask(this.linkedTaskId);
    },

    /**
     * Resolve the typed task label to a real Schedule item when a focus
     * session starts: reuse an open task with the same title today, else
     * create one in the Tasks app.
     */
    _ensureLinkedTask() {
        const S = this._schedule();
        if (!S) return;
        if (this.linkedTask()) return;
        this.linkedTaskId = null; // drop a stale link to a deleted task
        const title = (this.currentTask || '').trim();
        if (!title) return;
        const existing = S.todayTasks().find(t =>
            (t.title || '').trim().toLowerCase() === title.toLowerCase());
        this.linkedTaskId = existing ? existing.id : S.createTask(title);
        if (this.linkedTaskId) {
            this.saveData();
            if (!existing) UIUtils.showToast('Task added to Tasks', 'success');
        }
    },

    // Start/stop the linked task's own timer in the Tasks app. Idempotent,
    // so it's safe to call from every mode transition.
    _setTaskTimer(on) {
        const item = this.linkedTask();
        const S = this._schedule();
        if (!item || !S) return;
        try {
            if (on && !item.timerStartedAt) S.startTimer(item.id);
            else if (!on && item.timerStartedAt) S.stopTimer(item.id);
        } catch (_) { /* Tasks view may be mid-teardown; time is still safe in storage */ }
    },

    // After a focus session on a linked task, offer to check it off.
    async _offerMarkTaskDone() {
        const item = this.linkedTask();
        if (!item || item.resolved) return;
        const ok = await UIUtils.confirm(
            'Pomodoro complete',
            `Mark "${this.escape(item.title)}" as done in Tasks?`,
            '&#10003;',
            { cancelText: 'Still Working on it', confirmText: 'Mark Done' }
        );
        if (!ok) return;
        this._schedule()?.completeTask(item.id);
        this.currentTask = '';
        this.linkedTaskId = null;
        this.saveData();
        this.renderUI();
    },

    /**
     * Entry point for the Tasks app (detail-page Focus button and card play
     * buttons): start — or jump back to — a focus session for a specific
     * schedule item. Replaces the old free-running stopwatch.
     */
    startForTask(taskId) {
        if (!this._initialized) this.init();
        const item = this._schedule()?.getTask(taskId);
        if (!item) return;

        AppManager.openApp('pomodoro');

        // Already focusing this task: resume if paused, otherwise just land
        // on the running timer.
        if (this.mode === 'focus' && this.linkedTaskId === taskId) {
            if (!this.isRunning) this.startTimer();
            return;
        }

        this.setMode('focus', false); // closes out any other session / task timer
        this.linkedTaskId = taskId;
        this.currentTask = item.title || '';
        this.saveData();
        this.startTimer();
    },

    render() {
        Breadcrumb.render('pomodoro-breadcrumb', [
            { label: 'Pomodoro' },
        ]);
        this.renderUI();   // calls bindEvents() internally
        this.startTickLoop();
    },

    // ---------- Timer logic ----------

    durationMsForMode(mode) {
        if (this.customDurations[mode]) return this.customDurations[mode];
        return this.settingsDurationMs(mode);
    },

    settingsDurationMs(mode) {
        const m = mode === 'short' ? this.settings.shortBreakMin
                : mode === 'long'  ? this.settings.longBreakMin
                :                    this.settings.focusMin;
        return Math.max(1, m) * 60 * 1000;
    },

    setMode(mode, autoStart = false) {
        // Leaving (or restarting) focus closes out the linked task's timer,
        // so partial time from skips/resets still lands on the task.
        if (this.mode === 'focus') this._setTaskTimer(false);
        this.mode = mode;
        this.durationMs = this.durationMsForMode(mode);
        this.remainingMs = this.durationMs;
        this.isRunning = false;
        this.endsAt = null;
        if (autoStart) {
            this.startTimer();
        } else {
            this.saveData();
            this._syncFocusMode(); // before the paint: a phase change releases held notices the break view lists
            this.renderUI();
        }
    },

    resetTimer() {
        this.setMode(this.mode, false);
    },

    startTimer() {
        if (this.isRunning) return;
        if (this.mode === 'focus') this._ensureLinkedTask();
        this.isRunning = true;
        this.endsAt = Date.now() + this.remainingMs;
        if (this.mode === 'focus') this._setTaskTimer(true);
        // A new focus phase starts a fresh hold ledger.
        if (this.mode === 'focus' && typeof FocusMode !== 'undefined') FocusMode.clearReleased();
        this.saveData();
        this._syncFocusMode();
        this.renderUI();
    },

    pauseTimer() {
        if (!this.isRunning) return;
        this.remainingMs = Math.max(0, this.endsAt - Date.now());
        this.isRunning = false;
        this.endsAt = null;
        if (this.mode === 'focus') this._setTaskTimer(false);
        this.saveData();
        this._syncFocusMode();
        this.renderUI();
    },

    toggleStartPause() {
        if (this.isRunning) this.pauseTimer();
        else this.startTimer();
    },

    skipTimer() {
        // Move to next mode without logging current as completed
        this.advanceMode(false);
    },

    // ---------- Inline duration edit ----------

    canEditTime() {
        // Only before the timer has started — editing mid-session would
        // make "remaining" ambiguous.
        return !this.isRunning && this.remainingMs === this.durationMs;
    },

    /**
     * Swap the big time display for an inline input. Commits on Enter/blur,
     * cancels on Escape. The value becomes a one-off override for the
     * current mode (kept until the matching setting is changed); it is
     * volatile, so a restart falls back to settings.
     */
    startTimeEdit() {
        if (!this.canEditTime() || this._editingTime) return;
        const el = document.getElementById('pomodoro-time-display');
        if (!el) return;
        this._editingTime = true;

        const minutes = Math.round(this.durationMs / 60000);
        el.innerHTML = `<input id="pomodoro-time-edit" class="pomodoro-time-edit" type="text"
            inputmode="numeric" value="${minutes}" aria-label="Duration (minutes, or mm:ss)" />`;
        const input = el.querySelector('input');

        const finish = (commit) => {
            if (!this._editingTime) return;
            this._editingTime = false;
            if (commit) {
                const ms = this.parseDurationInput(input.value);
                if (ms) {
                    // An edit back to the settings value clears the override
                    // so later settings changes apply again.
                    if (ms === this.settingsDurationMs(this.mode)) delete this.customDurations[this.mode];
                    else this.customDurations[this.mode] = ms;
                    this.durationMs = ms;
                    this.remainingMs = ms;
                    this.saveData();
                }
            }
            this.renderUI();
        };
        input.addEventListener('keydown', (e) => {
            e.stopPropagation(); // keep Space from toggling the timer mid-type
            if (e.key === 'Enter') finish(true);
            else if (e.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
        input.focus();
        input.select();
    },

    // "10" → 10 minutes, "10:30" → 10m 30s. Clamped to 1 min – 3 h;
    // returns null when unparseable.
    parseDurationInput(raw) {
        const v = String(raw || '').trim();
        let ms = 0;
        const mmss = v.match(/^(\d{1,3}):([0-5]?\d)$/);
        if (mmss) ms = (parseInt(mmss[1]) * 60 + parseInt(mmss[2])) * 1000;
        else if (/^\d+(\.\d+)?$/.test(v)) ms = parseFloat(v) * 60000;
        if (!ms) return null;
        return Math.min(180 * 60000, Math.max(60000, Math.round(ms)));
    },

    completeTimer(endedAtMs = Date.now()) {
        const wasFocus = this.mode === 'focus';
        const completedAt = new Date(endedAtMs).toISOString();
        this.sessions.push({
            id: endedAtMs.toString(),
            type: this.mode,
            durationMin: Math.round(this.durationMs / 60000),
            startedAt: new Date(endedAtMs - this.durationMs).toISOString(),
            completedAt,
            taskLabel: wasFocus ? (this.currentTask || '').trim() : '',
            linkedTaskId: wasFocus ? (this.linkedTaskId || null) : null,
        });
        if (wasFocus) {
            this.cycleCount = (this.cycleCount + 1) % this.settings.sessionsPerCycle;
        }
        this.saveData();
        this.notifyEnd();
        this.advanceMode(true); // setMode inside stops the linked task's timer
        if (wasFocus) this._offerMarkTaskDone();
    },

    /**
     * Advance from the current mode to the next in the cycle.
     * @param {boolean} fromCompletion — true when called from completeTimer (governs auto-start)
     */
    advanceMode(fromCompletion) {
        let nextMode;
        if (this.mode === 'focus') {
            // After enough focuses, take a long break
            const justCompletedFocus = fromCompletion ? this.completedFocusToday() : this.completedFocusToday() + 1;
            const inCycle = justCompletedFocus % this.settings.sessionsPerCycle;
            nextMode = inCycle === 0 ? 'long' : 'short';
        } else {
            nextMode = 'focus';
        }
        const shouldAutoStart = fromCompletion && (
            (nextMode === 'focus' && this.settings.autoStartFocus) ||
            (nextMode !== 'focus' && this.settings.autoStartBreaks)
        );
        this.setMode(nextMode, shouldAutoStart);
    },

    /**
     * Tick loop — recomputes remainingMs from wall clock so it stays accurate
     * even if the tab is backgrounded or the user hops between views.
     */
    startTickLoop() {
        if (this.tickHandle) return;
        this.tickHandle = setInterval(() => {
            // Completion runs regardless of the active view so the session
            // is logged and the linked task's timer stops on time, not
            // whenever the user happens to come back to this view.
            if (this.isRunning) {
                const left = Math.max(0, this.endsAt - Date.now());
                this.remainingMs = left;
                if (left <= 0) {
                    this.completeTimer();
                    return;
                }
            }
            if (AppManager.currentApp !== 'pomodoro') return;
            this.updateLiveElements();
        }, 250);
    },

    // ---------- Stats ----------

    isToday(iso) {
        if (!iso) return false;
        const d = new Date(iso);
        const now = new Date();
        return d.getFullYear() === now.getFullYear()
            && d.getMonth() === now.getMonth()
            && d.getDate() === now.getDate();
    },

    todaysSessions() {
        return this.sessions.filter(s => this.isToday(s.completedAt));
    },

    completedFocusToday() {
        return this.todaysSessions().filter(s => s.type === 'focus').length;
    },

    minutesFocusedToday() {
        return this.todaysSessions()
            .filter(s => s.type === 'focus')
            .reduce((sum, s) => sum + (s.durationMin || 0), 0);
    },

    formatDuration(min) {
        if (min < 60) return `${min}m`;
        const h = Math.floor(min / 60);
        const m = min % 60;
        return m === 0 ? `${h}h` : `${h}h ${m}m`;
    },

    formatTime(ms) {
        const total = Math.max(0, Math.ceil(ms / 1000));
        const m = Math.floor(total / 60);
        const s = total % 60;
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    },

    formatRelative(iso) {
        const then = new Date(iso).getTime();
        const diffMin = Math.round((Date.now() - then) / 60000);
        if (diffMin < 1) return 'just now';
        if (diffMin < 60) return `${diffMin}m ago`;
        const diffHr = Math.round(diffMin / 60);
        if (diffHr < 24) return `${diffHr}h ago`;
        const diffDay = Math.round(diffHr / 24);
        return `${diffDay}d ago`;
    },

    // ---------- Quote ----------

    refreshQuote() {
        if (typeof QuotesLibrary === 'undefined') {
            this.quote = null;
            return;
        }
        const all = QuotesLibrary.search('');
        if (!all.length) {
            this.quote = null;
            return;
        }
        // Avoid repeating the same quote twice in a row when possible
        let next;
        for (let i = 0; i < 5; i++) {
            next = all[Math.floor(Math.random() * all.length)];
            if (!this.quote || next.text !== this.quote.text) break;
        }
        this.quote = next;
    },

    // ---------- Notifications & sound ----------

    notifyEnd() {
        const justFinished = this.MODE_LABELS[this.mode];
        if (this.settings.soundEnabled) this.playChime();
        if (this.settings.notificationEnabled && typeof Notification !== 'undefined') {
            try {
                if (Notification.permission === 'granted') {
                    const body = this.mode === 'focus'
                        ? 'Nice work. Time to step away.'
                        : 'Break\'s up. Ready for another round?';
                    // Local only (telegram:false) — the user is at this Mac by
                    // definition; kind 'task' so a focus session never holds
                    // its own end-of-round notice.
                    if (typeof Notify !== 'undefined') Notify.show(`${justFinished} complete`, body, { silent: true, telegram: false, kind: 'task' });
                    else new Notification(`${justFinished} complete`, { body, silent: true });
                } else if (Notification.permission !== 'denied') {
                    Notification.requestPermission();
                }
            } catch (_) { /* notifications may be unavailable in some sandboxes */ }
        }
    },

    playChime() {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            const ctx = new Ctx();
            const tones = this.mode === 'focus'
                ? [659.25, 783.99, 987.77]  // E5 G5 B5 — celebratory rising
                : [587.33, 493.88];          // D5 B4 — gentle two-tone for end of break
            tones.forEach((freq, i) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = freq;
                const t0 = ctx.currentTime + i * 0.18;
                gain.gain.setValueAtTime(0, t0);
                gain.gain.linearRampToValueAtTime(0.25, t0 + 0.04);
                gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.6);
                osc.connect(gain).connect(ctx.destination);
                osc.start(t0);
                osc.stop(t0 + 0.65);
            });
            setTimeout(() => ctx.close && ctx.close(), 1500);
        } catch (_) { /* audio may be blocked before any user gesture */ }
    },

    // ---------- Focus mode (app-wide) ----------

    /**
     * Tell the app what the session is doing (js/core/focus-mode.js). A
     * session EXISTS while the timer runs or sits paused mid-way; a reset
     * or an untouched timer is idle and the app goes back to normal.
     */
    _syncFocusMode() {
        if (typeof FocusMode === 'undefined') return;
        const live = this.isRunning || this.remainingMs < this.durationMs;
        if (!live) { FocusMode.exit(); return; }
        FocusMode.update({
            app: 'pomodoro',
            label: (this.currentTask || '').trim() || 'Focusing',
            phase: this.mode,
            running: this.isRunning,
            endsAt: this.endsAt,
            remainingMs: this.remainingMs,
        });
    },

    // ---------- Parking lot ----------
    // The technique's own rule: a thought that arrives mid-session is
    // written down and dealt with on the break. Items live on the blob,
    // each can become a task (Tasks app) in one click on the break.

    parkThought(text) {
        const t = String(text || '').trim();
        if (!t) return;
        this.parkingLot.push({ id: UIUtils.generateId(), text: t, at: new Date().toISOString() });
        this.saveData();
        this.renderUI();
    },

    unparkThought(id) {
        this.parkingLot = this.parkingLot.filter(p => p.id !== id);
        this.saveData();
        this.renderUI();
    },

    parkedToTask(id) {
        const p = this.parkingLot.find(x => x.id === id);
        const S = this._schedule();
        if (!p || !S) return;
        const created = S.createTask(p.text);
        if (created) UIUtils.showToast('Added to Tasks', 'success');
        this.unparkThought(id);
    },

    // ---------- Rendering ----------

    _phaseWord() {
        return this.mode === 'focus' ? 'Focus' : this.mode === 'long' ? 'Long break' : 'Short break';
    },

    _stateWord() {
        if (this.isRunning) return this.mode === 'focus' ? 'Stay with it' : 'Step away';
        return this.remainingMs < this.durationMs ? 'Paused' : 'Ready';
    },

    _ringGeometry() {
        const radius = 118;
        const circumference = 2 * Math.PI * radius;
        const progress = this.durationMs > 0 ? (this.durationMs - this.remainingMs) / this.durationMs : 0;
        return { radius, circumference, dashOffset: circumference * (1 - progress) };
    },

    _taskSessionsToday(taskId) {
        return this.todaysSessions().filter(s => s.type === 'focus' && s.linkedTaskId === taskId).length;
    },

    _fmtTracked(ms) {
        const min = Math.round((ms || 0) / 60000);
        if (min < 1) return null;
        return this.formatDuration(min);
    },

    /** The task block: linked → hero; free text → the pill input; break → what you come back to. */
    _taskHtml() {
        const esc = (v) => this.escape(v);
        const task = this.linkedTask();
        const onBreak = this.mode !== 'focus';
        if (task) {
            const tracked = this._fmtTracked((task.totalTimeSpent || 0) + (task.timerStartedAt ? Date.now() - new Date(task.timerStartedAt).getTime() : 0));
            const n = this._taskSessionsToday(task.id);
            const meta = [
                tracked ? `${tracked} on this task` : null,
                n ? `${n} session${n === 1 ? '' : 's'} today` : null,
            ].filter(Boolean);
            const eyebrow = onBreak ? 'Back to' : (task.project || 'Task');
            return `
                <div class="pomo-task is-linked">
                    <div class="pomo-task-eyebrow">${esc(eyebrow)}</div>
                    <button type="button" class="pomo-task-title" data-open-task="${esc(task.id)}" title="Open in Tasks">${esc(task.title || '(untitled)')}</button>
                    ${task.description && !onBreak ? `<p class="pomo-task-desc">${esc(task.description)}</p>` : ''}
                    <div class="pomo-task-meta">
                        ${meta.map(m => `<span>${esc(m)}</span>`).join('<span class="pomo-task-meta-sep">·</span>')}
                        ${!this.isRunning ? `<button type="button" class="pomo-link-btn" id="pomodoro-task-pick-btn">Change</button>` : ''}
                    </div>
                </div>`;
        }
        if (onBreak) {
            return `<div class="pomo-task is-break"><div class="pomo-task-eyebrow">Break</div><p class="pomo-break-copy">Stand up, look away from the screen, drink some water.</p></div>`;
        }
        return `
            <div class="pomo-task is-free">
                <div class="pomo-task-field">
                    <input id="pomodoro-task-input" type="text" class="pomo-task-input" placeholder="What are you working on?" value="${esc(this.currentTask)}" autocomplete="off" />
                    <button type="button" class="pomo-link-btn" id="pomodoro-task-pick-btn">From tasks</button>
                </div>
            </div>`;
    },

    _parkHtml() {
        const esc = (v) => this.escape(v);
        const onBreak = this.mode !== 'focus';
        const items = this.parkingLot;
        if (onBreak) {
            if (!items.length) return '';
            return `
                <section class="pomo-park is-break">
                    <div class="pomo-section-head">Parked during focus <span class="pomo-count">${items.length}</span></div>
                    <ul class="pomo-park-list">
                        ${items.map(p => `<li class="pomo-park-row">
                            <span class="pomo-park-text">${esc(p.text)}</span>
                            <span class="pomo-park-actions">
                                <button type="button" class="pomo-mini-btn" data-park-task="${esc(p.id)}">Make a task</button>
                                <button type="button" class="pomo-mini-btn is-ghost" data-park-drop="${esc(p.id)}" title="Let it go">Done</button>
                            </span>
                        </li>`).join('')}
                    </ul>
                </section>`;
        }
        return `
            <section class="pomo-park">
                <form class="pomo-park-form" id="pomodoro-park-form">
                    <input id="pomodoro-park-input" type="text" class="pomo-park-input" placeholder="Something on your mind? Park it for the break." autocomplete="off" />
                    <button type="submit" class="pomo-mini-btn">Park</button>
                </form>
                ${items.length ? `<ul class="pomo-park-chips">${items.map(p => `<li class="pomo-park-chip">${esc(p.text)}<button type="button" class="pomo-park-chip-x" data-park-drop="${esc(p.id)}" aria-label="Remove">&times;</button></li>`).join('')}</ul>` : ''}
            </section>`;
    },

    _heldHtml() {
        if (this.mode === 'focus' || typeof FocusMode === 'undefined') return '';
        const esc = (v) => this.escape(v);
        const held = FocusMode.lastReleased();
        if (!held.length) return '';
        return `
            <section class="pomo-held">
                <div class="pomo-section-head">While you focused <span class="pomo-count">${held.length}</span></div>
                <ul class="pomo-held-list">
                    ${held.slice(0, 6).map(h => `<li class="pomo-held-row"><span class="pomo-held-kind">${esc(h.kind)}</span><span class="pomo-held-title">${esc(h.title)}</span>${h.body ? `<span class="pomo-held-body">${esc(h.body.split('\n')[0])}</span>` : ''}</li>`).join('')}
                    ${held.length > 6 ? `<li class="pomo-held-more">+${held.length - 6} more</li>` : ''}
                </ul>
            </section>`;
    },

    _settingsHtml() {
        const s = this.settings;
        return `
            <div id="pomodoro-settings-panel" class="pomo-settings" ${this.settingsOpen ? '' : 'hidden'}>
                <div class="pomo-settings-col">
                    <div class="pomo-section-head">Durations</div>
                    <div class="pomo-settings-grid">
                        <label>Focus <span class="pomo-input-row"><input type="number" id="ps-focus" min="1" max="120" value="${s.focusMin}" /><span class="pomo-input-suffix">min</span></span></label>
                        <label>Short break <span class="pomo-input-row"><input type="number" id="ps-short" min="1" max="60" value="${s.shortBreakMin}" /><span class="pomo-input-suffix">min</span></span></label>
                        <label>Long break <span class="pomo-input-row"><input type="number" id="ps-long" min="1" max="60" value="${s.longBreakMin}" /><span class="pomo-input-suffix">min</span></span></label>
                        <label>Sessions per set <span class="pomo-input-row"><input type="number" id="ps-cycle" min="2" max="10" value="${s.sessionsPerCycle}" /></span></label>
                    </div>
                </div>
                <div class="pomo-settings-col">
                    <div class="pomo-section-head">Behavior</div>
                    <div class="pomo-settings-checks">
                        <label class="pomo-check"><input type="checkbox" id="ps-autobreak" ${s.autoStartBreaks ? 'checked' : ''}/> Auto-start breaks</label>
                        <label class="pomo-check"><input type="checkbox" id="ps-autofocus" ${s.autoStartFocus ? 'checked' : ''}/> Auto-start next focus session</label>
                        <label class="pomo-check"><input type="checkbox" id="ps-sound" ${s.soundEnabled ? 'checked' : ''}/> Play chime when timer ends</label>
                        <label class="pomo-check"><input type="checkbox" id="ps-notify" ${s.notificationEnabled ? 'checked' : ''}/> Show desktop notifications</label>
                    </div>
                </div>
            </div>`;
    },

    renderUI() {
        const root = document.getElementById('pomodoro-content');
        if (!root) return;
        const esc = (v) => this.escape(v);

        const focusCount = this.completedFocusToday();
        const focusMin = this.minutesFocusedToday();
        const breakCount = this.todaysSessions().filter(s => s.type !== 'focus').length;
        const cyclePos = this.cycleCount;
        const total = this.settings.sessionsPerCycle;
        const recent = [...this.todaysSessions()].reverse().slice(0, 6);

        // Set progress: one segment per session in the set, the current one lit.
        let segs = '';
        for (let i = 0; i < total; i++) {
            const filled = i < cyclePos;
            const current = i === cyclePos && this.mode === 'focus';
            segs += `<span class="pomo-set-seg${filled ? ' is-filled' : ''}${current ? ' is-current' : ''}"></span>`;
        }

        const effMin = (mode) => Math.round(this.durationMsForMode(mode) / 60000);
        const modes = [
            { key: 'focus', label: 'Focus', sub: `${effMin('focus')} min` },
            { key: 'short', label: 'Short break', sub: `${effMin('short')} min` },
            { key: 'long', label: 'Long break', sub: `${effMin('long')} min` },
        ];
        const modesHtml = modes.map(m => `
            <button type="button" class="pomo-mode${this.mode === m.key ? ' is-active' : ''}" data-mode="${m.key}" role="tab" aria-selected="${this.mode === m.key}">
                <span class="pomo-mode-label">${m.label}</span><span class="pomo-mode-sub">${m.sub}</span>
            </button>`).join('');

        const g = this._ringGeometry();
        const running = this.isRunning;
        const primary = running ? 'Pause' : (this.remainingMs < this.durationMs ? 'Resume' : (this.mode === 'focus' ? 'Start focus' : 'Start break'));

        const recentHtml = recent.length
            ? recent.map(s => {
                const label = s.type === 'focus' ? (s.taskLabel || 'Focus') : (s.type === 'long' ? 'Long break' : 'Short break');
                return `<li class="pomo-recent-row ${s.type === 'focus' ? 'is-focus' : 'is-break'}">
                    <span class="pomo-recent-dot" aria-hidden="true"></span>
                    <span class="pomo-recent-label" title="${esc(label)}">${esc(label)}</span>
                    <span class="pomo-recent-meta">${s.durationMin}m · ${this.formatRelative(s.completedAt)}</span>
                </li>`;
            }).join('')
            : '<li class="pomo-recent-empty">No sessions yet today.</li>';

        const quoteHtml = this.quote
            ? `<p class="pomo-quote-text">&ldquo;${esc(this.quote.text)}&rdquo;</p>
               <p class="pomo-quote-author">${esc(this.quote.author || 'Unknown')}</p>`
            : '';

        root.innerHTML = `
            ${this._settingsHtml()}
            <div class="pomo">
                <section class="pomo-stage" data-phase="${this.mode}" data-running="${running ? '1' : '0'}">
                    <header class="pomo-stage-head">
                        <div class="pomo-modes" role="tablist">${modesHtml}</div>
                        <div class="pomo-set" title="Long break after ${total} sessions">
                            <span class="pomo-set-segs">${segs}</span>
                            <span class="pomo-set-label">${cyclePos} of ${total}</span>
                        </div>
                    </header>

                    <div class="pomo-ring-wrap">
                        <svg class="pomo-ring" viewBox="0 0 260 260" aria-hidden="true">
                            <circle class="pomo-ring-track" cx="130" cy="130" r="${g.radius}"></circle>
                            <circle class="pomo-ring-progress" cx="130" cy="130" r="${g.radius}"
                                style="stroke-dasharray: ${g.circumference}; stroke-dashoffset: ${g.dashOffset};"></circle>
                        </svg>
                        <div class="pomo-time-stack">
                            <div class="pomo-phase">${this._phaseWord()}</div>
                            <div id="pomodoro-time-display" class="pomo-time${this.canEditTime() ? ' is-editable' : ''}"
                                 ${this.canEditTime() ? 'role="button" tabindex="0" title="Click to set a custom duration"' : ''}>${this.formatTime(this.remainingMs)}</div>
                            <div class="pomo-state">${this._stateWord()}</div>
                        </div>
                    </div>

                    ${this._taskHtml()}

                    <div class="pomo-controls">
                        <button id="pomodoro-startpause-btn" type="button" class="pomo-btn pomo-btn-primary">${primary}</button>
                        <button id="pomodoro-reset-btn" type="button" class="pomo-btn" ${this.remainingMs === this.durationMs && !running ? 'disabled' : ''}>Reset</button>
                        <button id="pomodoro-skip-btn" type="button" class="pomo-btn">Skip</button>
                    </div>

                    ${this._parkHtml()}
                    ${this._heldHtml()}

                    <p class="pomo-hint"><kbd>Space</kbd> start or pause · click the time to set a duration</p>
                </section>

                <aside class="pomo-rail">
                    <div class="pomo-card pomo-today">
                        <div class="pomo-section-head">Today</div>
                        <div class="pomo-stats">
                            <div class="pomo-stat"><span class="pomo-stat-num">${focusCount}</span><span class="pomo-stat-label">Sessions</span></div>
                            <div class="pomo-stat"><span class="pomo-stat-num">${this.formatDuration(focusMin)}</span><span class="pomo-stat-label">Focused</span></div>
                            <div class="pomo-stat"><span class="pomo-stat-num">${breakCount}</span><span class="pomo-stat-label">Breaks</span></div>
                        </div>
                    </div>
                    <div class="pomo-card">
                        <div class="pomo-section-head">Recent</div>
                        <ul class="pomo-recent">${recentHtml}</ul>
                    </div>
                    ${quoteHtml ? `<div class="pomo-card pomo-quote">
                        <div class="pomo-section-head">A thought
                            <button id="pomodoro-quote-refresh" type="button" class="pomo-icon-btn" title="Another" aria-label="Another thought"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><polyline points="21 3 21 9 15 9"/></svg></button>
                        </div>
                        ${quoteHtml}
                    </div>` : ''}
                </aside>
            </div>`;

        // innerHTML replaced every node above — rebind.
        this.bindEvents();
        this._syncFocusMode();
    },

    /** Kept for callers; the picker button now lives inside _taskHtml. */
    renderTaskPicker() { return ''; },

    openHelpModal() {
        const content = `
            <p class="pomodoro-help-lede">
                The Pomodoro Technique is a time-management method built around short,
                focused work intervals separated by deliberate breaks. It was developed
                by Francesco Cirillo in the late 1980s &mdash; "pomodoro" is Italian
                for tomato, named after the kitchen timer Cirillo used as a student.
            </p>

            <h4 class="pomodoro-help-heading">How it works</h4>
            <ol class="pomodoro-help-list">
                <li>Pick a task and start a focus session &mdash; <strong>25 minutes</strong> of uninterrupted work.</li>
                <li>When the timer ends, take a <strong>short break</strong> of about 5 minutes.</li>
                <li>After <strong>4 focus sessions</strong>, take a longer 15-minute break.</li>
                <li>Repeat. Adjust the durations in Settings if a different rhythm suits you.</li>
            </ol>

            <h4 class="pomodoro-help-heading">Why it helps</h4>
            <ul class="pomodoro-help-list">
                <li><strong>Lowers the bar to start.</strong> A 25-minute commitment is much easier to begin than "work on this all afternoon." The hardest part of focused work is starting.</li>
                <li><strong>Protects attention.</strong> Knowing a break is coming makes it easier to ignore notifications or the urge to switch tabs &mdash; you can defer interruptions to the next break.</li>
                <li><strong>Builds sustainable rhythm.</strong> Short cycles with built-in rest are more sustainable than long marathon sessions, which often end in fatigue and lower-quality output.</li>
                <li><strong>Creates visible progress.</strong> Counting completed sessions gives concrete feedback, even on tasks where the finish line isn't in sight.</li>
                <li><strong>Sharpens estimation.</strong> Over time you learn how many sessions a typical task takes &mdash; useful for planning.</li>
            </ul>

            <h4 class="pomodoro-help-heading">Tips for getting the most out of it</h4>
            <ul class="pomodoro-help-list">
                <li><strong>Single-task during the focus.</strong> No email, no chat, no quick lookups unrelated to the task. If something comes up, jot it down and handle it on the break.</li>
                <li><strong>Take real breaks.</strong> Stand up, look away from the screen, drink water. A break spent doomscrolling doesn't reset your attention.</li>
                <li><strong>Don't pause when distracted.</strong> Reset and start over. The discipline of the unbroken 25 is part of the value.</li>
                <li><strong>Pair it with a task.</strong> Use <em>From tasks</em> to link a task from the Tasks app so each session has a clear goal.</li>
            </ul>
        `;

        Modal.create({
            title: 'About the Pomodoro Technique',
            className: 'pomodoro-help-modal',
            content,
            buttons: [
                { text: 'Got it', className: 'primary-btn' },
            ],
        });
    },

    openTaskPickerModal() {
        const tasks = this.getScheduleTasks();
        const linkedId = this.linkedTaskId;

        let listHtml;
        if (tasks.length === 0) {
            listHtml = `
                <div class="pomodoro-task-modal-empty">
                    <p>No open tasks for today.</p>
                    <p class="pomodoro-task-modal-empty-hint">Add tasks in the Tasks app and they'll show up here.</p>
                </div>`;
        } else {
            listHtml = `
                <ul class="pomodoro-task-modal-list">
                    ${tasks.map(t => `
                        <li>
                            <button class="pomodoro-task-modal-item ${t.id === linkedId ? 'is-current' : ''}"
                                    data-task-id="${this.escape(t.id)}"
                                    data-task-title="${this.escape(t.title)}">
                                ${t.startTime
                                    ? `<span class="pomodoro-task-modal-time">${this.escape(t.startTime)}</span>`
                                    : '<span class="pomodoro-task-modal-time pomodoro-task-modal-time-empty">&mdash;</span>'}
                                <span class="pomodoro-task-modal-title">${this.escape(t.title)}</span>
                                ${t.id === linkedId ? '<span class="pomodoro-task-modal-current-badge">Current</span>' : ''}
                            </button>
                        </li>
                    `).join('')}
                </ul>`;
        }

        const content = `
            <p class="pomodoro-task-modal-intro">
                Pick a task from today's list to focus on. The session will be linked to that task when you finish.
            </p>
            ${listHtml}
        `;

        this._taskModal = Modal.create({
            title: 'Choose a task',
            className: 'pomodoro-task-modal',
            content,
            buttons: [
                {
                    text: 'Open Tasks',
                    className: 'secondary-btn',
                    onClick: () => {
                        this._taskModal?.close();
                        AppManager.openApp('actions');
                    },
                },
                {
                    text: 'Cancel',
                    className: 'secondary-btn',
                    onClick: () => this._taskModal?.close(),
                },
            ],
            onClose: () => { this._taskModal = null; },
        });

        this._taskModal.body.querySelectorAll('.pomodoro-task-modal-item').forEach(item => {
            item.addEventListener('click', () => {
                this.linkedTaskId = item.dataset.taskId;
                this.currentTask = item.dataset.taskTitle;
                this.saveData();
                this._taskModal?.close();
                this.renderUI();
            });
        });
    },

    updateLiveElements() {
        if (this._editingTime) return; // don't clobber the inline duration input
        const timeEl = document.getElementById('pomodoro-time-display');
        if (timeEl) timeEl.textContent = this.formatTime(this.remainingMs);

        const ring = document.querySelector('#pomodoro-content .pomo-ring-progress');
        if (ring) ring.style.strokeDashoffset = this._ringGeometry().dashOffset;

        const stateEl = document.querySelector('#pomodoro-content .pomo-state');
        if (stateEl) stateEl.textContent = this._stateWord();
    },

    bindEvents() {
        const root = document.getElementById('pomodoro-content');
        if (!root) return;

        root.querySelectorAll('.pomo-mode').forEach(tab => {
            tab.addEventListener('click', () => this.setMode(tab.dataset.mode, false));
        });

        root.querySelector('#pomodoro-startpause-btn')?.addEventListener('click', () => this.toggleStartPause());
        root.querySelector('#pomodoro-reset-btn')?.addEventListener('click', () => this.resetTimer());
        root.querySelector('#pomodoro-skip-btn')?.addEventListener('click', () => this.skipTimer());

        const timeDisplay = root.querySelector('#pomodoro-time-display');
        if (timeDisplay) {
            timeDisplay.addEventListener('click', () => this.startTimeEdit());
            timeDisplay.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); this.startTimeEdit(); }
            });
        }

        // Free-text task (no link yet)
        const taskInput = root.querySelector('#pomodoro-task-input');
        if (taskInput) {
            taskInput.addEventListener('input', () => { this.currentTask = taskInput.value; this.saveData(); });
            taskInput.addEventListener('keydown', (e) => {
                e.stopPropagation(); // Space types, never toggles the timer
                if (e.key === 'Enter') { e.preventDefault(); if (!this.isRunning) this.startTimer(); }
            });
        }

        // Linked task: the title opens it in Tasks; Change / From tasks picks another.
        root.querySelector('[data-open-task]')?.addEventListener('click', (e) => {
            const id = e.currentTarget.dataset.openTask;
            const S = this._schedule();
            if (S && S.openTask) S.openTask(id);
        });
        root.querySelector('#pomodoro-task-pick-btn')?.addEventListener('click', () => this.openTaskPickerModal());

        // Parking lot
        const parkForm = root.querySelector('#pomodoro-park-form');
        if (parkForm) {
            const input = parkForm.querySelector('#pomodoro-park-input');
            input?.addEventListener('keydown', (e) => e.stopPropagation());
            parkForm.addEventListener('submit', (e) => {
                e.preventDefault();
                const v = input?.value || '';
                if (!v.trim()) return;
                this.parkThought(v);
                // renderUI rebuilt the form; put the caret back for the next thought.
                document.getElementById('pomodoro-park-input')?.focus();
            });
        }
        root.querySelectorAll('[data-park-drop]').forEach(b => b.addEventListener('click', () => this.unparkThought(b.dataset.parkDrop)));
        root.querySelectorAll('[data-park-task]').forEach(b => b.addEventListener('click', () => this.parkedToTask(b.dataset.parkTask)));

        root.querySelector('#pomodoro-quote-refresh')?.addEventListener('click', () => { this.refreshQuote(); this.renderUI(); });

        const settingsBtn = document.getElementById('pomodoro-settings-btn');
        if (settingsBtn && !settingsBtn._pomodoroBound) {
            settingsBtn._pomodoroBound = true;
            settingsBtn.addEventListener('click', () => { this.settingsOpen = !this.settingsOpen; this.renderUI(); });
        }
        const helpBtn = document.getElementById('pomodoro-help-btn');
        if (helpBtn && !helpBtn._pomodoroBound) {
            helpBtn._pomodoroBound = true;
            helpBtn.addEventListener('click', () => this.openHelpModal());
        }
        this.bindSettingsInputs(root);

        if (!this._keyHandler) {
            this._keyHandler = (e) => {
                if (AppManager.currentApp !== 'pomodoro') return;
                if (e.code !== 'Space') return;
                const tag = (e.target?.tagName || '').toLowerCase();
                if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
                e.preventDefault();
                this.toggleStartPause();
            };
            document.addEventListener('keydown', this._keyHandler);
        }
    },

    bindSettingsInputs(root) {
        const handlers = [
            ['ps-focus',     'focusMin',           v => Math.max(1, Math.min(120, parseInt(v) || 25)), 'focus'],
            ['ps-short',     'shortBreakMin',      v => Math.max(1, Math.min(60,  parseInt(v) || 5)),  'short'],
            ['ps-long',      'longBreakMin',       v => Math.max(1, Math.min(60,  parseInt(v) || 15)), 'long'],
            ['ps-cycle',     'sessionsPerCycle',   v => Math.max(2, Math.min(10,  parseInt(v) || 4)),  null],
        ];
        handlers.forEach(([id, key, sanitize, modeKey]) => {
            const el = root.querySelector(`#${id}`);
            if (!el) return;
            el.addEventListener('change', () => {
                const next = sanitize(el.value);
                this.settings[key] = next;
                // A settings change wins over any inline one-off override.
                if (modeKey) delete this.customDurations[modeKey];
                this.saveData();
                // If editing the active mode's duration while idle, update its remaining
                if (!this.isRunning && this.remainingMs === this.durationMs) {
                    this.durationMs = this.durationMsForMode(this.mode);
                    this.remainingMs = this.durationMs;
                }
                this.cycleCount = this.completedFocusToday() % this.settings.sessionsPerCycle;
                this.renderUI();
            });
        });
        const checks = [
            ['ps-autobreak', 'autoStartBreaks'],
            ['ps-autofocus', 'autoStartFocus'],
            ['ps-sound',     'soundEnabled'],
            ['ps-notify',    'notificationEnabled'],
        ];
        checks.forEach(([id, key]) => {
            const el = root.querySelector(`#${id}`);
            if (!el) return;
            el.addEventListener('change', () => {
                this.settings[key] = el.checked;
                this.saveData();
                if (key === 'notificationEnabled' && el.checked
                    && typeof Notification !== 'undefined'
                    && Notification.permission === 'default') {
                    try { Notification.requestPermission(); } catch (_) {}
                }
            });
        });
    },

    escape(str) {
        return AppManager.escapeHtml(str || '');
    },
};

AppManager.register('pomodoro', PomodoroApp);

// What the Tasks app drives: its play button and the editor's Focus button
// act on whatever package exposes 'focusTimer' — with this one absent they
// fall back to the plain task timer.
if (typeof Anjadhe !== 'undefined') {
    Anjadhe.expose('focusTimer', {
        startForTask: (id) => PomodoroApp.startForTask(id),
        pause: () => PomodoroApp.pauseTimer(),
        isFocusing: (id) => PomodoroApp.isRunning && PomodoroApp.mode === 'focus' && PomodoroApp.linkedTaskId === id
    });
}
