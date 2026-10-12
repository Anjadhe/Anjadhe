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
 * Since 2026-10-06 the judgment RUNS in ThingCapture (js/agent/thing-capture.js),
 * BEFORE the reply, together with the card's; this file keeps the folder's
 * prompt and the checks (`vet`), which ThingCapture calls.
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
    ...(typeof module !== 'undefined' && module.exports ? require('../shared/matter-capture') : MatterCaptureRules),
    _busy: new Set(),

    get M() { return typeof Matters !== 'undefined' ? Matters : require('../core/matters.js'); },
    /** C2: the quote is in the person's own words. */

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


    /** C5. */
    eligible(conv, { untrusted = false } = {}) {
        if (!conv || untrusted || conv.contextMode === 'simple') return false;
        if (typeof PrivateChat !== 'undefined' && PrivateChat.isPrivate(conv)) return false;
        return true;
    },
};

if (typeof module !== 'undefined') module.exports = MatterCapture;
