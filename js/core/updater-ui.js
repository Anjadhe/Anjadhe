/**
 * UpdaterUI — the titlebar update pill, Home's "ready to install" card, and
 * Settings › App version.
 *
 * Subscribes to the electron-updater events pushed from the main process
 * via window.electronUpdater. A download in progress is shown ONLY on
 * Settings › App version (2026-09-30, by request: the floating strip that
 * showed the progress over every page, Home included, was removed) — the
 * page names the installed version, the download with its progress, a
 * failed download, or "up to date", with
 * Check for updates and the release notes. When the download is ready the
 * pill appears next to the sync indicator in the titlebar, with an
 * "Install" button that triggers quitAndInstall() through the preload
 * bridge, and Home shows its one "ready to install" card.
 *
 * Also handles the "Check for Updates…" menu action result — shows a
 * short toast telling the user whether they're on the latest build, or
 * why the check failed, when there's no newer version for the main
 * update-available flow to advertise.
 *
 * In dev mode (`npm start`) window.electronUpdater still exists but all
 * its calls return `{ error: 'dev build' }` and no events fire, so
 * init() is a harmless no-op.
 */
const UpdaterUI = {
    _pillEl: null,
    _textEl: null,
    _btnEl: null,
    _version: null,
    _downloaded: false,

    init() {
        if (!window.electronUpdater) {
            // Running outside Electron (e.g., rendered statically). Skip.
            return;
        }

        this._pillEl = document.getElementById('updater-pill');
        this._textEl = document.getElementById('updater-pill-text');
        this._btnEl = document.getElementById('updater-install-btn');

        if (!this._pillEl || !this._btnEl) {
            console.warn('[updater-ui] pill DOM not found; updates will still download but the nudge will not appear');
            return;
        }

        this._btnEl.addEventListener('click', () => this._requestInstall());

        window.electronUpdater.onAvailable((info) => {
            console.log('[updater-ui] update available:', info && info.version);
            this._version = (info && info.version) || null;
            this._showDownloading({ version: this._version, percent: 0 });
        });

        window.electronUpdater.onProgress((info) => {
            this._showDownloading(info);
        });

        window.electronUpdater.onDownloaded((info) => {
            this._version = (info && info.version) || this._version;
            this._downloaded = true;
            this._show();
        });

        window.electronUpdater.onDownloadError?.((info) => {
            console.warn('[updater-ui] download failed:', info && info.message);
            this._showDownloadFailed(info);
        });

        // Rehydrate: if a download already completed before this window
        // existed, the one-shot `updater:downloaded` broadcast is gone, so
        // ask the main process for the current state and show the pill.
        if (window.electronUpdater.getState) {
            window.electronUpdater.getState().then((state) => {
                if (state && state.downloadedVersion) {
                    this._version = state.downloadedVersion;
                    this._downloaded = true;
                    this._show();
                } else if (state && state.downloading) {
                    this._version = state.downloading.version || this._version;
                    this._showDownloading(state.downloading);
                }
            }).catch(() => {});
        }
    },

    // ── Status (drawn by Settings › App version) ─────────────────────────
    // One record of where the update stands; every updater event rewrites
    // it and repaints the page and its Settings row if they are on screen.
    // phase: idle | checking | latest | downloading | failed | ready | error
    _status: { phase: 'idle' },

    _setStatus(next) {
        this._status = { ...next, at: Date.now() };
        this.renderSettings();
        const hint = document.getElementById('settings-root-hint-version');
        if (hint) this.hintText().then((t) => { hint.textContent = t; });
    },

    _showDownloading(info) {
        if (this._downloaded) return;
        const version = (info && info.version) || this._version;
        const pct = Math.max(0, Math.min(100, Math.round((info && info.percent) || 0)));
        this._setStatus({ phase: 'downloading', version, percent: pct, size: this._sizeText(info) });
    },

    // "12 of 231 MB" when the sizes are known, else the bare percent.
    _sizeText(info) {
        const total = Number(info && info.total) || 0;
        if (!total) return '';
        const mb = (n) => Math.round(n / (1024 * 1024));
        return `${mb(Number(info.transferred) || 0)} of ${mb(total)} MB`;
    },

    _showDownloadFailed(info) {
        if (this._downloaded) return;
        this._setStatus({ phase: 'failed', version: (info && info.version) || this._version });
    },

    _installedVersion: null,
    _installed() {
        if (this._installedVersion) return Promise.resolve(this._installedVersion);
        const p = window.electronSystem?.getInfo?.();
        if (!p || typeof p.then !== 'function') return Promise.resolve(null);
        return p.then((i) => (this._installedVersion = (i && i.appVersion) || null)).catch(() => null);
    },

    _v(version) { return version ? 'v' + String(version).replace(/^v/, '') : ''; },

    /** The one line the Settings row shows under "App version". */
    async hintText() {
        const installed = this._v(await this._installed());
        const st = this._status;
        if (st.phase === 'downloading') return `Downloading ${this._v(st.version)} · ${st.percent}%`;
        if (st.phase === 'ready') return `${this._v(st.version)} ready to install`;
        return installed || 'Version and updates';
    },

    /** Settings › App version: facts, the update's state, and its actions. */
    /** The version card, drawn into `host` (the one Settings' About page,
     *  2026-10-06); without one, the last host still on the page. */
    async renderSettings(host) {
        if (host) this._host = host;
        host = host || (this._host && this._host.isConnected ? this._host : null);
        if (!host) return;
        const esc = (x) => (typeof UIUtils !== 'undefined' && UIUtils.escapeHtml) ? UIUtils.escapeHtml(String(x ?? '')) : String(x ?? '');
        const installed = await this._installed();
        const st = this._status;
        const v = esc(this._v(st.version));

        let state = '';
        let action = '<button type="button" class="secondary-btn" id="app-version-check">Check for updates</button>';
        if (st.phase === 'downloading') {
            state = `<p class="app-version-line">Downloading nenva ${v}</p>
                <div class="app-version-progress"><span class="app-version-track" aria-hidden="true"><span class="app-version-fill" style="width:${st.percent}%"></span></span>
                <span class="app-version-pct">${esc(st.size || st.percent + '%')}</span></div>
                <p class="settings-card-hint">It downloads in the background; you can keep working. When it is ready, it installs the next time you quit nenva, or sooner if you restart.</p>`;
            action = '';
        } else if (st.phase === 'ready') {
            state = `<p class="app-version-line">nenva ${v} is ready to install</p>
                <p class="settings-card-hint">Installs automatically the next time you quit nenva. Restart now to get it sooner.</p>`;
            action = '<button type="button" class="primary-btn" id="app-version-install">Restart &amp; update</button>';
        } else if (st.phase === 'failed') {
            state = `<p class="app-version-line app-version-warn">Could not download nenva ${v}</p>
                <p class="settings-card-hint">nenva will try again later, or check again now.</p>`;
        } else if (st.phase === 'checking') {
            state = '<p class="app-version-line">Checking for updates&hellip;</p>';
            action = '';
        } else if (st.phase === 'latest') {
            state = '<p class="app-version-line">You are on the latest version.</p>';
        } else if (st.phase === 'error') {
            state = `<p class="app-version-line app-version-warn">Could not check for updates</p><p class="settings-card-hint">${esc(st.message || '')}</p>`;
        } else {
            state = '<p class="settings-card-hint">nenva checks for updates when it opens and every few hours, and downloads them in the background.</p>';
        }

        host.innerHTML = `
            <ul class="license-facts">
                <li><span class="license-fact-label">Installed</span><span>${esc(installed ? 'nenva ' + this._v(installed) : 'nenva')}</span></li>
            </ul>
            ${state}
            <div class="feedback-actions">
                <a href="#" id="app-version-notes">What&rsquo;s in this version</a>
                <a href="#" id="app-version-all">All releases</a>
                <span class="spacer" style="flex:1"></span>
                ${action}
            </div>`;

        host.querySelector('#app-version-check')?.addEventListener('click', () => this.checkNow());
        host.querySelector('#app-version-install')?.addEventListener('click', () => this._requestInstall());
        host.querySelector('#app-version-notes')?.addEventListener('click', (e) => {
            e.preventDefault();
            if (typeof WhatsNew !== 'undefined' && WhatsNew.openReleaseNotes) WhatsNew.openReleaseNotes(installed);
        });
        host.querySelector('#app-version-all')?.addEventListener('click', (e) => {
            e.preventDefault();
            if (typeof WhatsNew !== 'undefined' && WhatsNew.openChangelog) WhatsNew.openChangelog();
        });
    },

    /** Check for updates from the Settings page; the answer is drawn in place. */
    async checkNow() {
        if (!window.electronUpdater) return;
        const before = this._status;
        this._setStatus({ phase: 'checking' });
        let res = null;
        try { res = await window.electronUpdater.check(); } catch (e) { res = { error: e.message }; }
        // An update found here arrives as updater:available and
        // has already replaced 'checking'; only settle what is still ours.
        if (this._status.phase !== 'checking') return;
        if (res && res.error) {
            this._setStatus({ phase: 'error', message: res.error });
        } else if (before.phase === 'ready' || this._downloaded) {
            this._setStatus({ phase: 'ready', version: this._version });
        } else {
            this._setStatus({ phase: 'latest' });
        }
    },

    /**
     * Install entry point for both the titlebar pill and the home card.
     * If AI work is mid-flight (a chat answer, email insights, a task
     * build…), restarting would silently throw that work away — so ask
     * first. Model warm-up and engine loads don't count: interrupting
     * them loses nothing, the model just reloads after the restart.
     */
    async _requestInstall() {
        const busy = this._runningAIActivities();
        if (busy.length > 0) {
            const esc = (s) => (typeof UIUtils !== 'undefined' && UIUtils.escapeHtml)
                ? UIUtils.escapeHtml(s) : String(s);
            const labels = [...new Set(busy.map(it => it.label))].map(esc).join(', ');
            const noun = busy.length > 1 ? 'these tasks' : 'this task';
            const confirmed = await UIUtils.confirm(
                'AI work in progress',
                `nenva is still working on: <strong>${labels}</strong>.<br><br>
                 Restarting now interrupts ${noun}. You can wait for it to finish —
                 the update also installs on its own the next time you quit.`,
                '&#9888;',
                { confirmText: 'Restart anyway', cancelText: 'Wait' }
            );
            if (!confirmed) return;
        }
        window.electronUpdater.install();
    },

    /** In-flight AI work worth protecting from a restart. */
    _runningAIActivities() {
        if (typeof AIActivity === 'undefined' || !AIActivity.active) return [];
        return [...AIActivity.active.values()]
            .filter(it => it.kind !== 'engine' && it.tag !== 'prewarm');
    },

    _show() {
        this._setStatus({ phase: 'ready', version: this._version });
        if (this._btnEl) this._btnEl.textContent = 'Install';
        if (this._pillEl) {
            if (this._textEl) {
                const v = this._version ? ' ' + this._version : '';
                this._textEl.textContent = 'Update' + v + ' ready';
            }
            this._pillEl.style.display = 'inline-flex';
        }
        this._renderHomeCard();
    },

    // The home-feed card — the pill's second, more visible surface. Renders
    // at the top of the home column once the download is ready. Dismissal is
    // per-version and machine-local (localStorage): updates are per-Mac, and
    // the next version's card should reappear. The titlebar pill stays either
    // way, and ignoring both is safe — the update installs on quit.
    _CARD_DISMISS_KEY: 'anjadhe_update_card_dismissed',

    _renderHomeCard() {
        if (!this._downloaded) return;
        const host = document.getElementById('dash-update-card');
        if (!host) return;

        let dismissedFor = null;
        try { dismissedFor = localStorage.getItem(this._CARD_DISMISS_KEY); } catch {}
        if (this._version && dismissedFor === this._version) return;

        const esc = (s) => (typeof UIUtils !== 'undefined' && UIUtils.escapeHtml)
            ? UIUtils.escapeHtml(s) : String(s);
        const v = this._version ? 'v' + String(this._version).replace(/^v/, '') : '';

        host.innerHTML = `
            <div class="dash-firstrun">
                <button type="button" class="dash-firstrun-dismiss" id="dash-update-dismiss"
                        title="Later — it installs when you quit" aria-label="Dismiss">&times;</button>
                <p class="dash-firstrun-kicker">Update ready</p>
                <h3 class="dash-firstrun-title">nenva ${esc(v)} is ready to install</h3>
                <p class="dash-firstrun-body">Installs automatically the next time you quit nenva.
                   Restart now to get it sooner.${this._version ? `
                   <a href="#" class="dash-update-notes-link" id="dash-update-notes">See what\u2019s in this release</a>` : ''}</p>
                <button type="button" class="primary-btn" id="dash-update-restart">Restart &amp; update</button>
            </div>`;
        host.style.display = '';

        // The notes are the "should I?" half of the nudge: read what the
        // incoming version changes before deciding to restart for it.
        document.getElementById('dash-update-notes')?.addEventListener('click', (e) => {
            e.preventDefault();
            if (typeof WhatsNew !== 'undefined' && WhatsNew.openReleaseNotes) {
                WhatsNew.openReleaseNotes(this._version);
            } else {
                window.electronAuth?.openExternal?.('https://github.com/Anjadhe/Anjadhe/releases');
            }
        });
        document.getElementById('dash-update-restart')?.addEventListener('click', () => {
            this._requestInstall();
        });
        document.getElementById('dash-update-dismiss')?.addEventListener('click', () => {
            if (this._version) {
                try { localStorage.setItem(this._CARD_DISMISS_KEY, this._version); } catch {}
            }
            host.innerHTML = '';
            host.style.display = 'none';
        });
    }
};
