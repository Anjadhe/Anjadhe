/**
 * AskAfter — "how did it go?" after something the person planned to do
 * (2026-10-05, by request, docs/COMMITMENTS.md "Asking how it went").
 *
 * A workout planned for today is worth asking about a few hours later; a
 * school pickup is not. The answer starts the commitment's own conversation,
 * where what the person says lands on that day (OccurrenceCapture).
 *
 *   JUDGMENT         Which commitments are worth asking after is the
 *   (the assistant)  assistant's, made when it reads each one
 *                    (Commitments' read, `askAfter`). No word list decides.
 *   FACTS (code)     It happened today (or last evening): a real occurrence,
 *                    whose time passed WAIT_MS ago (no time: from EVENING).
 *                    The time is THAT DAY's (Commitments.timeOn): a day
 *                    moved to the evening is asked about after the evening.
 *                    Nothing is on that day yet: no mark, no report. Anything
 *                    the person already reported, by a tap or in the chat,
 *                    means there is nothing to ask. "I'll do it tonight" is
 *                    a plan, not a report: the question waits for the
 *                    evening instead of going away.
 *   SURFACE          One card on Now at a time (kind Check-in): Tell you how
 *                    it went (opens the commitment's chat, opening with the
 *                    question), Did it, Skipped it, Not now, Don't ask about
 *                    this. One notification per occurrence, inside
 *                    Proactive's shared budget, never late at night.
 *   MEMORY           "Don't ask about this" stops it for that commitment and
 *                    writes a Preferences sentence the assistant reads.
 *   SAFETY           Nothing is marked without a tap or the person's words.
 *
 * Pure core: askAt, due. Pinned by tests/ask-after-test.js.
 */
const AskAfter = {
    WAIT_MS: 2 * 3600000,          // after it ends
    DEFAULT_LEN_MS: 3600000,       // a timed one with no end is taken as an hour
    EVENING: 18 * 60,              // an untimed one is asked about from 6 PM
    OPEN_MS: 16 * 3600000,         // the question stays this long, then lapses
    NUDGE_FROM: 8 * 60,
    NUDGE_UNTIL: 21 * 60,
    LOCAL_KEY: 'ask-after-nudged',

    get C() { return typeof Commitments !== 'undefined' ? Commitments : require('./commitments.js'); },
    _hm(v) { const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim()); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null; },

    /** When the question about `day` opens (ms). Pure. */
    askAt(c, day) {
        const base = new Date(`${day}T00:00:00`).getTime();
        const t = this.C.timeOn(c, day);
        const start = this._hm(t.time);
        const evening = base + this.EVENING * 60000;
        if (start === null) return evening;
        const end = this._hm(t.end);
        const at = base + (end !== null && end > start ? end * 60000 : start * 60000 + this.DEFAULT_LEN_MS) + this.WAIT_MS;
        // They said it is still to come that day, and gave it no new time:
        // not before the evening has had its chance.
        return !t.moved && this.planned(c, day) ? Math.max(at, evening + this.WAIT_MS) : at;
    },
    /** Their words on that day that say it is still to come (Commitments.report `plan`). */
    planned(c, day) { return !!(c.log && c.log[day] && c.log[day].some(e => e && e.plan)); },
    /** Already reported: a mark, or words that are not just a plan. */
    reported(c, day) { return !!((c.history && c.history[day]) || (c.log && c.log[day] && c.log[day].some(e => e && !e.plan))); },

    /** What is worth asking about right now: [{ c, day, askAt }], earliest first. Pure. */
    due(all, nowMs = Date.now()) {
        const C = this.C;
        const today = C.today(nowMs);
        const yesterday = C.iso(new Date(new Date(`${today}T12:00:00`).getTime() - 86400000));
        const out = [];
        for (const c of all || []) {
            if (!c || c.state !== 'open' || !c.read || c.read.askAfter !== true || c.read.stopAsk) continue;
            for (const day of [today, yesterday]) {
                if (!C.occursOn(c, day)) continue;
                if (this.reported(c, day)) continue;
                const at = this.askAt(c, day);
                if (nowMs >= at && nowMs < at + this.OPEN_MS) out.push({ c, day, askAt: at });
            }
        }
        return out.sort((a, b) => a.askAt - b.askAt);
    },

    key(x) { return `askafter:${x.c.id}:${x.day}`; },
    _dayWord(day, nowMs = Date.now()) { return day === this.C.today(nowMs) ? 'today' : 'yesterday'; },
    question(x, nowMs = Date.now()) {
        const w = this._dayWord(x.day, nowMs);
        return `How did “${x.c.title}” go${w === 'today' ? '' : ' yesterday'}?`;
    },

    /** Now's cards: the one question open now. */
    cards(nowMs = Date.now()) {
        if (typeof Commitments === 'undefined' || !Commitments._inited) return [];
        return this.due(Commitments.all(), nowMs).slice(0, 1).map(x => {
            const on = this.C.timeOn(x.c, x.day).time;
            const t = on ? new Date(`${x.day}T${on}:00`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
            return { key: this.key(x), kind: 'checkin', rank: 50, title: this.question(x, nowMs),
                body: `It was on your list for ${this._dayWord(x.day, nowMs)}${t ? ` at ${t}` : ''}. Tell me and I'll keep it on that day.`,
                primary: 'Tell you how it went', choices: ['Did it', 'Skipped it'],
                commitment: x.c.id, askAfter: { id: x.c.id, day: x.day }, talk: '' };
        });
    },

    /** A tap on the card: done or skipped, on that day, with Undo. */
    mark(id, day, how) {
        const r = Commitments.report(id, { day, how }, { by: 'you', why: 'answered how it went' });
        if (r.ok && r.ledgerId && typeof UIUtils !== 'undefined' && UIUtils.showToast) {
            try { UIUtils.showToast(how === 'done' ? 'Marked done' : 'Marked skipped', 'success', 6000, { actionLabel: 'Undo', onAction: () => { Commitments.undo(r.ledgerId); if (typeof SimpleExperience !== 'undefined') SimpleExperience.render(); } }); } catch { /* the mark holds */ }
        }
        return r;
    },

    /** Open the commitment's own chat with the question asked in it. */
    open(id, day) {
        const c = Commitments.get(id);
        if (!c || typeof AgentService === 'undefined' || typeof SimpleExperience === 'undefined') return;
        const card = { key: `task:${id}`, title: c.title, body: '', commitment: id };
        const { conv } = SimpleExperience._cardConv(card);
        const q = this.question({ c, day });
        const last = (conv.messages || []).slice(-1)[0];
        if (!(last && last.role === 'assistant' && last.content === q)) {
            conv.messages.push({ role: 'assistant', content: q, timestamp: new Date().toISOString(), metadata: { fromCard: true } });
            conv.updatedAt = new Date().toISOString();
            AgentService._saveConversations();
        }
        SimpleExperience.openChatFor(card);
    },

    /** Don't ask about this one again; the assistant reads why. */
    stop(id) {
        const c = Commitments.get(id);
        if (!c) return;
        c.read = { ...(c.read || {}), askAfter: false, stopAsk: true };
        Commitments._save();
        if (typeof MemoryManager !== 'undefined') {
            try { MemoryManager.remember({ text: `Don't ask me how "${c.title}" went.`, heading: 'preferences', subject: `no-ask-after:${id}`, source: 'you' }); } catch { /* the stop still holds */ }
        }
    },

    /** Pure: which open question, if any, gets its one notification now. */
    nudgeChoice(due, nudged, now, { looking = false } = {}) {
        const mins = now.getHours() * 60 + now.getMinutes();
        if (looking || mins < this.NUDGE_FROM || mins >= this.NUDGE_UNTIL) return null;
        return due.find(x => !nudged[this.key(x)]) || null;
    },
    nudgeMaybe(now = new Date()) {
        try {
            if (typeof Proactive === 'undefined' || typeof Commitments === 'undefined' || !Commitments._inited) return;
            if (typeof SimpleExperience !== 'undefined' && SimpleExperience.locked && (SimpleExperience.locked('actions') || SimpleExperience.locked('schedule'))) return;
            let nudged = {};
            try { nudged = JSON.parse(localStorage.getItem(this.LOCAL_KEY) || '{}') || {}; } catch { nudged = {}; }
            const looking = !document.hidden && document.hasFocus() && typeof AppManager !== 'undefined' && AppManager.currentApp === null;
            const x = this.nudgeChoice(this.due(Commitments.all(), now.getTime()), nudged, now, { looking });
            if (!x) return;
            const key = this.key(x);
            const sent = Proactive._notify('askafter', this.question(x, now.getTime()), 'Tell me and I\'ll keep it on that day.', 'reminder', () => {
                if (typeof AppManager !== 'undefined') AppManager.showDashboard();
                if (typeof SimpleExperience !== 'undefined') { SimpleExperience._front = key; SimpleExperience.render(); }
            });
            if (!sent) return;
            nudged[key] = now.getTime();
            const keys = Object.keys(nudged);
            for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete nudged[k];
            try { localStorage.setItem(this.LOCAL_KEY, JSON.stringify(nudged)); } catch { /* quota */ }
        } catch (e) { console.warn('[ask-after] nudge failed:', e && e.message); }
    }
};

if (typeof module !== 'undefined') module.exports = AskAfter;
