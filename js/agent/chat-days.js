/**
 * ChatDays — a chat that runs over several days says which day each part
 * was said on (2026-10-05).
 *
 * One conversation per thing means a chat is continued days later. The
 * model then reads its own "moved to tomorrow at 9:00 AM" from yesterday as
 * if it were said now, and answers "It's set for 9:00 AM tomorrow" without
 * changing anything (Ram, 2026-10-05). Messages carried no day, so nothing
 * told it that "tomorrow" had already become today.
 *
 * Code keeps the fact, the model reads it: every message is stamped when it
 * is written (`timestamp`), and at send time the first user message of each
 * EARLIER day gets one code-written line naming that day. Today's messages
 * get none (CURRENT CONTEXT names today). Send-time only, on copies: the
 * stored message and what the person sees never change.
 *
 * Pure; pinned by tests/chat-days-test.js.
 */
const ChatDays = {
    _iso(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },
    /** The local day a stamp falls on, or '' when there is no usable stamp. */
    dayOf(stamp) {
        const t = stamp ? Date.parse(stamp) : NaN;
        return Number.isFinite(t) ? this._iso(new Date(t)) : '';
    },
    line(dayISO) {
        const d = new Date(`${dayISO}T12:00:00`);
        const name = d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        return `(The app notes: this part of the chat was on ${name}, ${dayISO}. "Today", "tomorrow" and "tonight" in it mean that day, and anything it says was set or moved may have changed since.)`;
    },
    /**
     * `stored` are the conversation's messages in the window, `llm` the
     * copies about to be sent (same order and length). Returns `llm` with
     * the day lines added. `startedAt` (the conversation's createdAt) dates
     * the first user message of a chat written before messages were stamped.
     */
    mark(stored, llm, { now = Date.now(), startedAt = null, windowStart = 0 } = {}) {
        if (!Array.isArray(stored) || !Array.isArray(llm) || stored.length !== llm.length) return llm;
        const today = this._iso(new Date(now));
        let last = '', firstUser = true;
        return llm.map((m, i) => {
            const s = stored[i];
            if (!s || s.role !== 'user') return m;
            let day = this.dayOf(s.timestamp);
            if (!day && firstUser && windowStart === 0) day = this.dayOf(startedAt);
            firstUser = false;
            if (!day || day >= today || day === last) return m;
            last = day;
            const head = this.line(day) + '\n';
            if (typeof m.content === 'string') return { ...m, content: head + m.content };
            if (Array.isArray(m.content)) return { ...m, content: [{ type: 'text', text: head }, ...m.content] };
            return m;
        });
    }
};

if (typeof module !== 'undefined') module.exports = ChatDays;
