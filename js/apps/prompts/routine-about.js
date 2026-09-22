/**
 * RoutineAbout — what a routine is ABOUT.
 *
 * A routine had no reference to any other record. Where a link was needed
 * the app faked it with the TITLE: "Project Review: <goal title>" and
 * "Strategy Review: <strategy name>", found by prefix concatenation and
 * kept in step by `ReviewRoutines.syncRename` on every rename path. That is
 * why CLAUDE.md carries the law "never look a review up by raw prefix
 * concatenation again" — a rename that forgot to call it broke the link
 * silently, two records with the same title collided, and a user-written
 * routine that happened to start with the prefix was treated as a review.
 *
 * And it only covered those two. A routine about a ticker, an account, a
 * document or a project had no reference at all: the app could not know
 * what it was about, so it could not carry that record into the run, list
 * the routine on the record's own page, or settle the routine when the
 * record was deleted.
 *
 * The reference is `config.about` — `[{ type, id }]`, the same
 * '<type>:<id>' vocabulary `RecordTypes` and `DecisionStore` already speak.
 * Everything here reads that one registry, so a package that registers a
 * record type gets routine references for free.
 *
 * Laws:
 *
 *   A1  The ID is the link, never the title. The title convention survives
 *       only as the fallback for routines written before this existed, and
 *       a resolved id always wins over it.
 *   A2  A reference is resolved at READ time and never trusted to still
 *       exist. Existence is `RecordTypes.get(type).ids()`, which is
 *       TRI-STATE: a Set means "these are the live ids", null means "not
 *       knowable right now" — and null never means gone. This is
 *       `DecisionStore.pruneOrphans`' rule and it exists because a record
 *       whose app has not loaded is not a deleted record.
 *   A3  A reference is a POINTER, not a copy. Nothing here caches a title:
 *       renaming the record renames what the routine says about it,
 *       everywhere, with no sync path to forget.
 *   A4  It never mutates. Resolving, labelling and opening are reads; only
 *       an explicit write path (the tool, a record page arming a review)
 *       sets `about`.
 */
const RoutineAbout = {

    // A routine about a dozen things is about nothing. Five is already more
    // than any real one needs, and the cap is what keeps a model-written
    // `about` from turning into a junk drawer.
    MAX: 5,

    /**
     * The stored shape: a list of `{ type, id }`, deduped, capped, with
     * unknown or malformed entries dropped. Pure — the one normalizer, used
     * by the config reader and by every writer.
     *
     * `known` (a predicate, defaulting to the live RecordTypes registry) is
     * injectable so this can be tested without the registry loaded.
     */
    normalize(about, known) {
        const isKnown = typeof known === 'function'
            ? known
            : (t) => (typeof RecordTypes !== 'undefined' ? !!RecordTypes.get(t) : true);
        const out = [];
        const seen = new Set();
        for (const entry of Array.isArray(about) ? about : []) {
            if (!entry || typeof entry !== 'object') continue;
            const type = String(entry.type || '').trim().toLowerCase();
            const id = String(entry.id || '').trim();
            if (!type || !id || !isKnown(type)) continue;
            const key = type + ':' + id;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ type, id });
            if (out.length >= this.MAX) break;
        }
        return out;
    },

    /** `[{type, id}]` → the '<type>:<id>' keys decisions and mentions use. */
    keys(about) {
        return this.normalize(about).map(a => `${a.type}:${a.id}`);
    },

    /**
     * What each reference points at, for display: `{ type, id, label,
     * typeLabel, exists }`. `exists` is A2's tri-state — true, false, or
     * null when the record's app cannot say right now.
     */
    resolve(about) {
        if (typeof RecordTypes === 'undefined') return [];
        return this.normalize(about).map(a => {
            const def = RecordTypes.get(a.type);
            if (!def) return null;
            let label = '';
            let exists = null;
            try {
                const live = def.ids ? def.ids() : null;
                if (live instanceof Set) exists = live.has(a.id);
            } catch { exists = null; }
            try {
                const rec = def.resolve ? def.resolve({ id: a.id }) : null;
                if (rec && rec.title) { label = rec.title; if (exists === null) exists = true; }
                else if (rec === null && exists === null) exists = null;
            } catch { /* a resolver that throws tells us nothing */ }
            return {
                type: a.type,
                id: a.id,
                typeLabel: def.label || a.type,
                // A3: no stored title to go stale — and NO substitute for
                // one either. An unresolved reference gets an empty label
                // so the surface can say what it actually knows ("Project ·
                // deleted") rather than repeating the type back as if it
                // were the record's name ("Project · Project").
                label,
                exists
            };
        }).filter(Boolean);
    },

    /** Open the record a reference points at (navigation only — A4). */
    open(ref) {
        const def = (typeof RecordTypes !== 'undefined') ? RecordTypes.get(ref && ref.type) : null;
        if (def && typeof def.open === 'function') def.open(ref.id);
    },

    /**
     * The payoff: the records' own context blocks, for the RUN.
     *
     * A routine about a ticker gets that ticker's page context — its
     * profile, its decisions — without the prompt naming it and without
     * `useContext` dragging in the whole briefing. It goes through
     * `RecordTypes.recordKey` → `AgentContext.blockForRecord`, the same
     * path a chat attached to that record takes, so there is ONE builder
     * per record type and this adds none.
     */
    contextBlocks(about) {
        if (typeof RecordTypes === 'undefined' || typeof AgentContext === 'undefined') return [];
        const out = [];
        for (const a of this.normalize(about)) {
            const def = RecordTypes.get(a.type);
            if (!def || typeof def.recordKey !== 'function') continue;
            let block = null;
            try { block = AgentContext.blockForRecord(def.recordKey(a.id)); } catch { block = null; }
            if (block && block.body) out.push(block);
        }
        return out;
    },

    /** The same blocks as plain text, for the prompt paths that take one. */
    contextText(about) {
        return this.contextBlocks(about)
            .map(b => `${b.title}\n${b.body}`)
            .join('\n\n');
    },

    /**
     * Every armed routine about a given record — what a record's own page
     * shows ("reviewed every Monday"), and what a delete path asks about.
     */
    forRecord(type, id) {
        if (typeof NotePrompts === 'undefined') return [];
        const want = `${String(type || '').toLowerCase()}:${String(id || '')}`;
        return NotePrompts.list().filter(n => {
            const cfg = NotePrompts.config(n);
            return cfg.offline && this.keys(cfg.about).includes(want);
        });
    }
};

if (typeof window !== 'undefined') window.RoutineAbout = RoutineAbout;
if (typeof module !== 'undefined' && module.exports) module.exports = RoutineAbout;
