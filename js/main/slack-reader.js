'use strict';

// Main-only, read-only Web API adapter. Uses the existing MCP user OAuth grant;
// no token, arbitrary URL, file download or send method is exposed over IPC.
// API contracts and rollout limitations: docs/SLACK_MONITORING.md.
const { MonitorError, scopeFor } = require('./slack-monitor-policy');
const READ_LIMITS = Object.freeze({ page: 15, responseBytes: 256 * 1024, timeoutMs: 15000 });
const TS = /^\d{10,12}\.\d{6}$/;
const isId = (value, prefix) => typeof value === 'string' && new RegExp(`^[${prefix}][A-Z0-9]{1,31}$`).test(value);
const fail = code => { throw new MonitorError(code, `Slack read did not complete (${code}).`); };
const validTs = value => typeof value === 'string' && TS.test(value);
const tsOrder = value => BigInt(value.replace('.', ''));
const cursorFor = value => {
    if (value == null || value === '') return '';
    if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20]/.test(value)) fail('invalid_cursor');
    return value;
};

async function boundedJSON(response) {
    const size = Number(response.headers.get('content-length'));
    if (size > READ_LIMITS.responseBytes) { await response.body?.cancel(); fail('response_limit'); }
    if (!response.body) fail('invalid_response');
    const reader = response.body.getReader(), chunks = [];
    let length = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > READ_LIMITS.responseBytes) { await reader.cancel(); fail('response_limit'); }
            chunks.push(Buffer.from(value));
        }
    } finally { reader.releaseLock(); }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
    catch { fail('invalid_response'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('invalid_response');
    return data;
}

function normalizeMessage(raw, scope, channelId) {
    if (!raw || !validTs(raw.ts)) fail('invalid_response');
    if (raw.type !== 'message') return { kind: 'unsupported', ts: raw.ts };
    if (raw.subtype === 'message_deleted') {
        if (!validTs(raw.deleted_ts)) fail('invalid_response');
        return { kind: 'deleted', ts: raw.deleted_ts, revision: raw.ts };
    }
    // Changed events can appear in event-style fixtures; normal history reads
    // return the current text and edited.ts directly.
    const message = raw.subtype === 'message_changed' ? raw.message : raw;
    if (!message || !validTs(message.ts)) fail('invalid_response');
    const userId = message.user || message.bot_id;
    if (!isId(userId, 'UWB') || typeof message.text !== 'string') return { kind: 'unsupported', ts: message.ts };
    if (message.edited && !validTs(message.edited.ts)) fail('invalid_response');
    if (message.thread_ts != null && !validTs(message.thread_ts)) fail('invalid_response');
    return { kind: 'message', workspaceId: scope.workspaceId, channelId, userId,
        ts: message.ts, text: message.text, editedTs: message.edited?.ts || null,
        threadTs: message.thread_ts || null,
        attachmentsOmitted: !!(message.files?.length || message.attachments?.length || message.blocks?.some(b => b.type !== 'rich_text')),
        hasReplies: Number(message.reply_count) > 0 };
}

class SlackReader {
    constructor({ accessToken, fetch = globalThis.fetch, connected = () => true }) {
        if (typeof accessToken !== 'function') throw new TypeError('Slack OAuth token provider required');
        this.accessToken = accessToken;
        this.fetch = fetch;
        this.connected = connected;
        this.abort = new AbortController();
    }

    stop() { this.abort.abort(); }

    _check(signal) {
        if (this.abort.signal.aborted || signal?.aborted || this.connected() !== true) fail('cancelled');
    }

    async _call(method, args, token, signal) {
        // Fixed method and origin even if a future caller misuses this seam.
        if (!['auth.test', 'users.info', 'users.conversations', 'conversations.history', 'conversations.replies'].includes(method)) fail('invalid_method');
        if (typeof token !== 'string' || !token || token.length > 16384 || /[\r\n]/.test(token)) fail('needs_sign_in');
        this._check(signal);
        let response;
        try {
            response = await this.fetch(`https://slack.com/api/${method}`, {
                method: 'POST', redirect: 'error',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(args).toString(),
                signal: AbortSignal.any([this.abort.signal, ...(signal ? [signal] : []), AbortSignal.timeout(READ_LIMITS.timeoutMs)])
            });
            this._check(signal);
            if (response.status === 429) {
                const retry = Number(response.headers.get('retry-after'));
                await response.body?.cancel();
                const error = new MonitorError('rate_limited', 'Slack asked monitoring to wait.');
                error.retryAfterMs = Number.isFinite(retry) && retry > 0 ? Math.ceil(retry * 1000) : 60000;
                throw error;
            }
            if (!response.ok) { await response.body?.cancel(); fail(response.status === 401 ? 'needs_sign_in' : 'read_failed'); }
            const data = await boundedJSON(response);
            this._check(signal);
            if (data.ok !== true) {
                const code = ['invalid_auth', 'token_expired', 'token_revoked', 'account_inactive', 'not_authed'].includes(data.error) ? 'needs_sign_in'
                    : data.error === 'invalid_cursor' ? 'invalid_cursor'
                    : data.error === 'thread_not_found' ? 'source_unavailable'
                    : ['missing_scope', 'channel_not_found', 'not_in_channel', 'access_denied'].includes(data.error) ? 'access_denied' : 'read_failed';
                fail(code);
            }
            return data;
        } catch (error) {
            if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
            this._check(signal);
            if (error instanceof MonitorError) throw error;
            fail('read_failed'); // never echo a response body, URL, token or transport error
        }
    }

    async _session(scope, signal) {
        this._check(signal);
        let token, identity;
        try { token = await this.accessToken(); }
        catch { fail('needs_sign_in'); }
        this._check(signal);
        try { identity = await this._call('auth.test', {}, token, signal); }
        catch (error) {
            if (error.code !== 'needs_sign_in') throw error;
            try { token = await this.accessToken(token); }
            catch { fail('needs_sign_in'); }
            this._check(signal);
            identity = await this._call('auth.test', {}, token, signal);
        }
        if (!isId(identity.team_id, 'T') || !isId(identity.user_id, 'UW') || identity.bot_id) fail('invalid_identity');
        if (scope && (identity.team_id !== scope.workspaceId || identity.user_id !== scope.userId)) fail('account_changed');
        return { token, identity: { workspaceId: identity.team_id, userId: identity.user_id },
            workspaceName: typeof identity.team === 'string' ? identity.team.slice(0, 120) : identity.team_id };
    }

    async identity({ signal, labels = false } = {}) {
        const session = await this._session(null, signal);
        return labels ? { ...session.identity, workspaceName: session.workspaceName } : session.identity;
    }

    async conversations({ cursor = '', signal, names = false } = {}) {
        cursor = cursorFor(cursor);
        const { token, identity } = await this._session(null, signal);
        const data = await this._call('users.conversations', { types: 'im,mpim,public_channel,private_channel',
            exclude_archived: 'true', limit: String(READ_LIMITS.page), ...(cursor ? { cursor } : {}) }, token, signal);
        if (!Array.isArray(data.channels) || data.channels.length > READ_LIMITS.page) fail('invalid_response');
        const conversations = data.channels.map(c => {
            if (!c || !isId(c.id, 'CDG')) fail('invalid_response');
            return { id: c.id, name: typeof c.name === 'string' ? c.name.slice(0, 200) : '',
                type: c.is_im ? 'im' : c.is_mpim ? 'mpim' : c.is_private ? 'private_channel' : 'public_channel',
                peerId: isId(c.user, 'UW') ? c.user : null };
        });
        // Only the user-opened picker asks for names. Read no message bodies,
        // emails, avatars or arbitrary profile fields; each page stays bounded.
        if (names) for (const c of conversations) {
            if (c.type !== 'im' || !c.peerId) continue;
            const profile = await this._call('users.info', { user: c.peerId }, token, signal);
            if (profile.user?.id !== c.peerId) fail('invalid_response');
            const name = profile.user.profile?.display_name || profile.user.real_name || profile.user.name;
            if (typeof name === 'string' && name.trim()) c.name = name.slice(0, 120);
        }
        return { ...identity, conversations, nextCursor: cursorFor(data.response_metadata?.next_cursor) };
    }

    async _messages(method, { scope: input, channelId, oldest, latest, cursor = '', threadTs, signal, inclusive = false, limit = READ_LIMITS.page }) {
        const scope = scopeFor(input);
        if (!scope.conversationIds.includes(channelId)) fail('invalid_scope');
        if (!Number.isInteger(limit) || limit < 1 || limit > READ_LIMITS.page) fail('source_limit');
        if (!validTs(oldest) || !validTs(latest) || tsOrder(oldest) > tsOrder(latest)) fail('invalid_window');
        if (method === 'conversations.replies' && !validTs(threadTs)) fail('invalid_window');
        cursor = cursorFor(cursor);
        const { token } = await this._session(scope, signal);
        const data = await this._call(method, { channel: channelId, oldest, latest, inclusive: String(inclusive), limit: String(limit),
            ...(cursor ? { cursor } : {}), ...(threadTs ? { ts: threadTs } : {}) }, token, signal);
        if (!Array.isArray(data.messages) || data.messages.length > limit || (data.has_more != null && typeof data.has_more !== 'boolean')) fail('invalid_response');
        const normalized = data.messages.map(m => normalizeMessage(m, scope, channelId));
        let contextOmitted = false;
        const messages = normalized.filter(m => {
            // replies may include its parent. Only the requested interval is
            // eligible for intake; older parent text is not historical consent.
            if (method === 'conversations.replies' && m.ts === threadTs && tsOrder(m.ts) < tsOrder(oldest)) {
                contextOmitted = true; return false;
            }
            if (method === 'conversations.replies' && m.kind === 'message' && m.ts !== threadTs && m.threadTs !== threadTs) fail('invalid_response');
            // Fail closed rather than admitting unrequested historical context.
            if (tsOrder(m.ts) < tsOrder(oldest) || tsOrder(m.ts) > tsOrder(latest)) fail('invalid_response');
            return true;
        });
        const nextCursor = cursorFor(data.response_metadata?.next_cursor);
        if (nextCursor && nextCursor === cursor) fail('invalid_cursor');
        // Slack also supports time pagination. Without a cursor, keep coverage
        // incomplete; never pretend has_more is an exhausted time interval.
        if (data.has_more === true && !nextCursor) fail('pagination_incomplete');
        return { messages, nextCursor, contextOmitted, complete: !nextCursor && data.is_limited !== true,
            limited: data.is_limited === true };
    }

    history(input) { return this._messages('conversations.history', { ...input, threadTs: undefined, inclusive: true, limit: READ_LIMITS.page }); }
    replies(input) { return this._messages('conversations.replies', { ...input, inclusive: true, limit: READ_LIMITS.page }); }
    async message(input) {
        // Revalidation for a KNOWN message. Absence invalidates evidence but is
        // not proof of a deletion (retention or permissions may have changed).
        const isReply = input.threadTs && input.threadTs !== input.ts;
        try {
            const page = await this._messages(isReply ? 'conversations.replies' : 'conversations.history', {
                ...input, threadTs: isReply ? input.threadTs : undefined,
                oldest: input.ts, latest: input.ts, cursor: '', inclusive: true, limit: isReply ? READ_LIMITS.page : 1 });
            return { message: page.messages.find(m => m.ts === input.ts) || null, complete: page.complete };
        } catch (error) {
            if (isReply && error.code === 'source_unavailable') return { message: null, complete: true };
            throw error;
        }
    }
}

module.exports = { SlackReader, READ_LIMITS, validTs, tsOrder, cursorFor };
