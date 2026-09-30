/**
 * DecisionStore - per-record decisions the assistant and the user save
 * onto a specific record: the plans, constraints and standing instructions
 * that are ABOUT a task/goal/note/routine/strategy/account but don't fit
 * its fields ("deploy the excess cash as a 3-month DCA: …").
 *
 * Distinct from MemoryManager on purpose: a memory is a consolidated fact
 * about the user (rewritten by compaction, pruned by staleness), while a
 * decision is a dated instruction pinned to one record that must survive
 * verbatim and come back on every read of that record. Storage key is
 * `agent-decisions`, record-merged in sync (main.js RECORD_MERGED_KEYS):
 * every edit bumps updatedAt, every removal stamps a tombstone first.
 *
 * Keys are '<type>:<recordId>' with type ∈ TYPES — ids, never names, so a
 * renamed strategy keeps its decisions. resolveKey() is where tool-facing
 * names (strategies and accounts are usually addressed by name) become ids.
 */
const DecisionStore = {
    _storageKey: 'agent-decisions',
    decisions: [],
    tombstones: {},
    _loaded: false,

    // The decision hosts are whatever record types are registered
    // (js/core/record-types.js) — app packages add their own.
    get TYPES() { return (typeof RecordTypes !== 'undefined') ? RecordTypes.decisionTypes() : []; },
    TITLE_MAX: 80,
    BODY_MAX: 1200,
    // Superseded decisions are history: kept for the UI's "N earlier" fold,
    // pruned (with tombstones) after RETAIN_MS. Matches the sync merge's
    // tombstone TTL so a prune can never lose to a resurrection.
    RETAIN_MS: 90 * 24 * 60 * 60 * 1000,

    // Context-block budget (agent-service _buildCurrentContextBlock).
    CTX_MAX_ITEMS: 8,
    CTX_ITEM_CHARS: 300,
    CTX_TOTAL_CHARS: 1600,

    init() {
        if (this._loaded) return;
        try {
            const data = StorageManager.get(this._storageKey);
            this.decisions = (data && Array.isArray(data.decisions)) ? data.decisions : [];
            this.tombstones = (data && data.tombstones && typeof data.tombstones === 'object') ? data.tombstones : {};
        } catch (e) {
            console.warn('[decisions] load failed:', e);
            this.decisions = [];
            this.tombstones = {};
        }
        this._loaded = true;
        this.prune();
    },

    _save() {
        try {
            StorageManager.set(this._storageKey, {
                decisions: this.decisions,
                tombstones: this.tombstones
            });
        } catch (e) {
            console.warn('[decisions] save failed:', e);
        }
    },

    // Stamp a deletion so the sync merge honours it — BEFORE the save that
    // drops the record, same contract as MemoryManager._tombstone.
    _tombstone(ids) {
        const now = Date.now();
        const nowISO = new Date(now).toISOString();
        for (const id of (Array.isArray(ids) ? ids : [ids])) this.tombstones[id] = nowISO;
        for (const [id, at] of Object.entries(this.tombstones)) {
            if (now - (Date.parse(at) || 0) > this.RETAIN_MS) delete this.tombstones[id];
        }
    },

    _newId() {
        return 'dec_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    },

    /**
     * '<type>' + {id?, name?} → { key, recordTitle } or { error }.
     * Validates the record actually exists — a decision on a made-up id
     * would be unreachable forever. Blob lookups mirror RecordLinks.TYPES;
     * strategy/account also accept a name because that is how their tools
     * address them (the KEY still carries the id, so renames don't orphan).
     */
    resolveKey(type, { id, name } = {}) {
        const t = String(type || '').toLowerCase().trim();
        if (!this.TYPES.includes(t)) {
            return { error: `Unknown record type "${type}". One of: ${this.TYPES.join(', ')}.` };
        }
        const wantId = id != null ? String(id) : '';
        const wantName = (name || '').trim().toLowerCase();

        const def = RecordTypes.get(t);
        if (!def || !def.resolve) return { error: `Records of type "${t}" cannot hold decisions.` };
        if (!wantId && !wantName) return { error: `${t} requires an id (from its list tool)${def.resolve.length ? ' or a name' : ''}.` };
        let rec = null;
        try { rec = def.resolve({ id: wantId || null, name: wantName || null }); } catch (_) { rec = null; }
        return rec
            ? { key: `${t}:${rec.id}`, recordTitle: rec.title || def.label.toLowerCase() }
            : { error: `No ${def.label.toLowerCase()} matching "${wantId || name}".` };
    },

    /**
     * AgentContext recordKey → decision key, or null for anything that
     * doesn't carry decisions. email/insight/browse are deliberately
     * unmapped: those records ARE untrusted content, so decisions never
     * surface over them by construction (defense in depth under the
     * runtime ctx.untrusted gate).
     */
    fromRecordKey(recordKey) {
        const hit = RecordTypes.fromRecordKey(recordKey);
        if (hit && hit.def.decisions) return `${hit.type}:${hit.id}`;
        return null;
    },

    /**
     * The one write path (MemoryManager.saveSmart's three arithmetic cases):
     * exact body dup on the same key → reconfirm (bump updatedAt); same
     * key + title with a different body → the decision CHANGED: append new,
     * stamp old superseded — never edit in place; else plain create.
     * Returns { decision, deduped?, superseded? }.
     */
    saveSmart({ key, title, body, convId, source } = {}) {
        this.init();
        if (!key || !body || !String(body).trim()) throw new Error('decision key and body required');
        const cleanTitle = String(title || body).trim().slice(0, this.TITLE_MAX);
        const cleanBody = String(body).trim().slice(0, this.BODY_MAX);
        const bodyNorm = cleanBody.toLowerCase();
        const titleNorm = cleanTitle.toLowerCase();
        const active = this.decisions.filter(d => d.key === key && !d.supersededAt);

        const exact = active.find(d => (d.body || '').trim().toLowerCase() === bodyNorm);
        if (exact) {
            exact.updatedAt = new Date().toISOString();
            this._save();
            return { decision: exact, deduped: true };
        }

        const now = new Date().toISOString();
        const decision = {
            id: this._newId(),
            key,
            title: cleanTitle,
            body: cleanBody,
            convId: convId || null,
            source: source === 'user' ? 'user' : 'chat',
            createdAt: now,
            updatedAt: now
        };
        const prior = active.find(d => (d.title || '').trim().toLowerCase() === titleNorm);
        if (prior) {
            prior.supersededAt = now;
            prior.supersededBy = decision.id;
            prior.updatedAt = now;
            decision.supersedes = prior.id;
        }
        this.decisions.unshift(decision);
        this._save();
        return prior ? { decision, superseded: prior } : { decision };
    },

    /** Newest-first decisions for one key; superseded hidden by default. */
    listFor(key, { includeSuperseded = false } = {}) {
        this.init();
        return this.decisions
            .filter(d => d.key === key && (includeSuperseded || !d.supersededAt))
            .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
    },

    get(id) {
        this.init();
        return this.decisions.find(d => d.id === id) || null;
    },

    /** Tombstone-then-save removal. Returns the removed decision or null. */
    remove(id) {
        this.init();
        const d = this.decisions.find(x => x.id === id);
        if (!d) return null;
        this._tombstone(id);
        this.decisions = this.decisions.filter(x => x.id !== id);
        this._save();
        return d;
    },

    /**
     * Maintenance sweep: drop decisions whose HOST RECORD no longer exists
     * (a deleted goal's decisions are unreachable — no page mounts them, no
     * read tool resolves them). Called from AppManager.init, the
     * cleanupStaleLinks slot. Two defenses, both load-bearing:
     *
     * - ORPHAN_GRACE_MS: sync merges each key independently, so a decision
     *   made on the other Mac can land here BEFORE its host record's blob
     *   does. Judging it orphaned in that window would tombstone it, and
     *   the tombstone syncs back and kills it everywhere. Only decisions
     *   past the grace age are judged — by then both keys have long since
     *   converged, and a real orphan lingering a week is the cheap side of
     *   that trade.
     * - Tri-state existence (the RecordLinks rule): a host blob that is
     *   MISSING is unknowable, not empty — skip its types entirely rather
     *   than reading a bad boot as a mass deletion.
     */
    ORPHAN_GRACE_MS: 7 * 24 * 60 * 60 * 1000,

    pruneOrphans() {
        this.init();
        // Each record type says which ids are alive (null = unknowable
        // right now, never prune) — js/core/record-types.js.
        const hosts = {};
        for (const d of RecordTypes.all()) {
            if (!d.decisions) continue;
            try { hosts[d.type] = d.ids(); } catch (_) { hosts[d.type] = null; }
        }
        const cutoff = Date.now() - this.ORPHAN_GRACE_MS;
        const dead = this.decisions.filter(d => {
            const created = Date.parse(d.createdAt) || 0;
            if (created > cutoff) return false;                   // inside grace
            const sep = (d.key || '').indexOf(':');
            if (sep === -1) return true;                          // malformed key
            const known = hosts[d.key.slice(0, sep)];
            if (known === null || known === undefined) return false;  // unknowable
            return !known.has(d.key.slice(sep + 1));
        });
        if (!dead.length) return 0;
        this._tombstone(dead.map(d => d.id));
        const deadIds = new Set(dead.map(d => d.id));
        this.decisions = this.decisions.filter(d => !deadIds.has(d.id));
        this._save();
        console.log(`[decisions] pruned ${dead.length} orphaned decision(s) whose host record is gone`);
        return dead.length;
    },

    /** Drop superseded decisions past RETAIN_MS — with tombstones, or the
     *  record-merge union restores them from the other Mac. */
    prune() {
        const cutoff = Date.now() - this.RETAIN_MS;
        const dead = this.decisions.filter(d =>
            d.supersededAt && (Date.parse(d.supersededAt) || 0) < cutoff);
        if (!dead.length) return 0;
        this._tombstone(dead.map(d => d.id));
        const deadIds = new Set(dead.map(d => d.id));
        this.decisions = this.decisions.filter(d => !deadIds.has(d.id));
        this._save();
        return dead.length;
    },

    /**
     * Budgeted plain-text block for the CURRENT-RECORD context injection.
     * Active only, newest-first, hard caps so the context block can never
     * balloon. '' when there is nothing to say.
     */
    forContext(key) {
        const list = this.listFor(key);
        if (!list.length) return '';
        const lines = [];
        let used = 0;
        let shown = 0;
        for (const d of list.slice(0, this.CTX_MAX_ITEMS)) {
            const when = this._when(d.createdAt);
            const text = d.title && d.title !== d.body
                ? `${d.title}: ${d.body}` : d.body;
            const line = `- [${when}] ${text}`.slice(0, this.CTX_ITEM_CHARS);
            if (used + line.length > this.CTX_TOTAL_CHARS) break;
            lines.push(line);
            used += line.length;
            shown++;
        }
        const more = list.length - shown;
        if (more > 0) lines.push(`(${more} more — list_decisions for the rest)`);
        return lines.join('\n');
    },

    _when(iso) {
        const d = new Date(iso);
        return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
};
