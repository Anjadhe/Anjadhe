/**
 * NoteTags — the tags the assistant may put on a note it writes (2026-10-07).
 *
 * Ram: "let it use existing tags first and then if it could not find an
 * existing tag to associate, it should come up with only one tag that
 * describes the content best... otherwise it becomes noisy."
 *
 * The assistant judges which tags fit; code keeps the shape:
 *   NT1 existing() is every tag the person has — the tag library plus every
 *       tag on a note — one spelling each (first seen wins, case-insensitive).
 *   NT2 resolve(): a proposed tag that names an existing one is kept in the
 *       existing spelling. When at least one does, the invented ones are
 *       dropped. When none does, exactly ONE new tag is kept (the first) and
 *       the rest are dropped.
 *   NT3 The result names what was dropped, so the assistant can say so.
 *
 * Pure; pinned by tests/note-tags-test.js. The create_note tool lists
 * existing() in its schema and runs resolve() on what the model sent.
 */
const NoteTags = {
    /** Trim and fold a tag for comparison; '' when there is nothing to keep. */
    key(tag) {
        return String(tag == null ? '' : tag).trim().replace(/^#/, '').toLowerCase();
    },

    /**
     * NT1 — every tag the person has, in the spelling they use.
     * @param {{tags?: {tags?: {name:string}[]}, notes?: {notes?: {tags?: string[]}[]}}} stores
     *   the `tags` and `notes` blobs as StorageManager hands them out.
     */
    existing({ tags, notes } = {}) {
        const seen = new Map();
        const take = (t) => {
            const name = String(t == null ? '' : t).trim().replace(/^#/, '');
            const k = name.toLowerCase();
            if (!k || seen.has(k)) return;
            seen.set(k, name);
        };
        for (const t of (tags && Array.isArray(tags.tags)) ? tags.tags : []) take(t && t.name);
        for (const n of (notes && Array.isArray(notes.notes)) ? notes.notes : []) {
            for (const t of (n && Array.isArray(n.tags)) ? n.tags : []) take(t);
        }
        return Array.from(seen.values());
    },

    /**
     * NT2/NT3 — what a new note gets from what the model proposed.
     * @returns {{tags: string[], dropped: string[]}}
     */
    resolve(proposed, existing) {
        const byKey = new Map();
        for (const e of Array.isArray(existing) ? existing : []) {
            const k = this.key(e);
            if (k && !byKey.has(k)) byKey.set(k, String(e).trim().replace(/^#/, ''));
        }
        const matched = [], fresh = [];
        const used = new Set();
        for (const p of Array.isArray(proposed) ? proposed : []) {
            const k = this.key(p);
            if (!k || used.has(k)) continue;
            used.add(k);
            if (byKey.has(k)) matched.push(byKey.get(k));
            else fresh.push(String(p).trim().replace(/^#/, ''));
        }
        if (matched.length) return { tags: matched, dropped: fresh };
        return { tags: fresh.slice(0, 1), dropped: fresh.slice(1) };
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = NoteTags;
if (typeof globalThis !== 'undefined') globalThis.NoteTags = NoteTags;
