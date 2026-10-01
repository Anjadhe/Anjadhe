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
        'REMOTE CHANNEL — this conversation happens in the nenva app on the user\'s ' +
        'phone while you run on their Mac. They CAN reply, so a short clarifying question ' +
        'is fine when truly needed. Style: concise and phone-readable — short paragraphs, ' +
        'simple markdown (bold, short lists) is fine, avoid wide tables. When you mention a ' +
        'specific task, note, journal entry, event, routine, or bookmark a tool returned, link its ' +
        'title — [Pay water bill](anjadhe://task/<id from the tool result>) — the phone opens ' +
        'it in place; never invent an id. You may use your tools, including creating or ' +
        'updating records when asked. An action that needs approval is asked on their phone; ' +
        'if they decline or do not answer, say plainly that it was not done. Never include ' +
        'secrets, API keys, or file contents unless explicitly asked.',

    init() {
        if (!window.electronMobileChat) return;
        window.electronMobileChat.onMessage((msg) => this._enqueue(msg));
        window.electronMobileChat.onAnswer?.((a) => this._answerAsk(a));
    },

    // ── Approvals on the phone (2026-09-25, docs/MOBILE_NATIVE.md "M5") ──
    //
    // A phone turn used to decline every step that needed approval ("it has
    // to be confirmed on the Mac"). Now the question goes to the phone —
    // the CLIBridge shape: AgentService._confirmWrite asks here while this
    // conversation has a live phone run, and the answer resolves it. Same
    // words as the Mac's own card (`AgentUI._describeToolAction`), same
    // scopes (once / this session / always, or once only), same grants.
    // An ask is PUSHED to the phone (`chat-ask`) and also kept here, so a
    // phone that was not connected at that moment gets it from the
    // `chat-asks` view the next time it looks. Unanswered for ten minutes →
    // declined, and the run says so.
    ASK_TIMEOUT_MS: 10 * 60 * 1000,
    _running: new Set(),      // conv ids with a phone run in progress
    _asks: new Map(),         // askId -> { ask, resolve, timer }
    _askSeq: 0,

    wantsPermission(convId) {
        return !!convId && this._running.has(convId);
    },

    /** Plain text of the Mac card's one-line description. */
    _describe(tool, args) {
        let html = '';
        try { html = (typeof AgentUI !== 'undefined' && AgentUI._describeToolAction) ? AgentUI._describeToolAction(tool, args) : ''; } catch { html = ''; }
        const text = String(html || '')
            .replace(/<\/?strong>/gi, '**').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
            .trim();
        return text || String(tool || '').replace(/_/g, ' ');
    },

    askPermission(convId, tool, args, note, { onceOnly = false } = {}) {
        const askId = 'ask_' + Date.now().toString(36) + '_' + (++this._askSeq);
        const ask = {
            askId, convId, tool: String(tool || ''),
            text: this._describe(tool, args).slice(0, 2000),
            note: typeof note === 'string' ? note.slice(0, 600) : '',
            onceOnly: !!onceOnly,
            at: new Date().toISOString(),
        };
        return new Promise((resolve) => {
            const timer = setTimeout(() => this._settleAsk(askId, { approved: false, scope: 'once' }), this.ASK_TIMEOUT_MS);
            this._asks.set(askId, { ask, resolve, timer });
            try { window.electronMobileChat.sendAsk?.(ask); } catch { /* the view still carries it */ }
        });
    },

    /** Asks still waiting, for the phone's `chat-asks` view. */
    pendingAsks() {
        return [...this._asks.values()].map(e => e.ask);
    },

    _answerAsk(a) {
        if (!a || typeof a.askId !== 'string' || !this._asks.has(a.askId)) return false;
        const scope = ['once', 'session', 'always'].includes(a.scope) ? a.scope : 'once';
        const entry = this._asks.get(a.askId);
        this._settleAsk(a.askId, { approved: a.approved === true, scope: entry.ask.onceOnly ? 'once' : scope });
        return true;
    },

    _settleAsk(askId, decision) {
        const entry = this._asks.get(askId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this._asks.delete(askId);
        try { window.electronMobileChat.sendAskDone?.({ askId, approved: decision.approved }); } catch { /* best effort */ }
        entry.resolve(decision);
    },

    /** A run ended: nothing may stay asked on its behalf. */
    _endRun(convId) {
        this._running.delete(convId);
        for (const [askId, e] of this._asks) if (e.ask.convId === convId) this._settleAsk(askId, { approved: false, scope: 'once' });
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

    // --- Streaming the answer as it is written (2026-09-21) ----------------
    //
    // The phone used to sit on "Your Mac is thinking…" for the whole run and
    // then get the finished answer in one push. It now watches it arrive.
    //
    // It has to be a POLL, not a callback. `AgentService.sendMessage` takes an
    // `onChunk`, but `wrappedOnChunk` drops it unless the conversation is the
    // ACTIVE one in the Mac's own UI (agent-service.js, "if
    // (this.activeConversationId !== targetConvId) return") — and a mobile
    // conversation is deliberately never made active. The accumulated buffer
    // fills regardless, so we read that. This is exactly what `CLIBridge`
    // does for the terminal, and the two subtleties it learned are copied
    // here: the buffer RESETS to empty at the start of every tool iteration
    // (so a shrink means "start again", not "text was deleted"), and the last
    // tokens land after the final tick — harmless for us, because the
    // authoritative full text still rides the `chat-reply` that follows.
    //
    // Cadence is the cost control. Every push is a sealed, counter-numbered,
    // hex-encoded frame over the encrypted channel, so per-token would be
    // absurd — roughly ten times the bytes in overhead and a WKWebView
    // round trip per token on the phone. A tick of 300 ms with a small
    // minimum flush gives three-ish pushes a second, the same order as the
    // `data-changed` debounce, and reads as typing on the other end.
    STREAM_TICK_MS: 300,
    STREAM_MIN_CHARS: 24,

    /**
     * Start forwarding this conversation's stream buffer to the phone.
     * Returns a function that stops it. Deltas are INCREMENTAL (a cumulative
     * push would re-send the whole answer every tick and cross the channel's
     * gzip threshold mid-stream), and carry a `seq` so the phone can tell a
     * gap from a pause after a reconnect.
     */
    _streamTo(convId) {
        const send = window.electronMobileChat && window.electronMobileChat.sendDelta;
        if (typeof send !== 'function') return () => {};
        let sent = 0;
        let seq = 0;
        const flush = (force) => {
            const st = AgentService._streamingState && AgentService._streamingState.get(convId);
            if (!st) return;
            const content = String(st.content || '');
            // A shorter buffer is the next tool iteration starting, not an
            // edit — begin again rather than slicing from a stale offset.
            if (content.length < sent) { sent = 0; return; }
            const pending = content.length - sent;
            if (!pending) return;
            if (!force && pending < this.STREAM_MIN_CHARS) return;
            const text = content.slice(sent);
            sent = content.length;
            seq += 1;
            try { send({ convId, seq, text }); } catch { /* best effort; the reply still lands */ }
        };
        const timer = setInterval(() => flush(false), this.STREAM_TICK_MS);
        return () => { clearInterval(timer); flush(true); };
    },

    async _answer(text, msg) {
        if (typeof AgentService === 'undefined' || typeof AgentService.sendMessage !== 'function') return;
        const respond = (ok, convId, replyText) => window.electronMobileChat
            .sendResult({ ok, convId: convId || null, text: replyText })
            .catch(() => { /* push is best-effort; sync still carries the reply */ });

        if (!AgentService.model) {
            respond(false, null,
                'No AI model is set up on the Mac yet. Open nenva there: Settings, then AI Assistant.');
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
        // A conversation the phone started or continued on its own while
        // this Mac was away arrives through sync, and may land a moment
        // after the message naming it: take in what the store holds before
        // deciding it is unknown (docs/MOBILE_NATIVE.md "M5").
        if (!conv && msg && msg.convId && AgentService.mergeStoredConversations) {
            AgentService.mergeStoredConversations();
            conv = (AgentService.conversations || [])
                .find((c) => c && c.id === msg.convId && c.channel === 'mobile') || null;
        }
        if (!conv) conv = this._currentConv();
        if (!conv) conv = this._newConv(text);
        // Framing must survive a conv created before this build, or synced in.
        if (!conv.extraContext) conv.extraContext = this.EXTRA_CONTEXT;

        let res;
        const stopStream = this._streamTo(conv.id);
        this._running.add(conv.id);
        try {
            res = await AgentService.sendMessage(text, null, {
                convId: conv.id,          // a real, persisted conversation — not ephemeral
                unattended: true,         // nobody at the Mac; approvals go to the phone (wantsPermission)
                readOnly: false,          // writes allowed (add a task from the road)
                logTag: 'mobile',         // LLM Logs names the source; the ledger is the disclosure
            });
        } catch (e) {
            stopStream();
            this._endRun(conv.id);
            respond(false, conv.id, 'Sorry — that didn\'t work: ' + (e && e.message || 'the run failed') + '.');
            return;
        }
        stopStream();
        this._endRun(conv.id);

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
