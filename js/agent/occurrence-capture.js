/**
 * OccurrenceCapture — what the person says about ONE day of a commitment
 * reaches that day (2026-10-05, docs/COMMITMENTS.md "A report lands on its
 * day").
 *
 * Why: a commitment has one conversation, and a repeating one has many days.
 * "Did 40 minutes today, knee was sore" in the workout's chat changed
 * nothing: the day stayed unmarked, the words were lost, and the assistant's
 * next read said the workout "went by without being done".
 *
 * A chat TIED to a commitment (conv.todayKey is `task:<id>`), so which
 * commitment is already known and nothing is ever created from here.
 *
 * Since 2026-10-06 the judgment RUNS in ThingCapture (js/agent/thing-capture.js),
 * BEFORE the reply, together with the card's; this file keeps the
 * commitment's prompt and the checks (`vet`), which ThingCapture calls.
 *
 * Laws:
 *   O1 The assistant judges, once per turn (`commitment-said`): did the
 *      person just report on a day of it (did it, skipped it, how it went),
 *      and which day?
 *   O2 Kept only with a quote copied verbatim from what the PERSON typed in
 *      this turn. The day's log keeps the quote itself.
 *   O3 Code checks the day (`vet`): for a repeat it is one of the real
 *      occurrences it was shown, today or before. A report made on another
 *      day ("did Monday's workout this morning") goes on the occurrence it
 *      is about; no occurrence is ever invented. A one-time commitment keeps
 *      it on the day it was said, and "skipped" there is only a note.
 *      "Could not do it this morning, will do it this evening" is not a
 *      report: it is kept on today as their PLAN (`later`), which marks
 *      nothing and leaves "how did it go?" still to be asked.
 *   O4 Written through Commitments' own door (`Commitments.report`): the
 *      words and the day's mark in ONE ledgered write, with the receipt
 *      under the answer and Undo. The receipt is written by code. No
 *      approval is asked: these are the person's own words about their own
 *      day.
 *   O5 Never from a private, no-personal-context, untrusted or headless
 *      turn; one capture at a time per conversation; fire-and-forget. When
 *      the turn's own tool already marked the day, only the words are kept.
 *
 * Pure gates are Node-testable (tests/occurrence-capture-test.js).
 */
const OccurrenceCapture = {
    SOURCE: 'commitment-said',
    REPORTS: ['none', 'done', 'skipped', 'note', 'later'],
    _busy: new Set(),

    get C() { return typeof Commitments !== 'undefined' ? Commitments : require('../core/commitments.js'); },
    _norm(s) { return String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim(); },
    /** O2: the quote is in the person's own words. */
    quoteOk(quote, userText) {
        const q = this._norm(quote);
        return q.length >= 2 && this._norm(userText).includes(q);
    },
    _dayLabel(iso) {
        return new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    },

    /** The commitment a chat is tied to, or null. */
    commitmentFor(conv) {
        const m = /^task:(.+)$/.exec(String((conv && conv.todayKey) || ''));
        return m ? this.C.get(m[1]) : null;
    },

    /**
     * Keep the assistant's answer only where it is checkable (O2, O3). Pure.
     * Returns { day, how, quote, receipt } or null.
     */
    vet(raw, c, userText, today = this.C.today(), { marked = false } = {}) {
        const C = this.C;
        if (!raw || typeof raw !== 'object' || !c) return null;
        let report = this.REPORTS.includes(raw.report) ? raw.report : 'none';
        if (report === 'none') return null;
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
        if (marked && report !== 'note') report = 'note';
        const how = report === 'done' ? 'done' : report === 'skipped' ? 'dropped' : null;
        const word = how === 'done' ? 'done' : how === 'dropped' ? 'skipped' : 'noted';
        return { day, how, plan: false, quote, receipt: `${this._dayLabel(day)}: ${word} · "${quote}"` };
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
{"report": "done" if they say they did it; "skipped" if they say they did not and will not do it that day; "later" if they say today's is not done yet but they will still do it later TODAY ("could not this morning, will do it this evening"); "note" if they said how it went or something about that day worth keeping, without saying it was done or skipped; "none" if they only asked something, made a plan for another day, talked about it in general ("I go every week"), or asked you to change it,
 "quote": the phrase that says so, copied EXACTLY from what the person just said${rep ? `,
 "day": the day it is about, as one of the dates listed above, for example "${days[0] || today}". "today" or no day mentioned means the most recent one on or before today. If they did an earlier day's one late ("did Monday's this morning"), give the day it was FOR` : ''}}
When unsure, answer "none".`;
    },

    /** O5. */
    eligible(conv, { untrusted = false } = {}) {
        if (!conv || untrusted || conv.contextMode === 'simple') return false;
        if (typeof PrivateChat !== 'undefined' && PrivateChat.isPrivate(conv)) return false;
        return true;
    },
};

if (typeof module !== 'undefined') module.exports = OccurrenceCapture;
