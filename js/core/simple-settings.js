/**
 * SimpleSettings — the simple shell's Settings (2026-10-01), iOS-style:
 * grouped rows, a value on the right, a chevron, one page per thing.
 *
 * Built ONE ROW AT A TIME by decision (Ram: "we will consciously decide
 * what needs to be available there"). Everything not moved here yet stays
 * one tap away under "Advanced" (SettingsApp's root).
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
 *   Privacy & security, Appearance — below. Backup, App lock, Data activity, About
 *   (with Send feedback and Registration) — js/core/simple-settings-pages.js
 *   (2026-10-06); no row here opens the full SettingsApp except Advanced.
 *   Other pages open a page here with SimpleSettings.open(page).
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
        page.addEventListener('focusout', e => { if (e.target?.dataset?.taughtNote) this._taughtNoteBlur(e.target); });
        page.addEventListener('input', e => {
            if (e.target.dataset.slackFind !== undefined && typeof SlackConnector !== 'undefined') { SlackConnector.filterPicker(e.target); return; }
            if (e.target.classList.contains('ss-search')) this._filterConnectors(e.target.value);
        });
        page.addEventListener('keydown', e => {
            if (!e.target.classList.contains('ss-search') || e.isComposing) return;
            if (e.key === 'Escape') { e.preventDefault(); this._clearConnectorSearch(); }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                page.querySelector('.ss-connectors .ss-row:not([hidden])')?.focus();
            }
        });
        window.addEventListener('anjadhe:connectors-changed', () => {
            if (AppManager.currentApp !== 'simplesettings' || !['root', 'connectors', 'connector:notion', 'connector:slack', 'connector:slack:watch', 'connector:linear'].includes(this._page)) return;
            const input = page.querySelector('.ss-search');
            const query = input?.value || '';
            const focused = input && document.activeElement === input;
            const selection = focused ? [input.selectionStart, input.selectionEnd] : null;
            this.render();
            const search = page.querySelector('.ss-search');
            if (search && query) { search.value = query; this._filterConnectors(query); }
            if (search && focused) { search.focus(); search.setSelectionRange(...selection); }
        });
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
    /** A page change inside Settings moves the nav light (Memory is a nav item since 2026-10-07). */
    _lit() { if (typeof SimpleExperience !== 'undefined' && SimpleExperience.onNavigate) SimpleExperience.onNavigate('simplesettings'); },

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
        if (this._page === 'taught' && !this._taughtOn()) this._page = 'memory';
        this._lit();
        this._returnMemoryPage();
        if (this._page === 'model') { wrap.innerHTML = this._modelHtml(); this._startPoll(); return; }
        this._stopPoll();
        if (this._page === 'memory') { this._renderMemory(wrap); return; }
        if (this._page === 'pinned') { wrap.innerHTML = this._pinnedHtml(); return; }
        if (this._page === 'taught') { wrap.innerHTML = this._taughtHtml(); this._fillTaughtBrowser(wrap); return; }
        if (this._page === 'connectors') { wrap.innerHTML = this._connectorsHtml(); this._filterConnectors(this._connectorQuery); return; }
        if (this._page.startsWith('connector:')) {
            const id = this._page.slice(10);
            wrap.innerHTML = this._connectorHtml(id);
            if (id === 'institutions' && wrap.querySelector('#settings-brokerages')) SettingsApp._renderBrokerages();
            if (id === 'texts' && wrap.querySelector('#settings-imessage')) SettingsApp._renderIMessage();
            return;
        }
        if (this._page === 'phone') { this._renderPhone(wrap); return; }
        if (this._page === 'privacy') { wrap.innerHTML = this._privacyHtml(); return; }
        if (this._page === 'appearance') { wrap.innerHTML = this._appearanceHtml(); this._fillBackground(wrap); return; }
        // The four pages that used to open the full SettingsApp (js/core/simple-settings-pages.js).
        if (this._page === 'backup') { this._backupHtml().then(h => { if (this._page === 'backup') wrap.innerHTML = h; }); return; }
        if (this._page === 'lock') { wrap.innerHTML = this._lockHtml(); return; }
        if (this._page === 'plan') { wrap.innerHTML = this._planHtml(null); this._fillPlan(wrap); return; }
        if (this._page === 'analytics') { wrap.innerHTML = this._analyticsHtml(); return; }
        if (this._page === 'left') { wrap.innerHTML = this._leftHtml(); return; }
        if (this._page === 'about') { wrap.innerHTML = this._aboutHtml(); this._fillAbout(wrap); return; }
        if (this._page === 'feedback') { wrap.innerHTML = this._feedbackHtml(); this._fillFeedback(wrap); return; }
        if (this._page === 'registration') { wrap.innerHTML = this._registrationHtml(); this._fillRegistration(wrap); return; }
        wrap.innerHTML = this._rootHtml();
        this._fillVersion(wrap);
        // The Plan row's value ("Free · 62% used") arrives with usage.
        if (typeof PlanUsage !== 'undefined' && this._planRowValue) {
            PlanUsage.fetch().then(() => {
                const el = wrap.querySelector('.ss-plan-value');
                if (el && this._page === 'root') el.textContent = this._planRowValue();
            }).catch(() => {});
        }
        this._fillBackup();
        if (this._fillPhone) this._fillPhone();
    },

    // ── Advanced (2026-10-06, by request) ───────────────────────────────
    // ONE row, always shown: SettingsApp's root, which lists ONLY what this
    // page does not cover (name, model options, web search, keys, logs,
    // flags). The Developer options switch that used to gate it is gone;
    // nothing in Settings is hidden behind a mode any more.

    // ── Memory ─────────────────────────────────────────────────────────

    _renderMemory(wrap) {
        // A nav root since 2026-10-07: no way "back" to Settings from here.
        // What nenva keeps on the person's behalf (2026-10-07, Ram: text documents
        // and finance data "can be considered part of app's memory"): one quiet
        // panel of doors — Commitments, the folders from mail, Finance, Text
        // Documents, Taught tasks — then what it remembers about them.
        const doors = [this._commitmentsRowHtml(), this._mattersRowHtml(), this._financeRowHtml(), this._documentsRowHtml(), this._taughtRowHtml()].filter(Boolean).join('');
        const coached = this._coachingRowsHtml();
        wrap.innerHTML = `<h1 class="ss-title">Memory</h1>${doors ? `<div class="ss-group ss-memory-doors">${doors}</div>` : ''}${coached ? `<div class="ss-group ss-memory-coaching">${coached}</div>` : ''}<div class="ss-memory-host"></div>`;
        const mem = document.getElementById('memory-page');
        if (mem) wrap.querySelector('.ss-memory-host').append(mem);
        if (typeof MemoryUI !== 'undefined') MemoryUI.render();
    },

    /**
     * Pinned (2026-10-09, by request): a nav root listing what the person
     * pinned, each row only a door to the commitment's own page (Pins holds
     * the references; nothing here summarises or keeps a copy).
     */
    _pinnedHtml() {
        const pins = typeof Pins !== 'undefined' ? Pins.list() : [];
        const rows = pins.map(({ c }) => `<button type="button" class="ss-row" data-ss="commitment" data-id="${this._esc(c.id)}">
                    ${this._tile('<path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/>')}
                    <span class="ss-label">${this._esc(c.title)}</span>${c.state !== 'open' ? `<span class="ss-value">${c.state === 'dropped' ? 'Ignored' : 'Done'}</span>` : ''}${this._chev}
                </button>`).join('');
        // The door to every commitment sits under the pins (2026-10-09, by
        // request): the page says to open a commitment, so it shows where.
        const all = this._commitmentsRowHtml();
        return `<h1 class="ss-title">Pinned</h1>${rows ? `<div class="ss-group">${rows}</div>`
            : '<p class="ss-lede">Nothing pinned yet. Open a commitment and choose Pin to keep it here.</p>'}${all ? `<div class="ss-group">${all}</div>` : ''}`;
    },

    /** Commitments' door (2026-10-05, by request: off the left nav, a row
     *  here): what the person said they would do sits beside what nenva
     *  remembers about them. */
    _commitmentsRowHtml() {
        if (typeof CommitmentsPage === 'undefined' || typeof Commitments === 'undefined' || !Commitments._inited) return '';
        let n = 0;
        try { n = Commitments.all().filter(c => c.state === 'open').length; } catch { /* optional */ }
        return `<button type="button" class="ss-row" data-ss="commitments">
                    ${this._tile('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12 2.5 2.5 4.5-5"/>')}
                    <span class="ss-label">${this._esc(CommitmentsPage.LABEL)}</span><span class="ss-value">${n ? `${n} open` : 'None yet'}</span>${this._chev}
                </button>`;
    },
    /**
     * Coached goals (docs/COACH.md §6, 2026-10-09): one row per open goal
     * that has a domain, its domain and where it stands, opening its sheet.
     * No row at all when nothing is coached: the "fitness area" is these
     * rows, not an app.
     */
    _coachingRowsHtml() {
        if (typeof Commitments === 'undefined' || !Commitments._inited || typeof CommitmentsPage === 'undefined') return '';
        let rows = [];
        try {
            const all = Commitments.all(), today = Commitments.today();
            rows = all.filter(c => c.state === 'open' && c.domain && !c.parent).map(c => {
                const p = Commitments.progress(c, all, today);
                const m = p && p.measure;
                const where = m && m.toGo != null ? (m.reached ? 'aim reached' : `${Commitments.figure(m.toGo, m.unit)} to go`)
                    : p && p.stage && p.stage.started ? `${p.stage.done} of ${p.stage.planned} this stage` : '';
                const label = typeof CoachDomains !== 'undefined' ? CoachDomains.label(c.domain) : c.domain;
                return { c, label, value: [label, where].filter(Boolean).join(' · ') };
            }).sort((a, b) => a.label.localeCompare(b.label) || a.c.title.localeCompare(b.c.title));
        } catch { return ''; }
        return rows.map(r => `<button type="button" class="ss-row" data-ss="commitment" data-id="${this._esc(r.c.id)}">
                    ${this._tile('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".5"/>')}
                    <span class="ss-label">${this._esc(r.c.title)}</span><span class="ss-value">${this._esc(r.value)}</span>${this._chev}
                </button>`).join('');
    },
    /** Finance: what nenva knows about the person's money (the Finance app, js/apps/portfolio). */
    _financeRowHtml() {
        if (typeof AppManager === 'undefined' || !AppManager.apps || !AppManager.apps.portfolio) return '';
        let accounts = 0;
        try { accounts = ((StorageManager.get('portfolio') || {}).accounts || []).filter(a => a && !a.deletedAt).length; } catch { /* optional */ }
        return `<button type="button" class="ss-row" data-ss="app" data-id="portfolio">
                    ${this._tile('<path d="M3 17l5-6 4 4 5-7 4 5"/><path d="M3 21h18"/>')}
                    <span class="ss-label">Finance</span><span class="ss-value">${accounts ? `${accounts} account${accounts === 1 ? '' : 's'}` : 'Nothing yet'}</span>${this._chev}
                </button>`;
    },
    /** Documents: everything the person has in writing — what nenva wrote, what they wrote, the files they gave it (js/apps/documents). */
    _documentsRowHtml() {
        if (typeof DocumentsPage === 'undefined') return '';
        let n = 0;
        try { n = ((StorageManager.get('notes') || {}).notes || []).filter(x => x && !x.deletedAt).length; } catch { /* optional */ }
        try { n += (((typeof ReaderApp !== 'undefined' && ReaderApp._listing) || {}).docs || []).length; } catch { /* optional */ }
        return `<button type="button" class="ss-row" data-ss="documents">
                    ${this._tile('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>')}
                    <span class="ss-label">Documents</span><span class="ss-value">${n ? `${n}` : 'None yet'}</span>${this._chev}
                </button>`;
    },
    /** The folders' door (2026-10-07, docs/MATTERS.md §17): what nenva keeps
     *  track of from mail and texts, beside what the person said they would
     *  do. Opens the list (the `fyi` page); each row there opens its page. */
    _mattersRowHtml() {
        // Matters inits from the email bootstrap, which may not have run yet;
        // the store itself reads fine before that.
        if (typeof Matters === 'undefined' || typeof MatterPage === 'undefined') return '';
        let n = 0, any = 0;
        try { n = Matters.openMatters().length; any = Matters.all().length; } catch { /* optional */ }
        const mail = (() => { try { return (StorageManager.get('email') || {}).accounts?.length > 0; } catch { return false; } })();
        if (!any && !mail) return '';   // nothing to list and nothing connected: no row
        return `<button type="button" class="ss-row" data-ss="matters">
                    ${this._tile('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>')}
                    <span class="ss-label">From your email and texts</span><span class="ss-value">${n ? `${n} need${n === 1 ? 's' : ''} you` : 'Nothing open'}</span>${this._chev}
                </button>`;
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
        const theme = { light: 'Light', dark: 'Dark', system: 'System' }[typeof AppManager !== 'undefined' && AppManager.getThemePref ? AppManager.getThemePref() : 'light'] || 'Light';
        return `<h1 class="ss-title">Settings</h1>
            <div class="ss-group">
                <button type="button" class="ss-row" data-ss="page" data-id="model">
                    ${this._tile('<rect x="6" y="6" width="12" height="12" rx="2.5"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>')}
                    <span class="ss-label">Model</span><span class="ss-value">${this._esc(model)}</span>${this._chev}
                </button>
                <button type="button" class="ss-row" data-ss="page" data-id="connectors">
                    ${this._tile(this._ICON.plug)}
                    <span class="ss-label">Connectors</span><span class="ss-value">${this._esc(this.connectorsSummary())}</span>${this._chev}
                </button>
                <button type="button" class="ss-row" data-ss="page" data-id="phone">
                    ${this._tile('<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>')}
                    <span class="ss-label">On your phone</span><span class="ss-value ss-phone-value">${this._esc(this._phoneRowValue ? this._phoneRowValue() : '')}</span>${this._chev}
                </button>
                <button type="button" class="ss-row" data-ss="page" data-id="plan">
                    ${this._tile('<path d="M4 19h16"/><path d="M7 15v-4M12 15V7M17 15v-6"/>')}
                    <span class="ss-label">Plan</span><span class="ss-value ss-plan-value">${this._esc(this._planRowValue ? this._planRowValue() : '')}</span>${this._chev}
                </button>
            </div>
            <div class="ss-group">
                <button type="button" class="ss-row" data-ss="page" data-id="privacy">
                    ${this._tile('<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/>')}
                    <span class="ss-label">Privacy &amp; security</span>${this._chev}
                </button>
                <button type="button" class="ss-row" data-ss="page" data-id="backup">
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
                <button type="button" class="ss-row" data-ss="all">
                    ${this._tile('<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>')}
                    <span class="ss-label">Advanced</span><span class="ss-value">Name, web search, keys, logs, flags</span>${this._chev}
                </button>
            </div>`;
    },

    // ── Privacy & security: two doors, with details on their own pages ──
    _privacyHtml() {
        const lock = typeof AppManager !== 'undefined' && AppManager.authEnabled ? 'Touch ID' : 'Off';
        const analytics = typeof AnalyticsManager !== 'undefined' && AnalyticsManager.isEnabled ? !!AnalyticsManager.isEnabled() : false;
        return `<button type="button" class="ss-back" data-ss="back">‹ Settings</button>
            <h1 class="ss-title">Privacy &amp; security</h1>
            <div class="ss-group">
                <button type="button" class="ss-row" data-ss="page" data-id="lock">
                    <span class="ss-label">App lock</span><span class="ss-value">${lock}</span>${this._chev}
                </button>
                <button type="button" class="ss-row" data-ss="page" data-id="analytics">
                    <span class="ss-label">Share usage statistics</span><span class="ss-value">${analytics ? 'On' : 'Off'}</span>${this._chev}
                </button>
            </div>`;
    },

    /** Main owns the backup settings (window.electronBackup); the root row fills in once they arrive. */
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
                    <span class="ss-pick-copy"><span class="ss-label">Keep nenva running</span><span class="ss-sub">Closing the window keeps nenva in the menu bar, so routines keep running.</span><span class="ss-sub ss-background-awake"></span></span>
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
        // Sleep is a fact of the schedule, never a switch: main holds the Mac awake while routines are armed (BackgroundRuntime.awakeLine).
        const awake = wrap.querySelector('.ss-background-awake');
        if (awake) { awake.textContent = typeof BackgroundRuntime !== 'undefined' ? BackgroundRuntime.awakeLine(state) : ''; awake.hidden = !awake.textContent; }
    },
    /** Main's state changed (the hold started, Pause flipped): repaint the group if it is on screen. */
    refreshBackground() {
        if (this._page !== 'appearance') return;
        const wrap = document.querySelector('#simplesettings-view .ss-wrap');
        if (wrap) this._fillBackground(wrap);
    },

    // About, Backup, App lock, Usage statistics and Data activity: js/core/simple-settings-pages.js.
    _fillVersion(wrap) {
        const el = wrap.querySelector('.ss-version');
        if (!el || !window.electronSystem || !window.electronSystem.getInfo) return;
        window.electronSystem.getInfo().then(i => { if (i && i.appVersion) el.textContent = `v${String(i.appVersion).replace(/^v/, '')}`; }).catch(() => {});
    },

    /** The switches on this page (2026-10-06): each writes through the one owner of that setting. */
    async _flip(kind, on, input) {
        if (kind === 'backup') { await this._backupAct('backup', on, input); return; }
        if (kind === 'lock') { await this._lockAct('lock', on, input); return; }
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

    /** The full SettingsApp, on one of its pages (Advanced, or a door a page needs). */
    _full(open) {
        if (typeof SettingsApp === 'undefined') return;
        SettingsApp._intent = 'advanced';   // read once by SettingsApp.render: don't bounce back here
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
        if (ss === 'connectors-clear') { this._clearConnectorSearch(); return; }
        if (ss === 'page') {
            if (id === 'memory' && typeof MemoryUI !== 'undefined') MemoryUI._openPage = null;
            this._page = id; this.render();
        }
        if (ss === 'back') { this._page = id || 'root'; this.render(); }
        if (ss.startsWith('google-') || ss.startsWith('apple-') || ss.startsWith('texts-') || ss.startsWith('files-') || ss.startsWith('applenotes-') || ss.startsWith('notion-') || ss.startsWith('slack-') || ss.startsWith('linear-')) this._connectorClick(ss, b);
        if (ss.startsWith('tg-') && this._phoneAct) this._phoneAct(ss, id, b);
        if (ss === 'commitments' && typeof CommitmentsPage !== 'undefined') CommitmentsPage.open();
        if (ss === 'commitment' && id && typeof CommitmentsPage !== 'undefined') CommitmentsPage.open(id);
        if (ss === 'matters') AppManager.openAppFromLauncher('fyi');
        if (ss === 'app' && id) AppManager.openAppFromLauncher(id);
        if (ss === 'documents' && typeof DocumentsPage !== 'undefined') DocumentsPage.open();
        if (ss === 'taught' && this._taughtOn()) { this._page = 'taught'; this.render(); }
        if (ss.startsWith('taught-')) this._taughtAct(ss, id, b);
        if (ss === 'all') this._full(() => SettingsApp.showRoot?.());
        if (ss === 'developer') this._full(() => SettingsApp.openCategory('build'));
        if (ss.startsWith('backup') || ss === 'passphrase') this._backupAct(ss, id, b);
        if (ss === 'feedback-send') this._sendFeedback(b.closest('.ss-wrap'), b);
        if (ss === 'founder' && typeof WhatsNew !== 'undefined') AppManager.openExternal?.(WhatsNew.FOUNDER_PAGE);
        if (ss === 'about-nenva') AppManager.openAppFromLauncher('about');
        if (ss === 'theme' && typeof AppManager !== 'undefined' && AppManager.setThemePref) { AppManager.setThemePref(id); this.render(); }
        if (ss === 'choose') this.choose(id);
        if (ss === 'remove') this.remove(id);
        if (ss === 'add') this.addModel();
        if (ss === 'one') { this._clearRoutes(); this.render(); }
        if (ss === 'plan-search-key' && typeof HelpActions !== 'undefined') HelpActions.open('web-search');
        if (ss.startsWith('plan-') && ss !== 'plan-search-key') this._planAct(ss, id, b);
    }
};
