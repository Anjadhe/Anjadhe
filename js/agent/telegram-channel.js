/**
 * telegram-channel.js — the renderer half of the Telegram bridge.
 * ===============================================================
 * Main (js/main/telegram-bridge.js) owns the token, the poll loop and the
 * one-linked-chat allowlist; every message it forwards here has already
 * passed that gate, so what arrives is the USER's own text, remotely.
 *
 * Telegram exchanges are REAL conversations (2026-08-31, by request):
 * each message lands in a persistent conversation in the assistant's own
 * list — titled "Telegram: …", synced across Macs, visible in the Agent
 * app, and feeding memory extraction like any chat. The conversation is
 * NEVER made active: a message arriving from the phone must not hijack
 * whatever chat is open on the Mac (sendMessage targets it by convId).
 *
 * Session shape: messages continue the latest Telegram conversation until
 * a quiet gap (SESSION_GAP_MS) passes or the user sends /new — then a
 * fresh conversation starts and the retired one is queued for memory
 * extraction, the same hand-off leaving a chat in the UI performs.
 *
 * The run itself: full assistant (system prompt, briefing, tools) with
 * Telegram framing riding the conv's extraContext. Interactive in spirit
 * (the user CAN reply) but unattended in the consent sense — nobody can
 * click a dialog, so ASK-gated tools decline with "needs your approval on
 * the Mac" and egress asks auto-resolve, the same machinery routines use.
 *
 * Replies go back as plain text: Telegram renders no markdown, and its
 * parse modes error on unbalanced characters — `_plain` flattens the
 * assistant's markdown (record links become their titles; web links keep
 * their URLs) rather than gambling on parse_mode.
 */
const TelegramChannel = {
    _queue: Promise.resolve(),        // messages answer strictly in order
    SESSION_GAP_MS: 3 * 60 * 60 * 1000, // quiet this long → next message starts a new conversation

    EXTRA_CONTEXT:
        'REMOTE CHANNEL — this conversation happens over Telegram: the user is messaging ' +
        'from their phone while you run on their Mac. They CAN reply, so a short clarifying ' +
        'question is fine when truly needed. Style: plain text only — no markdown headers, ' +
        'bold, tables, or anjadhe:// links (they do not render in Telegram); keep answers ' +
        'concise, phone-readable, and self-contained. You may use your tools, including ' +
        'creating or updating records when asked. If an action is declined because it needs ' +
        'the user\'s approval, say plainly that it has to be confirmed on their Mac. ' +
        'Never include secrets, API keys, or file contents unless explicitly asked.',

    init() {
        if (!window.electronTelegram) return;
        window.electronTelegram.onMessage((msg) => this._enqueue(msg));
        // Settings re-render when a link handshake completes mid-view.
        window.electronTelegram.onLinked(() => {
            if (typeof SettingsApp !== 'undefined' && SettingsApp._renderTelegram) {
                try { SettingsApp._renderTelegram(); } catch { /* view not open */ }
            }
        });
    },

    _enqueue(msg) {
        const text = msg && typeof msg.text === 'string' ? msg.text.trim() : '';
        if (!text) return;
        this._queue = this._queue
            .then(() => this._answer(text))
            .catch((e) => console.warn('[telegram] answer failed:', e && e.message));
    },

    /**
     * The current Telegram conversation: the newest conv tagged
     * `channel: 'telegram'`, unless it has gone quiet past the session gap.
     * Reload-safe — the tag is on the persisted record, so a Cmd+R (or
     * another Mac, via sync) continues the same thread.
     */
    _currentConv() {
        const convs = AgentService.conversations || [];
        let latest = null;
        for (const c of convs) {
            if (c && c.channel === 'telegram'
                && (!latest || (c.updatedAt || '') > (latest.updatedAt || ''))) {
                latest = c;
            }
        }
        if (!latest) return null;
        const age = Date.now() - new Date(latest.updatedAt || latest.createdAt || 0).getTime();
        if (age > this.SESSION_GAP_MS) {
            // Session over — retire it into memory extraction (the same
            // hand-off leaving a chat performs) and let a new one start.
            try { AgentService._queueMemoryExtraction(latest); } catch { /* best-effort */ }
            return null;
        }
        return latest;
    },

    /** Start a fresh persistent Telegram conversation — NOT active. */
    _newConv(firstText) {
        const conv = {
            id: 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            title: 'Telegram: ' + String(firstText).slice(0, 48) + (String(firstText).length > 48 ? '…' : ''),
            channel: 'telegram',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messages: []
        };
        conv.extraContext = this.EXTRA_CONTEXT;
        AgentService.conversations.unshift(conv);
        AgentService._saveConversations();
        return conv;
    },

    async _answer(text) {
        if (typeof AgentService === 'undefined' || typeof AgentService.sendMessage !== 'function') return;
        if (!AgentService.model) {
            await window.electronTelegram.send(
                'No AI model is set up on the Mac yet. Open Anjadhe there: Settings, then AI Assistant.');
            return;
        }

        // /new — deliberately end the session, whatever its age.
        if (/^\/new\b/i.test(text)) {
            const cur = this._currentConv();
            if (cur) {
                cur.updatedAt = new Date(0).toISOString(); // age it out
                try { AgentService._queueMemoryExtraction(cur); } catch { /* best-effort */ }
                AgentService._saveConversations();
            }
            await window.electronTelegram.send('Started a fresh conversation.');
            return;
        }

        let conv = this._currentConv();
        if (!conv) conv = this._newConv(text);
        // Framing must survive a conv created before this build, or synced in.
        if (!conv.extraContext) conv.extraContext = this.EXTRA_CONTEXT;

        // Telegram shows "typing…" for ~5s per sendChatAction, and a model
        // run takes longer — refresh it while the run is in flight so the
        // user can see the Mac is still working.
        window.electronTelegram.typing();
        const typingTimer = setInterval(() => window.electronTelegram.typing(), 4500);
        let res;
        try {
            res = await AgentService.sendMessage(text, null, {
                convId: conv.id,          // a real, persisted conversation — not ephemeral
                unattended: true,         // nobody can click a dialog; ASK-gated tools decline
                readOnly: false,          // writes allowed (add a task from the road)
                logTag: 'telegram',       // LLM Logs names the source; the ledger is the disclosure
            });
        } finally {
            clearInterval(typingTimer);
        }

        // sendMessage returns null when the conv already has a stream in
        // flight — our queue serializes sends, so treat it as a failure.
        let reply;
        if (res && res.type !== 'error' && String(res.content || '').trim()) {
            reply = this._plain(res.content);
        } else {
            reply = 'Sorry — that didn\'t work: '
                + ((res && res.content) || 'the assistant returned nothing') + '.';
        }
        await window.electronTelegram.send(reply);
    },

    /** Markdown → Telegram-friendly plain text. */
    _plain(md) {
        let s = String(md || '');
        // Record links carry app-internal ids — keep the human title only.
        s = s.replace(/\[([^\]]*)\]\(anjadhe:\/\/[^)]*\)/g, '$1');
        // Web links: title + URL, both useful on a phone.
        s = s.replace(/\[([^\]]*)\]\((https?:\/\/[^)]*)\)/g, '$1 ($2)');
        s = s.replace(/^#{1,6}\s+/gm, '');            // headers
        s = s.replace(/\*\*([^*]+)\*\*/g, '$1');      // bold
        s = s.replace(/\*([^*\n]+)\*/g, '$1');        // italic
        s = s.replace(/^```[^\n]*$/gm, '');           // fence lines
        s = s.replace(/`([^`]+)`/g, '$1');            // inline code
        s = s.replace(/^\s*[-*]\s+/gm, '• ');    // bullets
        s = s.replace(/\n{3,}/g, '\n\n');
        return s.trim();
    },
};
