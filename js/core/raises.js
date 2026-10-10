/**
 * Raises — a card on Now is a RECORD (2026-10-06, docs/NOW.md).
 *
 * A raise is a question nenva is raising about one THING (a commitment, a
 * folder, a trip, an event, a job…), with a lifecycle of its own: open,
 * later (until a time), held (while the mailbox is being read), settled
 * (by the record, by a tap, or by the person's words in the thing's chat).
 * The deck on Now is the open raises; nothing on Now is recomputed from
 * scratch any more, and nothing the person did to a card lives in a
 * per-Mac side-table.
 *
 * Laws (docs/NOW.md R1–R7):
 *   R1 One thing, one raise. Keyed by the thing, never by the producer. A
 *      raiser that speaks FOR other things (a commitment made from a
 *      folder's step, a trip for its bookings, a folder for its messages)
 *      names them in `also`, and the reconciler drops those things' own
 *      raises.
 *   R2 A raise settles by the record (its raiser stopped raising it) or by
 *      the person (a tap, their words), never by the clock alone. Later is a
 *      state with an `until`.
 *   R3 A settled raise reopens only with a stated reason: every raise
 *      carries its raiser's `rev` (a hash of the facts the card is built
 *      from); while it holds, a settlement holds; when it changes, the raise
 *      reopens with a code-written line (`reopened.why`) and keeps its
 *      history.
 *   R5 Code keeps the facts: keys, revisions, states, history. What to
 *      raise and what it says is the raiser's (and inside it, the
 *      assistant's, vetted there).
 *   R6 Synced, record-merged (`raises` key: `raises` + `tombstones`; main
 *      merges per record by updatedAt). The phone sees the same Now.
 *   R7 History is kept per raise (capped) — the learning input and the
 *      evidence VISION's "Make attention useful" asks for.
 *
 * Pure parts (reconcile, settle, later, rev) are Node-testable:
 * tests/raises-test.js. The store half (register, refresh, the hooks) needs
 * the renderer.
 */
const Raises = {
    STORE_KEY: 'raises',
    VERSION: 1,
    KINDS: ['approval', 'decide', 'offer', 'headsup', 'checkin', 'question'],
    STATES: ['open', 'later', 'held', 'settled'],
    HOWS: ['done', 'ignore', 'later', 'answered', 'stop', 'gone'],
    BYS: ['you', 'chat', 'record'],
    HISTORY_MAX: 12,
    /** A settled raise nobody raises any more is forgotten after this long. */
    FORGET_MS: 30 * 86400000,
    REOPEN_LINE: 'New since you set this aside.',

    // ── Pure ────────────────────────────────────────────────────────────

    /** A stable hash of the facts a card is built from. */
    rev(facts) {
        const s = typeof facts === 'string' ? facts : JSON.stringify(facts, Object.keys(facts || {}).sort());
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
        return h.toString(36);
    },
    idFor(thing) { return `r:${thing}`; },
    blank() { return { version: this.VERSION, raises: [], tombstones: {} }; },

    /** The content fields a raiser may set on a card. Anything else is dropped. */
    CONTENT: ['kind', 'title', 'body', 'primary', 'choices', 'dismiss', 'source', 'talk', 'extra'],
    _content(c) {
        const out = {};
        for (const k of this.CONTENT) if (c && c[k] !== undefined) out[k] = c[k];
        if (!this.KINDS.includes(out.kind)) out.kind = 'headsup';
        out.title = String(out.title || '').slice(0, 200);
        out.body = String(out.body || '').slice(0, 2000);
        out.choices = Array.isArray(out.choices) ? out.choices.slice(0, 4).map(String) : [];
        return out;
    },

    /**
     * R1: one raise per thing. `produced` is what every raiser would raise
     * now ({thing, rev, producer, content, also?, held?, whatsNew?}); the
     * first raiser to name a thing wins (raisers are consulted in the order
     * they registered), and a thing another raise speaks for (`also`) gets
     * no raise of its own. Pure.
     */
    collapse(produced) {
        const byThing = new Map();
        for (const p of produced || []) {
            if (!p || !p.thing || byThing.has(p.thing)) continue;
            byThing.set(p.thing, p);
        }
        const covered = new Set();
        for (const p of byThing.values()) for (const t of p.also || []) if (t !== p.thing) covered.add(t);
        return [...byThing.values()].filter(p => !covered.has(p.thing));
    },

    /**
     * The one pass that keeps the store true to the raisers (docs/NOW.md
     * "The reconciler"). Pure: returns { state, changed, reopened[] }.
     */
    reconcile(state, produced, now = Date.now()) {
        const iso = new Date(now).toISOString();
        const s = state && Array.isArray(state.raises) ? state : this.blank();
        const next = { ...s, raises: [], tombstones: { ...(s.tombstones || {}) } };
        const live = this.collapse(produced);
        const byThing = new Map(s.raises.filter(r => r && r.thing).map(r => [r.thing, r]));
        let changed = false;
        const reopened = [];
        const push = (r, entry) => { r.history = [...(r.history || []), { at: iso, ...entry }].slice(-this.HISTORY_MAX); };

        for (const p of live) {
            const content = this._content(p.content);
            const rev = String(p.rev || this.rev(content));
            const held = !!p.held;
            let r = byThing.get(p.thing);
            byThing.delete(p.thing);
            if (!r) {
                r = { id: this.idFor(p.thing), thing: p.thing, producer: p.producer || null, rev, ...content,
                    state: held ? 'held' : 'open', raisedAt: iso, updatedAt: iso, history: [] };
                push(r, { how: 'raised', by: 'record', rev });
                next.raises.push(r);
                delete next.tombstones[r.id];
                changed = true;
                continue;
            }
            r = { ...r };
            let touched = false;
            const was = r.state;
            if (r.rev !== rev) {
                // R3: the facts moved. An open raise just updates; a raise
                // the person set aside comes back with the reason named.
                const aside = was === 'settled' || was === 'later';
                const byPerson = was === 'later' || (r.settled && r.settled.by !== 'record');
                Object.assign(r, content, { rev, producer: p.producer || r.producer });
                if (aside) {
                    r.state = held ? 'held' : 'open';
                    if (byPerson) {
                        r.reopened = { at: iso, why: [this.REOPEN_LINE, p.whatsNew].filter(Boolean).join(' ') };
                        reopened.push(r.thing);
                    } else delete r.reopened;
                    delete r.until;
                    push(r, { how: 'reopened', by: 'record', rev, quiet: !byPerson });
                } else push(r, { how: 'changed', by: 'record', rev });
                touched = true;
            } else {
                // Same facts: the words may still be fresher ("in 2 days").
                for (const k of this.CONTENT) {
                    if (JSON.stringify(r[k]) !== JSON.stringify(content[k])) { r[k] = content[k]; touched = true; }
                }
                if (r.state === 'later' && r.until && Date.parse(r.until) <= now) { r.state = 'open'; delete r.until; touched = true; push(r, { how: 'back', by: 'record' }); }
                // Settled by the RECORD means its raiser stopped raising it;
                // raised again, it is live again, same facts or not. Only the
                // person's settlement holds on the rev (R3). A pass that ran
                // before the stores loaded (a reload) settled every card and
                // they never came back (2026-10-08).
                if (r.state === 'settled' && r.settled && r.settled.by === 'record') {
                    r.state = held ? 'held' : 'open';
                    delete r.settled; delete r.reopened;
                    push(r, { how: 'reopened', by: 'record', rev, quiet: true });
                    touched = true;
                }
            }
            if (r.state === 'held' && !held) { r.state = 'open'; touched = true; }
            if (touched) { r.updatedAt = iso; changed = true; }
            next.raises.push(r);
        }

        // Raises nothing produces any more: an open one settles by the
        // record; a settled one is kept as history for a while, then forgotten.
        for (const r of byThing.values()) {
            if (r.state !== 'settled') {
                const g = { ...r, state: 'settled', settled: { how: 'gone', by: 'record', at: iso }, updatedAt: iso };
                delete g.until;
                push(g, { how: 'gone', by: 'record' });
                next.raises.push(g);
                changed = true;
            } else if (now - (Date.parse(r.updatedAt) || 0) > this.FORGET_MS) {
                next.tombstones[r.id] = iso;
                changed = true;
            } else next.raises.push(r);
        }
        return { state: next, changed, reopened };
    },

    /**
     * R2: the person (a tap or their words) or the record settles a raise.
     * `how` ∈ HOWS; `later` takes `until` (an ISO time or a ms duration).
     * Pure: returns the new state, or null when there is no such raise.
     */
    settle(state, thing, how, { by = 'you', quote = null, until = null, now = Date.now() } = {}) {
        if (!this.HOWS.includes(how) || !this.BYS.includes(by)) return null;
        const s = state && Array.isArray(state.raises) ? state : this.blank();
        const i = s.raises.findIndex(r => r && r.thing === thing);
        if (i < 0) return null;
        const iso = new Date(now).toISOString();
        const r = { ...s.raises[i] };
        if (r.state === 'settled' && how !== 'later') return null;
        r.history = [...(r.history || []), { at: iso, how, by, rev: r.rev, ...(quote ? { quote: String(quote).slice(0, 140) } : {}) }].slice(-this.HISTORY_MAX);
        delete r.reopened;
        if (how === 'later') {
            const t = typeof until === 'number' ? now + until : until ? Date.parse(until) : now + 4 * 3600000;
            r.state = 'later';
            r.until = new Date(isNaN(t) ? now + 4 * 3600000 : t).toISOString();
            delete r.settled;
        } else {
            r.state = 'settled';
            r.settled = { how, by, at: iso, ...(quote ? { quote: String(quote).slice(0, 140) } : {}) };
            delete r.until;
        }
        r.updatedAt = iso;
        const raises = s.raises.slice();
        raises[i] = r;
        return { ...s, raises };
    },

    /** Undo a settlement by the person: the raise is open again, the settlement stays in its history. Pure; null when there is none to undo. */
    unsettle(state, thing, now = Date.now()) {
        const s = state && Array.isArray(state.raises) ? state : this.blank();
        const i = s.raises.findIndex(r => r && r.thing === thing);
        if (i < 0) return null;
        const r = { ...s.raises[i] };
        if (r.state !== 'settled' && r.state !== 'later') return null;
        if (r.settled && r.settled.by === 'record') return null;
        const iso = new Date(now).toISOString();
        r.state = 'open';
        delete r.settled; delete r.until; delete r.reopened;
        r.history = [...(r.history || []), { at: iso, how: 'undone', by: 'you' }].slice(-this.HISTORY_MAX);
        r.updatedAt = iso;
        const raises = s.raises.slice(); raises[i] = r;
        return { ...s, raises };
    },

    /** The open raises (and ones due back), in store order. Pure. */
    openOf(state, now = Date.now()) {
        return ((state && state.raises) || []).filter(r => r && (r.state === 'open'
            || (r.state === 'later' && r.until && Date.parse(r.until) <= now)));
    },
    /** What the person did with raises of a kind lately — facts for a raiser's judge (R7). Pure. */
    recentSettlements(state, { producer = null, kind = null, limit = 8, now = Date.now(), days = 30 } = {}) {
        const since = now - days * 86400000;
        return ((state && state.raises) || [])
            .filter(r => r && r.settled && r.settled.by !== 'record' && (Date.parse(r.settled.at) || 0) >= since
                && (!producer || r.producer === producer) && (!kind || r.kind === kind))
            .sort((a, b) => Date.parse(b.settled.at) - Date.parse(a.settled.at)).slice(0, limit)
            .map(r => ({ thing: r.thing, title: r.title, how: r.settled.how, by: r.settled.by, at: r.settled.at }));
    },

    // ── Store (renderer) ────────────────────────────────────────────────

    _raisers: [],
    /**
     * A producer registers ONCE, like Widgets.register:
     *   Raises.register('matters', { raise(now) → [{thing, rev, content, also?, held?, whatsNew?}],
     *                                onSettle(raise, how, opts), onAct(raise, act) })
     * Order of registration is precedence when two raisers name one thing (R1).
     */
    register(id, def) {
        if (!id || !def || typeof def.raise !== 'function') return;
        this._raisers = this._raisers.filter(r => r.id !== id);
        this._raisers.push({ id, ...def });
    },
    raiserOf(raise) { return this._raisers.find(r => r.id === (raise && raise.producer)) || null; },

    _load() {
        if (this._data) return this._data;
        let d = null;
        try { d = typeof StorageManager !== 'undefined' ? StorageManager.get(this.STORE_KEY) : null; } catch { d = null; }
        this._data = d && typeof d === 'object' && Array.isArray(d.raises) ? d : this.blank();
        if (!this._data.tombstones) this._data.tombstones = {};
        return this._data;
    },
    _save(d) {
        this._data = d;
        try { if (typeof StorageManager !== 'undefined') StorageManager.set(this.STORE_KEY, d); } catch (e) { console.warn('[raises] save failed:', e); }
    },
    invalidate() { this._data = null; },
    all() { return this._load().raises.slice(); },
    get(thing) { return this._load().raises.find(r => r && r.thing === thing) || null; },
    open(now = Date.now()) { return this.openOf(this._load(), now); },

    /** Ask every raiser, reconcile, save when anything moved. Returns the open raises. */
    refresh(now = Date.now()) {
        const produced = [];
        for (const r of this._raisers) {
            try {
                for (const p of r.raise(now) || []) if (p && p.thing) produced.push({ ...p, producer: r.id });
            } catch (e) { console.warn(`[raises] ${r.id} failed:`, e && e.message); }
        }
        const out = this.reconcile(this._load(), produced, now);
        if (out.changed) this._save(out.state);
        return this.openOf(out.state, now);
    },

    /**
     * The person set a raise aside (a tap, or their words in its chat): the
     * record-side effect through the raiser's own hook, then the raise.
     * Returns the raise, or null.
     */
    settleThing(thing, how, { by = 'you', quote = null, until = null } = {}) {
        const r = this.get(thing);
        if (!r) return null;
        const raiser = this.raiserOf(r);
        if (raiser && typeof raiser.onSettle === 'function') {
            try { raiser.onSettle(r, how, { by, quote }); } catch (e) { console.warn(`[raises] ${raiser.id}.onSettle failed:`, e && e.message); }
        }
        const next = this.settle(this._load(), thing, how, { by, quote, until });
        if (next) this._save(next);
        return next ? this.get(thing) : null;
    },

    unsettleThing(thing) {
        const next = this.unsettle(this._load(), thing);
        if (next) this._save(next);
        return !!next;
    },

    /** A card's button other than setting it aside: the raiser's. */
    act(thing, act) {
        const r = this.get(thing);
        const raiser = r && this.raiserOf(r);
        if (!raiser || typeof raiser.onAct !== 'function') return false;
        try { raiser.onAct(r, act); return true; } catch (e) { console.warn(`[raises] ${raiser.id}.onAct failed:`, e && e.message); return false; }
    }
};

if (typeof module !== 'undefined') module.exports = Raises;
