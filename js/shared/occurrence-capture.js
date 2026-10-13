'use strict';
// Shared desktop capture prompts and checks; hosts supply record dependencies.
const OccurrenceCaptureRules = Object.freeze({
    REPORTS: ['none', 'done', 'skipped', 'note', 'later', 'request'],
    _norm(s) { return String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim(); },
    quoteOk(quote, userText) {
        const q = this._norm(quote);
        return q.length >= 2 && this._norm(userText).includes(q);
    },
    _dayLabel(iso) {
        return new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    },
    vet(raw, c, userText, today = this.C.today(), { marked = false } = {}) {
        const C = this.C;
        if (!raw || typeof raw !== 'object' || !c) return null;
        let report = this.REPORTS.includes(raw.report) ? raw.report : 'none';
        if (report === 'none' || report === 'request') return null;
        const quote = String(raw.quote || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!this.quoteOk(quote, userText)) return null;
        let day = today;
        if (C.repeats(c)) {
            const days = C.recentDays(c, today);
            const given = C.day(raw.day);
            // The day they did it rather than the day it was for: the
            // occurrence it belongs to is the latest one on or before it.
            day = given && given <= today ? days.find(d => d <= given) : null;
            if (!day || (given !== day && Math.round((Date.parse(`${given}T12:00:00`) - Date.parse(`${day}T12:00:00`)) / 86400000) > 6)) return null;
        } else if (report === 'skipped') report = 'note';
        // Still to come: only ever about today, and only while today is open.
        if (report === 'later') {
            if (day !== today || C.isDone(c, today) || (c.history && c.history[today])) return null;
            return { day, how: null, plan: true, quote, receipt: `${this._dayLabel(day)}: still to come · "${quote}"` };
        }
        // O6: passed on as named; Commitments.report checks each against the quote.
        const measures = this.figuresOf(raw.measures);
        if (marked && report !== 'note') report = 'note';
        const how = report === 'done' ? 'done' : report === 'skipped' ? 'dropped' : null;
        const word = how === 'done' ? 'done' : how === 'dropped' ? 'skipped' : 'noted';
        return { day, how, plan: false, quote, ...(measures.length ? { measures } : {}), receipt: `${this._dayLabel(day)}: ${word} · "${quote}"` };
    },
    figuresOf(list) {
        return Array.isArray(list) ? list.filter(m => m && typeof m === 'object').slice(0, 8)
            .map(m => ({ name: m.name, value: typeof m.value === 'string' && !m.value.includes(':') && m.value.trim() !== '' ? Number(m.value.replace(/,/g, '')) : m.value, unit: m.unit })) : [];
    },
    receiptWith(j, kept) {
        if (!kept || !kept.length) return j.receipt;
        const C = this.C;
        const word = j.how === 'done' ? 'done' : j.how === 'dropped' ? 'skipped' : 'noted';
        return `${this._dayLabel(j.day)}: ${word} · ${kept.map(m => m.unit === 'time' ? `${m.name} ${C.figure(m.value, 'time')}` : C.figure(m.value, m.unit)).join(', ')}`;
    },
    measuresClause(c) {
        let units = '';
        try { units = Object.entries(this.C.measureUnits(c)).map(([n, u]) => `${n} (${u || 'count'})`).join(', '); } catch { units = ''; }
        return `"measures": the figures in what they said, each as they said it: [{"name", "value", "unit"}] ("ran 5.2 miles in 48 min" is [{"name":"distance","value":5.2,"unit":"mi"},{"name":"duration","value":48,"unit":"min"}]; "BP 128/82" is systolic 128 and diastolic 82 "mmHg"; "in bed 11:40" is {"name":"bedtime","value":"23:40","unit":"time"}). Never a figure you worked out. [] when there is none${units ? `. Names already kept here, reuse them: ${units}` : ''}`;
    },
    _prompt(c, userText, before, today = this.C.today()) {
        const C = this.C;
        const rep = C.repeats(c);
        const days = C.recentDays(c, today);
        const now = new Date(`${today}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const dayLines = days.map(d => `${d} (${this._dayLabel(d)}${d === today ? ', today' : ''})${c.history && c.history[d] ? ` — already marked ${c.history[d] === 'dropped' ? 'skipped' : c.history[d]}` : ''}`);
        return `Today is ${now} (${today}).

The person keeps this commitment and is talking with you about it. Decide whether what they JUST SAID reports on a particular day of it.

THE COMMITMENT
${c.title}${rep ? `\nIt repeats. Its recent days:\n${dayLines.join('\n')}` : `${c.when && c.when.date ? `\nIts day: ${c.when.date}` : ''}${c.state !== 'open' ? `\nAlready marked ${c.state}.` : ''}`}
${before ? `\nYOU (context only, never quote it): ${String(before).slice(0, 400)}\n` : ''}
THE PERSON JUST SAID:
${userText}

Answer JSON only:
{"report": "request" if they ask YOU to do something (add or create an item, a step or a task, change, move, plan, schedule, remind, delete): nothing is recorded here, you will do it in your reply; "done" if they say they did it, even when they also say how it went ("did it last night, knee was sore" is done); "skipped" if they say they did not and will not do it that day; "later" if they say today's is not done yet but they will still do it later TODAY ("could not this morning, will do it this evening"); "note" ONLY if they said how a day of it went without saying they did it or skipped it ("slow going today", "half done"), never an idea, a wish or something to add; "none" if they only asked something, made a plan for another day, or talked about it in general ("I go every week"),
 "quote": the phrase that says so, copied EXACTLY from what the person just said, including any figures,
 ${this.measuresClause(c)}${rep ? `,
 "day": the day it is about, as one of the dates listed above, for example "${days[0] || today}". "today" or no day mentioned means the most recent one on or before today. If they did an earlier day's one late ("did Monday's this morning"), give the day it was FOR. When the commitment is itself a log of something that happened before it (a morning sleep log), last night's sleep belongs to TODAY's log, not yesterday's` : ''}}
When unsure, answer "none".`;
    },
});
if (typeof module !== 'undefined' && module.exports) module.exports = OccurrenceCaptureRules;
