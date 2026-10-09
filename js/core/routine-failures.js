/**
 * RoutineFailures — failures are quiet (docs/ROUTINES_UX.md I7, step 2,
 * 2026-10-09).
 *
 * A routine's failed runs no longer post "This run didn't finish" into its
 * chat or raise a card on Now each time. The engine keeps, per routine, its
 * failures since its last good run (`promptFeed.fails[id] = { since, last,
 * count, error, cause }`, RoutineEngine.noteFailure / clearFailure), and
 * this module decides, from those facts, what Now shows:
 *
 *   - one failure: nothing (the routine's detail has its "Last problem");
 *   - a routine that keeps failing (STUCK): one card for that routine;
 *   - when the MODEL is the cause (unreachable, out of allowance), one card
 *     for every routine it stopped, pointing at the model, never one per
 *     routine.
 *
 * The cause is a fact about the error (the transport said the server is
 * unreachable, the cloud said the allowance is spent), not a judgment.
 * Pure: tests/routine-failures-test.js.
 */
const RoutineFailures = {
    STUCK_COUNT: 3,
    STUCK_PAIR_MS: 20 * 3600000,
    /** The model could not answer: unreachable, overloaded, out of allowance, nothing selected. */
    MODEL_RX: /allowance|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|ENETUNREACH|not running|no server|still loading|loading the model|overloaded|No response from model|model unavailable|Local model unavailable|No model|network|\b5\d\d\b/i,

    causeOf(error) { return this.MODEL_RX.test(String(error || '')) ? 'model' : 'routine'; },

    /** One routine's record after another failure. Pure. */
    next(prev, error, nowMs) {
        const iso = new Date(nowMs).toISOString();
        const p = prev && typeof prev === 'object' ? prev : null;
        return { since: (p && p.since) || iso, last: iso, count: ((p && p.count) || 0) + 1,
            error: String(error || 'Run failed').slice(0, 200), cause: this.causeOf(error) };
    },

    /** Has this routine been failing long enough to tell the person? Pure. */
    stuck(f, nowMs) {
        if (!f || !f.count) return false;
        if (f.count >= this.STUCK_COUNT) return true;
        return f.count >= 2 && nowMs - (Date.parse(f.since) || nowMs) >= this.STUCK_PAIR_MS;
    },

    _day(iso) {
        const d = new Date(iso);
        return isNaN(d) ? '' : d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    },

    /**
     * The cards Now shows for failures. Pure. `fails` is the engine's map,
     * `titleOf(id)` a routine's title (null when it is gone). Returns
     * [{ thing, kind, title, body, primary, routineId?, model?, facts }].
     */
    cards(fails, titleOf, nowMs) {
        const live = Object.entries(fails || {}).filter(([id, f]) => f && f.count && titleOf(id));
        const out = [];
        const model = live.filter(([, f]) => f.cause === 'model');
        const total = model.reduce((t, [, f]) => t + f.count, 0);
        if (model.length && (model.some(([, f]) => this.stuck(f, nowMs)) || total >= this.STUCK_COUNT)) {
            const since = model.map(([, f]) => f.since).sort()[0];
            const newest = model.slice().sort((a, b) => String(b[1].last).localeCompare(String(a[1].last)))[0][1];
            const names = model.map(([id]) => titleOf(id));
            const who = names.length === 1 ? `“${names[0]}” hasn’t` : `${names.length} routines haven’t`;
            out.push({ thing: 'routines:model', kind: 'decide', model: true,
                title: names.length === 1 ? `“${names[0]}” can’t reach the model` : 'Your routines can’t reach the model',
                body: `${who} run since ${this._day(since)}. ${newest.error}`,
                primary: 'Check the model', facts: { since, routines: model.map(([id]) => id).sort() } });
        }
        for (const [id, f] of live) {
            if (f.cause === 'model' || !this.stuck(f, nowMs)) continue;
            out.push({ thing: `routine:${id}`, kind: 'decide', routineId: id,
                title: `“${titleOf(id)}” keeps failing`,
                body: `It hasn’t finished since ${this._day(f.since)}. ${f.error}`,
                primary: 'Open the routine', facts: { since: f.since, cause: f.cause } });
        }
        return out;
    }
};

if (typeof module !== 'undefined') module.exports = RoutineFailures;
