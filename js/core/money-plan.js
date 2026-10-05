/**
 * MoneyPlan — the money side of a goal (docs/MONEY_COACH.md "The household
 * plan"). A money goal IS a commitment (docs/COMMITMENTS.md: one store for
 * everything the person said they would do): its title, its date (`by`) and
 * whether it is still open live there. This keeps only what a commitment
 * has no field for: the amount, which accounts hold the money, and an
 * amount the person told us when no account is recorded.
 *
 * Stored in the `money-plan` key: { goals: [{ id (the commitment's id),
 * amount, accounts: [names], saved, title, by, createdAt, updatedAt }] }.
 * `title` and `by` are a copy for a build without Commitments; the live
 * commitment wins. Progress is arithmetic (progress(), pure), never written
 * by a model. A savings target or a debt order is a Memory sentence (MC6).
 */
const MoneyPlan = {
    KEY: 'money-plan',
    _load() {
        let d = null;
        try { d = typeof StorageManager !== 'undefined' ? StorageManager.get(this.KEY) : null; } catch { d = null; }
        return d && Array.isArray(d.goals) ? d : { goals: [] };
    },
    goals() { return this._load().goals; },
    get(id) { return this.goals().find(g => g.id === id) || null; },

    /** Add or change a goal's money facts. Returns the stored record, or { error }. */
    save(input) {
        const amount = Number(input && input.amount);
        if (!input || !input.id) return { error: 'A money goal needs the commitment it belongs to.' };
        if (!(amount > 0)) return { error: 'A money goal needs an amount above zero.' };
        const d = this._load();
        const now = new Date().toISOString();
        let g = d.goals.find(x => x.id === input.id);
        if (!g) { g = { id: String(input.id), createdAt: now }; d.goals.push(g); }
        g.amount = Math.round(amount * 100) / 100;
        if (input.accounts !== undefined) g.accounts = [...new Set((input.accounts || []).map(a => String(a).trim()).filter(Boolean))].slice(0, 12);
        if (input.saved !== undefined) g.saved = input.saved == null || !(Number(input.saved) >= 0) ? null : Number(input.saved);
        if (input.title) g.title = String(input.title).slice(0, 200);
        if (input.by !== undefined) g.by = /^\d{4}-\d{2}-\d{2}$/.test(String(input.by || '')) ? input.by : null;
        g.updatedAt = now;
        StorageManager.set(this.KEY, d);
        return g;
    },
    remove(id) {
        const d = this._load();
        const n = d.goals.length;
        d.goals = d.goals.filter(g => g.id !== id);
        if (d.goals.length !== n) StorageManager.set(this.KEY, d);
        return d.goals.length !== n;
    },

    /**
     * Where a goal stands. `accounts` is every account the app knows with
     * its value ([{name, value}]); `today` is YYYY-MM-DD. Pure.
     */
    progress(goal, accounts, today) {
        const names = (goal.accounts || []).map(a => a.toLowerCase());
        const held = (accounts || []).filter(a => names.includes(String(a.name || '').toLowerCase()));
        const saved = held.length ? held.reduce((t, a) => t + (Number(a.value) || 0), 0) : (goal.saved != null ? Number(goal.saved) : null);
        const out = { id: goal.id, title: goal.title || 'A goal', target: Math.round(goal.amount), ...(goal.by ? { by: goal.by } : {}) };
        if (names.length) out.accounts = held.map(a => a.name);
        if (names.length && held.length < names.length) out.accountsNotFound = (goal.accounts || []).filter(a => !held.some(h => h.name.toLowerCase() === a.toLowerCase()));
        if (saved == null) return out;
        out.saved = Math.round(saved);
        out.pct = Math.round((saved / goal.amount) * 1000) / 10;
        out.left = Math.max(0, Math.round(goal.amount - saved));
        if (goal.by && today) {
            const [y1, m1, d1] = today.split('-').map(Number), [y2, m2, d2] = goal.by.split('-').map(Number);
            const months = (y2 - y1) * 12 + (m2 - m1) + (d2 >= d1 ? 0 : -1);
            out.monthsLeft = months;
            if (months > 0 && out.left > 0) out.perMonthNeeded = Math.round(out.left / months);
        }
        return out;
    }
};

if (typeof module !== 'undefined') module.exports = MoneyPlan;
