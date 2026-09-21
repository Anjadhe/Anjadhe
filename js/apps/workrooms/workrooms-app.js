/* Workrooms — a chat where Anjadhe can bring in specialists (2026-09-21).
 *
 * The page is a messaging app: a list of conversations on the left, ONE
 * thread on the right. You and Anjadhe talk; when the job needs it an agent
 * joins, and what it reports is a message under its own name. While someone
 * is working the thread says "Browser is opening fandango.com…", the way a
 * chat says someone is typing. An approval is a message with quick replies.
 * Everything else — members, what an agent did step by step, the live
 * browser, setup, website permissions, pause and delete — is one tap away in
 * the group's info panel, not on the page.
 *
 * This file only DRAWS. The work runs in WorkroomEngine (background owner
 * window only), state lives in main's event log, and the page is fed by
 * deltas: a new event appends one node; nothing re-renders the thread.
 */
const WorkroomsApp = {
    rooms: [], selected: null, _creating: false, _inited: false, _panel: null, _driving: null, _panelClosed: new Set(),
    _events: new Map(), _drafts: new Map(), _attachmentDrafts: new Map(), _readingFiles: new Set(),
    active() { return typeof FEATURES !== 'undefined' && FEATURES.isEnabled('workrooms'); },
    locked() { return AppManager.isAppLocked('agent') && !AppManager.sensitiveUnlocked; },
    label(id) { return Specialists.label(id); },
    viewing(id) { return AppManager.currentApp === 'workrooms' && this.selected === id && !this._creating && !document.hidden; },

    async init() {
        if (!this.active()) return;
        if (!this._inited) {
            this._inited = true;
            window.electronWorkrooms.onEvent(delta => this.onDelta(delta));
            // The engine is pushed to as well; this is only the safety net
            // for a queued room nobody announced (a restart, a new owner).
            this._timer = setInterval(() => WorkroomEngine.tick(), 15000);
            this.mount();
        }
        await this.refresh();
        WorkroomEngine.tick();
    },
    async refresh() {
        try { this.rooms = await window.electronWorkrooms.list(); } catch (error) { this.error(error); }
        for (const map of [this._drafts, this._attachmentDrafts, this._events]) for (const id of map.keys()) if (id !== 'new' && !this.rooms.some(room => room.id === id)) map.delete(id);
        if (AppManager.currentApp === 'workrooms') this.render();
        document.dispatchEvent(new Event('anjadhe:attention-changed'));
    },
    /** One delta from main: a room summary, maybe one event, maybe a delete. */
    async onDelta(delta) {
        WorkroomEngine.onDelta(delta);
        if (delta.deleted) {
            this.rooms = this.rooms.filter(room => room.id !== delta.deleted);
            this._events.delete(delta.deleted);
            if (this.selected === delta.deleted) { this.selected = null; this._panel = null; }
            if (AppManager.currentApp === 'workrooms') this.render();
        }
        if (delta.room) {
            const index = this.rooms.findIndex(room => room.id === delta.room.id);
            const before = index >= 0 ? this.rooms[index] : null;
            if (index >= 0) this.rooms[index] = delta.room; else this.rooms.unshift(delta.room);
            if (delta.event) {
                const log = this._events.get(delta.room.id);
                if (log) {
                    if (delta.event.seq === (log.at(-1)?.seq || 0) + 1) log.push(delta.event);
                    else if (delta.event.seq > (log.at(-1)?.seq || 0)) log.push(...await window.electronWorkrooms.events(delta.room.id, log.at(-1)?.seq || 0));
                }
                if (delta.event.type === 'approval' && !this.viewing(delta.room.id) && typeof Notify !== 'undefined') {
                    Notify.show(`${this.label(delta.event.agent)} is asking before it acts`, delta.event.summary, { kind: 'task' });
                }
            }
            if (AppManager.currentApp === 'workrooms' && !this.locked()) {
                this.renderList();
                if (this.selected === delta.room.id && !this._creating) {
                    if (delta.event) this.appendEvent(delta.room, delta.event);
                    if (['activity', 'task_end'].includes(delta.event?.type)) this.renderTicker(delta.room, delta.event.taskId || delta.event.id);
                    // The browser is something to WATCH: open it beside the chat the
                    // first time it goes to work here, unless the user closed it.
                    if (delta.event?.type === 'task' && delta.event.agent === 'browser' && !this._panel && !this._panelClosed.has(delta.room.id)) this._panel = { agent: 'browser' };
                    if (delta.room.status === 'running' && this._driving === delta.room.id) this._driving = null;
                    this.renderStatus(delta.room);
                    if (this._panel) this.renderPanel(delta.room);
                    this.markSeen(delta.room.id);
                }
            }
            if (!before || before.status !== delta.room.status || !!before.approval !== !!delta.room.approval) document.dispatchEvent(new Event('anjadhe:attention-changed'));
            if (delta.room.status === 'queued') WorkroomEngine.tick();
        }
    },

    // ── shell ────────────────────────────────────────────────────────────
    mount() {
        if (document.getElementById('workrooms-view')) return;
        const view = document.createElement('main'); view.id = 'workrooms-view'; view.className = 'view';
        view.innerHTML = `<div class="wr-shell">
            <aside class="wr-list" aria-label="Chats"><header><h1>Workrooms</h1><button class="wr-icon-btn" data-wr="new" type="button" title="New chat" aria-label="New chat"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button></header><div id="wr-rooms" class="wr-rooms"></div></aside>
            <section id="workroom-detail" class="wr-chat" aria-label="Conversation"></section>
            <aside id="wr-panel" class="wr-panel" hidden aria-label="Group info"></aside>
        </div><p id="workroom-error" class="wr-error" role="alert"></p>`;
        document.getElementById('app-views').appendChild(view);
        const fileInput = document.createElement('input');
        fileInput.type = 'file'; fileInput.multiple = true; fileInput.hidden = true; fileInput.id = 'workroom-file-input';
        view.appendChild(fileInput);
        fileInput.addEventListener('change', () => { this.attachFiles(Array.from(fileInput.files || []), this._filePickerKey); fileInput.value = ''; });
        view.addEventListener('submit', event => { if (event.target.matches('.wr-composer')) { event.preventDefault(); this.send(event.target); } });
        view.addEventListener('click', event => this.onClick(event, fileInput));
        view.addEventListener('input', event => {
            if (!event.target.matches('.wr-composer textarea')) return;
            this._drafts.set(this.key(), event.target.value);
            AgentUI._autoGrowComposer(event.target); this.updateSend();
        });
        view.addEventListener('keydown', event => {
            if (event.target.matches('.wr-composer textarea') && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); event.target.form.requestSubmit(); }
        });
        // On the document: the button that opened a panel is gone after the
        // repaint, so focus is on <body>, outside this view.
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || !this._panel || this._driving || AppManager.currentApp !== 'workrooms' || document.querySelector('dialog[open]')) return;
            this._panel = null; this.renderPanel(this.room());
        });
        this.wireView(view.querySelector('#wr-panel'));
        view.addEventListener('dragover', event => {
            const composer = event.target.closest('.wr-composer');
            if (!composer || !event.dataTransfer?.types?.includes('Files')) return;
            event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; composer.classList.add('agent-drop-active');
        });
        view.addEventListener('dragleave', event => { const composer = event.target.closest('.wr-composer'); if (composer && !composer.contains(event.relatedTarget)) composer.classList.remove('agent-drop-active'); });
        view.addEventListener('drop', event => {
            const composer = event.target.closest('.wr-composer'); if (!composer) return;
            event.preventDefault(); composer.classList.remove('agent-drop-active');
            this.attachFiles(Array.from(event.dataTransfer?.files || []), this.key());
        });
        view.addEventListener('paste', event => {
            if (!event.target.matches('.wr-composer textarea') || !event.clipboardData?.files?.length) return;
            event.preventDefault(); this.attachFiles(Array.from(event.clipboardData.files), this.key());
        });
    },
    INVITES: ['Find a well-reviewed electric kettle under $40', 'What did I promise people by email this week?', 'Compare two hotels near the venue and draft a note to the team', 'Check my calendar and tasks: what can wait until Monday?'],
    key() { return this._creating || !this.selected ? 'new' : this.selected; },
    room() { return this._creating ? null : this.rooms.find(room => room.id === this.selected) || null; },
    error(error) { const el = document.getElementById('workroom-error'); if (el) el.textContent = error ? (error.message || String(error)) : ''; },
    async command(action, input) {
        if (this.locked()) return null;
        try { const result = await window.electronWorkrooms.command(action, input); this.error(null); return result; }
        catch (error) { this.error(error); return null; }
    },
    async onClick(event, fileInput) {
        const link = event.target.closest('.wr-thread a, .wr-panel .ai-prose a');
        if (link && !link.hasAttribute('data-record-link')) {
            const href = link.getAttribute('href') || '';
            if (/^https?:/i.test(href)) { event.preventDefault(); AppManager.openExternal(href); return; }
            if (/^mailto:/i.test(href)) { event.preventDefault(); window.electronAuth?.openExternal(href); return; }
            if (href === '#') { event.preventDefault(); return; }
        }
        if (event.target.closest('.wr-composer') && event.target.closest('.agent-attach-btn, .agent-attachment-remove')) {
            if (this.locked() || this._sending) return;
            const remove = event.target.closest('.agent-attachment-remove');
            if (remove) { (this._attachmentDrafts.get(this.key()) || []).splice(Number(remove.dataset.idx), 1); this.renderAttachments(); }
            else { this._filePickerKey = this.key(); fileInput.click(); }
            return;
        }
        const row = event.target.closest('[data-open-room]');
        if (row) { this.openChat(row.dataset.openRoom); return; }
        const target = event.target.closest('[data-wr]'); if (!target) return;
        const action = target.dataset.wr, room = this.room();
        if (action === 'invite') {
            const input = document.querySelector('.wr-composer textarea'); if (!input) return;
            input.value = target.textContent; this._drafts.set(this.key(), input.value);
            AgentUI._autoGrowComposer(input); this.updateSend(); input.focus(); return;
        }
        if (action === 'new') { this._creating = true; this._panel = null; this.render(); document.querySelector('.wr-composer textarea')?.focus(); return; }
        if (action === 'info') { this._panel = this._panel ? null : 'info'; this.renderPanel(room); return; }
        if (action === 'close-panel') { this._panel = null; if (room) this._panelClosed.add(room.id); this.renderPanel(room); return; }
        if (action === 'agent') { this._panel = { agent: target.dataset.agent }; this.renderPanel(room); return; }
        if (action === 'back-info') { this._panel = 'info'; this.renderPanel(room); return; }
        if (!room) return;
        if (action === 'yes' || action === 'always' || action === 'no') {
            target.closest('.wr-replies')?.querySelectorAll('button').forEach(button => { button.disabled = true; });
            await this.command('approval', { id: room.id, approvalId: target.dataset.approval, approved: action !== 'no', always: action === 'always' });
            return;
        }
        if (action === 'drive') {
            try { await window.electronAgentBrowser.command('takeover', { here: true, roomId: room.id }); this._driving = room.id; this.renderPanel(room); document.querySelector('.wr-view-screen')?.focus(); }
            catch (error) { this.error(error); }
            return;
        }
        if (action === 'hand-back') { this._driving = null; this.renderPanel(room); if (room.status === 'paused') await this.command('resume', { id: room.id }); return; }
        if (action === 'stop') { await this.command('pause', { id: room.id }); return; }
        if (action === 'continue') { this._driving = null; await this.command('resume', { id: room.id }); return; }
        if (action === 'delete') { this.confirmDelete(room.id); return; }
        if (action === 'browser' || action === 'browser-control') {
            try { await BrowserTools.open({ takeover: action === 'browser-control' }); } catch (error) { this.error(error); }
            return;
        }
        if (action === 'browser-setup') { this.browserSetup(); return; }
        if (action === 'websites') { this.websitePermissions(); return; }
    },
    async send(form) {
        const key = this.key();
        if (this._sending || this._readingFiles.has(key) || this.locked()) return;
        const text = form.querySelector('textarea').value;
        const attachments = (this._attachmentDrafts.get(key) || []).slice();
        if (!text.trim() && !attachments.length) return;
        this._sending = true; this.updateSend();
        const create = key === 'new';
        const result = await this.command(create ? 'create' : 'message', create ? { goal: text, attachments } : { id: this.selected, text, attachments });
        this._sending = false;
        if (result) {
            this._drafts.delete(key); this._attachmentDrafts.delete(key);
            if (create) { this._creating = false; this.selected = result.id; this.render(); }
            else { const input = form.querySelector('textarea'); input.value = ''; AgentUI._autoGrowComposer(input); this.renderAttachments(); }
            WorkroomEngine.tick();
        }
        this.updateSend();
    },
    async attachFiles(files, key) {
        if (!files.length || !key || this.locked() || this._sending || this._readingFiles.has(key)) return;
        if (!this._attachmentDrafts.has(key)) this._attachmentDrafts.set(key, []);
        const attachments = this._attachmentDrafts.get(key);
        this._readingFiles.add(key); this.renderAttachments();
        try {
            await AgentUI.attachFiles(files, { attachments, entry: AgentService.getDefaultEntry(), render: () => this.renderAttachments(),
                focus: () => { if (this.key() === key) document.querySelector('.wr-composer textarea')?.focus(); } });
        } catch (error) { this.error(error); }
        finally { this._readingFiles.delete(key); this.renderAttachments(); }
    },
    renderAttachments() {
        const strip = document.querySelector('.wr-composer .agent-attachments'); if (!strip) return;
        const attachments = this._attachmentDrafts.get(this.key()) || [];
        strip.hidden = !attachments.length;
        strip.innerHTML = AgentUI.attachmentChipsHtml(attachments);
        const status = document.querySelector('.wr-file-status');
        if (status) { status.textContent = this._readingFiles.has(this.key()) ? 'Reading files…' : ''; status.hidden = !status.textContent; }
        this.updateSend();
    },
    updateSend() {
        const form = document.querySelector('.wr-composer'); if (!form) return;
        const busy = !!this._sending || this._readingFiles.has(this.key());
        form.querySelector('[type=submit]').disabled = busy || (!form.querySelector('textarea').value.trim() && !(this._attachmentDrafts.get(this.key()) || []).length);
        form.querySelector('.agent-attach-btn').disabled = busy;
    },

    // ── the chat list ────────────────────────────────────────────────────
    chatTime(iso) {
        const at = new Date(iso);
        if (!iso || Number.isNaN(at.getTime())) return '';
        // CALENDAR days apart, not hours apart; rounded for DST days.
        const midnight = date => { const day = new Date(date); day.setHours(0, 0, 0, 0); return day; };
        const days = Math.round((midnight(new Date()) - midnight(at)) / 86400000);
        if (days <= 0) return at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        if (days === 1) return 'Yesterday';
        if (days < 7) return at.toLocaleDateString([], { weekday: 'short' });
        return at.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' });
    },
    // Unread is a fact about this screen, not the record: per-Mac, never synced.
    lastSeen() {
        if (!this._lastSeen) { try { this._lastSeen = JSON.parse(localStorage.getItem('workroom-last-seen') || '{}') || {}; } catch { this._lastSeen = {}; } }
        return this._lastSeen;
    },
    markSeen(id) {
        if (!id || !this.viewing(id)) return;
        this.lastSeen()[id] = new Date().toISOString();
        try { localStorage.setItem('workroom-last-seen', JSON.stringify(this._lastSeen)); } catch { /* private window */ }
    },
    unread(room) { return !!room.last && room.last.from !== 'you' && room.last.at > (this.lastSeen()[room.id] || room.createdAt); },
    /** What a room is waiting on you for, if anything. SimpleExperience reads this too. */
    attention(room) { return room.approval ? 'Asking you' : room.status === 'paused' ? 'Paused' : ''; },
    working(room) {
        if (room.status === 'queued') return AgentService.model ? 'Starting…' : 'Choose an AI model in Settings to start';
        if (room.status !== 'running') return '';
        if (room.approval) return `${this.label(room.approval.agent)} is waiting for your answer`;
        const now = room.now || { agent: 'master', text: '' };
        return `${this.label(now.agent)} is ${now.text || (now.agent === 'master' ? 'thinking' : 'working')}…`;
    },
    avatar(id) {
        if (id === 'master') return '<span class="wr-avatar is-master" aria-hidden="true">A</span>';
        return `<span class="wr-avatar" aria-hidden="true">${UIUtils.escapeHtml(this.label(id).slice(0, 1).toUpperCase())}</span>`;
    },
    renderList() {
        const host = document.getElementById('wr-rooms'); if (!host) return;
        const esc = UIUtils.escapeHtml, scroll = host.scrollTop;
        const ordered = [...this.rooms].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        host.innerHTML = ordered.map(room => {
            const open = !this._creating && room.id === this.selected;
            const live = this.working(room), attention = this.attention(room);
            const who = room.last ? (room.last.from === 'you' ? 'You: ' : room.last.from === 'master' ? '' : `${this.label(room.last.from)}: `) : '';
            const preview = live && room.status === 'running' ? live : room.last ? `${who}${room.last.text}` : 'No messages yet';
            return `<button class="wr-room${live ? ' is-live' : ''}" data-open-room="${esc(room.id)}" aria-current="${open}">
                <span class="wr-avatar is-group" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 5.6a3.2 3.2 0 0 1 0 6.3M17.5 14.2A5.5 5.5 0 0 1 21 19"/></svg></span>
                <span class="wr-room-body"><span class="wr-room-top"><span class="wr-room-name">${esc(room.title)}</span><time>${esc(this.chatTime(room.last?.at || room.updatedAt))}</time></span>
                <span class="wr-room-bottom"><span class="wr-room-preview">${esc(preview)}</span>${attention ? `<span class="wr-badge is-word">${esc(attention)}</span>` : !open && this.unread(room) ? '<span class="wr-badge" aria-label="Unread"></span>' : ''}</span></span>
            </button>`;
        }).join('') || '<p class="wr-empty">No chats yet. Start one with +.</p>';
        host.scrollTop = scroll;
    },
    async openChat(id) {
        if (!id) return;
        this._creating = false; this.selected = id; this._panel = null;
        await this.render();
    },
    open(id) { this._creating = false; if (id) this.selected = id; this._panel = null; AppManager.openApp('workrooms'); },
    onShow() { this.render(); },
    onHide() { this.stopPreview(); },

    // ── the thread ───────────────────────────────────────────────────────
    time(iso) { const at = new Date(iso); return Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); },
    prose(text) { AgentUI._installCopyHandlers?.(); return `<div class="ai-prose wr-prose">${AgentUI.formatContent(String(text || ''))}</div>`; },
    /** One event as one node of the conversation, or '' for what the thread does not show. */
    eventHtml(room, event, previous) {
        const esc = UIUtils.escapeHtml;
        const line = (text, cls = '') => `<div class="wr-line ${cls}" data-seq="${event.seq}"><span>${text}</span></div>`;
        if (event.type === 'message' && event.from === 'you') {
            return `<div class="wr-msg is-me" data-seq="${event.seq}" data-from="you"><div class="wr-bubble"><div class="wr-plain">${esc(event.text)}</div>${event.attachments?.length ? `<div class="agent-msg-attachments">${AgentUI.messageAttachmentsHtml(event.attachments)}</div>` : ''}<time>${esc(this.time(event.at))}</time></div></div>`;
        }
        if (event.type === 'message' || event.type === 'task_end') {
            const from = event.type === 'message' ? event.from : event.agent;
            const follows = previous && (previous.type === 'message' ? previous.from : previous.type === 'task_end' ? previous.agent : null) === from;
            const sources = (event.sources || []).slice(0, 4).map(url => { try { return `<a href="${esc(url)}">${esc(new URL(url).hostname.replace(/^www\./, ''))}</a>`; } catch { return ''; } }).filter(Boolean).join('');
            return `<div class="wr-msg${follows ? ' is-follow' : ''}${from === 'master' ? ' is-master' : ''}" data-seq="${event.seq}" data-from="${esc(from)}">${this.avatar(from)}<div class="wr-bubble${event.status === 'blocked' ? ' is-blocked' : ''}">
                <header><button class="wr-name" ${from === 'master' ? 'disabled' : `data-wr="agent" data-agent="${esc(from)}"`}>${esc(this.label(from))}</button>${event.status === 'blocked' ? '<span class="wr-tag">could not finish</span>' : ''}</header>
                ${this.prose(event.text)}${sources ? `<div class="wr-sources">${sources}</div>` : ''}${event.status === 'blocked' && from === 'browser' ? '<div class="wr-replies"><button data-wr="agent" data-agent="browser">Show the browser</button></div>' : ''}<time>${esc(this.time(event.at))}</time></div></div>`;
        }
        if (event.type === 'join') return line(`${esc(this.label(event.agent))} joined`);
        if (event.type === 'task') return `<details class="wr-line wr-brief" data-seq="${event.seq}"><summary><span>Anjadhe asked ${esc(this.label(event.agent))}</span></summary><p>${esc(event.text)}</p></details><div class="wr-ticker" data-task="${esc(event.id)}">${this.tickerHtml(room, event.id)}</div>`;
        if (event.type === 'approval') {
            const pending = room.approval?.id === event.id;
            return `<div class="wr-msg" data-seq="${event.seq}" data-approval="${esc(event.id)}" data-from="${esc(event.agent)}">${this.avatar(event.agent)}<div class="wr-bubble wr-ask${event.sensitive ? ' is-sensitive' : ''}">
                <header><button class="wr-name" data-wr="agent" data-agent="${esc(event.agent)}">${esc(this.label(event.agent))}</button></header>
                <p class="wr-ask-q">${esc(event.summary)}</p>${event.detail ? `<p class="wr-ask-detail">${esc(event.detail)}</p>` : ''}
                ${pending ? `<div class="wr-replies"><button data-wr="yes" data-approval="${esc(event.id)}">${event.kind === 'step' ? 'Yes, this once' : 'Yes'}</button>${event.kind === 'site' && event.origin ? `<button data-wr="always" data-approval="${esc(event.id)}">Always on this site</button>` : ''}<button data-wr="no" data-approval="${esc(event.id)}">No</button></div>` : ''}
                <time>${esc(this.time(event.at))}</time></div></div>`;
        }
        if (event.type === 'approval_answer') {
            return line(event.by === 'system' ? 'The question was withdrawn' : event.approved ? (event.always ? 'You said always on this site' : 'You said yes') : 'You said no');
        }
        if (event.type === 'status') return line(esc(event.text), event.state === 'error' ? 'is-error' : '');
        return '';
    },
    /** The steps of one job, from its activity events. */
    steps(room, taskId) {
        const steps = [];
        for (const event of this._events.get(room.id) || []) {
            if (event.type !== 'activity' || event.taskId !== taskId) continue;
            if (event.phase === 'start') steps.push({ say: event.say || event.tool, at: event.at, state: 'going' });
            else { const open = [...steps].reverse().find(step => step.state === 'going'); if (open) { open.state = event.phase; open.error = event.error; open.end = event.at; } }
        }
        return steps;
    },
    span(from, to) {
        const seconds = Math.round((Date.parse(to) - Date.parse(from)) / 1000);
        if (!Number.isFinite(seconds) || seconds < 1) return '';
        return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    },
    /* What an agent is doing, IN the conversation: its last few steps while it
     * works, one summary line once it is done. Every word is counted off the
     * recorded activity; nothing here is a model's account of itself. */
    tickerHtml(room, taskId) {
        const esc = UIUtils.escapeHtml, log = this._events.get(room.id) || [];
        const task = log.find(event => event.type === 'task' && event.id === taskId); if (!task) return '';
        const end = log.find(event => event.type === 'task_end' && event.id === taskId), steps = this.steps(room, taskId);
        const open = `data-wr="agent" data-agent="${esc(task.agent)}"`;
        if (end || room.status !== 'running') {
            if (!steps.length) return '';
            const failed = steps.filter(step => step.state === 'error').length, took = this.span(task.at, (end || steps.at(-1)).at);
            return `<button class="wr-ticker-done" ${open}>${steps.length} ${steps.length === 1 ? 'step' : 'steps'}${took ? ` · ${esc(took)}` : ''}${failed ? ` · ${failed} did not work` : ''} · see what it did</button>`;
        }
        const shown = steps.slice(-3), hidden = steps.length - shown.length;
        return `<button class="wr-ticker-live" ${open}>${hidden > 0 ? `<span class="wr-tick is-more">${hidden} earlier ${hidden === 1 ? 'step' : 'steps'}</span>` : ''}${shown.map(step => `<span class="wr-tick is-${esc(step.state)}">${esc(step.say)}${step.error ? `<em>${esc(String(step.error).split('\n')[0].slice(0, 110))}</em>` : ''}</span>`).join('') || '<span class="wr-tick is-going">reading the brief</span>'}</button>`;
    },
    renderTicker(room, taskId) {
        const node = taskId && document.querySelector(`#wr-thread .wr-ticker[data-task="${CSS.escape(taskId)}"]`); if (!node) return;
        const thread = document.getElementById('wr-thread'), atEnd = thread.scrollHeight - thread.clientHeight - thread.scrollTop < 80;
        node.innerHTML = this.tickerHtml(room, taskId);
        if (atEnd) thread.scrollTop = thread.scrollHeight;
    },
    appendEvent(room, event) {
        const thread = document.getElementById('wr-thread'); if (!thread || thread.dataset.room !== room.id) return;
        if (thread.querySelector(`[data-seq="${event.seq}"]`)) return;
        if (event.type === 'approval_answer') thread.querySelector(`[data-approval="${CSS.escape(event.id)}"] .wr-replies`)?.remove();
        const log = this._events.get(room.id) || [];
        const shown = log.filter(item => item.seq < event.seq && this.eventHtml(room, item, null));
        const html = this.eventHtml(room, event, shown.at(-1)); if (!html) return;
        const atEnd = thread.scrollHeight - thread.clientHeight - thread.scrollTop < 80;
        thread.insertAdjacentHTML('beforeend', html);
        thread.querySelector('.wr-welcome')?.remove();
        if (atEnd || event.from === 'you') thread.scrollTop = thread.scrollHeight;
    },
    /** The line under the thread and the head's subtitle: who is doing what. */
    renderStatus(room) {
        if (room.status !== 'running') for (const node of document.querySelectorAll('#wr-thread .wr-ticker')) if (node.querySelector('.wr-ticker-live')) node.innerHTML = this.tickerHtml(room, node.dataset.task);
        const typing = document.getElementById('wr-typing'), sub = document.getElementById('wr-sub'), stop = document.getElementById('wr-stop');
        if (!typing || !room) return;
        const live = this.working(room);
        typing.hidden = !live;
        typing.innerHTML = live ? `<span class="wr-pulse" aria-hidden="true"></span><span>${UIUtils.escapeHtml(live)}</span>` : '';
        if (sub) sub.textContent = ['You', 'Anjadhe', ...(room.members || []).map(id => this.label(id))].join(', ');
        if (stop) {
            const running = ['running', 'queued'].includes(room.status);
            stop.hidden = !(running || room.status === 'paused');
            stop.dataset.wr = running ? 'stop' : 'continue';
            stop.textContent = running ? 'Stop' : 'Continue';
        }
    },
    composerHtml(create, draft) {
        return `<form class="wr-composer"><div class="agent-composer">
            <div class="agent-attachments" hidden></div><p class="wr-file-status" role="status" hidden></p>
            <textarea class="agent-composer-input" rows="1" maxlength="6000" aria-label="Message" placeholder="${create ? 'What would you like done?' : 'Message'}">${UIUtils.escapeHtml(draft)}</textarea>
            <div class="agent-composer-actions"><button class="agent-attach-btn" type="button" title="Attach files" aria-label="Attach a file">+</button>
            <div class="agent-model-select"><button id="workroom-composer-model-chip" class="agent-context-chip agent-model-chip" type="button" aria-haspopup="menu"></button></div>
            <button class="agent-send-btn" type="submit" title="Send" aria-label="Send"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg></button></div>
        </div></form>`;
    },
    async render() {
        if (!this._inited) return;
        const host = document.getElementById('workroom-detail'); if (!host) return;
        if (this.locked()) { document.getElementById('wr-rooms')?.replaceChildren(); host.replaceChildren(); this.stopPreview(); return; }
        if (!this._creating && !this.rooms.some(room => room.id === this.selected)) this.selected = this.rooms[0]?.id || null;
        if (!this.selected) this._creating = true;
        this.renderList();
        const room = this.room(), esc = UIUtils.escapeHtml, draft = this._drafts.get(this.key()) || '';
        if (!room) {
            host.innerHTML = `<div id="wr-thread" class="wr-thread" data-room="new"><div class="wr-welcome"><h2>What would you like done? <span>Say the outcome.</span></h2><p>Anjadhe answers, or brings in whoever the job needs: someone to read your mail or files, search the web, or work a website for you.</p><div class="wr-invites">${this.INVITES.map(text => `<button type="button" class="wr-invite" data-wr="invite">${esc(text)}</button>`).join('')}</div></div></div>${this.composerHtml(true, draft)}`;
        } else {
            if (!this._events.has(room.id)) {
                try { this._events.set(room.id, await window.electronWorkrooms.events(room.id)); } catch (error) { this.error(error); this._events.set(room.id, []); }
                if (this.selected !== room.id || this._creating) return; // the user moved on while it loaded
            }
            let previous = null;
            const thread = this._events.get(room.id).map(event => { const html = this.eventHtml(room, event, previous); if (html) previous = event; return html; }).join('');
            host.innerHTML = `<header class="wr-head"><button class="wr-head-id" data-wr="info" title="Group info"><span class="wr-avatar is-group" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 5.6a3.2 3.2 0 0 1 0 6.3M17.5 14.2A5.5 5.5 0 0 1 21 19"/></svg></span><span><strong>${esc(room.title)}</strong><span id="wr-sub" class="wr-sub"></span></span></button><button id="wr-stop" class="wr-pill" hidden></button></header>
                <div id="wr-thread" class="wr-thread" data-room="${esc(room.id)}" tabindex="0">${thread}</div><div id="wr-typing" class="wr-typing" role="status" hidden></div>${this.composerHtml(false, draft)}`;
            const node = document.getElementById('wr-thread'); node.scrollTop = node.scrollHeight;
            this.renderStatus(room); this.markSeen(room.id);
        }
        this.renderPanel(room);
        this.renderAttachments();
        AgentUI._autoGrowComposer(host.querySelector('textarea'));
        AgentUI.updateModelChip();
    },

    // ── group info, and one agent's own activity ─────────────────────────
    renderPanel(room) {
        const panel = document.getElementById('wr-panel'); if (!panel) return;
        const esc = UIUtils.escapeHtml;
        if (!room || !this._panel) { panel.hidden = true; panel.replaceChildren(); this.stopPreview(); return; }
        panel.hidden = false;
        const close = '<button class="wr-icon-btn" data-wr="close-panel" aria-label="Close"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
        if (this._panel === 'info') {
            this.stopView(); panel.dataset.agent = '';
            const running = ['running', 'queued'].includes(room.status);
            panel.innerHTML = `<header><h2>Group info</h2>${close}</header>
                <h3>In this chat</h3><ul class="wr-members"><li>${'<span class="wr-avatar" aria-hidden="true">Y</span>'}<span>You</span></li><li>${this.avatar('master')}<span>Anjadhe</span></li>
                ${(room.members || []).map(id => `<li><button data-wr="agent" data-agent="${esc(id)}">${this.avatar(id)}<span>${esc(this.label(id))}</span><span class="wr-more">What it did</span></button></li>`).join('')}</ul>
                ${(room.members || []).length ? '' : '<p class="wr-hint">Anjadhe brings in agents as the work needs them.</p>'}
                <h3>Browser</h3><p class="wr-hint">Agents use a Chrome window kept for them. Your sign-ins there stay on this Mac.</p>
                <div class="wr-actions"><button data-wr="browser">Open browser</button><button data-wr="browser-control">Take control</button><button data-wr="browser-setup">Browser setup</button><button data-wr="websites">Website permissions</button></div>
                <h3>This chat</h3><div class="wr-actions">${running ? '<button data-wr="stop">Stop</button>' : room.status === 'paused' ? '<button data-wr="continue">Continue</button>' : ''}<button class="is-danger" data-wr="delete">Delete chat</button></div>
                <p class="wr-hint">Work continues when you leave this page. Chats are kept on this Mac.</p>`;
            return;
        }
        const agent = this._panel.agent, log = this._events.get(room.id) || [];
        const tasks = log.filter(event => event.type === 'task' && event.agent === agent);
        const blocks = tasks.map(task => {
            const end = log.find(event => event.type === 'task_end' && event.id === task.id), steps = this.steps(room, task.id);
            const state = end ? (end.status === 'done' ? 'Finished' : 'Could not finish') : room.status === 'running' ? 'Working' : 'Stopped';
            return `<section class="wr-task"><header><strong>${esc(state)}</strong><time>${esc(this.time(task.at))}</time></header><p class="wr-task-brief">${esc(task.text)}</p>
                ${steps.length ? `<ol class="wr-steps">${steps.map(step => `<li class="is-${esc(step.state)}"><span>${esc(step.say)}</span>${step.error ? `<em>${esc(step.error)}</em>` : ''}<time>${esc(this.time(step.at))}</time></li>`).join('')}</ol>` : '<p class="wr-hint">No tools used.</p>'}</section>`;
        }).reverse().join('');
        const head = `<header><button class="wr-icon-btn" data-wr="back-info" aria-label="Back"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg></button><h2>${esc(this.label(agent))}</h2>${close}</header>`;
        if (agent !== 'browser') { this.stopView(); panel.classList.remove('is-wide'); panel.dataset.agent = agent; panel.innerHTML = head + (blocks || '<p class="wr-hint">Nothing yet.</p>'); return; }
        /* The browser IS the panel: the live tab, large enough to use. Keep the
         * screen node across repaints so the picture does not blink and a
         * password half-typed keeps its focus. */
        const driving = this._driving === room.id;
        const keep = panel.dataset.agent === 'browser' ? panel.querySelector('.wr-view') : null;
        panel.dataset.agent = agent; panel.classList.add('is-wide');
        panel.innerHTML = `${head}<section class="wr-view${driving ? ' is-driving' : ''}" aria-label="Live browser"></section>
            <details class="wr-view-log"${driving ? '' : ' open'}><summary>What it did</summary>${blocks || '<p class="wr-hint">Nothing yet.</p>'}</details>`;
        if (keep) panel.querySelector('.wr-view').replaceWith(keep);
        const view = panel.querySelector('.wr-view');
        if (!view.firstChild) view.innerHTML = '<div class="wr-view-bar"><span class="wr-view-url"></span><span class="wr-view-actions"></span></div><div class="wr-view-screen" tabindex="0" role="img" aria-label="The browser the agent is using"><img alt="" hidden draggable="false"><p>Waiting for the browser…</p></div><p class="wr-view-note"></p>';
        view.classList.toggle('is-driving', driving);
        view.querySelector('.wr-view-actions').innerHTML = driving
            ? '<button class="is-primary" data-wr="hand-back">Done, continue</button><button data-wr="browser">Open in Chrome</button>'
            : '<button data-wr="drive">Take control</button><button data-wr="browser">Open in Chrome</button>';
        view.querySelector('.wr-view-note').textContent = driving
            ? 'You are driving. Click and type in the picture as you would in the browser. What you type goes straight to Chrome: it is not saved, and the agent never sees it.'
            : room.status === 'running' ? 'Watching. Take control to sign in or do a step yourself; the team pauses while you drive.' : 'Take control to sign in or do a step yourself, then continue.';
        this.startView(room.id);
    },
    /* The live picture is the one poll on this page: only while the Browser
     * panel is open, faster while the user drives, and at once after input. */
    stopView() { clearTimeout(this._viewTimer); this._viewTimer = null; this._viewRoom = null; this._viewRun = (this._viewRun || 0) + 1; document.getElementById('wr-panel')?.classList.remove('is-wide'); },
    stopPreview() { this.stopView(); },
    startView(roomId) {
        if (this._viewRoom === roomId) return;
        this.stopView(); this._viewRoom = roomId; document.getElementById('wr-panel')?.classList.add('is-wide');
        const run = this._viewRun;
        const update = async () => {
            if (run !== this._viewRun) return;
            clearTimeout(this._viewTimer);
            const screen = document.querySelector('.wr-view-screen');
            if (!screen || AppManager.currentApp !== 'workrooms' || this.locked()) { this.stopView(); return; }
            try {
                if (!document.hidden && !this._viewBusy) {
                    this._viewBusy = true;
                    const shot = await window.electronAgentBrowser.command('view', { roomId }).finally(() => { this._viewBusy = false; });
                    if (run !== this._viewRun) return;
                    const image = screen.querySelector('img'), note = screen.querySelector('p');
                    if (shot.status === 'live' && typeof shot.image === 'string' && shot.image.startsWith('data:image/jpeg;base64,')) {
                        image.src = shot.image; image.hidden = false; note.hidden = true; this._viewport = shot.viewport;
                        const url = document.querySelector('.wr-view-url'); if (url) url.textContent = shot.url || '';
                        // Chrome says who is driving. If it went back to the agent, so do we.
                        if (shot.control === 'agent' && this._driving === roomId) { this._driving = null; this.renderPanel(this.room()); }
                    } else if (shot.status !== 'busy') { image.hidden = true; image.removeAttribute('src'); note.hidden = false; note.textContent = shot.message || 'Waiting for the browser…'; }
                }
            } catch { /* the next tick tries again */ }
            if (run === this._viewRun) this._viewTimer = setTimeout(update, this._driving === roomId ? 350 : 1100);
        };
        this._refreshView = () => { clearTimeout(this._viewTimer); this._viewTimer = setTimeout(update, 120); };
        update();
    },
    /** The user's pointer and keys, forwarded while THEY drive. Never kept. */
    wireView(view) {
        const send = event => { if (this._driving && this._driving === this._viewRoom) { window.electronAgentBrowser.command('input', { roomId: this._driving, event }).catch(error => this.error(error)); this._refreshView?.(); } };
        const mods = event => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
        const point = event => {
            const image = view.querySelector('.wr-view-screen img'); if (!image || image.hidden || !this._viewport) return null;
            const rect = image.getBoundingClientRect(); if (!rect.width) return null;
            return { x: (event.clientX - rect.left) * this._viewport.w / rect.width, y: (event.clientY - rect.top) * this._viewport.h / rect.height };
        };
        const onScreen = event => !!event.target.closest?.('.wr-view-screen') && this._driving;
        let lastMove = 0;
        view.addEventListener('mousedown', event => { if (!onScreen(event)) return; const at = point(event); if (!at) return; event.preventDefault(); event.target.closest('.wr-view-screen').focus(); send({ type: 'mouse', action: 'down', ...at, button: event.button, clickCount: event.detail, modifiers: mods(event) }); });
        view.addEventListener('mouseup', event => { if (!onScreen(event)) return; const at = point(event); if (at) send({ type: 'mouse', action: 'up', ...at, button: event.button, clickCount: event.detail, modifiers: mods(event) }); });
        view.addEventListener('mousemove', event => { if (!onScreen(event) || Date.now() - lastMove < 60) return; lastMove = Date.now(); const at = point(event); if (at) send({ type: 'mouse', action: 'move', ...at, modifiers: mods(event) }); });
        view.addEventListener('contextmenu', event => { if (onScreen(event)) event.preventDefault(); });
        view.addEventListener('wheel', event => { if (!onScreen(event)) return; const at = point(event); if (!at) return; event.preventDefault(); send({ type: 'wheel', ...at, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: mods(event) }); }, { passive: false });
        const key = action => event => {
            if (!onScreen(event) || event.isComposing) return;
            // Paste arrives as text (below); leave the app's own shortcuts alone.
            if (event.metaKey && ['v', 'q', 'w', 'r', 'k', ','].includes(event.key.toLowerCase())) return;
            if (event.key === 'Escape' && action === 'down' && !event.shiftKey) { /* Escape belongs to the page while driving */ event.stopPropagation(); }
            event.preventDefault();
            send({ type: 'key', action, key: event.key, code: event.code, keyCode: event.keyCode, modifiers: mods(event) });
        };
        view.addEventListener('keydown', key('down')); view.addEventListener('keyup', key('up'));
        view.addEventListener('paste', event => { if (!onScreen(event)) return; event.preventDefault(); send({ type: 'text', text: event.clipboardData?.getData('text/plain') || '' }); });
    },

    // ── dialogs ──────────────────────────────────────────────────────────
    async browserSetup() {
        if (this.locked() || this._browserDialog) return;
        const api = window.electronAgentBrowser, esc = UIUtils.escapeHtml;
        let timer;
        try {
            const chrome = await api.command('chrome-prepare');
            const dialog = this._browserDialog = Modal.create({ title: 'Workroom browser', className: 'workroom-browser-dialog',
                content: `<p>Agents work in Google Chrome under a separate profile kept for them, including any websites you sign in to there. Your everyday Chrome profile is never touched. After this one-time setup, Chrome opens in the background when a job needs it.</p><ol><li>Choose <strong>Open Chrome setup</strong>.</li><li>On Chrome’s Extensions page, turn on Developer mode and choose <strong>Load unpacked</strong>.</li><li>Select this folder: <code class="workroom-extension-path">${esc(chrome.extensionPath)}</code></li></ol><div class="workroom-browser-setup-actions"><button class="secondary-btn" data-browser-setup="launch">Open Chrome setup</button><button class="secondary-btn" data-browser-setup="folder">Show folder</button><button class="secondary-btn" data-browser-setup="copy">Copy folder path</button></div><p data-browser-status role="status"></p><p>To sign in to a website yourself, choose Open browser and Take control, then come back and Continue.</p>`,
                onClose: () => { clearTimeout(timer); this._browserDialog = null; },
                buttons: [{ text: 'Done', className: 'secondary-btn', onClick: () => dialog.close() }] });
            const status = dialog.element.querySelector('[data-browser-status]');
            const refresh = async () => {
                if (this._browserDialog !== dialog) return;
                try {
                    const state = await api.command('chrome-state');
                    status.textContent = !state.supported ? 'Available on macOS and Linux for now.' : !state.available ? 'Install Google Chrome first.'
                        : state.stale ? 'Connected, but the extension loaded in Chrome is older than this app. Open chrome://extensions and reload the Anjadhe extension.'
                        : state.connected ? 'Connected. Chrome is ready.' : state.starting ? 'Starting Chrome…' : 'Not connected yet. After loading the extension, open its popup and choose Connect if needed.';
                } catch (error) { status.textContent = error.message; }
                if (this._browserDialog === dialog) timer = setTimeout(refresh, 2000);
            };
            dialog.element.addEventListener('click', async event => {
                const button = event.target.closest('[data-browser-setup]'); if (!button) return;
                button.disabled = true; clearTimeout(timer);
                try {
                    if (button.dataset.browserSetup === 'launch') await api.command('chrome-launch', { setup: true });
                    else if (button.dataset.browserSetup === 'folder') await api.command('chrome-folder');
                    else { await navigator.clipboard.writeText(chrome.extensionPath); button.textContent = 'Copied'; }
                } catch (error) { status.textContent = error.message; }
                finally { button.disabled = false; refresh(); }
            });
            refresh();
        } catch (error) { this.error(error); }
    },
    async websitePermissions() {
        if (this.locked() || this._websiteDialog) return;
        try {
            const sites = await window.electronAgentBrowser.command('trusted-sites'), esc = UIUtils.escapeHtml;
            this._websiteDialog = Modal.create({ title: 'Website permissions',
                content: `<p>On these websites, agents work without asking first, in every chat on this Mac. Anything that reads as buying, paying, confirming, sending, deleting or signing in still asks every time.</p><div class="workroom-trusted-sites">${sites.length ? sites.map(origin => `<p><strong>${esc(origin)}</strong> <button data-revoke-site="${esc(origin)}">Remove</button></p>`).join('') : '<p>No websites are always allowed.</p>'}</div>`,
                onClose: () => { this._websiteDialog = null; },
                buttons: [{ text: 'Done', className: 'secondary-btn', onClick: () => this._websiteDialog.close() }] });
            this._websiteDialog.element.addEventListener('click', async event => {
                const button = event.target.closest('[data-revoke-site]'); if (!button) return;
                button.disabled = true;
                try { await window.electronAgentBrowser.command('revoke-site', { origin: button.dataset.revokeSite }); button.parentElement.remove(); }
                catch (error) { button.disabled = false; this.error(error); }
            });
        } catch (error) { this.error(error); }
    },
    confirmDelete(id) {
        const room = this.rooms.find(room => room.id === id);
        if (!room || this.locked() || this._deleteDialog) return;
        this._deleteDialog = Modal.create({ title: 'Delete chat?', className: 'workroom-delete-dialog',
            content: `<p>Delete “${UIUtils.escapeHtml(room.title)}”?</p><p>This removes the conversation and its files from this Mac and stops any work in it. It cannot be undone.</p>`,
            onClose: () => { this._deleteDialog = null; },
            buttons: [{ text: 'Cancel', className: 'secondary-btn', onClick: () => this._deleteDialog.close() },
                // The exact chat named in the confirmation, whatever is selected by then.
                { text: 'Delete chat', className: 'danger-btn', onClick: async () => { this._deleteDialog.close(); await this.command('delete', { id }); } }] });
        this._deleteDialog.element.querySelector('.secondary-btn').focus();
    }
};

if (FEATURES.isEnabled('workrooms')) {
    AppManager.register('workrooms', WorkroomsApp);
    const tile = document.createElement('button'); tile.className = 'dash-app-tile'; tile.dataset.app = 'workrooms'; tile.dataset.feature = 'workrooms';
    tile.dataset.desc = 'Hand Anjadhe a job and it brings in the agents it needs.';
    tile.innerHTML = '<span class="dash-app-tile-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="14" rx="3"/><path d="M7 22v-4m10 4v-4M7 9h10M7 13h6"/></svg></span><span class="dash-app-tile-label">Workrooms</span>';
    document.querySelector('#app-registry .dash-apps-section')?.appendChild(tile);
    AgentTools.register({ type: 'function', function: {
        name: 'create_workroom', description: 'Hand a bigger job to a workroom: a separate chat where Anjadhe brings in specialist agents (mail, calendar, tasks, documents, web research, a browser that can operate websites, a writer) and works it through. Use when the user asks for agents or a team, or for a multi-step job on websites. The user approves new websites and every buying, paying, sending or signing-in step themselves. Returns the room id.',
        parameters: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] }
    }}, async (args, ctx) => {
        if (ctx?.private || ctx?.unattended) return { error: 'Create workrooms from an ordinary user conversation.' };
        if (WorkroomsApp.locked()) return { error: 'Unlock Anjadhe before creating a workroom.' };
        const room = await window.electronWorkrooms.command('create', { goal: args.goal });
        return { id: room.id, status: room.status, message: 'The workroom is started. The user can open Workrooms to follow it and answer its questions.' };
    }, { group: 'workrooms', domain: /\b(workrooms?|specialists?|team of agents|agents? (?:work|collaborat))\b/i, blockUntrusted: true, ask: true, describe: args => `Start a workroom for: ${UIUtils.escapeHtml(String(args.goal || '').slice(0, 160))}` });
}
