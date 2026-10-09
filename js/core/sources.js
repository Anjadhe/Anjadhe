/**
 * Sources — ONE registry of the outside places nenva reads (2026-10-06,
 * docs/VISION.md "Sources").
 *
 * A source is not a store: nenva reads it to organize what is in it into
 * commitments, matters, memory and the search index, and never grows a page
 * that is a copy of the source's own app. Two modes:
 *
 *   mirror     read whole (mail, calendars, tasks, notes, texts); where the
 *              person can edit on the other side the source stays the truth
 *              and nenva writes back what the person does here (calendars
 *              do; task apps will). A mirrored source is an OBSERVATION
 *              source: it can raise a card on Now.
 *   reference  read on demand (big stores: Notion, Google Docs, Drive): the
 *              assistant looks there when a thing needs it or the person
 *              asks, every read in the ledger; it never raises a card.
 *
 * Every adapter registers here and nowhere else; the Connectors page and
 * the Privacy page are generated from this table, so adding a source is one
 * registration. Built-in adapters: js/core/source-adapters.js. A package's
 * adapter registers from its own folder.
 *
 *   Sources.register({
 *     id, label, icon, words,            // the row: name, fallback icon, search words
 *     iconAsset,                        // optional official icon filename in js/core/connector-icons
 *     kind,                              // mail | calendar | tasks | notes | texts | files | docs
 *     mode: 'mirror' | 'reference',
 *     writesBack: bool,                  // the person's changes here reach the source
 *     reads: 'one sentence',             // what nenva reads, in the person's words (Privacy page)
 *     privacy: 'email' | 'messages' | … | ['portfolio', 'spending'],   // CloudPrivacy class its ambient work rides
 *     feeds: ['matters', 'commitments', 'calendar', 'index', 'memory'],
 *     status() → { on, value, detail?, error? },   // for the row and the Privacy line
 *     page(S) → html | null,             // the connector's own page (SimpleSettings builders)
 *     consent?: 'one sentence'           // asked at connect, when the source needs it (texts)
 *   })
 */
const Sources = {
    MODES: ['mirror', 'reference'],
    _list: [],

    register(def) {
        if (!def || !def.id || !def.label || typeof def.status !== 'function') return null;
        const d = { mode: 'mirror', writesBack: false, feeds: [], words: '', icon: 'plug', ...def };
        if (!this.MODES.includes(d.mode)) d.mode = 'mirror';
        this._list = this._list.filter(s => s.id !== d.id);
        this._list.push(d);
        return d;
    },
    list() { return this._list.slice(); },
    get(id) { return this._list.find(s => s.id === id) || null; },

    /** A source's live state, never throwing (a missing module reads as off). */
    status(id) {
        const s = typeof id === 'string' ? this.get(id) : id;
        if (!s) return { on: false, value: '' };
        try { return { on: false, value: '', ...(s.status() || {}) }; } catch { return { on: false, value: 'Not available' }; }
    },
    on() { return this._list.filter(s => this.status(s).on); },

    /**
     * One sentence per source for the Privacy page: what it reads, whether
     * the person's AI may see it, and whether that leaves this Mac. Code's
     * words from code's facts (docs/VISION.md principle 7).
     */
    privacyLines() {
        const brainLeaves = (() => { try { return typeof CloudPrivacy !== 'undefined' && CloudPrivacy.brainLeaves(); } catch { return false; } })();
        return this._list.map(s => {
            const st = this.status(s);
            const allowed = (() => { try { return typeof CloudPrivacy === 'undefined' || !s.privacy || (Array.isArray(s.privacy) ? s.privacy : [s.privacy]).every(kind => CloudPrivacy.isEnabled(kind)); } catch { return true; } })();
            let ai = '';
            if (st.on) {
                if (s.mode === 'reference') ai = 'Read only when you ask or a thing needs it; each read is in the ledger.';
                else if (!brainLeaves) ai = 'Read on this Mac; your AI runs here too, so none of it leaves.';
                else if (allowed) ai = 'Read on this Mac; what your AI needs from it may be sent to your model.';
                else ai = 'Read on this Mac; kept from your AI unless you allow it.';
            }
            return { id: s.id, label: s.label, on: st.on, value: st.value, reads: s.reads || '', ai, writesBack: !!s.writesBack, mode: s.mode };
        });
    }
};

if (typeof module !== 'undefined') module.exports = Sources;
