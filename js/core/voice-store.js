/**
 * VoiceStore — the user's own writing voice (docs/LIBRARY.md L2).
 *
 * ONE voice per user, "My voice" (2026-09-02 — custom voices built from
 * other people's writing were removed, and the Writing Voices APP went
 * with them: the voice is a Settings feature now, Settings › Writing
 * voice, and drafting in it is something the assistant does when asked).
 * The record carries `self: true`, a `sources` map ({documents, notes,
 * journal, emails} booleans) naming what its study reads, an editable
 * style guide (`body`) and exemplar passages. Uploaded documents ride the
 * voice's Library folder (`collection` — the folder born with the voice,
 * never renamed after birth, so no relpath churns); notes/journal/sent
 * emails are sampled live from their own stores at study time (nothing is
 * copied into the folder).
 *
 * Two record kinds, one synced blob (StorageManager key `library`, in
 * main.js RECORD_MERGED_KEYS — ids + updatedAt stamps + tombstones):
 *
 *  - voicePages: the voice record. V6: style is explicit and
 *    user-editable — no latent style state. A page the user has edited
 *    carries `userEdited: true` and the study pass NEVER rewrites its body
 *    again; studies still refresh exemplars and stamp `lastStudiedAt`.
 *    Pre-2026-09-02 blobs may still hold OTHER voice records (custom
 *    voices); they are ignored, never deleted — user data stays put.
 *  - exemplars: verbatim passages from the voice's material, nominated by
 *    a study pass (source 'study') and pin/unpinnable by the user. Pinned
 *    exemplars survive every re-study; unpinned study nominations are
 *    replaced wholesale by the next study. Keyed by `collection`, like
 *    the study that produces them.
 *
 * Turning the voice off deletes the LENS, never the material — the folder
 * and its files stay in the Library (V1: the app never destroys the user's
 * originals on a record delete), and notes/journal/email are untouched.
 *
 * Every removal stamps `tombstones` — main.js merges this key by record
 * union, so an untombstoned delete is resurrected by the next sync.
 *
 * The style page ships inside every draft prompt, so it lives under a hard
 * char budget rather than growing without bound.
 */
const VoiceStore = {
    KEY: 'library',
    PAGE_CHAR_BUDGET: 2400,
    EXEMPLAR_CHAR_CAP: 700,
    MAX_STUDY_EXEMPLARS: 5,
    SOURCE_KEYS: ['documents', 'notes', 'journal', 'emails'],
    SELF_NAME: 'My voice',

    _load() {
        const d = StorageManager.get(this.KEY) || {};
        return {
            ...d,
            voicePages: Array.isArray(d.voicePages) ? d.voicePages : [],
            exemplars: Array.isArray(d.exemplars) ? d.exemplars : [],
            tombstones: (d.tombstones && typeof d.tombstones === 'object') ? d.tombstones : {}
        };
    },

    _save(data) {
        // main's mergedForWrite unions this write with what is stored, so a
        // renderer holding a stale copy cannot clobber records it never
        // loaded — removals happen through tombstones alone.
        StorageManager.set(this.KEY, data);
    },

    _tombstone(data, id) {
        data.tombstones[id] = new Date().toISOString();
    },

    /**
     * A strictly-increasing updatedAt. Every write of this key goes through
     * main's record-union merge, and two same-millisecond stamps tie —
     * resolved by comparing serialized records, which can pick the OLD copy
     * and silently drop the newer write (a study right after a user edit
     * lost its lastStudiedAt exactly this way).
     */
    _stamp(prev) {
        return new Date(Math.max(Date.now(), (Date.parse(prev || '') || 0) + 1)).toISOString();
    },

    _pageId(collection) {
        return `voice_${collection || '_root'}`;
    },

    /** Every stored voice record (the self voice plus any legacy ones). */
    pages() {
        return this._load().voicePages.map(p =>
            p.name ? p : { ...p, name: p.collection || this.SELF_NAME });
    },

    pageFor(collection) {
        return this.pages().find(p => (p.collection || '') === (collection || '')) || null;
    },

    /** The user's own voice, if it has been turned on. */
    selfVoice() {
        return this.pages().find(p => p.self === true) || null;
    },

    /** On = the self voice exists; studied = it carries a guide. */
    isOn() { return !!this.selfVoice(); },
    isStudied() {
        const v = this.selfVoice();
        return !!(v && (v.body || '').trim());
    },

    /** Normalized sources for the self voice. */
    sourcesOf(page) {
        const s = (page && page.sources && typeof page.sources === 'object') ? page.sources : {};
        const out = {};
        for (const k of this.SOURCE_KEYS) out[k] = s[k] === true;
        // A voice with every source off studies nothing — treat the stored
        // shape as "documents at least", the pre-restructure corpus.
        if (!this.SOURCE_KEYS.some(k => out[k])) out.documents = true;
        return out;
    },

    /**
     * One-time adoption of a pre-restructure voice named "My voice" as THE
     * self voice (that is exactly what the old welcome told users to
     * create; its corpus was uploaded documents). Runs from AppManager.init
     * — a read-time normalization would mean writing during reads.
     */
    adoptSelfOnce() {
        const data = this._load();
        if (data.voicePages.some(p => p.self === true)) return;
        const mine = data.voicePages.find(p =>
            String(p.name || p.collection || '').trim().toLowerCase() === this.SELF_NAME.toLowerCase());
        if (!mine) return;
        mine.self = true;
        mine.sources = { documents: true, notes: false, journal: false, emails: false };
        mine.updatedAt = this._stamp(mine.updatedAt);
        this._save(data);
    },

    /**
     * Turn on My voice: a self-flagged page over `collection` (the folder
     * that will hold uploaded documents — the caller asks main to create
     * it first; the store never touches the filesystem), with the user's
     * source picks. An existing record on that folder is claimed rather
     * than doubled.
     */
    createSelf(sources, collection) {
        const existing = this.selfVoice();
        if (existing) return { voice: existing, existed: true };
        const clean = {};
        for (const k of this.SOURCE_KEYS) clean[k] = !!(sources && sources[k]);
        if (!this.SOURCE_KEYS.some(k => clean[k])) clean.documents = true;

        const data = this._load();
        const onFolder = data.voicePages.find(p => (p.collection || '') === (collection || ''));
        if (onFolder) {
            onFolder.self = true;
            onFolder.sources = clean;
            onFolder.updatedAt = this._stamp(onFolder.updatedAt);
            this._save(data);
            return { voice: onFolder, existed: true };
        }
        const now = new Date().toISOString();
        const page = {
            id: this._pageId(collection),
            name: this.SELF_NAME,
            collection: collection || '',
            body: '',
            self: true,
            sources: clean,
            createdAt: now,
            updatedAt: now
        };
        data.voicePages.push(page);
        this._save(data);
        return { voice: page };
    },

    /** Change which sources the voice studies. Takes effect next study. */
    setSources(id, sources) {
        const data = this._load();
        const page = data.voicePages.find(p => p.id === id);
        if (!page || !page.self) return false;
        const clean = {};
        for (const k of this.SOURCE_KEYS) clean[k] = !!(sources && sources[k]);
        page.sources = clean;
        page.updatedAt = this._stamp(page.updatedAt);
        this._save(data);
        return true;
    },

    exemplarsFor(collection) {
        return this._load().exemplars
            .filter(e => (e.collection || '') === (collection || ''))
            .sort((a, b) => (b.pinned === true) - (a.pinned === true)
                || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    },

    /** A by-hand edit of the style page. From here on, studies keep it. */
    saveUserEdit(collection, body) {
        const text = String(body || '').trim().slice(0, this.PAGE_CHAR_BUDGET);
        const data = this._load();
        const now = new Date().toISOString();
        const id = this._pageId(collection);
        let page = data.voicePages.find(p => p.id === id);
        if (!page) {
            // Named by folder, never SELF_NAME: adoptSelfOnce claims a
            // record literally named "My voice", and a page created here
            // by a study of some other folder must not be mistaken for it.
            page = { id, name: collection || this.SELF_NAME, collection: collection || '', createdAt: now };
            data.voicePages.push(page);
        }
        page.body = text;
        page.userEdited = true;
        page.updatedAt = this._stamp(page.updatedAt);
        this._save(data);
        return page;
    },

    /**
     * Apply one study pass's outcome. `body` is the model-written style
     * guide, `exemplars` the ALREADY-VALIDATED verbatim nominations
     * ({docId, docTitle, text}) — validation (the quote-anchor gate) is
     * VoiceService's job; this method trusts its input's provenance but
     * still enforces the two page laws:
     *
     *  - NEVER-BLANK: an empty body changes nothing at all. A garbage model
     *    run must not cost the user an existing page (or its exemplars —
     *    nominations from a run that couldn't write a guide are not
     *    evidence of anything).
     *  - USER EDITS WIN: a userEdited page keeps its body forever; the
     *    study only refreshes exemplars and stamps lastStudiedAt.
     */
    applyStudy(collection, { body, exemplars = [], sampledDocs = 0 } = {}) {
        const guide = String(body || '').trim();
        if (!guide) return { applied: false, reason: 'empty-guide' };

        const data = this._load();
        const now = new Date().toISOString();
        const id = this._pageId(collection);
        let page = data.voicePages.find(p => p.id === id);
        let keptUserBody = false;
        if (!page) {
            // Named by folder, never SELF_NAME: adoptSelfOnce claims a
            // record literally named "My voice", and a page created here
            // by a study of some other folder must not be mistaken for it.
            page = { id, name: collection || this.SELF_NAME, collection: collection || '', createdAt: now };
            data.voicePages.push(page);
        }
        if (page.userEdited) {
            keptUserBody = true;
        } else {
            page.body = guide.slice(0, this.PAGE_CHAR_BUDGET);
        }
        page.lastStudiedAt = now;
        page.sampledDocs = sampledDocs;
        page.updatedAt = this._stamp(page.updatedAt);

        // Replace this collection's unpinned study nominations; pinned ones
        // are the user's picks and always survive.
        const kept = [];
        for (const e of data.exemplars) {
            const mine = (e.collection || '') === (collection || '');
            if (mine && e.source === 'study' && !e.pinned) { this._tombstone(data, e.id); continue; }
            kept.push(e);
        }
        const seen = new Set(kept
            .filter(e => (e.collection || '') === (collection || ''))
            .map(e => this._exKey(e)));
        let added = 0;
        for (const ex of exemplars.slice(0, this.MAX_STUDY_EXEMPLARS)) {
            const rec = {
                id: 'ex_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
                collection: collection || '',
                docId: ex.docId,
                docTitle: String(ex.docTitle || ''),
                text: String(ex.text || '').slice(0, this.EXEMPLAR_CHAR_CAP),
                source: 'study',
                pinned: false,
                createdAt: now,
                updatedAt: now
            };
            if (seen.has(this._exKey(rec))) continue;
            seen.add(this._exKey(rec));
            kept.push(rec);
            added++;
        }
        data.exemplars = kept;
        this._save(data);
        return { applied: true, keptUserBody, exemplarsAdded: added };
    },

    _exKey(e) {
        return `${e.docId}|${String(e.text || '').replace(/\s+/g, ' ').trim().toLowerCase()}`;
    },

    setPinned(id, pinned) {
        const data = this._load();
        const ex = data.exemplars.find(e => e.id === id);
        if (!ex) return false;
        ex.pinned = !!pinned;
        ex.updatedAt = this._stamp(ex.updatedAt);
        this._save(data);
        return true;
    },

    removeExemplar(id) {
        const data = this._load();
        const before = data.exemplars.length;
        data.exemplars = data.exemplars.filter(e => e.id !== id);
        if (data.exemplars.length === before) return false;
        this._tombstone(data, id);
        this._save(data);
        return true;
    },

    /** Turn the voice off: the page and its exemplars go; the material stays. */
    deletePage(collection) {
        const data = this._load();
        const id = this._pageId(collection);
        const before = data.voicePages.length;
        data.voicePages = data.voicePages.filter(p => p.id !== id);
        if (data.voicePages.length === before) return false;
        this._tombstone(data, id);
        for (const e of data.exemplars) {
            if ((e.collection || '') === (collection || '')) this._tombstone(data, e.id);
        }
        data.exemplars = data.exemplars.filter(e => (e.collection || '') !== (collection || ''));
        this._save(data);
        return true;
    }
};
