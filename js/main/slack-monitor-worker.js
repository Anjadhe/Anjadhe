'use strict';
const { planAnalysis } = require('./slack-monitor-policy');
const { serializeRequest } = require('./slack-monitor-inference');
const { bodyFor } = require('./slack-monitor-client');
const KEY = 'slackMonitorWork';

/** At most one bounded analysis batch per scheduler pass. The saved draft
 * survives a crash between analysis, filing and intake acknowledgement. */
class SlackMonitorWorker {
    constructor({ intake, delivery, client, store, now = Date.now }) {
        Object.assign(this, { intake, delivery, client, store, now });
        this.active = null;
    }
    cancel() { this.active?.abort(); this.client.cancel?.(); }
    clear() { this.cancel(); this.store.set(KEY, {}); }
    status() {
        const s = this.store.get(KEY) || {};
        let usage;
        try { usage = this.client.budget.status(); }
        catch { usage = { unavailable: true }; }
        return { analysisState: s.error || (this.active ? 'analyzing' : 'ready'), lastAnalysisAt: s.lastAnalysisAt || null,
            analysisNextAt: s.notBefore || 0, deferred: s.deferred || 0, usage };
    }
    async step() {
        if (this.active) return;
        const state = this.intake._read();
        if (!state.config || state.paused || !this.intake.allowed()) return;
        let work = this.store.get(KEY) || {};
        if (work.revision !== state.revision) work = { revision: state.revision, lastAnalysisAt: work.lastAnalysisAt };
        if (work.notBefore > this.now()) return;
        const active = this.active = new AbortController();
        try {
            await this.delivery.invalidate({ revision: state.revision, signal: active.signal });
            if (!work.draft) {
                const pending = this.intake.pending();
                let plan = planAnalysis(pending);
                // Leave room for the real provider wrapper, by deferring whole
                // messages. Never trim an excerpt to make the request fit.
                while (plan.request) {
                    try { serializeRequest(bodyFor(state.config.analysisModel, plan.request.messages)); break; }
                    catch (e) {
                        if (e.code !== 'request_limit') throw e;
                        const keep = new Set(plan.messageIds.slice(0, -1));
                        plan = planAnalysis({ ...pending, messages: pending.messages.filter(m => keep.has(`${m.workspaceId}:${m.channelId}:${m.ts}:${m.editedTs || 'original'}`)) });
                    }
                }
                if (!plan.request) {
                    this.store.set(KEY, { revision: state.revision, lastAnalysisAt: work.lastAnalysisAt,
                        error: pending.messages.length ? 'deferred' : null, deferred: pending.messages.length, notBefore: this.now() + 60000 });
                    return;
                }
                const result = await this.client.call(plan.request.messages, { revision: state.revision, scope: plan.scope, signal: active.signal });
                this.intake._guard(state.revision, active.signal);
                work.draft = { plan, text: result.text };
                this.store.set(KEY, work);
            }
            await this.delivery.file({ ...work.draft, revision: state.revision, signal: active.signal, checkpoint: {
                get: key => work.judgments?.[key],
                set: (key, text) => {
                    this.intake._guard(state.revision, active.signal);
                    work.judgments ||= {};
                    if (Object.keys(work.judgments).length >= 40 && !work.judgments[key]) return;
                    work.judgments[key] = text;
                    this.store.set(KEY, work);
                }
            } });
            this.store.set(KEY, { revision: state.revision, lastAnalysisAt: this.now(), notBefore: this.now() + 15000 });
        } catch (e) {
            // Never retain raw Slack material after consent changes.
            const current = this.intake._read();
            if (active.signal.aborted || current.revision !== state.revision) return;
            if (['stale_evidence', 'stale_receipt', 'invalid_result', 'ungrounded_result'].includes(e.code)) { delete work.draft; delete work.judgments; }
            if (e.code === 'filing_incomplete') delete work.judgments;
            work.error = e.code || 'analysis_failed'; work.failures = Math.min(6, (work.failures || 0) + 1);
            work.notBefore = this.now() + Math.min(3600000, 60000 * 2 ** work.failures);
            this.store.set(KEY, work);
        } finally { if (this.active === active) this.active = null; }
    }
}
module.exports = { SlackMonitorWorker, WORK_KEY: KEY };
