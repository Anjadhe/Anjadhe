/**
 * IMessageSource — texts as a source of insights (2026-09-10)
 * ============================================================
 * When the per-Mac switch is on (Settings › Accounts › iMessage › "Insights
 * from your texts"), this reads NEW messages from this Mac's Messages
 * database through main's imessage-reader, folds them into CONVERSATIONS,
 * and hands each conversation to the SAME insight engine that reads mail
 * (EmailApp.analyzeSingleEmail → the Email AI folders, the home card,
 * tasks, trips). Nothing new judges anything here: the model's relevance,
 * type, action and suppression rules are the email ones; this file only
 * decides what a "message" is.
 *
 * The unit is a conversation, not a text. A text is rarely a whole thought
 * ("ok", "see you at 3"), so lines from one chat are buffered and the
 * buffer CLOSES when the chat has been quiet for QUIET_MS, or it reaches
 * MAX_LINES, or it has been open for MAX_SPAN_MS — whichever first. A
 * closed buffer with at least one INCOMING line becomes one record (the
 * email engine's `_isIncoming` law: the user's own texts alone are never a
 * source); a buffer of only the user's own texts is dropped. The first
 * CONTEXT_LINES of the chat's previous record ride along as "earlier in
 * this conversation" so a reply is read in its thread.
 *
 * Records are email-SHAPED (messageId/from/subject/date/bodyText/labels)
 * because that is the engine's contract: EmailApp.emailById falls through
 * to registered insight sources, and everything downstream — rows,
 * detail, feedback, matters, task sync, record links, get_email — reads
 * the record like a message. `source: 'imessage'` is what the few
 * surfaces that must say "text, not email" key on. Ids are
 * `imsg:<message guid>` — the guid is Apple's and the same on every Mac
 * signed into the account, so the synced task ledger dedups across Macs
 * even though the records themselves are machine-local.
 *
 * Storage: the synced-key rule says the record blob is MACHINE-LOCAL
 * (`app_imessage-insights` in SYNC_EXCLUDE_KEYS — the Messages database is
 * this Mac's, and the records carry message text). Analyses land in the
 * machine-local email_analyses table like every other insight. The
 * per-Mac switch is localStorage (the AppleImport mould). Turning it OFF
 * forgets the records and their insights (the Gmail model: the source
 * owns the data); tasks already created stay — they are the user's.
 *
 * Privacy: every model call over a record carries the `imessage` source
 * tag, which CloudPrivacy maps to the `messages` class — OFF by default,
 * so with a cloud brain nothing leaves this Mac until the user says so
 * (docs/CLOUD_PRIVACY.md). The drain drops a blocked record from its queue
 * and `requeue()` offers it again when the gate opens.
 *
 * `fold` and `buildRecord` are pure and Node-exported
 * (tests/imessage-source-test.js).
 */
const IMessageSource = {
    ENABLED_KEY: 'imessage-insights',        // localStorage '1' = on (per-Mac)
    STORE_KEY: 'imessage-insights',          // StorageManager, machine-local
    PREFIX: 'imsg:',
    ACCOUNT: 'imessage',                     // the FYI page's account scope key
    LLM_TAG: 'imessage',                     // LLMLogger source → CloudPrivacy class 'messages'
    PRIVACY_CLASS: 'messages',

    QUIET_MS: 10 * 60 * 1000,                // a chat quiet this long closes its conversation
    MAX_LINES: 30,                           // …or this many lines
    MAX_SPAN_MS: 6 * 60 * 60 * 1000,         // …or this long since its first line
    CONTEXT_LINES: 5,                        // earlier lines carried into the next conversation
    INITIAL_LOOKBACK_DAYS: 3,                // first run: never the whole history
    RETENTION_DAYS: 90,                      // the Email AI page's own window
    MAX_RECORDS: 3000,
    POLL_MS: 60 * 1000,
    READ_LIMIT: 500,
    BODY_CHARS: 3000,                        // what analyzeSingleEmail reads (its own cap)
    SUBJECT_CHARS: 90,
    REQUEUE_WINDOW_MS: 3 * 24 * 60 * 60 * 1000,

    _data: null,
    _timer: null,
    _busy: false,
    _registered: false,
    _bootstrapped: false,

    // ── Switch + state ────────────────────────────────────────────────

    enabled() {
        try { return localStorage.getItem(this.ENABLED_KEY) === '1'; } catch { return false; }
    },

    /**
     * Flip the per-Mac switch. ON starts reading at once (the Settings card
     * awaits the first probe so a Full Disk Access denial shows while the
     * user is looking); OFF forgets the conversations read and their
     * insights, and stops the poll. Returns the probe result on enable.
     */
    async setEnabled(on) {
        try {
            if (on) localStorage.setItem(this.ENABLED_KEY, '1');
            else localStorage.removeItem(this.ENABLED_KEY);
        } catch { /* private mode: the switch just does not stick */ }
        if (on) {
            this._ensureData();
            this._startPolling();
            const probe = await this.probe();
            if (probe.ok) await this.tick('enable');
            return probe;
        }
        this._stopPolling();
        this.forget();
        return { ok: true };
    },

    /** Can this Mac read Messages right now? Counts only. */
    async probe() {
        if (!window.electronIMessage?.probe) return { ok: false, reason: 'platform', error: 'iMessage is only available on a Mac.' };
        const d = this._ensureData();
        try {
            const res = await window.electronIMessage.probe();
            d.lastError = res.ok ? null : (res.error || 'could not read Messages');
            d.lastErrorReason = res.ok ? null : (res.reason || 'other');
            this._save();
            return res;
        } catch (e) {
            d.lastError = String(e?.message || e);
            d.lastErrorReason = 'other';
            this._save();
            return { ok: false, reason: 'other', error: d.lastError };
        }
    },

    /** What the Settings card shows. */
    state() {
        const d = this._ensureData();
        return {
            enabled: this.enabled(),
            lastAt: d.lastAt || null,
            lastError: d.lastError || null,
            lastErrorReason: d.lastErrorReason || null,
            conversations: Object.keys(d.records || {}).length,
            open: Object.keys(d.open || {}).length,
            cursor: d.cursor || 0,
        };
    },

    // ── Wiring ────────────────────────────────────────────────────────

    /**
     * From AppManager.init — never from a view (the D5 rule: liveness must
     * not depend on Settings or Email AI being visited). Registers as an
     * insight source with the email engine (records resolve through
     * EmailApp.emailById from this point on), then polls while enabled.
     */
    init() {
        this._ensureData();
        this._register();
        if (this.enabled()) {
            this._startPolling();
            setTimeout(() => this.tick('init'), 4000);
        }
        // A window regaining focus is when a text just arrived on the
        // phone in the user's hand; don't make them wait out the poll.
        window.addEventListener('focus', () => { if (this.enabled()) this.tick('focus'); });
    },

    _register() {
        if (this._registered || typeof EmailApp === 'undefined' || !EmailApp.registerInsightSource) return;
        EmailApp.registerInsightSource({
            prefix: this.PREFIX,
            account: this.ACCOUNT,
            label: 'iMessage',
            privacyClass: this.PRIVACY_CLASS,
            llmTag: this.LLM_TAG,
            enabled: () => this.enabled(),
            recordById: (id) => this.recordById(id),
            records: () => this.records(),
            requeue: () => this.requeue(),
        });
        this._registered = true;
    },

    _startPolling() {
        if (this._timer) return;
        this._timer = setInterval(() => this.tick('poll'), this.POLL_MS);
    },

    _stopPolling() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    },

    // ── Records ───────────────────────────────────────────────────────

    _ensureData() {
        if (this._data) return this._data;
        let stored = null;
        try { stored = StorageManager.get(this.STORE_KEY); } catch { stored = null; }
        const d = (stored && typeof stored === 'object') ? stored : {};
        this._data = {
            cursor: Number(d.cursor) || 0,
            records: (d.records && typeof d.records === 'object') ? d.records : {},
            open: (d.open && typeof d.open === 'object') ? d.open : {},
            lastAt: d.lastAt || null,
            lastError: d.lastError || null,
            lastErrorReason: d.lastErrorReason || null,
            bootstrappedAt: d.bootstrappedAt || null,
        };
        return this._data;
    },

    _save() {
        if (!this._data) return;
        try { StorageManager.set(this.STORE_KEY, this._data); }
        catch (e) { console.warn('[imessage] save failed:', e?.message); }
    },

    records() {
        if (!this.enabled()) return [];
        return Object.values(this._ensureData().records);
    },

    recordById(id) {
        if (!id || !this.enabled()) return undefined;
        return this._ensureData().records[id];
    },

    /** The chat's most recent record, for the context lines. */
    _lastRecordForChat(chatKey) {
        let best = null;
        for (const r of Object.values(this._ensureData().records)) {
            if (r.chat?.key !== chatKey) continue;
            if (!best || (r.internalDate || 0) > (best.internalDate || 0)) best = r;
        }
        return best;
    },

    /**
     * Turning the switch off: drop the records, the open buffers and the
     * cursor, and let the email engine drop their analyses (its orphan
     * prune deletes any analysis whose record is gone). Tasks stay.
     */
    forget() {
        const d = this._ensureData();
        const ids = Object.keys(d.records);
        d.records = {};
        d.open = {};
        d.cursor = 0;
        d.lastAt = null;
        d.lastError = null;
        d.lastErrorReason = null;
        d.bootstrappedAt = null;
        this._save();
        if (ids.length && typeof EmailApp !== 'undefined' && EmailApp.dropSourceAnalyses) {
            EmailApp.dropSourceAnalyses(ids);
        }
        if (typeof Widgets !== 'undefined') Widgets.refresh();
        return ids.length;
    },

    // ── The read ──────────────────────────────────────────────────────

    /**
     * One pass: read what is new after the cursor, fold it into the open
     * buffers, close what is ready, mint records, queue them. Also runs
     * with NO new rows so a chat that simply went quiet still closes on
     * the next poll. Single-flight.
     */
    async tick(reason = '') {
        if (this._busy || !this.enabled()) return;
        if (!window.electronIMessage?.read) return;
        this._busy = true;
        try {
            const d = this._ensureData();
            const first = !d.cursor;
            const res = await window.electronIMessage.read({
                afterRowid: d.cursor || 0,
                limit: this.READ_LIMIT,
                sinceIso: first ? new Date(Date.now() - this.INITIAL_LOOKBACK_DAYS * 86400000).toISOString() : null,
            });
            if (!res || !res.ok) {
                d.lastError = (res && res.error) || 'could not read Messages';
                d.lastErrorReason = (res && res.reason) || 'other';
                this._save();
                return;
            }
            d.lastError = null;
            d.lastErrorReason = null;
            const now = Date.now();
            const folded = IMessageSource.fold(d.open, res.rows || [], now, this);
            d.open = folded.open;
            if (res.maxRowid > (d.cursor || 0)) d.cursor = res.maxRowid;
            // A first read that found nothing recent still needs a cursor,
            // or every poll would re-run the lookback query.
            if (first && !d.cursor && res.maxRowid) d.cursor = res.maxRowid;

            const fresh = [];
            for (const chunk of folded.closed) {
                const rec = IMessageSource.buildRecord(chunk, this._lastRecordForChat(chunk.chatKey), this);
                if (!rec) continue;
                if (d.records[rec.messageId]) continue;   // the same guid closed twice: keep the first
                d.records[rec.messageId] = rec;
                fresh.push(rec);
            }
            this._prune(d, now);
            d.lastAt = new Date(now).toISOString();
            // The backfill on enable is not "new mail": it must not ring
            // the phone for three days of already-seen texts.
            const notify = !!d.bootstrappedAt;
            if (!d.bootstrappedAt) d.bootstrappedAt = d.lastAt;
            this._save();
            if (fresh.length) await this._queue(fresh, { notify });
            if (res.more) setTimeout(() => this.tick('more'), 250);
        } catch (e) {
            console.warn('[imessage] read failed:', e?.message || e);
        } finally {
            this._busy = false;
        }
    },

    /** Drop records outside the window, oldest first past the cap. */
    _prune(d, now) {
        const cutoff = now - this.RETENTION_DAYS * 86400000;
        const entries = Object.entries(d.records);
        let changed = false;
        for (const [id, r] of entries) {
            if ((r.internalDate || 0) < cutoff) { delete d.records[id]; changed = true; }
        }
        const left = Object.entries(d.records);
        if (left.length > this.MAX_RECORDS) {
            left.sort((a, b) => (a[1].internalDate || 0) - (b[1].internalDate || 0));
            for (const [id] of left.slice(0, left.length - this.MAX_RECORDS)) { delete d.records[id]; changed = true; }
        }
        // Open buffers older than the span cap with no lines are junk.
        for (const [k, b] of Object.entries(d.open)) {
            if (!b || !Array.isArray(b.lines) || !b.lines.length) { delete d.open[k]; changed = true; }
        }
        return changed;
    },

    /**
     * Hand records to the email engine's queue. Loads the engine if this
     * session never opened mail (loadData dedupes in-flight callers and
     * no-ops the Gmail half without accounts); the gates are the engine's
     * own (shouldConsiderForAnalysis: incoming, not muted, the metered
     * shortlist), and the CloudPrivacy class gate runs in the drain.
     */
    async _queue(recs, { notify = false } = {}) {
        if (typeof EmailApp === 'undefined') return;
        try {
            if (!EmailApp._dataLoaded) await EmailApp.loadData();
        } catch (e) {
            console.warn('[imessage] could not load the email engine:', e?.message);
            return;
        }
        const pass = recs.filter(r => EmailApp.shouldConsiderForAnalysis(r));
        if (!pass.length) return;
        if (notify) for (const r of pass) EmailApp._notifyOnInsight.add(r.messageId);
        EmailApp.queueEmailsForAnalysis(pass);
    },

    /**
     * The email engine's requeueMissedAnalyses, for this source: records
     * from the last few days with no verdict, no tombstone and no queue
     * slot get their look — which is also how a record the drain dropped
     * under a closed privacy gate comes back once the gate opens.
     */
    requeue() {
        if (!this.enabled() || typeof EmailApp === 'undefined' || !EmailApp._dataLoaded) return;
        const cutoff = Date.now() - this.REQUEUE_WINDOW_MS;
        const missed = this.records().filter(r =>
            (r.internalDate || 0) >= cutoff
            && !EmailApp.priorityAnalyses[r.messageId]
            && !EmailApp.analyzedNoInsight[r.messageId]
            && !EmailApp.pendingAnalysisIds.includes(r.messageId)
            && EmailApp.shouldConsiderForAnalysis(r));
        if (missed.length) EmailApp.queueEmailsForAnalysis(missed);
    },

    // ── Doors + rendering ─────────────────────────────────────────────

    /** "Open in Messages": the chat behind a record, in Messages.app. */
    openChat(rec) {
        if (!window.electronIMessage?.openChat) return;
        const handle = rec?.chat?.isGroup ? '' : (rec?.chat?.handle || '');
        window.electronIMessage.openChat(handle).catch(() => {});
    },

    /** The conversation as bubbles, for the Email AI detail. */
    transcriptHtml(rec) {
        const esc = (s) => (typeof UIUtils !== 'undefined' ? UIUtils.escapeHtml(String(s ?? '')) : String(s ?? ''));
        const lines = Array.isArray(rec?.lines) ? rec.lines : [];
        if (!lines.length) return `<div class="imsg-transcript"><p class="imsg-line-text">${esc(rec?.bodyText || '')}</p></div>`;
        const fmt = (ms) => {
            const dt = new Date(ms);
            return isNaN(dt) ? '' : dt.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        };
        const who = (l) => l.fromMe ? 'Me' : (rec.chat?.isGroup ? (l.handle || 'Someone') : (rec.chat?.name || l.handle || 'Them'));
        return `<div class="imsg-transcript">${lines.map(l => `
            <div class="imsg-line${l.fromMe ? ' is-me' : ''}${l.context ? ' is-context' : ''}">
                <span class="imsg-line-meta"><strong>${esc(who(l))}</strong> · ${esc(fmt(l.at))}${l.context ? ' · earlier' : ''}</span>
                <span class="imsg-line-text">${esc(l.text)}${l.hasAttachment ? ' <span class="imsg-line-att">[attachment]</span>' : ''}</span>
            </div>`).join('')}</div>`;
    },

    // ── Pure core (Node-testable) ─────────────────────────────────────

    /**
     * Fold reader rows into per-chat buffers and close what is ready.
     *
     * @param {object} open   {chatKey: {chatKey, chat, lines:[...]}} from the last call
     * @param {Array}  rows   reader rows, oldest first
     * @param {number} now    ms
     * @param {object} limits {QUIET_MS, MAX_LINES, MAX_SPAN_MS}
     * @returns {{open: object, closed: Array}} closed = chunks with ≥1 incoming line
     */
    fold(open, rows, now, limits) {
        const Q = limits.QUIET_MS, L = limits.MAX_LINES, S = limits.MAX_SPAN_MS;
        const buf = {};
        for (const [k, b] of Object.entries(open || {})) {
            if (b && Array.isArray(b.lines) && b.lines.length) buf[k] = { chatKey: k, chat: b.chat, lines: b.lines.slice() };
        }
        const closed = [];
        const closeBuf = (k) => {
            const b = buf[k];
            delete buf[k];
            if (!b || !b.lines.length) return;
            if (!b.lines.some(l => !l.fromMe)) return;   // the user's own texts alone are not a source
            closed.push(b);
        };
        const ready = (b, at) => {
            const first = b.lines[0].at, last = b.lines[b.lines.length - 1].at;
            return (at - last >= Q) || b.lines.length >= L || (at - first >= S);
        };

        for (const r of rows || []) {
            const text = String(r.text || '').trim();
            if (!text) continue;
            const at = Date.parse(r.at);
            if (isNaN(at)) continue;
            const key = r.chatGuid ? `chat:${r.chatGuid}` : `chatid:${r.chatId}`;
            const line = { rowid: r.rowid, guid: r.guid || '', at, fromMe: !!r.fromMe, handle: r.handle || '', text, hasAttachment: !!r.hasAttachment };
            const existing = buf[key];
            // A gap longer than the quiet window INSIDE the rows (a backlog
            // being read in one go) is a conversation boundary too.
            if (existing && ready(existing, at)) closeBuf(key);
            if (!buf[key]) {
                buf[key] = {
                    chatKey: key,
                    chat: {
                        key,
                        guid: r.chatGuid || '',
                        identifier: r.chatIdentifier || '',
                        name: r.chatName || '',
                        isGroup: !!r.isGroup,
                        handle: r.isGroup ? '' : (r.handle || r.chatIdentifier || ''),
                        service: r.service || '',
                    },
                    lines: [],
                };
            }
            const b = buf[key];
            if (!b.chat.handle && !r.isGroup && r.handle) b.chat.handle = r.handle;
            b.lines.push(line);
            if (b.lines.length >= L) closeBuf(key);
        }
        for (const k of Object.keys(buf)) {
            if (ready(buf[k], now)) closeBuf(k);
        }
        return { open: buf, closed };
    },

    /**
     * One closed chunk → one email-shaped record (or null when it has no
     * readable incoming text). `prev` is the chat's previous record, whose
     * last CONTEXT_LINES lines are prepended as context (flagged so the
     * transcript can dim them and the prompt can name them).
     */
    buildRecord(chunk, prev, opts) {
        const lines = (chunk?.lines || []).filter(l => l && l.text);
        if (!lines.length || !lines.some(l => !l.fromMe)) return null;
        const chat = chunk.chat || {};
        const last = lines[lines.length - 1];
        const firstIn = lines.find(l => !l.fromMe);
        const id = last.guid ? `imsg:${last.guid}` : `imsg:${chat.key || 'chat'}:${last.rowid}`;

        const ctxN = Number(opts?.CONTEXT_LINES) || 0;
        const context = (prev && Array.isArray(prev.lines) && ctxN > 0)
            ? prev.lines.filter(l => !l.context).slice(-ctxN).map(l => ({ ...l, context: true }))
            : [];

        const who = (l) => l.fromMe ? 'Me' : (chat.isGroup ? (l.handle || 'Someone') : (chat.name || l.handle || 'Them'));
        const stamp = (ms) => {
            const dt = new Date(ms);
            return isNaN(dt) ? '' : dt.toISOString().slice(0, 16).replace('T', ' ');
        };
        const fmtLine = (l) => `[${stamp(l.at)}] ${who(l)}: ${l.text}${l.hasAttachment ? ' [attachment]' : ''}`;
        let body = '';
        if (context.length) body += `(earlier in this conversation)\n${context.map(fmtLine).join('\n')}\n(new messages)\n`;
        body += lines.map(fmtLine).join('\n');
        const cap = Number(opts?.BODY_CHARS) || 3000;
        if (body.length > cap) body = '…' + body.slice(body.length - cap + 1);

        const label = chat.isGroup ? (chat.name || 'Group chat') : (chat.name || chat.handle || 'Unknown');
        const addr = chat.isGroup ? `group:${chat.identifier || chat.guid || chat.key}` : (chat.handle || chat.identifier || 'unknown');
        const subjMax = Number(opts?.SUBJECT_CHARS) || 90;
        let subject = String(firstIn.text).replace(/\s+/g, ' ').trim();
        if (subject.length > subjMax) subject = subject.slice(0, subjMax - 1).trimEnd() + '…';

        return {
            messageId: id,
            id,
            source: 'imessage',
            account: 'imessage',
            from: `${label} <${addr}>`,
            to: 'me',
            subject,
            date: new Date(last.at).toISOString(),
            internalDate: last.at,
            snippet: body.replace(/\s+/g, ' ').slice(0, 200),
            bodyText: body,
            bodyHtml: '',
            labels: ['INBOX'],
            attachments: [],
            hasAttachment: lines.some(l => l.hasAttachment),
            chat: { ...chat },
            lines: [...context, ...lines],
        };
    },
};

if (typeof module !== 'undefined' && module.exports) module.exports = IMessageSource;
