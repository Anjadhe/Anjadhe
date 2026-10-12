'use strict';
const { randomUUID } = require('node:crypto');
const { MonitorError, scopeFor } = require('./slack-monitor-policy');
const fail = code => { throw new MonitorError(code, `Slack setup did not complete (${code}).`); };
const clean = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) : '';
const ENGINES = new Set(['llamacpp', 'anjadhe', 'openai', 'anthropic', 'server']);

function modelFor(entry) {
    const exact = value => typeof value === 'string' && value.trim() && value === clean(value);
    if (!entry || !ENGINES.has(entry.engine) || !exact(entry.id) || !exact(entry.model)) fail('model_unavailable');
    const model = { id: entry.id, engine: entry.engine, model: entry.model, label: clean(entry.label) || entry.model };
    if (model.engine === 'server') {
        let url;
        try { url = new URL(entry.baseUrl); } catch { fail('model_unavailable'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) fail('model_unavailable');
        model.baseUrl = url.href;
    }
    return Object.freeze(model);
}

/** Main owns scope choices and the final native consent review. No renderer
 * boolean, invented channel ID or stale dialog can activate monitoring. */
class SlackMonitorSetup {
    constructor({ runtime, mcp, models, confirm, trusted, now = Date.now }) {
        Object.assign(this, { runtime, mcp, models, confirm, trusted, now });
        this.sessions = new Map();
    }

    _trusted(event) { if (this.trusted(event) !== true) fail('app_window_required'); }
    _ready() { if (this.runtime.enabled() !== true) fail('not_available'); }
    status(event) { this._trusted(event); return this.runtime.status(); }
    _models() { return this.models().map(e => { try { return modelFor(e); } catch { return null; } }).filter(Boolean).slice(0, 100); }
    _session(event, id) {
        this._trusted(event); this._ready();
        const s = this.sessions.get(event.sender.id);
        if (!s || s.id !== id || s.abort.signal.aborted || this.now() > s.expires
            || this.mcp.slackReader(s.serverName) !== s.reader
            || this.runtime.intake.status().revision !== s.revision) fail('setup_expired');
        return s;
    }
    cancel(event) {
        this._trusted(event);
        const old = this.sessions.get(event.sender.id);
        old?.abort.abort(); this.sessions.delete(event.sender.id);
        return { cancelled: true };
    }
    async begin(event, serverName) {
        this._trusted(event); this._ready(); this.cancel(event);
        const s = { id: randomUUID(), serverName, reader: this.mcp.slackReader(serverName), abort: new AbortController(),
            expires: this.now() + 10 * 60000, revision: this.runtime.intake.status().revision,
            choices: new Map(), cursor: '', pages: 0, busy: true };
        this.sessions.set(event.sender.id, s);
        try {
            s.identity = await s.reader.identity({ signal: s.abort.signal, labels: true });
            this._session(event, s.id);
            const page = await this._page(event, s);
            return { session: s.id, ...s.identity, ...page, models: this._models() };
        } catch (error) {
            if (this.sessions.get(event.sender.id) === s) this.close(event.sender.id);
            throw error;
        } finally { s.busy = false; }
    }
    async _page(event, s) {
        if (s.pages >= 20) fail('picker_limit');
        const page = await s.reader.conversations({ cursor: s.cursor, signal: s.abort.signal, names: true });
        this._session(event, s.id);
        if (page.workspaceId !== s.identity.workspaceId || page.userId !== s.identity.userId) fail('account_changed');
        if (!Array.isArray(page.conversations) || page.conversations.length > 15) fail('invalid_response');
        for (const c of page.conversations) s.choices.set(c.id, { id: c.id, name: clean(c.name), type: c.type, peerId: c.peerId });
        if (page.nextCursor && page.nextCursor === s.cursor) fail('invalid_cursor');
        s.cursor = page.nextCursor; s.pages++;
        return { conversations: [...s.choices.values()], more: !!s.cursor && s.pages < 20 };
    }
    async more(event, session) {
        const s = this._session(event, session);
        if (s.busy || !s.cursor) fail('not_ready');
        s.busy = true;
        try { return await this._page(event, s); } finally { s.busy = false; }
    }
    async review(event, { session, conversationIds, modelId } = {}) {
        const s = this._session(event, session);
        if (s.busy) fail('not_ready');
        const scope = scopeFor({ ...s.identity, conversationIds });
        if (scope.conversationIds.some(id => !s.choices.has(id))) fail('invalid_scope');
        const model = this._models().find(e => e.id === modelId);
        if (!model) fail('model_unavailable');
        const labels = scope.conversationIds.map(id => {
            const c = s.choices.get(id);
            return `${c.type === 'im' ? 'Direct message: ' : c.type === 'mpim' ? 'Group message: ' : '#'}${c.name || c.peerId || c.id} (${id})`;
        });
        const destination = model.engine === 'llamacpp' ? 'local' : 'cloud';
        const disclosure = { workspace: clean(s.identity.workspaceName) || scope.workspaceId, workspaceId: scope.workspaceId,
            userId: scope.userId, conversations: labels, model: model.label,
            destination: destination === 'local' ? 'On this Mac' : model.engine === 'server' ? model.baseUrl
                : ({ anjadhe: 'nenva cloud', openai: 'OpenAI', anthropic: 'Anthropic' })[model.engine] };
        const current = () => {
            this._session(event, session);
            return JSON.stringify(this._models().find(e => e.id === modelId)) === JSON.stringify(model);
        };
        s.busy = true;
        try {
            const approved = await this.confirm(event, disclosure);
            if (!current()) fail('model_changed');
            if (approved !== true) return { cancelled: true };
            const result = await this.runtime.intake.configure({ serverName: s.serverName, scope, destination,
                consent: true, analysisModel: model, authorize: current });
            this.cancel(event);
            return result;
        } finally { s.busy = false; }
    }
    control(event, action) {
        this._trusted(event);
        if (action === 'stop') { this.cancel(event); this.runtime.intake.stop(); }
        else if (action === 'pause') this.runtime.intake.pause(true);
        else if (action === 'resume') {
            this._ready();
            const approved = this.runtime.intake._read().config?.analysisModel;
            if (!approved || JSON.stringify(this._models().find(e => e.id === approved.id)) !== JSON.stringify(approved)) fail('model_changed');
            this.runtime.intake.pause(false);
        }
        else fail('invalid_action');
        return this.runtime.status();
    }
    close(senderId) { this.sessions.get(senderId)?.abort.abort(); this.sessions.delete(senderId); }
}

module.exports = { SlackMonitorSetup, modelFor };
