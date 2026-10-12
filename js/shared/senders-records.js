'use strict';
// Shared validated record operations. Hosts supply only load/save and post-commit effects.
const SenderRecords = Object.freeze({
    ALL_GOOD_MAX: 200,
    FACTS_MAX: 40,
    NAME_MAX: 40,
    _clean(s, max) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max); },
    _norm(s) { return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); },
    _id(name, now = Date.now()) {
        const slug = this._norm(name).replace(/ /g, '-').slice(0, 24) || 'thing';
        return `sender:${slug}-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    },
    /** Start a sender by name ("start keeping track of Maya's music classes"). */
    create(name, allGood = '', { by = 'you', now = Date.now() } = {}) {
        name = this._clean(name, this.NAME_MAX);
        if (!name) return null;
        const d = this._load();
        const same = Object.values(d.senders).find(s => s.state !== 'archived' && this._norm(s.name) === this._norm(name));
        if (same) return same;
        const iso = new Date(now).toISOString();
        const id = this._id(name, now);
        d.senders[id] = { id, name, allGood: this._clean(allGood, this.ALL_GOOD_MAX), state: 'active', confirmed: by === 'you', by, createdAt: iso, updatedAt: iso };
        this._save();
        return d.senders[id];
    },
    _edit(id, fn) {
        const d = this._load();
        const s = d.senders[this.resolve(d, id)];
        if (!s) return null;
        const before = JSON.parse(JSON.stringify(s));
        fn(s);
        s.updatedAt = new Date().toISOString();
        this._save();
        return { sender: s, before };
    },
    confirm(id) { return this._edit(id, s => { s.confirmed = true; }); },
    rename(id, name) {
        name = this._clean(name, this.NAME_MAX);
        return name ? this._edit(id, s => { s.name = name; s.confirmed = true; }) : null;
    },
    setAllGood(id, sentence) { return this._edit(id, s => { s.allGood = this._clean(sentence, this.ALL_GOOD_MAX); }); },
    archive(id) { return this._edit(id, s => { s.state = 'archived'; s.archivedAt = new Date().toISOString(); }); },
    unarchive(id) { return this._edit(id, s => { s.state = 'active'; delete s.archivedAt; }); },
    /** Put a thing in a sender on the person's word; never re-judged after. Returns the previous placement (for Undo). */
    move(key, senderId, { by = 'you' } = {}) {
        const d = this._load();
        const id = this.resolve(d, senderId);
        if (!d.senders[id]) return null;
        const before = d.place[key] ? { ...d.place[key] } : null;
        d.place[key] = { sender: id, by, at: new Date().toISOString() };
        d.senders[id].updatedAt = d.place[key].at;
        d.senders[id].confirmed = true;
        this._save();
        return { before };
    },
    unmove(key, before) {
        const d = this._load();
        if (before) d.place[key] = before; else delete d.place[key];
        this._save();
    },
    /** Two senders that are one thing: `fromId` folds into `intoId`, its id stays an alias (S5, S7). */
    fold(fromId, intoId) {
        const d = this._load();
        const from = this.resolve(d, fromId), into = this.resolve(d, intoId);
        if (from === into || !d.senders[from] || !d.senders[into]) return null;
        const gone = d.senders[from];
        d.aliases[from] = into;
        delete d.senders[from];
        d.senders[into].updatedAt = new Date().toISOString();
        d.senders[into].confirmed = true;
        d.folded = d.folded || {};
        d.folded[from] = { sender: gone, into, at: d.senders[into].updatedAt };
        // What the person told nenva about it goes with it (M5); unfold takes those back.
        if ((gone.links || []).length) d.senders[into].links = [...(d.senders[into].links || []), ...gone.links.filter(l => !(d.senders[into].links || []).some(x => x.kind === l.kind && x.ref === l.ref)).map(l => ({ ...l, foldedFrom: from }))];
        if ((gone.facts || []).length) d.senders[into].facts = [...(d.senders[into].facts || []), ...gone.facts.map(f => ({ ...f, foldedFrom: from }))].slice(-this.FACTS_MAX);
        this._save();
        return { gone };
    },
    unfold(fromId) {
        const d = this._load();
        const rec = d.folded && d.folded[fromId];
        if (!rec) return false;
        d.senders[fromId] = rec.sender;
        const into = d.senders[rec.into];
        if (into && into.facts) into.facts = into.facts.filter(f => f.foldedFrom !== fromId);
        if (into && into.links) into.links = into.links.filter(l => l.foldedFrom !== fromId);
        delete d.aliases[fromId];
        delete d.folded[fromId];
        this._save();
        return true;
    },
});
if (typeof module !== 'undefined' && module.exports) module.exports = SenderRecords;
