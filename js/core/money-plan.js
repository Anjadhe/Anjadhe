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
 *
 * Since 2026-10-09 (docs/COACH.md, a money goal's amount becomes its aim):
 * the commitment carries `domain: 'money'` and `aim: { measure: 'saved',
 * target: amount, unit: '$' }` (syncAim), and the saved amount the accounts
 * report is kept once a day in `history` and offered to Commitments as a
 * measure source, so a money goal's progress block, chart and look-back are
 * the same as any goal's. This store keeps only which accounts count and a
 * figure the person gave when no account holds it.
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
    /**
     * The commitment's side of a money goal: its area and its aim, from the
     * amount the person gave (a fact, so code writes it; a no-op when equal).
     */
    syncAim(id) {
        const g = this.get(id);
        const C = typeof Commitments !== 'undefined' && Commitments._inited ? Commitments : null;
        if (!g || !C || !C.get(id)) return false;
        this._register();
        const c = C.get(id);
        const aim = { measure: 'saved', target: Math.round(g.amount), unit: '$', dir: 'up' };
        const want = { ...(c.domain ? {} : { domain: 'money' }), ...(c.aim && c.aim.measure === 'saved' && c.aim.target === aim.target ? {} : { aim }) };
        if (!Object.keys(want).length) return false;
        return !!C.change(id, want, { by: 'app', why: 'money goal amount' }).ok;
    },
    syncAims() { let n = 0; for (const g of this.goals()) if (this.syncAim(g.id)) n++; return n; },
    /**
     * The saved amount on a day (from the accounts, or the person's figure).
     * One point a day, refreshed at most hourly and only on a real change,
     * so a price tick does not write the store every few minutes.
     */
    HISTORY_MAX: 400,
    observe(id, saved, day, nowMs = Date.now()) {
        if (saved == null || !Number.isFinite(Number(saved)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return false;
        const d = this._load();
        const g = d.goals.find(x => x.id === id);
        if (!g) return false;
        const h = Array.isArray(g.history) ? g.history : (g.history = []);
        const last = h[h.length - 1];
        const v = Math.round(Number(saved));
        if (last && last.day === day) {
            if (Math.abs(last.saved - v) < 1 || nowMs - (Date.parse(last.at || '') || 0) < 3600000) return false;
            last.saved = v; last.at = new Date(nowMs).toISOString();
        } else h.push({ day, saved: v, at: new Date(nowMs).toISOString() });
        if (h.length > this.HISTORY_MAX) g.history = h.slice(-this.HISTORY_MAX);
        StorageManager.set(this.KEY, d);
        return true;
    },
    /** The goal's saved amount over time, for Commitments.series. Pure over the store. */
    points(id) { const g = this.get(id); return (g && Array.isArray(g.history) ? g.history : []).map(x => ({ day: x.day, value: x.saved })); },
    _register() {
        if (this._registered || typeof Commitments === 'undefined' || !Commitments.addMeasureSource) return;
        this._registered = true;
        Commitments.addMeasureSource((c, name) => name === 'saved' && this.get(c.id) ? this.points(c.id) : []);
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
