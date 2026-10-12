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
 *      Ignoring a one-time commitment closes that record, even without a
 *      Now card. Hiding only its card and remembering a preference do not.
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
 *   T6 (2026-10-10, docs/SENDERS.md M2) A SENDER's thread is one chat for
 *      many things (Auto insurance holds the renewal, the ID cards, the
 *      payment task). Its turn first settles WHICH member the person means,
 *      then runs the member's own judgment above, unchanged. Code decides
 *      when a fact does: only one member is open, or the person wrote from
 *      that member's own box in the last half hour (`conv.focus`). Otherwise
 *      one small call picks among the open members (or none).
 *      Since 2026-10-11 a GOAL's thread does the same over its steps (a
 *      step is never a thread of its own; js/core/threads-page.js): the
 *      step picked gets its own judgment, none picked judges the goal.
 *
 *   T7 (2026-10-11, by request) A GENERAL chat (nenva's own thread) is
 *      about no one thing, so one small call first says which of the
 *      person's open things (at most three) the message reports on, each
 *      with their verbatim words, and whether it asks for something to
 *      happen regularly. Each thing picked gets its own judgment (T1–T4,
 *      card left alone), its receipt names the thing, and nenva's note in
 *      that thing's thread says what was kept with a link back. A repeat
 *      request writes nothing: the reply is told to offer create_routine.
 *
 * Pure parts (cardOf, planFor, pickFor, isGeneral, vetRoute) are Node-testable (tests/thing-capture-test.js).
 */
const ThingCapture = {
    ...(typeof module !== 'undefined' && module.exports ? require('../shared/thing-capture') : ThingCaptureRules),
    get MatterCapture() { return typeof MatterCapture !== 'undefined' ? MatterCapture : undefined; },
    get OccurrenceCapture() { return typeof OccurrenceCapture !== 'undefined' ? OccurrenceCapture : undefined; },
    SOURCE: 'thing-chat',
    MAX_TEXT: 1500,


    /** The thing a chat is tied to: { thing, type, id } or null. */
    thingOf(conv) {
        const key = String((conv && conv.todayKey) || '');
        const m = /^(task|matter|trip|checkin|money|askafter|event|insight|ask|plan|replan|pref|routine|sender):(.+)$/.exec(key);
        if (!m) return null;
        return { thing: key, type: m[1], id: m[2] };
    },

    FOCUS_MS: 30 * 60000,
    /**
     * T6, the facts half: which member a sender's turn is about, when code
     * can tell. Pure. `members` are { key, open } in the sender; returns
     * { key } when decided, { ask: [keys] } when the model must pick, or null.
     */
    pickFor(conv, members, now = Date.now()) {
        const open = members.filter(m => m.open);
        const f = conv && conv.focus;
        if (f && f.key && now - (f.at || 0) < this.FOCUS_MS && members.some(m => m.key === f.key)) return { key: f.key };
        if (!open.length) return null;
        if (open.length === 1) return { key: open[0].key };
        return { ask: open.map(m => m.key) };
    },
    _memberLine(key) {
        if (/^matter:/.test(key) && typeof Matters !== 'undefined') {
            const m = Matters.get(key);
            if (!m) return '';
            const step = Matters.openStep ? Matters.openStep(m) : null;
            return `${Matters.titleOf(m)} (${m.kind || 'item'})${m.status ? ` — ${m.status}` : ''}${step ? ` — next: ${step.what}` : ''}`;
        }
        const c = typeof Commitments !== 'undefined' ? Commitments.get(key.slice(5)) : null;
        return c ? `${c.title} (their commitment${c.repeat && c.repeat.rule && c.repeat.rule !== 'none' ? `, repeats ${c.repeat.rule}` : ''})${c.when && c.when.date ? ` — ${c.when.date}` : ''}` : '';
    },
    _picked: new Map(),
    /** The member this conversation's latest turn was about (T6), for the after-turn look; null when none. */
    pickedMember(convId) { return this._picked.get(convId) || null; },
    /** T6: the member a sender's turn is about, or null. */
    async memberFor(conv, senderId, userText, before) {
        if (typeof Senders === 'undefined') return null;
        return this._pickAmong(conv, Senders.members(senderId), Senders.members(senderId, { open: true }), userText, before);
    },
    /**
     * T6 for a goal's thread (2026-10-11): a goal's steps live in its thread,
     * so "slept 11:30 to 7:45" in the Sleep goal's thread reaches "Log
     * sleep". Returns the step's key, or null to judge the goal itself.
     */
    async stepFor(conv, t, userText, before) {
        if (typeof Commitments === 'undefined' || !Commitments._inited || !Commitments.family) return null;
        const c = Commitments.get(t.id);
        if (!c) return null;
        const steps = Commitments.family(c).slice(1).filter(k => k.state === 'open');
        if (!steps.length) return null;
        const keys = [t.thing, ...steps.map(k => `task:${k.id}`)];
        const key = await this._pickAmong(conv, keys, keys, userText, before);
        return key && key !== t.thing ? key : null;
    },
    async _pickAmong(conv, keys, openList, userText, before) {
        const openKeys = new Set(openList);
        const pick = this.pickFor(conv, keys.map(k => ({ key: k, open: openKeys.has(k) })));
        if (!pick) return null;
        if (pick.key) return pick.key;
        const list = pick.ask.slice(0, 12).map(k => ({ k, line: this._memberLine(k) })).filter(x => x.line);
        if (!list.length) return null;
        let raw = null;
        try {
            const res = await LLMLogger.call(this.SOURCE, {
                model: AgentService.model,
                messages: [{ role: 'system', content: 'You are the person\'s personal assistant. You answer with JSON only.' },
                    { role: 'user', content: `The person is texting you about one thing in their life, which holds these items:\n${list.map((x, i) => `[${i + 1}] ${x.line}`).join('\n')}\n${before ? `\nYOU SAID BEFORE (context only): ${String(before).slice(0, 300)}\n` : ''}\nTHE PERSON JUST SAID:\n${userText}\n\nWhich ONE item is their message about? Answer JSON only: {"item": the number of the item, or 0 if it is about none of them in particular (a general question, something new)}` }],
                format: 'json', think: false, maxTokens: 40, stream: false, jobClass: 'background', logTag: this.SOURCE,
                options: { temperature: 0, num_ctx: AgentService.numCtx || 8192 }
            });
            if (!res || res.error) return null;
            raw = JSON.parse(String(res.message && res.message.content || '').replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim());
        } catch { return null; }
        const n = Number(raw && raw.item);
        return Number.isInteger(n) && n >= 1 && n <= list.length ? list[n - 1].k : null;
    },

    /** T5. */
    eligible(conv, { untrusted = false, headless = false } = {}) {
        if (!conv || untrusted || headless || conv.contextMode === 'simple') return false;
        if (typeof PrivateChat !== 'undefined' && PrivateChat.isPrivate(conv)) return false;
        return !!this.thingOf(conv);
    },

    /** T1: what the person meant for the card. A small model's near-synonyms are read; anything else keeps it. Pure. */

    /**
     * What to do, from the judge's answer and the facts, before anything is
     * written. Pure: returns { card, record, quote } where record is the
     * vetted judgment for the record's door (or null).
     *   t.type 'matter' → record from MatterCapture.vet
     *   t.type 'task'   → record from OccurrenceCapture.vet, or { cancel } /
     *                     { done } for a one-time commitment
     *   anything else   → card only
     */


    /** The facts the judge is shown, per kind of thing. Code's. */
    facts(t, now = Date.now()) {
        const out = { today: typeof Commitments !== 'undefined' && Commitments.today ? Commitments.today() : new Date(now).toISOString().slice(0, 10) };
        // A folder's id already reads "matter:<x>", so its chat key IS the id.
        if (t.type === 'matter' && typeof Matters !== 'undefined') out.matter = Matters.get(t.thing) || null;
        if (t.type === 'task' && typeof Commitments !== 'undefined' && Commitments._inited) {
            out.commitment = Commitments.get(t.id) || null;
            out.repeats = !!(out.commitment && Commitments.repeats(out.commitment));
        }
        if (typeof SimpleExperience !== 'undefined' && SimpleExperience.cardForThing) {
            try { out.card = SimpleExperience.cardForThing(t.thing); } catch { out.card = null; }
        }
        return out;
    },



    /** Add fields before the closing brace of the prompt's answer shape (the last "}" before the closing line). */

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
        if (typeof LLMLogger === 'undefined' || typeof AgentService === 'undefined') return null;
        const text = String(userText || '').trim().slice(0, this.MAX_TEXT);
        if (!text) return null;
        // T7: a general chat first says which things it is about.
        if (this.eligibleGeneral(conv, { untrusted, headless })) return this.routeGeneral(conv, text);
        if (!this.eligible(conv, { untrusted, headless })) return null;
        let t = this.thingOf(conv);
        const now = Date.now();
        // T6: a sender's thread acts on the member the person means.
        if (t.type === 'sender') {
            const prev = (conv.messages || []).filter(m => m.role === 'assistant' && typeof m.content === 'string').at(-1);
            const key = await this.memberFor(conv, t.thing, text, prev && prev.content);
            // MemoryCapture reads it after the turn: which item's mail, which commitment (M5).
            if (key) this._picked.set(conv.id, key); else this._picked.delete(conv.id);
            t = key ? this.thingOf({ todayKey: key }) : null;
            if (!t) return null;
        } else if (t.type === 'task') {
            // A goal's thread acts on the step the person means (T6), else on the goal.
            const prev = (conv.messages || []).filter(m => m.role === 'assistant' && typeof m.content === 'string').at(-1);
            const step = await this.stepFor(conv, t, text, prev && prev.content);
            if (step) t = this.thingOf({ todayKey: step });
        }
        const marked = (toolLog || []).some(x => x && x.ok && x.tool === 'resolve_commitment');
        const before = (conv.messages || []).filter(m => m.role === 'assistant' && typeof m.content === 'string').at(-1);
        const judged = await this._judge(t, text, before && before.content, { marked, now });
        return judged ? this.apply(conv, t, judged.plan, judged.facts) : null;
    },

    /** T1–T3 for one thing: its own judgment, planned against it as it is after the call. Null when nothing to judge. */
    async _judge(t, text, before, { marked = false, now = Date.now(), cardOk = true } = {}) {
        const facts = this.facts(t, now);
        facts.marked = marked;
        // Nothing to judge: no record and no card (the chat outlived both).
        if (!facts.matter && !facts.commitment && (!cardOk || !facts.card)) return null;
        const tag = this._tag(t, facts);
        let raw = null;
        try {
            const res = await LLMLogger.call(tag, {
                model: AgentService.model,
                messages: [{ role: 'system', content: 'You are the person\'s personal assistant. You answer with JSON only.' },
                    { role: 'user', content: this._prompt(t, facts, text, before, now) }],
                format: 'json', think: false, maxTokens: 300, stream: false, jobClass: 'background', logTag: tag,
                options: { temperature: 0.1, num_ctx: AgentService.numCtx || 8192 }
            });
            if (!res || res.error) return null;
            raw = JSON.parse(String(res.message && res.message.content || '').replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim());
        } catch { return null; }
        // The thing may have moved while the model was asked: plan against it as it is now.
        const fresh = this.facts(t, Date.now());
        fresh.marked = marked;
        const plan = this.planFor(raw, t, fresh, text, Date.now());
        // From a general chat the card stays where it is: the person was not looking at it (T7).
        if (!cardOk) plan.card = 'keep';
        return { plan, facts: fresh };
    },

    // ── T7: the general chat routes (2026-10-11, by request) ────────────
    //
    // Ram: "general nenva chat should have the ability to orchestrate or
    // propagate the updates with other threads too." "Slept 11:30 to 7:45"
    // in nenva's own thread got a good answer and no log, until he asked
    // "did you log it"; "a daily summary on news" got one summary and a
    // Memory sentence, never a routine. A general chat is about no one thing,
    // so ONE small call first says which of the person's things (at most
    // three) the message reports on, and whether it asks for something to
    // happen regularly. Each thing picked then gets its own judgment above,
    // unchanged (same quote rule, same vet, same door, same receipt), and a
    // note in that thing's thread says what was kept and links back here.
    // A repeat request writes nothing: the reply is told to offer a routine
    // through create_routine, whose ask is the consent.

    ROUTE_TASKS: 80,
    ROUTE_MATTERS: 30,

    /** A general conversation: no thing, page or routine owns it. Pure. */
    isGeneral(conv) {
        return !!conv && !!conv.id && !conv.todayKey && !conv.pageKey && !conv.standing && !String(conv.id).startsWith('ephemeral_');
    },
    eligibleGeneral(conv, { untrusted = false, headless = false } = {}) {
        if (!this.isGeneral(conv) || untrusted || headless || conv.contextMode === 'simple') return false;
        return !(typeof PrivateChat !== 'undefined' && PrivateChat.isPrivate(conv));
    },

    /** What the router is shown: the person's open commitments (repeats first) and open folders. Code's. */
    routeCandidates() {
        const out = [];
        if (typeof Commitments !== 'undefined' && Commitments._inited) {
            const cs = Commitments.all().filter(c => c && c.state === 'open'
                && !(c.privacySources || []).includes('slack') && !(c.origin && c.origin.kind === 'plan'));
            const rep = c => (Commitments.repeats(c) ? 1 : 0);
            cs.sort((a, b) => rep(b) - rep(a) || Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
            for (const c of cs.slice(0, this.ROUTE_TASKS)) {
                const key = `task:${c.id}`;
                const line = this._memberLine(key);
                const parent = c.parent ? Commitments.get(c.parent) : null;
                if (line) out.push({ key, line: parent ? `${line} — part of "${parent.title}"` : line });
            }
        }
        if (typeof Matters !== 'undefined') {
            const ms = (Matters.forAmbient ? Matters.forAmbient() : Matters.all()).filter(m => m && m.state === 'open').slice(0, this.ROUTE_MATTERS);
            for (const m of ms) { const line = this._memberLine(m.id); if (line) out.push({ key: m.id, line }); }
        }
        return out;
    },


    /** Keep only what is checkable: real items, each once, each with the person's own words. Pure. */

    /** The ask for the reply when they want something regularly. Pure. */
    repeatAsk(quote) {
        return `They asked for something to happen regularly: "${quote}". Answering once is not enough. Give today's answer if they asked for one, and set it up as a routine: load the routines tools (use_tools "prompts") and call create_routine with the schedule they said (it shows them the routine and asks before anything is armed). If the schedule is unclear, ask one short question instead. Never say it is set up unless create_routine ran in this turn.`;
    },

    async routeGeneral(conv, text) {
        const now = Date.now();
        const list = this.routeCandidates();
        const prev = (conv.messages || []).filter(m => m.role === 'assistant' && typeof m.content === 'string').at(-1);
        const before = prev && prev.content;
        let raw = null;
        try {
            const res = await LLMLogger.call('general-route', {
                model: AgentService.model,
                messages: [{ role: 'system', content: 'You are the person\'s personal assistant. You answer with JSON only.' },
                    { role: 'user', content: this._routePrompt(list, text, before, now) }],
                format: 'json', think: false, maxTokens: 200, stream: false, jobClass: 'background', logTag: 'general-route',
                options: { temperature: 0, num_ctx: AgentService.numCtx || 8192 }
            });
            if (!res || res.error) return null;
            raw = JSON.parse(String(res.message && res.message.content || '').replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim());
        } catch { return null; }
        const route = this.vetRoute(raw, list, text);
        const lines = [], routed = [], wrote = [], asks = [];
        let request = '';
        for (const key of route.keys) {
            const t = this.thingOf({ todayKey: key });
            if (!t) continue;
            const judged = await this._judge(t, text, before, { now, cardOk: false });
            if (!judged) continue;
            const out = this.apply(conv, t, judged.plan, judged.facts);
            if (!out) continue;
            if (out.line) {
                lines.push(out.line);
                const where = this.propagate(conv, t, judged.facts, out.line);
                for (const r of out.receipts) routed.push(this._routedReceipt(r, judged.facts, where));
            }
            wrote.push(...(out.wrote || []));
            if (out.ask) { asks.push(out.ask); request = request || out.request; }
        }
        if (route.repeat) asks.push(this.repeatAsk(route.repeat));
        if (!lines.length && !asks.length) return null;
        return { line: lines.join(' '), receipts: routed.length ? [{ routed }] : [], quote: '', wrote,
            ...(asks.length ? { ask: asks.join('\n'), request: request || route.repeat } : {}) };
    },

    /** A receipt from a general chat names the thing (the chat is not about it) and its thread. */
    _routedReceipt(r, facts, where) {
        const out = JSON.parse(JSON.stringify(r));
        const title = (facts.commitment && facts.commitment.title) || '';
        if (out.occurrence && title && !String(out.occurrence.text || '').startsWith(title)) out.occurrence.text = `${title} · ${out.occurrence.text}`;
        if (where) out.thread = where;
        return out;
    },

    /**
     * T7: the thing's own thread hears it too — nenva's note, the line code
     * wrote, linking back to this conversation (the hand-off's shape, so the
     * thread draws "From your chat with nenva"). The thread is the sender
     * holding the thing, else the thing's own. Returns { key, name } or null.
     */
    propagate(conv, t, facts, line) {
        if (typeof SimpleExperience === 'undefined' || typeof AgentService === 'undefined' || !SimpleExperience._cardConv) return null;
        let key = t.thing, name = (facts.commitment && facts.commitment.title) || (facts.matter && typeof Matters !== 'undefined' ? Matters.titleOf(facts.matter) : '') || 'This';
        try {
            const sid = typeof Senders !== 'undefined' ? Senders.senderOf(t.thing) : null;
            const s = sid ? Senders.get(sid) : null;
            if (s && !s.builtIn) { key = s.id; name = s.name; }
            else if (typeof ThreadsPage !== 'undefined' && ThreadsPage.threadKeyOf) {
                // A step lives in its goal's thread, a loose to-do in Reminders.
                const g = ThreadsPage.threadKeyOf(t.thing);
                const holder = g !== t.thing && /^sender:/.test(g) && typeof Senders !== 'undefined' ? Senders.get(g) : null;
                const top = !holder && g !== t.thing && /^task:/.test(g) && typeof Commitments !== 'undefined' ? Commitments.get(g.slice(5)) : null;
                if (holder) { key = g; name = holder.name; } else if (top) { key = g; name = top.title; }
            }
        } catch { /* the thing's own thread */ }
        if (conv.todayKey === key) return null;
        try {
            const { conv: th } = SimpleExperience._cardConv({ key, title: name });
            th.texting = true;
            th.messages.push({ role: 'assistant', content: line, timestamp: new Date().toISOString(),
                metadata: { handoff: { from: conv.id, title: conv.title || null }, routedFrom: conv.id } });
            th.updatedAt = new Date().toISOString();
            AgentService._saveConversations();
        } catch (e) { console.warn('[thing-capture] could not note it in its thread:', e && e.message); return null; }
        return { key, name };
    },

    /** T4: the record through its door, then the raise, then the receipts. */
    apply(conv, t, plan, facts) {
        const receipts = [];
        const lines = [];
        const quote = plan.quote;
        // What was written, for ClaimCheck: a mark, a resolve, a folder or a
        // card answers "mark it done" or "ignore it"; a note answers nothing
        // the person ASKED for (it is their own words kept on a day).
        const wrote = [];
        let closed = false;   // the record's door ended the thing: the card has nothing left to run
        if (plan.record && plan.record.door === 'matter' && typeof Matters !== 'undefined') {
            const j = plan.record.j;
            const f = Matters.observation({ id: `chat:${conv.id}:${(conv.messages || []).length}`, source: 'chat', at: new Date().toISOString(), text: quote || j.quote, summary: j.quote });
            const out = Matters.foldOwn(f, j);
            if (out) {
                receipts.push({ matter: { id: out.m.id, title: Matters.titleOf(out.m), text: j.receipt, token: out.token } });
                lines.push(`${Matters.titleOf(out.m)}: ${j.receipt}.`);
                wrote.push('change');
                closed = out.m.state !== 'open';
            }
        } else if (plan.record && plan.record.door === 'report' && typeof Commitments !== 'undefined') {
            const j = plan.record.j, c = facts.commitment;
            const out = Commitments.report(c.id, { day: j.day, how: j.how, quote: j.quote, plan: j.plan, measures: j.measures || null }, { by: 'you', why: 'said in its chat' });
            if (out.ok && out.changed.length) {
                const text = typeof OccurrenceCapture !== 'undefined' && OccurrenceCapture.receiptWith ? OccurrenceCapture.receiptWith(j, out.measures) : j.receipt;
                receipts.push({ occurrence: { id: c.id, title: c.title, text, ledgerId: out.ledgerId } });
                lines.push(`${c.title}: ${text}.`);
                wrote.push(j.how ? 'change' : 'note');
                const after = Commitments.get(c.id);
                // A day marked done or skipped answers the card that asked about it (a fact, not the model's word).
                closed = !!(after && after.state !== 'open') || !!j.how;
            }
        } else if (plan.record && plan.record.door === 'resolve' && typeof Commitments !== 'undefined') {
            const c = facts.commitment;
            const out = Commitments.resolve(c.id, plan.record.how, { by: 'you', why: `said in its chat: "${plan.record.quote}"` });
            if (out.ok) {
                const word = plan.record.how === 'dropped' ? 'ignored' : 'done';
                receipts.push({ occurrence: { id: c.id, title: c.title, text: `${c.title}: ${word} · "${plan.record.quote}"`, ledgerId: out.ledgerId } });
                lines.push(`${c.title}: marked ${word}.`);
                wrote.push('change');
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
                receipts.push({ card: { thing: t.thing, how: cardWant, text: cardWant === 'gone' ? 'Card set aside' : 'Card shown later' } });
                lines.push(cardWant === 'gone' ? 'Its card is set aside for good.' : 'Its card will come back later.');
                wrote.push('change');
            }
        }
        // They asked the assistant to DO something (2026-10-09): nothing was
        // recorded for it here, and the reply must not read a kept note as
        // the thing done. "Lets add a pin to home" in a backlog's chat was
        // kept as a note and answered "Noted —", and no task was ever made.
        let ask = '';
        if (plan.request) {
            const c = facts.commitment;
            ask = `They asked: "${plan.request}". Nothing has been done about it yet. Do it now with your tools${c ? ` (a new item, step or task under "${c.title}" is add_commitment with parent "${c.id}")` : ''}, or say plainly that you have not done it. Never say it is added, noted or done unless a tool did it in this turn.`;
        }
        if (!lines.length && !ask) return null;
        return { line: lines.join(' '), receipts, quote, wrote, ...(ask ? { ask, request: plan.request } : {}) };
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
