/**
 * Rhythm — when the person's day starts, learned from when they use nenva
 * (2026-10-02, docs/AI_NATIVE.md phase 4). Routines that used to be fixed at
 * 07:00 / 09:00 for everyone (Morning News, a project's weekly review) start
 * from this instead.
 *
 *   FACT     the first time nenva is used each day (`noteActive`, per Mac).
 *   DEFAULT  07:00 until there are five days of facts; then a little before
 *            the person's usual first look (median, rounded down to :00/:30,
 *            minus 30 minutes).
 *   ASKED    once the learned time differs from what nenva uses, a one-tap
 *            question (PrefAsks 'day-start'); the answer is a Memory sentence
 *            ("My day usually starts around 7:30.") that wins from then on.
 */
const Rhythm = {
    KEY: 'rhythm-day-starts',
    MIN_DAYS: 5,

    _days() { try { return JSON.parse(localStorage.getItem(this.KEY) || '{}'); } catch { return {}; } },

    /** The first activity of today, if this is it. */
    noteActive(now = new Date()) {
        const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const days = this._days();
        if (days[d] !== undefined) return;
        days[d] = now.getHours() * 60 + now.getMinutes();
        const keep = Object.keys(days).sort().slice(-30);
        const out = {};
        for (const k of keep) out[k] = days[k];
        try { localStorage.setItem(this.KEY, JSON.stringify(out)); } catch { /* fine */ }
        this._checkAsk();
    },

    /** Learned from the facts, or null with too few days. Pure over `days`. */
    learned(days = this._days()) {
        const mins = Object.values(days).filter(m => Number.isFinite(m) && m >= 240 && m <= 720).sort((a, b) => a - b);
        if (mins.length < this.MIN_DAYS) return null;
        const median = mins[Math.floor(mins.length / 2)];
        const t = Math.max(300, Math.floor(median / 30) * 30 - 30);
        return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    },

    /** The time morning things should run: the person's answer, else learned, else 07:00. */
    morning() {
        const asked = typeof PrefAsks !== 'undefined' ? PrefAsks.value('day-start') : null;
        return asked || this.learned() || '07:00';
    },

    _label(hhmm) {
        const [h, m] = hhmm.split(':').map(Number);
        return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    },
    _checkAsk() {
        if (typeof PrefAsks === 'undefined') return;
        const l = this.learned();
        if (!l || PrefAsks.answered('day-start')) return;
        PrefAsks.suggest('day-start', l, `You usually start your day around ${this._label(l)}. Run your morning routines then?`);
    },

    init() {
        if (this._inited) return;
        this._inited = true;
        if (typeof PrefAsks !== 'undefined') {
            const times = [];
            for (let t = 300; t <= 660; t += 30) times.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
            PrefAsks.register({
                id: 'day-start', order: 70, default: null,
                question: 'When should your morning routines run?',
                choices: times.map(v => ({ value: v, label: this._label(v), sentence: `My day usually starts around ${this._label(v)}; run morning routines then.` }))
            });
        }
        this.noteActive();
        window.addEventListener('focus', () => this.noteActive());
    }
};

if (typeof module !== 'undefined') module.exports = Rhythm;
