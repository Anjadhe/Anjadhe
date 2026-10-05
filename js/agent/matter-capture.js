/**
 * MatterCapture — what the person says in a chat reaches the folder it is
 * about (2026-10-05, docs/MATTERS.md §15).
 *
 * Why: folders were fed only by mail and texts. A chat opened from a
 * folder's card could read the folder (get_matter) and set its card aside,
 * but "I paid that yesterday" or "they moved it to the 14th" changed
 * nothing: the richest thing nenva hears, what the person tells it directly,
 * never reached the place that holds the whole picture.
 *
 * This is the first chat source: a chat TIED to a folder (conv.todayKey is
 * the folder's id), so which folder is already known and nothing is ever
 * created from here. General chats (which folder? a new one?) come with the
 * wider search (§15, later phase).
 *
 * Laws:
 *   C1 The assistant judges, once per turn (`matter-chat`): did the person's
 *      own words change where this thing stands, or only ask about it?
 *   C2 Kept only with a quote copied verbatim from what the PERSON typed in
 *      this turn; never the assistant's words, never an email or a page. The
 *      folder's history keeps the quote itself.
 *   C3 Code checks the rest (`vet`): a status or step may hold no number the
 *      person's words and the folder lack; dates must be real; a done or
 *      cancelled thing gets no new step.
 *   C4 Written through Matters' own `apply` (`Matters.foldOwn`), with the
 *      receipt under the answer and Undo. The receipt is written by code.
 *      Nothing is sent, paid or scheduled from here.
 *   C5 Never from a private, no-personal-context, untrusted or headless
 *      turn; never when the turn already set the card aside; one capture at
 *      a time per conversation; fire-and-forget.
 *
 * Pure gates are Node-testable (tests/matter-capture-test.js).
 */
const MatterCapture = {
    CHANGES: ['none', 'note', 'changed', 'done', 'cancelled'],
    _busy: new Set(),

    get M() { return typeof Matters !== 'undefined' ? Matters : require('../core/matters.js'); },
    _norm(s) { return String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim(); },
    /** C2: the quote is in the person's own words. */
    quoteOk(quote, userText) {
        const q = this._norm(quote);
        return q.length >= 2 && this._norm(userText).includes(q);
    },

    /** The folder a chat is tied to, or null. */
    folderFor(conv) {
        const key = String((conv && conv.todayKey) || '');
        if (!/^matter:/.test(key)) return null;
        return this.M.get(key) || (key.startsWith('matter:matter:') ? this.M.get(key.slice(7)) : null);
    },
    /** The call's tag: a folder holding texts rides the `messages` privacy class, any other `email`. */
    sourceFor(m) { return ((m && m.sources) || []).some(s => s.kind === 'imessage') ? 'matter-chat-text' : 'matter-chat'; },

    /**
     * Keep the assistant's answer only where it is checkable (C2, C3). Pure.
     * Returns a judgment `Matters.apply` takes, plus `note` (the history
     * line) and `receipt` (what the person is told), or null.
     */
    vet(raw, m, userText, now = Date.now()) {
        const M = this.M;
        if (!raw || typeof raw !== 'object' || !m) return null;
        const change = this.CHANGES.includes(raw.change) ? raw.change : 'none';
        if (change === 'none') return null;
        const quote = String(raw.quote || '').replace(/\s+/g, ' ').trim().slice(0, 140);
        if (!this.quoteOk(quote, userText)) return null;
        const known = new Set([...M._nums(userText), ...M._nums(`${m.title || ''} ${m.status || ''} ${m.amount || ''} ${(m.when && `${m.when.date} ${m.when.time || ''}`) || ''} ${(m.next && m.next.what) || ''} ${(m.sources || []).map(s => s.summary).join(' ')}`)]);
        const clean = (s, max) => {
            const v = String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
            return v && M._nums(v).every(n => known.has(n)) ? v : '';
        };
        const lo = M._iso(now - 400 * 86400000), hi = M._iso(now + 730 * 86400000);
        const date = d => { const v = M._day(d); return v && v >= lo && v <= hi ? v : null; };
        const time = t => { const x = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim()); return x && +x[1] < 24 && +x[2] < 60 ? `${x[1].padStart(2, '0')}:${x[2]}` : null; };
        const closing = change === 'done' || change === 'cancelled';
        const status = change === 'note' ? '' : clean(raw.status, 80);
        const when = closing || change === 'note' ? null : date(raw.when);
        let next = null;
        const n = raw.next;
        if (!closing && change !== 'note' && n && typeof n === 'object') {
            const what = clean(n.what, 120);
            if (what) next = { what, label: null, by: date(n.by), how: 'none', reply: null, url: null, yours: n.yours === true, isTask: false };
        }
        // "changed" has to change something a check let through.
        if (change === 'changed' && !status && !when && !next) return null;
        const receipt = change === 'done' ? 'marked done' : change === 'cancelled' ? 'marked cancelled' : change === 'note' ? 'noted' : (status || 'updated');
        return {
            about: m.id, kind: m.kind || 'other', title: '', status, change: change === 'note' ? 'same' : change,
            when, time: when ? time(raw.time) : null, next, calendarEventId: null, taskId: null, checkinUrl: null, tell: 'file',
            quote, note: `You said: "${quote}"`, receipt
        };
    },

    _prompt(m, userText, before, now = Date.now()) {
        const M = this.M;
        const today = new Date(now).toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const step = M.openStep(m);
        const lines = [
            `${M.titleOf(m)} (${m.kind}, ${m.state})`,
            m.status ? `Where it stands: ${m.status}` : '',
            m.when && m.when.date ? `When: ${m.when.date}${m.when.time ? ' ' + m.when.time : ''}` : '',
            step ? `Their next step: ${step.what}${step.by ? ` by ${step.by}` : ''}` : 'Nothing is waiting on them.',
            ...(m.sources || []).slice(-3).map(s => `- ${s.from || 'unknown'}: ${String(s.summary || '').slice(0, 160)}`)
        ].filter(Boolean);
        return `Today is ${today}.

You keep a folder for one real thing in the person's life. They are talking with you about it. Decide whether what they JUST SAID changes where it stands.

THE FOLDER
${lines.join('\n')}
${before ? `\nYOU (context only, never quote it): ${String(before).slice(0, 400)}\n` : ''}
THE PERSON JUST SAID:
${userText}

Answer JSON only:
{"change": "none" if they only asked something, chatted, or told you what to do with the card (ignore it, later); "done" if they say it is finished or dealt with (paid, went, picked up, confirmed, sorted out); "cancelled" if they say it is off; "changed" if they tell you a new fact about it (a new date or time, a new amount, what they will do next, where it stands now); "note" if they said something about it worth keeping that changes none of that,
 "quote": the phrase that says so, copied EXACTLY from what the person just said,
 "status": where it stands now in a few words, or null,
 "when": "YYYY-MM-DD" only if they gave a new date, else null, "time": "HH:MM" or null,
 "next": {"what": the one thing they now have to do, "by": "YYYY-MM-DD" or null, "yours": true if it is real work for them} only if they said what comes next, else null}
Never invent amounts, dates or times. When unsure, answer "none".`;
    },

    /** C5. */
    eligible(conv, { untrusted = false } = {}) {
        if (!conv || untrusted || conv.contextMode === 'simple') return false;
        if (typeof PrivateChat !== 'undefined' && PrivateChat.isPrivate(conv)) return false;
        return true;
    },

    /** Called at the end of every chat turn (AgentService.sendMessage), beside MemoryCapture. */
    afterTurn({ conv, msg, userText, toolLog = [], untrusted = false }) {
        try {
            if (!this.eligible(conv, { untrusted }) || typeof Matters === 'undefined' || typeof LLMLogger === 'undefined') return;
            const text = String(userText || '').trim();
            if (!text || this._busy.has(conv.id)) return;
            // The card was set aside in this turn: the chat already reached it.
            if ((toolLog || []).some(t => t && t.ok && t.tool === 'set_card_aside')) return;
            const m = this.folderFor(conv);
            if (!m) return;
            this._busy.add(conv.id);
            this._capture(conv, msg, m, text.slice(0, 1500))
                .catch(e => console.warn('[matter-capture] failed:', e))
                .finally(() => this._busy.delete(conv.id));
        } catch (e) {
            console.warn('[matter-capture] guard error:', e);
        }
    },

    async _capture(conv, msg, m, userText) {
        const msgs = conv.messages || [];
        const idx = msg ? msgs.indexOf(msg) : -1;
        const before = msgs.slice(0, idx < 0 ? msgs.length : idx).filter(x => x.role === 'assistant' && typeof x.content === 'string').slice(-1)[0];
        const tag = this.sourceFor(m);
        const res = await LLMLogger.call(tag, {
            model: AgentService.model,
            messages: [{ role: 'system', content: 'You are the person\'s personal assistant. You answer with JSON only.' },
                { role: 'user', content: this._prompt(m, userText, before && before.content) }],
            format: 'json', think: false, maxTokens: 300, stream: false, jobClass: 'background', logTag: tag,
            options: { temperature: 0.1, num_ctx: AgentService.numCtx || 8192 }
        });
        if (!res || res.error) return;
        let raw = null;
        try { raw = JSON.parse(String(res.message && res.message.content || '').replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim()); } catch { raw = null; }
        // The folder may have moved on while the model was asked: check against it as it is now.
        const now = Matters.get(m.id);
        const j = now && this.vet(raw, now, userText);
        if (!j) return;
        const f = Matters.observation({ id: `chat:${conv.id}:${idx >= 0 ? idx : msgs.length}`, source: 'chat', at: new Date().toISOString(), text: userText, summary: j.quote });
        const out = Matters.foldOwn(f, j);
        if (!out) return;
        console.log(`[matter-capture] conv ${conv.id}: ${j.change} on ${out.m.id}`);
        this._receipt(conv, msg, { id: out.m.id, title: Matters.titleOf(out.m), text: j.receipt, token: out.token });
    },

    /** C4: the receipt on the answer, repainted. */
    _receipt(conv, msg, rec) {
        if (!msg) return;
        msg.metadata = msg.metadata || {};
        msg.metadata.matter = rec;
        // The answer may have said "done" with no tool call: this is that change, made.
        delete msg.metadata.notDone;
        try {
            AgentService._persistConversation(conv);
            AgentService._syncActiveConversation(conv.id, conv);
            if (typeof AgentUI !== 'undefined' && AgentService.activeConversationId === conv.id
                && !AgentService._streamingState.has(conv.id)) AgentUI.renderMessages();
        } catch { /* the note shows on the next render */ }
    }
};

if (typeof module !== 'undefined') module.exports = MatterCapture;
