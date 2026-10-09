'use strict';

// Main-only delivery adapter. Reuses the shared Matters door, never the email
// analysis drain. No timer or IPC here: the runtime supplies a current intake
// revision and a provider resolved from the explicitly approved model.
const { createHash } = require('node:crypto');
const Matters = require('../core/matters');
const { planAnalysis, MonitorError } = require('./slack-monitor-policy');
const { sendBounded, observationsFor } = require('./slack-monitor-inference');
const { modelFor } = require('./slack-monitor-setup');
const { stageTasks } = require('./slack-monitor-tasks');
const KEY = 'app_matters';
const fail = code => { throw new MonitorError(code, `Slack insight delivery did not complete (${code}).`); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => structuredClone(value);

function factsFor(observation, plan) {
    const f = Matters.observation(observation);
    const evidence = JSON.parse(plan.request.messages[1].content).messages;
    const quoted = evidence.filter(m => observation.evidenceIds.includes(m.id));
    const thread = quoted[0].threadTs;
    f.meta.thread = `slack:${plan.scope.workspaceId}:${observation.channelId}${thread ? ':' + thread : ''}`;
    f.meta.name = observation.own ? 'You' : `Slack ${[...new Set(quoted.map(m => m.userId))].join(', ')}`;
    f.slack = { workspaceId: plan.scope.workspaceId, userId: plan.scope.userId, channelId: observation.channelId,
        threadTs: thread, evidenceIds: observation.evidenceIds, coverage: observation.coverage,
        sourceUrl: observation.sourceUrl, kind: observation.kind };
    return f;
}

class SlackInsightDelivery {
    constructor({ store, intake, budget, provider, call, authorize, transaction, fetch = globalThis.fetch, now = Date.now }) {
        if (!store?.get || !store?.set || !intake || (!call && typeof provider !== 'function') || typeof authorize !== 'function') {
            throw new TypeError('Main store, intake, approved provider and live authorization required');
        }
        Object.assign(this, { store, intake, budget, provider, call, authorize, transaction, fetch, now });
        this.queue = Promise.resolve();
        intake.resultRefsFor = ids => {
            const refs = new Map();
            if (!ids.length) return refs;
            const wanted = new Set(ids);
            for (const [ref, receipt] of Object.entries(this._read().slackDeliveries || {})) {
                for (const id of receipt.messageIds || []) if (wanted.has(id)) refs.set(id, ref);
            }
            return refs;
        };
    }

    _enqueue(fn) { const job = this.queue.then(fn, fn); this.queue = job.catch(() => {}); return job; }
    _read() {
        const raw = this.store.get(KEY);
        if (raw == null) return { version: Matters.VERSION, matters: {}, aliases: {} };
        if (raw.version !== Matters.VERSION || !raw.matters || typeof raw.matters !== 'object'
            || Array.isArray(raw.matters) || (raw.slackDeliveries && (typeof raw.slackDeliveries !== 'object' || Array.isArray(raw.slackDeliveries)))) fail('store_unavailable');
        return copy(raw);
    }
    _commit(before, next) {
        // A user edit, sync or another source may have landed while inference
        // awaited. Never overwrite it with a model's view of an older snapshot.
        if (digest(this._read()) !== digest(before)) fail('matter_changed');
        const result = this.store.set(KEY, next);
        if (result === false || result?.then || digest(this._read()) !== digest(next)) fail('store_unavailable');
    }
    _current(revision, plan, signal) {
        const state = this.intake._guard(revision, signal);
        if (JSON.stringify(state.config.scope) !== JSON.stringify(plan.scope)) fail('stale_evidence');
        const records = plan.messageIds.map(id => state.records.find(r => r.id === id));
        if (!records.length || records.some(r => !r)) fail('stale_evidence');
        // Compare the complete selected evidence, not just caller-supplied IDs.
        const verified = planAnalysis({ scope: state.config.scope, messages: records.map(r => r.message), readComplete: false });
        if (JSON.stringify(JSON.parse(verified.request?.messages[1].content || '{}').messages)
            !== JSON.stringify(JSON.parse(plan.request?.messages[1].content || '{}').messages)) fail('stale_evidence');
        return state;
    }
    _ack(revision, plan, resultRef) {
        const state = this.intake._guard(revision);
        const remaining = plan.messageIds.filter(id => !state.receipts.some(r => r.id === id && r.resultRef === resultRef));
        if (!remaining.length) return;
        const records = remaining.map(id => state.records.find(r => r.id === id));
        if (records.some(r => !r || (r.status === 'analyzed' && r.resultRef !== resultRef))) fail('stale_receipt');
        const pending = records.filter(r => r.status === 'pending').map(r => r.id);
        if (pending.length) this.intake.acknowledge({ revision, messageIds: pending, resultRef });
        this.intake.acknowledge({ revision, messageIds: remaining, resultRef, delivered: true });
    }

    file(input) { return this._enqueue(() => this._file(input)); }
    async _file({ plan, text, revision, signal, checkpoint }) {
        const first = this.intake._guard(revision, signal);
        if (JSON.stringify(first.config.scope) !== JSON.stringify(plan.scope)) fail('stale_evidence');
        const resultRef = 'slack-result:' + digest([plan.scope.workspaceId, plan.scope.userId, [...plan.messageIds].sort()]);
        const before = this._read();
        const prior = before.slackDeliveries?.[resultRef];
        // A crash after the shared write, before either intake acknowledgement,
        // only replays acknowledgement. No repeated inference or side effects.
        if (prior) {
            if (JSON.stringify(prior.messageIds) !== JSON.stringify(plan.messageIds)) fail('stale_receipt');
            this._ack(revision, plan, resultRef);
            return { resultRef, matterIds: prior.matterIds, replayed: true };
        }
        this._current(revision, plan, signal);
        const model = modelFor(first.config.analysisModel);
        const observations = observationsFor(plan, text);
        const next = copy(before), service = Object.create(Matters);
        Object.assign(service, { _data: next, _queue: Promise.resolve(), _lastChange: new Map(), _strictInference: true,
            // observe is a staged transaction; no renderer/task/calendar effects
            // and no shared writes until every judgment and authorization passes.
            _save() {}, _changed() {}, _passOver() {}, _waitFor() {} });
        const current = (sources, destination = null) => {
            const state = this._current(revision, plan, signal);
            if (JSON.stringify(modelFor(state.config.analysisModel)) !== JSON.stringify(model)) return false;
            // Main authorization reads live local state synchronously. A
            // promise is not permission (it could settle after a revocation).
            return this.authorize({ revision, scope: plan.scope, model, sources, destination }) === true;
        };
        service._inference = async ({ params, sources }) => {
            if (!await current(sources)) fail('not_authorized');
            const cacheKey = digest([model, params.messages, sources]);
            const cached = checkpoint?.get(cacheKey);
            if (cached) return { message: { content: cached } };
            if (this.call) {
                const result = await this.call(params.messages, { revision, scope: plan.scope, sources, signal, maxTokens: params.maxTokens });
                checkpoint?.set(cacheKey, result.text);
                return { message: { content: result.text } };
            }
            const resolved = await this.provider(model);
            // The provider supplies credentials and the complete body builder;
            // it cannot send. Every primary/second/narrow look uses one sender.
            const body = resolved.body(params.messages, Math.min(params.maxTokens, 1024));
            if (body.model !== model.model) fail('model_changed');
            const response = await sendBounded({ scope: plan.scope, body, url: resolved.url, headers: resolved.headers,
                budget: this.budget, signal, fetch: this.fetch,
                authorize: destination => current(sources, destination) });
            return { message: { content: response.text } };
        };
        let inferenceError = null;
        const infer = service._inference;
        service._inference = async input => { try { return await infer(input); } catch (e) { inferenceError = e; throw e; } };
        // Other Slack accounts/channels need their own consent. Keep them out
        // of both the first shortlist and the wider second look.
        service._offerable = function (f) {
            return Matters._offerable.call(this, f).filter(m => !this.needsBounded(m)
                || (m.slackScopes?.length && m.slackScopes.every(s =>
                    s.workspaceId === plan.scope.workspaceId && s.userId === plan.scope.userId
                    && plan.scope.conversationIds.includes(s.channelId))));
        };
        // Current tasks are context, not a second place to file Slack findings.
        // A match records the existing task ID through the shared vet/apply.
        const scheduleState = this.store.get('app_schedule') || null;
        const commitmentsState = this.store.get('app_commitments') || null;
        const schedule = copy(scheduleState?.scheduleItems || []);
        const tasks = new Map(schedule.map(t => [t.id, t]));
        for (const c of commitmentsState?.items || []) {
            tasks.set(c.id, { id: c.id, title: c.title, scheduledDate: c.when?.date || c.by || null,
                createdAt: c.createdAt, repeat: c.repeat?.rule || 'none', lastCompletedDate: c.state !== 'open' ? true : null });
        }
        service.tasksAround = (days, now) => Matters.tasksAround(days, now, [...tasks.values()]);
        service.eventsOn = () => []; // calendar context awaits a scoped adapter
        const baseVet = service.vet;
        service.vet = function (raw, f, cands, now, events, tasks) {
            const j = baseVet.call(this, raw, f, cands, now, events, tasks);
            if (!j || j.about === 'none') return j;
            if (['done', 'cancelled'].includes(j.change) && f.slack.kind !== 'resolution') return null;
            if (['done', 'cancelled'].includes(j.change) && (typeof raw.resolution_quote !== 'string'
                || !raw.resolution_quote.trim() || !f.body.includes(raw.resolution_quote))) return null;
            // A resolution may need the wider second look to find an earlier
            // request in another thread. _fold below forbids creating a new
            // matter if that second look still found no existing one.
            const target = j.about !== 'new' && this.get(j.about);
            // An ignored matter stays ignored. Old/repeated observations must
            // not revive a resolved step; reopening needs a future user review.
            if (target && (target.state === 'ignored' || (target.state !== 'open' && !['done', 'cancelled'].includes(j.change)))) {
                return { ...j, title: '', status: '', change: 'same', next: null, when: null, time: null, tell: 'file' };
            }
            if (j.next && !j.next.quote) return null;
            // No guessed dates from a summary or timestamp. Relative/natural
            // language deadlines need a separate grounded date adapter.
            if (j.when && !f.body.includes(j.when)) { j.when = null; j.time = null; }
            if (j.time && !f.body.includes(j.time)) j.time = null;
            if (j.next?.by && !j.next.byQuote?.includes(j.next.by)) { j.next.by = null; j.next.time = null; }
            if (j.next?.time && !j.next.timeQuote?.includes(j.next.time)) j.next.time = null;
            if (j.next?.how === 'reply') Object.assign(j.next, { how: 'link', url: f.slack.sourceUrl, label: 'Open Slack', reply: null });
            // Quotes were checked against local evidence above. Sync only
            // derived facts + references, never the raw Slack excerpt.
            if (j.next) {
                j.next.evidenceIds = f.slack.evidenceIds;
                delete j.next.quote; delete j.next.byQuote; delete j.next.timeQuote;
            }
            return j;
        };
        service._fold = function (f, j, opts) {
            if (f.slack.kind === 'resolution' && j.about === 'new') return null;
            return Matters._fold.call(this, f, j, opts);
        };
        const matterIds = [];
        for (const observation of observations) {
            if (!await current(['slack'])) fail('not_authorized');
            const out = await service.observe(factsFor(observation, plan), { quiet: true, deferEffects: true });
            if (out.error || (!out.m && !out.j)) { if (inferenceError) throw inferenceError; fail('filing_incomplete'); }
            if (out.m && !matterIds.includes(out.m.id)) matterIds.push(out.m.id);
        }
        if (!await current(['slack'])) fail('not_authorized');
        this._current(revision, plan, signal);
        if (digest(this.store.get('app_schedule') || null) !== digest(scheduleState)
            || digest(this.store.get('app_commitments') || null) !== digest(commitmentsState)) fail('matter_changed');
        next.slackDeliveries ||= {};
        next.slackDeliveries[resultRef] = { at: this.now(), messageIds: plan.messageIds, matterIds };
        const refs = Object.keys(next.slackDeliveries).sort((a, b) => next.slackDeliveries[a].at - next.slackDeliveries[b].at);
        for (const ref of refs.slice(0, Math.max(0, refs.length - 1000))) delete next.slackDeliveries[ref];
        const effects = this.transaction && stageTasks(before, next, matterIds, commitmentsState, scheduleState, this.now());
        const commit = () => {
            this._commit(before, next);
            if (effects) {
                for (const [key, value] of Object.entries(effects)) {
                    if (this.store.set('app_' + key, value) === false
                        || digest(this.store.get('app_' + key)) !== digest(value)) fail('store_unavailable');
                }
            }
        };
        if (this.transaction) this.transaction(commit); else commit();
        this._ack(revision, plan, resultRef);
        return { resultRef, matterIds, replayed: false };
    }

    invalidate({ revision, signal }) {
        return this._enqueue(() => {
            const state = this.intake._guard(revision, signal);
            const invalidations = copy(state.invalidations);
            if (!invalidations.length) return { affected: 0 };
            const before = this._read(), next = copy(before);
            let affected = 0;
            for (const m of Object.values(next.matters)) {
                for (const s of m.sources || []) {
                    if (!s.slack || s.slack.workspaceId !== state.config.scope.workspaceId || s.slack.userId !== state.config.scope.userId) continue;
                    const hit = invalidations.filter(r => s.slack.evidenceIds.includes(r.id));
                    if (!hit.length) continue;
                    s.slack.invalidated = true;
                    s.tell = 'file';
                    m.evidenceNeedsReview = true;
                    if (m.next && (m.next.messageId === s.id || m.next.evidenceIds?.some(id => hit.some(r => r.id === id)))) m.next.evidenceInvalidated = true;
                    affected++;
                }
            }
            // Unavailability is not proof of completion or deletion. Keep the
            // historical state, flag it for review, and suppress its stale step.
            this.intake._guard(revision, signal);
            this._commit(before, next);
            this.intake.acknowledgeInvalidations({ revision, invalidations });
            return { affected };
        });
    }
}

module.exports = { SlackInsightDelivery, factsFor };
