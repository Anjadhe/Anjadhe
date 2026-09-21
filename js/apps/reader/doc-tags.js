/**
 * DocTags — tags on documents (the Documents app, 2026-09-02).
 *
 * The one way documents are ORGANIZED. A tag is a path: "Finance/Taxes/2025"
 * is the tag Finance › Taxes › 2025, and the app's nav draws every tag as
 * a tree built from those paths — a document tagged "Finance/Taxes/2025"
 * shows under Finance, under Taxes and under 2025. No folders to manage:
 * files stay wherever the import put them (V1 — the folder is the corpus)
 * and tags are the user's own vocabulary over them.
 *
 * Storage: `docTags` records in the synced `library` blob (StorageManager
 * key `library`, record-merged in main.js RECORD_MERGE_ARRAYS — ids +
 * updatedAt stamps + tombstones). Keyed by the document's index id, which
 * is a hash of its relpath — stable across Macs that share the folder
 * (iCloud/Dropbox), stable across re-indexes, lost on a rename (the file
 * is a new document then). `relpath` rides along so a dangling record can
 * be recognised and healed. Tags are user data and SYNC; the index they
 * point into is machine-local and rebuildable — the two never mix.
 *
 * Every write stamps `updatedAt` (record-merge law); every removal
 * tombstones (an untombstoned delete is resurrected by the next sync).
 */
const DocTags = {
    KEY: 'library',
    SEP: '/',
    MAX_TAGS: 30,

    _load() {
        const d = StorageManager.get(this.KEY) || {};
        return {
            ...d,
            docTags: Array.isArray(d.docTags) ? d.docTags : [],
            tombstones: (d.tombstones && typeof d.tombstones === 'object') ? d.tombstones : {}
        };
    },

    _save(data) { StorageManager.set(this.KEY, data); },

    _stamp(prev) {
        return new Date(Math.max(Date.now(), (Date.parse(prev || '') || 0) + 1)).toISOString();
    },

    /**
     * Normalize one tag path: trim each segment, drop empties, collapse
     * separators — "  finance / taxes//2025 " → "finance/taxes/2025".
     * Case is kept as typed; matching is case-insensitive.
     */
    normalize(tag) {
        return String(tag || '')
            .split(this.SEP)
            .map(s => s.trim().replace(/\s+/g, ' '))
            .filter(Boolean)
            .join(this.SEP)
            .slice(0, 120);
    },

    _key(tag) { return this.normalize(tag).toLowerCase(); },

    /** Tags of one document (normalized, in the order they were added). */
    get(docId) {
        const rec = this._load().docTags.find(r => r.id === docId);
        return rec ? (rec.tags || []).map(t => this.normalize(t)).filter(Boolean) : [];
    },

    /** Every document's tags: Map<docId, string[]>. */
    all() {
        const out = new Map();
        for (const r of this._load().docTags) {
            const tags = (r.tags || []).map(t => this.normalize(t)).filter(Boolean);
            if (tags.length) out.set(r.id, tags);
        }
        return out;
    },

    /** Replace a document's tag list. Empty list = untagged (record kept
     *  with its relpath so a later add doesn't need it again). */
    set(docId, tags, relpath) {
        if (!docId) return false;
        const seen = new Set();
        const clean = [];
        for (const t of (tags || [])) {
            const n = this.normalize(t);
            if (!n || seen.has(n.toLowerCase())) continue;
            seen.add(n.toLowerCase());
            clean.push(n);
            if (clean.length >= this.MAX_TAGS) break;
        }
        const data = this._load();
        let rec = data.docTags.find(r => r.id === docId);
        if (!rec) {
            rec = { id: docId, relpath: relpath || '', tags: [], createdAt: new Date().toISOString() };
            data.docTags.push(rec);
        }
        if (relpath) rec.relpath = relpath;
        rec.tags = clean;
        rec.updatedAt = this._stamp(rec.updatedAt);
        this._save(data);
        return true;
    },

    add(docId, tag, relpath) {
        const cur = this.get(docId);
        const n = this.normalize(tag);
        if (!n || cur.some(t => t.toLowerCase() === n.toLowerCase())) return false;
        return this.set(docId, [...cur, n], relpath);
    },

    remove(docId, tag) {
        const k = this._key(tag);
        const cur = this.get(docId);
        const next = cur.filter(t => t.toLowerCase() !== k);
        if (next.length === cur.length) return false;
        return this.set(docId, next);
    },

    /** Does `tag` sit under `parent` (or equal it)? Case-insensitive. */
    under(tag, parent) {
        const t = this._key(tag), p = this._key(parent);
        return !!p && (t === p || t.startsWith(p + this.SEP));
    },

    /** Ids of every document carrying `tag` or a descendant of it. */
    docsWithTag(tag) {
        const out = [];
        for (const [id, tags] of this.all()) {
            if (tags.some(t => this.under(t, tag))) out.push(id);
        }
        return out;
    },

    /** Rename a tag path everywhere (children move with it). */
    rename(from, to) {
        const f = this._key(from), t = this.normalize(to);
        if (!f || !t) return 0;
        const data = this._load();
        let changed = 0;
        for (const r of data.docTags) {
            const tags = (r.tags || []).map(x => this.normalize(x));
            const next = tags.map(x => {
                const k = x.toLowerCase();
                if (k === f) return t;
                if (k.startsWith(f + this.SEP)) return t + x.slice(f.length);
                return x;
            });
            if (next.join('\u0000') !== tags.join('\u0000')) {
                r.tags = [...new Set(next)];
                r.updatedAt = this._stamp(r.updatedAt);
                changed++;
            }
        }
        if (changed) this._save(data);
        return changed;
    },

    /**
     * Every distinct tag path plus every ancestor path implied by it
     * ("a/b/c" implies "a" and "a/b"), with document counts that include
     * descendants — the numbers the tree shows.
     */
    counts() {
        const counts = new Map();   // key -> { tag, count }
        for (const [, tags] of this.all()) {
            const touched = new Set();
            for (const t of tags) {
                const parts = t.split(this.SEP);
                for (let i = 1; i <= parts.length; i++) {
                    const p = parts.slice(0, i).join(this.SEP);
                    touched.add(p);
                }
            }
            for (const p of touched) {
                const k = p.toLowerCase();
                const cur = counts.get(k) || { tag: p, count: 0 };
                cur.count++;
                counts.set(k, cur);
            }
        }
        return counts;
    },

    /** All tag paths (ancestors included), sorted, for the picker. */
    allTagNames() {
        return [...this.counts().values()].map(c => c.tag)
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    },

    /**
     * The tag tree: [{ tag, name, depth, count, children: [...] }], sorted
     * by name at every level. `tag` is the full path, `name` the last
     * segment.
     */
    tree() {
        const counts = this.counts();
        const root = { children: new Map() };
        for (const { tag, count } of counts.values()) {
            const parts = tag.split(this.SEP);
            let node = root;
            for (let i = 0; i < parts.length; i++) {
                const key = parts[i].toLowerCase();
                if (!node.children.has(key)) {
                    node.children.set(key, { tag: parts.slice(0, i + 1).join(this.SEP), name: parts[i], depth: i, count: 0, children: new Map() });
                }
                node = node.children.get(key);
            }
            node.count = count;
        }
        const finish = (n) => {
            const kids = [...n.children.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
            return kids.map(k => ({ ...k, children: finish(k) }));
        };
        return finish(root);
    },

    /**
     * Forget one document's tags — called when the user deletes the
     * document through the app (Remove → Trash). NOT run on listing
     * refreshes: the folder is not synced by the app, so a Mac that lacks
     * a file must not tombstone the tags another Mac put on it; a dangling
     * record is harmless and never shown. Tombstoned so the removal
     * survives the record-union merge; a later re-add of the same path
     * writes a newer stamp and wins.
     */
    forget(docId) {
        const data = this._load();
        const rec = data.docTags.find(r => r.id === docId);
        if (!rec) return false;
        data.docTags = data.docTags.filter(r => r.id !== docId);
        // The tombstone must be NEWER than the record's own updatedAt, or
        // the record merge ("an edit newer than the tombstone beats the
        // delete") resurrects it. _stamp pushes every edit at least 1 ms
        // past the previous stamp, so a tag-rename-delete inside one
        // millisecond left updatedAt ahead of a raw-clock tombstone
        // (2026-09-11: the eval's "gone" check, blamed on leftovers the
        // day before).
        data.tombstones[docId] = this._stamp(rec.updatedAt);
        this._save(data);
        return true;
    }
};
