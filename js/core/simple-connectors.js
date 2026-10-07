/**
 * SimpleSettings › Connectors (2026-10-05, by request) — the third row of
 * the simple Settings: a searchable list of the outside sources nenva can
 * read, each with its own small page in the Model / Memory shape.
 *
 * Since 2026-10-06 the list IS the Sources registry (js/core/sources.js,
 * docs/VISION.md "Sources"): a connector is a registered source, its row
 * value is the source's status, its page is the builder the source names.
 * Nothing here is a second copy of the machinery: Google goes through
 * AccountsManager and SettingsApp's own connect / remove, Apple through
 * AppleImport and SettingsApp's own import runners, texts through
 * IMessageSource, Files through electronLibrary, so All settings › Accounts
 * and these pages are two views of the same state.
 */
Object.assign(SimpleSettings, {
    _ICON: {
        mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
        calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
        check: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
        plug: '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>',
        text: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12Z"/>',
        file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
        note: '<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/>'
    },
    /** The registered sources (js/core/sources.js), in registration order. A method: Object.assign would freeze a getter's first value. */
    connectors() { return typeof Sources !== 'undefined' ? Sources.list() : []; },

    _googleAccounts() { return typeof AccountsManager !== 'undefined' ? AccountsManager.getAll() : []; },
    _googleOn(c) {
        return this._googleAccounts().filter(a => !AccountsManager.isLocallyDisconnected(a.email) && AccountsManager.isServiceEnabled(a.email, c.google));
    },
    _appleOn(c) {
        if (typeof AppleImport === 'undefined') return false;
        return c.apple === 'events' ? AppleImport.eventsEnabled() : AppleImport.enabled();
    },
    _connectorOn(c) { return typeof Sources !== 'undefined' ? Sources.status(c).on : false; },
    /** The value on a connector's row in the list: the source's own status. */
    _connectorValue(c) { return typeof Sources !== 'undefined' ? Sources.status(c).value : ''; },
    connectorsSummary() {
        const n = this.connectors().filter(c => this._connectorOn(c)).length;
        return n ? `${n} on` : 'None yet';
    },

    _switch(checked, data) {
        return `<span class="settings-switch"><input type="checkbox" ${checked ? 'checked' : ''} ${data}><span class="settings-switch-track"></span></span>`;
    },
    /** A row that is a label + one line under it + a switch. */
    _switchRow(label, sub, checked, data) {
        return `<label class="ss-row ss-two"><span class="ss-pick-copy"><span class="ss-label">${this._esc(label)}</span>${sub ? `<span class="ss-sub">${this._esc(sub)}</span>` : ''}</span>${this._switch(checked, data)}</label>`;
    },

    // ── The list ───────────────────────────────────────────────────────

    _connectorsHtml() {
        const rows = this.connectors().map(c => `<button type="button" class="ss-row" data-ss="page" data-id="connector:${c.id}" data-find="${this._esc(`${c.label} ${c.words}`.toLowerCase())}">
                    ${this._tile(this._ICON[c.icon])}
                    <span class="ss-label">${this._esc(c.label)}</span><span class="ss-value">${this._esc(this._connectorValue(c))}</span>${this._chev}
                </button>`).join('');
        return `<button type="button" class="ss-back" data-ss="back">‹ Settings</button>
            <h1 class="ss-title">Connectors</h1>
            <p class="ss-lede">Where nenva reads from. Everything is read on this Mac and organized into what needs you; a source is never copied into a page of its own.</p>
            <input type="search" class="ss-search" placeholder="Search connectors" aria-label="Search connectors" autocomplete="off" spellcheck="false">
            <div class="ss-group ss-connectors">${rows}</div>
            <p class="ss-empty ss-none" hidden>No connector by that name.</p>`;
    },
    _filterConnectors(q) {
        const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
        const rows = [...document.querySelectorAll('#simplesettings-view .ss-connectors .ss-row')];
        let shown = 0;
        for (const r of rows) {
            const hit = words.every(w => r.dataset.find.includes(w));
            r.hidden = !hit;
            if (hit) shown++;
        }
        const group = document.querySelector('#simplesettings-view .ss-connectors');
        const none = document.querySelector('#simplesettings-view .ss-none');
        if (group) group.hidden = !shown;
        if (none) none.hidden = !!shown;
    },

    // ── One connector ──────────────────────────────────────────────────

    _connectorHtml(id) {
        const c = this.connectors().find(x => x.id === id);
        if (!c) return this._connectorsHtml();
        const head = `<button type="button" class="ss-back" data-ss="back" data-id="connectors">‹ Connectors</button>
            <h1 class="ss-title">${this._esc(c.label)}</h1>`;
        let body = '';
        try { body = typeof c.page === 'function' ? c.page(this, c) : ''; } catch (e) { body = `<p class="ss-lede">${this._esc(e && e.message || 'Not available')}</p>`; }
        return head + (body || '<p class="ss-lede">Not available on this Mac.</p>');
    },

    // ── Texts (iMessage) ───────────────────────────────────────────────
    // The consent is asked HERE, at connect (docs/VISION.md "Sources"): the
    // source's own sentence, then whether the person's AI may read texts
    // (the `messages` CloudPrivacy class, off by default).
    _textsHtml(c) {
        if (typeof IMessageSource === 'undefined') return '<p class="ss-lede">Not available on this Mac.</p>';
        const st = IMessageSource.state();
        const on = !!st.enabled;
        const sub = !on ? 'Off — your texts are not read' : st.lastError ? st.lastError : st.lastAt
            ? `Last checked ${UIUtils.formatDateTime(st.lastAt)} · ${st.conversations} conversation${st.conversations === 1 ? '' : 's'} read` : 'On. Checking for new texts';
        const fda = on && st.lastErrorReason === 'fda'
            ? '<p class="ss-foot">How to allow it: System Settings › Privacy & Security › Full Disk Access, the + button, then nenva from Applications (still called Anjadhe there if this Mac updated from it). Quit nenva, open it again, then Check now.</p>' : '';
        const ai = typeof CloudPrivacy !== 'undefined' ? CloudPrivacy.isEnabled('messages') : false;
        const brainLeaves = (() => { try { return typeof CloudPrivacy !== 'undefined' && CloudPrivacy.brainLeaves(); } catch { return false; } })();
        return `<p class="ss-lede">${this._esc(c.reads)}</p>
            <p class="ss-lede">${this._esc(c.consent)}</p>
            <div class="ss-group">${this._switchRow('Read my texts', sub, on, 'data-ss-switch="texts"')}
                ${on ? `<button type="button" class="ss-row" data-ss="texts-check"><span class="ss-label">Check now</span>${this._chev}</button>` : ''}</div>
            <div class="ss-group">${this._switchRow('Let my AI read them', brainLeaves ? (ai ? 'What your AI needs from a text may be sent to your model.' : 'Your texts stay on this Mac; nenva reads them here only.') : 'Your AI runs on this Mac, so nothing leaves either way.', ai, 'data-ss-switch="texts-ai"')}</div>
            ${fda}
            <p class="ss-foot">Turn this on for one Mac. Turning it off forgets the conversations it read; commitments you got from them stay.</p>`;
    },

    // ── Apple Notes (index only, js/core/apple-notes-source.js) ────────
    _appleNotesHtml(c) {
        if (typeof AppleNotesSource === 'undefined' || !window.electronAppleImport?.notesMeta) return '<p class="ss-lede">Not available on this Mac.</p>';
        const on = AppleNotesSource.enabled(), st = AppleNotesSource.state();
        const k = st.counts || {};
        const sub = !on ? 'Off — your notes are not read' : st.lastError ? st.lastError : st.lastAt
            ? `Last read ${UIUtils.formatDateTime(st.lastAt)} · ${k.notes || 0} notes indexed${k.locked ? `, ${k.locked} locked skipped` : ''}` : 'On. First read running';
        return `<p class="ss-lede">${this._esc(c.reads)}</p>
            <div class="ss-group">${this._switchRow('Index my Apple Notes', sub, on, 'data-ss-switch="applenotes"')}
                ${on ? `<button type="button" class="ss-row" data-ss="applenotes-check"><span class="ss-label">Read again now</span>${this._chev}</button>` : ''}</div>
            <p class="ss-foot">Read on this Mac through the Notes app (macOS asks once). Turn this on for one Mac. Turning it off forgets the index; your notes are untouched.</p>`;
    },

    // ── Files (the Documents library) ──────────────────────────────────
    _filesHtml(c) {
        if (!window.electronLibrary) return '<p class="ss-lede">Not available on this Mac.</p>';
        const st = (typeof ReaderApp !== 'undefined' && ReaderApp._status) || {};
        const dir = st.dir || '~/nenva/library';
        const count = st.docs ? `${st.docs} document${st.docs === 1 ? '' : 's'}, ${st.chunks || 0} passages indexed` : 'Nothing in it yet';
        return `<p class="ss-lede">${this._esc(c.reads)}</p>
            <div class="ss-group">
                <button type="button" class="ss-row" data-ss="files-open"><span class="ss-pick-copy"><span class="ss-label">Your library folder</span><span class="ss-sub">${this._esc(dir)} · ${this._esc(count)}</span></span><span class="ss-value">Open</span>${this._chev}</button>
                <button type="button" class="ss-row" data-ss="files-app"><span class="ss-label">See your documents</span>${this._chev}</button>
            </div>
            <p class="ss-foot">Drop a file in the folder and nenva reads it here. Nothing is uploaded.</p>`;
    },

    _googleHtml(c) {
        const mail = c.google === 'mail';
        const accounts = this._googleAccounts();
        const lede = mail
            ? 'Mail syncs from Google straight to this Mac and your model reads it here. nenva shows what needs you; nothing is sent from here without you.'
            : 'Your Google events show in Today and the assistant can read them. Events you add or change in nenva are written to Google Calendar.';
        if (!accounts.length) {
            return `<p class="ss-lede">${lede}</p>
                <div class="ss-group"><button type="button" class="ss-row" data-ss="google-connect"><span class="ss-label ss-accent">Connect Google</span><span class="ss-value"></span>${this._chev}</button></div>
                <p class="ss-foot">One sign-in connects both Gmail and Google Calendar.</p>`;
        }
        const rows = accounts.map(a => {
            const email = this._esc(a.email);
            if (AccountsManager.isLocallyDisconnected(a.email)) {
                return `<button type="button" class="ss-row ss-two" data-ss="google-connect"><span class="ss-pick-copy"><span class="ss-label">${email}</span><span class="ss-sub">Connected on another Mac. Sign in once to use it here.</span></span><span class="ss-value ss-accent">Sign in</span></button>`;
            }
            const on = AccountsManager.isServiceEnabled(a.email, c.google);
            return this._switchRow(a.email, on ? (mail ? 'Reading mail' : 'Showing events') : 'Off', on, `data-ss-toggle="google" data-email="${email}" data-service="${c.google}"`);
        }).join('');
        const removes = accounts.map(a => `<button type="button" class="ss-row" data-ss="google-remove" data-email="${this._esc(a.email)}"><span class="ss-label ss-danger">Remove ${this._esc(a.email)}</span></button>`).join('');
        return `<p class="ss-lede">${lede}</p>
            <div class="ss-group">${rows}</div>
            <div class="ss-group"><button type="button" class="ss-row" data-ss="google-connect"><span class="ss-label ss-accent">Add a Google account</span><span class="ss-value"></span>${this._chev}</button></div>
            <div class="ss-group">${removes}</div>
            <p class="ss-foot">An account is shared by Gmail and Google Calendar. Removing it clears its mail and events from nenva; they stay in Google.</p>`;
    },

    _appleHtml(c) {
        if (typeof AppleImport === 'undefined') return '<p class="ss-lede">Not available on this Mac.</p>';
        const events = c.apple === 'events';
        const st = AppleImport.state();
        const on = this._appleOn(c);
        const err = events ? st.eventsLastError : st.lastError;
        const at = events ? st.eventsLastAt : st.lastAt;
        const k = (events ? st.eventsCounts : st.counts) || {};
        const sub = !on ? 'Off' : err ? err : at
            ? `Last read ${UIUtils.formatDateTime(at)} · ${events ? `${k.events || 0} events from ${k.calendars || 0} calendars` : `${k.created || 0} added, ${k.updated || 0} updated`}`
            : 'On. First read running';
        const lede = events
            ? 'Shows this Mac’s iCloud and local calendars in nenva, kept current on its own. Events you add or change here are written to Apple Calendar.'
            : 'Brings this Mac’s iCloud reminders into nenva as commitments. Reminders stays the truth: marking one done, dropped or removed here, or giving it a new date or title, is written back to Reminders.';
        const lists = !events && on ? (st.lists || []) : [];
        const picked = (AppleImport.prefs() || {}).reminderLists;
        return `<p class="ss-lede">${lede}</p>
            <div class="ss-group">${this._switchRow(events ? 'Show Apple Calendar' : 'Read Apple Reminders', sub, on, `data-ss-toggle="apple" data-kind="${c.apple}"`)}</div>
            ${lists.length ? `<p class="ss-eyebrow">Lists</p><div class="ss-group">${lists.map(name =>
                this._switchRow(name, '', !picked || picked.includes(name), `data-ss-toggle="apple-list" data-list="${this._esc(name)}"`)).join('')}</div>` : ''}
            ${on ? `<div class="ss-group"><button type="button" class="ss-row" data-ss="apple-import" data-kind="${c.apple}"><span class="ss-label ss-accent">${this._busy === c.apple ? 'Reading…' : 'Read again now'}</span></button></div>` : ''}
            <p class="ss-foot">Turning this off removes ${events ? 'the events' : 'the imported reminders'} from nenva. They stay in Apple ${events ? 'Calendar' : 'Reminders'}.</p>`;
    },

    // ── Actions ────────────────────────────────────────────────────────

    async _appleImport(kind) {
        if (typeof SettingsApp === 'undefined' || this._busy) return;
        this._busy = kind; this.render();
        try { await (kind === 'events' ? SettingsApp._runAppleEventsImport() : SettingsApp._runAppleImport()); }
        finally { this._busy = null; this.render(); }
    },

    async _connectorClick(ss, b) {
        if (ss === 'applenotes-check' && typeof AppleNotesSource !== 'undefined') { await AppleNotesSource.sync('settings'); this.render(); return; }
        if (ss === 'texts-check' && typeof IMessageSource !== 'undefined') {
            const probe = await IMessageSource.probe();
            if (probe.ok) await IMessageSource.tick('settings');
            this.render(); return;
        }
        if (ss === 'files-open' && window.electronLibrary) { try { await window.electronLibrary.openFolder(); } catch { /* the folder may be gone */ } return; }
        if (ss === 'files-app') { AppManager.openAppFromLauncher('reader'); return; }
        if (typeof SettingsApp === 'undefined') return;
        if (ss === 'google-connect') { await SettingsApp._connectGoogleAccount(); this.render(); }
        if (ss === 'google-remove') { await SettingsApp._disconnectGoogleAccount(b.dataset.email); this.render(); }
        if (ss === 'apple-import') await this._appleImport(b.dataset.kind);
    },

    async _onChange(e) {
        const sw = e.target.closest('[data-ss-switch]');
        if (sw) { await this._flip(sw.dataset.ssSwitch, sw.checked, sw); return; }
        const input = e.target.closest('[data-ss-toggle]');
        if (!input) return;
        const kind = input.dataset.ssToggle;
        const on = input.checked;
        if (kind === 'google') {
            AccountsManager.setServiceEnabled(input.dataset.email, input.dataset.service, on);
            this.render();
        } else if (kind === 'apple-list') {
            const all = [...document.querySelectorAll('#simplesettings-view [data-ss-toggle="apple-list"]')];
            const picked = all.filter(i => i.checked).map(i => i.dataset.list);
            // Every list on stores null ("all"), so a NEW list is included by default.
            AppleImport.savePrefs({ reminderLists: picked.length === all.length ? null : picked });
        } else if (kind === 'apple') {
            const events = input.dataset.kind === 'events';
            if (events) AppleImport.setEventsEnabled(on); else AppleImport.setEnabled(on);
            if (!on) {
                const n = events ? AppleImport.removeImportedEvents() : AppleImport.removeImportedReminders();
                if (n) UIUtils.showToast(events ? `Removed ${n} event${n === 1 ? '' : 's'}; still in Apple Calendar` : `Removed ${n} task${n === 1 ? '' : 's'}; still in Apple Reminders`, 'info');
                this.render();
            } else await this._appleImport(input.dataset.kind);
        }
    }
});
