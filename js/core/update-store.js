/**
 * UpdateStore — the dated UPDATES posted on a project or a task: the
 * running log of what happened ("sent the deck, waiting on Dana"), written
 * by the user from the record's page or by the assistant (a review, a
 * risk it noticed, a nudge that nothing has been said for a while).
 *
 * Distinct from a Decision on purpose: a decision is a standing
 * instruction the model must follow on every read; an update is history —
 * it is never re-read as an instruction, only as what happened. Distinct
 * from a task's Notes field too: notes describe the task, updates date
 * the progress.
 *
 * Storage key `updates` → { updates: [...], tombstones: {} }, record-merged
 * in sync (main.js RECORD_MERGED_KEYS): every record carries createdAt /
 * updatedAt, every removal stamps a tombstone first. Keys are
 * '<type>:<recordId>' with type ∈ 'goal' | 'task' — the DecisionStore key
 * shape, so the same recordKey → key mapping serves both.
 *
 * A record:
 *   { id, key, body, source: 'user' | 'ai', kind: 'update' | 'review' |
 *     'risk', createdAt, updatedAt, postId?, convId? }
 *
 * `postId` is set when the assistant's weekly Project Review is mirrored
 * here from its feed post (GoalInterview.mirrorReviewPost) and is the
 * idempotency handle for that mirror. DOM-free so the pure half runs in
 * plain Node (tests/update-store-test.js).
 */
const UpdateStore = {
    _storageKey: 'updates',
    updates: [],
    tombstones: {},
    _loaded: false,

    TYPES: ['goal', 'task'],
    KINDS: ['update', 'review', 'risk'],
    BODY_MAX: 2000,
    RETAIN_MS: 90 * 24 * 60 * 60 * 1000,      // tombstone TTL, the sync merge's
    ORPHAN_GRACE_MS: 7 * 24 * 60 * 60 * 1000,  // the DecisionStore rule
    /** A project with no update or task movement for this long is "quiet". */
    QUIET_DAYS: 14,

    // Context-block budget (agent-service _updatesBlockFor / read attach).
    CTX_MAX_ITEMS: 5,
    CTX_ITEM_CHARS: 280,
    CTX_TOTAL_CHARS: 1200,

    init() {
        if (this._loaded) return;
        try {
            const data = StorageManager.get(this._storageKey);
            this.updates = (data && Array.isArray(data.updates)) ? data.updates : [];
            this.tombstones = (data && data.tombstones && typeof data.tombstones === 'object') ? data.tombstones : {};
        } catch (e) {
            console.warn('[updates] load failed:', e);
            this.updates = [];
            this.tombstones = {};
        }
        this._loaded = true;
    },

    /** Drop the cache so the next read sees a merge / another window's write. */
    reload() { this._loaded = false; this.init(); },

    _save() {
        try {
            StorageManager.set(this._storageKey, { updates: this.updates, tombstones: this.tombstones });
        } catch (e) {
            console.warn('[updates] save failed:', e);
        }
    },

    _tombstone(ids) {
        const now = Date.now();
        const nowISO = new Date(now).toISOString();
        for (const id of (Array.isArray(ids) ? ids : [ids])) this.tombstones[id] = nowISO;
        for (const [id, at] of Object.entries(this.tombstones)) {
            if (now - (Date.parse(at) || 0) > this.RETAIN_MS) delete this.tombstones[id];
        }
    },

    _newId() {
        return 'upd_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    },

    keyFor(type, id) {
        const t = type === 'project' ? 'goal' : type;
        return this.TYPES.includes(t) && id ? `${t}:${id}` : null;
    },

    /**
     * Post an update. Returns the record, or { error } for an empty body.
     * `postId` dedupes: a second call carrying the same postId returns the
     * existing record instead of a duplicate (the review mirror runs on
     * every Mac that saw the post land).
     */
    add({ key, body, source = 'user', kind = 'update', postId = null, convId = null } = {}) {
        this.init();
        const text = String(body || '').trim().slice(0, this.BODY_MAX);
        if (!key || !/^(goal|task):.+/.test(key)) return { error: 'a project or task key is required' };
        if (!text) return { error: 'the update is empty' };
        if (postId) {
            const dup = this.updates.find(u => u.postId === postId);
            if (dup) return { update: dup, deduped: true };
        }
        const now = new Date().toISOString();
        const update = {
            id: this._newId(),
            key,
            body: text,
            source: source === 'ai' ? 'ai' : 'user',
            kind: this.KINDS.includes(kind) ? kind : 'update',
            createdAt: now,
            updatedAt: now,
            ...(postId ? { postId } : {}),
            ...(convId ? { convId } : {})
        };
        this.updates.push(update);
        this._save();
        return { update };
    },

    /** Newest-first updates for one key. */
    listFor(key, { limit = 0 } = {}) {
        this.init();
        const list = this.updates
            .filter(u => u.key === key)
            .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
        return limit > 0 ? list.slice(0, limit) : list;
    },

    /** The newest update on a key, or null. */
    latestFor(key) {
        return this.listFor(key, { limit: 1 })[0] || null;
    },

    /** Newest update per key for MANY keys in one pass — the home table. */
    latestForKeys(keys) {
        this.init();
        const wanted = new Set(keys);
        const out = new Map();
        for (const u of this.updates) {
            if (!wanted.has(u.key)) continue;
            const cur = out.get(u.key);
            if (!cur || (Date.parse(u.createdAt) || 0) > (Date.parse(cur.createdAt) || 0)) out.set(u.key, u);
        }
        return out;
    },

    get(id) {
        this.init();
        return this.updates.find(u => u.id === id) || null;
    },

    /** Tombstone-then-save removal. Returns the removed update or null. */
    remove(id) {
        this.init();
        const u = this.updates.find(x => x.id === id);
        if (!u) return null;
        this._tombstone(id);
        this.updates = this.updates.filter(x => x.id !== id);
        this._save();
        return u;
    },

    /** Remove every update on a key (a record deleted for good). */
    removeFor(key) {
        this.init();
        const dead = this.updates.filter(u => u.key === key);
        if (!dead.length) return 0;
        this._tombstone(dead.map(u => u.id));
        this.updates = this.updates.filter(u => u.key !== key);
        this._save();
        return dead.length;
    },

    /**
     * Whole days since an ISO stamp (0 for today), or null. Local
     * midnights, so "yesterday" is 1 whatever the hour.
     */
    daysSince(iso, now = new Date()) {
        const t = new Date(iso);
        if (isNaN(t)) return null;
        const a = new Date(t.getFullYear(), t.getMonth(), t.getDate());
        const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        return Math.max(0, Math.round((b - a) / 86400000));
    },

    /** "today" / "yesterday" / "3 days ago" / "5 weeks ago" — for the row gutter. */
    ago(iso, now = new Date()) {
        const d = this.daysSince(iso, now);
        if (d === null) return '';
        if (d === 0) return 'today';
        if (d === 1) return 'yesterday';
        if (d < 14) return `${d} days ago`;
        if (d < 60) return `${Math.round(d / 7)} weeks ago`;
        return `${Math.round(d / 30)} months ago`;
    },

    /**
     * Maintenance sweep — updates whose host record is gone. Same two
     * defenses as DecisionStore.pruneOrphans: a grace window (sync merges
     * keys independently, so an update can land before its host's blob)
     * and tri-state existence (an unknowable host blob never prunes).
     */
    pruneOrphans() {
        this.init();
        if (typeof RecordTypes === 'undefined') return 0;
        const hosts = {};
        for (const t of this.TYPES) {
            const d = RecordTypes.get(t);
            try { hosts[t] = d ? d.ids() : null; } catch (_) { hosts[t] = null; }
        }
        const cutoff = Date.now() - this.ORPHAN_GRACE_MS;
        const dead = this.updates.filter(u => {
            if ((Date.parse(u.createdAt) || 0) > cutoff) return false;
            const sep = (u.key || '').indexOf(':');
            if (sep === -1) return true;
            const known = hosts[u.key.slice(0, sep)];
            if (known === null || known === undefined) return false;
            return !known.has(u.key.slice(sep + 1));
        });
        if (!dead.length) return 0;
        this._tombstone(dead.map(u => u.id));
        const deadIds = new Set(dead.map(u => u.id));
        this.updates = this.updates.filter(u => !deadIds.has(u.id));
        this._save();
        console.log(`[updates] pruned ${dead.length} orphaned update(s) whose host record is gone`);
        return dead.length;
    },

    /**
     * Budgeted plain-text block for the CURRENT-RECORD context injection.
     * Newest first, hard caps. '' when there is nothing to say.
     */
    forContext(key, now = new Date()) {
        const list = this.listFor(key);
        if (!list.length) return '';
        const lines = [];
        let used = 0;
        let shown = 0;
        for (const u of list.slice(0, this.CTX_MAX_ITEMS)) {
            const who = u.source === 'ai' ? 'Anjadhe' : 'user';
            const tag = u.kind !== 'update' ? ` ${u.kind}` : '';
            const line = `- [${this._when(u.createdAt)}, ${who}${tag}] ${u.body}`.slice(0, this.CTX_ITEM_CHARS);
            if (used + line.length > this.CTX_TOTAL_CHARS) break;
            lines.push(line);
            used += line.length;
            shown++;
        }
        const more = list.length - shown;
        if (more > 0) lines.push(`(${more} more — list_updates for the rest)`);
        const quiet = this.daysSince(list[0].createdAt, now);
        if (quiet !== null && quiet >= this.QUIET_DAYS) lines.push(`(no update for ${quiet} days)`);
        return lines.join('\n');
    },

    _when(iso) {
        const d = new Date(iso);
        return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = UpdateStore;
