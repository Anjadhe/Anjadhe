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
        wrap.innerHTML = this._rootHtml();
    },

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
                <button type="button" class="ss-row" data-ss="all">
                    ${this._tile('<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>')}
                    <span class="ss-label">All settings</span><span class="ss-value"></span>${this._chev}
                </button>
            </div>`;
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
        if (ss.startsWith('google-') || ss.startsWith('apple-')) this._connectorClick(ss, b);
        if (ss === 'commitments' && typeof CommitmentsPage !== 'undefined') CommitmentsPage.open();
        if (ss === 'all') {
            AppManager.openAppFromLauncher('settings');
            if (AppManager.currentApp === 'settings' && typeof SettingsApp !== 'undefined') SettingsApp.showRoot?.();
        }
        if (ss === 'choose') this.choose(id);
        if (ss === 'remove') this.remove(id);
        if (ss === 'add') this.addModel();
        if (ss === 'one') { this._clearRoutes(); this.render(); }
    }
};
