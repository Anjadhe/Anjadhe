'use strict';
const { createHash } = require('node:crypto');
const { modelFor } = require('./slack-monitor-setup');
const { MonitorError } = require('./slack-monitor-policy');
const { sendBounded } = require('./slack-monitor-inference');
const Privacy = require('../core/cloud-privacy');
const fail = code => { throw new MonitorError(code, `Slack analysis paused (${code}).`); };

function bodyFor(model, messages, maxTokens = 1024) {
    const body = { model: model.model, messages, stream: false };
    if (model.engine === 'anthropic') {
        body.system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
        body.messages = messages.filter(m => m.role !== 'system'); body.max_tokens = maxTokens;
    } else if (model.engine === 'openai') body.max_completion_tokens = maxTokens;
    else { body.max_tokens = maxTokens; body.temperature = 0; body.response_format = { type: 'json_object' }; }
    if (model.engine === 'llamacpp') body.chat_template_kwargs = { enable_thinking: false };
    return body;
}

/** Where an approved model sends, in LLMLogger.destinationOf's words. */
function destinationOf(model) {
    if (model.engine === 'llamacpp') return { left: false, destination: 'This Mac' };
    if (model.engine === 'anjadhe') return { left: true, destination: model.label || 'nenva cloud' };
    if (model.engine === 'openai') return { left: true, destination: 'OpenAI (your key)' };
    if (model.engine === 'anthropic') return { left: true, destination: 'Anthropic (your key)' };
    return { left: true, destination: 'Your server' };
}

/** One LLM Logs entry for one attempt (the renderer's LLMLogger trims and stores it). */
function logEntry(model, messages, { startedAt, result, error }) {
    const text = role => messages.filter(m => m.role === role).map(m => String(m.content ?? '')).join('\n') || null;
    return {
        id: `${startedAt}-slack-${Math.random().toString(36).slice(2, 6)}`, source: 'slack-monitor', subject: 'Monitoring',
        timestamp: new Date(startedAt).toISOString(), model: model.model, provider: model.engine, ...destinationOf(model),
        messageCount: messages.length, systemPrompt: text('system'), userPrompt: text('user'), toolCount: 0, temperature: 0,
        requestChars: result?.requestBytes ?? error?.requestBytes ?? null, durationMs: Date.now() - startedAt,
        response: result?.text ?? null, responseChars: result?.text?.length ?? null, toolCalls: null,
        error: error ? `Slack analysis did not complete (${error.code || 'analysis_failed'}).` : null,
        promptTokens: null, completionTokens: null, totalTokens: null
    };
}

/** One main-owned destination, budget and scheduler for ALL Slack inference. */
class SlackModelClient {
    constructor({ intake, budget, store, catalog, resolve, schedule, fetch = globalThis.fetch, audit = () => {} }) {
        Object.assign(this, { intake, budget, store, catalog, resolve, schedule, fetch, audit });
        this.active = new Set();
    }
    /** Every attempt that may have reached the model is logged; the log never stops the work. */
    _audit(entry) { try { this.audit(entry); } catch { /* disclosure is best effort here; the send already happened */ } }
    cancel() { for (const controller of this.active) controller.abort(); }
    authorize({ revision, scope, model, sources = [] }) {
        const state = this.intake._guard(revision);
        const approved = modelFor(state.config.analysisModel);
        const live = this.catalog().find(e => e.id === approved.id);
        if (!live || JSON.stringify(modelFor(live)) !== JSON.stringify(approved)
            || JSON.stringify(approved) !== JSON.stringify(model) || JSON.stringify(state.config.scope) !== JSON.stringify(scope)) fail('model_changed');
        const classes = this.store.get('app_cloud-privacy')?.classes || {};
        for (const source of sources) {
            if (source === 'slack') continue; // exact scoped consent above
            const cls = { email: 'email', imessage: 'messages', commitment: 'notes', calendar: 'notes', chat: 'notes' }[source];
            if (!cls || !Privacy.decide(cls, classes, model.engine !== 'llamacpp').allowed) fail('privacy_blocked');
        }
        return true;
    }
    async call(messages, { revision, scope, sources = ['slack'], signal, maxTokens = 1024 } = {}) {
        const state = this.intake._guard(revision, signal), model = modelFor(state.config.analysisModel);
        const grant = { revision, scope: scope || state.config.scope, model, sources };
        this.authorize(grant);
        const controller = new AbortController(); this.active.add(controller);
        signal = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
        let slot;
        try {
            slot = await this.schedule(model, signal);
            this.intake._guard(revision, signal); this.authorize(grant);
            const cfg = await this.resolve(model);
            const headers = { ...cfg.headers };
            if (model.engine === 'anjadhe') {
                headers['X-Nenva-Feature'] = 'slack-monitor';
                headers['X-Nenva-Slack-Account'] = createHash('sha256').update(`${grant.scope.workspaceId}:${grant.scope.userId}`).digest('hex');
            }
            const startedAt = Date.now();
            let result;
            try {
                result = await sendBounded({ scope: grant.scope, body: bodyFor(model, messages, maxTokens), url: cfg.url, headers,
                    budget: this.budget, signal, fetch: this.fetch, authorize: () => this.authorize(grant) });
            } catch (error) {
                if (error?.attempted) this._audit(logEntry(model, messages, { startedAt, error }));
                throw error;
            }
            this._audit(logEntry(model, messages, { startedAt, result }));
            return result;
        } finally { slot?.release(); this.active.delete(controller); }
    }
}
module.exports = { SlackModelClient, bodyFor, destinationOf, logEntry };
