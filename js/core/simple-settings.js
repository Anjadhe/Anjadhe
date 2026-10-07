/**
 * SimpleSettings — the simple shell's Settings (2026-10-01), iOS-style:
 * grouped rows, a value on the right, a chevron, one page per thing.
 *
 * Built ONE ROW AT A TIME by decision (Ram: "we will consciously decide
 * what needs to be available there"). Everything not moved here yet stays
 * one tap away under "All settings" (the full SettingsApp).
 *
 * Rows so far:
 *   Memory — what nenva remembers, by page (MemoryUI's own page, hosted
 *   here: the #memory-page element is moved in while this page shows and
 *   back to Settings' Memory view when it leaves, so there is one copy).
 *   Model — one model for everything. Choosing a model makes it the default
 *   AND clears every per-part assignment (ModelRouting), so chat, email,
 *   routines and the rest all answer from it. No per-app picker here.
 *   Connectors — a searchable list of outside sources, one small page each
 *   (js/core/simple-connectors.js, 2026-10-05).
 *
 * The page reuses the existing machinery, never a second copy of it:
 * SettingsApp.chooseDefault (switch, or download-then-switch for a local
 * model), SettingsApp._activeDownloads (progress), and the Add a model page
 * (SettingsApp._openAddModelPage) with a return hook back here.
 */
const SimpleSettings = {
    _page: 'root',
    _timer: null,

    mount() {
        if (document.getElementById('simplesettings-view')) return;
        const page = document.createElement('div');
        page.id = 'simplesettings-view';
        page.className = 'view app-view ss-view';
        page.innerHTML = '<div class="ss-wrap"></div>';
        document.getElementById('app-views').append(page);
        page.addEventListener('click', e => this._onClick(e));
        page.addEventListener('change', e => this._onChange(e));
        page.addEventListener('input', e => { if (e.target.classList.contains('ss-search')) this._filterConnectors(e.target.value); });
        AppManager.register('simplesettings', {
            render: () => this.render(),
            onHide: () => { this._stopPoll(); this._returnMemoryPage(); }
        });
    },

    open(pageName = 'root') {
        this._page = pageName;
        AppManager.openAppFromLauncher('simplesettings');
        this.render();
    },

    _esc(s) { return UIUtils.escapeHtml(s == null ? '' : String(s)); },
    /** An iOS-style row icon: an ink glyph on a quiet tile (monochrome). */
    _tile(paths) {
        return `<span class="ss-tile"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg></span>`;
    },
    _chev: '<svg class="ss-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
    _check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',

    render() {
        const wrap = document.querySelector('#simplesettings-view .ss-wrap');
        if (!wrap) return;
        this._returnMemoryPage();
        if (this._page === 'model') { wrap.innerHTML = this._modelHtml(); this._startPoll(); return; }
        this._stopPoll();
        if (this._page === 'memory') { this._renderMemory(wrap); return; }
        if (this._page === 'connectors') { wrap.innerHTML = this._connectorsHtml(); return; }
        if (this._page.startsWith('connector:')) { wrap.innerHTML = this._connectorHtml(this._page.slice(10)); return; }
        if (this._page === 'privacy') { wrap.innerHTML = this._privacyHtml(); return; }
        if (this._page === 'appearance') { wrap.innerHTML = this._appearanceHtml(); this._fillBackground(wrap); return; }
        if (this._page === 'about') { wrap.innerHTML = this._aboutHtml(); this._fillVersion(wrap); return; }
        wrap.innerHTML = this._rootHtml();
        this._fillVersion(wrap);
        this._fillBackup();
    },

    // ── Developer options (2026-10-06, the simplification) ──────────────
    // ONE switch, per-Mac. Off (the default) this page is the whole of
    // Settings; on, "All settings" opens the full SettingsApp (logs, the DB
    // browser, experimental flags, model routing, tool servers and the
    // rest), and SettingsApp.showRoot stops sending people back here.
    DEV_KEY: 'developer-settings',
    developer() { try { return localStorage.getItem(this.DEV_KEY) === 'on'; } catch { return false; } },
    setDeveloper(on) { try { localStorage.setItem(this.DEV_KEY, on ? 'on' : 'off'); } catch { /* per-Mac */ } },


    // ── Memory ─────────────────────────────────────────────────────────

    _renderMemory(wrap) {
        wrap.innerHTML = `<button type="button" class="ss-back" data-ss="back">‹ Settings</button>
            <h1 class="ss-title">Memory</h1>${this._commitmentsRowHtml()}<div class="ss-memory-host"></div>`;
        const mem = document.getElementById('memory-page');
        if (mem) wrap.querySelector('.ss-memory-host').append(mem);
        if (typeof MemoryUI !== 'undefined') MemoryUI.render();
    },

    /** Commitments' door (2026-10-05, by request: off the left nav, a row
     *  here): what the person said they would do sits beside what nenva
     *  remembers about them. */
    _commitmentsRowHtml() {
        if (typeof CommitmentsPage === 'undefined' || typeof Commitments === 'undefined' || !Commitments._inited) return '';
        let n = 0;
        try { n = Commitments.all().filter(c => c.state === 'open').length; } catch { /* optional */ }
        return `<div class="ss-group ss-memory-doors">
                <button type="button" class="ss-row" data-ss="commitments">
                    ${this._tile('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12 2.5 2.5 4.5-5"/>')}
                    <span class="ss-label">${this._esc(CommitmentsPage.LABEL)}</span><span class="ss-value">${n ? `${n} open` : 'None yet'}</span>${this._chev}
                </button>
            </div>`;
    },

    /** Put the Memory page back where Settings keeps it before this page redraws. */
    _returnMemoryPage() {
        const mem = document.getElementById('memory-page');
        const home = document.getElementById('memories-settings-view');
        if (mem && home && mem.closest('#simplesettings-view')) home.append(mem);
    },

    // ── Root ───────────────────────────────────────────────────────────

    _rootHtml() {
        const def = typeof AgentService !== 'undefined' ? AgentService.getDefaultEntry() : null;
        const model = def ? AgentService.displayModelName(def) : 'Choose a model';
        const n = typeof MemoryManager !== 'undefined' ? MemoryManager.all().length : 0;
        const memory = n ? `${n} thing${n === 1 ? '' : 's'}` : 'Nothing yet';
        const theme = { light: 'Light', dark: 'Dark', system: 'System' }[typeof AppManager !== 'undefined' && AppManager.getThemePref ? AppManager.getThemePref() : 'light'] || 'Light';
        const dev = this.developer();
        return `<h1 class="ss-title">Settings</h1>
            <div class="ss-group">
                <button type="button" class="ss-row" data-ss="page" data-id="model">
                    ${this._tile('<rect x="6" y="6" width="12" height="12" rx="2.5"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>')}
                    <span class="ss-label">Model</span><span class="ss-value">${this._esc(model)}</span>${this._chev}
                </button>
                <button type="button" class="ss-row" data-ss="page" data-id="memory">
                    ${this._tile('<path d="M12 20s-7-4.4-7-9.6A4 4 0 0 1 12 7a4 4 0 0 1 7 3.4C19 15.6 12 20 12 20z"/>')}
                    <span class="ss-label">Memory</span><span class="ss-value">${this._esc(memory)}</span>${this._chev}
                </button>
                <button type="button" class="ss-row" data-ss="page" data-id="connectors">
                    ${this._tile(this._ICON.plug)}
                    <span class="ss-label">Connectors</span><span class="ss-value">${this._esc(this.connectorsSummary())}</span>${this._chev}
                </button>
            </div>
            <div class="ss-group">
                <button type="button" class="ss-row" data-ss="page" data-id="privacy">
                    ${this._tile('<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/>')}
                    <span class="ss-label">Privacy</span><span class="ss-value">${this._esc(this.whereLabel(def))}</span>${this._chev}
                </button>
                <button type="button" class="ss-row" data-ss="backup">
                    ${this._tile('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>')}
                    <span class="ss-label">Backup</span><span class="ss-value">${this._esc(this._backupSummary())}</span>${this._chev}
                </button>
            </div>
            <div class="ss-group">
                <button type="button" class="ss-row" data-ss="page" data-id="appearance">
                    ${this._tile('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>')}
                    <span class="ss-label">Appearance</span><span class="ss-value">${this._esc(theme)}</span>${this._chev}
                </button>
                <button type="button" class="ss-row" data-ss="page" data-id="about">
                    ${this._tile('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>')}
                    <span class="ss-label">About</span><span class="ss-value ss-version"></span>${this._chev}
                </button>
            </div>
            <div class="ss-group">
                <label class="ss-row ss-switch-row">
                    ${this._tile('<path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14"/>')}
                    <span class="ss-label">Developer options</span>
                    <span class="settings-switch"><input type="checkbox" data-ss-switch="developer"${dev ? ' checked' : ''} aria-label="Developer options"><span class="settings-switch-track"></span></span>
                </label>
                ${dev ? `<button type="button" class="ss-row" data-ss="all">
                    ${this._tile('<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>')}
                    <span class="ss-label">All settings</span><span class="ss-value">Logs, flags, tools</span>${this._chev}
                </button>` : ''}
            </div>`;
    },

    // ── Privacy (2026-10-06): one page in sentences ─────────────────────
    // Every sentence states what the code does (docs/CLOUD_PRIVACY.md: the
    // ledger is the disclosure; docs/VISION.md principle 7). The per-class
    // switches, tool servers, the permissions list and model routing live
    // behind Developer options; the one choice a person makes here is the
    // model (cloud or only this Mac), which IS the strict local-only choice,
    // since there is no fallback across engines.
    _privacyHtml() {
        const def = typeof AgentService !== 'undefined' ? AgentService.getDefaultEntry() : null;
        const where = this.whereLabel(def);
        const local = !def || where === 'On this Mac';
        const anyLeaves = (() => { try { return typeof CloudPrivacy !== 'undefined' && CloudPrivacy.anyLeaves(); } catch { return !local; } })();
        const ai = local && !anyLeaves
            ? 'Your AI runs only on this Mac. Nothing you connect leaves it for AI, and there is no cloud fallback: when the model here cannot answer, nenva says so.'
            : local
                ? 'Chat runs on this Mac, but part of nenva is pointed at a model that runs elsewhere (Developer options › All settings › Models). What that part reads may be sent there.'
                : `Your AI runs ${where === 'nenva cloud' ? 'in nenva cloud' : where.startsWith('Your server') ? 'on your own server' : `at ${where}`}. What nenva reads from the sources you connected may be sent there to answer you and to do its own work (reading your mail, routines). It goes only where you point it${where === 'nenva cloud' ? ', and nenva cloud never logs or stores what is sent' : ''}.`;
        const analytics = typeof AnalyticsManager !== 'undefined' && AnalyticsManager.isEnabled ? !!AnalyticsManager.isEnabled() : false;
        return `<button type="button" class="ss-back" data-ss="back">‹ Settings</button>
            <h1 class="ss-title">Privacy</h1>
            <p class="ss-lede">Everything nenva keeps — your mail, calendar, folders, commitments and memory — is stored on this Mac. Backups go where you choose.</p>
            <div class="ss-group">
                <button type="button" class="ss-row" data-ss="page" data-id="model">
                    <span class="ss-pick-copy"><span class="ss-label">Your AI</span><span class="ss-sub">${this._esc(ai)}</span></span><span class="ss-value">Change</span>${this._chev}
                </button>
                <button type="button" class="ss-row" data-ss="left">
                    <span class="ss-pick-copy"><span class="ss-label">What left this Mac</span><span class="ss-sub">Every call that went to a server off this Mac: when, where to, what kind of data.</span></span>${this._chev}
                </button>
            </div>
            ${this._readsHtml()}
            <div class="ss-group">
                <button type="button" class="ss-row" data-ss="lock">
                    <span class="ss-pick-copy"><span class="ss-label">Lock nenva</span><span class="ss-sub">A password or Touch ID before nenva opens.</span></span>${this._chev}
                </button>
                <label class="ss-row ss-switch-row">
                    <span class="ss-pick-copy"><span class="ss-label">Anonymous usage signals</span><span class="ss-sub">Off unless you turn it on. Content-free events (like “assistant reply marked helpful”) with a random ID for this Mac; never a line of your mail, notes or chats.</span></span>
                    <span class="settings-switch"><input type="checkbox" data-ss-switch="analytics"${analytics ? ' checked' : ''} aria-label="Send anonymous usage signals"><span class="settings-switch-track"></span></span>
                </label>
            </div>`;
    },

    /** Main owns the backup settings (window.electronBackup); the root row fills in once they arrive. */
    /** What nenva reads, one line per source, from the Sources registry (code's words from code's facts). */
    _readsHtml() {
        if (typeof Sources === 'undefined') return '';
        const lines = Sources.privacyLines().filter(l => l.on);
        if (!lines.length) return `<div class="ss-group"><button type="button" class="ss-row" data-ss="page" data-id="connectors"><span class="ss-pick-copy"><span class="ss-label">What nenva reads</span><span class="ss-sub">Nothing is connected yet.</span></span>${this._chev}</button></div>`;
        return `<div class="ss-group">${lines.map(l => `<button type="button" class="ss-row" data-ss="page" data-id="connector:${this._esc(l.id)}">
                <span class="ss-pick-copy"><span class="ss-label">${this._esc(l.label)}</span><span class="ss-sub">${this._esc(l.reads)} ${this._esc(l.ai)}</span></span><span class="ss-value">${this._esc(l.value)}</span>${this._chev}
            </button>`).join('')}</div>`;
    },

    _backupSummary() { return this._backupState ? (this._backupState.enabled ? 'On' : 'Off') : ''; },
    _fillBackup() {
        if (!window.electronBackup || !window.electronBackup.getSettings) return;
        window.electronBackup.getSettings().then(st => {
            const was = this._backupState && this._backupState.enabled;
            this._backupState = st || {};
            if (this._page === 'root' && was !== !!this._backupState.enabled) this.render();
        }).catch(() => {});
    },

    // ── Appearance (2026-10-06): the theme, and keeping nenva running ───
    _appearanceHtml() {
        const pref = typeof AppManager !== 'undefined' && AppManager.getThemePref ? AppManager.getThemePref() : 'light';
        const pick = (v, label) => `<button type="button" class="ss-pick-main" data-ss="theme" data-id="${v}" aria-pressed="${pref === v}">
                <span class="ss-pick-copy"><span class="ss-label">${label}</span></span><span class="ss-checkmark" aria-hidden="true">${pref === v ? this._check : ''}</span></button>`;
        return `<button type="button" class="ss-back" data-ss="back">‹ Settings</button>
            <h1 class="ss-title">Appearance</h1>
            <div class="ss-group">
                <div class="ss-row ss-pick${pref === 'light' ? ' is-on' : ''}">${pick('light', 'Light')}</div>
                <div class="ss-row ss-pick${pref === 'dark' ? ' is-on' : ''}">${pick('dark', 'Dark')}</div>
                <div class="ss-row ss-pick${pref === 'system' ? ' is-on' : ''}">${pick('system', 'Match the Mac')}</div>
            </div>
            <div class="ss-group ss-background" hidden>
                <label class="ss-row ss-switch-row">
                    <span class="ss-pick-copy"><span class="ss-label">Keep nenva running</span><span class="ss-sub">Closing the window keeps nenva in the menu bar, so routines keep running.</span></span>
                    <span class="settings-switch"><input type="checkbox" data-ss-switch="background" aria-label="Keep nenva running in the menu bar"><span class="settings-switch-track"></span></span>
                </label>
                <label class="ss-row ss-switch-row">
                    <span class="ss-pick-copy"><span class="ss-label">Open at login</span><span class="ss-sub ss-background-status"></span></span>
                    <span class="settings-switch"><input type="checkbox" data-ss-switch="login" aria-label="Open nenva at login"><span class="settings-switch-track"></span></span>
                </label>
            </div>`;
    },
    /** The menu-bar switches read main's state (js/main/background-mode.js) — shown only where supported. */
    _fillBackground(wrap) {
        const state = window.electronBackground && window.electronBackground.state ? window.electronBackground.state() : null;
        const group = wrap.querySelector('.ss-background');
        if (!group || !state || !state.supported) return;
        group.hidden = false;
        const bg = wrap.querySelector('[data-ss-switch="background"]'), login = wrap.querySelector('[data-ss-switch="login"]');
        bg.checked = !!state.enabled;
        login.checked = !!state.openAtLogin;
        login.disabled = !state.loginAvailable;
        wrap.querySelector('.ss-background-status').textContent = !state.loginAvailable ? 'Available in the installed app.' : state.paused ? 'Scheduled routines are paused; resume them from the menu bar.' : '';
    },

    // ── About (2026-10-06): version and updates, feedback, registration ──
    _aboutHtml() {
        return `<button type="button" class="ss-back" data-ss="back">‹ Settings</button>
            <h1 class="ss-title">About</h1>
            <div class="ss-group">
                <button type="button" class="ss-row" data-ss="updates">
                    <span class="ss-pick-copy"><span class="ss-label">Version</span><span class="ss-sub">Updates install on their own; check now, or read what changed.</span></span><span class="ss-value ss-version"></span>${this._chev}
                </button>
                <button type="button" class="ss-row" data-ss="feedback">
                    <span class="ss-pick-copy"><span class="ss-label">Send feedback</span><span class="ss-sub">To the person who makes nenva.</span></span>${this._chev}
                </button>
                <button type="button" class="ss-row" data-ss="license">
                    <span class="ss-pick-copy"><span class="ss-label">Registration</span><span class="ss-sub">nenva is free. Registering is how release news reaches you.</span></span>${this._chev}
                </button>
                <button type="button" class="ss-row" data-ss="about-nenva">
                    <span class="ss-label">About nenva</span>${this._chev}
                </button>
            </div>`;
    },
    _fillVersion(wrap) {
        const el = wrap.querySelector('.ss-version');
        if (!el || !window.electronSystem || !window.electronSystem.getInfo) return;
        window.electronSystem.getInfo().then(i => { if (i && i.appVersion) el.textContent = `v${String(i.appVersion).replace(/^v/, '')}`; }).catch(() => {});
    },

    /** The switches on this page (2026-10-06): each writes through the one owner of that setting. */
    async _flip(kind, on, input) {
        if (kind === 'developer') { this.setDeveloper(on); this.render(); return; }
        if (kind === 'texts' && typeof IMessageSource !== 'undefined') {
            input.disabled = true;
            try {
                const r = await IMessageSource.setEnabled(!!on);
                if (on && r && !r.ok) UIUtils.showToast(r.reason === 'fda' ? 'Full Disk Access is needed — see how below' : (r.error || 'Could not read Messages'), 'error');
                if (!on) UIUtils.showToast('Stopped reading texts — conversations forgotten, commitments kept', 'info');
            } finally { input.disabled = false; }
            this.render(); return;
        }
        if (kind === 'applenotes' && typeof AppleNotesSource !== 'undefined') {
            input.disabled = true;
            try {
                const r = await AppleNotesSource.setEnabled(!!on);
                if (on && r && !r.ok) UIUtils.showToast(r.error || 'Could not read Apple Notes', 'error');
                if (!on) UIUtils.showToast(`Stopped indexing Apple Notes${r && r.removed ? ` — ${r.removed} forgotten` : ''}`, 'info');
            } finally { input.disabled = false; }
            this.render(); return;
        }
        if (kind === 'texts-ai' && typeof CloudPrivacy !== 'undefined') { CloudPrivacy.setEnabled('messages', !!on); CloudPrivacy._resetNotes?.(); this.render(); return; }
        if (kind === 'analytics' && typeof AnalyticsManager !== 'undefined') { AnalyticsManager.setEnabled(!!on); return; }
        if ((kind === 'background' || kind === 'login') && window.electronBackground && window.electronBackground.set) {
            input.disabled = true;
            try { await window.electronBackground.set({ [kind === 'background' ? 'enabled' : 'openAtLogin']: !!on }); }
            catch (err) { UIUtils.showToast(err && err.message ? err.message : 'Could not change that', 'error'); }
            finally { input.disabled = false; }
            const wrap = document.querySelector('#simplesettings-view .ss-wrap');
            if (wrap && this._page === 'appearance') this._fillBackground(wrap);
        }
    },

    /** The full SettingsApp, on one of its pages (Developer options, or a door a page needs). */
    _full(open) {
        if (typeof SettingsApp === 'undefined') return;
        AppManager.openAppFromLauncher('settings');
        if (AppManager.currentApp === 'settings') open();
    },

    // ── Model ──────────────────────────────────────────────────────────

    whereLabel(entry) {
        const e = entry && entry.engine;
        if (e === 'anjadhe') return 'nenva cloud';
        if (e === 'openai') return 'OpenAI, your key';
        if (e === 'anthropic') return 'Anthropic, your key';
        if (e === 'server') {
            try { return `Your server · ${new URL(entry.baseUrl).host}`; } catch { return 'Your server'; }
        }
        return 'On this Mac';
    },

    _routesInUse() {
        try { return Object.keys(AgentService.getRouteAssignments() || {}).length > 0; } catch { return false; }
    },

    _modelHtml() {
        const list = AgentService.getModelList();
        const def = AgentService.getDefaultEntry();
        const dl = (typeof SettingsApp !== 'undefined' && SettingsApp._activeDownloads) || new Map();
        const pending = typeof SettingsApp !== 'undefined' ? SettingsApp._pendingDefaultId : null;
        const rows = list.map(e => {
            const on = def && def.id === e.id;
            const prog = dl.get(e.id);
            const sub = prog ? `Downloading · ${prog.text || ''}` : pending === e.id ? 'Waiting for the download' : this.whereLabel(e);
            return `<div class="ss-row ss-pick${on ? ' is-on' : ''}" data-id="${this._esc(e.id)}">
                <button type="button" class="ss-pick-main" data-ss="choose" data-id="${this._esc(e.id)}" aria-pressed="${!!on}">
                    <span class="ss-pick-copy"><span class="ss-label">${this._esc(AgentService.displayModelName(e))}</span><span class="ss-sub">${this._esc(sub)}</span></span>
                    <span class="ss-checkmark" aria-hidden="true">${on ? this._check : ''}</span>
                </button>
                ${on ? '' : `<button type="button" class="ss-remove" data-ss="remove" data-id="${this._esc(e.id)}" title="Remove" aria-label="Remove">Remove</button>`}
            </div>`;
        }).join('');
        return `<button type="button" class="ss-back" data-ss="back">‹ Settings</button>
            <h1 class="ss-title">Model</h1>
            <p class="ss-lede">nenva uses one model for everything: chat, email, routines and the rest.</p>
            ${this._routesInUse() ? `<p class="ss-note">Some parts of nenva are set to a different model. <button type="button" class="ss-link" data-ss="one">Use ${this._esc(def ? AgentService.displayModelName(def) : 'this model')} for everything</button></p>` : ''}
            <div class="ss-group">${rows || '<p class="ss-empty">No model yet.</p>'}</div>
            <div class="ss-group">
                <button type="button" class="ss-row" data-ss="add"><span class="ss-label ss-accent">Add a model</span><span class="ss-value"></span>${this._chev}</button>
            </div>`;
    },

    /** One model for everything: clear every per-part assignment. */
    _clearRoutes() {
        try {
            const s = StorageManager.get('agent-settings') || {};
            if (s[ModelRouting.KEY] && Object.keys(s[ModelRouting.KEY]).length) {
                s[ModelRouting.KEY] = {};
                StorageManager.set('agent-settings', s);
            }
        } catch { /* routing is a preference layer */ }
    },

    async choose(id) {
        if (typeof SettingsApp === 'undefined') return;
        const res = await SettingsApp.chooseDefault(id);
        if (res !== null) this._clearRoutes();
        if (typeof AgentUI !== 'undefined') { AgentUI.updateModelChip?.(); AgentUI.startReadinessWatch?.(); }
        this.render();
    },

    async remove(id) {
        const e = AgentService.getEntry(id);
        if (!e) return;
        const ok = await UIUtils.confirm('Remove model', `Remove ${this._esc(AgentService.displayModelName(e))} from your list?`, '', { confirmText: 'Remove' });
        if (!ok) return;
        AgentService.removeEntry(id);
        this.render();
    },

    addModel() {
        if (typeof SettingsApp === 'undefined') return;
        AppManager.openAppFromLauncher('settings');
        SettingsApp._addModelReturn = () => {
            SettingsApp._addModelReturn = null;
            this.open('model');
        };
        SettingsApp._openAddModelPage();
    },

    _startPoll() {
        if (this._timer) return;
        this._timer = setInterval(() => {
            if (this._page !== 'model' || AppManager.currentApp !== 'simplesettings') { this._stopPoll(); return; }
            const dl = (typeof SettingsApp !== 'undefined' && SettingsApp._activeDownloads) || new Map();
            if (dl.size || this._hadDownloads) { this._hadDownloads = dl.size > 0; this.render(); }
        }, 1000);
    },
    _stopPoll() { if (this._timer) clearInterval(this._timer); this._timer = null; },

    _onClick(e) {
        const b = e.target.closest('[data-ss]');
        if (!b) return;
        const { ss, id } = b.dataset;
        if (ss === 'page') {
            if (id === 'memory' && typeof MemoryUI !== 'undefined') MemoryUI._openPage = null;
            this._page = id; this.render();
        }
        if (ss === 'back') { this._page = id || 'root'; this.render(); }
        if (ss.startsWith('google-') || ss.startsWith('apple-') || ss.startsWith('texts-') || ss.startsWith('files-') || ss.startsWith('applenotes-')) this._connectorClick(ss, b);
        if (ss === 'commitments' && typeof CommitmentsPage !== 'undefined') CommitmentsPage.open();
        if (ss === 'all') this._full(() => SettingsApp.showRoot?.());
        if (ss === 'backup') this._full(() => SettingsApp.openStorageBackup?.());
        if (ss === 'left') this._full(() => SettingsApp.openLlmLogs?.('left'));
        if (ss === 'lock') this._full(() => SettingsApp.openCategory?.('privacy'));
        if (ss === 'updates') this._full(() => SettingsApp.openCategory?.('version'));
        if (ss === 'feedback') this._full(() => SettingsApp.openCategory?.('feedback'));
        if (ss === 'license') this._full(() => SettingsApp.openCategory?.('license'));
        if (ss === 'about-nenva') AppManager.openAppFromLauncher('about');
        if (ss === 'theme' && typeof AppManager !== 'undefined' && AppManager.setThemePref) { AppManager.setThemePref(id); this.render(); }
        if (ss === 'choose') this.choose(id);
        if (ss === 'remove') this.remove(id);
        if (ss === 'add') this.addModel();
        if (ss === 'one') { this._clearRoutes(); this.render(); }
    }
};
