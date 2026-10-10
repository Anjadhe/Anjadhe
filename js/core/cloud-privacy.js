/**
 * CloudPrivacy — what AMBIENT AI work may send off this Mac.
 *
 * The app is private by default; a non-local brain (nenva cloud, OpenAI,
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
        { id: 'email',     label: 'Email',          desc: 'Message bodies and attachments, for insights and routines.' },
        { id: 'messages',  label: 'Messages',       desc: 'iMessage and SMS conversations read for insights. Opened and closed by the Texts switch itself (one consent, 2026-10-09).', off: true },
        { id: 'notes',     label: 'Notes',          desc: 'Note contents read by routines and project reviews.' },
        { id: 'portfolio', label: 'Portfolio',      desc: 'Holdings, balances, transactions and strategy text.' },
        { id: 'spending',  label: 'Spending',       desc: 'Bank and card transactions and balances. Off by default.', off: true, feature: 'spending' },
        { id: 'browse',    label: 'Web pages',      desc: 'The text of pages a routine reads with read_url.' },
        // The coach's background looks at health goals (docs/COACH.md, 2026-10-09):
        // off until the person answers the one-tap question on Now.
        { id: 'health',    label: 'Health goals',   desc: 'Readings and words on health goals, read by the coach between chats. Asked once with a tap.', off: true },
        { id: 'files',     label: 'Files',          desc: 'Files a routine reads from your nenva folder.' }
    ],

    // Ambient LLMLogger source tags → class. Interactive sources (chat,
    // email-compose) are deliberately absent: a user who asked gets
    // an answer. Memory extraction is absent too — it reads a conversation
    // that already went to the brain, so nothing new leaves.
    SOURCE_CLASS: {
        'email': 'email', 'email-attachment': 'email',
        'email-reservation': 'email', 'email-event': 'email', 'email-txn': 'email', 'email-bundles': 'email',
        // Texts (js/apps/email/imessage-source.js) ride the email engine's
        // passes under their own tag family, gated by their own class.
        'imessage': 'messages', 'imessage-reservation': 'messages', 'imessage-event': 'messages', 'imessage-txn': 'messages',
        // The assistant's own looks (docs/PROACTIVE.md P6): meeting prep
        // reads the last email with the attendees; follow-ups read mail the
        // person sent. Both are email.
        'proactive-prep': 'email', 'proactive-followup': 'email',
        // What reaches the phone (js/core/phone-reach.js): the assistant
        // writes a card, a commitment or an approval as a message.
        'phone-reach': 'email', 'phone-reach-text': 'messages',
        // Trips (js/core/trips.js) read the bookings and the mail around them.
        'trip-review': 'email',
        // Matters (js/core/matters.js): the assistant files each message.
        'email-matter': 'email', 'imessage-matter': 'messages',
        // What the person said about a folder in its chat (js/agent/matter-capture.js):
        // the call shows the folder, which holds what its mail or texts said.
        'matter-chat': 'email', 'matter-chat-text': 'messages',
        // The one chat judge for any other thing's card (js/agent/thing-capture.js): the card's own words.
        'thing-chat': 'email',
        // The person's own tasks and events as sources (js/core/matter-sources.js):
        // triage shows their titles only; the filing call also shows folders mail filled.
        'matter-triage': 'notes', 'matter-own': 'email',
        // Today's rows carry task titles and their source email's sender.
        'today-help': 'email',
        // Check-ins read tasks, projects and what memory holds about plans.
        'check-ins': 'notes',
        // The money coach reads the money sheet (js/core/money-facts.js);
        // the spending and email parts are withheld there by their own classes.
        'money-coach': 'portfolio',
        // The goal coach (js/core/coach.js): a look per area. Health readings
        // are their own class; the other areas read commitments like Check-ins.
        'coach-health': 'health', 'coach-fitness': 'notes', 'coach-parenting': 'notes', 'coach-learning': 'notes', 'coach-adopt': 'notes',
        // A bank row settles the bill it paid (js/core/money-settle.js): the rows are bank data.
        'money-settle': 'spending',
        // Now's order reads card titles, some from email; a card's "where it
        // stands" line reads the card and its chat (js/core/simple-experience.js cardStandingHtml).
        'now-order': 'email', 'now-standing': 'email',
        // Work plans read tasks, the calendar and memory preferences.
        'work-plan': 'notes',
        // Converting routines reads their instructions and last results,
        // which can quote mail (js/core/routine-convert.js).
        'routine-convert': 'email'
    },

    // READ tools → class. Writes are not here: a routine that creates a
    // journal entry sends the model's text to the Mac, not the Mac's text to
    // the model. Names not listed are ungated (calendar, schedule, goals,
    // search queries: dated facts, not the user's prose).
    TOOL_CLASS: {
        list_emails: 'email', get_email: 'email', list_email_analyses: 'email',
        read_email_attachment: 'email', scan_emails: 'email',
        // A lookup reads exactly one channel; text contacts keep the messages gate.
        find_contact: 'email', // text lookups select messages in guardTool below
        list_notes: 'notes', get_note: 'notes',
        // Packages add their own rows through AgentTools.register `dataClass`.
        read_url: 'browse',
        fs_read: 'files', fs_list: 'files', fs_search: 'files'
        // read_library_doc: registered by the Documents package (dataClass 'files').
    },

    _data: null,

    // ── Pure core (Node-testable) ──────────────────────────────────────

    /**
     * The classes a person is SHOWN (Settings, the first-leave dialog). A
     * class whose app sits behind an off feature flag has nothing to govern
     * and is left out; its gate still answers as before.
     */
    shownClasses() {
        return this.CLASSES.filter(c => !c.feature || typeof FEATURES === 'undefined' || FEATURES.isEnabled(c.feature));
    },

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
            // "the model doing this work", not "your AI model": with
            // per-surface routing the model that would read this is not
            // always the brain (model-routing.js R4).
            reason: `${known.label} stays on this Mac: the model doing this work runs off this Mac and ambient `
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
        return this._leaves(this._entry(null));
    },

    /**
     * Does the model answering THIS ambient source run off the Mac?
     *
     * The gate follows the DESTINATION, never the brain (model-routing.js
     * R4): a surface the user pointed at a local model stays home even
     * under a cloud brain, and a surface pointed at the cloud is gated even
     * when the brain is local — without this, assigning email to a cloud
     * model would send every message body off the Mac with no gate at all.
     */
    leavesFor(source) {
        return this._leaves(this._entry(source));
    },

    /** Is ANY model in play off this Mac? (Settings copy about the whole app.) */
    anyLeaves() {
        if (this.brainLeaves()) return true;
        try {
            return (ModelRouting.SURFACES || []).some(s => this._leaves(AgentService.entryForSurface?.(s.id)));
        } catch { return false; }
    },

    /** Display name of where ambient work would go. */
    brainDestination() {
        return this.destinationFor(null);
    },

    /** Where work from THIS source would go, by name. */
    destinationFor(source) {
        return this._destination(this._entry(source));
    },

    // The entry answering a source — the brain when `source` is null or
    // routing isn't loaded. One resolver so every question below (leaves,
    // destination, the refusal sentence) names the same model.
    _entry(source) {
        try {
            if (source && AgentService.entryForSource) return AgentService.entryForSource(source);
            return AgentService.getDefaultEntry?.() || null;
        } catch { return null; }
    },

    _leaves(entry) {
        return !!(entry && entry.engine && entry.engine !== 'llamacpp');
    },

    _destination(entry) {
        try {
            if (!entry) return null;
            if (entry.engine === 'anjadhe') return AgentService.displayModelName(entry);
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

    /** allows(), asked of the model that answers `source` (R4). */
    allowsFor(cls, source) {
        return this.decide(cls, this._load().classes, this.leavesFor(source)).allowed;
    },

    reasonBlocked(cls) {
        return this.decide(cls, this._load().classes, this.brainLeaves()).reason || null;
    },

    reasonBlockedFor(cls, source) {
        return this.decide(cls, this._load().classes, this.leavesFor(source)).reason || null;
    },

    /**
     * LLMLogger's safety net: a known ambient source on a blocked class
     * returns the refusal result the caller would have gotten from a failed
     * call, and records the skip once per class per session in AI Activity.
     */
    guardSource(source) {
        // Monitoring consent is scoped to a Slack account, conversations and
        // model on this Mac. The generic logger has neither that grant nor the
        // durable request budget, even when the default model is local.
        if (/^slack-(?:monitor|matter)(?:-|$)/.test(String(source || ''))) {
            return { error: 'Slack monitoring requires its approved, bounded analysis path.', blocked: true, blockedClass: 'slack' };
        }
        const cls = this.SOURCE_CLASS[source];
        if (!cls) return null;
        const d = this.decide(cls, this._load().classes, this.leavesFor(source));
        if (d.allowed) return null;
        this._noteBlocked(cls, source, source);
        return { error: d.reason, blocked: true, blockedClass: cls };
    },

    /**
     * AgentTools' gate for ambient runs. `ctx.source` names the LLMLogger
     * tag the run's model calls carry ('prompt-feed' for a routine, 'task'
     * for task mode) so the tool gate and the send gate can't disagree
     * about where this run's work goes.
     */
    guardTool(name, ctx, args) {
        if (!ctx || !ctx.ambient) return null;
        const cls = name === 'find_contact' && args?.channel === 'text' ? 'messages' : this.TOOL_CLASS[name];
        if (!cls) return null;
        const d = this.decide(cls, this._load().classes, this.leavesFor(ctx.source || null));
        if (d.allowed) return null;
        this._noteBlocked(cls, name, ctx.source || null);
        return { error: d.reason, blocked: true, blockedClass: cls };
    },

    _notedThisSession: new Set(),
    _noteBlocked(cls, what, source) {
        // One activity row per class per session, shown as a "Kept on this
        // Mac" line on the Data activity ledger (Developer; 2026-10-07):
        // the point is that the person can see the skip happened, not a row
        // per email.
        const key = cls;
        if (this._notedThisSession.has(key)) return;
        this._notedThisSession.add(key);
        try {
            const known = this.CLASSES.find(c => c.id === cls);
            AIActivity.noteBlocked?.({
                label: `${known ? known.label : cls} kept on this Mac`,
                desc: `Ambient AI skipped ${what} because ${known ? known.label.toLowerCase() : cls} may not leave this Mac while the model runs on ${this.destinationFor(source) || 'a server'}.`,
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
    // `source` names the ambient work, so the minimization follows the
    // model that will actually read the body (model-routing.js R4) rather
    // than the brain; omitted, it asks about the brain as before.
    bodyForModel(text, max, source) {
        const t = this.leavesFor(source || null) ? this.minimize(text) : String(text || '');
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
        const on = this.shownClasses().filter(c => this.isEnabled(c.id)).map(c => c.label);
        const off = this.shownClasses().filter(c => !this.isEnabled(c.id)).map(c => c.label);
        const esc = (s) => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
        await new Promise((resolve) => {
            const modal = Modal.create({
                title: `Your AI model now runs on ${esc(dest)}`,
                className: 'confirm-dialog cloud-privacy-disclosure',
                content: `
                    <div class="confirm-message">
                        <p>Everything you ask in chat goes there, exactly as you typed it. nenva also does work on its own — email insights, routines, reviews. Here is what that work may send:</p>
                        <p><strong>May leave this Mac:</strong> ${on.length ? esc(on.join(', ')) : 'nothing'}</p>
                        <p><strong>Stays on this Mac:</strong> ${off.length ? esc(off.join(', ')) : 'nothing held back'}</p>
                        <p>Settings › Privacy says this in sentences, and you can ask nenva what left this Mac.</p>
                    </div>`,
                buttons: [
                    { text: 'Open settings', className: 'secondary-btn', onClick: () => { modal.close(); resolve(); try { SimpleSettings.open('privacy'); } catch { /* settings not ready */ } } },
                    { text: 'OK', className: 'primary-btn', onClick: () => { modal.close(); resolve(); } }
                ]
            });
        });
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = CloudPrivacy;
