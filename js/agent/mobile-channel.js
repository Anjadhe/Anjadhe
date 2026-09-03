/**
 * mobile-channel.js — the renderer half of the phone chat channel.
 * ================================================================
 * The phone app as a remote channel to the assistant: the Telegram shape
 * (js/agent/telegram-channel.js) carried on our own encrypted phone<->Mac
 * channel instead of a third party's servers. Main (handleChannelChat)
 * forwards text that arrived over the Noise channel — only a PAIRED phone
 * can produce it, so what lands here is the USER's own text, remotely.
 *
 * Phone exchanges are REAL conversations, like Telegram's: each message
 * lands in a persistent conversation tagged `channel: 'mobile'` — titled
 * "Phone: …", synced across Macs AND down to the phone itself (the
 * `app_agent-conversations` blob syncs), visible in the Agent app, and
 * feeding memory extraction like any chat. Never made active: a message
 * from the phone must not hijack whatever chat is open on the Mac.
 *
 * Two things Telegram cannot do, this channel can:
 *   - The phone renders markdown AND anjadhe:// record links (they deep-
 *     link into the phone's own screens), so replies keep their links —
 *     there is no _plain() flattening here.
 *   - The reply is durable without the socket: it goes back as a
 *     `chat-reply` push for immediacy, but it also rides the synced
 *     conversation blob, so a phone that disconnected mid-run still gets
 *     the answer on its next sync.
 *
 * Session shape: messages continue the latest mobile conversation until a
 * quiet gap passes or the phone asks for a fresh one (`fresh: true`) —
 * the retired conversation is queued for memory extraction, the same
 * hand-off leaving a chat in the UI performs. The phone may also pin a
 * specific conversation by `convId` (it holds the synced list).
 *
 * The run: full assistant (system prompt, briefing, tools) with phone
 * framing riding the conv's extraContext. Interactive in spirit (the user
 * CAN reply) but unattended in the consent sense — nobody can click a Mac
 * dialog, so ASK-gated tools decline and egress asks auto-resolve, the
 * same machinery routines use.
 */
const MobileChannel = {
    _queue: Promise.resolve(),        // messages answer strictly in order
    SESSION_GAP_MS: 3 * 60 * 60 * 1000, // quiet this long → next message starts a new conversation

    EXTRA_CONTEXT:
        'REMOTE CHANNEL — this conversation happens in the Anjadhe app on the user\'s ' +
        'phone while you run on their Mac. They CAN reply, so a short clarifying question ' +
        'is fine when truly needed. Style: concise and phone-readable — short paragraphs, ' +
        'simple markdown (bold, short lists) is fine, avoid wide tables. When you mention a ' +
        'specific task, note, journal entry, event, routine, or bookmark a tool returned, link its ' +
        'title — [Pay water bill](anjadhe://task/<id from the tool result>) — the phone opens ' +
        'it in place; never invent an id. You may use your tools, including creating or ' +
        'updating records when asked. If an action is declined because it needs the user\'s ' +
        'approval, say plainly that it has to be confirmed on their Mac. Never include ' +
        'secrets, API keys, or file contents unless explicitly asked.',

    init() {
        if (!window.electronMobileChat) return;
        window.electronMobileChat.onMessage((msg) => this._enqueue(msg));
    },

    _enqueue(msg) {
        const text = msg && typeof msg.text === 'string' ? msg.text.trim() : '';
        if (!text) return;
        this._queue = this._queue
            .then(() => this._answer(text, msg))
            .catch((e) => console.warn('[mobile-chat] answer failed:', e && e.message));
    },

    /**
     * The current phone conversation: the newest conv tagged
     * `channel: 'mobile'`, unless it has gone quiet past the session gap.
     * Reload-safe — the tag is on the persisted record, so a Cmd+R (or
     * another Mac, via sync) continues the same thread.
     */
    _currentConv() {
        const convs = AgentService.conversations || [];
        let latest = null;
        for (const c of convs) {
            if (c && c.channel === 'mobile'
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

    /** Start a fresh persistent phone conversation — NOT active. */
    _newConv(firstText) {
        const conv = {
            id: 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            title: 'Phone: ' + String(firstText).slice(0, 48) + (String(firstText).length > 48 ? '…' : ''),
            channel: 'mobile',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messages: []
        };
        conv.extraContext = this.EXTRA_CONTEXT;
        AgentService.conversations.unshift(conv);
        AgentService._saveConversations();
        return conv;
    },

    /** Retire the current session so the next message starts fresh. */
    _endSession() {
        const cur = this._currentConv();
        if (!cur) return;
        cur.updatedAt = new Date(0).toISOString(); // age it out
        try { AgentService._queueMemoryExtraction(cur); } catch { /* best-effort */ }
        AgentService._saveConversations();
    },

    async _answer(text, msg) {
        if (typeof AgentService === 'undefined' || typeof AgentService.sendMessage !== 'function') return;
        const respond = (ok, convId, replyText) => window.electronMobileChat
            .sendResult({ ok, convId: convId || null, text: replyText })
            .catch(() => { /* push is best-effort; sync still carries the reply */ });

        if (!AgentService.model) {
            respond(false, null,
                'No AI model is set up on the Mac yet. Open Anjadhe there: Settings, then AI Assistant.');
            return;
        }

        if (msg && msg.fresh === true) this._endSession();

        // The phone may pin the conversation it is showing; otherwise the
        // session-gap rule picks (or starts) the current one.
        let conv = null;
        if (msg && msg.convId) {
            conv = (AgentService.conversations || [])
                .find((c) => c && c.id === msg.convId && c.channel === 'mobile') || null;
        }
        if (!conv) conv = this._currentConv();
        if (!conv) conv = this._newConv(text);
        // Framing must survive a conv created before this build, or synced in.
        if (!conv.extraContext) conv.extraContext = this.EXTRA_CONTEXT;

        let res;
        try {
            res = await AgentService.sendMessage(text, null, {
                convId: conv.id,          // a real, persisted conversation — not ephemeral
                unattended: true,         // nobody can click a Mac dialog; ASK-gated tools decline
                readOnly: false,          // writes allowed (add a task from the road)
                logTag: 'mobile',         // LLM Logs names the source; the ledger is the disclosure
            });
        } catch (e) {
            respond(false, conv.id, 'Sorry — that didn\'t work: ' + (e && e.message || 'the run failed') + '.');
            return;
        }

        // sendMessage returns null when the conv already has a stream in
        // flight — our queue serializes sends, so treat it as a failure.
        if (res && res.type !== 'error' && String(res.content || '').trim()) {
            respond(true, conv.id, String(res.content));
        } else {
            respond(false, conv.id, 'Sorry — that didn\'t work: '
                + ((res && res.content) || 'the assistant returned nothing') + '.');
        }
    },
};
