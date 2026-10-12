'use strict';
// Shared desktop capture prompts and checks; hosts supply record dependencies.
const ThingCaptureRules = Object.freeze({
    ROUTE_MAX: 3,
    CARD: ['keep', 'later', 'gone'],
    _norm(s) { return String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim(); },
    quoteOk(quote, userText) { const q = this._norm(quote); return q.length >= 2 && this._norm(userText).includes(q); },
    cardOf(raw) {
        const c = raw && typeof raw === 'object' ? String(raw.card || '').toLowerCase().trim() : '';
        if (this.CARD.includes(c)) return c;
        if (['done', 'drop', 'dropped', 'dismiss', 'dismissed', 'ignore', 'ignored', 'remove', 'removed', 'skip', 'skipped', 'hide', 'hidden'].includes(c)) return 'gone';
        if (['snooze', 'snoozed', 'postpone', 'postponed', 'tomorrow', 'not now'].includes(c)) return 'later';
        return 'keep';
    },
    planFor(raw, t, facts, userText, now = Date.now()) {
        const card = this.cardOf(raw);
        const quote = String((raw && raw.quote) || '').replace(/\s+/g, ' ').trim().slice(0, 140);
        const said = this.quoteOk(quote, userText);
        let record = null;
        if (t.type === 'matter' && facts.matter && typeof this.MatterCapture !== 'undefined') {
            record = this.MatterCapture.vet(raw, facts.matter, userText, now);
            if (record) record = { door: 'matter', j: record };
        } else if (t.type === 'task' && facts.commitment && typeof this.OccurrenceCapture !== 'undefined') {
            const c = facts.commitment;
            const repeats = facts.repeats;
            const r = this.OccurrenceCapture.vet(raw, c, userText, facts.today, { marked: !!facts.marked });
            // Ignore is the commitment's dropped state, not just a card
            // dismissal. Read the judge's record intent, never infer it
            // from card:'gone' (which can mean hide only the reminder).
            const ignored = ['ignored', 'cancelled', 'dropped'].includes(raw.record);
            if (!repeats && c.state === 'open' && said && ignored) record = { door: 'resolve', how: 'dropped', quote };
            else if (r) record = { door: 'report', j: r };
            else if (!repeats && c.state === 'open' && said && raw.record === 'done') record = { door: 'resolve', how: 'done', quote };
        }
        // They asked the assistant to do something: recorded nowhere here; the reply is told to do it.
        const request = t.type === 'task' && raw && raw.report === 'request' && said ? quote : '';
        // A card may only go at the person's word.
        return { card: said ? card : 'keep', record, quote: said ? quote : '', ...(request ? { request } : {}) };
    },
    _cardClause() {
        return `"card": what they want done with the card about this in their thread — "gone" if they tell you to ignore it, drop it, skip it, forget it, let it go, stop showing it, or say it is handled, done, paid or cancelled; "later" if they say later, not now, tomorrow, remind me; "keep" for anything else (a question, a new fact, a plan, a report that leaves it open)`;
    },
    _prompt(t, facts, userText, before, now = Date.now()) {
        const today = new Date(now).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        if (t.type === 'matter' && facts.matter && typeof this.MatterCapture !== 'undefined') {
            // The folder's own prompt, with the card clause added LAST to its
            // answer shape (a small model copies the shape and may stop after
            // the first field it answers: first, "card" cost it "change").
            return this._addLast(this.MatterCapture._prompt(facts.matter, userText, before, now), `,\n ${this._cardClause()}`)
                .replace(/told you what to do with the card \(ignore it, later\);/, 'told you what to do with the card (ignore it, later — that is the "card" field, not a change);');
        }
        if (t.type === 'task' && facts.commitment && typeof this.OccurrenceCapture !== 'undefined') {
            // A one-time alert needs a decision about the task itself first.
            // Appending that decision to a day-report prompt led the model
            // to classify "these can be ignored" as general conversation.
            if (!facts.repeats) {
                // A reading on an undated tracker ("Track blood pressure") is a note with figures.
                const one = this._oneTimePrompt(facts.commitment, userText, before, facts.today);
                return this.OccurrenceCapture.measuresClause ? this._addLast(one, `,\n "measures" (with report "done" or "note"): ${this.OccurrenceCapture.measuresClause(facts.commitment).replace(/^"measures": /, '')}`).replace('Answer JSON only, all four fields:', 'Answer JSON only, all five fields:') : one;
            }
            const base = this.OccurrenceCapture._prompt(facts.commitment, userText, before, facts.today);
            return this._addLast(base, `,\n ${this._cardClause()}`);
        }
        const card = facts.card || {};
        return `Today is ${today}.

nenva shows the person a card about this in its thread, and they are talking with you about it.

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
    _oneTimePrompt(c, userText, before, today) {
        return `Today is ${today}.
The person is in this one-time task's own conversation. Decide what their latest words mean for THIS TASK, then its Now card. They may express a lasting preference at the same time; remembering it does not change the task.

CURRENT TASK
${c.title}
State: ${c.state}
${c.when && c.when.date ? `Scheduled day: ${c.when.date}\n` : ''}${c.origin && c.origin.kind ? `Source: ${c.origin.kind}\n` : ''}
${before ? `YOU (context only, never quote it): ${String(before).slice(0, 400)}\n` : ''}
THE PERSON JUST SAID:
${userText}

Choose record:
- "ignored": they dismiss this task or alert, say it can be ignored or is not needed, or ask to cancel/drop/forget it. "These can be ignored" includes this alert, even when followed by a reason or a general habit. That closes the current task, whether or not a Now card exists.
- "done": they say they finished the task.
- "none": a question, a negation, a habit without a dismissal, a change of date/time, or a preference limited to future alerts that keeps this task. "Can I ignore this?" asks for advice. "Hide only the card, keep the task" leaves the task open.

Choose report:
- "request" if they ask YOU to do something (add or create an item, a step or a task under it, change it, move it, plan it, schedule something, delete): nothing is recorded here, you will do it in your reply. "Let's add X", "add a task for Y", "create a step to Z" are requests, never notes.
- "done" if they report finishing it; "note" ONLY for how today's work on it went, without finishing it (never an idea, a wish or something to add); "later" if they still plan to do it later TODAY; otherwise "none". A dismissal is record "ignored", report "none".

Choose card:
- "gone" for an ignored/done task or an explicit request to hide its card; "later" for an explicit request to show it later; otherwise "keep". Questions and future-only preferences keep the current card.
- Decide this separately from record: "hide only the Now card, keep the task open" means record "none", card "gone".

Answer JSON only, all four fields:
{"record": "ignored" | "done" | "none", "report": "request" | "done" | "note" | "later" | "none", "quote": "the relevant phrase copied EXACTLY from the person's latest words", "card": "gone" | "later" | "keep"}
When unsure, use record "none", report "none", card "keep".`;
    },
    _addLast(prompt, fields) {
        const i = prompt.lastIndexOf('}');
        return i < 0 ? prompt : `${prompt.slice(0, i)}${fields}${prompt.slice(i)}`;
    },
    _routePrompt(list, userText, before, now = Date.now()) {
        const today = new Date(now).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        return `Today is ${today}.

The person is talking with you in your general conversation, which is about no one thing. These are the things you keep track of for them:
${list.map((x, i) => `[${i + 1}] ${x.line}`).join('\n') || '(none)'}
${before ? `\nYOU SAID BEFORE (context only, never quote it): ${String(before).slice(0, 400)}\n` : ''}
THE PERSON JUST SAID:
${userText}

1. Which of these things does their message REPORT on: they did it, skipped it, say how it went, give a reading or figures for it (sleep times, a workout, a weight, a blood pressure), or tell you it is done, paid, cancelled or not needed? A question about a thing, advice, or general talk is not a report. Pick the most specific item (a log or step rather than the goal it is part of). At most ${this.ROUTE_MAX}; usually none or one.
2. Do they ask for something to happen REGULARLY, on its own, from now on (a daily summary, a weekly check, every morning, remind me each week)? A one-time question is not.

Answer JSON only:
{"items": [{"item": the number, "quote": "the phrase about it, copied EXACTLY from what the person just said"}] ([] for none),
 "repeat": "the phrase asking for it regularly, copied EXACTLY", or "" for none}
When unsure, answer {"items": [], "repeat": ""}.`;
    },
    vetRoute(raw, list, userText) {
        const keys = [];
        for (const x of (raw && Array.isArray(raw.items) ? raw.items : [])) {
            const n = Number(x && x.item);
            if (!Number.isInteger(n) || n < 1 || n > list.length) continue;
            if (!this.quoteOk(String((x && x.quote) || ''), userText)) continue;
            const key = list[n - 1].key;
            if (!keys.includes(key)) keys.push(key);
            if (keys.length >= this.ROUTE_MAX) break;
        }
        const r = String((raw && raw.repeat) || '').replace(/\s+/g, ' ').trim().slice(0, 140);
        return { keys, repeat: this.quoteOk(r, userText) ? r : '' };
    },
});
if (typeof module !== 'undefined' && module.exports) module.exports = ThingCaptureRules;
