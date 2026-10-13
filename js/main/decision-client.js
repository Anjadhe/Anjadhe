'use strict';
// Device-owned dispatch intent and result reuse. Never retry a submitted
// decision, including after a timeout/restart (DECISION_MODELS D4, DJ4-DJ5).
//
// One receipt per exact request identity (state + tier + question + policy +
// backend), in machine-local settings, written BEFORE the request leaves:
//   dispatching  the intent; the request may be in flight or lost
//   unknown      dispatched, no outcome came back; a later `reconcile` may settle it
//   invalid      a KNOWN terminal outcome with no usable answer: Connect said the
//                provider's answer or model id was unusable, its own upstream
//                failed, or it scored the request but this Mac lost the answer.
//                Terminal: the decision is never re-dispatched for this identity.
//                The caller may run the judgment the decision replaced (D4 says a
//                dispatched failure is never masked by a second DECISION; the
//                generative check it stood in for is not a retry of it).
//   scored       a validated answer, reused on an identical request
// Unknown receipts block a new attempt for the same state and tier. Once old
// enough to be out of flight they are asked about (`/v1/decisions/status`, the
// id only) before they block, and `reconcile` sweeps them at launch and daily,
// so a lost response settles instead of sitting forever (2026-10-13).
const crypto = require('node:crypto');
const Contract = require('../shared/decision-contract');

function createDecisionClient({ baseUrl, store, resolveKey, acquire, fetch: fetcher = globalThis.fetch,
    now = Date.now, timeoutMs = 20000, settleAfterMs = 120000, recheckAfterMs = 600000 }) {
    const STORE = 'decisionDispatches';
    const STATUSES = ['dispatching', 'unknown', 'invalid', 'scored'];
    const OPEN = ['dispatching', 'unknown'];
    const pending = new Map();
    let discovery = null;
    let deniedUntil = 0;   // the service said this install is outside the rollout; ask again later
    const unsupported = () => ({ handled: false, status: 'unsupported' });
    const failed = (code, requestId) => ({ handled: true, status: 'unknown', code, requestId,
        error: 'The decision could not be confirmed. Its request has not been repeated.' });
    const invalid = (code, requestId, cached = false) => ({ handled: true, status: 'invalid', code, requestId, cached,
        error: 'The decision gave no usable answer. Its request has not been repeated.' });
    const preDispatchCodes = {
        400: ['request'], 401: ['auth'], 429: ['quota', 'background_quota', 'rate', 'busy', 'budget'],
        503: ['unsupported', 'budget']
    };
    // Connect's own terminal answers after dispatch (502 from /v1/decisions, or /status).
    const terminalCodes = { invalid: 'invalid_response', unknown: 'provider_failed', scored: 'answer_lost' };
    const getRows = () => {
        const raw = store.get(STORE, {});
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('receipt_store');
        const rows = structuredClone(raw);
        for (const [key, row] of Object.entries(rows)) {
            if (!/^[a-f0-9]{64}$/.test(key) || !row || typeof row !== 'object'
                || !/^[a-f0-9]{64}$/.test(row.semanticKey || '')
                || typeof row.requestId !== 'string'
                || !STATUSES.includes(row.status)
                || !Number.isFinite(row.at)
                || ('checkedAt' in row && !Number.isFinite(row.checkedAt))
                || ('code' in row && typeof row.code !== 'string')) throw new Error('receipt_store');
        }
        return rows;
    };
    function save(key, row) {
        const rows = getRows();
        rows[key] = structuredClone(row);
        // Only settled receipts can leave the bounded cache. An uncertain
        // intent is retained; eviction must never turn it into a fresh attempt.
        for (const status of ['scored', 'invalid']) {
            const done = Object.keys(rows).filter(k => rows[k].status === status)
                .sort((a, b) => rows[a].at - rows[b].at);
            while (done.length > 128) delete rows[done.shift()];
        }
        store.set(STORE, rows); // synchronous durable write before dispatch
    }
    function digest(input) {
        let secret = store.get('decisionDigestKey');
        if (!secret) {
            // Losing the digest secret cannot make retained uncertain intents
            // invisible and thereby permit fresh paid attempts.
            if (Object.keys(getRows()).length) throw new Error('receipt_key_missing');
            secret = crypto.randomBytes(32).toString('hex'); store.set('decisionDigestKey', secret);
        }
        if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret)) throw new Error('receipt_key_invalid');
        return crypto.createHmac('sha256', secret).update(JSON.stringify(Contract.canonical(input))).digest('hex');
    }
    async function readJson(res) {
        // Discovery/results contain no large content. Bound even an unexpected
        // service response before parsing; error bodies never reach logs.
        const reader = res.body.getReader();
        let size = 0; const chunks = [];
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > 65536) throw new Error('response_size');
                chunks.push(Buffer.from(value));
            }
        } finally { await reader.cancel().catch(() => {}); }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    async function capabilities() {
        if (discovery && now() < discovery.until) return discovery.value;
        try {
            const res = await fetcher(baseUrl + '/v1/decisions/capabilities', { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
            const value = res.ok ? await readJson(res) : null;
            if (!res.ok) await res.body?.cancel().catch(() => {});
            discovery = { value, until: now() + 60000 };
            return value;
        } catch { return null; }
    }
    /** Connect's status for one request id (the id is all that is sent), or null when it could not be asked. */
    async function statusOf(requestId) {
        try {
            const apiKey = await resolveKey();
            const res = await fetcher(baseUrl + '/v1/decisions/status', {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify({ requestId }), signal: AbortSignal.timeout(timeoutMs), redirect: 'error'
            });
            const json = await readJson(res);
            if (!res.ok || !json || json.requestId !== requestId || typeof json.status !== 'string') return null;
            return json.status;
        } catch { return null; }
    }
    /**
     * Settle one open receipt from Connect's accounting: a request Connect
     * finished (scored, invalid or failed) is terminal here with no answer
     * to recover; one Connect never reserved is dropped; one still in flight
     * stays. Returns the row as it stands afterwards, or null when dropped.
     * Asked at most once per `recheckAfterMs` per receipt, and only once it
     * is `settleAfterMs` old, so an in-flight request is never asked about.
     */
    async function settle(key, row) {
        const t = now();
        if (!OPEN.includes(row.status) || pending.has(row.semanticKey) || t - row.at < settleAfterMs
            || (row.checkedAt && t - row.checkedAt < recheckAfterMs)) return row;
        const status = await statusOf(row.requestId);
        if (status === 'not_found') { const rows = getRows(); delete rows[key]; store.set(STORE, rows); return null; }
        const next = { ...row, checkedAt: t };
        if (terminalCodes[status]) { next.status = 'invalid'; next.code = terminalCodes[status]; }
        else if (status === 'dispatching') next.status = 'unknown';
        save(key, next);
        return next;
    }
    /** Sweep every open receipt (launch, then daily). Sends ids only. */
    async function reconcile() {
        const out = { open: 0, settled: 0, dropped: 0 };
        let rows;
        try { rows = getRows(); } catch { return { ...out, error: 'receipt_store' }; }
        for (const [key, row] of Object.entries(rows)) {
            if (!OPEN.includes(row.status)) continue;
            out.open++;
            let next;
            try { next = await settle(key, row); } catch { continue; }
            if (next === null) { out.dropped++; out.open--; }
            else if (next.status === 'invalid') { out.settled++; out.open--; }
        }
        return out;
    }
    async function evaluate(params) {
        if (params.engine !== 'anjadhe' || !Contract.CLOUD_MODELS.includes(params.model)
            || params.jobClass !== 'background' || !Contract.USE_CASES[params.useCase]
            || !Contract.validState(params.state, params.useCase)) return unsupported();
        let semanticKey;
        try {
            // Snapshot caller data before the first await. A queued caller
            // cannot change the payload after its dispatch identity is chosen.
            const semantic = { cloudModel: params.model, workClass: 'background', useCase: params.useCase,
                schemaVersion: Contract.VERSION, questionVersion: Contract.VERSION, state: structuredClone(params.state) };
            semanticKey = digest(semantic);
            if (pending.has(semanticKey)) {
                const { audit, ...result } = await pending.get(semanticKey);
                return { ...structuredClone(result), joined: true, ...(result.status === 'scored' ? { cached: true } : {}) };
            }
            const job = prepare(semanticKey, semantic);
            pending.set(semanticKey, job);
            try { return await job; } finally { pending.delete(semanticKey); }
        } catch { return failed('storage_unavailable'); }
    }
    async function prepare(semanticKey, semantic) {
        // Version 1 asked a binary question. A new question must not forget a
        // paid outcome still unresolved for the same underlying state/tier.
        const priorKeys = [semanticKey, ...(semantic.useCase === Contract.USE_CASE
            ? [digest({ ...semantic, schemaVersion: 1, questionVersion: 1 })] : [])];
        const rows = getRows();
        const priorKey = Object.keys(rows).find(k => priorKeys.includes(rows[k].semanticKey) && rows[k].status !== 'scored');
        if (priorKey) {
            // Open: ask Connect once it is old enough; still open blocks. Terminal
            // (now or already): reported, never dispatched again for this state
            // and tier, whatever the backend is today. Dropped (never reserved):
            // a fresh attempt may go.
            const prior = await settle(priorKey, rows[priorKey]);
            if (prior && prior.status === 'invalid') return invalid(prior.code || 'invalid_response', prior.requestId, true);
            if (prior) return failed('outcome_unknown', prior.requestId);
        }
        if (now() < deniedUntil) return unsupported();
        const cap = await capabilities();
        const offer = Contract.capabilityFor(cap, semantic.useCase);
        if (!offer || offer.mode !== 'active') return unsupported();
        const key = digest({ semantic, definition: offer.definition, policy: offer.policy, backend: offer.backendRevision });
        return run(key, semanticKey, semantic, cap);
    }
    async function run(key, semanticKey, semantic, cap) {
        const existing = getRows()[key];
        if (existing) {
            if (existing.status === 'scored' && Contract.validResponse(existing.response,
                { ...semantic, requestId: existing.requestId }, cap)) {
                return { ...existing.response, handled: true, cached: true };
            }
            if (existing.status === 'invalid') return invalid(existing.code || 'invalid_response', existing.requestId, true);
            return failed('outcome_unknown', existing.requestId);
        }
        if (Object.values(getRows()).filter(r => OPEN.includes(r.status)).length >= 128) return failed('recovery_required');
        let apiKey;
        try { apiKey = await resolveKey(); } catch { return failed('credentials_unavailable'); }
        const release = await acquire(false);
        const request = { ...semantic, requestId: crypto.randomUUID() };
        const audit = { request, left: true, destination: 'nenva Connect', cached: false };
        let dispatched = false;
        try {
            save(key, { semanticKey, requestId: request.requestId, status: 'dispatching', at: now() });
            dispatched = true;
            const res = await fetcher(baseUrl + '/v1/decisions', {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify(request), signal: AbortSignal.timeout(timeoutMs), redirect: 'error'
            });
            const result = await readJson(res);
            if (!res.ok || !Contract.validResponse(result, request, cap)) {
                // A bounded service declaration can confirm rejection before
                // provider dispatch. It permits a later attempt, never a retry
                // or generative fallback in this call.
                if (!res.ok && result?.status === 'not_dispatched' && preDispatchCodes[res.status]?.includes(result.code)) {
                    const rows = getRows(); delete rows[key]; store.set(STORE, rows);
                    // Outside the rollout (or the use case is off for this install): stop asking for a while.
                    if (result.code === 'unsupported') deniedUntil = now() + 600000;
                    return { handled: true, status: 'not_dispatched', code: result.code, requestId: request.requestId,
                        error: 'The decision request was not dispatched.', audit };
                }
                // Connect's own word that the request is finished with no usable
                // answer: terminal here, with the exact dispatch still on record.
                if (!res.ok && res.status === 502 && result?.requestId === request.requestId
                    && ['invalid', 'unknown'].includes(result.status)) {
                    const code = terminalCodes[result.status];
                    save(key, { semanticKey, requestId: request.requestId, status: 'invalid', code, at: now() });
                    return { ...invalid(code, request.requestId), audit };
                }
                save(key, { semanticKey, requestId: request.requestId, status: 'unknown', at: now() });
                return { ...failed('outcome_unknown', request.requestId), audit };
            }
            save(key, { semanticKey, requestId: request.requestId, status: 'scored', response: result, at: now() });
            return { ...result, handled: true, cached: false, audit };
        } catch {
            // Persistence failure after the response leaves the dispatch intent
            // in place. A restart cannot initiate a duplicate paid request.
            return { ...failed(dispatched ? 'outcome_unknown' : 'storage_unavailable', request.requestId),
                ...(dispatched ? { audit } : {}) };
        } finally { release(); }
    }
    return { evaluate, reconcile };
}
module.exports = { createDecisionClient };
