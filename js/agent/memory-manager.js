/**
 * MemoryManager - persistent, cross-session memories for the Anjadhe Agent.
 *
 * Memories capture stable facts, preferences, ongoing context, and
 * corrections the user has given. Unlike the briefing (derived from
 * structured app data each conversation), these are free-form notes
 * that survive across chats and sync across machines.
 *
 * Storage key is `agent-memories` and participates in the normal sync
 * journal — memories follow the user to every Mac.
 */
const MemoryManager = {
    _storageKey: 'agent-memories',
    memories: [],
    // ISO timestamp of the last consolidation pass. Persisted alongside the
    // memories and synced so the daily merge runs once across all machines
    // (mirrors PromptFeed's per-run dedup), not independently on each Mac.
    consolidatedAt: null,
    // Per-record delete stamps ({id: deletedAtISO}) so the record-level sync
    // merge (main.js RECORD_MERGED_KEYS) doesn't resurrect deleted items —
    // EVERY removal path must stamp here before saving (delete, exactDedup,
    // replaceChunk, prune), or the union brings the record back from the
    // other Mac. Same contract as the portfolio blob.
    tombstones: {},
    _loaded: false,

    // Allowed types. Keep this list narrow — extraction prompts and UI
    // rendering both branch on it, so expanding the enum means updating
    // both. See the Jan-2026 design discussion for rationale.
    TYPES: ['preference', 'fact', 'context', 'correction'],

    // Retention arithmetic (no model judgment — facts age by the clock):
    // absorbed/superseded items are history, kept this long for the UI's
    // provenance and then pruned; `context` items describe a situation
    // ("currently job hunting"), get an "(as of …)" label after STALE_MS
    // and are pruned after CONTEXT_TTL_MS without a reconfirming mention.
    RETAIN_MS: 90 * 24 * 60 * 60 * 1000,
    STALE_MS: 60 * 24 * 60 * 60 * 1000,
    CONTEXT_TTL_MS: 180 * 24 * 60 * 60 * 1000,

    init() {
        if (this._loaded) return;
        try {
            const data = StorageManager.get(this._storageKey);
            this.memories = (data && Array.isArray(data.memories)) ? data.memories : [];
            this.consolidatedAt = (data && data.consolidatedAt) || null;
            this.tombstones = (data && data.tombstones && typeof data.tombstones === 'object') ? data.tombstones : {};
        } catch (e) {
            console.warn('[memory] load failed:', e);
            this.memories = [];
            this.consolidatedAt = null;
            this.tombstones = {};
        }
        this._loaded = true;
    },

    _save() {
        try {
            StorageManager.set(this._storageKey, {
                memories: this.memories,
                consolidatedAt: this.consolidatedAt,
                tombstones: this.tombstones
            });
        } catch (e) {
            console.warn('[memory] save failed:', e);
        }
    },

    // Stamp a deletion so the sync merge honours it. Prunes expired stamps
    // opportunistically (the merge in main.js prunes them too).
    _tombstone(ids) {
        const now = Date.now();
        const nowISO = new Date(now).toISOString();
        for (const id of (Array.isArray(ids) ? ids : [ids])) this.tombstones[id] = nowISO;
        for (const [id, at] of Object.entries(this.tombstones)) {
            if (now - (Date.parse(at) || 0) > this.RETAIN_MS) delete this.tombstones[id];
        }
    },

    _newId() {
        return 'mem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    },

    /**
     * Create a memory. Required: type, body. Optional: title, profile, source,
     * and provenance — `convId` (source conversation), `quote` (short verbatim
     * span of what the user actually said; the extraction gate requires one),
     * `entity` (the person/place/topic the fact is about). Provenance is what
     * lets the memory page answer "why does it think this?" and lets a
     * paraphrase by a small model be checked against the user's own words.
     */
    create({ type, title, body, profile, source, convId, quote, entity } = {}) {
        this.init();
        if (!body || typeof body !== 'string') throw new Error('memory body required');
        if (!this.TYPES.includes(type)) throw new Error(`invalid memory type: ${type}`);

        const now = new Date().toISOString();
        const memory = {
            id: this._newId(),
            type,
            title: (title || body.slice(0, 60)).trim(),
            body: body.trim(),
            profile: profile || null,
            createdAt: now,
            updatedAt: now,
            lastUsedAt: null,
            usageCount: 0,
            source: source || 'manual',
            ...(convId ? { convId } : {}),
            ...(quote ? { quote: String(quote).trim().slice(0, 300) } : {}),
            ...(entity ? { entity: String(entity).trim().slice(0, 60) } : {})
        };
        this.memories.unshift(memory);
        this._save();
        return memory;
    },

    /**
     * The one write path extraction and save_memory should use. Three cases,
     * decided by ARITHMETIC (exact matches), never by a model verdict:
     *   - exact body duplicate → reconfirm it: bump updatedAt (which is also
     *     the staleness clock and the sync-merge stamp) and return it;
     *   - same type + same non-empty title but a DIFFERENT body → the fact
     *     CHANGED: create the new item and mark the old one superseded
     *     (supersededAt/supersededBy — kept for history, out of every active
     *     view, pruned after RETAIN_MS). Never edit or delete in place —
     *     append-and-supersede is what makes a wrong update recoverable;
     *   - otherwise → plain create.
     * Returns { memory, deduped?, superseded? }.
     */
    saveSmart({ type, title, body, profile, source, convId, quote, entity } = {}) {
        this.init();
        const bodyNorm = (body || '').trim().toLowerCase();
        const titleNorm = (title || '').trim().toLowerCase();
        const p = profile || null;
        const active = this.memories.filter(m => !m.supersededAt && m.profile === p);

        const exact = active.find(m => m.body.trim().toLowerCase() === bodyNorm);
        if (exact) {
            exact.updatedAt = new Date().toISOString();
            this._save();
            return { memory: exact, deduped: true };
        }

        const prior = titleNorm
            ? active.find(m => m.type === type && m.title.trim().toLowerCase() === titleNorm)
            : null;
        const memory = this.create({ type, title, body, profile, source, convId, quote, entity });
        if (prior) {
            prior.supersededAt = memory.createdAt;
            prior.supersededBy = memory.id;
            prior.updatedAt = memory.createdAt;
            memory.supersedes = prior.id;
            this._save();
            return { memory, superseded: prior };
        }
        return { memory };
    },

    get(id) {
        this.init();
        return this.memories.find(m => m.id === id) || null;
    },

    update(id, patch) {
        this.init();
        const m = this.memories.find(x => x.id === id);
        if (!m) return null;
        const allowed = ['type', 'title', 'body', 'profile'];
        for (const k of allowed) {
            if (patch[k] !== undefined) m[k] = patch[k];
        }
        if (patch.type && !this.TYPES.includes(patch.type)) {
            throw new Error(`invalid memory type: ${patch.type}`);
        }
        m.updatedAt = new Date().toISOString();
        this._save();
        return m;
    },

    delete(id) {
        this.init();
        const before = this.memories.length;
        this.memories = this.memories.filter(m => m.id !== id);
        const changed = this.memories.length !== before;
        if (changed) { this._tombstone(id); this._save(); }
        return changed;
    },

    /**
     * Filtered list, newest first. All filters optional. Superseded items are
     * history and excluded unless `includeSuperseded` — every active surface
     * (injection, consolidation, tools, UI) wants only the current facts.
     * Sorted explicitly: the sync merge stores records in canonical
     * createdAt-ascending order, so insertion order can't be trusted.
     */
    list({ type, profile, source, onlyProfile, includeSuperseded } = {}) {
        this.init();
        let out = this.memories.slice();
        if (!includeSuperseded) out = out.filter(m => !m.supersededAt);
        if (type) out = out.filter(m => m.type === type);
        if (source) out = out.filter(m => m.source === source);
        if (profile !== undefined) {
            out = out.filter(m => (onlyProfile ? m.profile === profile : (m.profile === null || m.profile === profile)));
        }
        out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        return out;
    },

    /**
     * Newest active log items for the memory page's "Recently learned" feed —
     * what extraction and save_memory captured, with provenance intact.
     */
    recentLog({ limit = 8 } = {}) {
        return this.list({}).slice(0, limit);
    },

    /**
     * A `context` item describes a situation, not an identity — after
     * STALE_MS without reconfirmation it should be read as "as of <then>",
     * not as current truth. Pure arithmetic on updatedAt (which saveSmart
     * bumps when a fact is re-observed).
     */
    isStale(m) {
        if (!m || m.type !== 'context') return false;
        const t = Date.parse(m.updatedAt || m.createdAt) || 0;
        return t > 0 && (Date.now() - t) > this.STALE_MS;
    },

    /** "as of May 2026" label for a stale context item, '' otherwise. */
    asOfLabel(m) {
        if (!this.isStale(m)) return '';
        const d = new Date(Date.parse(m.updatedAt || m.createdAt));
        return `as of ${d.toLocaleString('en-US', { month: 'short', year: 'numeric' })}`;
    },

    /**
     * Simple substring search across title+body. Case-insensitive. Returns
     * matches ordered by a tiny relevance score (title hit > body hit),
     * then recency. Good enough for an on-demand tool; swap for embeddings
     * later if the set grows past a few hundred memories.
     */
    search(query, { profile, limit = 20 } = {}) {
        this.init();
        if (!query || typeof query !== 'string') return [];
        const q = query.trim().toLowerCase();
        if (!q) return [];

        let candidates = profile !== undefined
            ? this.memories.filter(m => m.profile === null || m.profile === profile)
            : this.memories;
        candidates = candidates.filter(m => !m.supersededAt);

        const scored = [];
        for (const m of candidates) {
            const titleHit = m.title.toLowerCase().includes(q);
            const bodyHit = m.body.toLowerCase().includes(q);
            if (!titleHit && !bodyHit) continue;
            scored.push({ m, score: (titleHit ? 2 : 0) + (bodyHit ? 1 : 0) });
        }
        scored.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return (b.m.updatedAt || '').localeCompare(a.m.updatedAt || '');
        });
        return scored.slice(0, limit).map(s => s.m);
    },

    /**
     * Bump usage counter when a memory is read by the agent. Batched save
     * avoids thrashing storage when many memories are touched in one turn.
     */
    recordUsage(ids) {
        this.init();
        const list = Array.isArray(ids) ? ids : [ids];
        const now = new Date().toISOString();
        let changed = false;
        for (const id of list) {
            const m = this.memories.find(x => x.id === id);
            if (!m) continue;
            m.usageCount = (m.usageCount || 0) + 1;
            m.lastUsedAt = now;
            changed = true;
        }
        if (changed) this._save();
    },

    /**
     * Dedupe helper used by extraction and the save_memory tool. Matches
     * case-insensitive equality on body OR a title+type match. Returns the
     * existing memory if one is found, else null.
     */
    findDuplicate({ type, title, body, profile }) {
        this.init();
        const bodyNorm = (body || '').trim().toLowerCase();
        const titleNorm = (title || '').trim().toLowerCase();
        return this.memories.find(m => {
            if (m.supersededAt) return false;
            if (m.profile !== (profile || null)) return false;
            if (m.body.trim().toLowerCase() === bodyNorm) return true;
            if (type && m.type === type && titleNorm && m.title.trim().toLowerCase() === titleNorm) return true;
            return false;
        }) || null;
    },

    // ─────────────────────── Consolidation / pruning ───────────────────────
    //
    // The agent auto-extracts memories after conversations, so the store grows
    // unbounded and accumulates near-duplicates (extraction dedup only catches
    // *exact* body matches). A daily pass keeps it tight: a cheap deterministic
    // exact-dedup, then a model-driven merge of overlapping memories. Both are
    // strictly merge-only — a unique fact is never silently dropped, only
    // collapsed into a memory that already covers it. The model orchestration
    // lives in AgentService (it owns the local model); these are the data
    // primitives it drives.

    getConsolidatedAt() {
        this.init();
        return this.consolidatedAt;
    },

    markConsolidated() {
        this.init();
        this.consolidatedAt = new Date().toISOString();
        this._save();
    },

    // Pick the member that should absorb the others: most-used first, then
    // oldest (its createdAt anchors the merged memory's age).
    _pickSurvivor(members) {
        return members.slice().sort((a, b) => {
            const ua = a.usageCount || 0, ub = b.usageCount || 0;
            if (ub !== ua) return ub - ua;
            return (a.createdAt || '').localeCompare(b.createdAt || '');
        })[0];
    },

    // Fold the stats of every member into the survivor: usage sums (so a
    // merged memory keeps its earned ranking weight), age is the earliest
    // createdAt, last-used is the most recent. A manual member makes the
    // result manual — the user authored it, so it shouldn't be treated as
    // disposable extracted data.
    _absorb(survivor, members) {
        let usage = 0;
        let earliest = survivor.createdAt || null;
        let latest = survivor.lastUsedAt || null;
        let manual = false;
        for (const m of members) {
            usage += (m.usageCount || 0);
            if (m.createdAt && (!earliest || m.createdAt < earliest)) earliest = m.createdAt;
            if (m.lastUsedAt && (!latest || m.lastUsedAt > latest)) latest = m.lastUsedAt;
            if (m.source === 'manual') manual = true;
        }
        survivor.usageCount = usage;
        if (earliest) survivor.createdAt = earliest;
        survivor.lastUsedAt = latest;
        if (manual) survivor.source = 'manual';
    },

    /**
     * Deterministic, model-free pass: collapse memories whose bodies are
     * exactly equal (case-insensitive), scoped within the same profile.
     * Returns the number of memories removed. Safe with no local model, so
     * remote-only users still benefit.
     */
    exactDedup() {
        this.init();
        const groups = new Map();
        for (const m of this.memories) {
            if (m.supersededAt) continue; // history, prune() owns it
            const key = (m.profile || '') + '\x00' + m.body.trim().toLowerCase();
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(m);
        }
        const removeIds = new Set();
        const now = new Date().toISOString();
        for (const members of groups.values()) {
            if (members.length < 2) continue;
            const survivor = this._pickSurvivor(members);
            this._absorb(survivor, members);
            survivor.updatedAt = now;
            for (const m of members) if (m !== survivor) removeIds.add(m.id);
        }
        if (removeIds.size) {
            this.memories = this.memories.filter(m => !removeIds.has(m.id));
            this._tombstone([...removeIds]);
            this._save();
        }
        return removeIds.size;
    },

    /**
     * Deterministic retention pass (no model): drop what only exists as
     * history — absorbed items RETAIN_MS after absorption (their content
     * lives on in the pages; keeping them forever made every full rebuild
     * re-send the whole past), superseded items RETAIN_MS after
     * supersession, and `context` items nobody has re-confirmed in
     * CONTEXT_TTL_MS (a situation that old isn't a situation any more).
     * Tombstoned so sync can't resurrect them. Returns the count removed.
     */
    prune() {
        this.init();
        const now = Date.now();
        const dead = [];
        for (const m of this.memories) {
            const absorbedMs = Date.parse(m.absorbedAt || '') || 0;
            const supersededMs = Date.parse(m.supersededAt || '') || 0;
            const touchedMs = Date.parse(m.updatedAt || m.createdAt) || now;
            if (supersededMs && now - supersededMs > this.RETAIN_MS) dead.push(m.id);
            else if (absorbedMs && now - absorbedMs > this.RETAIN_MS) dead.push(m.id);
            else if (m.type === 'context' && now - touchedMs > this.CONTEXT_TTL_MS) dead.push(m.id);
        }
        if (dead.length) {
            const set = new Set(dead);
            this.memories = this.memories.filter(m => !set.has(m.id));
            this._tombstone(dead);
            this._save();
        }
        return dead.length;
    },

    /**
     * Swap a set of existing memories for a model-rewritten, consolidated set.
     * Deletes `oldIds`, inserts `newItems` (each `{ type, body, title?, profile?,
     * createdAt?, lastUsedAt?, usageCount?, source? }`), and persists once.
     * Items with no body or an invalid type are skipped. Used by the chunked
     * consolidation pass — see AgentService._consolidateChunk for the safety
     * guards (never called with an empty/blanking result). Returns
     * `{ removed, created }`.
     */
    replaceChunk(oldIds, newItems) {
        this.init();
        const removeSet = new Set(Array.isArray(oldIds) ? oldIds : []);
        const before = this.memories.length;
        this.memories = this.memories.filter(m => !removeSet.has(m.id));
        const removed = before - this.memories.length;
        if (removed) this._tombstone([...removeSet]);

        const now = new Date().toISOString();
        let created = 0;
        for (const it of (Array.isArray(newItems) ? newItems : [])) {
            const body = (it && it.body || '').trim();
            if (!body || !this.TYPES.includes(it.type)) continue;
            this.memories.unshift({
                id: this._newId(),
                type: it.type,
                title: (it.title || body.slice(0, 60)).trim(),
                body,
                profile: it.profile || null,
                createdAt: it.createdAt || now,
                updatedAt: now,
                lastUsedAt: it.lastUsedAt || null,
                usageCount: it.usageCount || 0,
                source: it.source || 'extracted',
                // Provenance carried from the chunk (agent-service picks the
                // survivor's) — a consolidated fact keeps its trail.
                ...(it.convId ? { convId: it.convId } : {}),
                ...(it.quote ? { quote: it.quote } : {}),
                ...(it.entity ? { entity: it.entity } : {}),
                ...(it.absorbedInto ? { absorbedInto: it.absorbedInto } : {}),
                // absorbedAt must survive the rewrite: without it a
                // consolidated chunk of already-filed facts rejoins the
                // unabsorbed pool — old facts resurface as "Recently noted"
                // and compaction re-folds them on the next pass.
                ...(it.absorbedAt ? { absorbedAt: it.absorbedAt } : {})
            });
            created++;
        }

        this._save();
        return { removed, created };
    },

    // ─────────────────────── Memory profile (categorized summary) ───────────────────────
    //
    // The user-facing surface for memory is no longer a flat list of items — it
    // is a small set of editable, categorized sections (a "profile"): Who I am,
    // Career, Food, Hobbies, etc. Each section is a short free-text summary the
    // user can read and edit directly on the assistant page.
    //
    // The flat `agent-memories` store above is kept as the raw capture LOG
    // (extraction + save_memory still write there). A background compaction pass
    // (AgentService.compactMemoryProfile) folds unabsorbed log items into these
    // sections, deduping and resolving contradictions, then marks the items
    // `absorbedAt` so they aren't re-filed. The sections are the truth the model
    // sees; the log is the audit trail underneath.
    //
    // Sections are scoped to a concrete profile id (never null) so each profile
    // keeps an independent summary. Storage key `agent-memory-profile` syncs
    // normally, like the log.

    _profileKey: 'agent-memory-profile',
    profileSections: [],
    profileSeeded: {},      // profileId -> true once defaults have been seeded
    profileCompactedAt: null,
    profileMigratedAt: null,
    // Same contract as the log's tombstones — deleteSection must stamp here
    // or the record-level sync merge resurrects the page from the other Mac.
    profileTombstones: {},
    _profileLoaded: false,

    // Seed pages for a fresh profile — a filing scaffold for the small local
    // model, not a fixed schema: compaction creates new pages for topics that
    // deserve their own (people, projects, themes), so the wiki grows past
    // these. Deliberately no catch-all "Other" and no "Favourites" (overlapped
    // hobbies) — trimmed 2026-07-20; profiles seeded earlier keep them and
    // deleted seeds never resurrect (profileSeeded tracking). `key` is the
    // stable slug compaction addresses; `title` is what the user sees; `hint`
    // guides the model (never shown to the user). Order is display order.
    DEFAULT_SECTIONS: [
        { key: 'about', title: 'Who I am', hint: 'Identity: name, age, where they live, background, life situation.' },
        { key: 'career', title: 'Career & work', hint: 'Job, company, role, ongoing projects, skills, professional goals.' },
        { key: 'food', title: 'Food & drink', hint: 'Foods, cuisines and drinks they like or avoid; dietary restrictions and allergies.' },
        { key: 'hobbies', title: 'Hobbies & interests', hint: 'Pastimes, sports, games, creative pursuits, subjects they follow; favourite media, music, books, shows, brands, places, teams.' },
        { key: 'relationships', title: 'People & relationships', hint: 'Family, partner, friends, colleagues, pets — names and who they are.' },
        { key: 'preferences', title: 'How to help me', hint: 'How the assistant should behave: tone, format, language, and do/don\'t corrections.' }
    ],

    _initProfile() {
        if (this._profileLoaded) return;
        try {
            const data = StorageManager.get(this._profileKey);
            this.profileSections = (data && Array.isArray(data.sections)) ? data.sections : [];
            this.profileSeeded = (data && data.seeded && typeof data.seeded === 'object') ? data.seeded : {};
            this.profileCompactedAt = (data && data.compactedAt) || null;
            this.profileMigratedAt = (data && data.migratedAt) || null;
            this.profileTombstones = (data && data.tombstones && typeof data.tombstones === 'object') ? data.tombstones : {};
        } catch (e) {
            console.warn('[memory-profile] load failed:', e);
            this.profileSections = [];
            this.profileSeeded = {};
            this.profileCompactedAt = null;
            this.profileMigratedAt = null;
            this.profileTombstones = {};
        }
        this._profileLoaded = true;
        this._upgradePages();
    },

    // Lazily upgrade section records to wiki pages by filling the additive
    // fields (summary, core, usage stats). Idempotent — records written by an
    // older app version (or synced in from one) just get the fields refilled.
    // Old versions round-trip unknown fields untouched, so coexistence across
    // Macs is safe.
    _upgradePages() {
        let changed = false;
        for (const s of this.profileSections) {
            if (s.summary === undefined) {
                s.summary = this._deriveSummary(s.body);
                s.summaryUpdatedAt = s.updatedAt || null;
                changed = true;
            }
            if (s.core === undefined) {
                s.core = (s.key === 'about' || s.key === 'preferences');
                changed = true;
            }
            if (s.usageCount === undefined) { s.usageCount = 0; s.lastUsedAt = null; changed = true; }
        }
        if (changed) this._saveProfile();
    },

    // Deterministic one-line summary from a page body: first non-empty line,
    // markdown markers stripped, ~100 chars. Used as a fallback whenever the
    // model hasn't provided a better one.
    _deriveSummary(body) {
        const line = (body || '').split('\n').map(l => l.trim()).find(l => l);
        if (!line) return '';
        const text = line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').replace(/\s+/g, ' ').trim();
        return text.length > 100 ? text.slice(0, 97).trimEnd() + '…' : text;
    },

    _saveProfile() {
        try {
            StorageManager.set(this._profileKey, {
                sections: this.profileSections,
                seeded: this.profileSeeded,
                compactedAt: this.profileCompactedAt,
                migratedAt: this.profileMigratedAt,
                tombstones: this.profileTombstones
            });
        } catch (e) {
            console.warn('[memory-profile] save failed:', e);
        }
    },

    // Every section lives in one scope. This used to resolve the active
    // profile; profiles were removed 2026-07-30, so 'default' is the only
    // id there is. The parameter stays because stored sections carry the
    // field and callers still pass it through.
    _effProfile(profile) {
        return (profile !== undefined) ? (profile || 'default') : 'default';
    },

    _newSectionId() {
        return 'sec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    },

    // Seed the default sections for a profile the first time it's viewed.
    // Tracked in `profileSeeded` so a user who deletes a built-in section
    // doesn't have it silently resurrected on the next read.
    _seedProfile(profile) {
        const p = this._effProfile(profile);
        if (this.profileSeeded[p]) return;
        const now = new Date().toISOString();
        this.DEFAULT_SECTIONS.forEach((d, i) => {
            this.profileSections.push({
                id: this._newSectionId(),
                key: d.key,
                title: d.title,
                body: '',
                summary: '',
                summaryUpdatedAt: null,
                core: d.key === 'about' || d.key === 'preferences',
                builtin: true,
                order: i,
                profile: p,
                userEdited: false,
                userEditedAt: null,
                compactedAt: null,
                usageCount: 0,
                lastUsedAt: null,
                createdAt: now,
                updatedAt: now
            });
        });
        this.profileSeeded[p] = true;
        this._saveProfile();
    },

    /** All sections for a profile (active by default), display-ordered. Seeds defaults on first access. */
    listSections(profile) {
        this._initProfile();
        const p = this._effProfile(profile);
        this._seedProfile(p);
        return this.profileSections
            .filter(s => s.profile === p)
            .slice()
            .sort((a, b) => (a.order || 0) - (b.order || 0) || (a.title || '').localeCompare(b.title || ''));
    },

    getSection(id) {
        this._initProfile();
        return this.profileSections.find(s => s.id === id) || null;
    },

    getSectionByKey(key, profile) {
        this._initProfile();
        const p = this._effProfile(profile);
        return this.profileSections.find(s => s.profile === p && s.key === key) || null;
    },

    // Slugify a title into a section key, uniquified within the profile.
    _sectionKeyFromTitle(title, profile) {
        const base = (title || 'section').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'section';
        let key = base, n = 2;
        while (this.getSectionByKey(key, profile)) key = `${base}-${n++}`;
        return key;
    },

    /** Add a user-created section (wiki page). Returns the new section. */
    addSection({ title, summary, body, core, profile } = {}) {
        this._initProfile();
        const p = this._effProfile(profile);
        this._seedProfile(p);
        const now = new Date().toISOString();
        const maxOrder = this.profileSections.filter(s => s.profile === p).reduce((m, s) => Math.max(m, s.order || 0), -1);
        const section = {
            id: this._newSectionId(),
            key: this._sectionKeyFromTitle(title, p),
            title: (title || 'Untitled').trim(),
            body: (body || '').trim(),
            summary: (summary || '').trim(),
            summaryUpdatedAt: summary ? now : null,
            core: !!core,
            builtin: false,
            order: maxOrder + 1,
            profile: p,
            userEdited: true,
            userEditedAt: now,
            compactedAt: null,
            usageCount: 0,
            lastUsedAt: null,
            createdAt: now,
            updatedAt: now
        };
        this.profileSections.push(section);
        this._saveProfile();
        return section;
    },

    /**
     * Update a section. `byUser` marks it user-edited so compaction treats the
     * text as authored and won't rewrite it (only gently appends). Compaction
     * passes `fromCompaction` to bump compactedAt without claiming user authorship.
     */
    updateSection(id, patch = {}, { byUser = false, fromCompaction = false } = {}) {
        this._initProfile();
        const s = this.profileSections.find(x => x.id === id);
        if (!s) return null;
        if (patch.title !== undefined) s.title = String(patch.title).trim();
        if (patch.body !== undefined) s.body = String(patch.body).trim();
        const now = new Date().toISOString();
        if (patch.summary !== undefined) {
            s.summary = String(patch.summary).trim();
            s.summaryUpdatedAt = now;
        }
        if (patch.core !== undefined) s.core = !!patch.core;
        if (byUser) { s.userEdited = true; s.userEditedAt = now; }
        if (fromCompaction) s.compactedAt = now;
        s.updatedAt = now;
        this._saveProfile();
        return s;
    },

    deleteSection(id) {
        this._initProfile();
        const before = this.profileSections.length;
        this.profileSections = this.profileSections.filter(s => s.id !== id);
        const changed = this.profileSections.length !== before;
        if (changed) {
            const now = Date.now();
            this.profileTombstones[id] = new Date(now).toISOString();
            for (const [tid, at] of Object.entries(this.profileTombstones)) {
                if (now - (Date.parse(at) || 0) > this.RETAIN_MS) delete this.profileTombstones[tid];
            }
            this._saveProfile();
        }
        return changed;
    },

    /**
     * Compaction helper: write a page's content (body + one-line summary) into
     * the page keyed `key` for a profile, creating the page if the model
     * invented a new topic. Never blanks an existing non-empty body. Returns
     * the page (or null if it refused to blank).
     */
    setPageContent(key, { title, summary, body } = {}, profile) {
        this._initProfile();
        const p = this._effProfile(profile);
        // Seed defaults first on a fresh profile — otherwise a cold call
        // (nothing has listed sections yet) misses the builtin page for
        // `key` and mints a duplicate under a slugified title.
        this._seedProfile(p);
        const text = (body || '').trim();
        const line = (summary || '').trim() || this._deriveSummary(text);
        const s = this.getSectionByKey(key, p);
        if (s) {
            if (!text && s.body) return null; // never blank existing content
            const patch = { body: text, ...(title ? { title } : {}), ...(line ? { summary: line } : {}) };
            return this.updateSection(s.id, patch, { fromCompaction: true });
        }
        if (!text) return null;
        // Model invented a new page — create it, attributed to compaction.
        const created = this.addSection({ title: title || key, summary: line, body: text, profile: p });
        created.userEdited = false;
        created.userEditedAt = null;
        created.compactedAt = new Date().toISOString();
        this._saveProfile();
        return created;
    },

    /** Back-compat shim for the pre-wiki compaction signature. */
    setSectionBody(key, title, body, profile) {
        return this.setPageContent(key, { title, body }, profile);
    },

    /** Non-empty sections for prompt injection, display-ordered. */
    sectionsForInjection(profile) {
        return this.listSections(profile)
            .filter(s => (s.body || '').trim())
            .map(s => ({ title: s.title, body: s.body.trim() }));
    },

    // Budget for the always-injected core tier, in characters (~1,200 tokens).
    // A small model with 8K of context can't afford an unbounded biography in
    // every prompt — the deterministic-injection rule is "a small curated
    // block, everything else behind recall_memory". Overflow pages demote to
    // index lines; they stay one tool call away.
    CORE_CHAR_BUDGET: 4800,

    // Cap on index lines in the briefing. The index grows one line per page
    // forever (compaction mints topical pages), and an unbounded roster
    // crowds the very context the core budget protects. Overflow pages are
    // still reachable — the briefing says how many more exist and
    // list_memory_pages returns the full roster.
    INDEX_MAX: 20,

    /**
     * Briefing split: `core` pages are injected in full every conversation
     * (identity + behavior rules) up to CORE_CHAR_BUDGET; everything else —
     * including core pages past the budget, shortest-first wins — appears
     * only as an index line the model can follow up on with recall_memory.
     * Pages with empty bodies are omitted entirely. The index is capped at
     * INDEX_MAX lines — most-recalled pages win the slots (a page the model
     * never needs shouldn't hold a line forever), display order is kept for
     * the survivors, and `more` reports how many pages were left out.
     */
    pagesForBriefing(profile) {
        const pages = this.listSections(profile).filter(s => (s.body || '').trim());
        const core = [];
        let index = [];
        // Shortest-first keeps the most pages fully present under the budget;
        // a single sprawling page can't evict every other core page.
        const corePages = pages.filter(s => s.core)
            .slice()
            .sort((a, b) => (a.body || '').length - (b.body || '').length);
        let used = 0;
        const demoted = new Set();
        for (const s of corePages) {
            const len = s.body.trim().length;
            if (used + len <= this.CORE_CHAR_BUDGET) {
                used += len;
            } else {
                demoted.add(s.id);
            }
        }
        // Preserve display order for what survived the budget.
        for (const s of pages) {
            if (s.core && !demoted.has(s.id)) {
                core.push({ title: s.title, body: s.body.trim() });
            } else {
                index.push({
                    _page: s,
                    title: s.title,
                    summary: (s.summary || '').trim() || this._deriveSummary(s.body)
                });
            }
        }
        let more = 0;
        if (index.length > this.INDEX_MAX) {
            const keep = new Set(index.slice()
                .sort((a, b) => (b._page.usageCount || 0) - (a._page.usageCount || 0)
                    || (b._page.updatedAt || '').localeCompare(a._page.updatedAt || ''))
                .slice(0, this.INDEX_MAX)
                .map(e => e._page.id));
            more = index.length - keep.size;
            index = index.filter(e => keep.has(e._page.id));
        }
        for (const e of index) delete e._page;
        return { core, index, more };
    },

    /**
     * Resolve a recall reference to a page: exact key → exact title →
     * title substring → summary/body substring. Case-insensitive.
     */
    findPage(ref, profile) {
        const q = (ref || '').trim().toLowerCase();
        if (!q) return null;
        const pages = this.listSections(profile);
        return pages.find(s => (s.key || '').toLowerCase() === q)
            || pages.find(s => (s.title || '').toLowerCase() === q)
            || pages.find(s => (s.title || '').toLowerCase().includes(q))
            || pages.find(s => ((s.summary || '') + '\n' + (s.body || '')).toLowerCase().includes(q))
            || null;
    },

    /** Bump a page's recall stats. Not injected anywhere, so no cache impact. */
    recordPageUsage(id) {
        this._initProfile();
        const s = this.profileSections.find(x => x.id === id);
        if (!s) return;
        s.usageCount = (s.usageCount || 0) + 1;
        s.lastUsedAt = new Date().toISOString();
        this._saveProfile();
    },

    /** Substring search across page title + summary + body, title hits first. */
    searchPages(query, { profile, limit = 10 } = {}) {
        const q = (query || '').trim().toLowerCase();
        if (!q) return [];
        const scored = [];
        for (const s of this.listSections(profile)) {
            if (!(s.body || '').trim()) continue;
            const titleHit = (s.title || '').toLowerCase().includes(q);
            const textHit = ((s.summary || '') + '\n' + s.body).toLowerCase().includes(q);
            if (!titleHit && !textHit) continue;
            scored.push({ s, score: (titleHit ? 2 : 0) + (textHit ? 1 : 0) });
        }
        scored.sort((a, b) => b.score - a.score || (b.s.updatedAt || '').localeCompare(a.s.updatedAt || ''));
        return scored.slice(0, limit).map(x => x.s);
    },

    /**
     * Pages whose body changed after the summary was last written (a UI body
     * edit, or a write from an app version that predates summaries). Compaction
     * heals these with _deriveSummary so the briefing index never lies badly.
     */
    staleSummaryPages(profile) {
        return this.listSections(profile).filter(s =>
            (s.body || '').trim() && (!s.summaryUpdatedAt || (s.updatedAt || '') > s.summaryUpdatedAt));
    },

    markProfileCompacted() {
        this._initProfile();
        this.profileCompactedAt = new Date().toISOString();
        this._saveProfile();
    },

    getProfileMigratedAt() {
        this._initProfile();
        return this.profileMigratedAt;
    },

    markProfileMigrated() {
        this._initProfile();
        this.profileMigratedAt = new Date().toISOString();
        this._saveProfile();
    },

    // ───────────── Raw log <-> profile bridge ─────────────

    /**
     * Log items not yet folded into the profile, visible to a profile (global
     * `null` items plus that profile's own). These are fed to compaction and,
     * until then, surfaced to the model as "recently noted" so a just-saved
     * memory is never invisible between compaction passes.
     */
    unabsorbed(profile, { limit } = {}) {
        this.init();
        const p = (profile === undefined) ? undefined : (profile || null);
        let out = this.memories.filter(m => !m.absorbedAt && !m.supersededAt);
        if (p !== undefined) out = out.filter(m => m.profile === null || m.profile === p);
        out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        return (limit ? out.slice(0, limit) : out);
    },

    /**
     * Mark log items as folded into the profile. `pageKeys` records WHICH
     * pages that compaction pass touched — coarse (pass-level, the model
     * doesn't report per-fact filing) but honest provenance in the other
     * direction: the memory page renders it as "filed into <page>".
     * Bumps updatedAt because the absorbed mark must win the record-level
     * sync merge — an unstamped mark ties with the other Mac's unabsorbed
     * copy and can lose, which would re-fold the item there.
     */
    markAbsorbed(ids, pageKeys) {
        this.init();
        const set = new Set(Array.isArray(ids) ? ids : [ids]);
        const now = new Date().toISOString();
        const keys = Array.isArray(pageKeys) ? pageKeys.slice(0, 6) : null;
        let changed = false;
        for (const m of this.memories) {
            if (set.has(m.id) && !m.absorbedAt) {
                m.absorbedAt = now;
                m.updatedAt = now;
                if (keys && keys.length) m.absorbedInto = keys;
                changed = true;
            }
        }
        if (changed) this._save();
        return changed;
    }
};
