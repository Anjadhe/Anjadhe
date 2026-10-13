'use strict';
// Shared commitment calendar, extracted from Commitments under law C1.
// One implementation in Electron and JavaScriptCore. No storage, network,
// DOM, model calls or mutable module state. Dates use the device's local zone.
const CommitmentCalendar = Object.freeze({
    KINDS: ['goal', 'project', 'habit', 'task'],
    kindOf(c, all = this.all()) {
        if (!c) return 'task';
        if (this.KINDS.includes(c.kind)) return c.kind;
        if (c.aim || c.domain) return 'goal';
        if (c.outcome || all.some(k => k && k.parent === c.id)) return 'project';
        return this.repeats(c) ? 'habit' : 'task';
    },

    iso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; },
    today(now = Date.now()) { return this.iso(new Date(now)); },
    /** A real calendar date, or null. */
    day(v) {
        const s = String(v || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
        const [y, m, d] = s.split('-').map(Number);
        const dt = new Date(y, m - 1, d);
        return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? s : null;
    },
    /** HH:MM, or null. */
    time(v) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
        return m && +m[1] < 24 && +m[2] < 60 ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
    },
    repeats(c) { return !!(c && c.repeat && c.repeat.rule && c.repeat.rule !== 'none'); },
    /**
     * Does it happen on this YYYY-MM-DD? The anchor (when.date) is the start;
     * a repeat never fires before it. With no anchor it starts on the local
     * day it was made (2026-10-09): a weekly made on Friday was asked about
     * "Sat, Oct 3", a day from before it existed.
     */
    occursOn(c, dateStr) {
        const anchor = c && c.when && c.when.date;
        if (!this.repeats(c)) return !!anchor && anchor === dateStr;
        const start = anchor || this.madeOn(c);
        if (start && dateStr < start) return false;
        // A stage of a plan repeats until its last day (docs/COACH.md §1).
        if (c.until && dateStr > c.until) return false;
        const rule = c.repeat.rule;
        if (rule === 'monthly' || rule === 'yearly') {
            if (!anchor) return false;
            const [, am, ad] = anchor.split('-').map(Number);
            const [y, m, d] = dateStr.split('-').map(Number);
            const dim = new Date(y, m, 0).getDate();
            const day = Math.min(ad, dim);   // the 31st falls on the month's last day
            return rule === 'monthly' ? d === day : (m === am && d === Math.min(ad, new Date(y, am, 0).getDate()));
        }
        const dow = new Date(`${dateStr}T00:00:00`).getDay();
        if (rule === 'daily') return true;
        if (rule === 'weekdays') return dow >= 1 && dow <= 5;
        return (c.repeat.days || []).includes(dow);   // weekly / custom
    },
    /** The local YYYY-MM-DD it was made, or '' when unknown. */
    madeOn(c) {
        const t = c && c.createdAt ? Date.parse(c.createdAt) : NaN;
        return Number.isFinite(t) && t > 0 ? this.iso(new Date(t)) : '';
    },
    /** The next date on or after `fromISO` it happens (within ~2 years), or null. */
    nextOn(c, fromISO) {
        if (!this.repeats(c)) return (c.when && c.when.date) || null;
        const start = c.when && c.when.date && c.when.date > fromISO ? c.when.date : fromISO;
        const d = new Date(`${start}T00:00:00`);
        for (let i = 0; i < 800; i++) {
            const s = this.iso(d);
            if (this.occursOn(c, s)) return s;
            d.setDate(d.getDate() + 1);
        }
        return null;
    },
    /**
     * The time ONE day of it happens (2026-10-05): that day's own time when
     * it was moved for that day only (`moved[day]`), else the usual one.
     * "Not permanently, just for today" had nowhere to go: the only time a
     * repeat had was the series' own, so a one-day move rewrote every week.
     * Pure. Returns { time, end, moved }.
     */
    timeOn(c, day) {
        const w = (c && c.when) || {};
        const m = c && c.moved && c.moved[day];
        if (m && m.time && this.repeats(c)) return { time: m.time, end: m.end || null, moved: true };
        return { time: w.time || null, end: w.time ? (w.end || null) : null, moved: false };
    },
    /** Resolved for this day? One-time: by state. Repeating: today's history. */
    isDone(c, dateStr) {
        if (!c) return false;
        if (!this.repeats(c)) return c.state === 'done' || c.state === 'dropped';
        const h = c.history && c.history[dateStr];
        return h === 'done' || h === 'dropped';
    },
});

if (typeof module !== 'undefined' && module.exports) module.exports = CommitmentCalendar;
