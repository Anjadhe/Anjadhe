/**
 * CloudPrivacy — what AMBIENT AI work may send off this Mac.
 *
 * The app is private by default; a non-local brain (Anjadhe Cloud, OpenAI,
 * Anthropic, the user's own server) makes every prompt leave the machine.
 * A chat turn is the user's explicit act and is never gated here. Ambient
 * work — the email insight sweep, thread judgments, routine runs, goal
 * reviews — is the app deciding on its own to send something, and THAT is
 * what this module governs, per class of data rather than per app or per
 * cost (docs/CLOUD_PRIVACY.md, law L2; `AgentService.isMeteredBrain` stays
 * the cost gate and is unrelated).
 *
 * Two enforcement points, both reading the same `allows()`:
 *   - `LLMLogger.call/stream` map a known ambient SOURCE tag to a class and
 *     refuse the send (the safety net: no ambient email prompt can reach a
 *     cloud brain through any path).
 *   - `AgentTools.execute` maps a READ tool to a class when the run is
 *     ambient (`ctx.ambient`: routine runs, routine-born tasks) and answers
 *     the model with a refusal it can relay, instead of the data.
 * Sites that own a loop (the email drain) also check up front so they skip
 * cleanly instead of failing per item.
 *
 * The arithmetic is pure (`decide`) and pinned by tests/cloud-privacy-test.js.
 * Stored in the SYNCED `cloud-privacy` key: the choice is about the person's
 * data, not this Mac's capability (the opposite call from model settings).
 */

const CloudPrivacy = {
    KEY: 'cloud-privacy',

    // Order is display order. `off` = default when the user has said nothing.
    CLASSES: [
        { id: 'email',     label: 'Email',          desc: 'Message bodies and attachments, for insights, thread status and routines.' },
        { id: 'notes',     label: 'Notes',          desc: 'Note contents read by routines and goal reviews.' },
        { id: 'journal',   label: 'Journal',        desc: 'Journal entries. Off by default: the most personal writing in the app.', off: true },
        { id: 'wellness',  label: 'Wellness',       desc: 'Vitals, meals, sleep, mood and medication logs. Off by default.', off: true },
        { id: 'portfolio', label: 'Portfolio',      desc: 'Holdings, balances, transactions and strategy text.' },
        { id: 'browse',    label: 'Web pages',      desc: 'The text of pages a routine reads with read_url.' },
        { id: 'files',     label: 'Files',          desc: 'Files a routine reads from the Anjadhe folder.' }
    ],

    // Ambient LLMLogger source tags → class. Interactive sources (chat,
    // email-compose, maker) are deliberately absent: a user who asked gets
    // an answer. Memory extraction is absent too — it reads a conversation
    // that already went to the brain, so nothing new leaves.
    SOURCE_CLASS: {
        'email': 'email', 'email-threads': 'email', 'email-attachment': 'email',
        'email-reservation': 'email', 'email-txn': 'email', 'email-bundles': 'email'
    },

    // READ tools → class. Writes are not here: a routine that creates a
    // journal entry sends the model's text to the Mac, not the Mac's text to
    // the model. Names not listed are ungated (calendar, schedule, goals,
    // search queries: dated facts, not the user's prose).
    TOOL_CLASS: {
        list_emails: 'email', get_email: 'email', list_email_analyses: 'email',
        read_email_attachment: 'email', scan_emails: 'email',
        list_notes: 'notes', get_note: 'notes',
        list_journal: 'journal',
        list_wellness: 'wellness', wellness_summary: 'wellness',
        list_portfolio: 'portfolio', get_ticker_detail: 'portfolio', get_strategy: 'portfolio',
        check_strategy: 'portfolio',
        read_url: 'browse',
        fs_read: 'files', fs_list: 'files', fs_search: 'files', read_creation: 'files',
        read_library_doc: 'files'
    },

    _data: null,

    // ── Pure core (Node-testable) ──────────────────────────────────────

    /** Default on/off map from CLASSES. */
    defaults() {
        const out = {};
        for (const c of this.CLASSES) out[c.id] = !c.off;
        return out;
    },

    /**
     * The one decision. `settings` is the stored {classId: bool} map (may be
     * partial or null); `brainLeaves` says whether the default brain runs
     * off this Mac. Unknown classes are allowed — a gate that fails closed
     * on a typo would silently kill features, and every gated class is
     * enumerated above.
     */
    decide(cls, settings, brainLeaves) {
        if (!brainLeaves) return { allowed: true };
        const known = this.CLASSES.find(c => c.id === cls);
        if (!known) return { allowed: true };
        const on = settings && typeof settings[cls] === 'boolean' ? settings[cls] : !known.off;
        if (on) return { allowed: true };
        return {
            allowed: false,
            reason: `${known.label} stays on this Mac: the current AI model runs off this Mac and ambient `
                + `${known.label.toLowerCase()} access is off in Settings › AI Assistant › Cloud privacy. `
                + 'Asking in chat still works.'
        };
    },

    // ── Renderer wiring ────────────────────────────────────────────────

    _load() {
        if (this._data) return this._data;
        let d = null;
        try { d = (typeof StorageManager !== 'undefined') ? StorageManager.get(this.KEY) : null; } catch { /* first run */ }
        this._data = (d && typeof d === 'object') ? d : {};
        if (!this._data.classes || typeof this._data.classes !== 'object') this._data.classes = {};
        if (!this._data.seen || typeof this._data.seen !== 'object') this._data.seen = {};
        return this._data;
    },

    _save() {
        try { StorageManager.set(this.KEY, this._data); } catch (e) { console.warn('cloud-privacy save failed', e); }
    },

    /** Does the default brain run off this Mac? No brain → nothing leaves. */
    brainLeaves() {
        try {
            const entry = AgentService.getDefaultEntry?.();
            return !!(entry && entry.engine && entry.engine !== 'llamacpp');
        } catch { return false; }
    },

    /** Display name of where ambient work would go. */
    brainDestination() {
        try {
            const entry = AgentService.getDefaultEntry?.();
            if (!entry) return null;
            if (entry.engine === 'anjadhe') return AgentService.anjadheEntryLabel(entry);
            if (entry.engine === 'openai') return 'OpenAI';
            if (entry.engine === 'anthropic') return 'Anthropic';
            if (entry.engine === 'server') return 'your server';
            return null;
        } catch { return null; }
    },

    isEnabled(cls) {
        const s = this._load().classes;
        if (typeof s[cls] === 'boolean') return s[cls];
        const known = this.CLASSES.find(c => c.id === cls);
        return known ? !known.off : true;
    },

    setEnabled(cls, on) {
        this._load().classes[cls] = !!on;
        this._save();
    },

    allows(cls) {
        return this.decide(cls, this._load().classes, this.brainLeaves()).allowed;
    },

    reasonBlocked(cls) {
        return this.decide(cls, this._load().classes, this.brainLeaves()).reason || null;
    },

    /**
     * LLMLogger's safety net: a known ambient source on a blocked class
     * returns the refusal result the caller would have gotten from a failed
     * call, and records the skip once per class per session in AI Activity.
     */
    guardSource(source) {
        const cls = this.SOURCE_CLASS[source];
        if (!cls) return null;
        const d = this.decide(cls, this._load().classes, this.brainLeaves());
        if (d.allowed) return null;
        this._noteBlocked(cls, source);
        return { error: d.reason, blocked: true, blockedClass: cls };
    },

    /** AgentTools' gate for ambient runs. */
    guardTool(name, ctx) {
        if (!ctx || !ctx.ambient) return null;
        const cls = this.TOOL_CLASS[name];
        if (!cls) return null;
        const d = this.decide(cls, this._load().classes, this.brainLeaves());
        if (d.allowed) return null;
        this._noteBlocked(cls, name);
        return { error: d.reason, blocked: true, blockedClass: cls };
    },

    _notedThisSession: new Set(),
    _noteBlocked(cls, what) {
        // One AI Activity row per class per session: the point is that the
        // user can see the skip happened, not a row per email.
        const key = cls;
        if (this._notedThisSession.has(key)) return;
        this._notedThisSession.add(key);
        try {
            const known = this.CLASSES.find(c => c.id === cls);
            AIActivity.noteBlocked?.({
                label: `${known ? known.label : cls} kept on this Mac`,
                desc: `Ambient AI skipped ${what} because ${known ? known.label.toLowerCase() : cls} may not leave this Mac while the model runs on ${this.brainDestination() || 'a server'}.`,
                cls
            });
        } catch { /* activity is a courtesy */ }
    },

    /** Reset the once-per-session note when the gate changes. */
    _resetNotes() { this._notedThisSession = new Set(); },

    // ── Send less: minimize an email body before it leaves ─────────────

    /**
     * Strip what a model never needs from an email body: quoted history
     * ("On … wrote:" and "> " lines), the signature after "-- ", tracking
     * query strings on links, and runs of whitespace. Pure text arithmetic,
     * pinned by tests/cloud-privacy-test.js. Applied only when the brain
     * leaves the Mac (`bodyForModel`): locally the extra context is free and
     * occasionally useful ("yes, see below").
     */
    minimize(text) {
        let t = String(text || '');
        // Quoted history: cut at the first reply header or forwarded block.
        const cut = t.search(/\n\s*(On .{4,120}wrote:\s*\n|-{3,}\s*Original Message\s*-{3,}|_{5,}\s*\n\s*From:|From: .{1,120}\nSent: )/i);
        if (cut > 40) t = t.slice(0, cut);
        // Signature delimiter.
        const sig = t.search(/\n--\s*\n/);
        if (sig > 40) t = t.slice(0, sig);
        // Remaining "> " quote lines.
        t = t.split('\n').filter(l => !/^\s*>/.test(l)).join('\n');
        // Tracking query strings and bare tracking pixels/links.
        t = t.replace(/(https?:\/\/[^\s?#]+)\?[^\s]*/g, '$1');
        // Whitespace.
        t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        return t;
    },

    /** The email body a prompt may carry: minimized when it would leave. */
    bodyForModel(text, max) {
        const t = this.brainLeaves() ? this.minimize(text) : String(text || '');
        return max ? t.slice(0, max) : t;
    },

    // ── First-use disclosure ───────────────────────────────────────────

    hasSeen(key) { return !!this._load().seen[key]; },
    markSeen(key) { this._load().seen[key] = new Date().toISOString(); this._save(); },

    /**
     * Shown once when the default brain first becomes one that leaves the
     * Mac: what ambient work will send, what stays home, and the door to
     * change it. Returns after the user dismisses it. Never blocks the
     * selection — the choice was already made; this says what it means.
     */
    async discloseIfNeeded() {
        if (!this.brainLeaves() || this.hasSeen('brain-leaves')) return;
        if (typeof Modal === 'undefined' || !Modal.create) return;
        this.markSeen('brain-leaves');
        const dest = this.brainDestination() || 'a server off this Mac';
        const on = this.CLASSES.filter(c => this.isEnabled(c.id)).map(c => c.label);
        const off = this.CLASSES.filter(c => !this.isEnabled(c.id)).map(c => c.label);
        const esc = (s) => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
        await new Promise((resolve) => {
            const modal = Modal.create({
                title: `Your AI model now runs on ${esc(dest)}`,
                className: 'confirm-dialog cloud-privacy-disclosure',
                content: `
                    <div class="confirm-message">
                        <p>Everything you ask in chat goes there, exactly as you typed it. Anjadhe also does work on its own — email insights, routines, reviews. Here is what that work may send:</p>
                        <p><strong>May leave this Mac:</strong> ${on.length ? esc(on.join(', ')) : 'nothing'}</p>
                        <p><strong>Stays on this Mac:</strong> ${off.length ? esc(off.join(', ')) : 'nothing held back'}</p>
                        <p>Change any of this in Settings › AI Assistant › Cloud privacy. Every request that leaves this Mac is listed in Settings › LLM Logs under "Left this Mac".</p>
                    </div>`,
                buttons: [
                    { text: 'Open settings', className: 'secondary-btn', onClick: () => { modal.close(); resolve(); try { SettingsApp.openLLMSection?.('llm-sec-privacy'); } catch { /* best effort */ } } },
                    { text: 'OK', className: 'primary-btn', onClick: () => { modal.close(); resolve(); } }
                ]
            });
        });
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = CloudPrivacy;
