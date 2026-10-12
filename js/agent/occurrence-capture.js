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
 *   O6 The figures in their words ride along as measures (docs/COACH.md
 *      §2, 2026-10-09): the model names them, Commitments.report keeps only
 *      those whose figure is in the quote, and the receipt names what was
 *      kept. A figure it worked out (a pace) is refused there.
 *   O5 Never from a private, no-personal-context, untrusted or headless
 *      turn; one capture at a time per conversation; fire-and-forget. When
 *      the turn's own tool already marked the day, only the words are kept.
 *
 * Pure gates are Node-testable (tests/occurrence-capture-test.js).
 */
const OccurrenceCapture = {
    ...(typeof module !== 'undefined' && module.exports ? require('../shared/occurrence-capture') : OccurrenceCaptureRules),
    SOURCE: 'commitment-said',
    // 'request' (2026-10-09): they asked YOU to do something; nothing is recorded here, the reply does it.
    _busy: new Set(),

    get C() { return typeof Commitments !== 'undefined' ? Commitments : require('../core/commitments.js'); },
    /** O2: the quote is in the person's own words. */

    /** The commitment a chat is tied to, or null. */
    commitmentFor(conv) {
        const m = /^task:(.+)$/.exec(String((conv && conv.todayKey) || ''));
        return m ? this.C.get(m[1]) : null;
    },

    /**
     * Keep the assistant's answer only where it is checkable (O2, O3). Pure.
     * Returns { day, how, quote, receipt } or null.
     */

    /** The model's "measures" as the store takes them: numbers as numbers, a clock as said. Pure. */

    /** The receipt once the store kept the figures: "Oct 9: done · 5.2 mi, 48 min". Pure. */

    /**
     * The "measures" field of a report's answer (O6), shared by this prompt
     * and ThingCapture's one-time one: an undated "Track blood pressure"
     * does not repeat, and without the field its readings were kept as
     * words with no figures, so the progress line never saw them.
     */

    /**
     * The figures in words the person edited on the sheet (2026-10-10): one
     * call, the same "measures" field as a report; Commitments.editReport
     * checks each against the words. Resolves [] on any failure.
     */
    async readFigures(c, words) {
        if (!c || !/\d/.test(String(words || '')) || typeof LLMLogger === 'undefined' || typeof AgentService === 'undefined') return [];
        const prompt = `The person keeps "${c.title}" and wrote this about a day of it:\n${String(words).slice(0, 200)}\n\nAnswer JSON only:\n{${this.measuresClause(c)}}`;
        try {
            const res = await LLMLogger.call(this.SOURCE, {
                model: AgentService.model,
                messages: [{ role: 'system', content: 'You are the person\'s personal assistant. You answer with JSON only.' }, { role: 'user', content: prompt }],
                format: 'json', think: false, maxTokens: 200, stream: false, jobClass: 'background', logTag: this.SOURCE,
                options: { temperature: 0.1, num_ctx: AgentService.numCtx || 8192 }
            });
            if (!res || res.error) return [];
            const raw = JSON.parse(String(res.message && res.message.content || '').replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim());
            return this.figuresOf(raw && raw.measures);
        } catch { return []; }
    },


    /** O5. */
    eligible(conv, { untrusted = false } = {}) {
        if (!conv || untrusted || conv.contextMode === 'simple') return false;
        if (typeof PrivateChat !== 'undefined' && PrivateChat.isPrivate(conv)) return false;
        return true;
    },
};

if (typeof module !== 'undefined') module.exports = OccurrenceCapture;
