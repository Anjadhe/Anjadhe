/**
 * SettingsVoice — Settings › Writing voice (2026-09-02).
 *
 * The user's own writing voice is a SETTING, not an app: turn it on, pick
 * what it learns from (documents you add, Notes, Journal, sent emails),
 * press Study, read and edit the guide it writes. Drafting in the voice is
 * something the assistant does when asked ("write this in my voice") —
 * the draft_in_style tool (js/agent/voice-tools.js) fetches the kit this
 * page maintains. The one door out of here is "Draft in my voice…",
 * which opens a pre-scoped chat.
 *
 * Renders into the `voice` settings panel's #settings-voice-body on every
 * open (SettingsApp.openCategory) — source counts and document status
 * change underneath it. Controls look like controls (switch cards, a
 * bounded guide panel, quoted exemplars); the vocabulary is the More-apps
 * page's. Storage + laws: js/core/voice-store.js; the study pass:
 * js/core/voice-service.js.
 */
const SettingsVoice = {
    _wired: false,
    _listing: { docs: [] },

    _body() { return document.getElementById('settings-voice-body'); },

    /** Is the Writing voice panel the one on screen? */
    isOpen() {
        const panel = document.querySelector('#settings-detail .settings-panel[data-cat="voice"]');
        const view = document.getElementById('settings-view');
        return !!(panel && panel.classList.contains('active') && view && view.classList.contains('active'));
    },

    async render() {
        const body = this._body();
        if (!body) return;
        if (!this._wired) {
            this._wired = true;
            const panel = body.closest('.settings-panel');
            this._wireDrop(panel);
            this._wireDepth();
            try {
                window.electronLibrary.onProgress(() => { if (this.isOpen()) this.render(); });
            } catch { /* preload API missing — page still renders */ }
        }
        if (typeof VoiceStore === 'undefined') {
            body.innerHTML = '<p class="voice-none">The writing voice is not available in this build.</p>';
            return;
        }
        VoiceStore.adoptSelfOnce();
        try {
            // Documents are one source; the listing tells the page what the
            // folder holds. Missing IPC = no documents, the page still works.
            this._listing = window.electronLibrary ? await window.electronLibrary.list() : { docs: [] };
        } catch { this._listing = { docs: [] }; }
        if (!this.isOpen()) return;   // navigated away mid-await
        const voice = VoiceStore.selfVoice();
        body.innerHTML = voice ? this._voiceHtml(voice) : this._enableHtml();
        if (voice) this._bindVoice(body, voice);
        else this._bindEnable(body);
    },

    // ── Sources ────────────────────────────────────────────────────────

    /**
     * Live counts for the source picker. Email count is null until the
     * mailbox has loaded this session (bodies live in SQLite; Settings must
     * not block on them) — the label then just omits the number.
     */
    _sourceCounts() {
        let notes = 0, journal = 0, emails = null, accounts = 0;
        try {
            // Same predicate the study samples with (user prose only — no
            // prompt notes, no AI-written feed/assistant notes), so the
            // count can't promise material the study will then skip.
            notes = ((StorageManager.get('notes')?.notes) || [])
                .filter(n => VoiceService._userProseNote(n)).length;
        } catch { /* count stays 0 */ }
        try { journal = ((StorageManager.get('journal')?.entries) || []).length; } catch { /* 0 */ }
        try { accounts = ((StorageManager.get('email')?.accounts) || []).length; } catch { /* 0 */ }
        try {
            if (typeof EmailApp !== 'undefined' && EmailApp._dataLoaded === true) {
                emails = (EmailApp.emails || []).filter(e => (e.labels || []).includes('SENT')).length;
            }
        } catch { /* stays null */ }
        return { notes, journal, emails, accounts };
    },

    _icons() {
        const svg = (paths) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
        return {
            documents: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
            notes: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
            journal: svg('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'),
            emails: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>')
        };
    },

    /** Source labels + counts, shared by the enable rows and the switch cards. */
    _sourceMeta(counts, docCount) {
        return {
            documents: { label: 'Documents', count: docCount ? `${docCount} file${docCount === 1 ? '' : 's'}` : 'add or drop files', disabled: false },
            notes: { label: 'Notes', count: counts.notes ? `${counts.notes} note${counts.notes === 1 ? '' : 's'}` : 'none yet', disabled: false },
            journal: { label: 'Journal', count: counts.journal ? `${counts.journal} ${counts.journal === 1 ? 'entry' : 'entries'}` : 'none yet', disabled: false },
            emails: {
                label: 'Sent emails',
                count: counts.accounts
                    ? `${counts.emails != null ? `${counts.emails} sent · ` : ''}only what you wrote — quoted replies and signatures are left out`
                    : 'no email account connected',
                disabled: !counts.accounts
            }
        };
    },

    // ── Off: the enable card ───────────────────────────────────────────

    _enableHtml() {
        const esc = (s) => UIUtils.escapeHtml(String(s || ''));
        const counts = this._sourceCounts();
        const meta = this._sourceMeta(counts, 0);
        const defaults = { documents: true, notes: false, journal: false, emails: false };
        const row = (key) => `
            <label class="voice-source-row${meta[key].disabled ? ' is-disabled' : ''}">
                <input type="checkbox" data-self-src="${key}" ${defaults[key] && !meta[key].disabled ? 'checked' : ''} ${meta[key].disabled ? 'disabled' : ''}>
                <span class="voice-source-text"><strong>${esc(meta[key].label)}</strong> <span class="voice-source-hint">${esc(meta[key].count)}</span></span>
            </label>`;
        return `
            <div class="settings-card voice-enable">
                <div class="settings-card-title">Let the assistant learn how you write</div>
                <p class="settings-card-hint">Turn this on and Anjadhe studies your own writing — then, when you ask for a draft "in my voice", it sounds like you rather than like an AI. Pick what it may learn from. Nothing is read until you press Study, and the study runs on the AI model you chose.</p>
                ${VoiceStore.SOURCE_KEYS.map(row).join('')}
                <div class="voice-enable-actions">
                    <button type="button" class="primary-btn" id="settings-voice-enable-btn">Turn on</button>
                    <button type="button" class="voice-ex-btn voice-help-link" data-voice-help>How it works</button>
                </div>
            </div>`;
    },

    _bindEnable(body) {
        body.querySelector('[data-voice-help]')?.addEventListener('click', () => this._openHelp());
        const btn = body.querySelector('#settings-voice-enable-btn');
        if (!btn) return;
        btn.addEventListener('click', async () => {
            const sources = {};
            body.querySelectorAll('[data-self-src]').forEach(cb => { sources[cb.dataset.selfSrc] = cb.checked; });
            if (!Object.values(sources).some(Boolean)) {
                UIUtils.showToast('Pick at least one source to learn from', 'info');
                return;
            }
            btn.disabled = true;
            // The voice's own Library folder holds the documents source.
            let folder = { collection: VoiceStore.SELF_NAME };
            if (window.electronLibrary) {
                try { folder = await window.electronLibrary.createCollection(VoiceStore.SELF_NAME); } catch (e) { folder = { error: e.message }; }
                if (folder.error) { UIUtils.showToast(folder.error, 'error'); btn.disabled = false; return; }
            }
            const res = VoiceStore.createSelf(sources, folder.collection);
            if (res.error) { UIUtils.showToast(res.error, 'error'); btn.disabled = false; return; }
            this.render();
        });
    },

    // ── On: the voice's page ───────────────────────────────────────────

    /**
     * Section order follows study state: once studied the page leads with
     * what the voice IS (draft door, guide, its words) and the sources and
     * documents settle below as its settings; unstudied keeps the teach-it
     * order, material in → guide out.
     */
    _voiceHtml(voice) {
        const esc = (s) => UIUtils.escapeHtml(String(s || ''));
        const c = voice.collection || '';
        const docs = (this._listing.docs || []).filter(d => (d.collection || '') === c);
        const indexed = docs.filter(d => d.status === 'indexed').length;
        const exemplars = VoiceStore.exemplarsFor(c);
        const running = typeof VoiceService !== 'undefined' && VoiceService.isRunning(c);
        const sources = VoiceStore.sourcesOf(voice);
        const counts = this._sourceCounts();
        const studied = !!(voice.body || '').trim();
        // What can a study actually read? Any enabled source with content
        // (emails count as having content once an account is connected —
        // the mailbox may not be loaded yet, and the study loads it itself).
        const studiable = (sources.documents && indexed > 0)
            || (sources.notes && counts.notes > 0)
            || (sources.journal && counts.journal > 0)
            || (sources.emails && counts.accounts > 0);

        // The head carries the page's actions: drafting is the product, so
        // a studied voice leads with it; the study is maintenance. Unstudied,
        // Study IS the page's one action.
        const studyBtn = `<button type="button" class="${studied ? 'secondary-btn' : 'primary-btn'}" data-voice-study ${running || !studiable ? 'disabled' : ''}>
                ${running ? 'Studying…' : (studied ? 'Re-study' : 'Study')}
            </button>`;
        const headActions = studied
            ? `<button type="button" class="primary-btn" data-voice-draft>Draft in my voice&hellip;</button>${studyBtn}`
            : studyBtn;

        // One padded settings card holds the whole page (the group border
        // alone put the head and the footer flush against its edge).
        let html = `<div class="settings-card voice-page">
            <div class="voice-head">
                <h4 class="voice-title">${esc(voice.name || VoiceStore.SELF_NAME)}</h4>
                <span class="voice-head-actions">${headActions}</span>
            </div>
            <div class="voice-meta">${esc(this._meta(voice, sources, docs, indexed))}</div>`;

        const secHead = (title, action = '') => `
            <div class="voice-sec-head">
                <span class="voice-sec-title">${title}</span>${action}
            </div>`;

        const sourcesHtml = secHead('Learns from')
            + `<div class="voice-source-grid">${this._sourceCardsHtml(sources, counts, docs.length)}</div>`;

        let docsHtml = secHead('Documents',
            window.electronLibrary
                ? `<button type="button" class="secondary-btn voice-sec-btn" data-voice-add>Add documents&hellip;</button>` : '');
        if (!docs.length) {
            docsHtml += `<p class="voice-none">Posts, essays, reports, speeches of yours — add files or drag them onto this page.</p>`;
        } else {
            docsHtml += docs.map(d => this._docRowHtml(d)).join('');
            if (!sources.documents) {
                docsHtml += `<p class="voice-none">Documents are switched off — these files stay put but the study skips them.</p>`;
            }
        }

        let hintHtml = '';
        if (!studied && !running && studiable) {
            hintHtml = `<p class="voice-none">Ready to study — Study reads a sample of your selected sources on your chosen AI model and writes the first draft of the guide.</p>`;
        } else if (!studied && !running && docs.length && !indexed) {
            hintHtml = `<p class="voice-none">Indexing the documents… Study unlocks when they're ready.</p>`;
        }

        let guideHtml = '';
        if (studied || voice.userEdited) {
            guideHtml = secHead('How you write',
                voice.userEdited ? `<span class="voice-guide-edited">edited by you — kept through re-studies</span>` : '')
                + `<div class="voice-guide-card">
                <textarea class="voice-guide" data-voice-edit
                          maxlength="${VoiceStore.PAGE_CHAR_BUDGET}"
                          aria-label="Your style guide"
                          placeholder="How you write — tone, rhythm, vocabulary, moves. Edit freely; your edits survive re-studies.">${esc(voice.body || '')}</textarea>
            </div>`;
        }

        let exHtml = '';
        if (exemplars.length) {
            exHtml = secHead('In your words');
            for (const ex of exemplars) {
                exHtml += `
                <div class="voice-ex">
                    <p class="voice-ex-text">${esc(ex.text)}</p>
                    <div class="voice-ex-meta">
                        <span class="voice-ex-from" title="${esc(ex.docTitle)}">${esc(ex.docTitle)}</span>
                        <button type="button" class="voice-ex-btn${ex.pinned ? ' is-pinned' : ''}" data-voice-pin="${esc(ex.id)}">${ex.pinned ? 'Pinned' : 'Pin'}</button>
                        <button type="button" class="voice-ex-btn voice-ex-remove" data-voice-remove="${esc(ex.id)}">Remove</button>
                    </div>
                </div>`;
            }
        }

        html += studied
            ? guideHtml + exHtml + sourcesHtml + docsHtml + hintHtml
            : sourcesHtml + docsHtml + hintHtml + guideHtml + exHtml;

        html += `<div class="voice-footer">
                <button type="button" class="voice-ex-btn voice-off-btn" data-voice-off>Turn off</button>
                <button type="button" class="voice-ex-btn" data-voice-help>How it works</button>
            </div></div>`;
        return html;
    },

    _meta(voice, sources, docs, indexed) {
        const bits = [];
        const from = [
            sources.documents ? 'documents' : null,
            sources.notes ? 'notes' : null,
            sources.journal ? 'journal' : null,
            sources.emails ? 'sent emails' : null
        ].filter(Boolean).join(', ');
        bits.push(from ? `learns from ${from}` : 'no sources selected');
        if (docs.length && indexed < docs.length) bits.push(`${docs.length - indexed} still indexing`);
        if (voice.lastStudiedAt) bits.push(`studied ${new Date(voice.lastStudiedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`);
        if (voice.userEdited) bits.push('guide edited by you — studies keep your edits');
        return bits.join(' · ');
    },

    /** Source switch CARDS — icon, name, count, `.settings-switch` (the More-apps recipe). */
    _sourceCardsHtml(sources, counts, docCount) {
        const esc = (s) => UIUtils.escapeHtml(String(s || ''));
        const icons = this._icons();
        const meta = this._sourceMeta(counts, docCount);
        return VoiceStore.SOURCE_KEYS.map(key => {
            const m = meta[key];
            const on = sources[key] && !m.disabled;
            return `
            <div class="voice-source-card${on ? '' : ' is-off'}">
                <span class="voice-source-card-icon">${icons[key]}</span>
                <span class="voice-source-card-name">${esc(m.label)}</span>
                <label class="settings-switch" title="${on ? 'On' : 'Off'}">
                    <input type="checkbox" data-self-src="${key}" ${on ? 'checked' : ''} ${m.disabled ? 'disabled' : ''} aria-label="Learn from ${esc(m.label)}">
                    <span class="settings-switch-track"></span>
                </label>
                <span class="voice-source-card-count">${esc(m.count)}</span>
            </div>`;
        }).join('');
    },

    _docRowHtml(d) {
        const esc = (s) => UIUtils.escapeHtml(String(s || ''));
        const ext = ((String(d.relpath || '').match(/\.(\w+)$/) || [])[1] || '').toUpperCase().slice(0, 4);
        const status = d.status === 'indexed'
            ? `${d.chunkCount} passage${d.chunkCount === 1 ? '' : 's'}`
            : (d.status === 'error' ? `couldn't index — ${d.error || 'unknown error'}` : 'waiting…');
        return `
            <div class="voice-doc-row" data-voice-doc="${esc(d.id)}">
                <span class="voice-doc-ext">${esc(ext)}</span>
                <span class="voice-doc-title" title="${esc(d.relpath)}">${esc(d.title)}</span>
                <span class="voice-doc-meta">${esc(status)}</span>
                <button type="button" class="voice-ex-btn voice-doc-remove" data-voice-doc-remove="${esc(d.id)}" title="Move the file to the Trash">Remove</button>
            </div>`;
    },

    _bindVoice(body, voice) {
        const c = voice.collection || '';

        // Source switches: a flip saves immediately and applies at the next
        // study — Study stays the consent to read.
        body.querySelectorAll('.voice-source-grid [data-self-src]').forEach(cb => {
            cb.addEventListener('change', () => {
                const sources = {};
                body.querySelectorAll('.voice-source-grid [data-self-src]').forEach(x => {
                    sources[x.dataset.selfSrc] = x.checked;
                });
                if (!Object.values(sources).some(Boolean)) {
                    UIUtils.showToast('Keep at least one source on', 'info');
                    cb.checked = true;
                    return;
                }
                VoiceStore.setSources(voice.id, sources);
                this.render();
            });
        });

        body.querySelector('[data-voice-add]')?.addEventListener('click', async () => {
            let res;
            try { res = await window.electronLibrary.importFiles(c); } catch { return; }
            this._reportImport(res);
        });

        // Document rows: Remove moves the FILE to the Trash (V1 — the folder
        // is the corpus, so there is no keep-the-file-drop-the-index state).
        body.querySelectorAll('[data-voice-doc-remove]').forEach(el => {
            el.addEventListener('click', async (e) => {
                e.stopPropagation();
                const row = el.closest('[data-voice-doc]');
                const title = row?.querySelector('.voice-doc-title')?.textContent || 'this document';
                const ok = await UIUtils.confirm(
                    'Move to Trash',
                    `Move "${UIUtils.escapeHtml(title)}" to the Trash? It leaves the index; the file can be restored from the Trash.`,
                    '', { confirmText: 'Move to Trash' });
                if (!ok) return;
                let res;
                try { res = await window.electronLibrary.deleteDoc(el.dataset.voiceDocRemove); } catch (err) { res = { error: err.message }; }
                if (res && res.error) { UIUtils.showToast(res.error, 'error'); return; }
                UIUtils.showToast('Moved to Trash', 'success');
                this.render();
            });
        });

        body.querySelector('[data-voice-study]')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            btn.textContent = 'Studying…';
            const res = await VoiceService.study(c);
            if (res && res.error) UIUtils.showToast(res.error, 'error');
            else if (res && res.keptUserBody) UIUtils.showToast('Studied — exemplars refreshed, your edited guide kept', 'success');
            else UIUtils.showToast('Your voice is studied', 'success');
            this.render();
        });

        // Autosave edits without re-rendering — a repaint mid-typing steals
        // the caret. The meta line catches up on the next render.
        const area = body.querySelector('[data-voice-edit]');
        if (area) {
            let timer = null;
            area.addEventListener('input', () => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => VoiceStore.saveUserEdit(c, area.value), 600);
            });
        }

        // Long quotes clamp to two lines (CSS default). Only a quote the
        // clamp actually truncates gets the More button and the pointer —
        // measured against the laid-out element (clientHeight 0 = no
        // layout yet; leave those alone).
        body.querySelectorAll('.voice-ex').forEach(ex => {
            const text = ex.querySelector('.voice-ex-text');
            if (!text || !text.clientHeight || text.scrollHeight <= text.clientHeight + 1) return;
            ex.classList.add('is-clampable');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'voice-ex-btn voice-ex-more';
            btn.textContent = 'More';
            ex.querySelector('.voice-ex-meta')?.prepend(btn);
            const toggle = () => { btn.textContent = ex.classList.toggle('is-open') ? 'Less' : 'More'; };
            btn.addEventListener('click', toggle);
            text.addEventListener('click', toggle);
        });

        body.querySelectorAll('[data-voice-pin]').forEach(btn => {
            btn.addEventListener('click', () => {
                VoiceStore.setPinned(btn.dataset.voicePin, !btn.classList.contains('is-pinned'));
                this.render();
            });
        });
        body.querySelectorAll('[data-voice-remove]').forEach(btn => {
            btn.addEventListener('click', () => {
                VoiceStore.removeExemplar(btn.dataset.voiceRemove);
                this.render();
            });
        });

        body.querySelector('[data-voice-draft]')?.addEventListener('click', () => this.openDraftDoor());
        body.querySelectorAll('[data-voice-help]').forEach(b => b.addEventListener('click', () => this._openHelp()));

        body.querySelector('[data-voice-off]')?.addEventListener('click', async () => {
            const ok = await UIUtils.confirm(
                'Turn off your writing voice',
                'Turn off your voice? The style guide and its passages are removed; your documents, notes, journal and emails all stay where they are.',
                '', { confirmText: 'Turn off' });
            if (!ok) return;
            VoiceStore.deletePage(c);
            this.render();
        });
    },

    /**
     * The one door out: a pre-scoped conversation, then the composer. The
     * user's next message ("write a farewell note to my team") usually
     * contains NO voice vocabulary, so keyword domain-matching alone would
     * never ship draft_in_style — the openBuildConversation lesson. Pre-
     * scope the domain and bake the instruction in (extraContext is
     * durable across navigation); the greeting keeps the drawer from
     * opening silent.
     */
    async openDraftDoor() {
        if (typeof AgentService !== 'undefined' && AgentService.openScopedConversation) {
            const conv = AgentService.openScopedConversation({
                domains: ['voice'],
                extraContext: 'This conversation was opened from Settings › Writing voice. For ANY request to write, draft, or rewrite something, call draft_in_style FIRST and imitate the exemplars it returns — they are the user\'s own real writing. When it returns grounding passages, end the draft naming the groundedIn documents.',
                greeting: 'You\'re drafting in **your own voice**. Tell me what to write — a post, an email, a note, a speech — plus any details, and I\'ll write it the way you would.'
            });
            if (conv && AgentService.loadConversation) AgentService.loadConversation(conv.id);
        }
        if (typeof AgentUI !== 'undefined' && AgentUI.openComposer) await AgentUI.openComposer();
    },

    _openHelp() {
        if (typeof ContextHelp !== 'undefined') ContextHelp.open('voice');
    },

    /** Study depth — per-Mac (localStorage), read by VoiceService.depth() at
     *  the start of each study; no reload or re-study needed on change. */
    _wireDepth() {
        const depthSel = document.getElementById('settings-voice-study-depth');
        if (!depthSel || depthSel._wired) return;
        depthSel._wired = true;
        let cur = null;
        try { cur = localStorage.getItem('voice-study-depth'); } catch { /* default */ }
        depthSel.value = ['light', 'standard', 'deep'].includes(cur) ? cur : 'standard';
        depthSel.addEventListener('change', () => {
            try { localStorage.setItem('voice-study-depth', depthSel.value); } catch { /* per-Mac best effort */ }
        });
    },

    /**
     * Drop files anywhere on the panel to add them to the voice's folder —
     * the same copy-into-the-folder as the button, never an index of files
     * in place (V1: the folder is the corpus).
     */
    _wireDrop(panel) {
        if (!panel) return;
        const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
        panel.addEventListener('dragover', (e) => { stop(e); panel.classList.add('is-dragover'); });
        panel.addEventListener('dragleave', (e) => { stop(e); panel.classList.remove('is-dragover'); });
        panel.addEventListener('drop', async (e) => {
            stop(e);
            panel.classList.remove('is-dragover');
            const voice = (typeof VoiceStore !== 'undefined') ? VoiceStore.selfVoice() : null;
            if (!voice || !window.electronLibrary) return;
            const files = Array.from(e.dataTransfer?.files || []);
            if (!files.length) return;
            const paths = files
                .map(f => { try { return window.electronLibrary.pathForFile(f); } catch { return null; } })
                .filter(Boolean);
            if (!paths.length) return;
            let res;
            try { res = await window.electronLibrary.importPaths(paths, voice.collection || ''); } catch { return; }
            this._reportImport(res);
        });
    },

    _reportImport(res) {
        if (!res || res.canceled) return;
        if (res.error) { UIUtils.showToast(res.error, 'error'); return; }
        const bits = [];
        if (res.imported) bits.push(`Imported ${res.imported} file${res.imported === 1 ? '' : 's'}`);
        if (res.skipped) bits.push(`${res.skipped} skipped (unsupported type)`);
        if (bits.length) UIUtils.showToast(bits.join(' · '), res.imported ? 'success' : 'info');
        this.render();
    }
};

// Ambient context for a chat opened over this page: names the page and
// its state, never quotes the guide (the model has draft_in_style for that).
if (typeof AgentContext !== 'undefined') {
    AgentContext.register('voice', () => {
        try {
            if (!SettingsVoice.isOpen()) return null;
            const self = (typeof VoiceStore !== 'undefined') ? VoiceStore.selfVoice() : null;
            return {
                title: 'CURRENT PAGE',
                body: self
                    ? `The user is on Settings › Writing voice — their own writing voice, learned from sources they selected (editable style guide + exemplar passages)${(self.body || '').trim() ? '' : '; it is turned on but not studied yet'}. For any request to draft, write, or rewrite something, call draft_in_style FIRST and imitate the exemplars it returns.`
                    : 'The user is on Settings › Writing voice, which offers to learn their writing style from sources they pick (documents, notes, journal, sent emails). It is not on yet; they turn it on here.'
            };
        } catch { /* page state unavailable */ }
        return null;
    });
}
