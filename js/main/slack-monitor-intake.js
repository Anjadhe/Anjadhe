'use strict';

const { randomUUID } = require('node:crypto');
const { MonitorError, scopeFor, LIMITS } = require('./slack-monitor-policy');
const { validTs, tsOrder, cursorFor, READ_LIMITS } = require('./slack-reader');
const STORE_KEY = 'slackMonitorIntake'; // settingsStore only; never an app_* / synced blob
const INTAKE_LIMITS = Object.freeze({ records: 500, bytes: 1024 * 1024, receipts: 1000,
    invalidations: 500, pagesPerWindow: 100, cadenceMs: 60000,
    threads: 100, threadIntervalMs: 5 * 60000, recheckIntervalMs: 15 * 60000 });
const fail = code => { throw new MonitorError(code, `Slack intake did not complete (${code}).`); };
const size = value => Buffer.byteLength(JSON.stringify(value));
const messageId = m => `${m.workspaceId}:${m.channelId}:${m.ts}:${m.editedTs || 'original'}`;
const sameMessage = (a, b) => a.channelId === b.channelId && a.ts === b.ts;
const timestamp = time => `${Math.floor(time / 1000)}.${String((time % 1000) * 1000).padStart(6, '0')}`;
const empty = (revision = randomUUID()) => ({ version: 1, revision, config: null, paused: true,
    channels: [], records: [], receipts: [], invalidations: [], lastAt: 0, nextAt: 0,
    threads: [], threadLimitReached: false, turn: 0 });

function validMessage(m, scope) {
    return m && m.kind === 'message' && m.workspaceId === scope.workspaceId
        && scope.conversationIds.includes(m.channelId) && /^[UWB][A-Z0-9]{1,31}$/.test(m.userId)
        && validTs(m.ts) && (m.editedTs === null || validTs(m.editedTs))
        && (m.threadTs === null || validTs(m.threadTs)) && typeof m.text === 'string'
        && typeof m.attachmentsOmitted === 'boolean' && typeof m.hasReplies === 'boolean';
}

/** One main-process owner. No IPC, inference or automatic activation here.
 * The runtime explicitly calls tick with its live owner/
 * pause gate. Configuration is saved only after verifying the account at Slack.
 * A single synchronous store write commits a page AND its checkpoint. */
class SlackMonitorIntake {
    constructor({ store, readerFor, allowed, now = Date.now, resultRefsFor = () => new Map() }) {
        if (!store || typeof store.get !== 'function' || typeof store.set !== 'function'
            || typeof readerFor !== 'function' || typeof allowed !== 'function') throw new TypeError('Main store, reader and runtime gate required');
        this.store = store;
        this.readerFor = readerFor;
        this.allowed = allowed;
        this.now = now;
        this.resultRefsFor = resultRefsFor;
        this.active = null;
        this.setup = null;
    }

    _read() {
        let state;
        try {
            const raw = this.store.get(STORE_KEY);
            if (raw === undefined) return empty('unconfigured');
            state = structuredClone(raw);
            // Additive migration of the fixture-tested S2 store. No new consent
            // or network work is created by migrating persisted bookkeeping.
            if (state?.version === 1 && state.threads === undefined) {
                state.threads = []; state.threadLimitReached = false; state.turn = 0;
            }
            if (!state || state.version !== 1 || typeof state.revision !== 'string' || state.revision.length > 64
                || typeof state.paused !== 'boolean' || !Number.isSafeInteger(state.lastAt) || state.lastAt < 0
                || !Number.isSafeInteger(state.nextAt) || state.nextAt < 0
                || !Array.isArray(state.channels) || !Array.isArray(state.records) || !Array.isArray(state.receipts)
                || !Array.isArray(state.invalidations) || state.records.length > INTAKE_LIMITS.records
                || !Array.isArray(state.threads) || state.threads.length > INTAKE_LIMITS.threads
                || typeof state.threadLimitReached !== 'boolean' || ![0, 1, 2].includes(state.turn)
                || state.receipts.length > INTAKE_LIMITS.receipts || state.invalidations.length > INTAKE_LIMITS.invalidations
                || size(state) > INTAKE_LIMITS.bytes) throw new Error('Invalid state');
            if (!state.config) {
                if (state.channels.length || state.records.length || state.receipts.length || state.invalidations.length || state.threads.length || !state.paused) throw new Error('Unscoped state');
                return state;
            }
            const scope = scopeFor(state.config.scope);
            if (typeof state.config.serverName !== 'string' || !state.config.serverName || state.config.serverName.length > 100
                || !['local', 'cloud'].includes(state.config.destination) || !validTs(state.config.startedAt)
                || state.channels.length !== scope.conversationIds.length || new Set(state.channels.map(c => c.id)).size !== state.channels.length) throw new Error('Invalid configuration');
            for (const c of state.channels) {
                if (c.startedAt === undefined) c.startedAt = state.config.startedAt;
                if (!scope.conversationIds.includes(c.id) || !validTs(c.through) || !Number.isSafeInteger(c.nextAt) || c.nextAt < 0
                    || !validTs(c.startedAt) || tsOrder(c.startedAt) > tsOrder(c.through)
                    || !Number.isSafeInteger(c.failures) || c.failures < 0 || c.failures > 10) throw new Error('Invalid checkpoint');
                if (c.window) {
                    const w = c.window;
                    if (!validTs(w.oldest) || !validTs(w.latest) || w.oldest !== c.through || tsOrder(w.oldest) > tsOrder(w.latest)
                        || !Array.isArray(w.seen) || w.seen.length > INTAKE_LIMITS.pagesPerWindow
                        || w.seen.some(v => cursorFor(v) !== v) || cursorFor(w.cursor) !== w.cursor) throw new Error('Invalid window');
                }
            }
            for (const r of state.records) {
                if (!validMessage(r.message, scope) || r.id !== messageId(r.message) || !['pending', 'analyzed'].includes(r.status)
                    || (r.status === 'analyzed' && (typeof r.resultRef !== 'string' || r.resultRef.length > 200))) throw new Error('Invalid record');
            }
            for (const r of [...state.receipts, ...state.invalidations]) {
                if (!r || typeof r.id !== 'string' || r.id.length > 160 || !scope.conversationIds.includes(r.channelId)
                    || !validTs(r.ts) || typeof r.resultRef !== 'string' || r.resultRef.length > 200) throw new Error('Invalid receipt');
            }
            for (const r of state.receipts) {
                if (r.editedTs !== null && !validTs(r.editedTs)) throw new Error('Invalid receipt version');
                if (r.threadTs != null && !validTs(r.threadTs)) throw new Error('Invalid receipt thread');
                if (r.id !== messageId({ ...r, workspaceId: scope.workspaceId })) throw new Error('Invalid receipt identity');
            }
            for (const r of [...state.records, ...state.receipts]) {
                if (r.checkedAt != null && (!Number.isSafeInteger(r.checkedAt) || r.checkedAt < 0)) throw new Error('Invalid recheck');
            }
            for (const t of state.threads) {
                if (!scope.conversationIds.includes(t.channelId) || !validTs(t.ts) || !validTs(t.through)
                    || !Number.isSafeInteger(t.nextAt) || t.nextAt < 0) throw new Error('Invalid thread');
                if (t.window && (!validTs(t.window.oldest) || !validTs(t.window.latest) || t.window.oldest !== t.through
                    || tsOrder(t.window.oldest) > tsOrder(t.window.latest) || cursorFor(t.window.cursor) !== t.window.cursor
                    || !Array.isArray(t.window.seen) || t.window.seen.length > INTAKE_LIMITS.pagesPerWindow
                    || t.window.seen.some(v => cursorFor(v) !== v))) throw new Error('Invalid thread window');
            }
            return state;
        } catch { fail('store_unavailable'); }
    }

    _save(state) {
        if (state.records.length > INTAKE_LIMITS.records || state.invalidations.length > INTAKE_LIMITS.invalidations
            || size(state) > INTAKE_LIMITS.bytes) fail('queue_full');
        try {
            const result = this.store.set(STORE_KEY, state);
            if (result && typeof result.then === 'function') throw new Error('Async store');
        } catch { fail('store_unavailable'); }
    }

    _time(state) {
        const time = this.now();
        if (!Number.isSafeInteger(time) || time < 1000000000000) fail('invalid_clock');
        return Math.max(time, state.lastAt);
    }

    _cancel() {
        this.active?.abort();
        this.setup?.abort();
        this.onCancel?.();
    }

    cancelActive() { this._cancel(); }
    connection() { return this._read().config?.serverName || null; }

    async configure({ serverName, scope: input, destination, consent, analysisModel = null, authorize = () => true }) {
        if (consent !== true || !['local', 'cloud'].includes(destination)
            || typeof serverName !== 'string' || !serverName || serverName.length > 100) fail('consent_required');
        const scope = scopeFor(input);
        const before = this._read();
        this._cancel();
        const setup = this.setup = new AbortController();
        // A read-only identity check is the only network request before consent
        // is durably associated with a specific Slack user and workspace.
        try {
            const identity = await this.readerFor(serverName).identity({ signal: setup.signal });
            if (setup.signal.aborted || this.setup !== setup || this._read().revision !== before.revision) fail('cancelled');
            if (authorize() !== true) fail('cancelled');
            if (identity.workspaceId !== scope.workspaceId || identity.userId !== scope.userId) fail('account_changed');
            const state = empty(), time = this._time(before);
            state.lastAt = time;
            state.paused = false;
            state.config = { serverName, scope, destination, startedAt: timestamp(time) };
            if (analysisModel) state.config.analysisModel = structuredClone(analysisModel);
            const sameAccount = before.config?.serverName === serverName && before.config.scope.workspaceId === scope.workspaceId
                && before.config.scope.userId === scope.userId;
            state.channels = scope.conversationIds.map(id => (sameAccount && before.channels.find(c => c.id === id))
                || { id, startedAt: timestamp(time), through: timestamp(time), window: null, nextAt: time, failures: 0, error: null });
            if (sameAccount) {
                state.nextAt = before.nextAt;
                state.records = before.records.filter(r => scope.conversationIds.includes(r.message.channelId));
                state.receipts = before.receipts.filter(r => scope.conversationIds.includes(r.channelId));
                state.invalidations = before.invalidations.filter(r => scope.conversationIds.includes(r.channelId));
                state.threads = before.threads.filter(t => scope.conversationIds.includes(t.channelId));
                state.threadLimitReached = before.threadLimitReached;
                state.turn = before.turn;
            }
            this._save(state);
            this.onReset?.();
            return this.status();
        } finally { if (this.setup === setup) this.setup = null; }
    }

    pause(paused = true) {
        this._cancel();
        const state = this._read();
        if (!state.config) return this.status();
        state.paused = paused !== false;
        state.revision = randomUUID();
        this._save(state);
        return this.status();
    }

    stop() { this._cancel(); this._save(empty()); this.onReset?.(); }

    _guard(revision, signal) {
        const state = this._read();
        if (signal?.aborted || state.revision !== revision || !state.config || state.paused || this.allowed() !== true) fail('cancelled');
        return state;
    }

    status() {
        const s = this._read();
        return { configured: !!s.config, paused: s.paused, revision: s.revision, nextAt: s.nextAt,
            scope: s.config?.scope || null, lastReadAt: s.lastReadAt || null,
            pending: s.records.filter(r => r.status === 'pending').length,
            analyzed: s.records.filter(r => r.status === 'analyzed').length, invalidations: s.invalidations.length,
            threads: s.threads.length, threadLimitReached: s.threadLimitReached,
            channels: s.channels.map(c => ({ id: c.id, through: c.through, nextAt: c.nextAt, error: c.error, paging: !!c.window })),
            // Polling bounded known evidence cannot certify a whole workspace.
            coverageComplete: false, coverageReasons: ['bounded_known_threads', 'periodic_evidence_checks',
                ...(s.threadLimitReached ? ['thread_limit'] : [])] };
    }

    _trackThread(state, message) {
        const ts = message.threadTs || (message.hasReplies ? message.ts : null);
        if (!ts || state.threads.some(t => t.channelId === message.channelId && t.ts === ts)) return;
        if (state.threads.length >= INTAKE_LIMITS.threads) { state.threadLimitReached = true; return; }
        // A reply can identify a parent older than activation. Fetch only new
        // replies, never silently expand the approved historical window.
        const channel = state.channels.find(c => c.id === message.channelId);
        const start = channel.startedAt || state.config.startedAt;
        state.threads.push({ channelId: message.channelId, ts,
            through: tsOrder(ts) > tsOrder(start) ? ts : start,
            nextAt: state.lastAt, window: null });
    }

    _invalidate(state, message, reason) {
        const records = state.records.filter(r => sameMessage(r.message, message));
        // A shared result can have committed just before a crash prevented its
        // intake acknowledgement. Consult durable result refs for those still
        // marked pending, or an edit in that gap would leave stale evidence.
        const saved = this.resultRefsFor(records.filter(r => r.status === 'pending').map(r => r.id));
        for (const r of [...records.map(r => ({ ...r.message, id: r.id, resultRef: r.resultRef || saved.get(r.id) })).filter(r => r.resultRef), ...state.receipts]) {
            if (sameMessage(r, message) && !state.invalidations.some(i => i.id === r.id)) {
                state.invalidations.push({ id: r.id, channelId: r.channelId, ts: r.ts, resultRef: r.resultRef, reason });
            }
        }
        state.records = state.records.filter(r => !sameMessage(r.message, message));
    }

    _ingest(state, channelId, messages) {
        for (const message of messages) {
            if (message.kind === 'unsupported') continue; // caller persists incomplete coverage
            if (message.kind === 'deleted' || message.kind === 'unavailable') {
                if (!validTs(message.ts)) fail('invalid_response');
                this._invalidate(state, { channelId, ts: message.ts }, 'source_unavailable');
                continue;
            }
            if (!validMessage(message, state.config.scope) || message.channelId !== channelId) fail('invalid_response');
            this._trackThread(state, message);
            const id = messageId(message);
            const existing = state.records.find(r => r.id === id);
            if (existing) {
                existing.message.threadTs = message.threadTs;
                existing.message.hasReplies = message.hasReplies;
                continue;
            }
            if (state.receipts.some(r => r.id === id)) continue;
            // An older page must never undo a newer revision already held.
            const versions = [...state.records.map(r => r.message), ...state.receipts].filter(m => sameMessage(m, message));
            if (versions.some(m => tsOrder(m.editedTs || m.ts) > tsOrder(message.editedTs || message.ts))) continue;
            this._invalidate(state, message, 'source_changed');
            state.records.push({ id, message, status: 'pending', checkedAt: state.lastAt });
        }
    }

    _failure(error, revision, signal, channelId, now, resetHistoryCursor = false) {
        let state;
        try { state = this._guard(revision, signal); }
        catch (stale) { if (stale.code === 'cancelled') return { state: 'cancelled' }; throw stale; }
        const channel = state.channels.find(c => c.id === channelId);
        channel.failures = Math.min(10, channel.failures + 1);
        channel.error = error instanceof MonitorError ? error.code : 'read_failed';
        const wait = Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs > 0 ? error.retryAfterMs : 0;
        channel.nextAt = Math.min(Number.MAX_SAFE_INTEGER, now + Math.max(wait, Math.min(3600000, INTAKE_LIMITS.cadenceMs * 2 ** (channel.failures - 1))));
        if (error.code === 'rate_limited') state.nextAt = Math.max(state.nextAt, channel.nextAt);
        if (resetHistoryCursor && error.code === 'invalid_cursor' && channel.window) channel.window = { ...channel.window, cursor: '', seen: [] }; // replay the SAME fixed interval
        this._save(state);
        return { state: channel.error };
    }

    async readOne() {
        if (this.active || this.setup) return { state: 'busy' };
        const first = this._read();
        if (!first.config || first.paused || this.allowed() !== true) return { state: 'paused' };
        const now = this._time(first);
        if (first.nextAt > now) return { state: 'waiting' };
        const due = first.channels.filter(c => c.nextAt <= now).sort((a, b) => a.nextAt - b.nextAt)[0];
        if (!due) return { state: 'waiting' };
        if (first.records.length >= INTAKE_LIMITS.records) return { state: 'queue_full' };
        const active = this.active = new AbortController(), revision = first.revision;
        try {
            // Persist a fixed time window BEFORE reading its first page. New
            // arrivals cannot move the upper bound during pagination/restarts.
            const window = due.window || { oldest: due.through, latest: timestamp(now), cursor: '', seen: [] };
            due.window = window;
            due.nextAt = now + INTAKE_LIMITS.cadenceMs;
            first.lastAt = now;
            first.nextAt = due.nextAt;
            this._save(first);
            const page = await this.readerFor(first.config.serverName).history({ scope: first.config.scope, channelId: due.id,
                oldest: window.oldest, latest: window.latest, cursor: window.cursor, signal: active.signal });
            const state = this._guard(revision, active.signal), channel = state.channels.find(c => c.id === due.id);
            if (!page || !Array.isArray(page.messages) || page.messages.length > READ_LIMITS.page || typeof page.complete !== 'boolean') fail('invalid_response');
            const nextCursor = cursorFor(page.nextCursor);
            if (nextCursor && (window.seen.includes(nextCursor) || window.seen.length >= INTAKE_LIMITS.pagesPerWindow)) fail('pagination_incomplete');
            this._ingest(state, due.id, page.messages);
            channel.failures = 0;
            channel.error = page.messages.some(m => m.kind === 'unsupported') ? 'unsupported_messages' : page.limited ? 'history_limited' : null;
            if (nextCursor) channel.window = { ...window, cursor: nextCursor, seen: [...window.seen, nextCursor] };
            else if (page.complete) { channel.through = window.latest; channel.window = null; }
            else channel.error ||= 'history_incomplete';
            state.lastReadAt = now;
            // Atomic page + read checkpoint. Persistence failure leaves the
            // original window/cursor intact; replay is deduplicated next time.
            this._save(state);
            return { state: 'read', messages: page.messages.length, partial: true };
        } catch (error) {
            if (error.code === 'cancelled') return { state: 'cancelled' };
            return this._failure(error, revision, active.signal, due.id, now, true);
        } finally { if (this.active === active) this.active = null; }
    }

    /** Round-robin work classes survive restart, so a busy channel cannot
     * monopolize the shared account read allowance and starve reconciliation. */
    async tick() {
        if (this.active || this.setup) return { state: 'busy' };
        const state = this._read();
        if (!state.config || state.paused || this.allowed() !== true) return { state: 'paused' };
        const now = this._time(state);
        if (state.nextAt > now) return { state: 'waiting' };
        const channelDue = id => state.channels.some(c => c.id === id && c.nextAt <= now);
        const thread = state.threads.filter(t => t.nextAt <= now && channelDue(t.channelId)).sort((a, b) => a.nextAt - b.nextAt)[0];
        const evidence = [...state.records.map(r => ({ ...r.message, checkedAt: r.checkedAt || 0 })), ...state.receipts]
            .filter(r => (r.checkedAt || 0) <= now - INTAKE_LIMITS.recheckIntervalMs && channelDue(r.channelId))
            .sort((a, b) => (a.checkedAt || 0) - (b.checkedAt || 0))[0];
        const work = [state.channels.some(c => c.nextAt <= now) ? () => this.readOne() : null,
            thread ? () => this.readThread(thread.channelId, thread.ts) : null,
            evidence ? () => this.revalidate(evidence.channelId, evidence.ts) : null];
        for (let offset = 0; offset < 3; offset++) {
            const turn = (state.turn + offset) % 3;
            if (!work[turn]) continue;
            state.turn = (turn + 1) % 3;
            this._save(state);
            return work[turn]();
        }
        return { state: 'waiting' };
    }

    async readThread(channelId, ts) {
        if (this.active || this.setup) return { state: 'busy' };
        const first = this._read();
        this._guard(first.revision);
        const thread = first.threads.find(t => t.channelId === channelId && t.ts === ts);
        if (!thread) fail('unknown_thread');
        const now = this._time(first), channel = first.channels.find(c => c.id === channelId);
        if (first.nextAt > now || thread.nextAt > now || channel.nextAt > now) return { state: 'waiting' };
        if (first.records.length >= INTAKE_LIMITS.records) return { state: 'queue_full' };
        const active = this.active = new AbortController();
        try {
            const window = thread.window || { oldest: thread.through, latest: timestamp(now), cursor: '', seen: [] };
            thread.window = window;
            first.lastAt = now;
            first.nextAt = channel.nextAt = now + INTAKE_LIMITS.cadenceMs;
            thread.nextAt = now + INTAKE_LIMITS.threadIntervalMs;
            this._save(first);
            const page = await this.readerFor(first.config.serverName).replies({ scope: first.config.scope, channelId,
                threadTs: ts, oldest: window.oldest, latest: window.latest, cursor: window.cursor, signal: active.signal });
            const state = this._guard(first.revision, active.signal), target = state.threads.find(t => t.channelId === channelId && t.ts === ts);
            if (!page || !Array.isArray(page.messages) || page.messages.length > READ_LIMITS.page || typeof page.complete !== 'boolean') fail('invalid_response');
            const next = cursorFor(page.nextCursor);
            if (next && (window.seen.includes(next) || window.seen.length >= INTAKE_LIMITS.pagesPerWindow)) fail('pagination_incomplete');
            this._ingest(state, channelId, page.messages);
            const currentChannel = state.channels.find(c => c.id === channelId);
            currentChannel.failures = 0;
            currentChannel.error = page.complete || next ? null : 'history_incomplete';
            if (next) { target.window = { ...window, cursor: next, seen: [...window.seen, next] }; target.nextAt = state.nextAt; }
            else if (page.complete) { target.through = window.latest; target.window = null; }
            target.error = page.complete || next ? null : 'history_incomplete';
            state.lastReadAt = now;
            this._save(state);
            return { state: 'thread_read', messages: page.messages.length, partial: true };
        } catch (error) {
            if (error.code === 'source_unavailable') {
                try {
                    const state = this._guard(first.revision, active.signal);
                    const related = [...state.records.map(r => r.message), ...state.receipts]
                        .filter(m => m.channelId === channelId && (m.ts === ts || m.threadTs === ts));
                    for (const message of related) this._invalidate(state, message, 'source_unavailable');
                    state.threads = state.threads.filter(t => t.channelId !== channelId || t.ts !== ts);
                    this._save(state);
                    return { state: 'source_unavailable' };
                } catch (stale) { if (stale.code === 'cancelled') return { state: 'cancelled' }; throw stale; }
            }
            // Reset only this thread's expired cursor, preserving its interval.
            if (error.code === 'invalid_cursor') {
                try {
                    const state = this._guard(first.revision, active.signal);
                    const target = state.threads.find(t => t.channelId === channelId && t.ts === ts);
                    target.window = { ...target.window, cursor: '', seen: [] };
                    this._save(state);
                } catch (stale) { if (stale.code === 'cancelled') return { state: 'cancelled' }; throw stale; }
            }
            return this._failure(error, first.revision, active.signal, channelId, now);
        } finally { if (this.active === active) this.active = null; }
    }

    pending() {
        const state = this._read();
        return { revision: state.revision, scope: state.config?.scope || null, readComplete: false,
            messages: state.records.filter(r => r.status === 'pending').slice(0, LIMITS.sourceMessages).map(r => r.message) };
    }

    acknowledge({ revision, messageIds, resultRef, delivered = false }) {
        // The caller must have durably committed validated findings first.
        // This is deliberately not callable by a model or renderer in S2.
        const state = this._guard(revision);
        if (!Array.isArray(messageIds) || !messageIds.length || messageIds.length > LIMITS.analysisMessages
            || new Set(messageIds).size !== messageIds.length || typeof resultRef !== 'string' || !resultRef || resultRef.length > 200) fail('invalid_receipt');
        const records = messageIds.map(id => state.records.find(r => r.id === id));
        if (records.some(r => !r || (delivered && r.status !== 'analyzed')
            || (r.status === 'analyzed' && r.resultRef !== resultRef))) fail('stale_receipt');
        for (const r of records) {
            if (delivered) state.receipts.push({ id: r.id, channelId: r.message.channelId, ts: r.message.ts, editedTs: r.message.editedTs,
                threadTs: r.message.threadTs, checkedAt: r.checkedAt || 0, resultRef });
            else { r.status = 'analyzed'; r.resultRef = resultRef; }
        }
        if (delivered) state.records = state.records.filter(r => !messageIds.includes(r.id));
        state.receipts = state.receipts.slice(-INTAKE_LIMITS.receipts);
        this._save(state);
    }

    acknowledgeInvalidations({ revision, invalidations }) {
        const state = this._guard(revision);
        if (!Array.isArray(invalidations) || invalidations.length > INTAKE_LIMITS.invalidations) fail('invalid_receipt');
        const keys = new Set(invalidations.map(r => JSON.stringify(r)));
        if (invalidations.some(r => !state.invalidations.some(current => JSON.stringify(current) === JSON.stringify(r)))) fail('stale_receipt');
        state.invalidations = state.invalidations.filter(r => !keys.has(JSON.stringify(r)));
        this._save(state);
    }

    async revalidate(channelId, ts) {
        if (this.active || this.setup) return { state: 'busy' };
        const first = this._read();
        this._guard(first.revision);
        const known = [...first.records.map(r => r.message), ...first.receipts].find(m => m.channelId === channelId && m.ts === ts);
        if (!known) fail('unknown_message');
        const now = this._time(first), channel = first.channels.find(c => c.id === channelId);
        if (channel.nextAt > now || first.nextAt > now) return { state: 'waiting' };
        const active = this.active = new AbortController();
        try {
            channel.nextAt = now + INTAKE_LIMITS.cadenceMs;
            first.lastAt = now;
            first.nextAt = channel.nextAt;
            for (const r of first.records) if (r.message.channelId === channelId && r.message.ts === ts) r.checkedAt = now;
            for (const r of first.receipts) if (r.channelId === channelId && r.ts === ts) r.checkedAt = now;
            this._save(first);
            const page = await this.readerFor(first.config.serverName).message({ scope: first.config.scope, channelId, ts,
                threadTs: known.threadTs, signal: active.signal });
            const state = this._guard(first.revision, active.signal);
            if (!page.complete) return { state: 'partial' };
            if (page.message && page.message.ts !== ts) fail('invalid_response');
            this._ingest(state, channelId, [page.message || { kind: 'unavailable', ts }]);
            state.lastReadAt = now;
            this._save(state);
            return { state: 'revalidated' };
        } catch (error) {
            return this._failure(error, first.revision, active.signal, channelId, now);
        } finally { if (this.active === active) this.active = null; }
    }
}

module.exports = { SlackMonitorIntake, STORE_KEY, INTAKE_LIMITS };
