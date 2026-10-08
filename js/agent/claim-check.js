/**
 * ClaimCheck — a reply is held to what actually happened before it is
 * final (2026-10-05).
 *
 * Ram: "nenva agent is still saying things it did without doing it."
 * A chat answered "It's set for 9:00 AM tomorrow" with no change made. The
 * old guard was a word list ("I've created…") that this sentence walked
 * past, and the label MemoryCapture added afterwards only fired when the
 * memory model happened to notice.
 *
 * AI native: one small look by the model, held to facts code keeps.
 *
 *  V1  The model READS the reply: it lists each statement that says
 *      something is already true of the person's records, as an action
 *      ("I moved it", kind did) or a state ("it's set for 9 AM tomorrow",
 *      kind is), with the day and time it names. Code hands it the days
 *      (today, tomorrow, each weekday) so it never counts.
 *  V2  CODE decides, from facts it keeps: what ran this turn and where the
 *      thing this chat is about stands now. A "did" with no change that
 *      succeeded is unbacked; an "is" naming a day or time the record of
 *      this chat's thing does not show is unbacked. The model is never asked
 *      whether its own reply is true.
 *  V3  Code checks the reader too: a claim must be the reply's own words,
 *      or it is dropped. A reader that fails lets the reply through (never
 *      blocks a turn).
 *  V4  One retry: the model is told which sentences nothing supports and
 *      makes the change or says plainly that it has not been made. A reply
 *      that still fails is shown with code's own line under it ("Nothing
 *      was changed"), never silently.
 *  V5  Looked at only when the turn COULD have changed something (a tool
 *      that writes is in reach) and the turn did not simply succeed at
 *      every write it tried... a turn with no write, or with a write that
 *      failed or was declined, is where a false "done" comes from.
 *  V6  A change that DID succeed is still held to the record in a chat
 *      tied to a commitment: "now 6:30 PM today, next Monday it's back at
 *      8:45" was said after a write that moved every Monday. Code reads
 *      the time the record holds for each day the reply names
 *      (`standing.at(day)`) and a clock that differs is unbacked.
 *
 * Pure parts (facts, prompt, vet) pinned by tests/claim-check-test.js;
 * tests/claim-check-eval.js runs the look against a real model.
 */
const ClaimCheck = {
    _norm(s) {
        return String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[*_`#>\[\]]+/g, '').replace(/\s+/g, ' ').trim();
    },

    /** V5: is this turn one to look at? `ran` = [{tool, ok, readOnly}]. */
    worthLooking({ reply = '', canWrite = false, ran = [], tied = false } = {}) {
        if (!canWrite || String(reply).trim().length < 8) return false;
        const writes = ran.filter(r => !r.readOnly);
        // V6: in a chat tied to a commitment, what a change left behind is checkable too.
        return writes.length === 0 || writes.some(r => !r.ok) || !!tied;
    },

    /** V1: one line per tool call this turn. */
    ranLines(ran = []) {
        return ran.slice(-12).map(r => {
            const args = r.args ? ` ${String(typeof r.args === 'string' ? r.args : JSON.stringify(r.args)).slice(0, 200)}` : '';
            const kind = r.readOnly ? 'read' : 'change';
            const out = r.ok ? `succeeded${r.brief ? `: ${String(r.brief).slice(0, 400)}` : ''}` : `FAILED (${String(r.error || 'error').slice(0, 160)}), so nothing changed`;
            return `- ${kind} ${r.tool}${args} -> ${out}`;
        });
    },

    /** The days the reply may name, worked out by code so the judge never counts. */
    dayTable(now = Date.now()) {
        const out = [];
        for (let i = -1; i <= 7; i++) {
            const d = new Date(now); d.setDate(d.getDate() + i);
            const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            const name = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
            out.push(`${iso} = ${name}${i === -1 ? ' = yesterday' : i === 0 ? ' = TODAY' : i === 1 ? ' = tomorrow' : ''}`);
        }
        return out;
    },

    prompt({ reply, userText = '', thing = '', now = Date.now() }) {
        return `Read an assistant's REPLY and list what it tells the person is ALREADY true about their tasks, calendar, lists, messages or records. You do not judge whether it is true. Return ONLY JSON: {"claims": [ ... ]}. Each claim is an object with:
- "text": the sentence, copied word for word from REPLY
- "kind": "did" when REPLY says the assistant has made a change (it moved, added, created, saved, logged, sent, emailed, texted, booked, cancelled, deleted or completed something, or says "Done"); "is" when REPLY only says when or how something stands (it is set for, is on, is scheduled for, sits at a day or time)
- "about_this": true when it is about THE THING below (when there is one, "it" and "this" in REPLY mean THE THING), else false
- "day": the day the sentence names, as YYYY-MM-DD taken from DAYS below, or null when it names no day
- "time": the time it names as 24-hour HH:MM, or null

Leave out: offers and questions ("Want me to move it?"), plans for later ("I'll log it when you tell me"), advice, general knowledge, what the person will do themselves, and remembering something the person said about themselves. If nothing is left, return {"claims": []}.

DAYS:
${this.dayTable(now).join('\n')}

THE THING: ${String(thing || '').trim() || '(none)'}

THE PERSON SAID:
${String(userText || '').slice(0, 600)}

REPLY:
${String(reply || '').slice(0, 1800)}

JSON:`;
    },

    /**
     * V3: code decides what is unbacked. Pure.
     * `ran` = [{tool, ok, readOnly}], `standing` = {date, time, at?} of the
     * thing this chat is about (null when there is none); `at(day)` gives
     * the time the record holds for that day ({time}), or null when it does
     * not happen then.
     *  - "did" with no change that succeeded this turn: unbacked.
     *  - "is" about this thing, naming a day or time the record does not
     *    show, with no change that succeeded: unbacked.
     *  - after a change that succeeded (V6): an "is" about this thing whose
     *    clock differs from the one the record now holds for that day.
     * A claim whose text is not the reply's own words is dropped.
     */
    vet(raw, reply, { ran = [], standing = null } = {}) {
        const text = this._norm(reply);
        const list = raw && Array.isArray(raw.claims) ? raw.claims : null;
        if (!list) return { unbacked: [], ok: false };
        const changed = ran.some(r => r.ok && !r.readOnly);
        const read = ran.some(r => r.ok && r.readOnly);
        const out = [];
        for (const c of list.slice(0, 6)) {
            if (!c || typeof c !== 'object') continue;
            const q = this._norm(c.text).replace(/[.!]+$/, '');
            if (q.length < 4 || !text.includes(q)) continue;
            const day = /^\d{4}-\d{2}-\d{2}$/.test(String(c.day || '')) ? c.day : null;
            const time = /^\d{1,2}:\d{2}$/.test(String(c.time || '')) ? String(c.time).padStart(5, '0') : null;
            // The record's own time on the day the sentence names, when code can read it.
            let on = null;
            try { on = day && standing && typeof standing.at === 'function' ? standing.at(day) : null; } catch { on = null; }
            if (changed) {
                // V6: the change is made; only what it left on the record is checked.
                if (c.kind === 'is' && c.about_this !== false && on && time && on.time && time !== on.time
                    && !out.some(o => this._norm(o) === this._norm(c.text))) out.push(String(c.text).trim().slice(0, 240));
                continue;
            }
            let bad = false;
            if (c.kind === 'did') bad = true;
            // In a chat tied to a thing, a day or time is about that thing
            // unless the reader says otherwise AND something was read this
            // turn that it could have come from.
            else if (c.kind === 'is' && standing && (c.about_this !== false || !read)) {
                // A later day it really happens on is as good as its next one.
                const t = on ? on.time : standing.time;
                if (day && day !== (standing.date || null) && !on) bad = true;
                if (time && t && time !== t) bad = true;
                if (time && !t && day) bad = true;
            }
            if (bad && !out.some(o => this._norm(o) === this._norm(c.text))) out.push(String(c.text).trim().slice(0, 240));
        }
        return { unbacked: out.slice(0, 3), ok: true };
    },

    parse(content) {
        const s = String(content || '').replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
        try { return JSON.parse(s); } catch { /* look for the object */ }
        const m = s.match(/\{[\s\S]*\}/);
        if (m) { try { return JSON.parse(m[0]); } catch { /* not JSON */ } }
        return null;
    },

    /** V4: what the model is told when a claim is unbacked. */
    nudge(unbacked, { ran = [], standingText = '' } = {}) {
        const lines = this.ranLines(ran);
        const changed = ran.some(r => r.ok && !r.readOnly);
        if (changed) return `(Automatic check by the app, not a message from the user.) Your reply said: ${unbacked.map(u => `"${u}"`).join(' ; ')}. The record does not show that after the change you made. What ran in this turn:\n${lines.join('\n')}${standingText ? `\nWhere it stands right now:\n${standingText}` : ''}\nIf the change went further than the person asked (every time it repeats, when they meant one day), put it right now with the tool that fits, then answer. Otherwise say exactly what the lines above show. Do not mention this check.`;
        return `(Automatic check by the app, not a message from the user.) Your reply said: ${unbacked.map(u => `"${u}"`).join(' ; ')}. That is not true yet. What ran in this turn:\n${lines.length ? lines.join('\n') : '(nothing: no change was made)'}${standingText ? `\nWhere it stands right now:\n${standingText}` : ''}\nIf the person wants it changed, call the tool that changes it now, in this turn, then answer. If it cannot or should not be changed, say plainly that it has not been changed and what you need. Do not mention this check.`;
    },

    /**
     * The look. Returns { unbacked: [...] } (empty = let it through).
     * `call(params)` is the model transport (LLMLogger in the app).
     */
    async look({ reply, userText, ran = [], standing = null, thing = '', now = Date.now(), model, numCtx, keepAlive, privateChat = false }, call) {
        const params = {
            model, messages: [{ role: 'user', content: this.prompt({ reply, userText, thing, now }) }],
            keep_alive: keepAlive, think: false, format: 'json',
            options: { temperature: 0, num_predict: 400, num_ctx: numCtx || 8192 }, stream: false
        };
        if (privateChat) params.privateChat = true;
        let res = null;
        try { res = await call(params); } catch (e) { console.warn('[claim-check] model error:', e); return { unbacked: [], failed: true }; }
        if (!res || res.error) return { unbacked: [], failed: true };
        const v = this.vet(this.parse(res.message && res.message.content), reply, { ran, standing });
        return { unbacked: v.unbacked, failed: !v.ok };
    }
};

if (typeof module !== 'undefined') module.exports = ClaimCheck;
