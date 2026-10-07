/**
 * ThingCapture — what the person says in a thing's chat reaches the record
 * AND the card, in one write, BEFORE the reply (2026-10-06, docs/NOW.md R4).
 *
 * Why: a chat tied to a card used to reach it through four channels — a
 * tool the model had to remember to call (set_card_aside), two post-turn
 * judges (MatterCapture, OccurrenceCapture) that each excluded the other,
 * CheckIns' any-reply rule, and a note bolted onto save_memory. "Just
 * ignore it" got "Dropped." with the card still there whenever the model
 * skipped the tool, and the folder stayed open because the post-turn judge
 * read "ignore it" as nothing. Now ONE judgment runs on every turn of a
 * tied chat, by code, and the reply is generated against the changed state.
 *
 * Laws:
 *   T1 One judgment per tied turn, run by code before the reply: what did
 *      what they just said do to the THING (none / done / cancelled /
 *      changed / note / a report on a day) and to the CARD (keep / later /
 *      gone)?
 *   T2 Kept only with a quote copied verbatim from what the PERSON typed in
 *      this turn (MatterCapture C2, OccurrenceCapture O2). The record keeps
 *      the quote; the raise keeps it in its history.
 *   T3 Code checks the rest with the checks that already existed
 *      (MatterCapture.vet, OccurrenceCapture.vet): no number the facts
 *      lack, real dates, a closed thing gets no new step, a report lands on
 *      the occurrence it was FOR.
 *   T4 One write, through the record's own door (Matters.foldOwn,
 *      Commitments.report / resolve), then the raise (Raises.settleThing,
 *      by 'chat' with the quote), then the receipt under the answer,
 *      written by code, with Undo. Nothing is sent, paid, moved to a date
 *      or scheduled from here; those stay tools with their asks.
 *   T5 The reply is told what just happened ("JUST NOW, AT THEIR WORD") and
 *      ClaimCheck sees it as a change that ran, so a reply cannot claim more
 *      than was done. Never from a private, untrusted, no-personal-context
 *      or headless turn.
 *
 * Pure parts (cardOf, planFor) are Node-testable (tests/thing-capture-test.js).
 */
const ThingCapture = {
    CARD: ['keep', 'later', 'gone'],
    SOURCE: 'thing-chat',
    MAX_TEXT: 1500,

    _norm(s) { return String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim(); },
    quoteOk(quote, userText) { const q = this._norm(quote); return q.length >= 2 && this._norm(userText).includes(q); },

    /** The thing a chat is tied to: { thing, type, id } or null. */
    thingOf(conv) {
        const key = String((conv && conv.todayKey) || '');
        const m = /^(task|matter|trip|checkin|money|askafter|event|insight|ask|plan|replan|pref|routine):(.+)$/.exec(key);
        if (!m) return null;
        return { thing: key, type: m[1], id: m[2] };
    },

    /** T5. */
    eligible(conv, { untrusted = false, headless = false } = {}) {
        if (!conv || untrusted || headless || conv.contextMode === 'simple') return false;
        if (typeof PrivateChat !== 'undefined' && PrivateChat.isPrivate(conv)) return false;
        return !!this.thingOf(conv);
    },

    /** T1: what the person meant for the card. A small model's near-synonyms are read; anything else keeps it. Pure. */
    cardOf(raw) {
        const c = raw && typeof raw === 'object' ? String(raw.card || '').toLowerCase().trim() : '';
        if (this.CARD.includes(c)) return c;
        if (['done', 'drop', 'dropped', 'dismiss', 'dismissed', 'ignore', 'ignored', 'remove', 'removed', 'skip', 'skipped', 'hide', 'hidden'].includes(c)) return 'gone';
        if (['snooze', 'snoozed', 'postpone', 'postponed', 'tomorrow', 'not now'].includes(c)) return 'later';
        return 'keep';
    },

    /**
     * What to do, from the judge's answer and the facts, before anything is
     * written. Pure: returns { card, record, quote } where record is the
     * vetted judgment for the record's door (or null).
     *   t.type 'matter' → record from MatterCapture.vet
     *   t.type 'task'   → record from OccurrenceCapture.vet, or { cancel } /
     *                     { done } for a one-time commitment
     *   anything else   → card only
     */
    planFor(raw, t, facts, userText, now = Date.now()) {
        const card = this.cardOf(raw);
        const quote = String((raw && raw.quote) || '').replace(/\s+/g, ' ').trim().slice(0, 140);
        const said = this.quoteOk(quote, userText);
        let record = null;
        if (t.type === 'matter' && facts.matter && typeof MatterCapture !== 'undefined') {
            record = MatterCapture.vet(raw, facts.matter, userText, now);
            if (record) record = { door: 'matter', j: record };
        } else if (t.type === 'task' && facts.commitment && typeof OccurrenceCapture !== 'undefined') {
            const c = facts.commitment;
            const repeats = facts.repeats;
            const r = OccurrenceCapture.vet(raw, c, userText, facts.today, { marked: !!facts.marked });
            // A one-time commitment cancelled whole outranks a note about today.
            if (!repeats && c.state === 'open' && said && raw.record === 'cancelled') record = { door: 'resolve', how: 'dropped', quote };
            else if (r) record = { door: 'report', j: r };
            else if (!repeats && c.state === 'open' && said && raw.record === 'done') record = { door: 'resolve', how: 'done', quote };
        }
        // A card may only go at the person's word.
        return { card: said ? card : 'keep', record, quote: said ? quote : '' };
    },

    _cardClause() {
        return `"card": what they want done with this on their Now page — "gone" if they tell you to ignore it, drop it, skip it, forget it, let it go, stop showing it, or say it is handled, done, paid or cancelled; "later" if they say later, not now, tomorrow, remind me; "keep" for anything else (a question, a new fact, a plan, a report that leaves it open)`;
    },

    /** The facts the judge is shown, per kind of thing. Code's. */
    facts(t, now = Date.now()) {
        const out = { today: typeof Commitments !== 'undefined' && Commitments.today ? Commitments.today() : new Date(now).toISOString().slice(0, 10) };
        // A folder's id already reads "matter:<x>", so its chat key IS the id; a key written before that ("matter:matter:<x>") still resolves.
        if (t.type === 'matter' && typeof Matters !== 'undefined') out.matter = Matters.get(t.thing) || (t.thing.startsWith('matter:matter:') ? Matters.get(t.thing.slice(7)) : null) || null;
        if (t.type === 'task' && typeof Commitments !== 'undefined' && Commitments._inited) {
            out.commitment = Commitments.get(t.id) || null;
            out.repeats = !!(out.commitment && Commitments.repeats(out.commitment));
        }
        if (typeof SimpleExperience !== 'undefined' && SimpleExperience.cardForThing) {
            try { out.card = SimpleExperience.cardForThing(t.thing); } catch { out.card = null; }
        }
        return out;
    },

    _prompt(t, facts, userText, before, now = Date.now()) {
        const today = new Date(now).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        if (t.type === 'matter' && facts.matter && typeof MatterCapture !== 'undefined') {
            // The folder's own prompt, with the card clause added LAST to its
            // answer shape (a small model copies the shape and may stop after
            // the first field it answers: first, "card" cost it "change").
            return this._addLast(MatterCapture._prompt(facts.matter, userText, before, now), `,\n ${this._cardClause()}`)
                .replace(/told you what to do with the card \(ignore it, later\);/, 'told you what to do with the card (ignore it, later — that is the "card" field, not a change);');
        }
        if (t.type === 'task' && facts.commitment && typeof OccurrenceCapture !== 'undefined') {
            const base = OccurrenceCapture._prompt(facts.commitment, userText, before, facts.today);
            const cancel = facts.repeats ? '' : `,\n "record": "cancelled" if they say to cancel, drop or forget the whole commitment (not just today); "done" if they say the whole thing is finished; else "none"`;
            return this._addLast(base, `${cancel},\n ${this._cardClause()}`);
        }
        const card = facts.card || {};
        return `Today is ${today}.

The person's Now page shows them a card, and they are talking with you about it.

THE CARD
${card.title || t.thing}${card.body ? `\n${String(card.body).slice(0, 300)}` : ''}
${before ? `\nYOU (context only, never quote it): ${String(before).slice(0, 400)}\n` : ''}
THE PERSON JUST SAID:
${userText}

Answer JSON only:
{${this._cardClause()},
 "quote": the phrase that says so, copied EXACTLY from what the person just said}
When unsure, answer "keep".`;
    },

    /** Add fields before the closing brace of the prompt's answer shape (the last "}" before the closing line). */
    _addLast(prompt, fields) {
        const i = prompt.lastIndexOf('}');
        return i < 0 ? prompt : `${prompt.slice(0, i)}${fields}${prompt.slice(i)}`;
    },

    _tag(t, facts) {
        if (t.type === 'matter' && typeof MatterCapture !== 'undefined') return MatterCapture.sourceFor(facts.matter);
        if (t.type === 'task') return typeof OccurrenceCapture !== 'undefined' ? OccurrenceCapture.SOURCE : this.SOURCE;
        return this.SOURCE;
    },

    /**
     * Before the reply (T1–T5). Returns null when nothing was done, else
     * { line, receipts } — the line goes into the model's context, the
     * receipts under the answer.
     */
    async beforeReply({ conv, userText, untrusted = false, headless = false, toolLog = [] } = {}) {
        if (!this.eligible(conv, { untrusted, headless }) || typeof LLMLogger === 'undefined' || typeof AgentService === 'undefined') return null;
        const text = String(userText || '').trim().slice(0, this.MAX_TEXT);
        if (!text) return null;
        const t = this.thingOf(conv);
        const now = Date.now();
        const facts = this.facts(t, now);
        facts.marked = (toolLog || []).some(x => x && x.ok && x.tool === 'resolve_commitment');
        // Nothing to judge: no record and no card (the chat outlived both).
        if (!facts.matter && !facts.commitment && !facts.card) return null;
        const before = (conv.messages || []).filter(m => m.role === 'assistant' && typeof m.content === 'string').at(-1);
        const tag = this._tag(t, facts);
        let raw = null;
        try {
            const res = await LLMLogger.call(tag, {
                model: AgentService.model,
                messages: [{ role: 'system', content: 'You are the person\'s personal assistant. You answer with JSON only.' },
                    { role: 'user', content: this._prompt(t, facts, text, before && before.content, now) }],
                format: 'json', think: false, maxTokens: 300, stream: false, jobClass: 'background', logTag: tag,
                options: { temperature: 0.1, num_ctx: AgentService.numCtx || 8192 }
            });
            if (!res || res.error) return null;
            raw = JSON.parse(String(res.message && res.message.content || '').replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim());
        } catch { return null; }
        // The thing may have moved while the model was asked: plan against it as it is now.
        const fresh = this.facts(t, Date.now());
        fresh.marked = facts.marked;
        const plan = this.planFor(raw, t, fresh, text, Date.now());
        return this.apply(conv, t, plan, fresh);
    },

    /** T4: the record through its door, then the raise, then the receipts. */
    apply(conv, t, plan, facts) {
        const receipts = [];
        const lines = [];
        const quote = plan.quote;
        let closed = false;   // the record's door ended the thing: the card has nothing left to run
        if (plan.record && plan.record.door === 'matter' && typeof Matters !== 'undefined') {
            const j = plan.record.j;
            const f = Matters.observation({ id: `chat:${conv.id}:${(conv.messages || []).length}`, source: 'chat', at: new Date().toISOString(), text: quote || j.quote, summary: j.quote });
            const out = Matters.foldOwn(f, j);
            if (out) {
                receipts.push({ matter: { id: out.m.id, title: Matters.titleOf(out.m), text: j.receipt, token: out.token } });
                lines.push(`${Matters.titleOf(out.m)}: ${j.receipt}.`);
                closed = out.m.state !== 'open';
            }
        } else if (plan.record && plan.record.door === 'report' && typeof Commitments !== 'undefined') {
            const j = plan.record.j, c = facts.commitment;
            const out = Commitments.report(c.id, { day: j.day, how: j.how, quote: j.quote, plan: j.plan }, { by: 'you', why: 'said in its chat' });
            if (out.ok && out.changed.length) {
                receipts.push({ occurrence: { id: c.id, title: c.title, text: j.receipt, ledgerId: out.ledgerId } });
                lines.push(`${c.title}: ${j.receipt}.`);
                const after = Commitments.get(c.id);
                // A day marked done or skipped answers the card that asked about it (a fact, not the model's word).
                closed = !!(after && after.state !== 'open') || !!j.how;
            }
        } else if (plan.record && plan.record.door === 'resolve' && typeof Commitments !== 'undefined') {
            const c = facts.commitment;
            const out = Commitments.resolve(c.id, plan.record.how, { by: 'you', why: `said in its chat: "${plan.record.quote}"` });
            if (out.ok) {
                const word = plan.record.how === 'dropped' ? 'dropped' : 'done';
                receipts.push({ occurrence: { id: c.id, title: c.title, text: `${c.title}: ${word} · "${plan.record.quote}"`, ledgerId: out.ledgerId } });
                lines.push(`${c.title}: marked ${word}.`);
                closed = true;
            }
        }
        // The card (R2): at their word, or because the record's door just
        // closed the thing (a finished thing has no card to keep); then only
        // the raise is stamped.
        const cardWant = closed ? 'gone' : plan.card;
        if (cardWant !== 'keep' && typeof SimpleExperience !== 'undefined' && typeof Raises !== 'undefined') {
            const live = closed ? null : SimpleExperience.cardForThing(t.thing);
            let done = false;
            if (live && live.kind !== 'approval') {
                const r = SimpleExperience.letGoFromChat(t.thing, cardWant === 'gone', { quote });
                done = !!(r && r.done && r.title);
            }
            const raise = Raises.get(t.thing);
            if (!done && raise && raise.state !== 'settled') {
                Raises.settleThing(t.thing, cardWant === 'gone' ? 'done' : 'later', { by: 'chat', quote, until: cardWant === 'later' ? (typeof SimpleExperience !== 'undefined' ? SimpleExperience.LATER_MS : 4 * 3600000) : null });
                done = true;
            }
            if (done) {
                receipts.push({ card: { thing: t.thing, how: cardWant, text: cardWant === 'gone' ? 'Set aside on Now' : 'Shown later on Now' } });
                lines.push(cardWant === 'gone' ? 'Its card on Now is set aside for good.' : 'Its card on Now will come back later.');
            }
        }
        if (!lines.length) return null;
        return { line: lines.join(' '), receipts, quote };
    },

    /** T4: the receipts on the answer, repainted. */
    attach(conv, msg, out) {
        if (!msg || !out) return;
        msg.metadata = msg.metadata || {};
        for (const r of out.receipts) Object.assign(msg.metadata, r);
        delete msg.metadata.notDone;
        try {
            AgentService._persistConversation(conv);
            AgentService._syncActiveConversation(conv.id, conv);
            if (typeof AgentUI !== 'undefined' && AgentService.activeConversationId === conv.id && !AgentService._streamingState.has(conv.id)) AgentUI.renderMessages();
        } catch { /* the note shows on the next render */ }
    }
};

if (typeof module !== 'undefined') module.exports = ThingCapture;
