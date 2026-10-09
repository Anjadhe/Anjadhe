/**
 * Apple Notes as an INDEX source (2026-10-06, docs/VISION.md "Sources").
 *
 * Ram: "index only is fine, we don't have to replicate the data here." The
 * person's notes stay in Apple Notes; nenva reads them on this Mac and
 * indexes their text as VIRTUAL documents in the library index
 * (LibraryStore.upsertVirtual: searchable by the assistant through
 * search_library / read_library_doc, never listed as a document, never a
 * file in the library folder). A note that changes is re-indexed; a note
 * deleted in Apple Notes leaves the index on the next read. Turning the
 * source off removes every indexed note at once.
 *
 * This replaces the Apple Notes IMPORT (AppleImport.importNotes, which
 * copied notes into the notes blob): that import no longer runs at startup
 * and its card is a Developer-only leftover; notes it already brought in
 * stay, as text documents (nothing removes anyone's notes on its own).
 *
 * Per-Mac (localStorage), ONE Mac, like the import was: Apple Notes has no
 * stable cross-Mac id. Reads the Mac's own Notes through the JXA bridge
 * (electronAppleImport.notesMeta / notesBodies); locked notes are skipped.
 */
const AppleNotesSource = {
    ID: 'applenotes',
    SOURCE: 'Apple Notes',
    ENABLED_KEY: 'source-apple-notes',
    STATE_KEY: 'source-apple-notes-state',
    BATCH: 25,
    EVERY_MS: 30 * 60000,
    _busy: false,

    enabled() { try { return localStorage.getItem(this.ENABLED_KEY) === '1'; } catch { return false; } },
    state() { try { return JSON.parse(localStorage.getItem(this.STATE_KEY) || '{}'); } catch { return {}; } },
    _save(patch) { try { localStorage.setItem(this.STATE_KEY, JSON.stringify({ ...this.state(), ...patch })); } catch { /* per-Mac */ } },

    async setEnabled(on) {
        try { if (on) localStorage.setItem(this.ENABLED_KEY, '1'); else localStorage.removeItem(this.ENABLED_KEY); } catch { /* per-Mac */ }
        if (on) return this.sync('switch');
        // Off: the index forgets every note (the notes themselves are untouched).
        let removed = 0;
        try { removed = (await window.electronLibrary.virtualRemove(this.SOURCE, [])).removed || 0; } catch { /* nothing indexed */ }
        this._save({ seen: {}, lastAt: null, lastError: null, counts: null });
        return { ok: true, removed };
    },

    /** HTML from Notes' body() to the plain text the index holds. */
    toText(html) {
        try {
            const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
            doc.querySelectorAll('br').forEach(b => b.replaceWith('\n'));
            doc.querySelectorAll('div, p, li, h1, h2, h3, h4, tr').forEach(el => el.append('\n'));
            return (doc.body.textContent || '').replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        } catch { return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
    },

    /**
     * One read: the metadata sweep (cheap), bodies only for notes that are
     * new or changed since this Mac last read them, each indexed; notes gone
     * from Apple Notes leave the index.
     */
    async sync(reason = '') {
        if (this._busy || !this.enabled() || !window.electronAppleImport?.notesMeta || !window.electronLibrary?.virtualUpsert) return { ok: false, reason: 'unavailable' };
        this._busy = true;
        try {
            const meta = await window.electronAppleImport.notesMeta();
            if (meta.error) { this._save({ lastError: meta.message || meta.error }); return { ok: false, error: meta.message || meta.error }; }
            const rows = (meta.notes || []).filter(r => r && r.id && !r.locked);
            const seen = this.state().seen || {};
            const changed = rows.filter(r => seen[r.id] !== (r.modified || ''));
            let indexed = 0, failed = 0;
            for (let i = 0; i < changed.length; i += this.BATCH) {
                const batch = changed.slice(i, i + this.BATCH);
                const r = await window.electronAppleImport.notesBodies(batch.map(x => x.id));
                if (r.error) { this._save({ lastError: r.message || r.error }); return { ok: false, error: r.message || r.error }; }
                for (const row of batch) {
                    const text = this.toText((r.bodies || {})[row.id]);
                    const title = String(row.title || text.split('\n')[0] || 'Untitled').slice(0, 200);
                    const body = `${title}\n\n${text}`;
                    const out = await window.electronLibrary.virtualUpsert({ source: this.SOURCE, sourceId: row.id, title, text: body, modifiedAt: row.modified || null, collection: this.SOURCE });
                    if (out && !out.error) { seen[row.id] = row.modified || ''; indexed++; } else failed++;
                }
            }
            const keep = rows.map(r => r.id);
            let removed = 0;
            try { removed = (await window.electronLibrary.virtualRemove(this.SOURCE, keep)).removed || 0; } catch { /* next time */ }
            for (const id of Object.keys(seen)) if (!keep.includes(id)) delete seen[id];
            const counts = { notes: rows.length, indexed, removed, failed, locked: (meta.notes || []).filter(r => r && r.locked).length };
            this._save({ seen, lastAt: new Date().toISOString(), lastError: null, counts });
            if (reason !== 'startup') console.log(`[apple-notes] ${reason}: ${rows.length} notes, ${indexed} indexed, ${removed} removed`);
            return { ok: true, ...counts };
        } catch (e) {
            this._save({ lastError: e && e.message || String(e) });
            return { ok: false, error: e && e.message };
        } finally { this._busy = false; }
    },

    init() {
        if (this._inited) return;
        this._inited = true;
        if (typeof Sources !== 'undefined') {
            Sources.register({
                id: this.ID, label: 'Apple Notes', icon: 'note', iconAsset: 'apple-notes.png', words: 'icloud notes apple', kind: 'notes', mode: 'mirror',
                reads: 'Your notes in Apple Notes, read on this Mac and indexed so the assistant can find and quote them. Nothing is copied into nenva; there is no notes list here.',
                privacy: 'notes', feeds: ['index'],
                status: () => {
                    if (!window.electronAppleImport?.notesMeta) return { on: false, value: 'Not available' };
                    const on = this.enabled(), st = this.state();
                    return { on, error: !!(on && st.lastError), value: on ? (st.lastError ? 'Needs attention' : st.counts ? `${st.counts.notes} notes` : 'On') : 'Off', detail: st.lastAt ? `Last read ${new Date(st.lastAt).toLocaleString()}` : '' };
                },
                page: (S, c) => S._appleNotesHtml(c)
            });
        }
        if (this.enabled()) {
            setTimeout(() => this.sync('startup').catch(() => {}), 20000);
            setInterval(() => this.sync('timer').catch(() => {}), this.EVERY_MS);
        }
    }
};

if (typeof module !== 'undefined') module.exports = AppleNotesSource;
