/**
 * PrefAsks — preferences without settings screens, and without typing
 * (2026-10-02, docs/AI_NATIVE.md phase 4; Ram: "it should not be simple text
 * based thing making user to enter everything").
 *
 * A preference is a sentence in Memory that nenva reads. It arrives one of
 * three ways, none of which needs typing:
 *   1. A sensible DEFAULT: nothing to set up (`def.default`).
 *   2. A ONE-TAP QUESTION at the moment it matters (`def.ready()` says when):
 *      a card on Now with the choices as buttons, plus Not now.
 *   3. LEARNED from what the person does (`suggest(id, value, question)`),
 *      then confirmed with one tap.
 * A tap writes the choice's sentence to Memory (`pref:<id>` subject, the
 * value in meta), so it reads as words and replaces the earlier answer.
 * Memory shows the sentence with the same choices to change it by tap;
 * typing a sentence of your own stays possible, never required.
 *
 * Code holds: the choices offered (a fixed, safe set per preference), when
 * a question may appear, one question at a time, Not now = a week.
 */
const PrefAsks = {
    SNOOZE_MS: 7 * 86400000,
    STATE_KEY: 'pref-asks',
    _defs: new Map(),
    _listeners: new Map(),

    /**
     * def = { id, question, why?, default, heading?, choices: [{ value,
     * label, sentence }], ready?: () => bool, order? }
     */
    register(def) {
        if (!def || !def.id || !Array.isArray(def.choices) || !def.choices.length) return;
        this._defs.set(def.id, def);
    },
    def(id) { return this._defs.get(id) || null; },
    onChange(id, fn) { this._listeners.set(id, fn); },

    fact(id) {
        if (typeof MemoryManager === 'undefined') return null;
        try { return MemoryManager.all().find(f => f.subject === `pref:${id}`) || null; } catch { return null; }
    },
    /** The current value: the person's answer, else the default. */
    value(id) {
        const f = this.fact(id);
        if (f && f.meta && f.meta.value !== undefined) return f.meta.value;
        const d = this.def(id);
        return d ? d.default : undefined;
    },
    answered(id) { return !!this.fact(id); },

    /** A tap (or a migration): write the choice's sentence to Memory. */
    set(id, value, { source = 'you', quiet = false } = {}) {
        const d = this.def(id);
        const c = d && d.choices.find(x => x.value === value);
        if (!c || typeof MemoryManager === 'undefined') return false;
        MemoryManager.remember({ text: c.sentence, heading: d.heading || 'preferences', subject: `pref:${id}`, meta: { pref: id, value }, source });
        const st = this._state();
        delete st.snoozed[id];
        st.suggest = st.suggest.filter(s => s.id !== id);
        this._save(st);
        const fn = this._listeners.get(id);
        if (fn) { try { fn(value); } catch (e) { console.warn('[pref-asks] listener failed:', e); } }
        if (!quiet && typeof UIUtils !== 'undefined') UIUtils.showToast(`Got it: “${c.sentence}”`, 'success');
        return true;
    },

    _state() {
        try {
            const s = JSON.parse(localStorage.getItem(this.STATE_KEY) || '{}');
            return { snoozed: s.snoozed || {}, suggest: s.suggest || [] };
        } catch { return { snoozed: {}, suggest: [] }; }
    },
    _save(s) { try { localStorage.setItem(this.STATE_KEY, JSON.stringify(s)); } catch { /* per-Mac */ } },
    snooze(id, ms = this.SNOOZE_MS) { const s = this._state(); s.snoozed[id] = Date.now() + ms; s.suggest = s.suggest.filter(x => x.id !== id); this._save(s); },

    /** Learned from what the person did: ask to make it the rule (one tap). */
    suggest(id, value, question) {
        const d = this.def(id);
        if (!d || this.value(id) === value || !d.choices.some(c => c.value === value)) return;
        const s = this._state();
        if ((s.snoozed[id] || 0) > Date.now()) return;
        s.suggest = s.suggest.filter(x => x.id !== id);
        s.suggest.push({ id, value, question: String(question || d.question).slice(0, 160), at: Date.now() });
        this._save(s);
    },

    /** The questions due now, as cards for Now (one at a time). */
    due(now = Date.now()) {
        const s = this._state();
        const out = [];
        for (const x of s.suggest) {
            const d = this.def(x.id);
            if (!d || (s.snoozed[x.id] || 0) > now) continue;
            const yes = d.choices.find(c => c.value === x.value);
            out.push({ id: x.id, question: x.question, why: 'From what you did recently.',
                choices: [{ value: x.value, label: 'Yes' }, { value: null, label: 'No, keep it as is' }], learned: true, yes });
        }
        for (const d of [...this._defs.values()].sort((a, b) => (a.order || 50) - (b.order || 50))) {
            if (this.answered(d.id) || (s.snoozed[d.id] || 0) > now) continue;
            let ready = false;
            try { ready = !!(d.ready && d.ready()); } catch { ready = false; }
            if (ready) out.push({ id: d.id, question: d.question, why: d.why || '', choices: d.choices.map(c => ({ value: c.value, label: c.label })) });
        }
        return out.slice(0, 1);
    },

    /** A tap on a card: a choice, or (value null on a learned ask) a no. */
    answer(id, value) {
        if (value === null || value === undefined) { this.snooze(id, 60 * 86400000); return; }
        this.set(id, value);
    }
};

if (typeof module !== 'undefined') module.exports = PrefAsks;
