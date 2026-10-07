/**
 * MemoryManager — what nenva remembers about the person (rebuilt 2026-10-01).
 *
 * ONE store, ONE shape: a short list of facts, each one sentence in the
 * person's terms, filed under one of five fixed headings, carrying the
 * words it came from. There are no pages, no model-written prose and no
 * background passes that rewrite memory — the person can see every fact,
 * fix it or remove it in one click, and nothing the model "summarised"
 * stands between them and what they said.
 *
 * Laws (docs/ASSISTANT_CONTEXT.md "Assistant memory"):
 *   M1  A fact is the person's own. Chat extraction keeps a fact only when
 *       its `quote` appears verbatim in something the person typed
 *       (AgentService._extractMemories); an explicit save_memory is the
 *       person asking. Intentions are stored as intentions, never as done.
 *   M2  Upkeep is arithmetic, never a model verdict: the same text again
 *       re-confirms (updatedAt is the "last confirmed" clock); the same
 *       heading + subject with new text REPLACES the old text (kept as
 *       `was` for Undo); a fact unconfirmed for STALE_MS reads "as of …";
 *       past MAX_FACTS the oldest unstarred, least-recently-confirmed fact
 *       goes.
 *   M3  What a chat carries is decided here (forChat): every About you and
 *       Preferences fact plus starred ones, within CHAT_BUDGET characters;
 *       everything else is reached through recall_memory (search).
 *   M4  The person is the editor. edit/forget/restore are theirs; the
 *       assistant's update/delete tools act only on an explicit ask.
 *   M5  Never from a private or no-personal-context chat, never from a turn
 *       that read untrusted content (enforced by the callers).
 *
 * Storage: the `memory` key, written only by this Mac. The pre-2026-10-01
 * stores (`agent-memories`, `agent-memory-profile`) are cleared once on
 * first load — the redesign started memory from scratch by decision.
 */
const MemoryManager = {
    STORE_KEY: 'memory',
    LEGACY_KEYS: ['agent-memories', 'agent-memory-profile'],

    // Pages (2026-10-01): these six always exist; the assistant may start
    // more ("Kids' school", "Health") when a topic gathers its own facts —
    // a page is just a heading with a label, stored in `pages`.
    HEADINGS: [
        { id: 'about', label: 'About you' },
        { id: 'people', label: 'People' },
        { id: 'work', label: 'Work' },
        { id: 'preferences', label: 'Preferences' },
        { id: 'plans', label: 'Plans' },
        { id: 'email', label: 'Email' }
    ],
    // What nenva shows from email, said as facts (EmailApp reads this page;
    // docs/EMAIL_AI.md "Email preferences are memory"). Seeded once; the
    // person edits or deletes them like any fact.
    EMAIL_DEFAULTS: [
        'Show me bills, renewals, appointments, reservations, deliveries, deadlines, sign-in codes and security alerts.',
        'Skip ads, promotions, newsletters and offers, even when they mention a deadline.',
        'Only make a task when I have to do something by a date.',
        'Receipts are worth keeping, but they never need me.'
    ],
    // Carried into every chat (M3); the rest is searched on demand.
    ALWAYS_HEADINGS: ['about', 'preferences'],

    MAX_FACTS: 200,
    TEXT_MAX: 240,
    QUOTE_MAX: 300,
    CHAT_BUDGET: 3000,
    STALE_MS: 180 * 24 * 60 * 60 * 1000,

    facts: [],
    pages: {},      // custom page id → label
    seeded: {},     // page id → true once its defaults were added
    _loaded: false,
    // Facts the assistant forgot this session, by id — the chat note's Undo.
    _forgotten: new Map(),
    _listeners: new Set(),

    init() {
        if (this._loaded) return;
        this._loaded = true;
        try {
            const data = StorageManager.get(this.STORE_KEY);
            this.facts = (data && Array.isArray(data.facts)) ? data.facts.filter(f => f && f.id && f.text) : [];
            this.pages = (data && data.pages && typeof data.pages === 'object') ? data.pages : {};
            this.seeded = (data && data.seeded && typeof data.seeded === 'object') ? data.seeded : {};
        } catch (e) {
            console.warn('[memory] load failed:', e);
            this.facts = [];
        }
        this._clearLegacyOnce();
        this._seedEmailOnce();
    },

    _clearLegacyOnce() {
        try {
            if (localStorage.getItem('memory-legacy-cleared') === '1') return;
            // clear (a delete), never set({}): a record-merged write would be
            // unioned with the stored copy and keep every old record.
            for (const key of this.LEGACY_KEYS) {
                if (StorageManager.get(key) != null) StorageManager.clear(key);
            }
            localStorage.removeItem('memory-health');
            localStorage.setItem('memory-legacy-cleared', '1');
        } catch { /* best-effort; a retry next launch is harmless */ }
    },

    _seedEmailOnce() {
        if (this.seeded.email) return;
        const now = new Date().toISOString();
        for (const text of this.EMAIL_DEFAULTS) {
            if (this.facts.some(f => this._norm(f.text) === this._norm(text))) continue;
            this.facts.push({ id: this._newId(), text, heading: 'email', source: 'default', starred: false, createdAt: now, updatedAt: now });
        }
        this.seeded.email = true;
        this._save();
    },

    _save() {
        try {
            StorageManager.set(this.STORE_KEY, { facts: this.facts, pages: this.pages, seeded: this.seeded });
        } catch (e) {
            console.warn('[memory] save failed:', e);
        }
        for (const fn of this._listeners) { try { fn(); } catch { /* a listener never breaks a write */ } }
        try { if (typeof AgentService !== 'undefined') AgentService._briefingCache?.clear(); } catch { /* ignore */ }
    },

    /** Called after every change — the Memory page repaints from it. */
    onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); },

    _norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); },
    _clean(s, max) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max); },
    _newId() { return 'fact_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); },
    /**
     * A page id from what a caller passed: a known page by id or label, or
     * a NEW page from a short name ("Kids' school" -> kids-school, labelled
     * as given) — only with `create`, which the assistant's deliberate
     * save_memory passes; background capture never scatters new pages from
     * a stray word. Unknown, empty or junk falls back to About you.
     */
    headingOf(input, { create = false } = {}) {
        const raw = String(input || '').trim();
        if (!raw) return 'about';
        const low = raw.toLowerCase();
        const known = this.listPages().find(p => p.id === low || p.label.toLowerCase() === low);
        if (known) return known.id;
        const id = low.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
        if (!id) return 'about';
        if (this.pages[id]) return id;
        if (!create) return 'about';
        if (!this.pages[id]) this.pages[id] = raw.replace(/\s+/g, ' ').slice(0, 40);
        return id;
    },
    headingLabel(id) {
        const d = this.HEADINGS.find(h => h.id === id);
        return d ? d.label : (this.pages[id] || this.HEADINGS[0].label);
    },
    /** Every page: the six built-ins, then the ones the assistant started. */
    listPages() {
        const custom = Object.entries(this.pages || {}).filter(([id]) => !this.HEADINGS.some(h => h.id === id))
            .map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
        return [...this.HEADINGS, ...custom];
    },
    /** Facts on one page, newest first. */
    onPage(id) { return this.all().filter(f => f.heading === id); },

    all() {
        this.init();
        return this.facts.slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    },

    get(id) {
        this.init();
        return this.facts.find(f => f.id === id) || null;
    },

    /**
     * The one write path for new facts (M2). Returns
     * { fact, status: 'new' | 'confirmed' | 'updated', was? } or { error }.
     */
    remember({ text, heading, subject, quote, convId, source, meta, newPage = false } = {}) {
        this.init();
        const clean = this._clean(text, this.TEXT_MAX);
        if (!clean) return { error: 'text is required' };
        const h = this.headingOf(heading, { create: newPage });
        const subj = this._clean(subject, 60).toLowerCase();
        const now = new Date().toISOString();

        const same = this.facts.find(f => this._norm(f.text) === this._norm(clean));
        if (same) {
            same.updatedAt = now;
            this._save();
            return { fact: same, status: 'confirmed' };
        }
        const prior = subj ? this.facts.find(f => f.heading === h && f.subject === subj) : null;
        if (prior) {
            const was = { text: prior.text, at: prior.updatedAt };
            Object.assign(prior, {
                text: clean, was, updatedAt: now,
                ...(meta ? { meta } : {}),
                ...(quote ? { quote: this._clean(quote, this.QUOTE_MAX) } : {}),
                ...(convId ? { convId } : {}),
                source: source || prior.source
            });
            this._save();
            return { fact: prior, status: 'updated', was: was.text };
        }
        const fact = {
            id: this._newId(),
            text: clean,
            heading: h,
            ...(subj ? { subject: subj } : {}),
            ...(quote ? { quote: this._clean(quote, this.QUOTE_MAX) } : {}),
            ...(convId ? { convId } : {}),
            ...(meta && typeof meta === 'object' ? { meta } : {}),
            source: source || 'chat',
            starred: false,
            createdAt: now,
            updatedAt: now
        };
        this.facts.unshift(fact);
        this._evictOverCap();
        this._save();
        return { fact, status: 'new' };
    },

    _evictOverCap() {
        while (this.facts.length > this.MAX_FACTS) {
            const victims = this.facts.filter(f => !f.starred)
                .sort((a, b) => (a.updatedAt || '').localeCompare(b.updatedAt || ''));
            if (!victims.length) return;
            this.facts = this.facts.filter(f => f.id !== victims[0].id);
        }
    },

    /** The person's edit (M4): text, heading, starred. */
    edit(id, patch = {}) {
        this.init();
        const f = this.get(id);
        if (!f) return null;
        if (patch.text !== undefined) {
            const t = this._clean(patch.text, this.TEXT_MAX);
            if (!t) return null;
            if (t !== f.text) f.was = { text: f.text, at: f.updatedAt };
            f.text = t;
        }
        if (patch.heading !== undefined) f.heading = this.headingOf(patch.heading);
        if (patch.starred !== undefined) f.starred = !!patch.starred;
        f.updatedAt = new Date().toISOString();
        this._save();
        return f;
    },

    /** Facts on a page whose subject starts with a prefix ("mute:"). */
    bySubject(page, prefix) {
        return this.onPage(page).filter(f => (f.subject || '').startsWith(prefix));
    },

    /** Remove a fact by page + exact subject (e.g. unmute). */
    forgetSubject(page, subject) {
        const f = this.facts.find(x => x.heading === page && x.subject === subject);
        return f ? this.forget(f.id) : null;
    },

    /** Remove a fact. Returns it, so the caller can offer Undo (restore). */
    forget(id) {
        this.init();
        const f = this.get(id);
        if (!f) return null;
        this.facts = this.facts.filter(x => x.id !== id);
        this._save();
        return f;
    },

    restore(fact) {
        this.init();
        if (!fact || !fact.id || this.get(fact.id)) return;
        this.facts.unshift(fact);
        this._save();
    },

    /** Put an updated fact's previous wording back (the chat note's Undo). */
    revert(id) {
        const f = this.get(id);
        if (!f || !f.was) return null;
        f.text = f.was.text;
        delete f.was;
        f.updatedAt = new Date().toISOString();
        this._save();
        return f;
    },

    /** Plain word search, best match first (recall_memory, the page's box). */
    search(query, { limit = 12 } = {}) {
        this.init();
        const words = this._norm(query).split(' ').filter(w => w.length > 1);
        if (!words.length) return [];
        const scored = [];
        for (const f of this.facts) {
            const hay = this._norm(`${f.text} ${f.subject || ''} ${this.headingLabel(f.heading)}`);
            const hits = words.filter(w => hay.includes(w)).length;
            if (hits) scored.push({ f, hits });
        }
        scored.sort((a, b) => b.hits - a.hits || (b.f.updatedAt || '').localeCompare(a.f.updatedAt || ''));
        return scored.slice(0, limit).map(s => s.f);
    },

    isStale(f, now = Date.now()) {
        const t = Date.parse((f && f.updatedAt) || '') || 0;
        return t > 0 && now - t > this.STALE_MS;
    },

    asOfLabel(f) {
        if (!this.isStale(f)) return '';
        const d = new Date(Date.parse(f.updatedAt));
        return `as of ${d.toLocaleString('en-US', { month: 'short', year: 'numeric' })}`;
    },

    /** Facts the person should glance at: not confirmed in six months. */
    needsLook() {
        return this.all().filter(f => !f.starred && this.isStale(f));
    },

    /**
     * What a chat carries (M3): About you, Preferences and starred facts,
     * newest first, within CHAT_BUDGET; `rest` counts what recall reaches.
     */
    forChat() {
        const all = this.all();
        const want = all.filter(f => f.starred || this.ALWAYS_HEADINGS.includes(f.heading));
        const always = [];
        let used = 0;
        for (const f of want) {
            const len = f.text.length + 4;
            if (used + len > this.CHAT_BUDGET) break;
            always.push(f);
            used += len;
        }
        const shown = new Set(always.map(f => f.id));
        const restFacts = all.filter(f => !shown.has(f.id));
        const pages = [...new Set(restFacts.map(f => this.headingLabel(f.heading)))];
        return { always, rest: restFacts.length, pages };
    },

    /** One prompt line for a fact: text plus its "as of" label when stale. */
    line(f) {
        const asOf = this.asOfLabel(f);
        return `- ${f.text}${asOf ? ` (${asOf})` : ''}`;
    }
};
