/**
 * PageChat (2026-10-04, by request): the assistant's box ON a page.
 *
 * A page other than Chats often has a focused box for the assistant (the
 * Commitments box, a commitment's sheet, next: Now's card). This is the one
 * shape for all of them: the conversation opens as an OVERLAY on the page
 * the person is on, and it is the chat page's own experience (the same
 * messages, streaming, tool activity, approvals, attachments, Undo), not a
 * smaller copy of it.
 *
 *   - A THING's box (a commitment's sheet) is a door: a click opens the
 *     overlay on that thing's own conversation, cursor in the composer.
 *   - A PAGE's box is typed into. The host reads the words first (`route`,
 *     e.g. Commitments' capture: a new commitment or a change, as tap
 *     cards); what it does not handle opens the overlay with the words sent.
 *
 * Laws:
 *   PC1  One conversation per THING or page (the key). It is the same record
 *        the Chats page lists: a thing's key is the chat's `todayKey`
 *        (`task:<id>`, as Now's cards use), a page's is `pageKey`
 *        (`page:<tool group>`, which gives the chat that page's tools).
 *   PC2  It never leaves the page by itself. The drawer's "Open full view"
 *        is the person's tap; closing it (the X, Esc) leaves them where they
 *        were, with the page in full width again.
 *   PC3  There is no second chat here. The drawer IS AgentUI's panel on
 *        that conversation, docked at the right as on any page; nothing
 *        about a turn differs from Chats.
 *   PC4  The host owns its fast path and its repaint: `route(text)` returns
 *        true when it handled the words, and `onChange()` is called when the
 *        drawer closes, since the conversation may have changed the page.
 *
 * A host calls `PageChat.html(key, opts)` inside its own markup.
 */
const PageChat = {
    _state: new Map(),   // key -> { draft, busy }
    _hosts: new Map(),   // key -> opts
    _docked: null,       // the key whose conversation is open in the drawer
    _wired: false,

    esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },

    state(key) {
        if (!this._state.has(key)) this._state.set(key, { draft: '', busy: false });
        return this._state.get(key);
    },
    setDraft(key, text) { this.state(key).draft = String(text || ''); },

    // ── The conversation (PC1) ──────────────────────────────────────────

    isPage(key) { return /^page:/.test(String(key)); },
    conv(key, create = false) {
        if (typeof AgentService === 'undefined') return null;
        const found = (AgentService.conversations || []).filter(c => (this.isPage(key) ? c.pageKey : c.todayKey) === key)
            .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))[0] || null;
        if (found || !create) return found;
        const host = this._hosts.get(key) || {};
        const now = new Date().toISOString();
        const conv = { id: 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), title: String(host.title || 'From a page').slice(0, 60),
            createdAt: now, updatedAt: now, messages: [] };
        if (this.isPage(key)) conv.pageKey = key; else conv.todayKey = key;
        // The record it is about (`recordKey`, e.g. `portfolio:account:<id>`):
        // its context block rides every turn and its tool groups are loaded,
        // as for a chat opened from that record anywhere else.
        if (host.recordKey) {
            conv.recordKey = String(host.recordKey);
            if (host.recordLabel) conv.recordLabel = String(host.recordLabel);
            try { AgentService._seedRecordDomains(conv); } catch { /* the model can still load the group */ }
        }
        // A thing's chat opens with a code-written note of what it is about
        // (as Now's cards do), so the assistant does not start from nothing.
        if (!this.isPage(key) && host.title) {
            const body = String(host.body || '').trim();
            conv.messages.push({ role: 'assistant', content: `This chat is about “${host.title}”.${body ? ` ${/[.!?]$/.test(body) ? body : body + '.'}` : ''} What would you like to do with it?`,
                timestamp: now, metadata: { fromCard: true } });
        }
        AgentService.conversations.unshift(conv);
        AgentService._saveConversations();
        return conv;
    },
    /** Has the person said anything in it yet? */
    started(key) {
        const conv = this.conv(key);
        return !!(conv && (conv.messages || []).some(m => m.role === 'user'));
    },

    // ── Markup ──────────────────────────────────────────────────────────

    html(key, opts = {}) {
        this._wire();
        this._hosts.set(key, opts);
        const st = this.state(key);
        const e = s => this.esc(s);
        const SEND = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';
        const started = this.started(key);
        // A thing's box is a door to its conversation.
        if (!opts.route) {
            return `<div class="page-chat" data-page-chat="${e(key)}">
                <button type="button" class="page-chat-box page-chat-door" data-pc="open" aria-label="${e(opts.label || 'Talk to nenva about this')}">
                    <span class="page-chat-hint">${e(started ? (opts.resumePlaceholder || 'Continue our conversation…') : (opts.placeholder || 'Tell me what to do with this…'))}</span>
                    <span class="page-chat-send" aria-hidden="true">${SEND}</span>
                </button>
            </div>`;
        }
        return `<div class="page-chat" data-page-chat="${e(key)}">
            <form class="page-chat-box">
                <input type="text" name="text" autocomplete="off" value="${e(st.draft)}" placeholder="${e(opts.placeholder || 'Tell me what to do…')}" aria-label="${e(opts.label || 'Talk to nenva')}" ${st.busy ? 'disabled' : ''}>
                <button type="submit" class="page-chat-send" aria-label="Send" ${st.busy ? 'disabled' : ''}>${st.busy ? '…' : SEND}</button>
            </form>
            ${started ? '<button type="button" class="page-chat-link page-chat-resume" data-pc="open">Show our conversation</button>' : ''}
        </div>`;
    },
    mount(key) { return [...document.querySelectorAll('[data-page-chat]')].find(el => el.dataset.pageChat === key) || null; },
    paint(key) {
        const el = this.mount(key);
        if (!el) return;
        const tmp = document.createElement('div');
        tmp.innerHTML = this.html(key, this._hosts.get(key) || {});
        el.replaceWith(tmp.firstElementChild);
    },
    _focus(key) { const el = this.mount(key); const i = el && el.querySelector('.page-chat-box input'); if (i) i.focus(); },

    // ── A page's box: the host first, else the conversation (PC4) ──────

    async submit(key, text) {
        const t = String(text || '').trim();
        const st = this.state(key), host = this._hosts.get(key) || {};
        if (!t || st.busy) return;
        st.draft = '';
        if (host.route) {
            st.busy = true; this.paint(key);
            let handled = false;
            try { handled = await host.route(t); } catch (e) { console.warn('[page-chat] route failed:', e); }
            st.busy = false;
            this.paint(key);
            if (handled) { this._focus(key); return; }
        }
        this.open(key, t);
    },

    // ── The drawer: the chat itself, a bottom sheet over this page (PC2, PC3) ──

    /** Open the key's conversation in the drawer over the page; `text` is sent as the person's message. */
    open(key, text = '') {
        if (typeof AgentUI === 'undefined' || typeof AgentService === 'undefined') return;
        const conv = this.conv(key, true);
        const host = this._hosts.get(key) || {};
        this._dock(conv, key, host.title, text);
    },
    /**
     * Open a conversation that already exists in the same drawer, e.g. a Now
     * card's thing chat (SimpleExperience.openChatFor, 2026-10-09: the card's
     * box and the Commitments sheet's chat door rise over the page instead
     * of leaving it for Chats).
     */
    openConversation(conv, title = '', onClose = null) {
        if (!conv || typeof AgentUI === 'undefined' || typeof AgentService === 'undefined') return;
        this._dock(conv, conv.todayKey || conv.pageKey || conv.id, title || conv.title);
        this._onClose = onClose;
    },
    _dock(conv, key, heading, text = '') {
        this._docked = key;
        this._onClose = null;
        document.body.classList.add('page-chat-docked');
        const title = document.querySelector('#agent-panel .agent-header-title');
        if (title) { if (this._title == null) this._title = title.textContent; title.textContent = heading || this._title; }
        // open() paints at once and only then waits on the engine check.
        AgentUI.open();
        AgentService.loadConversation(conv.id);
        AgentUI.renderMessages();
        const input = document.getElementById('agent-input');
        if (text && input) { input.value = text; AgentUI.sendMessage(); }
    },
    _closed() {
        const key = this._docked;
        document.body.classList.remove('page-chat-docked');
        const title = document.querySelector('#agent-panel .agent-header-title');
        if (title && this._title != null) { title.textContent = this._title; this._title = null; }
        if (!key) return;
        this._docked = null;
        const onClose = this._onClose;
        this._onClose = null;
        if (onClose) { try { onClose(); } catch (e) { console.warn('[page-chat] onClose failed:', e); } }
        const host = this._hosts.get(key) || {};
        if (host.onChange) { try { host.onChange(); } catch (e) { console.warn('[page-chat] onChange failed:', e); } }
        else this.paint(key);
    },

    // ── Events (one delegate for every box) ─────────────────────────────

    _wire() {
        if (this._wired || typeof document === 'undefined') return;
        this._wired = true;
        const keyOf = t => { const el = t.closest && t.closest('[data-page-chat]'); return el ? el.dataset.pageChat : null; };
        document.addEventListener('submit', e => {
            if (!e.target.classList || !e.target.classList.contains('page-chat-box')) return;
            e.preventDefault(); e.stopPropagation();
            const key = keyOf(e.target);
            if (key) this.submit(key, e.target.querySelector('input').value);
        }, true);
        document.addEventListener('input', e => {
            if (e.target.matches && e.target.matches('.page-chat-box input')) { const key = keyOf(e.target); if (key) this.state(key).draft = e.target.value; }
        });
        document.addEventListener('click', e => {
            const b = e.target.closest && e.target.closest('[data-pc="open"]');
            const key = b && keyOf(b);
            if (!key) return;
            e.stopPropagation();
            this.open(key);
        }, true);
        document.addEventListener('keydown', e => {
            if (e.key !== 'Escape' || !this._docked || document.querySelector('dialog[open]')) return;
            AgentUI.close();
        });
        document.addEventListener('anjadhe:agent-panel-closed', () => this._closed());
    }
};

if (typeof module !== 'undefined') module.exports = PageChat;
