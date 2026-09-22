/* Native lifecycle controls. The scheduler consults main at each work boundary. */
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
            if (state.owner && !state.paused && typeof RoutineEngine !== 'undefined') {
                if (promoted) { RoutineEngine.load(); RoutineEngine.loadLocal(); }
                RoutineEngine._ensureMailSync();
                RoutineEngine.tick();
                if (typeof TaskService !== 'undefined') TaskService._resumeUnattendedRuns();
            }
        });
        bridge.onOpen(route => {
            if (route === 'updates' && typeof SimpleExperience !== 'undefined' && document.body.classList.contains('simple-experience')) AppManager.openApp('updates');
            else AppManager.showDashboard();
        });
        this.renderSettings();
        this._timer = setInterval(() => {
            if (!this._state?.enabled || !this._state?.owner) return;
            const tasks = typeof TaskService !== 'undefined' ? TaskService._all() : [];
            const rooms = typeof WorkroomsApp !== 'undefined' && WorkroomsApp.active() ? WorkroomsApp.rooms : [];
            const attention = tasks.some(task => task?.status === 'awaiting_user') || rooms.some(room => !!room.approval);
            const running = (typeof RoutineEngine !== 'undefined' && RoutineEngine._busy)
                || tasks.some(task => task?.unattended && ['planning', 'running', 'verifying'].includes(task.status));
            bridge.status(attention ? 'Needs your attention' : rooms.some(room => room.status === 'running') ? 'Working in a workroom' : running ? 'Running a routine' : 'Idle');
        }, 5000);
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
            : state.paused ? 'Scheduled routines are paused. Resume them from the menu bar.' : 'Your Mac can sleep normally. Routines catch up when it wakes. Quit stops all work.';
    }
};
