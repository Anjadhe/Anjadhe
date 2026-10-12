'use strict';
// Shared desktop capture prompts and checks; hosts supply record dependencies.
const MatterCaptureRules = Object.freeze({
    CHANGES: ['none', 'note', 'changed', 'done', 'cancelled'],
    _norm(s) { return String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim(); },
    quoteOk(quote, userText) {
        const q = this._norm(quote);
        return q.length >= 2 && this._norm(userText).includes(q);
    },
    vet(raw, m, userText, now = Date.now()) {
        const M = this.M;
        if (!raw || typeof raw !== 'object' || !m) return null;
        const change = this.CHANGES.includes(raw.change) ? raw.change : 'none';
        if (change === 'none') return null;
        const quote = String(raw.quote || '').replace(/\s+/g, ' ').trim().slice(0, 140);
        if (!this.quoteOk(quote, userText)) return null;
        const known = new Set([...M._nums(userText), ...M._nums(`${m.title || ''} ${m.status || ''} ${m.amount || ''} ${(m.when && `${m.when.date} ${m.when.time || ''}`) || ''} ${(m.next && m.next.what) || ''} ${(m.sources || []).map(s => s.summary).join(' ')}`)]);
        const clean = (s, max) => {
            const v = String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
            return v && M._nums(v).every(n => known.has(n)) ? v : '';
        };
        const lo = M._iso(now - 400 * 86400000), hi = M._iso(now + 730 * 86400000);
        const date = d => { const v = M._day(d); return v && v >= lo && v <= hi ? v : null; };
        const time = t => { const x = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim()); return x && +x[1] < 24 && +x[2] < 60 ? `${x[1].padStart(2, '0')}:${x[2]}` : null; };
        const closing = change === 'done' || change === 'cancelled';
        const status = change === 'note' ? '' : clean(raw.status, 80);
        const when = closing || change === 'note' ? null : date(raw.when);
        let next = null;
        const n = raw.next;
        if (!closing && change !== 'note' && n && typeof n === 'object') {
            const what = clean(n.what, 120);
            if (what) next = { what, label: null, by: date(n.by), how: 'none', reply: null, url: null, yours: n.yours === true, isTask: false };
        }
        // "changed" has to change something a check let through.
        if (change === 'changed' && !status && !when && !next) return null;
        const receipt = change === 'done' ? 'marked done' : change === 'cancelled' ? 'marked cancelled' : change === 'note' ? 'noted' : (status || 'updated');
        return {
            about: m.id, kind: m.kind || 'other', title: '', status, change: change === 'note' ? 'same' : change,
            when, time: when ? time(raw.time) : null, next, calendarEventId: null, taskId: null, checkinUrl: null, tell: 'file',
            quote, note: `You said: "${quote}"`, receipt
        };
    },
    _prompt(m, userText, before, now = Date.now()) {
        const M = this.M;
        const today = new Date(now).toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const step = M.openStep(m);
        const lines = [
            `${M.titleOf(m)} (${m.kind}, ${m.state})`,
            m.status ? `Where it stands: ${m.status}` : '',
            m.when && m.when.date ? `When: ${m.when.date}${m.when.time ? ' ' + m.when.time : ''}` : '',
            step ? `Their next step: ${step.what}${step.by ? ` by ${step.by}` : ''}` : 'Nothing is waiting on them.',
            ...(m.sources || []).slice(-3).map(s => `- ${s.from || 'unknown'}: ${String(s.summary || '').slice(0, 160)}`)
        ].filter(Boolean);
        return `Today is ${today}.

You keep a folder for one real thing in the person's life. They are talking with you about it. Decide whether what they JUST SAID changes where it stands.

THE FOLDER
${lines.join('\n')}
${before ? `\nYOU (context only, never quote it): ${String(before).slice(0, 400)}\n` : ''}
THE PERSON JUST SAID:
${userText}

Answer JSON only:
{"change": "none" if they only asked something, chatted, or told you what to do with the card (ignore it, later); "done" if they say it is finished or dealt with (paid, went, picked up, confirmed, sorted out); "cancelled" if they say it is off; "changed" if they tell you a new fact about it (a new date or time, a new amount, what they will do next, where it stands now); "note" if they said something about it worth keeping that changes none of that,
 "quote": the phrase that says so, copied EXACTLY from what the person just said,
 "status": where it stands now in a few words, or null,
 "when": "YYYY-MM-DD" only if they gave a new date, else null, "time": "HH:MM" or null,
 "next": {"what": the one thing they now have to do, "by": "YYYY-MM-DD" or null, "yours": true if it is real work for them} only if they said what comes next, else null}
Never invent amounts, dates or times. When unsure, answer "none".`;
    },
});
if (typeof module !== 'undefined' && module.exports) module.exports = MatterCaptureRules;
