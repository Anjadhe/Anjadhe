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

/** One main-owned destination, budget and scheduler for ALL Slack inference. */
class SlackModelClient {
    constructor({ intake, budget, store, catalog, resolve, schedule, fetch = globalThis.fetch, audit = () => {} }) {
        Object.assign(this, { intake, budget, store, catalog, resolve, schedule, fetch, audit });
        this.active = new Set();
    }
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
            const result = await sendBounded({ scope: grant.scope, body: bodyFor(model, messages, maxTokens), url: cfg.url, headers,
                budget: this.budget, signal, fetch: this.fetch, authorize: () => this.authorize(grant) });
            this.audit({ model: model.model, engine: model.engine, bytes: result.requestBytes, reservationId: result.reservationId });
            return result;
        } finally { slot?.release(); this.active.delete(controller); }
    }
}
module.exports = { SlackModelClient, bodyFor };
