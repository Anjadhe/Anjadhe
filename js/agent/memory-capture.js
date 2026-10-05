/**
 * MemoryCapture — nenva notices what to remember on every turn (2026-10-02).
 *
 * Why: a person told nenva something, asked it to remember, then told it
 * more without the word "remember". The reply said "Stored too" and nothing
 * was stored — the model said it, no tool did it, and the old background
 * pass only ran 90 seconds after the chat was left, four messages at a time,
 * once per 15 minutes. Memory has to keep up with the conversation, and a
 * claim to have saved something has to be true.
 *
 * Laws (on top of MemoryManager M1–M5):
 *   K1 Every eligible turn is LOOKED at (AI native 2026-10-02: no word
 *      lists decide which): the assistant reads what the person said and
 *      the answer, proposes facts (or none), and says whether the answer
 *      told them something was saved. Only a message too short to hold a
 *      fact (MIN_CHARS) is skipped.
 *   K2 A fact is kept only with a quote copied verbatim from what the PERSON
 *      typed (M1) — never the assistant's words, never an email or a page.
 *   K3 Pruning rides the same call and stays arithmetic (M2): a fact that
 *      changed comes back with the SAME heading + subject and replaces the
 *      old one (kept for Undo); one the person says is no longer true comes
 *      back as {forget: id} with the person's words as its quote, and only
 *      an id from the facts shown can be forgotten.
 *   K4 The receipt is the record. What the capture saved, replaced or
 *      forgot is added to the answer's "Remembered" note. An answer that
 *      claimed a save gets "Not saved to memory" only when the capture
 *      could not reach the model; when there was simply nothing to keep,
 *      the person is told nothing (2026-10-04).
 *   K6 A chat opened from a card that came from a message knows which
 *      message (2026-10-05: "these alerts from the library can be ignored",
 *      said in the card's chat, set that one card aside and the next notice
 *      raised another). The capture is shown who sent it, so a standing
 *      word about mail LIKE it becomes one sentence on Memory › Email, the
 *      page the mail readers read. Still the person's words (K2); a word
 *      about this one card only is not a fact.
 *   K5 Never from a private, no-personal-context, untrusted or headless
 *      turn (M5); one capture at a time per conversation; fire-and-forget.
 *
 * Pure gates are Node-testable (tests/memory-capture-test.js).
 */
const MemoryCapture = {
    MIN_CHARS: 12,

    _norm(s) { return String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim(); },

    /** K2: the quote appears in the person's own words. */
    quoteOk(quote, userText) {
        const q = this._norm(quote);
        return q.length >= 4 && this._norm(userText).includes(q);
    },

    /**
     * Sort the model's proposals into what may be applied (K2, K3). Pure:
     * `known` is the facts shown to the model ({id}), `userText` the person's
     * words. Returns { save: [{text, heading, subject, quote}], forget:
     * [{id, quote}], dropped }.
     */
    vet(candidates, { known = [], userText = '' } = {}) {
        const ids = new Set(known.map(f => f.id));
        const out = { save: [], forget: [], dropped: 0 };
        for (const c of (Array.isArray(candidates) ? candidates : []).slice(0, 6)) {
            if (!c || typeof c !== 'object') { out.dropped++; continue; }
            const quote = String(c.quote || '').trim();
            if (!this.quoteOk(quote, userText)) { out.dropped++; continue; }
            if (c.forget != null) {
                const id = String(c.forget);
                if (ids.has(id) && !out.forget.some(f => f.id === id)) out.forget.push({ id, quote });
                else out.dropped++;
                continue;
            }
            const text = String(c.text || '').trim();
            if (!text || text.length > 200) { out.dropped++; continue; }
            out.save.push({ text, heading: String(c.heading || 'about'), subject: c.subject ? String(c.subject).slice(0, 40) : undefined, quote });
        }
        return out;
    },

    // ── Runtime ─────────────────────────────────────────────────────────

    _busy: new Set(),

    /** Eligibility (K5). */
    eligible(conv, { untrusted = false } = {}) {
        if (!conv || untrusted) return false;
        if (conv.contextMode === 'simple') return false;
        if (typeof PrivateChat !== 'undefined' && PrivateChat.isPrivate(conv)) return false;
        return true;
    },

    /**
     * Called at the end of every chat turn (AgentService.sendMessage).
     * `msg` is the assistant message just pushed; `wrote` the turn's own
     * memory harvest (save/update/delete tool calls).
     */
    afterTurn({ conv, msg, userText, answerText, wrote = null, changed = false, untrusted = false }) {
        try {
            if (!this.eligible(conv, { untrusted })) return;
            if (typeof MemoryManager === 'undefined' || typeof AgentService === 'undefined') return;
            const toolSaved = !!(wrote && ((wrote.saved || []).length || (wrote.updated || []).length || (wrote.deleted || []).length || wrote.confirmed));
            if (String(userText || '').trim().length < this.MIN_CHARS && !String(answerText || '').trim()) return;
            if (this._busy.has(conv.id)) return;
            this._busy.add(conv.id);
            this._capture(conv, msg, { toolSaved, answerText, changed })
                .catch(e => console.warn('[memory-capture] failed:', e))
                .finally(() => this._busy.delete(conv.id));
        } catch (e) {
            console.warn('[memory-capture] guard error:', e);
        }
    },

    /** The person's words since the last capture (up to three messages). */
    _userSlice(conv, msg) {
        const msgs = conv.messages || [];
        const end = msg ? msgs.indexOf(msg) : msgs.length;
        const from = Math.max(conv._memCapturedAt || 0, 0);
        const users = msgs.slice(from, end < 0 ? msgs.length : end)
            .filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.trim());
        return users.slice(-3).map(m => m.content.trim().slice(0, 1500));
    },

    /** The facts shown to the model: those near the words, plus core ones. */
    _knownFor(text) {
        // Search by the meaningful words only; "my"/"is" would match everything.
        const words = String(text || '').toLowerCase().match(/[a-z0-9']{4,}/g) || [];
        const near = words.length ? MemoryManager.search(words.join(' '), { limit: 15 }) : [];
        const core = MemoryManager.all().filter(f => f.heading === 'about' || f.heading === 'people' || f.heading === 'preferences');
        const seen = new Set();
        return [...near, ...core].filter(f => !seen.has(f.id) && seen.add(f.id)).slice(0, 40);
    },

    /**
     * K6: what the chat's card came from, as the lines shown to the model.
     * Pure. `about` is { from, address, subject, text } or null.
     */
    aboutBlock(about) {
        if (!about || !(about.address || about.from)) return '';
        const who = [about.from, about.address && about.address !== about.from ? `<${about.address}>` : ''].filter(Boolean).join(' ');
        return `
THIS CHAT IS ABOUT ${about.text ? 'a text' : 'an email'} nenva showed the user as a card:
From: ${who}${about.subject ? `\nSubject: ${String(about.subject).slice(0, 160)}` : ''}
If the user says how messages LIKE this one should be treated from now on (ignore them, stop showing them, no tasks from them, always show them), remember that as ONE sentence with heading "email" that names the sender (and the address when there is one) and says which messages it covers, e.g. "Ignore overdue and due-soon notices from City Library (noreply@citylibrary.org); I return books in my own time." If a KNOWN email fact already covers this sender, return the new sentence with ITS subject. If they speak only about this one message ("ignore it", "drop this"), that is not a fact.
`;
    },

    /** The message behind the card this chat is tied to (a folder's latest, or the insight's own). */
    _cardSource(conv) {
        try {
            const key = String((conv && conv.todayKey) || '');
            let id = null, src = null;
            if (key.startsWith('insight:')) id = key.slice(8);
            else if (key.startsWith('matter:') && typeof Matters !== 'undefined') {
                const m = Matters.get(key) || Matters.get(key.replace(/^matter:(?=matter:)/, '').replace(/:next$/, '')) || Matters.get(key.replace(/:next$/, ''));
                const msgs = m ? Matters.messagesOf(m) : [];
                src = msgs[msgs.length - 1] || null;
                id = src && src.id;
            }
            const e = id && typeof EmailApp !== 'undefined' && EmailApp.emailById ? EmailApp.emailById(id) : null;
            if (!e && !src) return null;
            const from = String((e && (e.fromName || e.from)) || (src && src.from) || '');
            const address = (src && src.address) || (/<([^>]+)>/.exec(String((e && e.from) || '')) || [])[1] || (/@/.test(from) ? from : '');
            return { from: from.replace(/\s*<[^>]*>\s*/, '').trim(), address: String(address || '').toLowerCase(), subject: (e && e.subject) || '', text: !!(e && e.source === 'imessage') };
        } catch { return null; }
    },

    async _capture(conv, msg, { toolSaved = false, answerText = '', changed = false } = {}) {
        const users = this._userSlice(conv, msg);
        if (!users.length) return;
        const userText = users.join('\n');
        const msgs = conv.messages || [];
        const idx = msg ? msgs.indexOf(msg) : -1;
        // The assistant line just before the person's latest message, for
        // context only ("she" / "that one"); never a source of a quote (K2).
        const before = msgs.slice(0, idx < 0 ? msgs.length : idx).filter(m => m.role === 'assistant' && typeof m.content === 'string').slice(-2, -1)[0];
        const about = this._cardSource(conv);
        // A chat tied to a commitment: what they say about doing it is kept
        // on the commitment (OccurrenceCapture, its tools), never twice.
        let tiedTo = '';
        try { const m = /^task:(.+)$/.exec(String(conv.todayKey || '')); const c = m && typeof Commitments !== 'undefined' && Commitments.get ? Commitments.get(m[1]) : null; if (c) tiedTo = String(c.title || '').slice(0, 120); } catch { tiedTo = ''; }
        const known = this._knownFor(about ? `${userText} ${about.from} ${about.address}` : userText);
        const headings = MemoryManager.listPages ? MemoryManager.listPages().map(p => `"${p.id}" (${p.label})`).join(', ')
            : MemoryManager.HEADINGS.map(h => `"${h.id}" (${h.label})`).join(', ');

        const prompt = `You keep nenva's memory of the user up to date. Read what the user just said and decide what to remember, change or forget. Return ONLY JSON: {"facts": [ ... ], "answer_claims_saved": true if YOUR ANSWER below tells the user you saved, stored, noted or will remember something, else false}.

To remember or change a fact: {"text":"one short sentence about the user","heading":one of ${headings},"subject":"1-3 word handle, e.g. 'employer', 'partner', 'diet'","quote":"a phrase copied EXACTLY from the user's words"}
To forget a fact that is no longer true: {"forget":"<id from KNOWN>","quote":"the user's exact words saying so"}

Rules:
- Remember lasting things without being asked: who they are, people in their life (names, relations, birthdays), work, home, health, preferences, routines, plans, and anything they ask you to remember.
- If a KNOWN fact changed, return the new sentence with the SAME heading and subject as the known one (it replaces it). Do not repeat a known fact unchanged.
- A plan stays a plan ("Plans to…"), never written as done.
- "plans" holds ONLY what they intend to do and have not done yet; nenva later asks how each one went. Something that already happened ("did legs on Friday", "days 1-3 are done") is never a plan: it is a report of one day, so skip it unless it is lasting, and then file it under its topic. A routine or programme they follow, or a goal they hold, is about them ("about" or its own page). How they want to be treated ("never nudge me about…") is "preferences".
- Skip small talk, questions, one-off errands for today, moods, passwords and card numbers.
- "quote" must be copied character-for-character from the USER text below.
- "facts": [] if there is nothing to remember.

KNOWN:
${known.map(f => `- id ${f.id} [${f.heading}${f.subject ? `/${f.subject}` : ''}] ${f.text}`).join('\n') || '(nothing yet)'}
${this.aboutBlock(about)}${tiedTo ? `\nTHIS CHAT IS ABOUT one thing the user committed to do: "${tiedTo}". When they will do it, that they did or skipped it, how a day of it went, or a change to its time is kept on that commitment by the app: it is NOT a fact to remember here. Remember only lasting things about the user themselves.\n` : ''}${before ? `\nASSISTANT (context only, never quote it): ${String(before.content).slice(0, 500)}\n` : ''}
USER:
${userText}
${answerText ? `\nYOUR ANSWER (judge only whether it claims a save; never quote it):\n${String(answerText).slice(0, 800)}\n` : ''}
JSON:`;

        const params = {
            model: AgentService.model,
            messages: [{ role: 'user', content: prompt }],
            keep_alive: AgentService.keepAlive,
            think: false,
            options: { temperature: 0.1, num_predict: 512, num_ctx: AgentService.numCtx || 8192 },
            stream: false
        };
        let response = null;
        try {
            response = (typeof LLMLogger !== 'undefined' && LLMLogger.call)
                ? await LLMLogger.call('memory-extract', params)
                : await window.electronLLM.chat(params);
        } catch (e) {
            console.warn('[memory-capture] model error:', e);
        }
        const content = String(response?.message?.content || '').trim();
        let raw = null;
        try { raw = JSON.parse(content.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim()); } catch { raw = null; }
        if (!raw && content) { const a = AgentService._parseFirstJsonArray(content); raw = a ? { facts: a } : null; }
        const parsed = raw && Array.isArray(raw.facts) ? raw.facts : (Array.isArray(raw) ? raw : null);
        const claimed = !toolSaved && !!(raw && raw.answer_claims_saved === true);
        // (Whether the answer claims a CHANGE that never ran is ClaimCheck's
        // look, made before the answer is final; it is no longer asked here.)
        // Looked at either way — the next turn reads only what is new.
        if (idx >= 0) conv._memCapturedAt = idx + 1;

        const v = this.vet(parsed || [], { known, userText });
        const result = { saved: [], deleted: [], confirmed: 0 };
        for (const s of v.save) {
            const res = MemoryManager.remember({ ...s, convId: conv.id, source: 'chat', newPage: true });
            if (!res || res.error) continue;
            if (res.status === 'confirmed') { result.confirmed++; continue; }
            result.saved.push({ id: res.fact.id, text: res.fact.text, replaced: res.status === 'updated' });
        }
        for (const f of v.forget) {
            const gone = MemoryManager.forget(f.id);
            if (gone) { MemoryManager._forgotten.set(gone.id, gone); result.deleted.push({ id: gone.id, text: gone.text }); }
        }
        if (result.saved.length && idx >= 0) conv._memLastSavedAt = idx + 1;
        console.log(`[memory-capture] conv ${conv.id}: saved ${result.saved.length}, forgot ${result.deleted.length}, already known ${result.confirmed}, dropped ${v.dropped}${parsed ? '' : ' (no JSON)'}`);
        this._receipt(conv, msg, result, { claimed, failed: !parsed });
    },

    /** K4: write the receipt onto the answer and repaint it. */
    _receipt(conv, msg, result, { claimed, failed }) {
        if (!msg) return;
        const changed = result.saved.length || result.deleted.length;
        // A claimed save the capture found nothing in is said nowhere (Ram,
        // 2026-10-04: "when there is nothing to save we don't need to convey
        // that"); only a save LOST because the model was unreachable is.
        if (!changed && !(claimed && failed && !result.confirmed)) return;
        msg.metadata = msg.metadata || {};
        const mem = msg.metadata.memory || { saved: [], updated: [], deleted: [] };
        mem.saved = [...(mem.saved || []), ...result.saved];
        mem.deleted = [...(mem.deleted || []), ...result.deleted];
        if (!changed) mem.notSaved = 'failed';
        msg.metadata.memory = mem;
        try {
            AgentService._persistConversation(conv);
            AgentService._syncActiveConversation(conv.id, conv);
            if (typeof AgentUI !== 'undefined' && AgentService.activeConversationId === conv.id
                && !AgentService._streamingState.has(conv.id)) AgentUI.renderMessages();
        } catch { /* the note shows on the next render */ }
    }
};

if (typeof module !== 'undefined') module.exports = MemoryCapture;
