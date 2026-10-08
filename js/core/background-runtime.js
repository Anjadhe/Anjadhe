/* Native lifecycle controls. The scheduler consults main at each work boundary.
 * The owner window also tells main what it has SCHEDULED (`scheduledWork`,
 * every 5 s, sent on change): armed routines or a running job. Main holds a
 * sleep assertion while that is true, so a routine due at 8:00 runs on a Mac
 * nobody touched since 7:40, on battery or not (2026-10-07, by request). The
 * display still sleeps; Pause scheduled routines releases it. */
const BackgroundRuntime = {
    init() {
        if (this._inited || !window.electronBackground) return;
        this._inited = true;
        const bridge = window.electronBackground;
        this._state = bridge.state();
        bridge.onChange(state => {
            const promoted = state.owner && !this._state?.owner;
            this._state = state;
            this.renderSettings();
            if (typeof SimpleSettings !== 'undefined' && SimpleSettings.refreshBackground) SimpleSettings.refreshBackground();
            if (state.owner && !state.paused && typeof RoutineEngine !== 'undefined') {
                if (promoted) { RoutineEngine.load(); RoutineEngine.loadLocal(); }
                RoutineEngine._ensureMailSync();
                RoutineEngine.tick();
                // A promoted window picks up queued team jobs (routine runs too).
                if (typeof WorkroomEngine !== 'undefined') WorkroomEngine.tick();
            }
        });
        bridge.onOpen(route => {
            if (route === 'updates' && typeof SimpleExperience !== 'undefined' && document.body.classList.contains('simple-experience')) AppManager.openApp('updates');
            else AppManager.showDashboard();
        });
        this.renderSettings();
        this._timer = setInterval(() => {
            if (!this._state?.owner) return;
            const jobs = typeof TeamJobs !== 'undefined' ? TeamJobs.all().filter(t => t.engine === 'team') : [];
            this.reportAwake(jobs);
            if (!this._state?.enabled) return;
            const attention = jobs.some(job => job.status === 'awaiting_user');
            const running = (typeof RoutineEngine !== 'undefined' && RoutineEngine._busy)
                || jobs.some(job => job.routineId && job.status === 'running');
            const working = jobs.some(job => job.conversationId && job.status === 'running');
            bridge.status(attention ? 'Needs your attention' : running ? 'Running a routine' : working ? 'Working on a job' : 'Idle');
        }, 5000);
    },
    /** What this window has scheduled, as a fact main can hold the Mac awake on: `{ hold, reason }`. */
    scheduledWork(jobs) {
        let routines = 0;
        try { if (typeof RoutineEngine !== 'undefined') routines = RoutineEngine.armedRoutines().length; } catch { routines = 0; }
        const running = (jobs || []).filter(job => job.status === 'running').length;
        if (!routines && !running) return { hold: false, reason: '' };
        const parts = [];
        if (routines) parts.push(`${routines} ${routines === 1 ? 'routine is' : 'routines are'} scheduled`);
        if (running) parts.push(`${running} ${running === 1 ? 'job is' : 'jobs are'} running`);
        return { hold: true, reason: parts.join(', ') };
    },
    reportAwake(jobs) {
        const bridge = window.electronBackground;
        if (!bridge || !bridge.awake) return;
        const work = this.scheduledWork(jobs);
        if (this._awake && this._awake.hold === work.hold && this._awake.reason === work.reason) return;
        this._awake = work;
        bridge.awake(work.hold, work.reason);
    },
    /** One sentence for Settings about sleep, from main's state. */
    awakeLine(state) {
        if (!state || !state.supported) return '';
        if (state.paused) return 'Scheduled routines are paused, so your Mac can sleep normally.';
        if (state.awake) return `nenva is keeping this Mac awake while ${state.awakeReason || 'work is scheduled'}; the display still sleeps.`;
        return 'With nothing scheduled, your Mac sleeps normally.';
    },
    renderSettings() {
        const state = window.electronBackground?.state();
        const card = document.getElementById('settings-background');
        if (!card || !state) return;
        card.hidden = !state.supported;
        for (const [id, key] of [['settings-background-enabled', 'enabled'], ['settings-background-login', 'openAtLogin']]) {
            const input = document.getElementById(id);
            input.checked = !!state[key];
            input.disabled = key === 'openAtLogin' && !state.loginAvailable;
            input.onchange = async () => {
                input.disabled = true;
                try { await window.electronBackground.set({ [key]: input.checked }); }
                catch (error) { document.getElementById('settings-background-status').textContent = error.message; return; }
                finally { input.disabled = false; }
                this.renderSettings();
            };
        }
        document.getElementById('settings-background-status').textContent = !state.loginAvailable
            ? 'Launch at login is available in the installed app.'
            : state.paused ? 'Scheduled routines are paused. Resume them from the menu bar.' : `${this.awakeLine(state)} Quit stops all work.`;
    }
};
