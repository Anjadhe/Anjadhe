'use strict';
// Shared sender alias and inherited membership rules (SENDERS S5).
const SenderMembership = (() => {
const Calendar = typeof module !== 'undefined' && module.exports ? require('./commitment-calendar') : CommitmentCalendar;
return Object.freeze({
    NENVA: 'nenva', REMINDERS: 'sender:reminders',
    nenva() { return { id: this.NENVA, name: 'nenva', allGood: '', state: 'active', confirmed: true, builtIn: true }; },
    reminders() { return { id: this.REMINDERS, name: 'Reminders', allGood: 'Every small thing you said you would do is done, moved or let go, and nothing slips by unnoticed.', state: 'active', confirmed: true, builtIn: true }; },
    isToDo(c, all = []) {
        if (!c || !c.id || !c.title || c.parent) return false;
        if ((c.privacySources || []).includes('slack') || (c.origin && c.origin.kind === 'plan')) return false;
        // What it IS decides (CommitmentKinds): only a task with nothing under it.
        return Calendar.kindOf(c, all) === 'task' && !all.some(k => k && k.parent === c.id);
    },

    resolve(data, id) {
        let x = id;
        for (let i = 0; i < 6 && data.aliases && data.aliases[x]; i++) x = data.aliases[x];
        return x;
    },
    senderOfIn(data, key, { matterOf = null, folderOfTask = null, commitment = null } = {}) {
        if (!key) return null;
        const direct = k => { const p = data.place[k]; const id = p ? this.resolve(data, p.sender) : null; return id && data.senders[id] ? id : null; };
        if (/^matter:/.test(key)) {
            const m = matterOf ? matterOf(key) : null;
            return direct(m ? m.id : key) || direct(key);
        }
        const tm = /^task:(.+)$/.exec(key);
        if (!tm) return direct(key);
        const own = direct(key);
        if (own) return own;
        let c = commitment ? commitment(tm[1]) : null;
        for (let i = 0; i < 6 && c; i++) {
            if (i > 0) { const up = direct(`task:${c.id}`); if (up) return up; }
            if (c.origin && c.origin.kind === 'matter' && c.origin.ref) { const s = this.senderOfIn(data, String(c.origin.ref).startsWith('matter:') ? c.origin.ref : `matter:${c.origin.ref}`, { matterOf }); if (s) return s; }
            const f = folderOfTask ? folderOfTask(c.id) : null;
            if (f) { const s = direct(f.id); if (s) return s; }
            c = c.parent && commitment ? commitment(c.parent) : null;
        }
        return null;
    },
});
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SenderMembership;
