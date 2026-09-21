/**
 * UpdaterUI — renders the titlebar update pill and the download strip.
 *
 * Subscribes to the electron-updater events pushed from the main process
 * via window.electronUpdater. While a build downloads, a quiet strip in
 * the top-right corner (the "Set up more of Anjadhe" strip's shape, at
 * the top instead of the bottom — 2026-09-08 by request: a download the
 * user could not see ended in a restart banner that came from nowhere)
 * shows the version, a progress track and the percent; it can be
 * dismissed for that download and never asks for anything. When the
 * download is ready the strip goes and the pill appears next to the sync
 * indicator in the titlebar, with an "Install" button that triggers
 * quitAndInstall() through the preload bridge.
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

        this._btnEl.addEventListener('click', () => {
            if (this._blocked && !this._downloaded) { this._openLicense(); return; }
            this._requestInstall();
        });

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
            this._hideDownloading();
            this._show();
        });

        window.electronUpdater.onDownloadError?.((info) => {
            console.warn('[updater-ui] download failed:', info && info.message);
            this._showDownloadFailed(info);
        });

        window.electronUpdater.onManualCheckResult((result) => {
            this._handleManualCheck(result);
        });

        // The license gate declined to fetch a newer build (paid year over,
        // or an unlicensed trial that ended). Same pill, different sentence,
        // and its button opens Settings › License instead of installing.
        window.electronUpdater.onBlocked?.((info) => {
            this._showBlocked(info);
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
                } else if (state && state.blocked) {
                    this._showBlocked(state.blocked);
                } else if (state && state.downloading) {
                    this._version = state.downloading.version || this._version;
                    this._showDownloading(state.downloading);
                }
            }).catch(() => {});
        }
    },

    _blocked: null,

    // ── Download strip ──────────────────────────────────────────────────
    // Fixed top-right, under the titlebar; one element, built on first
    // use, hidden with `hidden` (never a stalled fade). Dismissal is per
    // download: a new version's download shows it again.
    _stripEl: null,
    _stripDismissedFor: null,
    _stripHideTimer: null,

    _strip() {
        if (this._stripEl) return this._stripEl;
        const el = document.createElement('div');
        el.className = 'updater-strip';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        el.hidden = true;
        el.innerHTML =
            `<span class="updater-strip-text"></span>
             <span class="updater-strip-track" aria-hidden="true"><span class="updater-strip-fill"></span></span>
             <span class="updater-strip-pct"></span>
             <button type="button" class="updater-strip-x" aria-label="Hide" title="Hide">&times;</button>`;
        el.querySelector('.updater-strip-x').addEventListener('click', () => {
            this._stripDismissedFor = this._version || '*';
            this._hideDownloading();
        });
        document.body.appendChild(el);
        this._stripEl = el;
        return el;
    },

    _showDownloading(info) {
        if (this._downloaded) return;
        const version = (info && info.version) || this._version;
        if (this._stripDismissedFor && this._stripDismissedFor === (version || '*')) return;
        const el = this._strip();
        if (this._stripHideTimer) { clearTimeout(this._stripHideTimer); this._stripHideTimer = null; }
        const pct = Math.max(0, Math.min(100, Math.round((info && info.percent) || 0)));
        const v = version ? ' v' + String(version).replace(/^v/, '') : '';
        el.classList.remove('is-failed');
        el.querySelector('.updater-strip-text').textContent = `Downloading Anjadhe${v}`;
        el.querySelector('.updater-strip-fill').style.width = pct + '%';
        el.querySelector('.updater-strip-pct').textContent = this._sizeText(info) || (pct + '%');
        el.hidden = false;
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
        const el = this._strip();
        const v = info && info.version ? ' v' + String(info.version).replace(/^v/, '') : '';
        el.classList.add('is-failed');
        el.querySelector('.updater-strip-text').textContent = `Could not download Anjadhe${v}. Anjadhe will try again later.`;
        el.querySelector('.updater-strip-fill').style.width = '0%';
        el.querySelector('.updater-strip-pct').textContent = '';
        el.hidden = false;
        if (this._stripHideTimer) clearTimeout(this._stripHideTimer);
        this._stripHideTimer = setTimeout(() => this._hideDownloading(), 12000);
    },

    _hideDownloading() {
        if (this._stripHideTimer) { clearTimeout(this._stripHideTimer); this._stripHideTimer = null; }
        if (this._stripEl) this._stripEl.hidden = true;
    },

    _showBlocked(info) {
        if (!info || this._downloaded || !this._pillEl) return;
        this._blocked = info;
        const v = info.version ? ' ' + String(info.version).replace(/^v/, '') : '';
        if (this._textEl) {
            this._textEl.textContent = info.reason === 'updates-ended'
                ? `Update${v} · updates ended`
                : `Update${v} · needs a license`;
        }
        if (this._btnEl) this._btnEl.textContent = 'License';
        this._pillEl.style.display = 'inline-flex';
    },

    _openLicense() {
        if (typeof HelpActions !== 'undefined') { HelpActions.open('license'); return; }
        if (typeof AppManager !== 'undefined') AppManager.openApp('settings');
        if (typeof SettingsApp !== 'undefined' && SettingsApp.openCategory) SettingsApp.openCategory('license');
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
                `Anjadhe is still working on: <strong>${labels}</strong>.<br><br>
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
        this._blocked = null;
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
                <h3 class="dash-firstrun-title">Anjadhe ${esc(v)} is ready to install</h3>
                <p class="dash-firstrun-body">Installs automatically the next time you quit Anjadhe.
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
                window.electronAuth?.openExternal?.('https://anjadhe.ai/changelog');
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
    },

    _handleManualCheck(result) {
        if (!result) return;

        // Error path — surface the reason so the user knows why nothing happened.
        if (result.error) {
            if (typeof UIUtils !== 'undefined' && UIUtils.showToast) {
                UIUtils.showToast('Update check failed: ' + result.error, 'error');
            }
            return;
        }

        // Success path. If a newer version exists, the normal update-available
        // event has already (or will shortly) fire and _show() will take over
        // once the download completes. If not, let the user know explicitly
        // that they're on the latest — otherwise the menu click feels like a
        // silent no-op.
        if (!this._downloaded && !this._version) {
            if (typeof UIUtils !== 'undefined' && UIUtils.showToast) {
                UIUtils.showToast('You are on the latest version.', 'success');
            }
        }
    }
};
