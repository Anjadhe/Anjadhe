/**
 * Pins (2026-10-09, by request): the person pins a commitment (a project, a
 * fitness log, a habit) and it is listed on the Pinned page in the left nav.
 * A pin is ONLY a stored reference, a shortcut: tapping it opens the
 * commitment's own page. No summary card, no view of its own to maintain.
 *
 * Stored as `pinned` = { items: [{ kind: 'commitment', id, at }] }, newest
 * pin first. A pin whose commitment is gone is skipped on read and dropped
 * on the next write; nothing else has to remember to unpin.
 */
const Pins = {
    KEY: 'pinned',

    _load() {
        let d = null;
        try { d = typeof StorageManager !== 'undefined' ? StorageManager.get(this.KEY) : null; } catch { /* optional */ }
        return { items: Array.isArray(d && d.items) ? d.items.filter(x => x && x.kind === 'commitment' && x.id) : [] };
    },

    /** Pins whose commitment still exists, newest first: [{ id, at, c }]. */
    list() {
        if (typeof Commitments === 'undefined' || !Commitments._inited) return [];
        return this._load().items.map(x => ({ id: x.id, at: x.at, c: Commitments.get(x.id) })).filter(x => x.c);
    },

    has(id) { return this._load().items.some(x => x.id === id); },

    /** Pin or unpin one commitment. Returns { ok, pinned } or { ok:false, error }. */
    set(id, pinned) {
        id = String(id || '');
        if (pinned && (typeof Commitments === 'undefined' || !Commitments.get(id))) return { ok: false, error: `No commitment with id "${id}".` };
        const live = id => typeof Commitments === 'undefined' || !!Commitments.get(id);
        const items = this._load().items.filter(x => x.id !== id && live(x.id));
        if (pinned) items.unshift({ kind: 'commitment', id, at: new Date().toISOString() });
        StorageManager.set(this.KEY, { items });
        // The Pinned page, if it is open, shows the change (the assistant may pin from a chat).
        if (typeof SimpleSettings !== 'undefined' && SimpleSettings._page === 'pinned' && typeof AppManager !== 'undefined' && AppManager.currentApp === 'simplesettings') SimpleSettings.render();
        return { ok: true, pinned: !!pinned };
    },

    toggle(id) { return this.set(id, !this.has(id)); }
};

if (typeof module !== 'undefined') module.exports = { Pins };
