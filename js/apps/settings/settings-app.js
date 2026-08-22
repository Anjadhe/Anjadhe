/**
 * Settings App
 * Full-page settings with storage, backup, theme, AI, auth, and developer options
 */

const SettingsApp = {
    init() {
        this.setupEventListeners();
        this.loadSettings();
        this.renderLogs();
        this.renderSearchLogs();
    },

    render() {
        // Opening Settings always lands on the root category list (iOS-style;
        // predictable), unless a search is mid-flight.
        const searching = !!document.querySelector('.settings-shell.searching');
        if (!searching) this.showRoot();
        this.loadSettings();
        this.renderLogs();
        this.renderSearchLogs();
    },

    /**
     * Build Apps panel — user-built apps platform (docs/PLATFORM.md).
     * Buttons use onclick assignment because loadSettings re-runs on every
     * Settings open and must not stack listeners.
     */
    async _loadUserAppsSettings() {
        const offEl = document.getElementById('settings-userapps-off');
        const onEl = document.getElementById('settings-userapps-on');
        if (!offEl || !onEl || !window.electronApps?.status) return;

        const refresh = async () => {
            const status = await window.electronApps.status();
            offEl.style.display = status.enabled ? 'none' : '';
            onEl.style.display = status.enabled ? '' : 'none';
            if (!status.enabled) return;
            const pathEl = document.getElementById('settings-userapps-path');
            if (pathEl) pathEl.textContent = status.dir;
            const apps = await window.electronApps.list();
            const entries = Array.isArray(apps) ? apps : [];
            const countEl = document.getElementById('settings-userapps-count');
            if (countEl) {
                countEl.textContent = entries.length === 0
                    ? 'No apps yet. Open a terminal in the folder and ask your coding agent to build one.'
                    : `${entries.length} app${entries.length !== 1 ? 's' : ''} installed.`;
            }
            this._renderUserAppsList(entries, refresh);
        };

        const enableBtn = document.getElementById('settings-userapps-enable-btn');
        if (enableBtn) {
            enableBtn.onclick = async () => {
                const result = await window.electronApps.enable();
                if (!result.ok) {
                    UIUtils.showToast(`Could not enable app building: ${result.error}`, 'error');
                    return;
                }
                UIUtils.showToast('App building enabled', 'success');
                await refresh();
            };
        }
        const openBtn = document.getElementById('settings-userapps-open-btn');
        if (openBtn) {
            openBtn.onclick = () => window.electronApps.openFolder();
        }

        await refresh();
    },

    /**
     * Per-app rows under Settings › Build Apps: name, id, stored-data size,
     * and a Reset Data button that clears ONLY that app's storage blob
     * (`userapp-<id>`). The delete rides the normal store path, so it
     * tombstones through sync — the reset reaches the user's other Macs.
     */
    _renderUserAppsList(entries, refresh) {
        const listEl = document.getElementById('settings-userapps-list');
        if (!listEl) return;
        listEl.innerHTML = '';
        for (const entry of entries) {
            const id = entry.dir;
            const name = entry.manifest?.name || id;
            const blob = StorageManager.get(`userapp-${id}`);
            const keys = blob && typeof blob === 'object' ? Object.keys(blob).length : 0;
            const size = blob ? JSON.stringify(blob).length : 0;
            const sizeLabel = !blob || !keys
                ? 'no saved data'
                : (size >= 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`) + ` in ${keys} key${keys !== 1 ? 's' : ''}`;

            const row = document.createElement('div');
            row.className = 'settings-card-row';
            const info = document.createElement('div');
            const title = document.createElement('div');
            title.className = 'settings-card-title';
            title.textContent = name;
            const hint = document.createElement('p');
            hint.className = 'settings-hint';
            hint.textContent = `${id} · ${sizeLabel}${entry.error ? ' · failed to load' : ''}`;
            info.appendChild(title);
            info.appendChild(hint);

            const btn = document.createElement('button');
            btn.className = 'secondary-btn';
            btn.textContent = 'Reset Data';
            btn.disabled = !keys;
            btn.onclick = async () => {
                const ok = await UIUtils.confirm(`Reset ${name}'s data?`,
                    `Everything "${name}" has saved is deleted — on this Mac and, via sync, on your other Macs. The app itself stays installed. This cannot be undone.`);
                if (!ok) return;
                StorageManager.clear(`userapp-${id}`);
                // A running app keeps its own snapshot/DOM — push the now-empty
                // blob into a sandboxed guest, or just repaint a host-side app.
                const app = (typeof AppManager !== 'undefined') ? AppManager.apps[id] : null;
                if (app?._sandboxed && typeof UserAppSandbox !== 'undefined') {
                    UserAppSandbox.pushStorage(id);
                } else if (app) {
                    try { app.render?.(); } catch { /* surfaced via errors.log */ }
                }
                UIUtils.showToast(`${name}'s data was reset`, 'success');
                await refresh();
            };

            row.appendChild(info);
            row.appendChild(btn);
            listEl.appendChild(row);
        }
    },

    async loadSettings() {
        const storageFolder = window.electronStore.getStorageFolder();

        // Storage summary on main settings page
        const storagePathEl = document.getElementById('settings-storage-path');
        if (storagePathEl) storagePathEl.textContent = storageFolder;

        // Setup Assistant: only surface the entry while there's something to
        // do. Hidden once complete; resurfaces on its own if a future release
        // adds new setup steps (isComplete() tracks the live step count).
        const setupGroup = document.getElementById('settings-setup-group');
        const setupNav = document.getElementById('settings-nav-setup');
        if (setupGroup && typeof SetupAssistant !== 'undefined') {
            const incomplete = !SetupAssistant.isComplete();
            setupGroup.style.display = incomplete ? '' : 'none';
            if (setupNav) setupNav.style.display = incomplete ? '' : 'none';
            const setupSummary = document.getElementById('settings-setup-summary');
            if (setupSummary && incomplete) {
                const done = SetupAssistant.completedCount();
                const total = SetupAssistant.steps().length;
                setupSummary.textContent = `${done} of ${total} steps done`;
            }
            // If the user is ON the Setup page and it just completed, return
            // to the root list rather than leaving a blank page.
            if (!incomplete && this._mode === 'category' &&
                document.querySelector('.settings-panel.active')?.dataset.cat === 'setup') {
                this.showRoot();
            }
        }

        // Theme (light / dark / system segmented control)
        this._paintThemeChoice();


        // DevTools state
        const devToggle = document.getElementById('settings-devtools');
        if (devToggle && window.electronAuth?.isDevToolsOpen) {
            window.electronAuth.isDevToolsOpen().then(isOpen => { devToggle.checked = isOpen; });
        }

        // Experimental features (off-by-default flags in js/core/features.js)
        this._renderExperimental();

        // Build Apps (user-built apps platform)
        this._loadUserAppsSettings();

        // AI Assistant summary
        this._loadLLMSummary();

        // Assistant permission grants (docs/COWORK_AGENT.md C1)
        this._loadAgentPermissions();

        // Experimental capability toggles (feature flags)

        // MCP tool servers (docs/COWORK_AGENT.md C2; behind the mcp flag)
        this._loadMCPServers();
        // Saved recipes (docs/COWORK_AGENT.md C8.3)
        this._loadRecipes();

        // Connected accounts (gmail + calendar in one place)
        this._renderConnectedAccounts();

        // Apple Reminders import (iCloud → Tasks, per-Mac opt-in)
        this._renderAppleImport();

        // Paired devices (the phone <-> Mac channel)
        this._renderPairedDevices();

        // Privacy / analytics badge
        const privacyBadge = document.getElementById('settings-privacy-status');
        if (privacyBadge && typeof AnalyticsManager !== 'undefined') {
            privacyBadge.textContent = AnalyticsManager.isEnabled() ? 'On' : 'Off';
        }

        // Network logs count comes from the main process over IPC.
        const netLogBadge = document.getElementById('settings-network-logs-count');
        if (netLogBadge && window.electronNetLog) {
            window.electronNetLog.getLogs()
                .then(logs => { netLogBadge.textContent = Array.isArray(logs) ? logs.length : 0; })
                .catch(() => {});
        }

        // Auth
        const authToggle = document.getElementById('settings-auth-toggle');
        const authSection = document.getElementById('settings-auth-section');
        if (authSection) authSection.style.display = AppManager.authAvailable ? '' : 'none';
        if (authToggle) authToggle.checked = AppManager.authEnabled;

        const autoLockSettings = document.getElementById('settings-auto-lock');
        if (autoLockSettings) autoLockSettings.style.display = AppManager.authEnabled ? '' : 'none';

        const autoLockSelect = document.getElementById('settings-auto-lock-timeout');
        if (autoLockSelect) autoLockSelect.value = AppManager.autoLockTimeout;

        this._loadAppLockSettings();
        this._loadBrowserSearchSettings();
        this._updateRootHints();
    },

    /** Mark the active segment on the Appearance theme control. */
    _paintThemeChoice() {
        const seg = document.getElementById('settings-theme-choice');
        if (!seg) return;
        const pref = AppManager.getThemePref?.() ||
            (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
        seg.querySelectorAll('[data-theme-pref]').forEach(btn => {
            const on = btn.dataset.themePref === pref;
            btn.classList.toggle('is-active', on);
            btn.setAttribute('aria-checked', on ? 'true' : 'false');
        });
    },

    /**
     * Locked apps. The auth mechanism is per-device: Touch ID where available
     * (no app passcode), otherwise an app passcode with security-question
     * recovery. Rendered fresh on every Settings open; controls use property
     * assignment / onclick so the re-run doesn't stack listeners.
     */
    _loadAppLockSettings() {
        const cfg = AppManager.getLockConfig();
        const touch = AppManager.authAvailable;
        const hasPass = !!cfg.passcode;
        const showConfig = touch || hasPass;   // reveal timeout + app picker

        const status = document.getElementById('settings-applock-status');
        if (status) status.textContent = AppManager.isLockEnabled() ? `On · ${cfg.apps.length}` : 'Off';

        const hint = document.getElementById('settings-applock-hint');
        if (hint) hint.textContent = touch
            ? 'Locked apps require Touch ID to open. The Touch ID prompt also lets you use your Mac login password.'
            : 'Locked apps require a passcode to open. Set one below.';

        // Action buttons depend on the mechanism.
        const actions = document.getElementById('settings-applock-actions');
        if (actions) {
            actions.innerHTML = '';
            // "Lock now" lived in the All apps sheet footer until that sheet
            // was removed (2026-07-30). It only means anything while the
            // locked group is open, which is also the only time it appears.
            if (AppManager.sensitiveUnlocked) {
                actions.appendChild(this._mkLockBtn('\u{1F512} Lock now', () => {
                    AppManager.lockSensitiveNow();
                    this._loadAppLockSettings();
                }));
            }
            if (touch) {
                const note = document.createElement('span');
                note.className = 'settings-badge';
                note.textContent = 'Touch ID';
                actions.appendChild(note);
            } else if (!hasPass) {
                actions.appendChild(this._mkLockBtn('Set passcode', () => this._promptSetPasscode()));
            } else {
                actions.appendChild(this._mkLockBtn('Change', () => this._promptSetPasscode()));
                if (AppManager.hasSecurityQuestions()) {
                    actions.appendChild(this._mkLockBtn('Forgot?', () => this.openAppLockRecovery()));
                }
                actions.appendChild(this._mkLockBtn('Turn off', () => this._turnOffAppLock(), 'settings-applock-off-btn'));
            }
        }

        // Options + app picker show on Touch ID devices, or once a passcode exists.
        const options = document.getElementById('settings-applock-options');
        if (options) options.style.display = showConfig ? '' : 'none';
        const appsCard = document.getElementById('settings-applock-apps-card');
        if (appsCard) appsCard.style.display = showConfig ? '' : 'none';

        // The old "Use Touch ID" toggle is gone — Touch ID is implicit now.
        const touchRow = document.getElementById('settings-applock-touchid-row');
        if (touchRow) touchRow.style.display = 'none';

        const timeoutSel = document.getElementById('settings-applock-timeout');
        if (timeoutSel) {
            timeoutSel.value = String(cfg.timeoutMin);
            timeoutSel.onchange = (e) => AppManager.setLockConfig({ timeoutMin: parseInt(e.target.value, 10) || 5 });
        }

        // App checkboxes — built from the dashboard tiles so labels/icons match
        // and user-installed apps are included. Settings/help/about excluded.
        const list = document.getElementById('settings-applock-apps');
        if (list) {
            const seen = new Set();
            const apps = [];
            document.querySelectorAll('.dash-apps-section .dash-app-tile[data-app]').forEach(tile => {
                if (tile.closest('#dash-favorite-apps-row') || tile.closest('#dash-locked-apps-row')) return;
                const id = tile.getAttribute('data-app');
                if (!id || seen.has(id) || !AppManager.canLockApp(id)) return;
                seen.add(id);
                const label = tile.querySelector('.dash-app-tile-label')?.textContent.trim() || id;
                apps.push({ id, label });
            });
            apps.sort((a, b) => a.label.localeCompare(b.label));

            list.innerHTML = '';
            for (const { id, label } of apps) {
                const row = document.createElement('label');
                row.className = 'settings-applock-app-row';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = cfg.apps.includes(id);
                cb.onchange = () => this._toggleLockApp(id, cb.checked);
                const span = document.createElement('span');
                span.textContent = label;
                row.appendChild(cb);
                row.appendChild(span);
                list.appendChild(row);
            }
        }
    },

    _toggleLockApp(appId, on) {
        const cfg = AppManager.getLockConfig();
        const set = new Set(cfg.apps);
        if (on) set.add(appId); else set.delete(appId);
        AppManager.setLockConfig({ apps: Array.from(set) });
        // Reflect the new count badge + refresh the home section.
        const status = document.getElementById('settings-applock-status');
        if (status) status.textContent = AppManager.isLockEnabled() ? `On · ${set.size}` : 'Off';
        AppManager.renderLockedApps();
    },

    _mkLockBtn(text, onClick, extraClass = '') {
        const b = document.createElement('button');
        b.className = 'secondary-btn' + (extraClass ? ' ' + extraClass : '');
        b.textContent = text;
        b.onclick = onClick;
        return b;
    },

    _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    async _turnOffAppLock() {
        const ok = await this._confirmAppLockIdentity('Turn off App Lock', 'Enter your passcode to turn off App Lock.');
        if (!ok) return;
        AppManager.clearLock();
        UIUtils.showToast?.('App Lock turned off', 'success');
        this._loadAppLockSettings();
        AppManager.renderLockedApps();
    },

    /**
     * Set or change the passcode (passcode devices only — Touch ID devices use
     * no app passcode). Initial setup also captures two recovery questions so a
     * forgotten passcode can be reset. Changing keeps the existing questions.
     */
    _promptSetPasscode() {
        const hasPass = !!AppManager.getLockConfig().passcode;
        const wrap = document.createElement('div');
        wrap.className = 'applock-passcode-dialog';
        wrap.innerHTML = `
            ${hasPass ? `
            <label class="applock-dialog-label">Current passcode</label>
            <input type="password" id="applock-cur" class="applock-dialog-input" inputmode="numeric" autocomplete="off">` : ''}
            <label class="applock-dialog-label">New passcode</label>
            <input type="password" id="applock-new" class="applock-dialog-input" inputmode="numeric" autocomplete="off" placeholder="At least 4 characters">
            <label class="applock-dialog-label">Confirm passcode</label>
            <input type="password" id="applock-confirm" class="applock-dialog-input" inputmode="numeric" autocomplete="off">
            ${hasPass ? '' : `
            <div class="applock-dialog-section">Recovery questions</div>
            <p class="applock-dialog-prompt">If you forget your passcode, you'll answer these to reset it. Pick answers you'll remember.</p>
            <label class="applock-dialog-label">Question 1</label>
            <input type="text" id="applock-q1" class="applock-dialog-input" autocomplete="off" placeholder="e.g. First pet's name">
            <label class="applock-dialog-label">Answer 1</label>
            <input type="text" id="applock-a1" class="applock-dialog-input" autocomplete="off">
            <label class="applock-dialog-label">Question 2</label>
            <input type="text" id="applock-q2" class="applock-dialog-input" autocomplete="off" placeholder="e.g. City you were born in">
            <label class="applock-dialog-label">Answer 2</label>
            <input type="text" id="applock-a2" class="applock-dialog-input" autocomplete="off">`}
            <p id="applock-dialog-error" class="applock-dialog-error" style="display:none;"></p>`;

        const showErr = (msg) => {
            const e = wrap.querySelector('#applock-dialog-error');
            e.textContent = msg; e.style.display = '';
        };

        let modalRef = null;
        modalRef = Modal.create({
            title: hasPass ? 'Change passcode' : 'Set passcode',
            content: wrap,
            className: 'applock-passcode-modal',
            buttons: [
                { text: 'Cancel', className: 'secondary-btn', onClick: () => modalRef.close() },
                {
                    text: 'Save',
                    className: 'primary-btn',
                    onClick: async () => {
                        if (hasPass) {
                            const cur = wrap.querySelector('#applock-cur').value;
                            if (!(await AppManager.verifyPasscode(cur))) {
                                showErr('Current passcode is incorrect'); return;
                            }
                        }
                        const np = wrap.querySelector('#applock-new').value;
                        const cp = wrap.querySelector('#applock-confirm').value;
                        if (np.length < 4) { showErr('Passcode must be at least 4 characters'); return; }
                        if (np !== cp) { showErr('Passcodes do not match'); return; }

                        let qa = null;
                        if (!hasPass) {
                            const q1 = wrap.querySelector('#applock-q1').value.trim();
                            const a1 = wrap.querySelector('#applock-a1').value.trim();
                            const q2 = wrap.querySelector('#applock-q2').value.trim();
                            const a2 = wrap.querySelector('#applock-a2').value.trim();
                            if (!q1 || !a1 || !q2 || !a2) {
                                showErr('Fill in both recovery questions and answers'); return;
                            }
                            qa = [{ question: q1, answer: a1 }, { question: q2, answer: a2 }];
                        }

                        await AppManager.setPasscode(np);
                        if (qa) await AppManager.setSecurityQuestions(qa);
                        modalRef.close();
                        UIUtils.showToast?.(hasPass ? 'Passcode changed' : 'Passcode set', 'success');
                        this._loadAppLockSettings();
                        AppManager.renderLockedApps();
                    }
                }
            ]
        });
        setTimeout(() => wrap.querySelector(hasPass ? '#applock-cur' : '#applock-new')?.focus(), 50);
    },

    /**
     * Recovery flow: answer the security questions to reset a forgotten
     * passcode. On success the passcode + questions are cleared and the user is
     * taken straight into setting a fresh passcode.
     */
    openAppLockRecovery() {
        const questions = AppManager.getSecurityQuestions();
        if (!questions.length) {
            UIUtils.showToast?.('No recovery questions are set on this device.', 'error');
            return;
        }
        const wrap = document.createElement('div');
        wrap.className = 'applock-passcode-dialog';
        wrap.innerHTML = `
            <p class="applock-dialog-prompt">Answer your recovery questions to reset the passcode.</p>
            ${questions.map((q, i) => `
                <label class="applock-dialog-label">${this._esc(q)}</label>
                <input type="text" class="applock-dialog-input applock-recovery-answer" data-i="${i}" autocomplete="off">`).join('')}
            <p id="applock-recovery-error" class="applock-dialog-error" style="display:none;"></p>`;

        let modalRef = null;
        modalRef = Modal.create({
            title: 'Reset passcode',
            content: wrap,
            className: 'applock-passcode-modal',
            buttons: [
                { text: 'Cancel', className: 'secondary-btn', onClick: () => modalRef.close() },
                {
                    text: 'Verify',
                    className: 'primary-btn',
                    onClick: async () => {
                        const answers = Array.from(wrap.querySelectorAll('.applock-recovery-answer')).map(i => i.value);
                        if (await AppManager.verifySecurityAnswers(answers)) {
                            AppManager.clearLock();
                            modalRef.close();
                            UIUtils.showToast?.('Verified — set a new passcode', 'success');
                            this._loadAppLockSettings();
                            AppManager.renderLockedApps();
                            this._promptSetPasscode();
                        } else {
                            const e = wrap.querySelector('#applock-recovery-error');
                            e.textContent = 'One or more answers are incorrect'; e.style.display = '';
                        }
                    }
                }
            ]
        });
        setTimeout(() => wrap.querySelector('.applock-recovery-answer')?.focus(), 50);
    },

    /**
     * Lightweight passcode confirmation modal (used before turning the feature
     * off). Resolves true when the entered passcode is correct.
     */
    _confirmAppLockIdentity(title, prompt) {
        return new Promise((resolve) => {
            const wrap = document.createElement('div');
            wrap.className = 'applock-passcode-dialog';
            wrap.innerHTML = `
                <p class="applock-dialog-prompt">${prompt}</p>
                <input type="password" id="applock-verify" class="applock-dialog-input" inputmode="numeric" autocomplete="off">
                <p id="applock-verify-error" class="applock-dialog-error" style="display:none;"></p>`;
            let modalRef = null;
            modalRef = Modal.create({
                title,
                content: wrap,
                className: 'applock-passcode-modal',
                onClose: () => resolve(false),
                buttons: [
                    { text: 'Cancel', className: 'secondary-btn', onClick: () => { modalRef.close(); } },
                    {
                        text: 'Confirm',
                        className: 'primary-btn',
                        onClick: async () => {
                            const val = wrap.querySelector('#applock-verify').value;
                            if (await AppManager.verifyPasscode(val)) {
                                resolve(true);
                                modalRef.close();
                            } else {
                                const e = wrap.querySelector('#applock-verify-error');
                                e.textContent = 'Incorrect passcode'; e.style.display = '';
                            }
                        }
                    }
                ]
            });
            setTimeout(() => wrap.querySelector('#applock-verify')?.focus(), 50);
        });
    },

    _loadBrowserSearchSettings() {
        const data = StorageManager.get('browse_settings') || {};
        const engine = data.searchEngine || 'duckduckgo';
        const custom = data.customSearchUrl || '';
        const sel = document.getElementById('settings-search-engine');
        const customWrap = document.getElementById('settings-search-engine-custom-wrap');
        const customInput = document.getElementById('settings-search-engine-custom-url');
        if (sel) sel.value = engine;
        if (customInput) customInput.value = custom;
        if (customWrap) customWrap.style.display = engine === 'custom' ? '' : 'none';
    },

    // Active two-pane category. Persisted on the instance so returning from a
    // drill-in sub-view (which just re-activates #settings-view) keeps the
    // user where they were. Default to AI.
    _activeCategory: 'ai',

    // ── Two-pane navigator + search ──────────────────────────────────

    _setupNavigator() {
        if (this._navigatorBound) return;
        this._navigatorBound = true;

        // Root list rows (iOS-style): tap a category row → its page.
        const list = document.getElementById('settings-nav-list');
        if (list) {
            list.addEventListener('click', (e) => {
                // Direct drill-ins skip the category layer (the AI Assistant
                // and Data & Storage cards go straight to their pages — no
                // intermediate one-card category page).
                const direct = e.target.closest('[data-open]');
                if (direct) {
                    if (direct.dataset.open === 'llm') this.openLLMSettings();
                    else if (direct.dataset.open === 'storage') this.openStorageBackup();
                    else if (direct.dataset.open === 'setup') this.openSetupAssistant();
                    return;
                }
                const item = e.target.closest('[data-cat]');
                if (!item) return;
                this.openCategory(item.dataset.cat);
            });
        }

        const search = document.getElementById('settings-search');
        if (search) {
            search.addEventListener('input', () => this._runSearch(search.value));
            search.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && search.value) {
                    search.value = '';
                    this._runSearch('');
                }
            });
        }

        this.showRoot();
    },

    // ── iOS-style shell modes: 'root' (category list) / 'category' (one page) ──

    showRoot() {
        this._mode = 'root';
        const root = document.getElementById('settings-root');
        if (root) root.style.display = '';
        document.querySelectorAll('#settings-detail .settings-panel').forEach(p => p.classList.remove('active'));
        const shell = document.querySelector('.settings-shell');
        if (shell) shell.classList.remove('in-category');
        Breadcrumb.render('settings-breadcrumb', [{ label: 'Settings' }]);
        this._updateRootHints();
    },

    openCategory(cat) {
        if (!cat) return;
        // Retired categories (2026-07-30): Advanced merged into the Developer
        // page; the Data & Storage layer collapsed into its one destination.
        // 'ai' and 'data' are search-only stub panels, never pages.
        if (cat === 'advanced') cat = 'build';
        if (cat === 'data') { this.openStorageBackup(); return; }
        if (cat === 'ai') { this.openLLMSettings(); return; }
        if (cat === 'setup') { this.openSetupAssistant(); return; }
        this._mode = 'category';
        const root = document.getElementById('settings-root');
        if (root) root.style.display = 'none';
        const shell = document.querySelector('.settings-shell');
        if (shell) shell.classList.add('in-category');

        let label = cat;
        document.querySelectorAll('#settings-detail .settings-panel').forEach(p => {
            const active = p.dataset.cat === cat;
            p.classList.toggle('active', active);
            if (active) {
                const t = p.querySelector('.settings-panel-title');
                if (t) label = t.textContent.trim();
            }
        });
        Breadcrumb.render('settings-breadcrumb', [
            { label: 'Settings', action: () => this.showRoot() },
            { label }
        ]);

        // The paired-devices panel reflects live channel state — refresh on open.
        if (cat === 'devices') this._renderPairedDevices();
        // Library engine state (model presence, index counts) is read fresh
        // on every open — a download or an import may have finished since.
        if (cat === 'library') this._renderLibrarySettings();
        // The feedback card shows the actual values a send would carry —
        // collected fresh on every open, since the model or a setting may
        // have changed since the last look.
        if (cat === 'feedback') this._renderFeedbackDisclosure();
    },

    // Fill the app-details line with what collectDiagnostics would send,
    // and reveal the analytics-id row only when there is an id to offer
    // (analytics opted in). The checkbox itself always starts unchecked —
    // attaching the id is a per-message decision, never a remembered one.
    async _renderFeedbackDisclosure() {
        const line = document.getElementById('feedback-details-line');
        if (!line) return;
        try {
            const d = await FeedbackManager.collectDiagnostics();
            line.textContent = d.details || '';
            const opt = document.getElementById('feedback-analytics-opt');
            if (opt) {
                opt.hidden = !d.analyticsId;
                const box = document.getElementById('feedback-include-analytics');
                if (box) box.checked = false;
            }
        } catch { line.textContent = ''; }
    },

    // Back-compat alias (harnesses + older callers).
    _selectCategory(cat) {
        this.openCategory(cat);
    },

    // Current-value hints on the root rows — filled from data loadSettings
    // already fetched. Each is best-effort; a missing source leaves the
    // static hint empty rather than erroring.
    _updateRootHints() {
        const set = (id, text) => {
            const el = document.getElementById(id);
            if (el) el.textContent = text || '';
        };
        try {
            if (typeof SetupAssistant !== 'undefined' && !SetupAssistant.isComplete()) {
                const done = SetupAssistant.completedCount();
                const total = SetupAssistant.steps().length;
                set('settings-root-hint-setup', `${done} of ${total} steps done`);
                const bar = document.getElementById('settings-root-setup-progress');
                if (bar) {
                    bar.hidden = false;
                    const fill = bar.querySelector('.settings-setup-progress-fill');
                    if (fill) fill.style.width = `${Math.round((done / Math.max(total, 1)) * 100)}%`;
                }
            }
        } catch {}
        // AI: the default model entry IS the brain — same source as the
        // AI Assistant sub-view, so the two can't disagree.
        try {
            const def = AgentService.getDefaultEntry?.();
            if (def) {
                const where = def.engine === 'server' ? 'Your server'
                    : def.engine === 'openai' ? 'OpenAI'
                    : def.engine === 'anthropic' ? 'Anthropic'
                    : def.engine === 'anjadhe' ? 'Anjadhe Cloud'
                    : 'This Mac';
                // Anjadhe Cloud entries name themselves by catalog label —
                // "Anjadhe Cloud · anjadhe-cloud" would be a stutter.
                const what = def.engine === 'anjadhe'
                    ? AgentService.anjadheEntryLabel(def) : def.model;
                set('settings-root-hint-ai', what === where ? where : `${where} · ${what}`);
            } else {
                set('settings-root-hint-ai', 'No model yet');
            }
        } catch {}
        try {
            const n = (typeof AccountsManager !== 'undefined') ? (AccountsManager.getAll() || []).length : 0;
            set('settings-root-hint-accounts', n ? `${n} account${n === 1 ? '' : 's'} connected` : 'Connect Google');
        } catch { set('settings-root-hint-accounts', ''); }
        set('settings-root-hint-data', 'Storage and backups');
        {
            const pref = AppManager.getThemePref?.() ||
                (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
            set('settings-root-hint-appearance',
                pref === 'system' ? 'System' : pref === 'dark' ? 'Dark' : 'Light');
        }
        try {
            const on = (typeof AnalyticsManager !== 'undefined') && AnalyticsManager.isEnabled();
            set('settings-root-hint-privacy', on ? 'Analytics on' : 'Analytics off');
        } catch {}
        try {
            const engineNames = {
                duckduckgo: 'DuckDuckGo', google: 'Google', bing: 'Bing',
                startpage: 'Startpage', kagi: 'Kagi', brave: 'Brave Search',
                ecosia: 'Ecosia', custom: 'Custom search'
            };
            const engine = (StorageManager.get('browse_settings') || {}).searchEngine || 'duckduckgo';
            set('settings-root-hint-browser', engineNames[engine] || 'DuckDuckGo');
        } catch { set('settings-root-hint-browser', ''); }
        set('settings-root-hint-devices', '');
        set('settings-root-hint-build', 'Build apps, developer tools');
    },

    // Live, cross-category filter. Empty query restores normal single-panel
    // mode; a query stacks every panel and hides cards that don't match,
    // collapsing groups/subheads/panels that end up empty.
    _runSearch(raw) {
        const shell = document.querySelector('.settings-shell');
        if (!shell) return;
        const q = (raw || '').trim().toLowerCase();

        const rootList = document.getElementById('settings-nav-list');

        if (!q) {
            shell.classList.remove('searching');
            shell.querySelectorAll('.search-hide').forEach(n => n.classList.remove('search-hide'));
            shell.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('has-match'));
            const empty = document.getElementById('settings-search-empty');
            if (empty) empty.style.display = 'none';
            if (rootList) rootList.style.display = '';
            this.showRoot();
            return;
        }

        // Searching: hide the category rows, stack matching panel content
        // below the search box (root stays visible as the container).
        if (this._mode === 'category') this.showRoot();
        if (rootList) rootList.style.display = 'none';
        shell.classList.add('searching');
        let anyMatch = false;

        shell.querySelectorAll('.settings-panel').forEach(panel => {
            // A hidden conditional section (e.g. Setup/Security) shouldn't surface.
            const conditionallyHidden = panel.dataset.cat === 'setup'
                && (() => { const g = document.getElementById('settings-setup-group'); return g && g.style.display === 'none'; })();

            let panelHasMatch = false;
            panel.querySelectorAll('.settings-card').forEach(card => {
                // A card inside feature-gated-off UI never matches — otherwise
                // its keywords would surface an empty panel title in the stack.
                const gate = card.closest('[data-feature]');
                const gatedOff = gate && typeof FEATURES !== 'undefined'
                    && !FEATURES.isEnabled(gate.getAttribute('data-feature'));
                const hay = (card.textContent + ' ' + (card.dataset.keywords || '')).toLowerCase();
                const match = !conditionallyHidden && !gatedOff && hay.includes(q);
                card.classList.toggle('search-hide', !match);
                if (match) panelHasMatch = true;
            });

            // Collapse empty groups and their subheads.
            panel.querySelectorAll('.settings-card-group').forEach(g => {
                const visible = g.querySelector('.settings-card:not(.search-hide)');
                g.classList.toggle('search-hide', !visible);
            });
            panel.querySelectorAll('.settings-subhead').forEach(sh => {
                let next = sh.nextElementSibling;
                while (next && !next.classList.contains('settings-card-group')) next = next.nextElementSibling;
                sh.classList.toggle('search-hide', !next || next.classList.contains('search-hide'));
            });

            panel.classList.toggle('has-match', panelHasMatch);
            if (panelHasMatch) anyMatch = true;
        });

        const empty = document.getElementById('settings-search-empty');
        if (empty) empty.style.display = anyMatch ? 'none' : '';
    },

    setupEventListeners() {
        this._setupNavigator();

        // Open Setup Assistant sub-view
        this._bindBtn('settings-open-setup-btn', () => {
            this.openSetupAssistant();
        });

        // Open Storage & Backup sub-view
        this._bindBtn('settings-open-storage-btn', () => {
            this.openStorageBackup();
        });

        // Open Customize Home Apps sub-view
        this._bindBtn('settings-open-home-apps-btn', () => {
            AppManager.openAppVisibilityModal('settings');
        });

        // Email preferences (global across accounts, on the Accounts panel)
        this._bindBtn('settings-open-email-prefs-btn', () => {
            AppManager.openAppSettings('email');
        });

        // Theme: three-way segmented control. The titlebar button stays a
        // plain light/dark toggle; picking an explicit segment here (or
        // toggling there) leaves System mode.
        const seg = document.getElementById('settings-theme-choice');
        if (seg && !seg._bound) {
            seg._bound = true;
            seg.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-theme-pref]');
                if (!btn) return;
                AppManager.setThemePref(btn.dataset.themePref);
                this._paintThemeChoice();
                this._updateRootHints();
            });
        }

        // DevTools
        this._bindChange('settings-devtools', async () => {
            const isOpen = await window.electronAuth.toggleDevTools();
            const cb = document.getElementById('settings-devtools');
            if (cb) cb.checked = isOpen;
        }, true);

        // Open AI Assistant sub-view (provider routing + web search key)
        this._bindBtn('settings-open-llm-btn', () => {
            this.openLLMSettings();
        });

        // Memories / LLM Logs / Web Search Logs each get their own sub-view,
        // opened on demand from the AI Assistant page — they were inline-rendered
        // sections before but carry heavy DOM and only matter when a user wants
        // to inspect/edit them.
        // Web-search setup walkthrough on the website (free-key signup steps).
        this._bindBtn('settings-search-help-link', (e) => {
            e.preventDefault();
            window.electronAuth.openExternal('https://anjadhe.ai/help/web-search');
        });

        this._bindBtn('settings-open-memories-btn', () => this.openMemoriesSettings());
        this._bindBtn('settings-open-llm-logs-btn', () => this.openLlmLogs());
        this._bindBtn('settings-open-search-logs-btn', () => this.openSearchLogs());
        this._bindBtn('settings-open-network-logs-btn', () => this.openNetworkLogs());
        this._bindBtn('settings-network-logs-refresh-btn', () => this.renderNetworkLogs());
        this._bindBtn('settings-network-logs-clear-btn', async () => {
            try { await window.electronNetLog.clear(); } catch {}
            this.renderNetworkLogs();
            UIUtils.showToast('Network logs cleared', 'success');
        });

        // Open Privacy settings sub-view
        this._bindBtn('settings-open-privacy-btn', () => {
            this.openPrivacySettings();
        });

        // Send Feedback: one POST on click, result stated inline. The
        // message field clears only on success — a failed send must not
        // eat what the user wrote.
        this._bindBtn('feedback-send-btn', async () => {
            const btn = document.getElementById('feedback-send-btn');
            const status = document.getElementById('feedback-status');
            const msg = document.getElementById('feedback-message');
            btn.disabled = true;
            status.textContent = 'Sending…';
            status.classList.remove('is-error');
            const r = await FeedbackManager.send({
                kind: document.getElementById('feedback-kind')?.value,
                message: msg?.value,
                email: document.getElementById('feedback-email')?.value,
                includeDetails: document.getElementById('feedback-include-details')?.checked !== false,
                includeAnalyticsId: document.getElementById('feedback-include-analytics')?.checked === true
            });
            btn.disabled = false;
            if (r.success) {
                if (msg) msg.value = '';
                status.textContent = 'Sent. Thank you!';
            } else {
                status.textContent = r.error;
                status.classList.add('is-error');
            }
        });

        this._bindBrowserSearchControls();

        // Auth toggle
        const authToggle = document.getElementById('settings-auth-toggle');
        if (authToggle) {
            const newEl = authToggle.cloneNode(true);
            authToggle.parentNode.replaceChild(newEl, authToggle);
            newEl.addEventListener('change', async (e) => {
                const enabled = e.target.checked;

                if (enabled) {
                    const result = await window.electronAuth.promptTouchID();
                    if (!result.success) {
                        e.target.checked = false;
                        return;
                    }
                }

                AppManager.authEnabled = enabled;
                await window.electronAuth.setAuthEnabled(enabled);

                const autoLock = document.getElementById('settings-auto-lock');
                if (autoLock) autoLock.style.display = enabled ? '' : 'none';

                if (enabled) {
                    AppManager.lastActivityTime = Date.now();
                    AppManager.startActivityTracking();
                } else {
                    AppManager.stopActivityTracking();
                }
            });
        }

        // Auto-lock timeout
        this._bindChange('settings-auto-lock-timeout', async (val) => {
            const minutes = parseInt(val, 10);
            AppManager.autoLockTimeout = minutes;
            await window.electronAuth.setAutoLockTimeout(minutes);
            AppManager.lastActivityTime = Date.now();
        });

    },

    // ── AI Assistant summary + sub-view ──

    async _loadLLMSummary() {
        // The default model entry IS the brain — summarize it directly.
        const engineLabels = { llamacpp: 'Local', server: 'Your server', openai: 'OpenAI', anthropic: 'Anthropic', anjadhe: 'Anjadhe Cloud' };
        try { await AgentService.ensureModelList?.(); } catch { /* offline */ }
        const def = AgentService.getDefaultEntry?.() || null;

        const provEl = document.getElementById('settings-llm-provider-display');
        if (provEl) provEl.textContent = def ? (engineLabels[def.engine] || def.engine) : '--';

        const localEl = document.getElementById('settings-llm-local-display');
        if (localEl) localEl.textContent = def ? def.model : '--';
    },

    /**
     * Assistant permission grants — standing "always allow" permissions
     * (docs/COWORK_AGENT.md C1). Machine-local; revoking restores the
     * confirmation dialog for that action.
     */
    async _loadAgentPermissions() {
        const list = document.getElementById('settings-agent-permissions-list');
        if (!list || typeof PermissionManager === 'undefined') return;
        await PermissionManager.ready();
        const grants = PermissionManager.listGrants();
        if (!grants.length) {
            list.innerHTML = '<p class="settings-hint" style="font-style: italic;">No standing permissions. The assistant asks each time.</p>';
            return;
        }
        const esc = UIUtils.escapeHtml;
        // Each grant renders as: short scannable TITLE, then the exact scope
        // (path / full command) as a one-line truncated monospace detail —
        // a five-line bold shell command was unreadable as a title
        // (2026-07-30 redesign). Full text stays available in the tooltip.
        const rowParts = (g) => {
            if (g.tool === 'fs:read') return { title: 'Read files', detail: g.scope };
            if (g.tool === 'fs:write') return { title: 'Write files', detail: g.scope };
            if (g.tool === 'shell') {
                // Handle = the command's first word (plus a plain subcommand
                // word: "brew install", not "curl -fsSL…").
                const toks = String(g.scope || '').trim().split(/\s+/);
                let title = toks[0] || 'command';
                // Second word only when it's a plain subcommand, never a flag.
                if (/^[a-z0-9._][a-z0-9._-]*$/i.test(toks[1] || '')) title += ` ${toks[1]}`;
                return { title, detail: g.scope };
            }
            if (g.tool.startsWith('mcp:')) {
                return { title: g.tool.slice(4), detail: 'Every tool from this server is trusted' };
            }
            const t = g.tool.replace(/_/g, ' ');
            return { title: t.charAt(0).toUpperCase() + t.slice(1), detail: '' };
        };
        // C8.6 bounds on a standing grant: daily budget, expiry, exclusions —
        // shown inline so a grant's real coverage is always visible.
        const bounds = (g) => {
            const bits = [];
            if (g.budget > 0) {
                const today = new Date().toISOString().slice(0, 10);
                const used = g.usedDay === today ? (g.usedCount || 0) : 0;
                bits.push(`${used}/${g.budget} today`);
            }
            if (g.expiresAt) bits.push(`until ${new Date(g.expiresAt).toLocaleDateString()}`);
            if ((g.exclusions || []).includes('new_recipient')) bits.push('known contacts only');
            return bits.join(' · ');
        };
        // One quiet line per grant — grants accumulate over months, and the
        // old three-line card with always-visible buttons made this page a
        // wall of chrome. Scope and bounds share the line (full text in the
        // detail tooltip), the grant date lives in the row tooltip, and the
        // Limit/Revoke actions appear on hover or keyboard focus.
        const row = (g) => {
            const p = rowParts(g);
            const b = bounds(g);
            const created = new Date(g.createdAt);
            return `
            <div class="agent-perm-row" data-grant="${esc(g.id)}" title="Granted ${esc(created.toLocaleDateString())}">
                <span class="agent-perm-title">${esc(p.title)}</span>
                ${p.detail ? `<span class="agent-perm-detail" title="${esc(p.detail)}">${esc(p.detail)}</span>` : ''}
                ${b ? `<span class="agent-perm-bounds">${esc(b)}</span>` : ''}
                <span class="settings-row-actions">
                    <button class="secondary-btn" data-limit="${esc(g.id)}">Limit&hellip;</button>
                    <button class="secondary-btn" data-revoke="${esc(g.id)}">Revoke</button>
                </span>
            </div>`;
        };
        // Grouped by kind — a flat mixed list buried the two file grants
        // under a dozen commands. Newest first inside each group.
        const GROUPS = [
            ['Files & folders', (g) => g.tool === 'fs:read' || g.tool === 'fs:write'],
            ['Commands', (g) => g.tool === 'shell'],
            ['Tool servers', (g) => g.tool.startsWith('mcp:')],
            ['App abilities', () => true]
        ];
        const remaining = [...grants].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        let html = '';
        for (const [name, match] of GROUPS) {
            const mine = remaining.filter(match);
            for (const g of mine) remaining.splice(remaining.indexOf(g), 1);
            if (!mine.length) continue;
            html += `<div class="settings-subhead">${name} <span class="settings-badge">${mine.length}</span></div>
                <div class="settings-card-group">${mine.map(row).join('')}</div>`;
        }
        list.innerHTML = html;
        list.querySelectorAll('button[data-revoke]').forEach(btn => {
            btn.onclick = async () => {
                await PermissionManager.revoke(btn.dataset.revoke);
                UIUtils.showToast('Permission revoked — the assistant will ask again', 'success');
                this._loadAgentPermissions();
            };
        });
        // Inline limit editor: two small inputs in place of the row actions.
        // is-editing pins the hover-revealed actions visible while it's open.
        list.querySelectorAll('button[data-limit]').forEach(btn => {
            btn.onclick = () => {
                const row = btn.closest('[data-grant]');
                row.classList.add('is-editing');
                const g = grants.find(x => x.id === row.dataset.grant);
                const actions = row.querySelector('.settings-row-actions');
                actions.innerHTML = `
                    <label class="settings-hint" style="margin:0;">per day <input type="number" min="0" max="999" data-budget style="width:52px;" value="${g.budget > 0 ? g.budget : ''}" placeholder="&infin;"></label>
                    <label class="settings-hint" style="margin:0;">days left <input type="number" min="0" max="365" data-days style="width:52px;" value="${g.expiresAt ? Math.max(1, Math.ceil((Date.parse(g.expiresAt) - Date.now()) / 86400000)) : ''}" placeholder="&infin;"></label>
                    <button class="secondary-btn" data-save-limit>Save</button>`;
                actions.querySelector('[data-save-limit]').onclick = async () => {
                    await PermissionManager.setGrantBounds(g.id, {
                        budget: actions.querySelector('[data-budget]').value,
                        expiresInDays: actions.querySelector('[data-days]').value
                    });
                    UIUtils.showToast('Limits saved', 'success');
                    this._loadAgentPermissions();
                };
            };
        });
    },


    /**
     * Saved recipes (docs/COWORK_AGENT.md C8.3): list + remove. Creation
     * happens only from a clean-verified task's card, never here.
     */
    _loadRecipes() {
        const list = document.getElementById('settings-recipes-list');
        if (!list || typeof RecipeService === 'undefined') return;
        const esc = UIUtils.escapeHtml;
        const recipes = RecipeService.all();
        if (!recipes.length) {
            list.innerHTML = '<p class="settings-hint" style="font-style: italic;">No recipes yet. When a task finishes and verifies cleanly, its card offers "Save as recipe".</p>';
            return;
        }
        list.innerHTML = recipes.map(r => `
            <div class="settings-toggle-row" data-recipe="${esc(r.id)}">
                <span class="settings-toggle-label" style="flex-direction: column; align-items: flex-start; gap: 2px;">
                    <strong>${esc(r.name)}</strong>
                    <span class="settings-hint" style="margin: 0;">
                        ${esc(r.description)}
                        &middot; ${r.steps.length} step${r.steps.length === 1 ? '' : 's'}
                        ${(r.slots || []).length ? ` &middot; params: ${esc(r.slots.map(s => s.name).join(', '))}` : ''}
                        ${r.uses ? ` &middot; used ${r.uses}&times;` : ''}
                    </span>
                </span>
                <span class="settings-row-actions">
                    <button class="secondary-btn" data-recipe-action="remove">Remove</button>
                </span>
            </div>`).join('');
        list.onclick = (e) => {
            const btn = e.target.closest('button[data-recipe-action="remove"]');
            if (!btn) return;
            const id = btn.closest('[data-recipe]')?.dataset.recipe;
            if (!id) return;
            RecipeService.remove(id);
            UIUtils.showToast('Recipe removed', 'success');
            this._loadRecipes();
        };
    },

    /**
     * Curated one-click connections (C8.7). Hosted (url) entries need no
     * local runtime; tokenPrompt entries paste a key inline (stored
     * encrypted as an Authorization header); needsNode entries are checked
     * against this Mac at Add time. remote-config `mcpPresets` replaces
     * this list without a release — review it each release alongside the
     * model catalog (RELEASING.md).
     */
    MCP_PRESETS: [
        {
            name: 'browser', label: 'Browser (Playwright)', recommended: true, needsNode: true,
            command: 'npx', args: ['-y', '@playwright/mcp@latest'],
            desc: 'Lets the assistant open websites, click, and fill forms in a real browser window on this Mac.'
        },
        {
            name: 'deepwiki', label: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp',
            desc: 'Lets the assistant look up and ask questions about any public GitHub repository\'s code and docs. Hosted service, no install, no account.'
        },
        {
            name: 'context7', label: 'Context7 docs', url: 'https://mcp.context7.com/mcp',
            desc: 'Up-to-date documentation for programming libraries, so coding answers cite current APIs instead of stale ones. Hosted service, no install.'
        },
        {
            name: 'github', label: 'GitHub', url: 'https://api.githubcopilot.com/mcp/',
            tokenPrompt: 'a GitHub personal access token', tokenPlaceholder: 'ghp_…',
            desc: 'Work with your GitHub issues, pull requests, and repositories. Hosted by GitHub, no install.'
        }
    ],
    _mcpPresets: null,

    async _loadMCPPresetOverride() {
        if (this._mcpPresets !== null) return;
        try {
            const cfg = await window.electronConfig?.get?.();
            if (Array.isArray(cfg?.mcpPresets) && cfg.mcpPresets.length) this._mcpPresets = cfg.mcpPresets;
            else this._mcpPresets = undefined;   // checked, no override
        } catch { this._mcpPresets = undefined; }
    },

    /**
     * MCP tool servers (docs/COWORK_AGENT.md C2). List + add/remove +
     * enable + test + per-server trust. Server processes and secrets live
     * in main; this is config UX only.
     */
    async _loadMCPServers() {
        await this._loadMCPPresetOverride();
        const list = document.getElementById('settings-mcp-list');
        if (!list || !window.electronMCP?.listServers) return;
        if (typeof FEATURES !== 'undefined' && !FEATURES.isEnabled('mcp')) return;

        const esc = UIUtils.escapeHtml;
        const servers = await window.electronMCP.listServers();
        await (typeof PermissionManager !== 'undefined' ? PermissionManager.ready() : Promise.resolve());
        const trusted = new Set(
            (typeof PermissionManager !== 'undefined' ? PermissionManager.listGrants() : [])
                .filter(g => g.tool.startsWith('mcp:')).map(g => g.tool.slice(4))
        );

        // Curated one-click connections (C8.7 — the C6 browser preset shape,
        // generalized): name, what it does, what it needs, one Add button.
        // Hosted (URL) entries need no local runtime; token entries paste a
        // key inline (stored encrypted); stdio entries state their runtime
        // requirement at Add time instead of failing cryptically later.
        // remote-config `mcpPresets` can extend/replace this list without a
        // release (same pattern as the model catalog).
        const presets = (this._mcpPresets || this.MCP_PRESETS)
            .filter(p => !servers.some(s => s.name === p.name));
        const presetHtml = presets.map(p => `
            <div class="settings-toggle-row" data-mcp-preset-row="${esc(p.name)}">
                <span class="settings-toggle-label" style="flex-direction: column; align-items: flex-start; gap: 2px;">
                    <strong>${esc(p.label)}${p.recommended ? ' &middot; recommended' : ''}</strong>
                    <span class="settings-hint" style="margin: 0;">${esc(p.desc)}${p.needsNode ? ' Needs Node.js.' : ''}${p.tokenPrompt ? ` Needs ${esc(p.tokenPrompt)}.` : ''} Every action asks for permission first.</span>
                </span>
                <span class="settings-row-actions">
                    ${p.tokenPrompt ? `<input type="password" class="settings-form-input" data-preset-token style="width: 150px;" placeholder="${esc(p.tokenPlaceholder || 'paste token')}">` : ''}
                    <button class="secondary-btn" data-mcp-preset="${esc(p.name)}">Add</button>
                </span>
            </div>`).join('');

        if (!servers.length) {
            list.innerHTML = presetHtml || '<p class="settings-hint" style="font-style: italic;">No servers yet.</p>';
        } else {
            list.innerHTML = presetHtml + servers.map(s => `
                <div class="settings-toggle-row" data-mcp="${esc(s.name)}">
                    <span class="settings-toggle-label" style="flex-direction: column; align-items: flex-start; gap: 2px;">
                        <strong>${esc(s.name)}</strong>
                        <span class="settings-hint" style="margin: 0;">
                            <code>${esc(s.url ? s.url : `${s.command} ${(s.args || []).join(' ')}`)}</code>
                            &middot; ${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}
                            ${s.transport === 'http' ? ' &middot; hosted' : ''}
                            ${s.running ? ' &middot; running' : ''}
                            ${trusted.has(s.name) ? ' &middot; trusted' : ''}
                        </span>
                    </span>
                    <span class="settings-row-actions">
                        <button class="secondary-btn" data-mcp-action="test">Test</button>
                        <button class="secondary-btn" data-mcp-action="trust">${trusted.has(s.name) ? 'Untrust' : 'Trust'}</button>
                        <button class="secondary-btn" data-mcp-action="toggle">${s.enabled ? 'Disable' : 'Enable'}</button>
                        <button class="secondary-btn" data-mcp-action="remove">Remove</button>
                    </span>
                </div>`).join('');
        }

        list.onclick = async (e) => {
            const presetBtn = e.target.closest('button[data-mcp-preset]');
            if (presetBtn) {
                const preset = (this._mcpPresets || this.MCP_PRESETS).find(p => p.name === presetBtn.dataset.mcpPreset);
                if (!preset) return;
                // Failure honesty (C8.7): a runtime the Mac doesn't have is a
                // sentence at Add time, not a cryptic first-tool-call error.
                if (preset.needsNode) {
                    const rt = await window.electronMCP.checkRuntime('npx');
                    if (!rt.found) {
                        UIUtils.showToast('This connection needs Node.js, which was not found on this Mac. Install it from nodejs.org, then Add again.', 'error');
                        return;
                    }
                }
                let headers;
                if (preset.tokenPrompt) {
                    const tokenEl = presetBtn.closest('[data-mcp-preset-row]')?.querySelector('[data-preset-token]');
                    const token = (tokenEl?.value || '').trim();
                    if (!token) { UIUtils.showToast(`Paste ${preset.tokenPrompt} first`, 'error'); return; }
                    headers = { Authorization: `${preset.tokenScheme || 'Bearer'} ${token}` };
                }
                presetBtn.disabled = true;
                presetBtn.textContent = 'Adding…';
                const res = await window.electronMCP.addServer({
                    name: preset.name,
                    command: preset.command,
                    args: preset.args,
                    env: {},
                    url: preset.url,
                    headers
                });
                if (res.error) {
                    UIUtils.showToast(res.error, 'error');
                } else if (preset.url) {
                    // Hosted servers cost nothing to verify right now — do it,
                    // so a bad token or dead URL is caught at Add time.
                    presetBtn.textContent = 'Connecting…';
                    const test = await window.electronMCP.testServer(res.name);
                    if (test.error) UIUtils.showToast(`Added, but connecting failed: ${test.error}`, 'error');
                    else {
                        UIUtils.showToast(`Connected — ${test.tools.length} tool${test.tools.length === 1 ? '' : 's'} available to the assistant`, 'success');
                        const updated = (await window.electronMCP.listServers()).find(s => s.name === res.name);
                        if (updated && typeof MCPTools !== 'undefined') MCPTools.refreshServer(updated);
                    }
                } else {
                    UIUtils.showToast(`Added "${res.name}" — press Test to connect and load its tools`, 'success');
                }
                this._loadMCPServers();
                return;
            }
            const btn = e.target.closest('button[data-mcp-action]');
            if (!btn) return;
            const name = btn.closest('[data-mcp]')?.dataset.mcp;
            if (!name) return;
            const action = btn.dataset.mcpAction;
            const servers = await window.electronMCP.listServers();
            const server = servers.find(s => s.name === name);
            if (action === 'test') {
                btn.disabled = true;
                btn.textContent = 'Testing…';
                const res = await window.electronMCP.testServer(name);
                if (res.error) UIUtils.showToast(`${name}: ${res.error}`, 'error');
                else {
                    UIUtils.showToast(`${name}: connected — ${res.tools.length} tool${res.tools.length === 1 ? '' : 's'}`, 'success');
                    // Re-register with the fresh tool list.
                    const updated = (await window.electronMCP.listServers()).find(s => s.name === name);
                    if (updated && typeof MCPTools !== 'undefined') MCPTools.refreshServer(updated);
                }
            } else if (action === 'trust') {
                const grant = (typeof PermissionManager !== 'undefined' ? PermissionManager.listGrants() : [])
                    .find(g => g.tool === 'mcp:' + name);
                if (grant) {
                    await PermissionManager.revoke(grant.id);
                    UIUtils.showToast(`"${name}" tools will ask again`, 'success');
                } else {
                    await PermissionManager.grantAlways('mcp:' + name);
                    UIUtils.showToast(`"${name}" tools run without asking now`, 'success');
                }
                this._loadAgentPermissions();
            } else if (action === 'toggle') {
                await window.electronMCP.setEnabled(name, !server.enabled);
                const updated = (await window.electronMCP.listServers()).find(s => s.name === name);
                if (updated && typeof MCPTools !== 'undefined') MCPTools.refreshServer(updated);
            } else if (action === 'remove') {
                const ok = await UIUtils.confirm(`Remove "${name}"?`, 'The server config (and any API keys you entered for it) is deleted from this Mac.');
                if (!ok) return;
                await window.electronMCP.removeServer(name);
                if (typeof MCPTools !== 'undefined') MCPTools.unregisterServer(name);
            }
            this._loadMCPServers();
        };

        const addBtn = document.getElementById('settings-mcp-add-btn');
        if (addBtn) addBtn.onclick = () => this._addMCPServer();
    },

    _addMCPServer() {
        let modal;
        const content = document.createElement('div');
        // Labeled fields with per-field hints (labels survive typing;
        // placeholder-only fields lose their meaning the moment they fill).
        content.innerHTML = `
            <div class="settings-form">
                <label class="settings-form-field">
                    <span class="settings-form-label">Name</span>
                    <input id="mcp-add-name" class="settings-form-input" type="text"
                           placeholder="github" spellcheck="false" autocomplete="off">
                </label>
                <label class="settings-form-field">
                    <span class="settings-form-label">Launch command <em>or</em> server URL</span>
                    <input id="mcp-add-command" class="settings-form-input settings-form-input--mono" type="text"
                           placeholder="npx -y @modelcontextprotocol/server-github &nbsp;&middot;&nbsp; https://mcp.example.com/mcp" spellcheck="false" autocomplete="off">
                    <span class="settings-form-hint">Paste it exactly as the server's docs show it. An https:// address connects to a hosted server (no install needed).</span>
                </label>
                <label class="settings-form-field">
                    <span class="settings-form-label">Environment variables or access token <em>optional</em></span>
                    <textarea id="mcp-add-env" class="settings-form-input settings-form-input--mono" rows="3"
                              placeholder="GITHUB_TOKEN=ghp_..." spellcheck="false"></textarea>
                    <span class="settings-form-hint">One KEY=value per line. For a hosted server, a single line with just the token becomes its Authorization header. Stored encrypted on this Mac.</span>
                </label>
            </div>`;
        const save = async () => {
            const name = document.getElementById('mcp-add-name')?.value.trim();
            const cmdLine = document.getElementById('mcp-add-command')?.value.trim();
            if (!name || !cmdLine) { UIUtils.showToast('Name and a command or URL are required', 'error'); return; }
            const isUrl = /^https?:\/\//i.test(cmdLine);
            const parts = cmdLine.split(/\s+/);
            const env = {};
            let bareToken = null;
            for (const line of (document.getElementById('mcp-add-env')?.value || '').split('\n')) {
                const t = line.trim();
                if (!t) continue;
                const eq = t.indexOf('=');
                if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
                else if (isUrl && !bareToken) bareToken = t;   // hosted: a lone token line → Authorization
            }
            const res = isUrl
                ? await window.electronMCP.addServer({
                    name, url: cmdLine.split(/\s+/)[0],
                    headers: bareToken ? { Authorization: `Bearer ${bareToken}` } : (Object.keys(env).length ? env : undefined)
                })
                : await window.electronMCP.addServer({ name, command: parts[0], args: parts.slice(1), env });
            if (res.error) { UIUtils.showToast(res.error, 'error'); return; }
            modal.close();
            UIUtils.showToast(`Added "${res.name}" — press Test to connect and load its tools`, 'success');
            this._loadMCPServers();
        };
        // Enter in a single-line field submits (the textarea keeps Enter
        // for new env lines).
        content.querySelectorAll('input').forEach(el =>
            el.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); }));
        modal = Modal.create({
            title: 'Add MCP server',
            content,
            buttons: [
                { text: 'Cancel', className: 'secondary-btn' },
                { text: 'Add', className: 'primary-btn', onClick: save }
            ]
        });
        content.querySelector('#mcp-add-name')?.focus();
    },

    // ── Connected accounts (macOS-style: account → toggleable services) ──

    _renderConnectedAccounts() {
        const container = document.getElementById('settings-connected-accounts-list');
        if (!container) return;

        const accounts = (typeof AccountsManager !== 'undefined') ? AccountsManager.getAll() : [];

        let html = '';
        if (accounts.length === 0) {
            html += `<div class="connected-account-empty">No accounts connected yet.</div>`;
        } else {
            for (const account of accounts) {
                html += this._renderAccountRow(account);
            }
        }

        // Single "Add Account" button — runs the unified OAuth flow that
        // grants every service (Mail + Calendar) in one shot.
        html += `
            <div class="connected-account-actions-row">
                <button id="connected-account-add-google" class="secondary-btn">+ Add Google Account</button>
            </div>
        `;

        container.innerHTML = html;

        // Wire up per-account actions
        container.querySelectorAll('.connected-account-service-toggle').forEach(input => {
            input.addEventListener('change', () => {
                const email = input.dataset.email;
                const service = input.dataset.service;
                this._toggleAccountService(email, service, input.checked);
            });
        });

        container.querySelectorAll('.connected-account-reconnect-btn').forEach(btn => {
            btn.addEventListener('click', () => this._reconnectGoogleAccount(btn.dataset.email));
        });

        container.querySelectorAll('.connected-account-disconnect-btn').forEach(btn => {
            btn.addEventListener('click', () => this._disconnectGoogleAccount(btn.dataset.email));
        });

        const addBtn = document.getElementById('connected-account-add-google');
        if (addBtn) addBtn.addEventListener('click', () => this._connectGoogleAccount());

        // The Email preferences row only makes sense once mail can flow.
        const prefsGroup = document.getElementById('settings-email-prefs-group');
        if (prefsGroup) prefsGroup.hidden = accounts.length === 0;
    },

    _renderAccountRow(account) {
        const email = this._esc(account.email);
        const displayName = this._esc(account.displayName || account.email);
        const services = account.services || {};
        // Accounts sync between Macs but OAuth tokens don't — an account
        // connected on another Mac shows here as needing a one-time sign-in
        // on this one, instead of pretending to be live and failing fetches.
        const localDisconnected = (typeof AccountsManager !== 'undefined')
            && AccountsManager.isLocallyDisconnected(account.email);
        if (localDisconnected) {
            return `
                <div class="connected-account-row connected-account-row-remote">
                    <div class="connected-account-header">
                        <div class="connected-account-info">
                            <div class="connected-account-email">${displayName}</div>
                            <div class="connected-account-subtitle">${displayName !== email ? email + ' &middot; ' : ''}Connected on another Mac &mdash; sign in once to use it here</div>
                        </div>
                        <div class="connected-account-row-actions">
                            <button class="secondary-btn connected-account-reconnect-btn" data-email="${email}" title="Sign in to this account on this Mac">Connect on this Mac</button>
                            <button class="secondary-btn connected-account-disconnect-btn" data-email="${email}" title="Remove this account everywhere">Remove</button>
                        </div>
                    </div>
                </div>
            `;
        }
        return `
            <div class="connected-account-row">
                <div class="connected-account-header">
                    <div class="connected-account-info">
                        <div class="connected-account-email">${displayName}</div>
                        ${displayName !== email ? `<div class="connected-account-subtitle">${email}</div>` : ''}
                    </div>
                    <div class="connected-account-row-actions">
                        <button class="secondary-btn connected-account-reconnect-btn" data-email="${email}" title="Re-authenticate this account">Reconnect</button>
                        <button class="secondary-btn connected-account-disconnect-btn" data-email="${email}" title="Remove this account">Remove</button>
                    </div>
                </div>
                <div class="connected-account-services">
                    ${this._renderServiceToggle(account.email, 'mail', 'Mail', services.mail)}
                    ${this._renderServiceToggle(account.email, 'calendar', 'Calendar', services.calendar)}
                </div>
            </div>
        `;
    },

    _renderServiceToggle(email, service, label, enabled) {
        // The door to the unified Email Settings page moved to its own row on
        // the Accounts panel (2026-07-30) — a link squeezed beside the Mail
        // toggle was two different controls sharing one hit area.
        return `
            <label class="connected-account-service">
                <span class="connected-account-service-label">${label}</span>
                <span class="settings-switch">
                    <input type="checkbox" class="connected-account-service-toggle"
                           data-email="${this._esc(email)}"
                           data-service="${service}"
                           ${enabled ? 'checked' : ''}>
                    <span class="settings-switch-track"></span>
                </span>
            </label>
        `;
    },

    /**
     * Apple Reminders card (Accounts panel). Per-Mac opt-in: the toggle and
     * import state live in localStorage via AppleImport; only the list picker
     * syncs. Enabling runs an import immediately — that first run is what
     * triggers the macOS Reminders consent dialog, so a denial surfaces here
     * as an honest error line instead of a silently empty import.
     */
    _renderAppleImport() {
        const container = document.getElementById('settings-apple-reminders');
        if (typeof AppleImport === 'undefined' || !container) return;

        const on = AppleImport.enabled();
        const state = AppleImport.state();
        const prefs = AppleImport.prefs();

        let body = '';
        if (on) {
            const lists = state.lists || [];
            if (lists.length) {
                body += `<div class="connected-account-services">` + lists.map(name => {
                    const checked = !prefs.reminderLists || prefs.reminderLists.includes(name);
                    return `
                        <label class="connected-account-service">
                            <span class="connected-account-service-label">${this._esc(name)}</span>
                            <span class="settings-switch">
                                <input type="checkbox" class="apple-reminders-list-toggle"
                                       data-list="${this._esc(name)}" ${checked ? 'checked' : ''}>
                                <span class="settings-switch-track"></span>
                            </span>
                        </label>
                    `;
                }).join('') + `</div>`;
            }
            let statusLine = '';
            if (state.lastError) {
                statusLine = `<span style="color:#dc2626">${this._esc(state.lastError)}</span>`;
            } else if (state.lastAt) {
                const c = state.counts || {};
                statusLine = `Last import ${UIUtils.formatDateTime(state.lastAt)} &middot; ${c.created || 0} added, ${c.updated || 0} updated`;
            }
            body += `
                <div class="connected-account-actions-row">
                    <button id="apple-reminders-import-now" class="secondary-btn">Import now</button>
                    <span class="connected-account-subtitle" id="apple-reminders-status-line">${statusLine}</span>
                </div>
            `;
        }

        // Apple Notes row. The one-Mac warning is load-bearing: Notes ids
        // are per-Mac, so two Macs importing would duplicate every note —
        // reminders don't have this problem (stable cross-device ids).
        const notesOn = AppleImport.notesEnabled();
        let notesBody = '';
        if (notesOn) {
            let line = '';
            if (state.notesLastError) {
                line = `<span style="color:#dc2626">${this._esc(state.notesLastError)}</span>`;
            } else if (state.notesLastAt) {
                const c = state.notesCounts || {};
                const extras = [];
                if (c.skippedLocked) extras.push(`${c.skippedLocked} locked skipped`);
                if (c.skippedEdited) extras.push(`${c.skippedEdited} edited here, left alone`);
                line = `Last import ${UIUtils.formatDateTime(state.notesLastAt)} &middot; ${c.created || 0} added, ${c.updated || 0} updated${extras.length ? ' &middot; ' + extras.join(', ') : ''}`;
            }
            notesBody = `
                <div class="connected-account-actions-row">
                    <button id="apple-notes-import-now" class="secondary-btn">Import now</button>
                    <span class="connected-account-subtitle" id="apple-notes-status-line">${line}</span>
                </div>
            `;
        }

        // Apple Calendar row — a read-only mirror of iCloud/local calendars
        // (Google-source calendars on the Mac are excluded by the helper:
        // the app syncs Google itself).
        const eventsOn = AppleImport.eventsEnabled();
        let eventsBody = '';
        if (eventsOn) {
            let line = '';
            if (state.eventsLastError) {
                line = `<span style="color:#dc2626">${this._esc(state.eventsLastError)}</span>`;
            } else if (state.eventsLastAt) {
                const c = state.eventsCounts || {};
                line = `Last import ${UIUtils.formatDateTime(state.eventsLastAt)} &middot; ${c.events || 0} events from ${c.calendars || 0} calendars`;
            }
            eventsBody = `
                <div class="connected-account-actions-row">
                    <button id="apple-events-import-now" class="secondary-btn">Import now</button>
                    <span class="connected-account-subtitle" id="apple-events-status-line">${line}</span>
                </div>
            `;
        }

        container.innerHTML = `
            <div class="connected-account-row">
                <div class="connected-account-header">
                    <div class="connected-account-info">
                        <div class="connected-account-email">Apple Reminders</div>
                        <div class="connected-account-subtitle">Import this Mac's iCloud reminders into Tasks. Read-only &mdash; nothing is written back, and turning this off removes the imported tasks here (they stay in Apple Reminders).</div>
                    </div>
                    <div class="connected-account-row-actions">
                        <label class="settings-switch">
                            <input type="checkbox" id="apple-reminders-enabled" ${on ? 'checked' : ''}>
                            <span class="settings-switch-track"></span>
                        </label>
                    </div>
                </div>
                ${body}
            </div>
            <div class="connected-account-row">
                <div class="connected-account-header">
                    <div class="connected-account-info">
                        <div class="connected-account-email">Apple Notes</div>
                        <div class="connected-account-subtitle">Import this Mac's Apple Notes into Notes, tagged &ldquo;apple-notes&rdquo;. Read-only; locked notes are skipped; turning this off removes the imported notes here (they stay in Apple Notes). Turn this on for ONE Mac only &mdash; imported notes reach your other Macs through Anjadhe's own sync.</div>
                    </div>
                    <div class="connected-account-row-actions">
                        <label class="settings-switch">
                            <input type="checkbox" id="apple-notes-enabled" ${notesOn ? 'checked' : ''}>
                            <span class="settings-switch-track"></span>
                        </label>
                    </div>
                </div>
                ${notesBody}
            </div>
            <div class="connected-account-row">
                <div class="connected-account-header">
                    <div class="connected-account-info">
                        <div class="connected-account-email">Apple Calendar</div>
                        <div class="connected-account-subtitle">Show this Mac's iCloud and local calendar events in Calendar. Read-only &mdash; they can't be edited here, turning this off removes them from the calendar, and Google calendars are left to the app's own Google sync.</div>
                    </div>
                    <div class="connected-account-row-actions">
                        <label class="settings-switch">
                            <input type="checkbox" id="apple-events-enabled" ${eventsOn ? 'checked' : ''}>
                            <span class="settings-switch-track"></span>
                        </label>
                    </div>
                </div>
                ${eventsBody}
            </div>
        `;

        const enableInput = document.getElementById('apple-reminders-enabled');
        if (enableInput) enableInput.addEventListener('change', async () => {
            AppleImport.setEnabled(enableInput.checked);
            if (!enableInput.checked) {
                // The Gmail model (by request): source owns the data, so
                // toggling off removes the imported copies.
                const n = AppleImport.removeImportedReminders();
                if (n) UIUtils.showToast(`Removed ${n} imported task${n === 1 ? '' : 's'} — still in Apple Reminders`, 'info');
            }
            this._renderAppleImport();
            if (enableInput.checked) await this._runAppleImport();
        });

        const importBtn = document.getElementById('apple-reminders-import-now');
        if (importBtn) importBtn.addEventListener('click', () => this._runAppleImport());

        const notesInput = document.getElementById('apple-notes-enabled');
        if (notesInput) notesInput.addEventListener('change', async () => {
            AppleImport.setNotesEnabled(notesInput.checked);
            if (!notesInput.checked) {
                const n = AppleImport.removeImportedNotes();
                if (n) UIUtils.showToast(`Removed ${n} imported note${n === 1 ? '' : 's'} — still in Apple Notes`, 'info');
            }
            this._renderAppleImport();
            if (notesInput.checked) await this._runAppleNotesImport();
        });

        const notesBtn = document.getElementById('apple-notes-import-now');
        if (notesBtn) notesBtn.addEventListener('click', () => this._runAppleNotesImport());

        const eventsInput = document.getElementById('apple-events-enabled');
        if (eventsInput) eventsInput.addEventListener('change', async () => {
            AppleImport.setEventsEnabled(eventsInput.checked);
            if (!eventsInput.checked) {
                const n = AppleImport.removeImportedEvents();
                if (n) UIUtils.showToast(`Removed ${n} mirrored event${n === 1 ? '' : 's'} — still in Apple Calendar`, 'info');
            }
            this._renderAppleImport();
            if (eventsInput.checked) await this._runAppleEventsImport();
        });

        const eventsBtn = document.getElementById('apple-events-import-now');
        if (eventsBtn) eventsBtn.addEventListener('click', () => this._runAppleEventsImport());

        container.querySelectorAll('.apple-reminders-list-toggle').forEach(input => {
            input.addEventListener('change', () => {
                const all = [...container.querySelectorAll('.apple-reminders-list-toggle')];
                const picked = all.filter(i => i.checked).map(i => i.dataset.list);
                // Every list checked stores null ("all") so a NEW list in
                // iCloud is included by default rather than silently skipped.
                AppleImport.savePrefs({ reminderLists: picked.length === all.length ? null : picked });
            });
        });
    },

    async _runAppleEventsImport() {
        const btn = document.getElementById('apple-events-import-now');
        if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
        try {
            const res = await AppleImport.importEvents();
            if (res.error) {
                UIUtils.showToast(res.error, 'error');
            } else {
                UIUtils.showToast(`Calendar imported: ${res.events} events from ${res.calendars} calendars`, 'success');
            }
        } catch (e) {
            UIUtils.showToast(`Import failed: ${e.message}`, 'error');
        }
        this._renderAppleImport();
    },

    async _runAppleNotesImport() {
        const btn = document.getElementById('apple-notes-import-now');
        if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
        try {
            const res = await AppleImport.importNotes();
            if (res.error) {
                UIUtils.showToast(res.error, 'error');
            } else {
                UIUtils.showToast(`Notes imported: ${res.created} added, ${res.updated} updated`, 'success');
            }
        } catch (e) {
            UIUtils.showToast(`Import failed: ${e.message}`, 'error');
        }
        this._renderAppleImport();
    },

    async _runAppleImport() {
        const btn = document.getElementById('apple-reminders-import-now');
        if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
        try {
            const res = await AppleImport.importReminders();
            if (res.error) {
                UIUtils.showToast(res.error, 'error');
            } else {
                UIUtils.showToast(`Reminders imported: ${res.created} added, ${res.updated} updated`, 'success');
            }
        } catch (e) {
            UIUtils.showToast(`Import failed: ${e.message}`, 'error');
        }
        this._renderAppleImport();
    },

    async _connectGoogleAccount() {
        if (typeof AccountsManager === 'undefined' || !window.electronAccounts) return;
        if (!(await AccountsManager.confirmGoogleConnect())) return;
        UIUtils.showToast('Opening Google sign-in...', 'info');
        try {
            const result = await window.electronAccounts.googleOAuth();
            if (result?.success && result.email) {
                AccountsManager.addOrUpdate({
                    email: result.email,
                    provider: 'google',
                    displayName: result.displayName,
                    enabledServices: result.services || ['mail', 'calendar']
                });
                UIUtils.showToast(`Connected ${result.email}`, 'success');
                this._renderConnectedAccounts();
            } else if (result?.error) {
                UIUtils.showToast(`Connection failed: ${result.error}`, 'error');
            }
        } catch (e) {
            UIUtils.showToast(`Connection error: ${e.message}`, 'error');
        }
    },

    async _reconnectGoogleAccount(email) {
        UIUtils.showToast(`Re-authenticate as ${email}`, 'info');
        await this._connectGoogleAccount();
    },

    async _disconnectGoogleAccount(email) {
        if (typeof AccountsManager === 'undefined') return;
        const confirmed = await UIUtils.confirm(
            'Remove account',
            `Remove ${email}? Synced data from this account (emails, calendar events) will be cleared. You can reconnect later.`,
            ''
        );
        if (!confirmed) return;
        await AccountsManager.remove(email);
        UIUtils.showToast(`Removed ${email}`, 'success');
        this._renderConnectedAccounts();
    },

    _toggleAccountService(email, service, enabled) {
        if (typeof AccountsManager === 'undefined') return;
        AccountsManager.setServiceEnabled(email, service, enabled);
        // The label below the switch updates implicitly via re-render on next open;
        // for now we just toast so the user gets immediate feedback.
        UIUtils.showToast(`${service === 'mail' ? 'Mail' : 'Calendar'} ${enabled ? 'enabled' : 'disabled'} for ${email}`, 'info');
    },

    // ── Paired devices (the phone <-> Mac channel) ──

    /**
     * Settings › Library — the app's plumbing (the page itself is for
     * reading and finding). Everything here re-reads live state on open;
     * the download button carries the progress inline, the way the old
     * on-page banner did before it moved here (2026-08-08).
     */
    async _renderLibrarySettings() {
        if (!window.electronLibrary) return;
        let status = null;
        try { status = await window.electronLibrary.status(); } catch { return; }

        const embedStatus = document.getElementById('settings-library-embed-status');
        const embedBtn = document.getElementById('settings-library-embed-btn');
        const downloaded = !!(status.embed && status.embed.modelDownloaded);
        if (embedStatus) {
            embedStatus.textContent = downloaded
                ? 'Search model downloaded — search finds passages by meaning.'
                : 'Not downloaded — search is keyword-only.';
        }
        if (embedBtn) {
            embedBtn.hidden = downloaded;
            if (!downloaded && !embedBtn._wired) {
                embedBtn._wired = true;
                embedBtn.addEventListener('click', async () => {
                    embedBtn.disabled = true;
                    embedBtn.textContent = 'Downloading…';
                    try { window.electronLibrary.onPullProgress((p) => {
                        if (p && p.percent != null) embedBtn.textContent = `Downloading… ${p.percent}%`;
                    }); } catch { /* progress is cosmetic */ }
                    const res = await window.electronLibrary.pullEmbedModel();
                    if (res && res.error) {
                        UIUtils.showToast(`Download failed: ${res.error}`, 'error');
                        embedBtn.disabled = false;
                        embedBtn.textContent = 'Download';
                    } else {
                        // Freshly capable — fill in vectors for whatever was
                        // indexed keyword-only while the model was missing.
                        window.electronLibrary.reindex();
                        UIUtils.showToast('Semantic search enabled — re-indexing your documents', 'success');
                        this._renderLibrarySettings();
                    }
                });
            }
        }

        const indexStatus = document.getElementById('settings-library-index-status');
        if (indexStatus) {
            const bits = status.docs
                ? [`${status.docs} document${status.docs === 1 ? '' : 's'}`, `${status.chunks || 0} passages`]
                : ['The Library folder is empty.'];
            if (status.queued) bits.push(`${status.queued} in the indexing queue`);
            if (status.errors) bits.push(`${status.errors} failed`);
            // Honest about the engine behind semantic search: the KNN index
            // when sqlite-vec is live, the linear scan when it isn't.
            if (status.docs && status.vectorIndex === 'vec') bits.push('vector index active');
            indexStatus.textContent = bits.join(' · ');
        }
        // Study depth — per-Mac (localStorage), read by VoiceService.depth()
        // at the start of each study; no reload or re-study needed on change.
        const depthSel = document.getElementById('settings-voice-study-depth');
        if (depthSel) {
            let cur = null;
            try { cur = localStorage.getItem('voice-study-depth'); } catch { /* default */ }
            depthSel.value = ['light', 'standard', 'deep'].includes(cur) ? cur : 'standard';
            if (!depthSel._wired) {
                depthSel._wired = true;
                depthSel.addEventListener('change', () => {
                    try { localStorage.setItem('voice-study-depth', depthSel.value); } catch { /* per-Mac best effort */ }
                });
            }
        }
        const rescanBtn = document.getElementById('settings-library-rescan-btn');
        if (rescanBtn && !rescanBtn._wired) {
            rescanBtn._wired = true;
            rescanBtn.addEventListener('click', async () => {
                try { await window.electronLibrary.scan(); } catch { /* status shows it */ }
                this._renderLibrarySettings();
            });
        }
        const reindexBtn = document.getElementById('settings-library-reindex-btn');
        if (reindexBtn && !reindexBtn._wired) {
            reindexBtn._wired = true;
            reindexBtn.addEventListener('click', async () => {
                try { await window.electronLibrary.reindex(); } catch { /* status shows it */ }
                UIUtils.showToast('Re-indexing everything in the background', 'info');
                this._renderLibrarySettings();
            });
        }

        const folderPath = document.getElementById('settings-library-folder-path');
        if (folderPath) folderPath.textContent = status.dir || '~/Anjadhe/library';
        const folderBtn = document.getElementById('settings-library-folder-btn');
        if (folderBtn && !folderBtn._wired) {
            folderBtn._wired = true;
            folderBtn.addEventListener('click', async () => {
                const res = await window.electronLibrary.openFolder();
                if (res && res.error) UIUtils.showToast(res.error, 'error');
            });
        }
    },

    async _renderPairedDevices() {
        const container = document.getElementById('settings-paired-devices-list');
        if (!container) return;

        const flagOff = typeof FEATURES !== 'undefined' && !FEATURES.isEnabled('mobilesync');
        if (flagOff || !window.electronChannel) {
            container.innerHTML = `<div class="connected-account-empty">Device pairing is not available in this build.</div>`;
            return;
        }

        // Register the "a phone paired" listener once, on first render.
        if (!this._pairedListenerBound) {
            this._pairedListenerBound = true;
            window.electronChannel.onPaired(() => {
                this._pairingQr = null;
                this._renderPairedDevices();
                if (typeof UIUtils !== 'undefined') UIUtils.showToast('Phone paired', 'success');
            });
        }

        let info = null;
        try { info = await window.electronChannel.getInfo(); } catch {}

        if (!info || !info.available) {
            container.innerHTML = `<div class="connected-account-empty">The channel is offline. Start the relay, then reopen this panel.</div>`;
            return;
        }

        const devices = info.devices || [];
        let html = '';
        if (devices.length === 0) {
            html += `<div class="connected-account-empty">No phone paired yet.</div>`;
        } else {
            for (const device of devices) html += this._renderDeviceRow(device);
        }

        if (this._pairingQr) {
            html += `
                <div class="pairing-qr-block">
                    <div class="pairing-qr">${this._pairingQr}</div>
                    <p class="pairing-qr-help">Open Anjadhe on your iPhone and scan this code to pair. It stays valid for two minutes.</p>
                    <div class="connected-account-actions-row">
                        <button id="paired-device-cancel" class="secondary-btn">Cancel</button>
                    </div>
                </div>
            `;
        } else {
            html += `
                <div class="connected-account-actions-row">
                    <button id="paired-device-pair" class="secondary-btn">+ Pair a device</button>
                </div>
            `;
        }

        container.innerHTML = html;

        container.querySelectorAll('.paired-device-forget-btn').forEach(btn => {
            btn.addEventListener('click', () => this._forgetDevice(btn.dataset.pub));
        });
        const pairBtn = document.getElementById('paired-device-pair');
        if (pairBtn) pairBtn.addEventListener('click', () => this._beginPairing());
        const cancelBtn = document.getElementById('paired-device-cancel');
        if (cancelBtn) cancelBtn.addEventListener('click', () => this._cancelPairing());
    },

    _renderDeviceRow(device) {
        const name = this._esc(device.name || 'iPhone');
        const pub = this._esc(device.pub || '');
        let when = '';
        if (device.pairedAt) {
            const d = new Date(device.pairedAt);
            if (!isNaN(d.getTime())) when = `Paired ${d.toLocaleDateString()}`;
        }
        return `
            <div class="connected-account-row">
                <div class="connected-account-header">
                    <div class="connected-account-info">
                        <div class="connected-account-email">${name}</div>
                        ${when ? `<div class="connected-account-subtitle">${when}</div>` : ''}
                    </div>
                    <div class="connected-account-row-actions">
                        <button class="secondary-btn paired-device-forget-btn" data-pub="${pub}" title="Unpair this device">Forget</button>
                    </div>
                </div>
            </div>
        `;
    },

    async _beginPairing() {
        if (!window.electronChannel) return;
        try {
            const result = await window.electronChannel.beginPairing();
            if (result && result.qrSvg) {
                this._pairingQr = result.qrSvg;
                this._renderPairedDevices();
            } else {
                UIUtils.showToast((result && result.error) || 'Could not start pairing', 'error');
            }
        } catch (e) {
            UIUtils.showToast(`Pairing error: ${e.message}`, 'error');
        }
    },

    _cancelPairing() {
        this._pairingQr = null;
        if (window.electronChannel) window.electronChannel.cancelPairing();
        this._renderPairedDevices();
    },

    async _forgetDevice(pub) {
        if (!window.electronChannel || !pub) return;
        const confirmed = await UIUtils.confirm(
            'Forget device',
            'Unpair this phone? It will need to scan a new code to reconnect.',
            ''
        );
        if (!confirmed) return;
        await window.electronChannel.removeDevice(pub);
        UIUtils.showToast('Device unpaired', 'success');
        this._renderPairedDevices();
    },

    _esc(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    },

    _llmSettingsBound: false,

    // Shared binding setup for both the AI Models sub-view and the AI Assistant
    // sub-view. Element IDs live in whichever view they were moved into — we bind
    // once (idempotent guard) and both sub-views work regardless of open order.
    _ensureLlmBindings() {
        if (this._llmSettingsBound) return;
        this._llmSettingsBound = true;
        this._attachLlmBindings();
    },

    _escape(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },

    // The AI Assistant page is a MASTER LIST (2026-07-30): rows showing each
    // setting's current value, each opening that one setting's own page.
    // Section content renders lazily when its page opens — nothing heavy
    // runs to show the list.
    LLM_SECTIONS: {
        'llm-sec-name': { label: 'Name' },
        'llm-sec-models': { label: 'Models' },
        // ownTitle: the section carries its own masthead title, so the
        // breadcrumb stops at the lineage (the Add Model page's rule).
        'settings-search-section': { label: 'Web Search', ownTitle: true },
        'settings-cli-section': { label: 'Terminal Access' },
        'llm-sec-mcp': { label: 'Tool Servers' },
        'llm-sec-recipes': { label: 'Recipes' },
        'llm-sec-permissions': { label: 'Permissions' }
    },

    async openLLMSettings() {
        const view = document.getElementById('llm-settings-view');
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        view.classList.add('active');
        view.classList.remove('llm-in-section');
        view.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
        Breadcrumb.render('llm-settings-breadcrumb', [
            { label: 'Settings', action: () => { view.classList.remove('active'); document.getElementById('settings-view').classList.add('active'); this._loadLLMSummary(); } },
            { label: 'AI Assistant' }
        ]);

        this._ensureLlmBindings();
        this._bindLlmRoot();
        this._stopLibraryWatch();
        this._renderLlmRootHints();
        this._refreshAssistantBadges();
    },

    /** Open ONE setting's page inside the AI Assistant view. */
    async openLLMSection(secId) {
        const spec = this.LLM_SECTIONS[secId];
        const view = document.getElementById('llm-settings-view');
        const sec = document.getElementById(secId);
        if (!spec || !view || !sec) return;
        if (!view.classList.contains('active')) {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            view.classList.add('active');
            this._ensureLlmBindings();
            this._bindLlmRoot();
        }
        view.classList.add('llm-in-section');
        view.querySelectorAll('.settings-section').forEach(s => s.classList.toggle('active', s === sec));
        const crumbs = [
            { label: 'Settings', action: () => { view.classList.remove('active'); document.getElementById('settings-view').classList.add('active'); this._loadLLMSummary(); } },
            { label: 'AI Assistant', action: () => this.openLLMSettings() }
        ];
        if (!spec.ownTitle) crumbs.push({ label: spec.label });
        Breadcrumb.render('llm-settings-breadcrumb', crumbs);

        // Lazy per-section render. The library watch runs only while the
        // Models page is open.
        if (secId !== 'llm-sec-models') this._stopLibraryWatch();
        switch (secId) {
            case 'llm-sec-name': this._bindAssistantName(); break;
            case 'llm-sec-models': await this._renderModelLibrary(); this._startLibraryWatch(); break;
            case 'settings-search-section': await this._renderSearchProviders(); break;
            case 'settings-cli-section': await this._renderCliCard(); break;
            case 'llm-sec-mcp': await this._loadMCPServers(); break;
            case 'llm-sec-recipes': this._loadRecipes(); break;
            case 'llm-sec-permissions': await this._loadAgentPermissions(); break;
        }
    },

    _bindLlmRoot() {
        const root = document.getElementById('llm-root');
        if (!root || root._bound) return;
        root._bound = true;
        root.addEventListener('click', (e) => {
            const row = e.target.closest('[data-llm-sec]');
            if (row) this.openLLMSection(row.dataset.llmSec);
        });
    },

    /** Current-value hints on the AI Assistant master list. Best-effort —
     *  a missing source just leaves that row's hint empty. */
    async _renderLlmRootHints() {
        const set = (id, text) => {
            const el = document.getElementById(id);
            if (el) el.textContent = text || '';
        };
        try {
            const name = (typeof AssistantIdentity !== 'undefined' && AssistantIdentity.get()) || '';
            set('llm-hint-name', name || 'AI Assistant');
        } catch {}
        try {
            const entries = AgentService.getModelList() || [];
            const def = AgentService.getDefaultEntry?.();
            set('llm-hint-models', def
                ? `${def.model}${entries.length > 1 ? ` · ${entries.length} models` : ''}`
                : 'No model yet · add one');
        } catch {}
        try {
            const r = window.electronCLI ? await window.electronCLI.status() : null;
            set('llm-hint-cli', r ? (r.enabled ? 'On · this Mac only' : 'Off') : '');
        } catch {}
        try {
            const s = await window.electronSearch?.getStatus?.();
            const NAMES = { anjadhe: 'Anjadhe', tavily: 'Tavily', brave: 'Brave' };
            set('llm-hint-search', s
                ? (s.enabled ? `On · ${NAMES[s.provider] || s.provider || 'no provider'}` : 'Off')
                : '');
        } catch {}
        try {
            if (window.electronMCP?.listServers) {
                const servers = await window.electronMCP.listServers();
                set('llm-hint-mcp', servers.length
                    ? `${servers.length} server${servers.length === 1 ? '' : 's'} connected`
                    : 'None connected');
            }
        } catch {}
        try {
            const n = (typeof RecipeService !== 'undefined') ? RecipeService.all().length : 0;
            set('llm-hint-recipes', n ? `${n} saved` : 'None yet');
        } catch {}
        try {
            if (typeof PermissionManager !== 'undefined') {
                await PermissionManager.ready();
                const n = PermissionManager.listGrants().length;
                set('llm-hint-permissions', n
                    ? `${n} standing grant${n === 1 ? '' : 's'}`
                    : 'Asks every time');
            }
        } catch {}
    },

    // Assistant name (AssistantIdentity): populate on every open, bind once.
    // Saving repaints every "AI Assistant" label via applyToDom; blank clears
    // back to the generic label.
    _bindAssistantName() {
        const input = document.getElementById('settings-assistant-name');
        if (!input) return;
        input.value = (typeof AssistantIdentity !== 'undefined' && AssistantIdentity.get()) || '';
        if (this._assistantNameBound) return;
        this._assistantNameBound = true;
        // Auto-save on blur/Enter — every other control on the page saves
        // itself, and a lone Save button made this one field feel like a form.
        const save = () => {
            const before = AssistantIdentity.get();
            AssistantIdentity.set(input.value);
            const now = AssistantIdentity.get();
            input.value = now || '';
            if (now === before || (!now && !before)) return; // unchanged: stay quiet
            if (now) UIUtils.showToast(`Your assistant is now called ${now}`, 'success');
            else UIUtils.showToast('Name removed', 'success');
        };
        input.addEventListener('blur', save);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); save(); }
        });
    },

    // ─────────────────── Model library ───────────────────
    //
    // One card per entry ({id, engine, model, baseUrl?, numCtx?, think?});
    // the DEFAULT entry is the brain. Every card renders its own Manage body
    // inline (no shared/moved panels), every mutation goes through the
    // AgentService entries API (addEntry/updateEntry/removeEntry — never a
    // raw selectedModel write), and downloads are tracked by entry id so a
    // re-render can't orphan a progress bar.

    _engines: null,              // snapshot from _refreshEngineState
    _openManageId: null,         // entry id whose Manage body is open
    _activeDownloads: new Map(), // entry id -> { text, percent }
    _libraryWatchTimer: null,
    _entryKeyStatus: new Map(),  // cloud entry id -> hasKey (refreshed per render)

    _engineLabel(engine) {
        return engine === 'server' ? 'your server'
            : engine === 'openai' ? 'OpenAI'
            : engine === 'anthropic' ? 'Anthropic'
            : engine === 'anjadhe' ? 'Anjadhe Cloud'
            : 'Local';
    },

    _engineApiFor() {
        return window.electronLlamaCpp;
    },

    /**
     * One parallel snapshot of everything the library renders from: the
     * model catalog (remote config), machine RAM, and each local engine's
     * status + installed + resident model sets. Failures degrade to empty —
     * an unreachable engine just renders as not installed.
     */
    async _refreshEngineState() {
        const wrap = (p) => Promise.resolve(p).then(v => v, () => null);
        const [config, llamaStatus, llamaModels] = await Promise.all([
            wrap(window.electronConfig?.get?.()),
            wrap(window.electronLlamaCpp?.status?.()),
            wrap(window.electronLlamaCpp?.listModels?.())
        ]);
        const names = (r) => new Set(((r && r.models) || []).map(m => m.name));
        this._engines = {
            catalog: (config && config.models) || [],
            totalMemGB: Number(config?.machine?.totalMemGB) || 8,
            llamacpp: {
                status: llamaStatus || { isReady: false, isInstalled: false },
                installed: names(llamaModels),
                resident: new Set(llamaStatus?.isReady && llamaStatus.loadedModel ? [llamaStatus.loadedModel] : [])
            }
        };
        return this._engines;
    },

    /** The catalog record for an entry's model, or null (custom models). */
    _catalogFor(entry) {
        if (!entry || !this._engines) return null;
        return this._engines.catalog.find(m => m.name === entry.model) || null;
    },

    /** "2026-03-11" → "Mar 2026" (the catalog's provider release date). */
    _formatReleased(iso) {
        const d = new Date(`${iso}T00:00:00`);
        if (isNaN(d.getTime())) return String(iso);
        return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    },

    async _renderModelLibrary() {
        const cardsHost = document.getElementById('settings-model-cards');
        if (!cardsHost) return;
        try { await AgentService.ensureModelList?.(); } catch { /* offline */ }
        await this._refreshEngineState();
        this._renderEngineUpdate(); // fire-and-forget; owns its own row

        const entries = AgentService.getModelList();
        // Cloud entries' status text depends on whether a key is saved —
        // resolve it once per render so _computeEntryStatus stays synchronous
        // (the watch loop repaints from it cheaply).
        await Promise.all(entries
            .filter(e => e.engine === 'openai' || e.engine === 'anthropic')
            .map(async (e) => {
                try {
                    const r = await window.electronLLM?.entryKeyStatus?.(e.id);
                    this._entryKeyStatus.set(e.id, r && r.unreadable ? 'unreadable' : !!(r && r.hasKey));
                } catch { /* leave unknown */ }
            }));
        const def = AgentService.getDefaultEntry();

        cardsHost.innerHTML = '';
        // Adding the first model is the single most important setup action in
        // the app, so the empty list is a real empty-state card and the Add
        // button below it steps up to primary until a model exists.
        const addBtn = document.getElementById('settings-add-model-btn');
        if (addBtn) {
            addBtn.classList.toggle('primary-btn', !entries.length);
            addBtn.classList.toggle('secondary-btn', !!entries.length);
        }
        if (!entries.length) {
            const empty = document.createElement('div');
            empty.className = 'settings-empty-state settings-model-cards-empty';
            empty.innerHTML = `
                <div class="settings-empty-state-title">No models yet</div>
                <p class="settings-empty-state-text">Add one to power chat, email insights, and everything else the assistant does. A model that runs on this Mac keeps your data here.</p>`;
            cardsHost.appendChild(empty);
            return;
        }
        for (const entry of entries) {
            const card = this._buildModelCard(entry, !!(def && def.id === entry.id));
            cardsHost.appendChild(card);
            if (this._activeDownloads.has(entry.id)) this._paintCardProgress(entry.id);
            if (this._openManageId === entry.id) this._openManage(card, entry);
        }
    },

    // The separate "Default Model" status card was removed 2026-07-24 —
    // it only echoed the default entry's name/engine/status, all of which
    // the Your Models card already shows on the entry marked Default.

    _engineUpdateBusy: false,   // an update in flight owns the row
    _engineUpdateCheck: null,   // cached {installed, latest, updateAvailable}

    /**
     * Quiet row under the model cards, shown only when remote config pins a
     * newer llama.cpp build than the one on disk AND a local model entry
     * exists to care about it. Updating reuses the normal engine install
     * path: same URL + SHA pin, installFromUrl swaps engine/ in place and
     * stops a running server, so the next chat warms the new build.
     */
    async _renderEngineUpdate() {
        const host = document.getElementById('settings-engine-update');
        if (!host || this._engineUpdateBusy) return;
        const hasLocal = AgentService.getModelList().some(e => !AgentService.isRemoteEngine(e.engine));
        const installed = !!this._engines?.llamacpp?.status?.isInstalled;
        if (hasLocal && installed && !this._engineUpdateCheck) {
            try { this._engineUpdateCheck = await window.electronLlamaCpp?.checkEngineUpdate?.(); } catch { /* stay hidden */ }
        }
        const check = this._engineUpdateCheck;
        if (!hasLocal || !installed || !check?.updateAvailable) {
            host.hidden = true;
            host.innerHTML = '';
            return;
        }
        host.hidden = false;
        host.innerHTML = `
            <span class="settings-engine-update-text">A newer llama.cpp engine is available (${check.installed} &rarr; ${check.latest}).</span>
            <button id="settings-engine-update-btn" class="secondary-btn">Update engine</button>`;
        const btn = host.querySelector('#settings-engine-update-btn');
        const text = host.querySelector('.settings-engine-update-text');
        btn.addEventListener('click', async () => {
            if (this._engineUpdateBusy) return;
            this._engineUpdateBusy = true;
            btn.disabled = true;
            try {
                const res = await window.electronLlamaCpp.install((p) => {
                    if (p.phase === 'download' && p.percent != null) text.textContent = `Updating engine… ${p.percent}%`;
                    else if (p.message) text.textContent = p.message;
                });
                if (res?.error) throw new Error(res.error);
                this._engineUpdateBusy = false;
                this._engineUpdateCheck = null; // re-check reads the new build
                UIUtils.showToast(`llama.cpp engine updated to ${check.latest}`, 'success');
                host.hidden = true;
                host.innerHTML = '';
                // The swap stopped any running server; warm the default model
                // back up so the first chat isn't a cold boot.
                AgentService.warmOnIntent?.();
            } catch (e) {
                this._engineUpdateBusy = false;
                text.textContent = e?.message || 'Engine update failed';
                btn.disabled = false;
            }
        });
    },

    /**
     * Entry status from the engine snapshot — synchronous so the watch can
     * repaint cheaply. States: downloading (an active pull owns the card),
     * server configured/not-configured (no auto-probe: testCustom issues a
     * real completion, too heavy per paint — Test lives in Manage),
     * engine-missing / not-installed / warming / ready / installed.
     */
    _computeEntryStatus(entry) {
        if (!entry) return { state: 'none', text: '' };
        if (this._activeDownloads.has(entry.id)) {
            const p = this._activeDownloads.get(entry.id);
            return { state: 'downloading', text: (p && p.text) || 'Downloading…' };
        }
        if (entry.engine === 'server') {
            if (!entry.baseUrl) return { state: 'not-configured', text: 'No server URL yet. Open Manage' };
            let hostLabel = entry.baseUrl;
            try { hostLabel = new URL(entry.baseUrl).host || entry.baseUrl; } catch { /* show raw */ }
            return { state: 'configured', text: hostLabel };
        }
        if (entry.engine === 'openai' || entry.engine === 'anthropic') {
            // 'unreadable' = a key IS stored but this Mac's keychain can't
            // decrypt it, so requests would go out without one. Saying
            // "configured" there is how a broken key stayed invisible.
            if (this._entryKeyStatus.get(entry.id) === 'unreadable') {
                return { state: 'not-configured', text: 'API key needs re-entering. Open Manage' };
            }
            if (this._entryKeyStatus.get(entry.id) === false) {
                return { state: 'not-configured', text: 'No API key yet. Open Manage' };
            }
            return { state: 'configured', text: entry.engine === 'openai' ? 'api.openai.com' : 'api.anthropic.com' };
        }
        if (entry.engine === 'anjadhe') {
            // No key to configure — the machine's Connect key mints itself on
            // first use, so the entry is ready the moment it exists.
            return { state: 'configured', text: 'api.anjadhe.com' };
        }
        const eng = this._engines && this._engines[entry.engine];
        if (!eng) return { state: 'unknown', text: '' };
        if (!eng.status.isInstalled) {
            return { state: 'engine-missing', text: 'Engine not installed yet' };
        }
        if (!eng.installed.has(entry.model)) return { state: 'not-installed', text: 'Not downloaded' };
        if (typeof AgentService !== 'undefined' && AgentService._warming) return { state: 'warming', text: 'Warming up…' };
        if (eng.resident.has(entry.model)) return { state: 'ready', text: 'Ready' };
        return { state: 'installed', text: 'Downloaded' };
    },

    _buildModelCard(entry, isDefault) {
        const card = document.createElement('div');
        card.className = 'settings-model-card' + (isDefault ? ' is-default' : '');
        card.dataset.entryId = entry.id;

        const header = document.createElement('div');
        header.className = 'settings-model-card-header';

        // Default radio — switching also warms local engines.
        const radioWrap = document.createElement('label');
        radioWrap.className = 'settings-model-card-default';
        radioWrap.title = 'Use this model for new chats and every AI feature';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'settings-model-card-default';
        radio.checked = !!isDefault;
        radio.addEventListener('change', async () => {
            if (!radio.checked) return;
            await AgentService.setDefaultEntry(entry.id);
            if (typeof AgentUI !== 'undefined') {
                AgentUI.updateModelChip?.();
                AgentUI.startReadinessWatch?.();
            }
            const e = AgentService.getEntry(entry.id);
            UIUtils.showToast(e && e.engine === 'server'
                ? `Default model: ${e.model} (your server)`
                : e && e.engine === 'anjadhe'
                    ? `Default model: ${AgentService.anjadheEntryLabel(e)}`
                : e && AgentService.isRemoteEngine(e.engine)
                    ? `Default model: ${e.model}`
                    : `Default model: ${e ? e.model : ''} — warming up`, 'success');
            this._renderModelLibrary();
        });
        radioWrap.appendChild(radio);

        // Name + engine badge; the catalog description moves to its own
        // subline below the header so the row never turns into a wrap-fest.
        const info = document.createElement('div');
        info.className = 'settings-model-card-info';
        const name = document.createElement('span');
        name.className = 'settings-model-card-name';
        // Anjadhe Cloud entries show their catalog label, never the raw
        // public id — and skip the engine badge when the label already says
        // "Anjadhe Cloud" (the pair would read as a stutter).
        name.textContent = entry.engine === 'anjadhe'
            ? AgentService.anjadheEntryLabel(entry) : entry.model;
        info.appendChild(name);
        if (isDefault) {
            const chip = document.createElement('span');
            chip.className = 'settings-model-card-defaultchip';
            chip.textContent = 'Default';
            chip.title = 'This model powers chat and every AI feature';
            info.appendChild(chip);
        }
        if (entry.engine !== 'anjadhe' || AgentService.anjadheEntryLabel(entry) !== 'Anjadhe Cloud') {
            const badge = document.createElement('span');
            badge.className = 'settings-model-card-engine';
            badge.textContent = this._engineLabel(entry.engine);
            info.appendChild(badge);
        }
        const cat = this._catalogFor(entry);
        // Vision badge: the catalog's mmproj sidecar marks a local model as
        // able to read attached images (chat gating keys on the same signal).
        if (cat && cat.gguf && cat.gguf.mmproj && entry.engine === 'llamacpp') {
            const vis = document.createElement('span');
            vis.className = 'settings-model-vision';
            vis.textContent = 'Reads images';
            vis.title = 'A regular chat model that can also read attached images';
            info.appendChild(vis);
        }

        // Status area: dot + text + (when not downloaded) a Download button.
        const statusWrap = document.createElement('div');
        statusWrap.className = 'settings-model-card-statuswrap';
        const dot = document.createElement('span');
        dot.className = 'settings-model-card-dot';
        dot.setAttribute('aria-hidden', 'true');
        const status = document.createElement('span');
        status.className = 'settings-model-card-status';
        statusWrap.append(dot, status);
        this._fillCardStatus(statusWrap, status, entry, card);

        // Manage disclosure.
        const manage = document.createElement('button');
        manage.type = 'button';
        manage.className = 'settings-model-card-manage';
        manage.textContent = 'Manage';
        manage.title = entry.engine === 'server'
            ? 'Server URL, API key, connection test'
            : (entry.engine === 'openai' || entry.engine === 'anthropic')
                ? 'API key, model, connection test'
            : entry.engine === 'anjadhe'
                ? 'Monthly allowance, connection test'
                : 'Engine status, context window, thinking, delete';
        manage.addEventListener('click', () => this._toggleManage(card, entry));

        // Remove from the list (weights stay on disk — Manage deletes those).
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'settings-model-card-remove';
        remove.title = 'Remove this model from the list';
        remove.textContent = '✕';
        remove.addEventListener('click', async () => {
            const ok = await UIUtils.confirm('Remove model',
                `Remove <strong>${this._escape(entry.model)}</strong> from your list? ` +
                (AgentService.isRemoteEngine(entry.engine) ? '' : 'Downloaded files stay on disk — use Manage &rsaquo; Delete to free the space.'),
                '✕', { confirmText: 'Remove' });
            if (!ok) return;
            if (this._openManageId === entry.id) this._openManageId = null;
            AgentService.removeEntry(entry.id);
            if (typeof AgentUI !== 'undefined') {
                AgentUI.updateModelChip?.();
                AgentUI.startReadinessWatch?.();
            }
            this._renderModelLibrary();
        });

        header.append(radioWrap, info, statusWrap, manage, remove);
        card.appendChild(header);

        // Subline: what the model is and when it shipped, out of the way.
        if (cat && entry.engine !== 'server' && (cat.desc || cat.released)) {
            const sub = document.createElement('div');
            sub.className = 'settings-model-card-sub';
            if (cat.desc) {
                const desc = document.createElement('span');
                desc.className = 'settings-model-card-desc';
                desc.textContent = cat.desc;
                sub.appendChild(desc);
            }
            if (cat.released) {
                const rel = document.createElement('span');
                rel.className = 'settings-model-card-released';
                rel.textContent = `Released ${this._formatReleased(cat.released)}`;
                rel.title = 'When the provider published this model';
                sub.appendChild(rel);
            }
            card.appendChild(sub);
        }

        // Hidden Manage body — rendered on open, per card.
        const body = document.createElement('div');
        body.className = 'settings-model-card-body';
        body.style.display = 'none';
        card.appendChild(body);
        return card;
    },

    /** Status text + the action that fits the state (Download / hint). */
    _fillCardStatus(statusWrap, statusEl, entry, card) {
        const st = this._computeEntryStatus(entry);
        card.dataset.state = st.state;
        statusEl.textContent = st.text;
        statusEl.classList.toggle('is-downloading', st.state === 'downloading');
        if (st.state === 'not-installed' || st.state === 'engine-missing') {
            const cat = this._catalogFor(entry);
            if (entry.engine === 'llamacpp' && !(cat && cat.gguf)) {
                // No download source — the model arrives as a GGUF drop-in.
                statusEl.textContent = 'GGUF not found — drop the file in ~/.anjadhe_llamacpp/models';
                return;
            }
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'secondary-btn settings-model-card-download';
            btn.textContent = cat && cat.size ? `Download (${cat.size})` : 'Download';
            if (st.state === 'engine-missing') {
                btn.title = 'Installs the llama.cpp engine (~11 MB), then downloads the model';
            }
            btn.addEventListener('click', () => this._startEntryDownload(entry.id));
            statusWrap.appendChild(btn);
        }
    },

    // ── Per-card Manage body ──

    _toggleManage(card, entry) {
        const body = card.querySelector('.settings-model-card-body');
        if (!body) return;
        const isOpen = body.style.display !== 'none';
        // Close any open body (one at a time).
        document.querySelectorAll('.settings-model-card-body').forEach(b => { b.style.display = 'none'; });
        document.querySelectorAll('.settings-model-card-manage.open').forEach(b => b.classList.remove('open'));
        this._openManageId = null;
        if (isOpen) return;
        this._openManage(card, entry);
    },

    _openManage(card, entry) {
        const body = card.querySelector('.settings-model-card-body');
        if (!body) return;
        this._openManageId = entry.id;
        card.querySelector('.settings-model-card-manage')?.classList.add('open');
        body.style.display = '';
        if (entry.engine === 'server') this._renderServerManage(body, entry);
        else if (entry.engine === 'openai' || entry.engine === 'anthropic') this._renderCloudManage(body, entry);
        else if (entry.engine === 'anjadhe') this._renderAnjadheManage(body, entry);
        else this._renderLocalManage(body, entry);
    },

    /**
     * Manage body for a local entry: engine status, Think toggle, context
     * window, license, delete-weights. All controls are closures over the
     * ENTRY and query inside the body — no global ids, so two cards can't
     * fight and nothing mutates machine-global engine state on open.
     */
    _renderLocalManage(body, entry) {
        body.innerHTML = '';
        const eng = this._engines && this._engines[entry.engine];

        const engineHost = document.createElement('div');
        engineHost.className = 'settings-model-card-enginestatus';
        body.appendChild(engineHost);
        this._renderEngineStatusInto(engineHost);

        // Think toggle — per entry, the chat default (header chip overrides per-chat).
        const thinkRow = document.createElement('div');
        thinkRow.className = 'settings-toggle-row';
        const thinkLabel = document.createElement('label');
        thinkLabel.className = 'settings-toggle-label';
        thinkLabel.textContent = 'Thinking';
        const thinkInput = document.createElement('input');
        thinkInput.type = 'checkbox';
        thinkInput.checked = entry.think !== false;
        thinkInput.title = 'Reasoning on by default (slower first token, often better multi-step answers) — uncheck to skip it';
        thinkInput.addEventListener('change', () => {
            AgentService.updateEntry(entry.id, { think: thinkInput.checked });
        });
        thinkRow.append(thinkLabel, thinkInput);
        body.appendChild(thinkRow);
        const thinkHint = document.createElement('p');
        thinkHint.className = 'settings-hint';
        thinkHint.textContent = 'On by default: reasoning models think through hidden tokens before each answer — slower to start, often better at multi-step tasks. Uncheck to answer without the thinking pass. Non-reasoning models ignore this. You can still flip it per-chat from the thinking chip.';
        body.appendChild(thinkHint);

        // Context window — per entry (Auto = the RAM tier for this engine).
        const ctxRow = document.createElement('div');
        ctxRow.className = 'settings-toggle-row';
        const ctxLabel = document.createElement('label');
        ctxLabel.className = 'settings-toggle-label';
        ctxLabel.textContent = 'Context window';
        const ctxSel = document.createElement('select');
        ctxSel.className = 'settings-select settings-inline-select';
        const autoVal = AgentService.autoNumCtx(this._engines?.totalMemGB || 8, entry.engine);
        for (const [value, label] of [
            [0, `Auto — ${autoVal.toLocaleString()} on this Mac`],
            [4096, '4,096 tokens (low RAM)'],
            [8192, '8,192 tokens'],
            [16384, '16,384 tokens'],
            [32768, '32,768 tokens'],
            [65536, '65,536 tokens (high memory)']
        ]) {
            const opt = document.createElement('option');
            opt.value = String(value);
            opt.textContent = label;
            ctxSel.appendChild(opt);
        }
        ctxSel.value = String(entry.numCtx || 0);
        ctxSel.addEventListener('change', () => {
            const n = Number(ctxSel.value);
            AgentService.updateEntry(entry.id, { numCtx: Number.isFinite(n) && n > 0 ? n : null });
        });
        ctxRow.append(ctxLabel, ctxSel);
        body.appendChild(ctxRow);
        const ctxHint = document.createElement('p');
        ctxHint.className = 'settings-hint';
        ctxHint.textContent = 'How much conversation and document context this model holds in memory. Bigger fits more but uses more RAM. Changing it triggers a one-time model reload on the next chat.';
        body.appendChild(ctxHint);

        // License — each model ships under its own terms.
        const cat = this._catalogFor(entry);
        if (cat && cat.license) {
            const lic = document.createElement('p');
            lic.className = 'settings-hint';
            lic.textContent = 'License: ';
            const link = document.createElement('a');
            link.href = '#';
            link.className = 'settings-model-license';
            link.textContent = cat.license;
            link.addEventListener('click', (e) => {
                e.preventDefault();
                if (cat.licenseUrl) window.electronAuth?.openExternal?.(cat.licenseUrl);
            });
            lic.appendChild(link);
            body.appendChild(lic);
        }

        // Delete the downloaded weights (the entry itself stays in the list).
        if (eng && eng.installed.has(entry.model)) {
            const delRow = document.createElement('div');
            delRow.className = 'settings-input-row';
            delRow.style.marginTop = 'var(--space-md)';
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'secondary-btn settings-model-card-deleteweights';
            delBtn.textContent = 'Delete model from disk';
            delBtn.addEventListener('click', async () => {
                const ok = await UIUtils.confirm('Delete model',
                    `Delete <strong>${this._escape(entry.model)}</strong> from this Mac? You can download it again anytime.`,
                    '🗑️', { confirmText: 'Delete' });
                if (!ok) return;
                delBtn.disabled = true;
                delBtn.textContent = 'Deleting…';
                try {
                    const result = await this._engineApiFor(entry.engine).deleteModel(entry.model);
                    if (result?.error || result?.success === false) throw new Error(result?.error || 'Delete failed');
                    UIUtils.showToast(`${entry.model} deleted`, 'success');
                    await this._renderModelLibrary();
                } catch {
                    UIUtils.showToast(`Failed to delete ${entry.model}`, 'error');
                    delBtn.disabled = false;
                    delBtn.textContent = 'Delete model from disk';
                }
            });
            delRow.appendChild(delBtn);
            body.appendChild(delRow);
        }
    },

    /**
     * Manage body for a server entry: model name, base URL, per-entry API
     * key, Auto-detect / Test / Save. Saving writes the URL + model onto the
     * ENTRY and the key into main's encrypted per-entry store; a blank key
     * field leaves any stored key untouched.
     */
    _renderServerManage(body, entry) {
        body.innerHTML = '';

        const desc = document.createElement('p');
        desc.className = 'settings-section-desc';
        desc.innerHTML = 'Connection details for this model\'s server &mdash; any endpoint that speaks the OpenAI <code>/v1/chat/completions</code> API (<code>llama-server</code>, vLLM, LM Studio) on a computer you own. Auto-detect finds one running on this Mac.';
        body.appendChild(desc);

        const modelRow = document.createElement('div');
        modelRow.className = 'settings-input-row';
        modelRow.style.marginBottom = 'var(--space-md)';
        const modelInput = document.createElement('input');
        modelInput.type = 'text';
        modelInput.className = 'settings-input';
        modelInput.placeholder = 'Model name on your server, e.g. qwen3.6:35b';
        modelInput.value = entry.model || '';
        modelRow.appendChild(modelInput);
        body.appendChild(modelRow);

        const urlRow = document.createElement('div');
        urlRow.className = 'settings-input-row';
        urlRow.style.marginBottom = 'var(--space-md)';
        const urlInput = document.createElement('input');
        urlInput.type = 'text';
        urlInput.className = 'settings-input';
        urlInput.placeholder = 'http://your-server:8080/v1';
        urlInput.value = entry.baseUrl || '';
        urlRow.appendChild(urlInput);
        body.appendChild(urlRow);

        const keyRow = document.createElement('div');
        keyRow.className = 'settings-input-row';
        const keyInput = document.createElement('input');
        keyInput.type = 'password';
        keyInput.className = 'settings-input';
        keyInput.placeholder = 'API key (optional)';
        window.electronLLM?.entryKeyStatus?.(entry.id).then((r) => {
            if (r?.unreadable) keyInput.placeholder = 'Saved key unreadable — enter it again';
            else if (r?.hasKey) keyInput.placeholder = '•••••••• (saved)';
        }).catch(() => {});
        const detectBtn = document.createElement('button');
        detectBtn.type = 'button';
        detectBtn.className = 'secondary-btn';
        detectBtn.textContent = 'Auto-detect';
        detectBtn.title = 'Scan localhost for a running OpenAI-compatible server';
        const testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.className = 'secondary-btn';
        testBtn.textContent = 'Test';
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'secondary-btn';
        saveBtn.textContent = 'Save';
        keyRow.append(keyInput, detectBtn, testBtn, saveBtn);
        body.appendChild(keyRow);

        const status = document.createElement('p');
        status.className = 'settings-key-status';
        status.textContent = entry.baseUrl
            ? `Endpoint: ${entry.baseUrl}`
            : 'No server URL yet. Enter one or use Auto-detect.';
        body.appendChild(status);

        const hint = document.createElement('p');
        hint.className = 'settings-hint';
        hint.innerHTML = 'The URL can be the base (<code>http://host:8080</code>), the <code>/v1</code> path, or the full <code>/v1/chat/completions</code>. An API key is only needed if your server requires one (e.g. <code>llama-server --api-key</code>) &mdash; it is stored encrypted, per model. App-action tools work only if the server supports OpenAI function-calling for the model.';
        body.appendChild(hint);

        detectBtn.addEventListener('click', async () => {
            status.textContent = 'Scanning localhost (8080, 1234, 8000…)…';
            const res = await window.electronLLM?.detectCustom?.();
            if (res?.found) {
                urlInput.value = res.baseUrl;
                if (res.model && !modelInput.value.trim()) modelInput.value = res.model;
                status.textContent = `Found a server at ${res.baseUrl}${res.model ? ` (serving: ${res.model})` : ''}. Click Save to use it.`;
                UIUtils.showToast('Server detected — review and Save', 'success');
            } else {
                status.textContent = 'No local OpenAI-compatible server found on common ports (8080, 1234, 8000, 5000, 8081).';
                UIUtils.showToast('No server found', 'error');
            }
        });

        testBtn.addEventListener('click', async () => {
            const baseUrl = urlInput.value.trim();
            if (!baseUrl) { status.textContent = 'Enter a server URL first.'; return; }
            status.textContent = 'Testing…';
            const cfg = { baseUrl, model: modelInput.value.trim() || entry.model || '', entryId: entry.id };
            const key = keyInput.value.trim();
            if (key) cfg.apiKey = key;
            const res = await window.electronLLM?.testCustom?.(cfg);
            if (res?.ok) {
                status.textContent = `✓ Connected${res.model ? ` (${res.model})` : ''}${res.reply ? ` — reply: "${res.reply}"` : ''}`;
                UIUtils.showToast('Server reachable', 'success');
            } else {
                status.textContent = `✗ ${res?.error || 'Connection failed'}`;
                UIUtils.showToast('Server test failed', 'error');
            }
        });

        saveBtn.addEventListener('click', async () => {
            const baseUrl = urlInput.value.trim();
            const model = modelInput.value.trim();
            if (!model) { UIUtils.showToast('Enter the model name on your server', 'error'); return; }
            // updateEntry persists via saveModelList, which write-throughs to
            // the legacy provider settings when this entry is the default.
            AgentService.updateEntry(entry.id, { model, baseUrl });
            const key = keyInput.value.trim();
            if (key) {
                const res = await window.electronLLM?.setEntryKey?.(entry.id, key);
                if (res && res.success === false) { UIUtils.showToast(res.error || 'Could not save the key', 'error'); return; }
                keyInput.value = '';
                keyInput.placeholder = '•••••••• (saved)';
            }
            status.textContent = baseUrl ? `Endpoint saved: ${baseUrl}` : 'No server URL yet — enter one or Auto-detect.';
            UIUtils.showToast('Server details saved', 'success');
            if (typeof AgentUI !== 'undefined') {
                AgentUI.updateModelChip?.();
                AgentUI.startReadinessWatch?.();
            }
            this._renderModelLibrary();
        });
    },

    /**
     * Manage body for a cloud entry (OpenAI / Anthropic API): model id, the
     * per-entry API key (encrypted in main), live model listing with the
     * key, and a connection test. Mirrors _renderServerManage minus the URL —
     * the endpoint is fixed per provider.
     */
    _renderCloudManage(body, entry) {
        body.innerHTML = '';
        const label = entry.engine === 'openai' ? 'OpenAI' : 'Anthropic';
        const keysUrl = entry.engine === 'openai'
            ? 'https://platform.openai.com/api-keys'
            : 'https://console.anthropic.com/settings/keys';

        const desc = document.createElement('p');
        desc.className = 'settings-section-desc';
        desc.textContent = `${label}'s official API with your own key. Whatever runs on this model — chats, email insights, builds — is sent to ${label}'s servers under your account.`;
        body.appendChild(desc);

        const modelRow = document.createElement('div');
        modelRow.className = 'settings-input-row';
        modelRow.style.marginBottom = 'var(--space-md)';
        const modelInput = document.createElement('input');
        modelInput.type = 'text';
        modelInput.className = 'settings-input';
        modelInput.placeholder = entry.engine === 'openai' ? 'Model id, e.g. gpt-5.2' : 'Model id, e.g. claude-opus-4-8';
        modelInput.value = entry.model || '';
        const listBtn = document.createElement('button');
        listBtn.type = 'button';
        listBtn.className = 'secondary-btn';
        listBtn.textContent = 'List models';
        listBtn.title = `Fetch the models your ${label} key can use`;
        modelRow.append(modelInput, listBtn);
        body.appendChild(modelRow);

        const modelSel = document.createElement('select');
        modelSel.className = 'settings-select';
        modelSel.style.display = 'none';
        modelSel.style.marginBottom = 'var(--space-md)';
        modelSel.addEventListener('change', () => { if (modelSel.value) modelInput.value = modelSel.value; });
        body.appendChild(modelSel);

        const keyRow = document.createElement('div');
        keyRow.className = 'settings-input-row';
        const keyInput = document.createElement('input');
        keyInput.type = 'password';
        keyInput.className = 'settings-input';
        keyInput.placeholder = 'API key';
        window.electronLLM?.entryKeyStatus?.(entry.id).then((r) => {
            if (r?.unreadable) keyInput.placeholder = 'Saved key unreadable — enter it again';
            else if (r?.hasKey) keyInput.placeholder = '•••••••• (saved)';
        }).catch(() => {});
        const testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.className = 'secondary-btn';
        testBtn.textContent = 'Test';
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'secondary-btn';
        saveBtn.textContent = 'Save';
        keyRow.append(keyInput, testBtn, saveBtn);
        body.appendChild(keyRow);

        const status = document.createElement('p');
        status.className = 'settings-key-status';
        body.appendChild(status);

        const hint = document.createElement('p');
        hint.className = 'settings-hint';
        hint.innerHTML = `The key is stored encrypted on this Mac, per model — it never syncs. Create or manage keys at <a href="#" class="settings-model-license">${keysUrl.replace('https://', '')}</a>. API usage is billed by ${label} to your account.`;
        hint.querySelector('a').addEventListener('click', (e) => {
            e.preventDefault();
            window.electronAuth?.openExternal?.(keysUrl);
        });
        body.appendChild(hint);

        listBtn.addEventListener('click', async () => {
            status.textContent = 'Fetching model list…';
            const res = await window.electronLLM?.cloudModels?.({
                engine: entry.engine, apiKey: keyInput.value.trim(), entryId: entry.id
            });
            if (res?.models?.length) {
                modelSel.innerHTML = '';
                const ph = document.createElement('option');
                ph.value = '';
                ph.textContent = `Pick from ${res.models.length} models…`;
                modelSel.appendChild(ph);
                for (const m of res.models) {
                    const opt = document.createElement('option');
                    opt.value = m.id;
                    opt.textContent = m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id;
                    modelSel.appendChild(opt);
                }
                modelSel.style.display = '';
                status.textContent = `Loaded ${res.models.length} models from ${label}.`;
            } else {
                status.textContent = `✗ ${res?.error || 'Could not list models'}`;
            }
        });

        testBtn.addEventListener('click', async () => {
            const model = modelInput.value.trim() || entry.model;
            status.textContent = 'Testing…';
            const res = await window.electronLLM?.testCloud?.({
                engine: entry.engine, model, apiKey: keyInput.value.trim(), entryId: entry.id
            });
            if (res?.ok) {
                status.textContent = `✓ Connected${res.model ? ` (${res.model})` : ''}${res.reply ? ` — reply: "${res.reply}"` : ''}`;
                UIUtils.showToast(`${label} reachable`, 'success');
            } else {
                status.textContent = `✗ ${res?.error || 'Connection failed'}`;
                UIUtils.showToast(`${label} test failed`, 'error');
            }
        });

        saveBtn.addEventListener('click', async () => {
            const model = modelInput.value.trim();
            if (!model) { UIUtils.showToast('Enter the model id', 'error'); return; }
            AgentService.updateEntry(entry.id, { model });
            const key = keyInput.value.trim();
            if (key) {
                const res = await window.electronLLM?.setEntryKey?.(entry.id, key);
                if (res && res.success === false) { UIUtils.showToast(res.error || 'Could not save the key', 'error'); return; }
                keyInput.value = '';
                keyInput.placeholder = '•••••••• (saved)';
            }
            status.textContent = 'Saved.';
            UIUtils.showToast(`${label} model saved`, 'success');
            if (typeof AgentUI !== 'undefined') {
                AgentUI.updateModelChip?.();
                AgentUI.startReadinessWatch?.();
            }
            this._renderModelLibrary();
        });
    },

    /**
     * Manage body for the Anjadhe Cloud entry: nothing to configure — the
     * machine's Connect key mints itself on first use — so the panel is the
     * consent copy, the free-tier meter (the same /v1/usage call the Web
     * Search card makes, reading its llm block), and a Test button.
     */
    _renderAnjadheManage(body, entry) {
        body.innerHTML = '';

        const desc = document.createElement('p');
        desc.className = 'settings-section-desc';
        desc.textContent = 'An open-weight model served by Anjadhe Connect (api.anjadhe.com). '
            + 'What runs on this model — chats, email insights, builds — goes to Anjadhe’s server, '
            + 'which forwards it to an inference provider under a no-retention agreement, without '
            + 'your identity. The service keeps usage counts, never what you asked.';
        body.appendChild(desc);

        const status = document.createElement('p');
        status.className = 'settings-key-status';
        status.textContent = 'Checking usage…';
        body.appendChild(status);

        const row = document.createElement('div');
        row.className = 'settings-input-row';
        const testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.className = 'secondary-btn';
        testBtn.textContent = 'Test';
        testBtn.title = 'Send a one-line test request to Anjadhe Cloud';
        row.appendChild(testBtn);
        body.appendChild(row);

        const hint = document.createElement('p');
        hint.className = 'settings-hint';
        hint.textContent = 'When the monthly allowance runs out, requests pause until the 1st — '
            + 'you can also run a model on this Mac, or add your own key or server. '
            + 'Removing this model stops anything from reaching Anjadhe Cloud.';
        body.appendChild(hint);

        // Name the deployment this app actually talks to — "api.anjadhe.com"
        // on the card is the default, and a staging test run (via
        // ANJADHE_CONNECT_URL) should be distinguishable at a glance. Also
        // the moment a fresh catalog is in hand, so a renamed label lands.
        const server = document.createElement('p');
        server.className = 'settings-hint';
        body.appendChild(server);
        window.electronLLM?.anjadheModels?.().then(async (res) => {
            if (res?.host) {
                const host = res.host.replace(/^https?:\/\//, '');
                server.textContent = `Server: ${host}`;
                if (host !== 'api.anjadhe.com') server.textContent += ' (overridden via ANJADHE_CONNECT_URL)';
            }
            const changed = await AgentService.refreshAnjadheLabels?.(res);
            if (changed) this._renderModelLibrary();
        }).catch(() => {});

        const refreshUsage = async () => {
            const u = await window.electronSearch?.connectUsage?.(false).catch(() => null);
            if (!u || u.error) {
                status.textContent = u?.error ? `Can't reach Anjadhe Connect — ${u.error}` : 'Usage unavailable.';
                return;
            }
            if (u.notProvisioned) {
                status.textContent = 'No usage yet — access sets itself up on the first request.';
                return;
            }
            const plan = (u.tier || 'free').replace(/^./, c => c.toUpperCase());
            const llm = u.llm || {};
            status.textContent = `${plan} plan — ${llm.requests ?? 0} of ${llm.requestQuota ?? '—'} AI requests used this month · resets ${u.resetsAt || '—'}`;
        };
        refreshUsage();

        testBtn.addEventListener('click', async () => {
            status.textContent = 'Testing…';
            testBtn.disabled = true;
            try {
                const res = await window.electronLLM?.chat?.({
                    engine: 'anjadhe',
                    model: entry.model || this.ANJADHE_CLOUD_MODEL,
                    messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
                    maxTokens: 10
                });
                if (res && !res.error) {
                    UIUtils.showToast('Anjadhe Cloud reachable', 'success');
                    await refreshUsage();
                } else {
                    status.textContent = `✗ ${res?.error || 'Connection failed'}`;
                    UIUtils.showToast('Anjadhe Cloud test failed', 'error');
                }
            } finally {
                testBtn.disabled = false;
            }
        });
    },

    // ── Downloads (engine install included) ──

    /**
     * Download an entry's model, installing the llama.cpp engine first when
     * it's missing (~11 MB tarball). Progress paints inline on the entry's
     * card, keyed by entry id so re-renders pick it right back up.
     */
    async _startEntryDownload(entryId) {
        const entry = AgentService.getEntry(entryId);
        if (!entry || AgentService.isRemoteEngine(entry.engine)) return;
        if (this._activeDownloads.has(entryId)) return;
        const api = this._engineApiFor(entry.engine);
        if (!api) return;

        const setProgress = (text, percent) => {
            this._activeDownloads.set(entryId, { text, percent });
            this._paintCardProgress(entryId);
        };
        setProgress('Starting…', null);

        try {
            // 1. Engine present? Install inline when we can.
            let status = null;
            try { status = await api.status(); } catch { /* treat as missing */ }
            if (!status?.isInstalled) {
                setProgress('Installing llama.cpp engine…', null);
                const res = await api.install((p) => {
                    if (p.phase === 'download' && p.percent != null) setProgress(`Installing llama.cpp engine… ${p.percent}%`, null);
                    else if (p.message) setProgress(p.message, null);
                });
                if (res?.error) throw new Error(res.error);
            }
            // 2. Pull, rAF-throttled so fast progress events can't flood layout.
            let latest = null;
            let rafPending = false;
            const flush = () => {
                rafPending = false;
                if (!latest) return;
                if (latest.percent !== null && latest.percent !== undefined) setProgress(`${latest.percent}%`, latest.percent);
                else setProgress(latest.status || 'Downloading…', null);
            };
            const result = await api.pullModel(entry.model, (progress) => {
                latest = progress;
                if (!rafPending) { rafPending = true; requestAnimationFrame(flush); }
            });
            if (result?.error) throw new Error(result.error);

            this._activeDownloads.delete(entryId);
            UIUtils.showToast(`${entry.model} downloaded`, 'success');
            const def = AgentService.getDefaultEntry();
            if (def && def.id === entryId) AgentService.warmOnIntent?.();
            await this._renderModelLibrary();
        } catch (e) {
            this._activeDownloads.delete(entryId);
            await this._handleEntryPullError(entry, e?.message || 'Download failed');
        }
    },

    /** Paint an in-flight download onto its card (found by entry id). */
    _paintCardProgress(entryId) {
        const card = document.querySelector(`.settings-model-card[data-entry-id="${CSS.escape(entryId)}"]`);
        if (!card) return;
        const p = this._activeDownloads.get(entryId);
        if (!p) return;
        card.dataset.state = 'downloading';
        const statusEl = card.querySelector('.settings-model-card-status');
        if (statusEl) {
            statusEl.textContent = p.text || 'Downloading…';
            statusEl.classList.add('is-downloading');
        }
        const btn = card.querySelector('.settings-model-card-download');
        if (btn) btn.remove();
        let strip = card.querySelector('.settings-model-progress');
        if (!strip) {
            strip = document.createElement('div');
            strip.className = 'settings-model-progress';
            strip.innerHTML = '<div class="settings-model-progress-fill"></div>';
            card.appendChild(strip);
        }
        const fill = strip.querySelector('.settings-model-progress-fill');
        if (fill && p.percent !== null && p.percent !== undefined) fill.style.width = p.percent + '%';
    },

    async _handleEntryPullError(entry, errorMsg) {
        UIUtils.showToast('Download failed: ' + errorMsg, 'error', 6000);
        // Re-render resets the card to its real state (Download reappears —
        // the entry stays in the list, so the user can just retry).
        await this._renderModelLibrary();
    },

    // ── Add-model flow (full page) ──
    //
    // #add-model-view: a sources nav (where the model runs) beside the step
    // pane. Each _renderAdd*Step takes (body, ctx) where ctx.close() means
    // "done" — the page passes a navigate-back-to-Models ctx; the setup
    // wizard (app-manager.js) still hosts the same steps inside a modal,
    // whose ctx is the modal itself. Incomplete state lives in the pane, so
    // a half-finished add can never persist a blank entry.

    // Which door the current add-model flow was opened from ('settings' |
    // 'wizard') — analytics label only, never behavior.
    _addModelSource: 'settings',

    ADD_MODEL_SOURCES: {
        local: { title: 'On this Mac' },
        anjadhe: { title: 'Anjadhe Cloud' },
        server: { title: 'Your server' },
        openai: { title: 'OpenAI API' },
        anthropic: { title: 'Anthropic API' }
    },

    async _openAddModelPage() {
        this._addModelSource = 'settings';
        const view = document.getElementById('add-model-view');
        if (!view) return;
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        view.classList.add('active');
        this._stopLibraryWatch();
        // The masthead's serif title names the page — the breadcrumb stops
        // at the lineage rather than saying "Add a model" twice.
        Breadcrumb.render('add-model-breadcrumb', [
            { label: 'Settings', action: () => { view.classList.remove('active'); document.getElementById('settings-view').classList.add('active'); this._loadLLMSummary(); } },
            { label: 'AI Assistant', action: () => this.openLLMSettings() },
            { label: 'Models', action: () => this.openLLMSection('llm-sec-models') }
        ]);
        this._bindAddModelNav();
        // The local catalog needs the engine probe (installed set, RAM cap)
        // when the page is entered before the library ever rendered.
        if (!this._engines) { try { await this._refreshEngineState(); } catch { /* pane shows empty catalog */ } }
        // A Mac under the 32 GB local floor gets no local offering, so the
        // nav must not call that path "Recommended" over an empty list.
        const localBadge = document.querySelector('#add-model-nav [data-add-src="local"] .add-model-src-badge');
        if (localBadge) localBadge.style.display = this._localBelowFloor() ? 'none' : '';
        // …and opens on Anjadhe Cloud, the same first offer the wizard's
        // low-RAM step makes (the alternative there is no AI at all).
        this._selectAddModelSource(this._localBelowFloor() ? 'anjadhe' : 'local');
        view.scrollTop = 0;
    },

    _bindAddModelNav() {
        const nav = document.getElementById('add-model-nav');
        if (!nav || nav._bound) return;
        nav._bound = true;
        nav.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-add-src]');
            if (btn) this._selectAddModelSource(btn.dataset.addSrc);
        });
        // Esc leaves the page — unless a layer above it (a dialog, ⌘K, the
        // app switcher) owns the key right now.
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const view = document.getElementById('add-model-view');
            if (!view || !view.classList.contains('active')) return;
            if (document.querySelector('dialog[open], .cmdk-overlay.is-open, .app-switcher.is-open')) return;
            this.openLLMSection('llm-sec-models');
        });
    },

    _selectAddModelSource(src) {
        const spec = this.ADD_MODEL_SOURCES[src];
        const body = document.getElementById('add-model-pane-body');
        if (!spec || !body) return;
        document.querySelectorAll('#add-model-nav .add-model-src').forEach(b =>
            b.classList.toggle('is-active', b.dataset.addSrc === src));
        const title = document.getElementById('add-model-pane-title');
        if (title) title.textContent = spec.title;
        const ctx = { close: () => this.openLLMSection('llm-sec-models') };
        if (src === 'local') this._renderAddLocalStep(body, ctx, 'llamacpp');
        else if (src === 'anjadhe') this._renderAddAnjadheStep(body, ctx);
        else if (src === 'server') this._renderAddServerStep(body, ctx);
        else this._renderAddCloudStep(body, ctx, src);
    },

    // The public model name Anjadhe Connect has served on /v1/llm since
    // launch — the fallback when the catalog can't be fetched (offline, or
    // a deployment predating /v1/llm/models). The server maps each public
    // name to whatever open weights it currently runs, so better weights
    // need no app release.
    ANJADHE_CLOUD_MODEL: 'anjadhe-cloud',

    /**
     * Add step for Anjadhe Cloud: no key — the Connect key mints itself on
     * the first request (clicking Add is the opt-in; nothing reaches the
     * service until the model is actually used). The model list comes from
     * the server's own catalog (/v1/llm/models), so which models are on
     * offer is the operator's call, never an app release: one model renders
     * as plain consent copy + Add, several render as a picker.
     */
    _renderAddAnjadheStep(body, ctx) {
        body.innerHTML = '';

        const desc = document.createElement('p');
        desc.className = 'settings-section-desc';
        desc.textContent = 'Open-weight models served by Anjadhe Connect (api.anjadhe.com). '
            + 'What runs on them — chats, email insights, builds — goes to Anjadhe’s server, '
            + 'which forwards it to an inference provider under a no-retention agreement, without your '
            + 'identity: nothing is stored, and nothing is used to train models. The service keeps '
            + 'usage counts, never what you asked; its source code is public so that can be checked.';
        body.appendChild(desc);

        const listWrap = document.createElement('div');
        body.appendChild(listWrap);
        const loading = document.createElement('p');
        loading.className = 'settings-hint';
        loading.textContent = 'Checking which models are available…';
        listWrap.appendChild(loading);

        const quota = document.createElement('p');
        quota.className = 'settings-hint';
        quota.textContent = 'Anjadhe Cloud is in preview: the free plan includes 1,000 AI requests a '
            + 'month across these models. When it runs out you can wait for the next month, run a '
            + 'model on this Mac, or add your own key or server.';
        body.appendChild(quota);

        const footer = document.createElement('div');
        footer.className = 'settings-input-row settings-add-model-footer';
        body.appendChild(footer);

        const render = (models) => {
            listWrap.innerHTML = '';
            footer.innerHTML = '';
            const mine = new Set(AgentService.getModelList()
                .filter(e => e.engine === 'anjadhe').map(e => e.model));
            const addable = models.filter(m => !mine.has(m.id));

            let selected = addable[0] || null;
            // Several models on offer → a picker in the local add step's
            // row mould; one model keeps the old copy-and-a-button shape.
            if (models.length > 1) {
                const list = document.createElement('div');
                list.className = 'settings-model-list settings-add-model-list';
                for (const m of models) {
                    const item = document.createElement('div');
                    item.className = 'settings-model-item'
                        + (mine.has(m.id) ? ' installed' : '')
                        + (selected && selected.id === m.id ? ' active' : '');
                    const radio = document.createElement('span');
                    radio.className = 'settings-model-radio';
                    const info = document.createElement('div');
                    info.className = 'settings-model-info';
                    const nameEl = document.createElement('span');
                    nameEl.className = 'settings-model-name';
                    nameEl.textContent = m.label;
                    info.appendChild(nameEl);
                    if (m.description) {
                        const descEl = document.createElement('span');
                        descEl.className = 'settings-model-desc';
                        descEl.textContent = m.description;
                        info.appendChild(descEl);
                    }
                    const statusEl = document.createElement('span');
                    statusEl.className = 'settings-model-status';
                    statusEl.textContent = mine.has(m.id) ? 'In your list' : '';
                    item.append(radio, info, statusEl);
                    item.addEventListener('click', () => {
                        if (mine.has(m.id)) return;
                        list.querySelectorAll('.settings-model-item.active').forEach(el => el.classList.remove('active'));
                        item.classList.add('active');
                        selected = m;
                    });
                    list.appendChild(item);
                }
                listWrap.appendChild(list);
            } else if (models.length === 1 && mine.has(models[0].id)) {
                const done = document.createElement('p');
                done.className = 'settings-key-status';
                const entry = AgentService.getModelList().find(e => e.engine === 'anjadhe' && e.model === models[0].id);
                const def = AgentService.getDefaultEntry?.();
                done.textContent = def && entry && def.id === entry.id
                    ? '✓ Already in your list — it’s your default model.'
                    : '✓ Already in your list.';
                listWrap.appendChild(done);
            }

            if (!addable.length) {
                if (models.length > 1) {
                    const done = document.createElement('p');
                    done.className = 'settings-key-status';
                    done.textContent = '✓ All Anjadhe Cloud models are in your list.';
                    listWrap.appendChild(done);
                }
                const goBtn = document.createElement('button');
                goBtn.type = 'button';
                goBtn.className = 'secondary-btn';
                goBtn.textContent = 'View your models';
                goBtn.addEventListener('click', () => ctx.close());
                footer.appendChild(goBtn);
                return;
            }

            const addBtn = document.createElement('button');
            addBtn.type = 'button';
            addBtn.className = 'primary-btn';
            addBtn.textContent = models.length > 1 ? 'Add selected model' : `Add ${addable[0].label}`;
            addBtn.addEventListener('click', () => {
                if (!selected) return;
                this._finishAddModel(ctx, {
                    engine: 'anjadhe', model: selected.id, label: selected.label
                });
            });
            footer.appendChild(addBtn);
        };

        window.electronLLM?.anjadheModels?.().then((res) => {
            const models = (res && Array.isArray(res.models) && res.models.length)
                ? res.models
                : [{ id: this.ANJADHE_CLOUD_MODEL, label: 'Anjadhe Cloud' }];
            // A fresh catalog in hand — carry any renamed labels onto the
            // entries already in the list (no extra request; see
            // refreshAnjadheLabels).
            AgentService.refreshAnjadheLabels?.(res).catch?.(() => {});
            render(models);
        }).catch(() => {
            render([{ id: this.ANJADHE_CLOUD_MODEL, label: 'Anjadhe Cloud' }]);
        });
    },

    /** Finish an add: create the entry, close, render, start the download. */
    async _finishAddModel(ctx, { engine, model, baseUrl, key, label }) {
        const before = AgentService.getModelList().length;
        const entry = AgentService.addEntry({ engine, model, baseUrl, label });
        if (!entry) { UIUtils.showToast('Enter a model name first', 'error'); return; }
        const isNew = AgentService.getModelList().length > before;
        if (!isNew) UIUtils.showToast(`${entry.model} is already in your list`, 'info');
        if (isNew && typeof AnalyticsManager !== 'undefined') {
            // Adoption funnel (opt-in analytics): which engine, which door.
            // _addModelSource is stamped 'wizard' by the setup flow that
            // reuses these steps; the modal opener resets it to 'settings'.
            AnalyticsManager.record('model.added', { engine, source: this._addModelSource || 'settings' });
        }
        if (key && AgentService.isRemoteEngine(engine)) {
            const res = await window.electronLLM?.setEntryKey?.(entry.id, key);
            if (res && res.success === false) UIUtils.showToast(res.error || 'Could not save the key', 'error');
        }
        // Awaited so the page ctx (navigate back to Models, which renders
        // the library) finishes before the render below — two interleaved
        // _renderModelLibrary calls could double-append cards.
        await ctx.close();
        if (typeof AgentUI !== 'undefined') {
            AgentUI.updateModelChip?.();
            AgentUI.startReadinessWatch?.();
        }
        await this._renderModelLibrary();
        if (isNew && !AgentService.isRemoteEngine(engine)) {
            const eng = this._engines && this._engines[engine];
            if (!eng?.installed?.has(entry.model)) {
                const cat = this._catalogFor(entry);
                // llama.cpp models without a GGUF source can't be downloaded —
                // the card shows the drop-in hint instead.
                if (engine !== 'llamacpp' || (cat && cat.gguf)) this._startEntryDownload(entry.id);
            }
        }
    },

    // Below the catalog's local floor: every local catalog model needs more
    // RAM than this Mac has (the deliberate 32 GB floor, 2026-08-06 — small
    // models didn't work well enough to offer). Distinct from a catalog
    // that failed to load, which deserves a different message.
    _localBelowFloor() {
        const totalRam = this._engines?.totalMemGB || 8;
        const cat = (this._engines?.catalog || []).filter(m => m.gguf);
        return cat.length > 0 && !cat.some(m => (m.minRam || 0) <= totalRam);
    },

    _renderAddLocalStep(body, ctx, engine) {
        body.innerHTML = '';

        const eng = this._engines && this._engines[engine];
        const installedSet = eng?.installed || new Set();
        const totalRam = this._engines?.totalMemGB || 8;
        const catalog = (this._engines?.catalog || [])
            .filter(m => (m.minRam || 0) <= totalRam)
            .filter(m => engine !== 'llamacpp' || m.gguf);
        const inList = new Set(AgentService.getModelList()
            .filter(e => e.engine === engine).map(e => e.model));
        const belowFloor = engine === 'llamacpp' && this._localBelowFloor();

        const desc = document.createElement('p');
        desc.className = 'settings-section-desc';
        desc.textContent = belowFloor
            ? `Running a model well takes 32 GB of memory or more, and this Mac has ${totalRam} GB — so none is offered here. Anjadhe Cloud, a server you own, or your own API key (in the list on the left) are the ways to run the AI on a Mac this size.`
            : `These models run on this Mac, free, and your data stays here. Best picks first, sized to fit this Mac's ${totalRam} GB of memory.`;
        body.appendChild(desc);

        let selectedName = null;
        let addBtn = null;
        const list = document.createElement('div');
        list.className = 'settings-model-list settings-add-model-list';

        // Catalog rows + any installed models the catalog doesn't know
        // (GGUF drop-ins, custom pulls) so they can become entries too.
        const catalogNames = new Set(catalog.map(m => m.name));
        const extras = [...installedSet].filter(n => !catalogNames.has(n)).map(name => ({
            name,
            desc: engine === 'llamacpp' ? 'GGUF file in ~/.anjadhe_llamacpp/models' : 'Installed model',
            size: ''
        }));
        for (const m of [...catalog, ...extras]) {
            const item = document.createElement('div');
            item.className = 'settings-model-item ' + (installedSet.has(m.name) ? 'installed' : 'not-installed');
            const radio = document.createElement('span');
            radio.className = 'settings-model-radio';
            const info = document.createElement('div');
            info.className = 'settings-model-info';
            const nameEl = document.createElement('span');
            nameEl.className = 'settings-model-name';
            nameEl.textContent = m.name;
            const descEl = document.createElement('span');
            descEl.className = 'settings-model-desc';
            descEl.textContent = m.desc || '';
            info.append(nameEl, descEl);
            if (m.gguf && m.gguf.mmproj) {
                const vis = document.createElement('span');
                vis.className = 'settings-model-vision';
                vis.textContent = 'Reads images';
                vis.title = 'A regular chat model that can also read attached images';
                info.appendChild(vis);
            }
            if (m.license) {
                const lic = document.createElement('a');
                lic.href = '#';
                lic.className = 'settings-model-license';
                lic.textContent = m.license;
                lic.title = 'View license';
                lic.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (m.licenseUrl) window.electronAuth?.openExternal?.(m.licenseUrl);
                });
                info.appendChild(lic);
            }
            if (m.released) {
                const rel = document.createElement('span');
                rel.className = 'settings-model-released';
                rel.textContent = `Released ${this._formatReleased(m.released)}`;
                rel.title = 'When the provider published this model';
                info.appendChild(rel);
            }
            const statusEl = document.createElement('span');
            statusEl.className = 'settings-model-status';
            statusEl.textContent = inList.has(m.name) ? 'In your list'
                : installedSet.has(m.name) ? 'Downloaded' : (m.size || '');
            item.append(radio, info, statusEl);
            item.addEventListener('click', () => {
                list.querySelectorAll('.settings-model-item.active').forEach(el => el.classList.remove('active'));
                item.classList.add('active');
                selectedName = m.name;
                if (addBtn) addBtn.disabled = false;
            });
            list.appendChild(item);
        }
        if (!catalog.length && !extras.length && !belowFloor) {
            const none = document.createElement('p');
            none.className = 'settings-hint';
            none.textContent = 'No recommended models for this engine yet.';
            list.appendChild(none);
        }
        body.appendChild(list);

        // GGUF drop-in hint for models outside the catalog.
        const nameInput = null;
        const hint = document.createElement('p');
        hint.className = 'settings-hint';
        hint.innerHTML = 'To use a model that isn&rsquo;t listed, drop any <code>.gguf</code> file into <code>~/.anjadhe_llamacpp/models</code> and come back to this page.';
        body.appendChild(hint);

        const license = document.createElement('p');
        license.className = 'settings-hint';
        license.textContent = 'Each model has its own license (shown above). Downloading one means accepting its terms.';
        body.appendChild(license);

        const footer = document.createElement('div');
        footer.className = 'settings-input-row settings-add-model-footer';
        addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'primary-btn';
        addBtn.textContent = 'Add model';
        addBtn.disabled = true;
        addBtn.addEventListener('click', () => {
            const model = selectedName || (nameInput && nameInput.value.trim());
            if (!model) return;
            this._finishAddModel(ctx, { engine, model });
        });
        footer.appendChild(addBtn);
        body.appendChild(footer);
    },

    _renderAddServerStep(body, ctx) {
        body.innerHTML = '';

        const desc = document.createElement('p');
        desc.className = 'settings-section-desc';
        desc.innerHTML = 'Any endpoint that speaks the OpenAI <code>/v1/chat/completions</code> API on a computer you own. Auto-detect finds one running on this Mac.';
        body.appendChild(desc);

        const urlRow = document.createElement('div');
        urlRow.className = 'settings-input-row';
        urlRow.style.marginBottom = 'var(--space-md)';
        const urlInput = document.createElement('input');
        urlInput.type = 'text';
        urlInput.className = 'settings-input';
        urlInput.placeholder = 'http://your-server:8080/v1';
        urlRow.appendChild(urlInput);
        body.appendChild(urlRow);

        const modelRow = document.createElement('div');
        modelRow.className = 'settings-input-row';
        modelRow.style.marginBottom = 'var(--space-md)';
        const modelInput = document.createElement('input');
        modelInput.type = 'text';
        modelInput.className = 'settings-input';
        modelInput.placeholder = 'Model name on the server, e.g. qwen3.6:35b';
        modelRow.appendChild(modelInput);
        body.appendChild(modelRow);

        const keyRow = document.createElement('div');
        keyRow.className = 'settings-input-row';
        const keyInput = document.createElement('input');
        keyInput.type = 'password';
        keyInput.className = 'settings-input';
        keyInput.placeholder = 'API key (optional)';
        const detectBtn = document.createElement('button');
        detectBtn.type = 'button';
        detectBtn.className = 'secondary-btn';
        detectBtn.textContent = 'Auto-detect';
        const testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.className = 'secondary-btn';
        testBtn.textContent = 'Test';
        keyRow.append(keyInput, detectBtn, testBtn);
        body.appendChild(keyRow);

        const status = document.createElement('p');
        status.className = 'settings-key-status';
        body.appendChild(status);

        detectBtn.addEventListener('click', async () => {
            status.textContent = 'Scanning localhost (8080, 1234, 8000…)…';
            const res = await window.electronLLM?.detectCustom?.();
            if (res?.found) {
                urlInput.value = res.baseUrl;
                if (res.model && !modelInput.value.trim()) modelInput.value = res.model;
                status.textContent = `Found a server at ${res.baseUrl}${res.model ? ` (serving: ${res.model})` : ''}.`;
            } else {
                status.textContent = 'No local OpenAI-compatible server found on common ports (8080, 1234, 8000, 5000, 8081).';
            }
        });
        testBtn.addEventListener('click', async () => {
            const baseUrl = urlInput.value.trim();
            if (!baseUrl) { status.textContent = 'Enter a server URL first.'; return; }
            status.textContent = 'Testing…';
            const cfg = { baseUrl, model: modelInput.value.trim() };
            const key = keyInput.value.trim();
            if (key) cfg.apiKey = key;
            const res = await window.electronLLM?.testCustom?.(cfg);
            status.textContent = res?.ok
                ? `✓ Connected${res.model ? ` (${res.model})` : ''}`
                : `✗ ${res?.error || 'Connection failed'}`;
        });

        const footer = document.createElement('div');
        footer.className = 'settings-input-row settings-add-model-footer';
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'primary-btn';
        addBtn.textContent = 'Add model';
        addBtn.addEventListener('click', () => {
            const baseUrl = urlInput.value.trim();
            const model = modelInput.value.trim();
            if (!baseUrl || !model) {
                UIUtils.showToast('Enter the server URL and model name', 'error');
                return;
            }
            this._finishAddModel(ctx, { engine: 'server', model, baseUrl, key: keyInput.value.trim() });
        });
        footer.appendChild(addBtn);
        body.appendChild(footer);
    },

    /**
     * Add-model step for a cloud provider (OpenAI / Anthropic API): paste a
     * key, list the models the key can use live (no hardcoded catalog to
     * rot), pick one or type an id, optional test, add. The key is saved
     * onto the new entry (encrypted in main) by _finishAddModel.
     */
    _renderAddCloudStep(body, ctx, engine) {
        body.innerHTML = '';
        const label = engine === 'openai' ? 'OpenAI' : 'Anthropic';
        const keysUrl = engine === 'openai'
            ? 'https://platform.openai.com/api-keys'
            : 'https://console.anthropic.com/settings/keys';

        const desc = document.createElement('p');
        desc.className = 'settings-section-desc';
        desc.textContent = `${label}'s official API with your own key. Anything that runs on this model — chats, email insights, builds — is sent to ${label}'s servers under your account, and API usage is billed by ${label}.`;
        body.appendChild(desc);

        const keyRow = document.createElement('div');
        keyRow.className = 'settings-input-row';
        keyRow.style.marginBottom = 'var(--space-md)';
        const keyInput = document.createElement('input');
        keyInput.type = 'password';
        keyInput.className = 'settings-input';
        keyInput.placeholder = `${label} API key`;
        const loadBtn = document.createElement('button');
        loadBtn.type = 'button';
        loadBtn.className = 'secondary-btn';
        loadBtn.textContent = 'List models';
        keyRow.append(keyInput, loadBtn);
        body.appendChild(keyRow);

        let selectedId = null;
        let addBtn = null;
        let testBtn = null;
        const list = document.createElement('div');
        list.className = 'settings-model-list settings-add-model-list';
        body.appendChild(list);

        const modelRow = document.createElement('div');
        modelRow.className = 'settings-input-row';
        modelRow.style.marginTop = 'var(--space-md)';
        const modelInput = document.createElement('input');
        modelInput.type = 'text';
        modelInput.className = 'settings-input';
        modelInput.placeholder = engine === 'openai'
            ? 'Or type a model id, e.g. gpt-5.2'
            : 'Or type a model id, e.g. claude-opus-4-8';
        modelInput.addEventListener('input', () => {
            if (modelInput.value.trim()) {
                list.querySelectorAll('.settings-model-item.active').forEach(el => el.classList.remove('active'));
                selectedId = null;
            }
            const has = !!(selectedId || modelInput.value.trim());
            if (addBtn) addBtn.disabled = !has;
            if (testBtn) testBtn.disabled = !has;
        });
        modelRow.appendChild(modelInput);
        body.appendChild(modelRow);

        const status = document.createElement('p');
        status.className = 'settings-key-status';
        body.appendChild(status);

        const hint = document.createElement('p');
        hint.className = 'settings-hint';
        hint.innerHTML = `The key is stored encrypted on this Mac, per model — it never syncs. Create a key at <a href="#" class="settings-model-license">${keysUrl.replace('https://', '')}</a>.`;
        hint.querySelector('a').addEventListener('click', (e) => {
            e.preventDefault();
            window.electronAuth?.openExternal?.(keysUrl);
        });
        body.appendChild(hint);

        loadBtn.addEventListener('click', async () => {
            const apiKey = keyInput.value.trim();
            if (!apiKey) { status.textContent = 'Paste your API key first.'; return; }
            status.textContent = `Fetching models from ${label}…`;
            const res = await window.electronLLM?.cloudModels?.({ engine, apiKey });
            list.innerHTML = '';
            if (!res?.models?.length) {
                status.textContent = `✗ ${res?.error || 'Could not list models'}`;
                return;
            }
            status.textContent = `Your key can use ${res.models.length} models — pick one.`;
            for (const m of res.models) {
                const item = document.createElement('div');
                item.className = 'settings-model-item';
                const radio = document.createElement('span');
                radio.className = 'settings-model-radio';
                const info = document.createElement('div');
                info.className = 'settings-model-info';
                const nameEl = document.createElement('span');
                nameEl.className = 'settings-model-name';
                nameEl.textContent = m.label && m.label !== m.id ? m.label : m.id;
                info.appendChild(nameEl);
                if (m.label && m.label !== m.id) {
                    const descEl = document.createElement('span');
                    descEl.className = 'settings-model-desc';
                    descEl.textContent = m.id;
                    info.appendChild(descEl);
                }
                item.append(radio, info);
                item.addEventListener('click', () => {
                    list.querySelectorAll('.settings-model-item.active').forEach(el => el.classList.remove('active'));
                    item.classList.add('active');
                    selectedId = m.id;
                    modelInput.value = '';
                    if (addBtn) addBtn.disabled = false;
                    if (testBtn) testBtn.disabled = false;
                });
                list.appendChild(item);
            }
        });

        const footer = document.createElement('div');
        footer.className = 'settings-input-row settings-add-model-footer';
        testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.className = 'secondary-btn';
        testBtn.textContent = 'Test';
        testBtn.disabled = true;
        testBtn.addEventListener('click', async () => {
            const model = selectedId || modelInput.value.trim();
            const apiKey = keyInput.value.trim();
            if (!apiKey) { status.textContent = 'Paste your API key first.'; return; }
            status.textContent = 'Testing…';
            const res = await window.electronLLM?.testCloud?.({ engine, model, apiKey });
            status.textContent = res?.ok
                ? `✓ Connected${res.model ? ` (${res.model})` : ''}`
                : `✗ ${res?.error || 'Connection failed'}`;
        });
        addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'primary-btn';
        addBtn.textContent = 'Add model';
        addBtn.disabled = true;
        addBtn.addEventListener('click', () => {
            const model = selectedId || modelInput.value.trim();
            const key = keyInput.value.trim();
            if (!model) { UIUtils.showToast('Pick or type a model id', 'error'); return; }
            if (!key) { UIUtils.showToast(`Paste your ${label} API key`, 'error'); return; }
            this._finishAddModel(ctx, { engine, model, key });
        });
        footer.append(testBtn, addBtn);
        body.appendChild(footer);
    },

    // ── Library status watch ──
    //
    // A light polling loop that keeps the status texts honest (warming →
    // ready, llama-server loading a model, engine installed outside the app).
    // Text-only repaints; a structural change (e.g. a model appeared on
    // disk) triggers one full re-render — skipped while the user is typing
    // in a card, so it can't eat their input.

    _startLibraryWatch() {
        this._stopLibraryWatch();
        const tick = async () => {
            const view = document.getElementById('llm-settings-view');
            if (!view || !view.classList.contains('active')) { this._stopLibraryWatch(); return; }
            try {
                await this._refreshEngineState();
                this._refreshCardStatuses();
            } catch { /* next tick */ }
            const busy = (typeof AgentService !== 'undefined' && AgentService._warming) || this._activeDownloads.size > 0;
            this._libraryWatchTimer = setTimeout(tick, busy ? 2500 : 8000);
        };
        this._libraryWatchTimer = setTimeout(tick, 2500);
    },

    _stopLibraryWatch() {
        if (this._libraryWatchTimer) clearTimeout(this._libraryWatchTimer);
        this._libraryWatchTimer = null;
    },

    _refreshCardStatuses() {
        const cardsHost = document.getElementById('settings-model-cards');
        if (!cardsHost) return;
        const typing = cardsHost.contains(document.activeElement)
            && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName || '');
        let structuralChange = false;
        cardsHost.querySelectorAll('.settings-model-card').forEach(card => {
            const entry = AgentService.getEntry(card.dataset.entryId);
            if (!entry) { structuralChange = true; return; }
            if (this._activeDownloads.has(entry.id)) return; // download owns the card
            const st = this._computeEntryStatus(entry);
            if (st.state !== card.dataset.state) { structuralChange = true; return; }
            const statusEl = card.querySelector('.settings-model-card-status');
            if (statusEl && statusEl.textContent !== st.text) statusEl.textContent = st.text;
        });
        if (structuralChange && !typing) this._renderModelLibrary();
    },

    // ─────────────────── Web-search providers page ───────────────────
    //
    // The Add Model page's design (2026-08-05, shared add-model-* classes):
    // masthead with the master switch, a providers nav grouped by where
    // queries go (Included / Your own key), and a detail pane holding the
    // key + Save/Test, signup link and the active-provider action. The
    // registry is fixed in main.js — no add flow. All controls are
    // closures over the provider id.

    // The provider being VIEWED in the pane (not necessarily active).
    _searchSel: null,

    // Renderer-side extras for each provider; labels + key state come from
    // main (search-get-status), which owns the registry. group/navHint feed
    // the sources nav (where queries go — the add-model nav's job), desc is
    // the pane's opening paragraph.
    _searchProviderMeta: {
        anjadhe: {
            group: 'Included',
            navHint: 'No key — via Anjadhe, without your identity'
        },
        // signupText is honest-copy per provider: Tavily's free plan needs no
        // card; Brave requires one and bills past its monthly credit.
        tavily: {
            group: 'Your own key',
            navHint: 'Straight to Tavily — free plan, no card',
            desc: 'Tavily’s search API with your own key. Queries go directly to Tavily under your account; the free plan needs no credit card.',
            placeholder: 'tvly-...', signupUrl: 'https://tavily.com/', signupLabel: 'tavily.com', signupText: 'Get a free key (no credit card) at '
        },
        brave: {
            group: 'Your own key',
            navHint: 'Straight to Brave — card required',
            desc: 'Brave Search’s API with your own key. Queries go directly to Brave under your account; a key requires a credit card, and use past the monthly credit is billed by Brave.',
            placeholder: 'BSA...', signupUrl: 'https://api.search.brave.com/app/keys', signupLabel: 'api.search.brave.com', signupText: 'Get a key (credit card required) at '
        }
    },

    // Terminal access (C7.3): toggle + one-click command install (a launcher
    // that runs the CLI with the app's own binary as its Node runtime — the
    // user needs no Node.js).
    async _renderCliCard() {
        const toggle = document.getElementById('settings-cli-enabled');
        if (!toggle || !window.electronCLI) return;
        let st = null;
        try { st = await window.electronCLI.status(); } catch { return; }
        const hint = document.getElementById('settings-cli-hint');
        const row = document.getElementById('settings-cli-install-row');
        const installHint = document.getElementById('settings-cli-install-hint');
        const installBtn = document.getElementById('settings-cli-install-btn');
        toggle.checked = !!st.enabled;
        if (hint) {
            hint.textContent = st.enabled
                ? `On — listening on 127.0.0.1:${st.port} (this Mac only). Run anjadhe in a terminal for a session.`
                : 'Off — nothing is listening.';
        }
        if (row) row.hidden = !st.enabled;
        const removeBtn = document.getElementById('settings-cli-remove-btn');
        if (installHint && installBtn) {
            if (st.installedAt) {
                installHint.textContent = `Installed at ${st.installedAt}. Open a terminal and run: anjadhe`;
                installBtn.textContent = 'Reinstall';
            } else {
                installHint.textContent = 'One click puts the anjadhe command on your PATH — no other software needed. (If you ever delete Anjadhe itself, the command notices and removes itself on its next run.)';
                installBtn.textContent = 'Install command';
            }
            if (removeBtn) {
                removeBtn.hidden = !st.installedAt;
                removeBtn.onclick = async () => {
                    const res = await window.electronCLI.uninstallCommand();
                    if (res && res.error) UIUtils.showToast(res.error, 'error');
                    else UIUtils.showToast('Command removed', 'success');
                    this._renderCliCard();
                };
            }
            installBtn.onclick = async () => {
                const res = await window.electronCLI.installCommand();
                if (res && res.error) {
                    UIUtils.showToast(res.error, 'error');
                } else {
                    UIUtils.showToast(`Installed: ${res.installedAt}`, 'success');
                    if (res.pathHint) UIUtils.showToast(res.pathHint, 'error');
                }
                this._renderCliCard();
            };
        }
        toggle.onchange = async () => {
            const res = await window.electronCLI.setEnabled(toggle.checked);
            if (res && res.error) {
                UIUtils.showToast(res.error, 'error');
                toggle.checked = !toggle.checked;
            } else {
                UIUtils.showToast(toggle.checked ? 'Terminal access on' : 'Terminal access off', 'success');
            }
            this._renderCliCard();
        };
    },

    async _renderSearchProviders() {
        const layout = document.getElementById('settings-search-layout');
        if (!layout || !window.electronSearch) return;
        let status = null;
        try { status = await window.electronSearch.getStatus(); } catch { return; }
        // Master switch: the providers layout (and the key hint) only shows
        // when web search is on — off means no feature sends queries
        // anywhere, so there is nothing to configure. `.onchange` (not
        // addEventListener) because this render runs repeatedly.
        const enabled = status.enabled !== false;
        const toggle = document.getElementById('settings-search-enabled');
        if (toggle) {
            toggle.checked = enabled;
            toggle.onchange = async () => {
                await window.electronSearch.setEnabled?.(toggle.checked);
                UIUtils.showToast(toggle.checked ? 'Web search on' : 'Web search off — nothing will query the web', 'success');
                this._renderSearchProviders();
            };
        }
        const keysHint = document.getElementById('settings-search-keys-hint');
        if (keysHint) keysHint.hidden = !enabled;
        const offHint = document.getElementById('settings-search-off-hint');
        if (offHint) offHint.hidden = enabled;
        layout.hidden = !enabled;
        if (!enabled) return;
        const ids = Object.keys(status.providers || {});
        if (!ids.length) { layout.hidden = true; return; }
        if (!this._searchSel || !ids.includes(this._searchSel)) {
            this._searchSel = (status.provider && ids.includes(status.provider)) ? status.provider : ids[0];
        }
        this._renderSearchNav(status);
        this._renderSearchPane(status);
    },

    _renderSearchNav(status) {
        const nav = document.getElementById('settings-search-nav');
        if (!nav) return;
        nav.innerHTML = '';
        let lastGroup = null;
        for (const id of Object.keys(status.providers)) {
            const info = status.providers[id];
            const meta = this._searchProviderMeta[id] || {};
            const group = meta.group || (info.builtin ? 'Included' : 'Your own key');
            if (group !== lastGroup) {
                const label = document.createElement('div');
                label.className = 'add-model-nav-label';
                label.textContent = group;
                nav.appendChild(label);
                lastGroup = group;
            }
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'add-model-src' + (id === this._searchSel ? ' is-active' : '');
            const name = document.createElement('span');
            name.className = 'add-model-src-name';
            name.textContent = info.label;
            if (id === status.provider) {
                const badge = document.createElement('span');
                badge.className = 'add-model-src-badge';
                badge.textContent = 'Active';
                badge.title = 'Web searches go to this provider';
                name.appendChild(badge);
            }
            const hint = document.createElement('span');
            hint.className = 'add-model-src-hint';
            hint.textContent = meta.navHint || (info.builtin ? 'Included with Anjadhe' : 'Your own key');
            btn.append(name, hint);
            btn.addEventListener('click', () => {
                this._searchSel = id;
                this._renderSearchNav(status);
                this._renderSearchPane(status);
            });
            nav.appendChild(btn);
        }
    },

    _renderSearchPane(status) {
        const id = this._searchSel;
        const info = status.providers[id];
        const title = document.getElementById('settings-search-pane-title');
        const body = document.getElementById('settings-search-pane-body');
        if (!info || !body) return;
        if (title) title.textContent = info.label;
        body.innerHTML = '';

        if (info.builtin) {
            this._renderConnectManage(body, id, info);
        } else {
            const meta = this._searchProviderMeta[id] || {};
            const desc = document.createElement('p');
            desc.className = 'settings-section-desc';
            desc.textContent = meta.desc
                || `${info.label}’s search API with your own key. Queries go directly to ${info.label} under your account.`;
            body.appendChild(desc);
            this._renderSearchKeyManage(body, id, info);
        }

        // Active state / the way to make it so — the add-model footer shape.
        // The active line sits right under the description (the "already
        // added" slot on the Add Model page), not below the controls.
        if (id === status.provider) {
            const active = document.createElement('p');
            active.className = 'settings-key-status';
            active.textContent = `✓ Active — web searches go to ${info.label}.`;
            body.insertBefore(active, body.children[1] || null);
        } else {
            const footer = document.createElement('div');
            footer.className = 'settings-input-row settings-add-model-footer';
            const useBtn = document.createElement('button');
            useBtn.type = 'button';
            useBtn.className = 'primary-btn';
            useBtn.textContent = 'Use for web searches';
            useBtn.addEventListener('click', async () => {
                await window.electronSearch.setProvider(id);
                UIUtils.showToast(`Search provider: ${info.label}`, 'success');
                this._renderSearchProviders();
            });
            footer.appendChild(useBtn);
            body.appendChild(footer);
        }
    },

    _renderSearchKeyManage(body, id, info) {
        const meta = this._searchProviderMeta[id] || {};

        const keyRow = document.createElement('div');
        keyRow.className = 'settings-input-row';
        const keyInput = document.createElement('input');
        keyInput.type = 'password';
        keyInput.className = 'settings-input';
        keyInput.placeholder = info.hasKey ? '••••••••••••••••' : (meta.placeholder || 'API key');
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'secondary-btn';
        saveBtn.textContent = 'Save Key';
        const testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.className = 'secondary-btn';
        testBtn.textContent = 'Test';
        keyRow.append(keyInput, saveBtn, testBtn);
        body.appendChild(keyRow);

        const status = document.createElement('p');
        status.className = 'settings-key-status';
        status.textContent = info.hasKey ? 'API key saved' : 'No API key configured';
        body.appendChild(status);

        if (meta.signupUrl) {
            const hint = document.createElement('p');
            hint.className = 'settings-hint';
            hint.textContent = meta.signupText || 'Get a key at ';
            const link = document.createElement('a');
            link.href = '#';
            link.style.color = 'var(--color-text-secondary)';
            link.textContent = meta.signupLabel || meta.signupUrl;
            link.addEventListener('click', (e) => {
                e.preventDefault();
                window.electronAuth.openExternal(meta.signupUrl);
            });
            hint.appendChild(link);
            hint.appendChild(document.createTextNode('.'));
            body.appendChild(hint);
        }

        this._buildSearchParallelRow(body, id, info);

        saveBtn.addEventListener('click', async () => {
            const key = keyInput.value.trim();
            await window.electronSearch.setApiKey(id, key);
            info.hasKey = !!key;
            if (key) {
                keyInput.value = '';
                keyInput.placeholder = '••••••••••••••••';
                status.textContent = 'API key saved';
                UIUtils.showToast(`${info.label} API key saved`, 'success');
            } else {
                // An empty save deliberately removes the stored key.
                keyInput.placeholder = meta.placeholder || 'API key';
                status.textContent = 'API key removed';
            }
        });

        testBtn.addEventListener('click', async () => {
            status.textContent = 'Testing…';
            const res = await window.electronSearch.test?.(id);
            if (res?.ok) {
                status.textContent = `✓ Connected — ${info.label} answered a test query`;
                UIUtils.showToast(`${info.label} reachable`, 'success');
            } else {
                status.textContent = `✗ ${res?.error || 'Test failed'}`;
                UIUtils.showToast('Search test failed', 'error');
            }
        });
    },

    // Parallel searches — how many requests this provider may have in
    // flight at once. 1 (default) keeps the app-wide serial queue with
    // 1s spacing; raising it is for paid plans that allow concurrency.
    _buildSearchParallelRow(body, id, info) {
        const parRow = document.createElement('div');
        parRow.className = 'settings-toggle-row';
        const parLabel = document.createElement('label');
        parLabel.className = 'settings-toggle-label';
        parLabel.textContent = 'Parallel searches';
        const parSel = document.createElement('select');
        parSel.className = 'settings-select settings-inline-select';
        for (const [value, label] of [
            [1, 'Off — one at a time (default)'],
            [2, '2 at once'], [3, '3 at once'], [4, '4 at once'],
            [6, '6 at once'], [8, '8 at once']
        ]) {
            const opt = document.createElement('option');
            opt.value = String(value);
            opt.textContent = label;
            parSel.appendChild(opt);
        }
        parSel.value = String(info.concurrency || 1);
        if (![...parSel.options].some(o => o.value === parSel.value)) parSel.value = '1';
        parSel.addEventListener('change', async () => {
            const n = Number(parSel.value) || 1;
            await window.electronSearch.setConcurrency?.(id, n);
            info.concurrency = n;
        });
        parRow.append(parLabel, parSel);
        body.appendChild(parRow);
        const parHint = document.createElement('p');
        parHint.className = 'settings-hint';
        parHint.textContent = 'When the assistant fires several searches at once, this is how many actually run in parallel. Most free plans allow only about one request per second — leave this off unless your plan supports more, or searches start failing with rate-limit errors.';
        body.appendChild(parHint);
    },

    // Anjadhe Connect card body: plan + usage instead of a key field. The
    // per-machine key mints automatically on the first search or an explicit
    // Test — nothing to paste. Merely opening this card never mints one
    // (web access is opt-in; browsing Settings isn't consent). Copy follows
    // docs/POSITIONING.md honest-copy rules: say where searches go, present
    // tense, no promises.
    _renderConnectManage(body, id, info) {
        // Description first — on the search page this is the pane's opening
        // paragraph, the same slot the key providers' desc fills.
        const hint = document.createElement('p');
        hint.className = 'settings-section-desc';
        hint.textContent = 'Included with Anjadhe — no signup, no key. Searches route through Anjadhe’s server (api.anjadhe.com), which forwards them to a search provider without your identity and doesn’t log what you search. Prefer to keep Anjadhe out of the loop? Use your own key with one of the other providers.';
        body.appendChild(hint);

        const status = document.createElement('p');
        status.className = 'settings-key-status';
        status.textContent = 'Checking plan…';
        body.appendChild(status);

        const testRow = document.createElement('div');
        testRow.className = 'settings-input-row';
        const testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.className = 'secondary-btn';
        testBtn.textContent = 'Test';
        testRow.appendChild(testBtn);
        body.appendChild(testRow);

        // Anonymous install id (the SHA-256 hash the server stores — the raw
        // id never leaves this Mac's settings). Shown so a plan upgrade can
        // name the right install; matches the Connect dashboard's id column.
        const idRow = document.createElement('p');
        idRow.className = 'settings-hint';
        idRow.hidden = true;
        body.appendChild(idRow);

        this._buildSearchParallelRow(body, id, info);

        const refreshUsage = async () => {
            const u = await window.electronSearch.connectUsage?.(false);
            if (!u || u.error) {
                status.textContent = `Can’t reach Anjadhe Connect${u?.error ? ` — ${u.error}` : ''}`;
                return;
            }
            if (u.notProvisioned) { status.textContent = 'Not set up yet — the key mints itself on the first search, or press Test'; return; }
            const tier = String(u.tier || 'free');
            const plan = tier.charAt(0).toUpperCase() + tier.slice(1);
            status.textContent = `${plan} plan — ${u.used} of ${u.quota} searches used this month · resets ${u.resetsAt}`;
            if (u.installIdHash) {
                idRow.hidden = false;
                idRow.innerHTML = '';
                idRow.append('Install id (anonymous): ');
                const code = document.createElement('code');
                code.textContent = `${u.installIdHash.slice(0, 12)}…`;
                code.title = 'Click to copy the full id';
                code.style.cursor = 'pointer';
                code.addEventListener('click', () => {
                    navigator.clipboard.writeText(u.installIdHash);
                    UIUtils.showToast('Install id copied', 'success');
                });
                idRow.appendChild(code);
            }
        };
        refreshUsage();

        testBtn.addEventListener('click', async () => {
            status.textContent = 'Testing…';
            const res = await window.electronSearch.test?.(id);
            if (res?.ok) {
                UIUtils.showToast('Anjadhe Connect reachable', 'success');
                refreshUsage();
            } else {
                status.textContent = `✗ ${res?.error || 'Test failed'}`;
                UIUtils.showToast('Search test failed', 'error');
            }
        });
    },

    // Keep the three summary badges on the AI Assistant page in sync without
    // building the full lists. Each renderer also updates its own badge when
    // invoked from inside its sub-view.
    _refreshAssistantBadges() {
        const logsBadge = document.getElementById('settings-logs-count');
        if (logsBadge) logsBadge.textContent = (LLMLogger.logs?.length || 0);
        const searchBadge = document.getElementById('settings-search-logs-count');
        if (searchBadge && typeof SearchLogger !== 'undefined') {
            searchBadge.textContent = (SearchLogger.logs?.length || 0);
        }
        const memBadge = document.getElementById('settings-memories-count');
        if (memBadge && typeof MemoryManager !== 'undefined' && MemoryManager.listSections) {
            try { memBadge.textContent = MemoryManager.listSections().filter(s => (s.body || '').trim()).length; } catch {}
        }
    },

    async openMemoriesSettings() {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('memories-settings-view').classList.add('active');
        Breadcrumb.render('memories-settings-breadcrumb', [
            { label: 'Settings', action: () => { document.getElementById('memories-settings-view').classList.remove('active'); document.getElementById('settings-view').classList.add('active'); this._loadLLMSummary(); } },
            { label: 'AI Assistant', action: () => this.openLLMSettings() },
            { label: 'Memories' }
        ]);
        this._ensureLlmBindings();
        this._renderMemories();
    },

    async openLlmLogs() {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('llm-logs-view').classList.add('active');
        Breadcrumb.render('llm-logs-breadcrumb', [
            { label: 'Settings', action: () => { document.getElementById('llm-logs-view').classList.remove('active'); document.getElementById('settings-view').classList.add('active'); this._loadLLMSummary(); } },
            { label: 'AI Assistant', action: () => this.openLLMSettings() },
            { label: 'LLM Logs' }
        ]);
        this._ensureLlmBindings();
        this.renderLogs();
    },

    async openSearchLogs() {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('search-logs-view').classList.add('active');
        Breadcrumb.render('search-logs-breadcrumb', [
            { label: 'Settings', action: () => { document.getElementById('search-logs-view').classList.remove('active'); document.getElementById('settings-view').classList.add('active'); this._loadLLMSummary(); } },
            { label: 'AI Assistant', action: () => this.openLLMSettings() },
            { label: 'Web Search Logs' }
        ]);
        this._ensureLlmBindings();
        this.renderSearchLogs();
    },

    async openNetworkLogs() {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('network-logs-view').classList.add('active');
        Breadcrumb.render('network-logs-breadcrumb', [
            { label: 'Settings', action: () => { document.getElementById('network-logs-view').classList.remove('active'); document.getElementById('settings-view').classList.add('active'); this.render(); } },
            { label: 'Network Logs' }
        ]);
        this.renderNetworkLogs();
    },

    // One-time event wiring for every control inside the two split sub-views.
    // Kept as a single block because many controls historically lived together;
    // splitting them by view adds only friction — the IDs are unique globally
    // regardless of which sub-view they landed in after the split.
    _attachLlmBindings() {
        // Model library: the guided add-model wizard. Everything else on a
        // card (Manage, downloads, default radio) binds per-card at render
        // time — no global ids.
        this._bindBtn('settings-add-model-btn', () => this._openAddModelPage());

        // Web-search provider cards bind per-card at render time
        // (_renderSearchProviders) — no global ids here.

        // LLM Logs
        this._bindBtn('settings-logs-refresh-btn', () => this.renderLogs());
        this._bindBtn('settings-logs-clear-btn', () => {
            LLMLogger.clear();
            this.renderLogs();
            UIUtils.showToast('LLM logs cleared', 'success');
        });
        document.getElementById('settings-logs-search')
            ?.addEventListener('input', () => this.renderLogs());

        // Web Search Logs
        this._bindBtn('settings-search-logs-refresh-btn', () => this.renderSearchLogs());
        this._bindBtn('settings-search-logs-clear-btn', () => {
            SearchLogger.clear();
            this.renderSearchLogs();
            UIUtils.showToast('Search logs cleared', 'success');
        });
        document.getElementById('settings-search-logs-search')
            ?.addEventListener('input', () => this.renderSearchLogs());

        // Memories
        this._bindMemoryEvents();
    },

    // Engine status (running / installed / not installed) with the inline
    // Install action, rendered INTO the given host element — one per open
    // Manage body, no global ids. llama.cpp has no daemon to "start":
    // llama-server spawns lazily on the first chat, so installed-but-idle
    // is a healthy state, not a problem to fix.
    async _renderEngineStatusInto(host) {
        host.innerHTML = '';
        const line = document.createElement('div');
        line.className = 'settings-ollama-status';
        const extra = document.createElement('div');
        extra.className = 'settings-ollama-version';
        host.append(line, extra);
        const dot = (active) => `<span class="ollama-status-dot${active ? ' active' : ''}"></span> `;
        const hint = (text) => { extra.innerHTML = `<span class="settings-hint">${UIUtils.escapeHtml(text)}</span>`; };
        try {
            const status = await window.electronLlamaCpp?.status?.();
            if (!status) return;
            if (status.isReady) {
                line.innerHTML = dot(true) + `llama.cpp running on port ${status.port}${status.loadedModel ? ` (${UIUtils.escapeHtml(status.loadedModel)})` : ''}`;
                if (status.version) hint(`llama.cpp build ${status.version}`);
            } else if (status.isInstalled) {
                line.innerHTML = dot(false) + 'llama.cpp installed — the model loads on your first chat';
                if (status.version) hint(`llama.cpp build ${status.version}`);
            } else {
                line.innerHTML = dot(false) + 'llama.cpp engine not installed ';
                const installBtn = document.createElement('button');
                installBtn.type = 'button';
                installBtn.className = 'secondary-btn ollama-start-btn';
                installBtn.textContent = 'Install engine (~11 MB)';
                installBtn.addEventListener('click', async () => {
                    installBtn.disabled = true;
                    installBtn.textContent = 'Installing…';
                    try {
                        const result = await window.electronLlamaCpp.install((p) => {
                            if (p.phase === 'download' && p.percent != null) installBtn.textContent = `Downloading… ${p.percent}%`;
                            else if (p.message) installBtn.textContent = p.message;
                        });
                        if (result?.error) throw new Error(result.error);
                        UIUtils.showToast('llama.cpp engine installed', 'success');
                        await this._renderModelLibrary();
                    } catch (e) {
                        installBtn.disabled = false;
                        installBtn.textContent = 'Install engine (~11 MB)';
                        UIUtils.showToast(e.message || 'Engine install failed', 'error');
                    }
                });
                line.appendChild(installBtn);
            }
            if (status.isInstalled) this._renderShareControls(host, status);
        } catch { /* engine bridge unavailable */ }
    },

    // Share on local network — rebinds llama-server to 0.0.0.0 with a
    // persistent key, so another device you own (e.g. a MacBook running
    // Anjadhe with a "Your server" model entry) can use whatever model this
    // Mac has loaded. Off by default; the model then answers only this Mac.
    _renderShareControls(host, status) {
        const share = status.share || { enabled: false };

        const row = document.createElement('div');
        row.className = 'settings-toggle-row settings-share-row';
        const label = document.createElement('label');
        label.className = 'settings-toggle-label';
        label.textContent = 'Share on local network';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!share.enabled;
        input.title = 'Let devices on your network use this Mac’s model with the URL and key below';
        input.addEventListener('change', async () => {
            input.disabled = true;
            const wasLoaded = !!status.loadedModel;
            if (input.checked && wasLoaded) UIUtils.showToast('Restarting the AI server for network access…', 'info');
            const res = await window.electronLlamaCpp?.setShare?.(input.checked);
            if (!res || res.error) {
                UIUtils.showToast(res?.error || 'Could not update network sharing', 'error');
                input.checked = !input.checked;
                input.disabled = false;
                return;
            }
            UIUtils.showToast(res.share?.enabled
                ? 'This Mac’s model is now available on your local network'
                : 'Network sharing is off', 'success');
            this._renderEngineStatusInto(host);
        });
        row.append(label, input);
        host.appendChild(row);

        const hint = document.createElement('p');
        hint.className = 'settings-hint';
        host.appendChild(hint);

        if (!share.enabled) {
            hint.textContent = 'Off — the local AI server answers only this Mac. '
                + 'Turn on to use this Mac’s model from another device on your network '
                + '(add it there as a “Your server” model). Turning it on reloads the model.';
            return;
        }

        const addr = (share.addresses && share.addresses[0]) || null;
        const url = addr ? `http://${addr}:${status.port}/v1` : null;
        const copyRow = (name, value, shown) => {
            const r = document.createElement('div');
            r.className = 'settings-share-value';
            const n = document.createElement('span');
            n.className = 'settings-share-value-name';
            n.textContent = name;
            const v = document.createElement('code');
            v.textContent = shown || value;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'secondary-btn settings-share-copy';
            btn.textContent = 'Copy';
            btn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(value);
                    btn.textContent = 'Copied';
                    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
                } catch { UIUtils.showToast('Copy failed', 'error'); }
            });
            r.append(n, v, btn);
            host.appendChild(r);
        };
        if (url) copyRow('Server URL', url);
        else {
            hint.textContent = 'Sharing is on, but this Mac has no network address right now — connect to Wi-Fi or Ethernet.';
        }
        if (share.key) copyRow('API key', share.key, share.key.slice(0, 8) + '…');
        if (url) {
            hint.textContent = 'Any device on your network with this key can use the model. '
                + 'On your other Mac, add a “Your server” model with this URL and key'
                + (status.loadedModel ? ` and the model name “${status.loadedModel}”` : '')
                + '. It serves whatever model this Mac has loaded. While sharing is on, '
                + 'Anjadhe loads your default model at launch and keeps it loaded.';
        }
    },

    // ── Memories ──

    _bindMemoryEvents() {
        this._bindBtn('settings-memory-edit-btn', () => this._editMemoryProfile());
        this._bindBtn('settings-memory-cleanup-btn', () => this._cleanupMemories());
    },

    // Jump to the Assistant page and open the editable memory profile panel.
    _editMemoryProfile() {
        try {
            if (typeof AppManager !== 'undefined' && AppManager.openApp) AppManager.openApp('agent');
            setTimeout(() => {
                if (typeof AgentUI !== 'undefined' && AgentUI.openProfilePanel) AgentUI.openProfilePanel();
            }, 150);
        } catch (e) {
            console.warn('[memory] open profile editor failed:', e);
        }
    },

    // Manual trigger for the consolidation pass that also runs daily on startup
    // (AgentService.consolidateMemories). Unlike the daily run, the button uses
    // `full: true` — it processes the ENTIRE store (looping passes until it
    // converges), so one click cleans everything rather than a bounded slice.
    async _cleanupMemories() {
        const btn = document.getElementById('settings-memory-cleanup-btn');
        if (typeof AgentService === 'undefined' || typeof AgentService.consolidateMemories !== 'function') {
            UIUtils.showToast('Rebuild unavailable', 'error');
            return;
        }
        if (typeof AgentService !== 'undefined' && !AgentService.model) {
            UIUtils.showToast('No local model selected to build the summary', 'error');
            return;
        }
        if (btn) { btn.disabled = true; btn.textContent = 'Rebuilding…'; }
        // Hold the same lock the daily auto-run checks, so the background timer
        // can't kick off a second overlapping pass while this one runs.
        // _foregroundMemoryOp warns on refresh (the user is watching this run).
        AgentService._consolidating = true;
        AgentService._foregroundMemoryOp = true;
        try {
            // consolidateMemories tidies the raw log AND re-folds it into the
            // categorized profile (full mode).
            await AgentService.consolidateMemories({ full: true });
            this._renderMemories();
            this._refreshAssistantBadges();
            UIUtils.showToast('Memory pages rebuilt from your chats', 'success');
        } catch (e) {
            UIUtils.showToast('Rebuild failed', 'error');
            console.warn('[memory] manual rebuild failed:', e);
        } finally {
            AgentService._consolidating = false;
            AgentService._foregroundMemoryOp = false;
            if (btn) { btn.disabled = false; btn.textContent = 'Rebuild pages'; }
        }
    },

    // Read-only view of the memory wiki. Editing lives on the Assistant page
    // (the "Edit on Assistant page" button); here we just list each page's
    // title + one-line summary so the user can review what's stored.
    _renderMemories() {
        const listEl = document.getElementById('settings-memory-list');
        const countEl = document.getElementById('settings-memories-count');
        if (!listEl || typeof MemoryManager === 'undefined') return;

        const pages = MemoryManager.listSections();
        const filled = pages.filter(s => (s.body || '').trim());
        if (countEl) countEl.textContent = filled.length;

        if (filled.length === 0) {
            listEl.innerHTML = '<div class="settings-memory-empty">Nothing remembered yet. The assistant fills this in as you chat — or open it on the Assistant page to write your own.</div>';
            return;
        }

        listEl.innerHTML = filled.map(s => {
            const badge = s.userEdited ? '<span class="settings-memory-chip">edited by you</span>' : '';
            const summary = (s.summary || '').trim() || MemoryManager._deriveSummary(s.body);
            const updated = this._relativeTime(s.updatedAt);
            return `
                <div class="settings-memory-item">
                    <div class="settings-memory-item-header">
                        <span class="settings-memory-title">${UIUtils.escapeHtml(s.title || '')}</span>
                        ${badge}
                        ${updated ? `<span class="settings-memory-updated">${UIUtils.escapeHtml(updated)}</span>` : ''}
                    </div>
                    <div class="settings-memory-body">${UIUtils.escapeHtml(summary)}</div>
                </div>
            `;
        }).join('');
    },

    _relativeTime(iso) {
        const then = Date.parse(iso);
        if (!then) return '';
        const diff = Date.now() - then;
        const mins = Math.round(diff / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.round(mins / 60);
        if (hrs < 24) return `${hrs}h ago`;
        const days = Math.round(hrs / 24);
        if (days < 7) return `${days}d ago`;
        return new Date(iso).toLocaleDateString();
    },


    // ── Privacy / Analytics sub-view ──

    _privacySettingsBound: false,

    openPrivacySettings() {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('privacy-settings-view').classList.add('active');
        Breadcrumb.render('privacy-settings-breadcrumb', [
            { label: 'Settings', action: () => { document.getElementById('privacy-settings-view').classList.remove('active'); document.getElementById('settings-view').classList.add('active'); this.render(); } },
            { label: 'Privacy' }
        ]);

        this._renderPrivacySettings();

        if (!this._privacySettingsBound) {
            this._privacySettingsBound = true;

            this._bindChange('settings-analytics-toggle', (checked) => {
                if (typeof AnalyticsManager === 'undefined') return;
                AnalyticsManager.setEnabled(!!checked);
                UIUtils.showToast(checked ? 'Analytics enabled' : 'Analytics disabled', 'info');
                this._renderPrivacySettings();
            }, true);

            this._bindBtn('settings-analytics-refresh-btn', () => {
                this._renderPrivacySettings();
            });

            this._bindBtn('settings-analytics-send-btn', async () => {
                if (typeof AnalyticsManager === 'undefined') return;
                if (!AnalyticsManager.isEnabled()) {
                    UIUtils.showToast('Enable analytics first', 'info');
                    return;
                }
                UIUtils.showToast('Sending…', 'info');
                const result = await AnalyticsManager.uploadIfDue({ force: true });
                if (result && result.uploaded) {
                    UIUtils.showToast(`Sent ${result.uploaded} event${result.uploaded === 1 ? '' : 's'}`, 'success');
                } else if (result && result.skipped === 'empty') {
                    UIUtils.showToast('No events to send', 'info');
                } else if (result && result.error) {
                    UIUtils.showToast(`Send failed: ${result.error}`, 'error');
                } else {
                    UIUtils.showToast('Send complete', 'info');
                }
                this._renderPrivacySettings();
            });

            this._bindBtn('settings-analytics-clear-btn', async () => {
                if (typeof AnalyticsManager === 'undefined') return;
                const confirmed = await UIUtils.confirm(
                    'Clear recorded events?',
                    'The local event log will be emptied. Your install ID and opt-in preference are kept.',
                    ''
                );
                if (!confirmed) return;
                AnalyticsManager.clearPendingEvents();
                UIUtils.showToast('Event log cleared', 'success');
                this._renderPrivacySettings();
            });

            // Clear browse data — wipes the persist:browse session so
            // every browsed site logs the user out and any trackers
            // start from scratch. Doesn't touch the main app data.
            this._bindBtn('settings-clear-browse-data-btn', async () => {
                if (!window.electronBrowse?.clearData) return;
                const confirmed = await UIUtils.confirm(
                    'Clear browse data?',
                    'This wipes cookies, cache, local storage, and saved auth from every site you\'ve visited in the Browse sub-app. Your notes, journal, goals, and other Anjadhe data are not affected.',
                    'Clear'
                );
                if (!confirmed) return;
                const status = document.getElementById('settings-clear-browse-data-status');
                if (status) status.textContent = 'Clearing…';
                const result = await window.electronBrowse.clearData();
                if (result?.ok) {
                    if (status) status.textContent = `Cleared at ${new Date().toLocaleString()}.`;
                    UIUtils.showToast('Browse data cleared', 'success');
                } else {
                    if (status) status.textContent = `Clear failed: ${result?.error || 'unknown error'}`;
                    UIUtils.showToast('Clear failed', 'error');
                }
            });
        }
    },

    _renderPrivacySettings() {
        if (typeof AnalyticsManager === 'undefined') return;

        const toggle = document.getElementById('settings-analytics-toggle');
        if (toggle) toggle.checked = AnalyticsManager.isEnabled();

        const installIdEl = document.getElementById('settings-analytics-install-id');
        if (installIdEl) installIdEl.textContent = AnalyticsManager.getInstallId();

        const lastUploadEl = document.getElementById('settings-analytics-last-upload');
        if (lastUploadEl) {
            const lastUpload = AnalyticsManager.getLastUploadAt();
            lastUploadEl.textContent = lastUpload
                ? `Last sent: ${this._formatTimeAgo(new Date(lastUpload))}`
                : 'Last sent: never';
        }

        const events = AnalyticsManager.getPendingEvents();
        const summaryEl = document.getElementById('settings-analytics-summary');
        if (summaryEl) {
            if (events.length === 0) {
                summaryEl.textContent = 'No events recorded.';
            } else {
                const oldest = new Date(events[0].ts);
                const newest = new Date(events[events.length - 1].ts);
                const span = oldest.getTime() === newest.getTime()
                    ? this._formatTime(newest)
                    : this._formatTimeRange(oldest, newest);
                summaryEl.textContent = `${events.length} event${events.length === 1 ? '' : 's'} · ${span}`;
            }
        }

        const eventsEl = document.getElementById('settings-analytics-events');
        if (eventsEl) {
            eventsEl.innerHTML = '';
            // Show newest first.
            for (let i = events.length - 1; i >= 0; i--) {
                const ev = events[i];
                const row = document.createElement('div');
                row.className = 'settings-analytics-event';
                const propStr = Object.keys(ev.props || {}).length
                    ? JSON.stringify(ev.props)
                    : '';
                row.innerHTML = `
                    <span class="settings-analytics-event-name">${this._esc(ev.name)}</span>
                    <span class="settings-analytics-event-props">${this._esc(propStr)}</span>
                    <span class="settings-analytics-event-time" title="${this._esc(this._formatTime(new Date(ev.ts)))}">${this._esc(this._formatTimeAgo(new Date(ev.ts)))}</span>
                `;
                eventsEl.appendChild(row);
            }
        }

        const vocabEl = document.getElementById('settings-analytics-vocabulary');
        if (vocabEl && !vocabEl.dataset.rendered) {
            vocabEl.innerHTML = '';
            for (const name of AnalyticsManager.getVocabulary()) {
                const schema = AnalyticsManager.VOCABULARY[name];
                const propKeys = Object.keys(schema);
                const li = document.createElement('li');
                li.innerHTML = `
                    <span>${this._esc(name)}</span>
                    <span class="settings-analytics-vocabulary-props">${propKeys.length ? this._esc('{ ' + propKeys.join(', ') + ' }') : '(no props)'}</span>
                `;
                vocabEl.appendChild(li);
            }
            vocabEl.dataset.rendered = '1';
        }
    },

    _formatTime(date) {
        const now = new Date();
        const timeOpts = { hour: 'numeric', minute: '2-digit' };
        const time = date.toLocaleTimeString(undefined, timeOpts);
        if (date.toDateString() === now.toDateString()) return `Today, ${time}`;
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
        const sameYear = date.getFullYear() === now.getFullYear();
        const dateOpts = sameYear
            ? { month: 'short', day: 'numeric' }
            : { year: 'numeric', month: 'short', day: 'numeric' };
        return `${date.toLocaleDateString(undefined, dateOpts)}, ${time}`;
    },

    _formatTimeRange(start, end) {
        if (start.toDateString() === end.toDateString()) {
            const endTime = end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
            return `${this._formatTime(start)} – ${endTime}`;
        }
        return `${this._formatTime(start)} – ${this._formatTime(end)}`;
    },

    _formatTimeAgo(date) {
        const diff = Date.now() - date.getTime();
        if (diff < 0) return this._formatTime(date);
        const secs = Math.floor(diff / 1000);
        if (secs < 45) return 'just now';
        const mins = Math.floor(secs / 60);
        if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
        const days = Math.floor(hours / 24);
        if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
        return this._formatTime(date);
    },

    // ── Storage & Backup sub-view ──

    _storageBackupBound: false,

    openSetupAssistant() {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('setup-assistant-view').classList.add('active');
        Breadcrumb.render('setup-assistant-breadcrumb', [
            { label: 'Settings', action: () => { document.getElementById('setup-assistant-view').classList.remove('active'); document.getElementById('settings-view').classList.add('active'); } },
            { label: 'Setup Assistant' }
        ]);

        const host = document.getElementById('setup-assistant-host');
        if (host && typeof SetupAssistant !== 'undefined') {
            // A user reaching this from Settings explicitly wants it back —
            // clear any "Maybe later" and render even when complete.
            SetupAssistant.reopen();
            SetupAssistant.renderFull(host, { force: true });
        }
    },

    // Master list of the five storage settings — same pattern as the AI
    // Assistant page (openLLMSection): rows with current values, one
    // section per page.
    SB_SECTIONS: {
        'sb-sec-location': { label: 'Storage Location' },
        'sb-sec-usage': { label: 'Data Usage' },
        'sb-sec-sync': { label: 'Sync Between Macs' },
        'sb-sec-enc': { label: 'Sync Encryption' },
        'sb-sec-backup': { label: 'Backup' }
    },

    openStorageSection(secId) {
        const spec = this.SB_SECTIONS[secId];
        const view = document.getElementById('storage-backup-view');
        const sec = document.getElementById(secId);
        if (!spec || !view || !sec) return;
        view.classList.add('sb-in-section');
        view.querySelectorAll('.settings-section').forEach(s => s.classList.toggle('active', s === sec));
        Breadcrumb.render('storage-backup-breadcrumb', [
            { label: 'Settings', action: () => { view.classList.remove('active'); document.getElementById('settings-view').classList.add('active'); } },
            { label: 'Storage & Backup', action: () => this.openStorageBackup() },
            { label: spec.label }
        ]);
    },

    _bindSbRoot() {
        const root = document.getElementById('sb-root');
        if (!root || root._bound) return;
        root._bound = true;
        root.addEventListener('click', (e) => {
            const row = e.target.closest('[data-sb-sec]');
            if (row) this.openStorageSection(row.dataset.sbSec);
        });
    },

    async openStorageBackup() {
        // Show the sub-view in master-list mode
        const sbView = document.getElementById('storage-backup-view');
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        sbView.classList.add('active');
        sbView.classList.remove('sb-in-section');
        sbView.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
        this._bindSbRoot();
        Breadcrumb.render('storage-backup-breadcrumb', [
            { label: 'Settings', action: () => { sbView.classList.remove('active'); document.getElementById('settings-view').classList.add('active'); } },
            { label: 'Storage & Backup' }
        ]);

        // Load current state
        const storageFolder = window.electronStore.getStorageFolder();
        const customPath = window.electronStore.getCustomStoragePath();

        const pathEl = document.getElementById('storage-backup-path');
        if (pathEl) pathEl.textContent = storageFolder;

        const locHint = document.getElementById('sb-hint-location');
        if (locHint) locHint.textContent = storageFolder + (customPath ? ' · custom location' : '');

        const customNote = document.getElementById('storage-backup-custom-note');
        if (customNote) customNote.style.display = customPath ? '' : 'none';

        const resetBtn = document.getElementById('settings-reset-storage-btn');
        if (resetBtn) resetBtn.style.display = customPath ? '' : 'none';

        // Backup settings
        let backupSettings = { enabled: false, frequency: 'hourly', lastBackup: null, backupPath: null };
        if (window.electronBackup) {
            try { backupSettings = await window.electronBackup.getSettings(); } catch {}
        }

        const backupToggle = document.getElementById('settings-backup-toggle');
        if (backupToggle) backupToggle.checked = backupSettings.enabled;

        const backupDetail = document.getElementById('settings-backup-detail');
        if (backupDetail) backupDetail.style.display = backupSettings.enabled ? '' : 'none';

        const freqSelect = document.getElementById('settings-backup-frequency');
        if (freqSelect) freqSelect.value = backupSettings.frequency;

        const lastBackupEl = document.getElementById('settings-last-backup');
        if (lastBackupEl) {
            lastBackupEl.textContent = backupSettings.lastBackup
                ? new Date(backupSettings.lastBackup).toLocaleString()
                : 'Never';
        }

        const backupPathEl = document.getElementById('settings-backup-path');
        if (backupPathEl) backupPathEl.textContent = backupSettings.backupPath || 'No folder selected';

        const backupHint = document.getElementById('sb-hint-backup');
        if (backupHint) {
            backupHint.textContent = backupSettings.enabled
                ? `On · ${backupSettings.frequency}${backupSettings.lastBackup ? ' · last ' + new Date(backupSettings.lastBackup).toLocaleString() : ''}`
                : 'Off';
        }

        this._renderStorageUsage();
        await this._renderSyncEncryption();
        await this._renderSyncToggle();

        // Bind events once
        if (!this._storageBackupBound) {
            this._storageBackupBound = true;

            this._bindBtn('settings-change-storage-btn', () => AppManager.changeStorageLocation());
            this._bindBtn('settings-reset-storage-btn', () => AppManager.resetStorageLocation());

            // Merge on demand. Anjadhe merges on launch and on refresh and
            // never on a timer, so before this the only way to ask for
            // another Mac's changes was Cmd+R — which also killed whatever
            // the assistant was doing (AppManager.requestReload).
            this._bindBtn('settings-sync-now-btn', async () => {
                const btn = document.getElementById('settings-sync-now-btn');
                btn.disabled = true;
                btn.textContent = 'Checking…';
                try {
                    await AppManager.syncNow();
                } finally {
                    btn.disabled = false;
                    btn.textContent = 'Check for changes now';
                }
                this._renderSyncToggle();
            });

            this._bindBtn('settings-sync-enc-set-btn', () => this._syncEncPrompt('set'));
            this._bindBtn('settings-sync-enc-unlock-btn', () => this._syncEncPrompt('unlock'));
            this._bindBtn('settings-sync-enc-change-btn', () => this._syncEncPrompt('change'));

            // Multi-Mac sync opt-in toggle
            const syncToggle = document.getElementById('settings-sync-toggle');
            if (syncToggle) {
                syncToggle.addEventListener('change', async (e) => {
                    const enabled = e.target.checked;
                    e.target.disabled = true;
                    try {
                        const result = await window.electronSync.setEnabled(enabled);
                        if (enabled) {
                            if (result?.locked) {
                                UIUtils.showToast('Sync is on — enter your sync passphrase below to pull in your data', 'info');
                            } else {
                                const n = result?.merged || 0;
                                UIUtils.showToast(n > 0 ? `Sync enabled — merged ${n} change${n === 1 ? '' : 's'}` : 'Sync enabled', 'success');
                            }
                        } else {
                            UIUtils.showToast('Sync turned off — data stays on this Mac', 'success');
                        }
                    } catch (err) {
                        UIUtils.showToast('Could not change sync: ' + (err?.message || err), 'error');
                        e.target.checked = !enabled;
                    }
                    e.target.disabled = false;
                    this._renderSyncToggle();
                    this._renderSyncEncryption();
                });
            }

            // Backup toggle
            const toggle = document.getElementById('settings-backup-toggle');
            if (toggle) {
                const newEl = toggle.cloneNode(true);
                toggle.parentNode.replaceChild(newEl, toggle);
                newEl.addEventListener('change', async (e) => {
                    const enabled = e.target.checked;
                    await window.electronBackup.setEnabled(enabled);
                    const detail = document.getElementById('settings-backup-detail');
                    if (detail) detail.style.display = enabled ? '' : 'none';

                    if (enabled) {
                        const result = await window.electronBackup.backupNow();
                        if (result.success) {
                            const timeEl = document.getElementById('settings-last-backup');
                            if (timeEl) timeEl.textContent = new Date(result.time).toLocaleString();
                            UIUtils.showToast('Backup enabled', 'success');
                        }
                    }
                });
            }

            // Backup folder chooser
            this._bindBtn('settings-backup-choose-folder-btn', async () => {
                const folderPath = await window.electronDialog.selectFolder();
                if (!folderPath) return;
                if (window.electronBackup) {
                    await window.electronBackup.setBackupPath(folderPath);
                }
                const pathEl = document.getElementById('settings-backup-path');
                if (pathEl) pathEl.textContent = folderPath;
                UIUtils.showToast('Backup folder updated', 'success');
            });

            this._bindChange('settings-backup-frequency', async (val) => {
                await window.electronBackup.setFrequency(val);
            });

            this._bindBtn('settings-backup-now-btn', async () => {
                const btn = document.getElementById('settings-backup-now-btn');
                btn.disabled = true;
                btn.textContent = 'Backing up...';
                try {
                    const result = await window.electronBackup.backupNow();
                    if (result.success) {
                        const timeEl = document.getElementById('settings-last-backup');
                        if (timeEl) timeEl.textContent = new Date(result.time).toLocaleString();
                        UIUtils.showToast('Backup completed', 'success');
                    } else {
                        UIUtils.showToast('Backup failed: ' + result.error, 'error');
                    }
                } catch (err) {
                    UIUtils.showToast('Backup failed: ' + err.message, 'error');
                }
                btn.disabled = false;
                btn.textContent = 'Backup Now';
            });

            this._bindBtn('settings-restore-btn', async () => {
                await AppManager.showRestoreBackupPicker();
            });
            this._bindBtn('settings-browse-db-btn', () => this.openDbBrowser());
        }
    },

    // ── Multi-Mac sync opt-in ──

    async _renderSyncToggle() {
        const toggle = document.getElementById('settings-sync-toggle');
        const hint = document.getElementById('settings-sync-machines');
        if (!toggle || !window.electronSync?.getStatus) return;
        let st;
        try { st = await window.electronSync.getStatus(); } catch { return; }
        toggle.checked = st.enabled === true;
        // "Check for changes now" is meaningless with sync off — there is no
        // journal to read — so it appears with the feature, not before it.
        const nowRow = document.getElementById('settings-sync-now-row');
        if (nowRow) nowRow.style.display = st.enabled ? '' : 'none';
        const rowHint = document.getElementById('sb-hint-sync');
        if (rowHint) {
            const n = (st.machines || []).filter(m => !m.isCurrent).length;
            rowHint.textContent = st.enabled
                ? (n ? `On · syncing with ${n} Mac${n === 1 ? '' : 's'}` : 'On · no other Macs yet')
                : 'Off';
        }
        if (!hint) return;
        const peers = (st.machines || []).filter(m => !m.isCurrent);
        const names = peers.map(m => m.hostname || m.machineId).join(', ');
        if (st.enabled) {
            hint.textContent = peers.length
                ? `Syncing with: ${names}`
                : 'No other Macs yet — install Anjadhe on another Mac and turn sync on there.';
        } else {
            hint.textContent = peers.length
                ? `Anjadhe data from another Mac is in your iCloud Drive (${names}) — turn sync on to merge with it.`
                : '';
        }
    },

    // ── Sync encryption (H6) ──

    async _renderSyncEncryption() {
        const statusEl = document.getElementById('settings-sync-enc-status');
        const setBtn = document.getElementById('settings-sync-enc-set-btn');
        const unlockBtn = document.getElementById('settings-sync-enc-unlock-btn');
        const changeBtn = document.getElementById('settings-sync-enc-change-btn');
        if (!statusEl || !window.electronSync?.encryptionStatus) return;
        let st;
        try { st = await window.electronSync.encryptionStatus(); } catch { return; }
        const show = (el, on) => { if (el) el.style.display = on ? '' : 'none'; };
        const messages = {
            passphrase: 'Protected: your sync key is encrypted with a passphrase and unlocked on this Mac.',
            locked: 'Locked. This Mac needs your passphrase to sync and back up; enter it to resume.',
            plaintext: 'Not protected yet. Your sync key sits unprotected in iCloud; set a passphrase to secure it.',
            'local-only': 'This Mac has a local key that isn’t synced yet. Set a passphrase to sync securely across your Macs.',
            none: 'No sync key on this Mac.'
        };
        statusEl.textContent = messages[st.state] || '';
        statusEl.style.color = st.state === 'locked' ? '#dc2626'
            : st.state === 'passphrase' ? '#16a34a' : '';
        const rowHint = document.getElementById('sb-hint-enc');
        if (rowHint) {
            rowHint.textContent = ({
                passphrase: 'Protected with a passphrase',
                locked: 'Locked — passphrase needed',
                plaintext: 'Not protected yet',
                'local-only': 'Local key, not synced',
                none: 'No sync key'
            })[st.state] || '';
        }
        show(setBtn, st.upgradeable);
        show(unlockBtn, st.locked);
        show(changeBtn, st.state === 'passphrase');
    },

    // One flow for set / change / unlock. `mode` picks the copy + IPC call.
    // Resolves true once the operation succeeds (used by the startup unlock).
    _syncEncPrompt(mode) {
        const cfg = {
            set: { title: 'Set a sync passphrase', label: 'Choose a passphrase (8+ characters)', confirm: true, save: 'Set passphrase',
                note: 'Every Mac will need this passphrase once to keep syncing. It isn’t stored in iCloud, so keep it somewhere safe — it can’t be recovered.',
                run: (p) => window.electronSync.setPassphrase(p), ok: 'Passphrase set — your sync key is now protected.' },
            change: { title: 'Change sync passphrase', label: 'New passphrase (8+ characters)', confirm: true, save: 'Change passphrase',
                note: 'Your other Macs will keep working until they next need the key; then they’ll ask for the new passphrase.',
                run: (p) => window.electronSync.changePassphrase(p), ok: 'Passphrase changed.' },
            unlock: { title: 'Unlock sync on this Mac', label: 'Enter your sync passphrase', confirm: false, save: 'Unlock',
                note: 'This unlocks the shared sync key on this Mac and resumes syncing and backups.',
                run: (p) => window.electronSync.unlock(p), ok: 'Unlocked — syncing resumed.' }
        }[mode];
        return new Promise((resolve) => {
            const body = document.createElement('div');
            body.innerHTML = `
                <p class="settings-section-desc">${UIUtils.escapeHtml(cfg.note)}</p>
                <p class="settings-hint" style="margin-bottom:4px;">${UIUtils.escapeHtml(cfg.label)}</p>
                <input type="password" id="sync-enc-pass" class="settings-input" autocomplete="new-password" style="width:100%;margin-bottom:var(--space-sm);">
                ${cfg.confirm ? '<p class="settings-hint" style="margin-bottom:4px;">Confirm passphrase</p><input type="password" id="sync-enc-pass2" class="settings-input" autocomplete="new-password" style="width:100%;">' : ''}
                <p id="sync-enc-err" class="settings-hint" style="color:#dc2626;display:none;"></p>`;
            let done = false;
            const err = body.querySelector('#sync-enc-err');
            const showErr = (m) => { err.textContent = m; err.style.display = ''; };
            const submit = async () => {
                const p = body.querySelector('#sync-enc-pass').value;
                if (cfg.confirm) {
                    if (p !== body.querySelector('#sync-enc-pass2').value) return showErr('Passphrases don’t match.');
                    if (p.length < 8) return showErr('Use at least 8 characters.');
                }
                if (!p) return showErr('Enter your passphrase.');
                const saveBtn = body.closest('.modal')?.querySelector('.modal-footer .primary-btn');
                if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Working…'; }
                let res;
                try { res = await cfg.run(p); } catch (e) { res = { error: e.message }; }
                if (res && res.ok) {
                    done = true;
                    modal.close();
                    UIUtils.showToast(cfg.ok, 'success');
                    this._renderSyncEncryption();
                    resolve(true);
                } else {
                    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = cfg.save; }
                    showErr((res && res.error) || 'Something went wrong.');
                }
            };
            const modal = Modal.create({
                title: cfg.title, content: body,
                buttons: [
                    { text: 'Cancel', className: 'secondary-btn', onClick: () => modal.close() },
                    { text: cfg.save, className: 'primary-btn', onClick: submit }
                ],
                onClose: () => { if (!done) resolve(false); }
            });
            body.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
            setTimeout(() => body.querySelector('#sync-enc-pass')?.focus(), 50);
        });
    },

    // ── Database Browser ──

    openDbBrowser() {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('db-browser-view').classList.add('active');
        Breadcrumb.render('db-browser-breadcrumb', [
            { label: 'Settings', action: () => { document.getElementById('db-browser-view').classList.remove('active'); document.getElementById('settings-view').classList.add('active'); } },
            { label: 'Storage', action: () => this.openStorageBackup() },
            { label: 'Browse Database' }
        ]);

        const allData = StorageManager.getAll();
        const keys = Object.keys(allData).sort();
        this._dbBrowserData = allData;
        this._dbBrowserKeys = keys;

        this._renderDbList(keys, allData);

        // Search filter
        if (!this._dbSearchBound) {
            this._dbSearchBound = true;
            const searchInput = document.getElementById('db-browser-search');
            searchInput.addEventListener('input', () => {
                const q = searchInput.value.toLowerCase().trim();
                const filtered = q
                    ? this._dbBrowserKeys.filter(k => k.toLowerCase().includes(q))
                    : this._dbBrowserKeys;
                this._renderDbList(filtered, this._dbBrowserData);
            });
        }
        document.getElementById('db-browser-search').value = '';
    },

    _renderDbList(keys, allData) {
        const container = document.getElementById('db-browser-list');
        const countEl = document.getElementById('db-browser-count');
        countEl.textContent = `${keys.length} key${keys.length !== 1 ? 's' : ''}`;

        if (keys.length === 0) {
            container.innerHTML = '<div class="db-browser-empty">No keys found</div>';
            return;
        }

        container.innerHTML = keys.map(key => {
            const val = allData[key];
            const size = this._formatSize(JSON.stringify(val));
            const type = Array.isArray(val) ? 'array' : typeof val;
            let itemCount = '';
            if (Array.isArray(val)) {
                itemCount = ` (${val.length})`;
            } else if (val && typeof val === 'object') {
                const innerArrays = Object.values(val).filter(v => Array.isArray(v));
                if (innerArrays.length === 1) {
                    itemCount = ` (${innerArrays[0].length} items)`;
                }
            }
            return `<div class="db-browser-item" data-key="${this._esc(key)}">
                <div class="db-browser-key">
                    <span class="db-browser-key-arrow">&#9654;</span>
                    <span class="db-browser-key-name">${this._esc(key)}</span>
                    <span class="db-browser-key-meta">${type}${itemCount} &middot; ${size}</span>
                </div>
                <div class="db-browser-value"><pre></pre></div>
            </div>`;
        }).join('');

        // Toggle expand on click
        container.querySelectorAll('.db-browser-key').forEach(el => {
            el.addEventListener('click', () => {
                const item = el.closest('.db-browser-item');
                const wasExpanded = item.classList.contains('expanded');
                if (!wasExpanded) {
                    const key = item.dataset.key;
                    const pre = item.querySelector('pre');
                    if (!pre.textContent) {
                        pre.textContent = JSON.stringify(allData[key], null, 2);
                    }
                }
                item.classList.toggle('expanded');
            });
        });
    },

    _formatSize(str) {
        const bytes = new Blob([str]).size;
        return this._formatBytes(bytes);
    },

    _formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    },

    // ── Per-app data usage (Storage & Backup page) ──

    // Map a raw storage key to a user-facing app name. Exact matches
    // first, then prefix rules for the namespaced / dynamic keys.
    // Anything unrecognized falls into "Other" so the totals always
    // add up even as new keys are introduced.
    _appForStorageKey(key) {
        const exact = {
            email: 'Email', emailPriorityTerms: 'Email', emailSearchHistory: 'Email',
            schedule: 'Schedule', calendar: 'Schedule',
            notes: 'Notes', notesPrefs: 'Notes', tags: 'Notes',
            journal: 'Journal',
            goals: 'Goals',
            bookmarks: 'Bookmarks', 'bookmarks-view-mode': 'Bookmarks', links: 'Bookmarks',
            portfolio: 'Portfolio',
            wellness: 'Wellness',
            focus: 'Focus', pomodoro: 'Focus',
            dictionary: 'Vocabulary', 'dictionary-cache': 'Vocabulary',
            prompts: 'Prompts', promptFeed: 'Prompts',
            // Assistant internals — chat history and model/search logs are
            // often the heaviest keys, so attributing them correctly keeps
            // the breakdown honest.
            'agent-settings': 'Assistant', 'agent-conversations': 'Assistant',
            'agent-memories': 'Assistant',
            // Diagnostic logs — every LLM/search call app-wide, capped and
            // machine-local. Kept separate from Assistant so chat/memory
            // size isn't conflated with debug logging (and it's clearable
            // from Settings - LLM Logs).
            'llm-logs': 'Logs', 'search-logs': 'Logs', 'network-logs': 'Logs',
            // Cross-cutting app/system state — not owned by any sub-app.
            profiles: 'System', accounts: 'System', analytics: 'System',
            'favorite-apps': 'System', 'hidden-apps': 'System',
            dashTab: 'System', 'dismissed-announcements': 'System'
        };
        if (exact[key]) return exact[key];
        if (key.startsWith('browse')) return 'Browser';        // browse_*, browseHomeTab, app_browse*
        if (key.startsWith('app_browse')) return 'Browser';
        if (key.startsWith('llm') || key.startsWith('search-log')) return 'Logs';
        if (key.startsWith('agent')) return 'Assistant';
        if (key.startsWith('email')) return 'Email';
        if (key.startsWith('calendar')) return 'Schedule';
        if (key.startsWith('journal')) return 'Journal';
        if (key.startsWith('notes')) return 'Notes';
        if (key.startsWith('bookmarks')) return 'Bookmarks';
        if (key.startsWith('dictionary')) return 'Vocabulary';
        if (key.startsWith('prompt')) return 'Prompts';
        // Truly unrecognized (new/future keys) — keep them visible rather
        // than hiding them inside System so the breakdown stays auditable.
        return 'Other';
    },

    async _renderStorageUsage() {
        const listEl = document.getElementById('storage-usage-list');
        const totalEl = document.getElementById('storage-usage-total');
        if (!listEl) return;

        let all = {};
        try { all = StorageManager.getAll() || {}; } catch {}

        const byApp = {};
        let total = 0;
        for (const key of Object.keys(all)) {
            // Same measurement as the DB browser: serialized byte length.
            let bytes = 0;
            try { bytes = new Blob([JSON.stringify(all[key] ?? null)]).size; } catch {}
            const app = this._appForStorageKey(key);
            byApp[app] = (byApp[app] || 0) + bytes;
            total += bytes;
        }

        // Email's cached messages live in a dedicated SQLite table, not the
        // app_email kv blob, so StorageManager.getAll() above only sees
        // Email's small metadata. Fold in the message-table size so Email
        // isn't drastically under-reported.
        try {
            const eml = await window.electronEmailDb?.dbSize?.();
            if (eml && eml.bytes > 0) {
                byApp['Email'] = (byApp['Email'] || 0) + eml.bytes;
                total += eml.bytes;
            }
        } catch {}

        const rows = Object.entries(byApp)
            .map(([app, bytes]) => ({ app, bytes }))
            .sort((a, b) => b.bytes - a.bytes);

        const usageHint = document.getElementById('sb-hint-usage');
        if (rows.length === 0 || total === 0) {
            listEl.innerHTML = '<p class="settings-hint">No app data stored yet.</p>';
            if (totalEl) totalEl.textContent = '';
            if (usageHint) usageHint.textContent = 'No app data stored yet';
            return;
        }
        if (usageHint) usageHint.textContent = `${this._formatBytes(total)} across ${rows.length} app${rows.length !== 1 ? 's' : ''}`;

        const max = rows[0].bytes || 1;
        listEl.innerHTML = rows.map(r => {
            const pct = Math.max(2, Math.round((r.bytes / max) * 100));
            const appId = this._launchIdForApp(r.app);
            const name = appId
                ? `<a href="#" class="storage-usage-link" data-app="${this._esc(appId)}" title="Open ${this._esc(r.app)}">${this._esc(r.app)}</a>`
                : `<span class="storage-usage-name-plain">${this._esc(r.app)}</span>`;
            return `<div class="storage-usage-row">
                <span class="storage-usage-name">${name}</span>
                <span class="storage-usage-bar"><span class="storage-usage-bar-fill" style="width: ${pct}%;"></span></span>
                <span class="storage-usage-size">${this._formatBytes(r.bytes)}</span>
            </div>`;
        }).join('');

        if (totalEl) totalEl.textContent = `Total: ${this._formatBytes(total)} across ${rows.length} app${rows.length !== 1 ? 's' : ''}`;

        // Delegated once: clicking an app name launches that sub-app.
        // Non-app buckets (System, Logs, Other) render as plain text and
        // have no data-app, so they're inert.
        if (!this._storageUsageBound) {
            this._storageUsageBound = true;
            listEl.addEventListener('click', (e) => {
                const link = e.target.closest('[data-app]');
                if (!link) return;
                e.preventDefault();
                const appId = link.getAttribute('data-app');
                if (appId && typeof AppManager !== 'undefined') AppManager.openApp(appId);
            });
        }
    },

    // Map a Data Usage bucket label to the canonical AppManager id, or
    // null for buckets that aren't launchable sub-apps (System, Logs,
    // Other). Keys mirror the labels produced by _appForStorageKey().
    _launchIdForApp(app) {
        const map = {
            Email: 'email', Schedule: 'schedule', Notes: 'notes',
            Journal: 'journal', Goals: 'goals', Bookmarks: 'bookmarks',
            Portfolio: 'portfolio', Wellness: 'wellness',
            Focus: 'goals', Vocabulary: 'dictionary',
            Prompts: 'prompts',
            Browser: 'browse', Assistant: 'agent'
        };
        return map[app] || null;
    },

    // ── LLM Logs rendering ──

    renderLogs() {
        const container = document.getElementById('settings-logs-container');
        const countBadge = document.getElementById('settings-logs-count');
        if (!container) return;

        const logs = LLMLogger.logs;
        if (countBadge) countBadge.textContent = logs.length;

        if (logs.length === 0) {
            container.innerHTML = '<p class="settings-hint" style="text-align:center; padding: var(--space-lg) 0;">No LLM calls recorded yet.</p>';
            return;
        }

        // Filter at render time; rows keep their ORIGINAL index because the
        // detail view resolves data-log-index against LLMLogger.logs.
        const query = (document.getElementById('settings-logs-search')?.value || '').trim().toLowerCase();
        const rows = logs.map((log, i) => ({ log, i }))
            .filter(({ log }) => !query || this._logMatchesQuery(log, query));

        if (rows.length === 0) {
            container.innerHTML = '<p class="settings-hint" style="text-align:center; padding: var(--space-lg) 0;">No log entries match your search.</p>';
            return;
        }

        container.innerHTML = `
            <table class="llm-logs-table">
                <thead>
                    <tr>
                        <th>Source</th>
                        <th>Model</th>
                        <th>Prompt</th>
                        <th>Duration</th>
                        <th>Tokens</th>
                        <th>Time</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map(({ log, i }) => this._renderLogEntry(log, i)).join('')}
                </tbody>
            </table>
        `;

        // Attach row click to show detail
        container.querySelectorAll('[data-log-index]').forEach(row => {
            row.addEventListener('click', () => {
                this._showLogDetail(parseInt(row.dataset.logIndex));
            });
        });
    },

    // A log search matches any text the row or its detail view shows: who
    // called, which model, what was sent, and what came back. Fields can be
    // null (errors, streams cut early), so only strings are tested.
    _logMatchesQuery(log, query) {
        const haystack = [
            log.source, log.model, log.provider,
            log.userPrompt, log.systemPrompt, log.response, log.error,
            ...(log.toolCalls || []).flatMap(tc => [tc.name, tc.args])
        ];
        return haystack.some(v => typeof v === 'string' && v.toLowerCase().includes(query));
    },

    _renderLogEntry(log, index) {
        const time = new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const date = new Date(log.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
        const duration = log.durationMs != null ? `${(log.durationMs / 1000).toFixed(1)}s` : '--';
        const status = log.error ? 'error' : '';

        const sourceLabels = { agent: 'Agent', email: 'Email' };
        const sourceLabel = sourceLabels[log.source] || log.source || '?';
        const sourceClass = `source-${log.source || 'agent'}`;

        const tokens = log.totalTokens != null
            ? `${log.promptTokens?.toLocaleString() || '?'} / ${log.completionTokens?.toLocaleString() || '?'}`
            : `~${Math.round((log.requestChars || 0) / 4).toLocaleString()}`;

        const prompt = this._esc((log.userPrompt || '').slice(0, 80)) + ((log.userPrompt || '').length > 80 ? '...' : '');

        // A model id can be a full GGUF path on llama.cpp — show the model
        // name; the full id stays in the tooltip and the detail view.
        const modelName = String(log.model || '?').split('/').pop().replace(/\.gguf$/i, '');

        return `
            <tr class="llm-log-row ${status}" data-log-index="${index}">
                <td><span class="log-source ${sourceClass}">${sourceLabel}</span></td>
                <td class="log-model-cell" title="${this._esc(log.model || '')}">${this._esc(modelName)}</td>
                <td class="log-prompt-cell">${prompt}</td>
                <td>${duration}</td>
                <td>${tokens}</td>
                <td>${date} ${time}</td>
                <td>${log.error ? '<span class="log-error-dot"></span>' : ''}</td>
            </tr>
        `;
    },

    renderSearchLogs() {
        const container = document.getElementById('settings-search-logs-container');
        const countBadge = document.getElementById('settings-search-logs-count');
        if (!container) return;

        const logs = SearchLogger.logs;
        if (countBadge) countBadge.textContent = logs.length;

        if (logs.length === 0) {
            container.innerHTML = '<p class="settings-hint" style="text-align:center; padding: var(--space-lg) 0;">No web searches recorded yet.</p>';
            return;
        }

        const query = (document.getElementById('settings-search-logs-search')?.value || '').trim().toLowerCase();
        const rows = logs.filter(log => !query ||
            [log.query, log.provider, log.error]
                .some(v => typeof v === 'string' && v.toLowerCase().includes(query)));

        if (rows.length === 0) {
            container.innerHTML = '<p class="settings-hint" style="text-align:center; padding: var(--space-lg) 0;">No log entries match your search.</p>';
            return;
        }

        container.innerHTML = `
            <table class="llm-logs-table">
                <thead>
                    <tr>
                        <th>Query</th>
                        <th>Provider</th>
                        <th>Results</th>
                        <th>Duration</th>
                        <th>Time</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map(log => this._renderSearchLogEntry(log)).join('')}
                </tbody>
            </table>
        `;
    },

    _renderSearchLogEntry(log) {
        const time = new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const date = new Date(log.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
        const duration = log.durationMs != null ? `${(log.durationMs / 1000).toFixed(1)}s` : '--';
        const status = log.error ? 'error' : '';
        const resultsCell = log.error ? this._esc(log.error) : String(log.resultCount ?? 0);
        const providerLabels = { tavily: 'Tavily', brave: 'Brave' };
        const providerCell = log.provider ? (providerLabels[log.provider] || this._esc(log.provider)) : '--';

        return `
            <tr class="llm-log-row ${status}">
                <td class="log-prompt-cell">${this._esc(log.query)}</td>
                <td>${providerCell}</td>
                <td>${resultsCell}</td>
                <td>${duration}</td>
                <td>${date} ${time}</td>
                <td>${log.error ? '<span class="log-error-dot"></span>' : ''}</td>
            </tr>
        `;
    },

    // ── Network Logs rendering ──

    async renderNetworkLogs() {
        const container = document.getElementById('settings-network-logs-container');
        const countBadge = document.getElementById('settings-network-logs-count');
        if (!container) return;

        let logs = [];
        try { logs = await window.electronNetLog.getLogs(); } catch {}
        if (!Array.isArray(logs)) logs = [];
        this._netLogs = logs;
        if (countBadge) countBadge.textContent = logs.length;

        if (logs.length === 0) {
            container.innerHTML = '<p class="settings-hint" style="text-align:center; padding: var(--space-lg) 0;">No network calls recorded yet.</p>';
            return;
        }

        container.innerHTML = `
            <table class="llm-logs-table">
                <thead>
                    <tr>
                        <th>Service</th>
                        <th>Request</th>
                        <th>Status</th>
                        <th>Size</th>
                        <th>Duration</th>
                        <th>Time</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    ${logs.map((log, i) => this._renderNetLogEntry(log, i)).join('')}
                </tbody>
            </table>
        `;

        container.querySelectorAll('[data-net-index]').forEach(row => {
            row.addEventListener('click', () => this._showNetLogDetail(parseInt(row.dataset.netIndex)));
        });
    },

    _fmtBytes(n) {
        if (n == null) return '--';
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / 1024 / 1024).toFixed(1)} MB`;
    },

    _renderNetLogEntry(log, index) {
        const time = new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const date = new Date(log.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
        const duration = log.durationMs != null ? `${(log.durationMs / 1000).toFixed(2)}s` : '--';
        const status = !log.ok ? 'error' : '';
        const statusCell = log.error ? this._esc(log.error) : (log.status != null ? String(log.status) : '--');
        const reqPath = (log.path || '/') + (log.hadQuery ? '?…' : '');
        const reqCell = `<span class="log-source">${this._esc(log.method || 'GET')}</span> ${this._esc(log.host || '')}${this._esc(reqPath.length > 60 ? reqPath.slice(0, 60) + '…' : reqPath)}`;
        const size = this._fmtBytes(log.resBytes);

        return `
            <tr class="llm-log-row ${status}" data-net-index="${index}">
                <td>${this._esc(log.service || 'Other')}</td>
                <td class="log-prompt-cell">${reqCell}</td>
                <td>${statusCell}</td>
                <td>${size}</td>
                <td>${duration}</td>
                <td>${date} ${time}</td>
                <td>${!log.ok ? '<span class="log-error-dot"></span>' : ''}</td>
            </tr>
        `;
    },

    _showNetLogDetail(index) {
        const log = (this._netLogs || [])[index];
        if (!log) return;

        const status = !log.ok ? 'error' : 'success';
        const sourceLabel = log.source === 'renderer' ? 'Renderer (fetch)' : 'Main process';
        const fullUrl = `${log.protocol || 'https:'}//${log.host || ''}${log.port ? ':' + log.port : ''}${log.path || '/'}${log.hadQuery ? '?…' : ''}`;

        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('net-log-detail-view').classList.add('active');
        window.scrollTo(0, 0);

        const content = document.getElementById('net-log-detail-content');
        content.innerHTML = `
            <div class="log-detail-overview">
                <span class="log-source">${this._esc(log.service || 'Other')}</span>
                <span class="log-model">${this._esc(log.method || 'GET')}</span>
                <span class="log-duration">${log.durationMs != null ? (log.durationMs / 1000).toFixed(2) + 's' : '—'}</span>
                <span class="log-status-dot ${status}"></span>
            </div>

            <div class="log-detail-section">
                <div class="log-detail-label">Destination</div>
                <pre class="log-detail-pre">${this._esc(fullUrl)}</pre>
            </div>

            <div class="log-detail-section">
                <div class="log-detail-label">Summary</div>
                <p class="log-detail-text">Initiated by: ${this._esc(sourceLabel)}</p>
                <p class="log-detail-text">Status: ${log.status != null ? log.status : '—'}${log.ok ? ' (ok)' : ' (failed)'}</p>
                <p class="log-detail-text">Request sent: ${this._fmtBytes(log.reqBytes)} | Response received: ${this._fmtBytes(log.resBytes)}</p>
                <p class="log-detail-text">Query string: ${log.hadQuery ? 'present (not logged)' : 'none'}</p>
                <p class="log-detail-text">When: ${new Date(log.timestamp).toLocaleString()}</p>
            </div>

            ${log.error ? `
                <div class="log-detail-section">
                    <div class="log-detail-label">Error</div>
                    <pre class="log-detail-pre log-error">${this._esc(log.error)}</pre>
                </div>
            ` : ''}

            <div class="log-detail-section">
                <div class="log-detail-label">Privacy</div>
                <p class="log-detail-text">Only the metadata above is recorded. Request and response bodies, headers, cookies, and authentication tokens are not logged, and the query string is stripped before storage.</p>
            </div>
        `;

        Breadcrumb.render('net-log-detail-breadcrumb', [
            { label: 'Settings', action: () => { document.querySelectorAll('.view').forEach(v => v.classList.remove('active')); document.getElementById('settings-view').classList.add('active'); this.render(); } },
            { label: 'Network Logs', action: () => this.openNetworkLogs() },
            { label: 'Request Detail' }
        ]);
    },

    _showLogDetail(index) {
        const log = LLMLogger.logs[index];
        if (!log) return;

        const systemPrompt = log.systemPrompt || 'None';
        const messages = log.requestMessages || [];
        const sourceLabels = { agent: 'Agent', email: 'Email' };
        const sourceLabel = sourceLabels[log.source] || log.source || '?';
        const sourceClass = `source-${log.source || 'agent'}`;
        const status = log.error ? 'error' : 'success';

        // Navigate to detail view
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        const view = document.getElementById('llm-log-detail-view');
        view.classList.add('active');
        window.scrollTo(0, 0);

        const content = document.getElementById('llm-log-detail-content');
        content.innerHTML = `
            <div class="log-detail-overview">
                <span class="log-source ${sourceClass}">${sourceLabel}</span>
                <span class="log-model">${this._esc(log.model || '?')}</span>
                <span class="log-duration">${log.durationMs != null ? (log.durationMs / 1000).toFixed(1) + 's' : '—'}</span>
                <span class="log-status-dot ${status}"></span>
            </div>

            <div class="log-detail-section">
                <div class="log-detail-label">Tokens</div>
                <p class="log-detail-text">Prompt: ${log.promptTokens?.toLocaleString() || '—'} | Completion: ${log.completionTokens?.toLocaleString() || '—'} | Total: ${log.totalTokens?.toLocaleString() || '—'}</p>
            </div>

            <div class="log-detail-section">
                <div class="log-detail-label">System Prompt <span class="log-detail-count">${systemPrompt.length.toLocaleString()} chars</span></div>
                <pre class="log-detail-pre">${this._esc(systemPrompt)}</pre>
            </div>

            <div class="log-detail-section">
                <div class="log-detail-label">Messages <span class="log-detail-count">${messages.length}</span></div>
                ${messages.map(m => `
                    <div class="log-detail-msg">
                        <strong>${this._esc(m.role)}</strong> <span class="log-detail-count">${m.chars.toLocaleString()} chars${m.toolCalls ? `, ${m.toolCalls} tool calls` : ''}</span>
                        <pre class="log-detail-pre">${this._esc(m.preview)}</pre>
                    </div>
                `).join('')}
            </div>

            ${log.toolCalls ? `
                <div class="log-detail-section">
                    <div class="log-detail-label">Tool Calls</div>
                    <pre class="log-detail-pre">${this._esc(JSON.stringify(log.toolCalls, null, 2))}</pre>
                </div>
            ` : ''}

            <div class="log-detail-section">
                <div class="log-detail-label">Full Response <span class="log-detail-count">${(log.responseChars || 0).toLocaleString()} chars</span></div>
                <pre class="log-detail-pre">${this._esc(log.response || log.error || 'No response')}</pre>
            </div>

            ${log.error ? `
                <div class="log-detail-section">
                    <div class="log-detail-label">Error</div>
                    <pre class="log-detail-pre log-error">${this._esc(log.error)}</pre>
                </div>
            ` : ''}
        `;

        // Breadcrumb for log detail — threads through the new LLM Logs sub-view
        // so Back goes log-list → assistant page → settings, matching how the
        // user navigated in.
        Breadcrumb.render('llm-log-detail-breadcrumb', [
            { label: 'Settings', action: () => { document.querySelectorAll('.view').forEach(v => v.classList.remove('active')); document.getElementById('settings-view').classList.add('active'); } },
            { label: 'AI Assistant', action: () => this.openLLMSettings() },
            { label: 'LLM Logs', action: () => this.openLlmLogs() },
            { label: 'Log Detail' }
        ]);
    },

    _esc(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    },

    // Helper: bind click with clone-and-replace
    _bindBrowserSearchControls() {
        const saveAndNotify = () => {
            const sel = document.getElementById('settings-search-engine');
            const customInput = document.getElementById('settings-search-engine-custom-url');
            const customWrap = document.getElementById('settings-search-engine-custom-wrap');
            const engine = sel ? sel.value : 'duckduckgo';
            const customSearchUrl = (customInput?.value || '').trim();
            if (customWrap) customWrap.style.display = engine === 'custom' ? '' : 'none';
            const existing = StorageManager.get('browse_settings') || {};
            StorageManager.set('browse_settings', { ...existing, searchEngine: engine, customSearchUrl });
            if (typeof BrowseApp !== 'undefined' && BrowseApp._invalidateSearchSettings) {
                BrowseApp._invalidateSearchSettings();
            }
        };
        this._bindChange('settings-search-engine', saveAndNotify);
        const customInput = document.getElementById('settings-search-engine-custom-url');
        if (customInput) {
            const fresh = customInput.cloneNode(true);
            customInput.parentNode.replaceChild(fresh, customInput);
            fresh.addEventListener('input', () => saveAndNotify());
        }
    },

    _bindBtn(id, handler) {
        const el = document.getElementById(id);
        if (!el) return;
        const newEl = el.cloneNode(true);
        el.parentNode.replaceChild(newEl, el);
        newEl.addEventListener('click', handler);
    },

    // Helper: bind change with clone-and-replace
    /**
     * User-facing copy per experimental flag. Keys are FEATURE_DEFAULTS keys.
     * A flag with no entry here still renders — under its own key, with no
     * description — because a missing line of copy must not be the reason a
     * shipped-off feature is unreachable.
     */
    EXPERIMENTAL_COPY: {
        maker: {
            title: 'Maker',
            hint: 'Build a small web page or interactive tool from a description, in an app of its own. Output quality varies a lot with the model you run.'
        },
        library: {
            title: 'Library',
            hint: 'Bring your own writing and documents into a folder the assistant can search and ground on. Indexing runs on a small local model (about a 330 MB download, on first use).'
        },
        mobilesync: {
            title: 'Paired devices',
            hint: 'Pair a phone with this Mac and sync over an end-to-end encrypted relay. Works, but the hosted relay is not finished.'
        }
    },

    /**
     * One switch per off-by-default flag. Built from FEATURES.experimental()
     * rather than from markup, so adding a flag to features.js is enough to
     * surface it here.
     *
     * Flags take effect on reload by design (see FEATURES.setOverride): tool
     * registries and gated routes are resolved at script-load time, so a live
     * flip would leave the app half-applied. The reload goes through
     * AppManager.requestReload so it can't silently kill a build or a task run
     * that is mid-flight.
     */
    _renderExperimental() {
        const list = document.getElementById('settings-experimental-list');
        if (!list || typeof FEATURES === 'undefined') return;

        const keys = FEATURES.experimental();
        const card = document.getElementById('settings-experimental-card');
        // Nothing experimental in this build — show no empty card.
        if (card) card.hidden = keys.length === 0;
        if (keys.length === 0) { list.innerHTML = ''; return; }

        const on = FEATURES.all();
        list.innerHTML = keys.map(key => {
            const copy = this.EXPERIMENTAL_COPY[key] || { title: key, hint: '' };
            return `
                <div class="settings-card-row settings-experimental-row">
                    <div>
                        <div class="settings-card-title">${UIUtils.escapeHtml(copy.title)}</div>
                        ${copy.hint ? `<p class="settings-card-hint">${UIUtils.escapeHtml(copy.hint)}</p>` : ''}
                    </div>
                    <label class="settings-switch">
                        <input type="checkbox" data-experimental="${UIUtils.escapeHtml(key)}"${on[key] ? ' checked' : ''}>
                        <span class="settings-switch-track"></span>
                    </label>
                </div>
            `;
        }).join('');

        list.querySelectorAll('input[data-experimental]').forEach(input => {
            input.addEventListener('change', () => {
                const key = input.dataset.experimental;
                FEATURES.setOverride(key, input.checked);
                const copy = this.EXPERIMENTAL_COPY[key] || { title: key };
                UIUtils.showToast(
                    `${copy.title} ${input.checked ? 'enabled' : 'disabled'} — reloading to apply`,
                    'success'
                );
                // Let the toast paint before the reload prompt takes the screen.
                setTimeout(() => AppManager.requestReload(), 400);
            });
        });
    },

    _bindChange(id, handler, isCheckbox = false) {
        const el = document.getElementById(id);
        if (!el) return;
        const newEl = el.cloneNode(true);
        el.parentNode.replaceChild(newEl, el);
        newEl.addEventListener('change', (e) => {
            handler(isCheckbox ? e.target.checked : e.target.value);
        });
    }
};

AppManager.register('settings', SettingsApp);
