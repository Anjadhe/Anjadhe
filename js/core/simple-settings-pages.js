/**
 * SimpleSettings › Backup, Lock, What left this Mac, About (2026-10-06, the
 * simplification, docs/SIMPLE_EXPERIENCE.md "Settings as ONE page").
 *
 * Until today these four rows opened the old full SettingsApp (the Storage
 * & Backup view, the Privacy & Security panel, the LLM Logs table, and the
 * version / feedback / license panels), each wearing that app's breadcrumb
 * and sibling cards. Now each is a page of the simple Settings in the
 * Model / Memory / Connectors shape, so nothing
 * on this page opens the full app.
 *
 * Nothing here is a second copy of the machinery:
 *  - Backup writes through window.electronBackup (main owns the settings)
 *    and the passphrase through SettingsApp._syncEncPrompt, the one flow.
 *  - Lock is AppManager's own auth state over window.electronAuth (Touch
 *    ID at open). The per-app lock stays under Advanced › Locked apps.
 *  - What left this Mac is LLMLogger's ledger (`left === true`) and
 *    SearchLogger's record, read as date · service · kind. Code's facts,
 *    no prompt text: the full log with prompts is the developer's view.
 *  - About hosts UpdaterUI.renderSettings(host) and
 *    SettingsApp._renderLicense(host), each given a host element instead of
 *    a fixed id, and the feedback form posts through FeedbackManager.send,
 *    with the disclosure read from the same collector send() uses.
 */
Object.assign(SimpleSettings, {

    // ── Backup ─────────────────────────────────────────────────────────

    async _backupHtml() {
        let st = { enabled: false, frequency: 'daily', lastBackup: null, backupPath: null };
        if (window.electronBackup && window.electronBackup.getSettings) {
            try { st = Object.assign(st, await window.electronBackup.getSettings()); } catch { /* main owns it */ }
        }
        this._backupState = st;
        let enc = null;
        if (window.electronSync && window.electronSync.encryptionStatus) {
            try { enc = await window.electronSync.encryptionStatus(); } catch { enc = null; }
        }
        const last = st.lastBackup ? this._when(st.lastBackup) : 'Never';
        const freq = { hourly: 'Every hour', daily: 'Every day', weekly: 'Every week' };
        const freqOpts = Object.entries(freq).map(([v, l]) => `<option value="${v}"${st.frequency === v ? ' selected' : ''}>${l}</option>`).join('');
        const detail = !st.enabled ? '' : `
                <button type="button" class="ss-row" data-ss="backup-folder">
                    <span class="ss-pick-copy"><span class="ss-label">Folder</span><span class="ss-sub">${this._esc(st.backupPath || 'Choose a folder')}</span></span><span class="ss-value">Change</span>${this._chev}
                </button>
                <label class="ss-row ss-field-row">
                    <span class="ss-label">How often</span>
                    <select class="ss-select" data-ss-select="backup-frequency" aria-label="How often to back up">${freqOpts}</select>
                </label>
                <div class="ss-row ss-field-row">
                    <span class="ss-pick-copy"><span class="ss-label">Last backup</span><span class="ss-sub">${this._esc(last)}</span></span>
                    <button type="button" class="ss-btn" data-ss="backup-now">Back up now</button>
                </div>`;
        return `<button type="button" class="ss-back" data-ss="back">‹ Settings</button>
            <h1 class="ss-title">Backup</h1>
            <p class="ss-lede">A copy of everything nenva keeps, written to a folder you choose. A backup can be opened on this Mac, or on another with your passphrase.</p>
            <div class="ss-group">
                <label class="ss-row ss-switch-row">
                    <span class="ss-pick-copy"><span class="ss-label">Back up nenva</span><span class="ss-sub">${st.enabled ? 'On' : 'Off'}</span></span>
                    <span class="settings-switch"><input type="checkbox" data-ss-switch="backup"${st.enabled ? ' checked' : ''} aria-label="Back up nenva"><span class="settings-switch-track"></span></span>
                </label>${detail}
            </div>
            ${this._passphraseHtml(enc)}
            <div class="ss-group">
                <button type="button" class="ss-row" data-ss="backup-restore">
                    <span class="ss-pick-copy"><span class="ss-label">Restore from a backup</span><span class="ss-sub">Pick a backup file; nenva replaces what it holds with it.</span></span>${this._chev}
                </button>
            </div>`;
    },

    /** The passphrase as ONE row: a sentence on where things stand and the one action that fits it (SettingsApp._renderSyncEncryption's states). */
    _passphraseHtml(enc) {
        if (!enc || !enc.state) return '';
        const copy = {
            passphrase: 'Set. Your backups open on any Mac with it.',
            mismatch: 'This Mac is on a different key, so your passphrase would not open its newest backups. Enter it to fix that.',
            locked: 'Locked. Enter your passphrase to resume backups on this Mac.',
            plaintext: 'Not set. Your backup key is unprotected in iCloud; a passphrase secures it.',
            'local-only': 'Not set. Backups open only on this Mac; a passphrase lets them open on another.',
            none: 'No backup key on this Mac.'
        }[enc.state] || '';
        const act = enc.locked ? ['unlock', 'Enter']
            : enc.state === 'mismatch' ? ['recover', 'Enter']
            : enc.upgradeable ? ['set', 'Set']
            : enc.state === 'passphrase' ? ['change', 'Change']
            : null;
        return `<div class="ss-group">
                <div class="ss-row ss-field-row">
                    <span class="ss-pick-copy"><span class="ss-label">Passphrase</span><span class="ss-sub${enc.state === 'locked' || enc.state === 'mismatch' ? ' ss-warn' : ''}">${this._esc(copy)}</span></span>
                    ${act ? `<button type="button" class="ss-btn" data-ss="passphrase" data-id="${act[0]}">${act[1]}</button>` : ''}
                </div>
            </div>`;
    },

    async _backupAct(kind, id, el) {
        if (!window.electronBackup) return;
        if (kind === 'backup') {
            el.disabled = true;
            try {
                await window.electronBackup.setEnabled(!!id);
                if (id) {
                    const r = await window.electronBackup.backupNow();
                    if (r && r.success) UIUtils.showToast('Backup on', 'success');
                    else if (r && r.error) UIUtils.showToast('Backup failed: ' + r.error, 'error');
                }
            } catch (err) { UIUtils.showToast(err && err.message ? err.message : 'Could not change that', 'error'); }
            finally { el.disabled = false; }
            this.render(); return;
        }
        if (kind === 'backup-folder') {
            const folder = window.electronDialog && window.electronDialog.selectFolder ? await window.electronDialog.selectFolder() : null;
            if (!folder) return;
            await window.electronBackup.setBackupPath(folder);
            UIUtils.showToast('Backup folder updated', 'success');
            this.render(); return;
        }
        if (kind === 'backup-frequency') { await window.electronBackup.setFrequency(id); return; }
        if (kind === 'backup-now') {
            el.disabled = true; el.textContent = 'Backing up…';
            try {
                const r = await window.electronBackup.backupNow();
                if (r && r.success) UIUtils.showToast('Backup completed', 'success');
                else UIUtils.showToast('Backup failed: ' + ((r && r.error) || 'unknown'), 'error');
            } catch (err) { UIUtils.showToast('Backup failed: ' + err.message, 'error'); }
            this.render(); return;
        }
        if (kind === 'backup-restore') { if (AppManager.showRestoreBackupPicker) await AppManager.showRestoreBackupPicker(); return; }
        if (kind === 'passphrase' && typeof SettingsApp !== 'undefined' && SettingsApp._syncEncPrompt) {
            await SettingsApp._syncEncPrompt(id);
            this.render();
        }
    },

    // ── Lock ───────────────────────────────────────────────────────────

    _lockHtml() {
        const avail = !!AppManager.authAvailable;
        const on = !!AppManager.authEnabled;
        const mins = [1, 2, 5, 10, 15, 30];
        const cur = Number(AppManager.autoLockTimeout) || 5;
        const opts = mins.map(m => `<option value="${m}"${cur === m ? ' selected' : ''}>${m} min</option>`).join('');
        return `<button type="button" class="ss-back" data-ss="back" data-id="privacy">‹ Privacy</button>
            <h1 class="ss-title">Lock nenva</h1>
            <p class="ss-lede">${avail
                ? 'Touch ID, or your Mac login password, before nenva opens and after it has sat idle.'
                : 'Locking nenva uses Touch ID, which this Mac does not have.'}</p>
            ${avail ? `<div class="ss-group">
                <label class="ss-row ss-switch-row">
                    <span class="ss-pick-copy"><span class="ss-label">Lock nenva</span><span class="ss-sub">${on ? 'On' : 'Off'}</span></span>
                    <span class="settings-switch"><input type="checkbox" data-ss-switch="lock"${on ? ' checked' : ''} aria-label="Lock nenva"><span class="settings-switch-track"></span></span>
                </label>
                ${on ? `<label class="ss-row ss-field-row">
                    <span class="ss-label">Lock after</span>
                    <select class="ss-select" data-ss-select="lock-after" aria-label="Lock after">${opts}</select>
                </label>` : ''}
            </div>` : ''}`;
    },

    async _lockAct(kind, id, el) {
        if (!window.electronAuth) return;
        if (kind === 'lock') {
            const on = !!id;
            el.disabled = true;
            try {
                if (on) {
                    const r = await window.electronAuth.promptTouchID();
                    if (!r || !r.success) { el.checked = false; return; }
                }
                AppManager.authEnabled = on;
                await window.electronAuth.setAuthEnabled(on);
                if (on) { AppManager.lastActivityTime = Date.now(); AppManager.startActivityTracking?.(); }
                else AppManager.stopActivityTracking?.();
            } finally { el.disabled = false; }
            this.render(); return;
        }
        if (kind === 'lock-after') {
            const minutes = parseInt(id, 10) || 5;
            AppManager.autoLockTimeout = minutes;
            await window.electronAuth.setAutoLockTimeout(minutes);
            AppManager.lastActivityTime = Date.now();
        }
    },

    // ── What left this Mac ─────────────────────────────────────────────

    /** Pure: the ledger as rows of {ts, service, kind}, newest first, from LLM calls that left and web searches. Pinned by tests/simple-settings-left-test.js. */
    leftRows(llmLogs, searchLogs, { limit = 200, kindOf } = {}) {
        const rows = [];
        for (const l of Array.isArray(llmLogs) ? llmLogs : []) {
            if (!l || l.left !== true) continue;
            rows.push({ ts: l.timestamp, service: l.destination || 'Left this Mac', kind: (kindOf ? kindOf(l.source) : null) || 'AI' });
        }
        for (const s of Array.isArray(searchLogs) ? searchLogs : []) {
            if (!s) continue;
            rows.push({ ts: s.timestamp, service: s.provider ? `${s.provider} search` : 'Web search', kind: 'Web search' });
        }
        rows.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
        return rows.slice(0, limit);
    },

    /** What kind of data a call carried: the surface the source tag belongs to (model-routing.js), in the person's words. */
    _kindOfSource(source) {
        try {
            const id = ModelRouting.surfaceOf(source);
            const s = ModelRouting.SURFACES.find(x => x.id === id);
            if (!s) return null;
            return { assistant: 'Chat', email: 'Mail and texts', documents: 'Documents', portfolio: 'Finance', routines: 'Routines and commitments', quick: 'Small jobs' }[s.id] || s.label;
        } catch { return null; }
    },

    _leftHtml() {
        const llm = typeof LLMLogger !== 'undefined' ? LLMLogger.logs : [];
        const search = typeof SearchLogger !== 'undefined' ? SearchLogger.logs : [];
        const rows = this.leftRows(llm, search, { kindOf: (s) => this._kindOfSource(s) });
        const head = `<button type="button" class="ss-back" data-ss="back" data-id="privacy">‹ Privacy</button>
            <h1 class="ss-title">What left this Mac</h1>
            <p class="ss-lede">Every call nenva made to a server off this Mac, newest first: when, where to, and what kind of thing it was about. What was sent is not shown here.</p>`;
        if (!rows.length) return head + '<div class="ss-group"><p class="ss-empty">Nothing has left this Mac.</p></div>';
        let day = '', html = '';
        for (const r of rows) {
            const d = this._day(r.ts);
            if (d !== day) { if (day) html += '</div>'; html += `<div class="ss-eyebrow">${this._esc(d)}</div><div class="ss-group ss-ledger">`; day = d; }
            html += `<div class="ss-row ss-ledger-row"><span class="ss-ledger-time">${this._esc(this._time(r.ts))}</span><span class="ss-label">${this._esc(r.service)}</span><span class="ss-value">${this._esc(r.kind)}</span></div>`;
        }
        return head + html + '</div>';
    },

    _day(ts) {
        const d = new Date(ts); if (isNaN(d)) return '';
        const today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1);
        const same = (a, b) => a.toDateString() === b.toDateString();
        if (same(d, today)) return 'Today';
        if (same(d, y)) return 'Yesterday';
        return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    },
    _time(ts) { const d = new Date(ts); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); },
    _when(ts) { const d = new Date(ts); return isNaN(d) ? '' : `${this._day(ts)} ${this._time(ts)}`; },

    // ── About ──────────────────────────────────────────────────────────

    _aboutHtml() {
        return `<button type="button" class="ss-back" data-ss="back">‹ Settings</button>
            <h1 class="ss-title">About</h1>
            <div class="ss-group ss-host" data-ss-host="version"><p class="ss-empty">Reading the version…</p></div>
            <div class="ss-group">
                <button type="button" class="ss-row" data-ss="page" data-id="feedback">
                    <span class="ss-pick-copy"><span class="ss-label">Send feedback</span><span class="ss-sub">To the person who makes nenva.</span></span>${this._chev}
                </button>
                <button type="button" class="ss-row" data-ss="page" data-id="registration">
                    <span class="ss-pick-copy"><span class="ss-label">Registration</span><span class="ss-sub">nenva is free. Registering is how release news reaches you.</span></span>${this._chev}
                </button>
                <button type="button" class="ss-row" data-ss="about-nenva">
                    <span class="ss-label">About nenva</span>${this._chev}
                </button>
            </div>`;
    },
    _fillAbout(wrap) {
        const host = wrap.querySelector('[data-ss-host="version"]');
        if (host && typeof UpdaterUI !== 'undefined' && UpdaterUI.renderSettings) UpdaterUI.renderSettings(host);
    },

    _feedbackHtml() {
        return `<button type="button" class="ss-back" data-ss="back" data-id="about">‹ About</button>
            <h1 class="ss-title">Send feedback</h1>
            <p class="ss-lede">What should be better? What broke? What do you wish nenva did? It goes straight to the person who wrote the app.</p>
            <div class="ss-group ss-form">
                <label class="ss-row ss-field-row">
                    <span class="ss-label">This is</span>
                    <select class="ss-select" data-ss-fb="kind"><option value="feedback">feedback or an idea</option><option value="support">a support request</option></select>
                </label>
                <textarea class="ss-textarea" data-ss-fb="message" rows="6" maxlength="4000" placeholder="Your message"></textarea>
                <input class="ss-input" data-ss-fb="email" type="email" autocomplete="off" placeholder="Your email (optional, only if you want a reply)">
                <label class="ss-row ss-switch-row">
                    <span class="ss-pick-copy"><span class="ss-label">Send app details</span><span class="ss-sub ss-fb-details"></span></span>
                    <span class="settings-switch"><input type="checkbox" data-ss-fb="details" checked aria-label="Send app details"><span class="settings-switch-track"></span></span>
                </label>
                <div class="ss-row ss-field-row">
                    <span class="ss-sub ss-fb-status" aria-live="polite"></span>
                    <button type="button" class="ss-btn ss-btn-primary" data-ss="feedback-send">Send</button>
                </div>
            </div>
            <p class="ss-foot">Nothing you have written in nenva goes with this: no mail, documents, commitments or chats. Only your message and, if ticked, the details above, over an encrypted connection. <button type="button" class="ss-link" data-ss="founder">Contact the founder</button> instead, if you would rather reach a person.</p>`;
    },
    /** The disclosure IS the payload: the details line is read from the collector send() uses, so what is shown cannot drift from what is sent. */
    async _fillFeedback(wrap) {
        const line = wrap.querySelector('.ss-fb-details');
        if (!line || typeof FeedbackManager === 'undefined') return;
        try { const d = await FeedbackManager.collectDiagnostics(); line.textContent = (d && d.details) || ''; } catch { line.textContent = ''; }
    },
    async _sendFeedback(wrap, btn) {
        if (typeof FeedbackManager === 'undefined') return;
        const q = (k) => wrap.querySelector(`[data-ss-fb="${k}"]`);
        const status = wrap.querySelector('.ss-fb-status');
        btn.disabled = true;
        if (status) { status.textContent = 'Sending…'; status.classList.remove('ss-warn'); }
        const r = await FeedbackManager.send({
            kind: q('kind') && q('kind').value,
            message: q('message') && q('message').value,
            email: q('email') && q('email').value,
            includeDetails: !q('details') || q('details').checked !== false
        });
        btn.disabled = false;
        if (r && r.success) { if (q('message')) q('message').value = ''; if (status) status.textContent = 'Sent. Thank you!'; }
        else if (status) { status.textContent = (r && r.error) || 'Could not send'; status.classList.add('ss-warn'); }
    },

    _registrationHtml() {
        return `<button type="button" class="ss-back" data-ss="back" data-id="about">‹ About</button>
            <h1 class="ss-title">Registration</h1>
            <div class="ss-group ss-host ss-license" data-ss-host="license"><p class="ss-empty">Reading…</p></div>`;
    },
    _fillRegistration(wrap) {
        const host = wrap.querySelector('[data-ss-host="license"]');
        if (host && typeof SettingsApp !== 'undefined' && SettingsApp._renderLicense) SettingsApp._renderLicense(host);
    }
});
