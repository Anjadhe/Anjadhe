'use strict';
const { createHash } = require('node:crypto');
const { LIMITS, MonitorError, SlackAnalysisBudget, scopeFor } = require('./slack-monitor-policy');
const fail = code => { throw new MonitorError(code, `Slack analysis did not complete (${code}).`); };
const RESPONSE_BYTES = 64 * 1024;
const OUTPUT_BYTES = 8 * 1024;

/** Final serialized provider body, not a character estimate of its source
 * messages. A provider adapter must build its complete body before this door;
 * no tools, images, extra history or hidden retries can be appended afterward. */
function serializeRequest(body) {
    const allowed = new Set(['model', 'messages', 'system', 'stream', 'temperature', 'max_tokens',
        'max_completion_tokens', 'response_format', 'chat_template_kwargs']);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !allowed.has(k))) fail('invalid_request');
    if (typeof body.model !== 'string' || !body.model || body.model.length > 200 || body.stream !== false
        || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 3
        || body.messages.some(m => !m || !['system', 'user'].includes(m.role) || typeof m.content !== 'string'
            || Object.keys(m).some(k => !['role', 'content'].includes(k)))
        || (body.system != null && typeof body.system !== 'string')) fail('invalid_request');
    const cap = body.max_tokens ?? body.max_completion_tokens;
    if (!Number.isInteger(cap) || cap < 1 || cap > LIMITS.outputTokens
        || (body.max_tokens != null && body.max_completion_tokens != null)) fail('output_limit');
    if (body.temperature != null && body.temperature !== 0) fail('invalid_request');
    if (body.response_format != null && JSON.stringify(body.response_format) !== '{"type":"json_object"}') fail('invalid_request');
    if (body.chat_template_kwargs != null && JSON.stringify(body.chat_template_kwargs) !== '{"enable_thinking":false}') fail('invalid_request');
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized) > LIMITS.requestBytes) fail('request_limit');
    return serialized;
}

/** Private main-process seam. `authorize` verifies live consent, owner,
 * revision AND the resolved model/endpoint before every attempt. Each caller
 * retry invokes this function again and spends a fresh reservation. */
async function sendBounded({ scope, body, url, headers, budget, authorize, signal, fetch = globalThis.fetch }) {
    if (!(budget instanceof SlackAnalysisBudget) || typeof authorize !== 'function') fail('not_configured');
    let endpoint;
    try { endpoint = new URL(url); } catch { fail('invalid_destination'); }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) fail('invalid_destination');
    const serialized = serializeRequest(body), requestBytes = Buffer.byteLength(serialized), requestModel = body.model;
    scope = scopeFor(scope);
    const current = async () => !signal?.aborted && await authorize({ url: endpoint.href, model: requestModel }) === true && !signal?.aborted;
    if (!await current()) fail('not_authorized');
    const reservation = budget.reserve(scope, requestBytes);
    if (!await current()) fail('not_authorized');
    let response;
    try {
        response = await fetch(endpoint.href, { method: 'POST', redirect: 'error', headers: { ...headers, 'Content-Type': 'application/json' },
            body: serialized, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120000)]) });
        if (!await current()) fail('not_authorized');
        if (!response.ok) fail(response.status === 429 ? 'analysis_limit' : 'analysis_failed');
        if (Number(response.headers.get('content-length')) > RESPONSE_BYTES || !response.body) fail('response_limit');
        const reader = response.body.getReader(), chunks = [];
        let total = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.byteLength;
                if (total > RESPONSE_BYTES) { await reader.cancel(); fail('response_limit'); }
                chunks.push(Buffer.from(value));
            }
        } finally { reader.releaseLock(); }
        if (!await current()) fail('not_authorized');
        const data = JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
        if (data.choices?.[0]?.finish_reason === 'length' || data.stop_reason === 'max_tokens') fail('incomplete_result');
        if (data.choices?.[0]?.message?.tool_calls?.length || data.content?.some?.(c => c.type === 'tool_use')) fail('invalid_result');
        const text = data.choices?.[0]?.message?.content ?? data.content?.filter?.(c => c.type === 'text').map(c => c.text).join('');
        if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > OUTPUT_BYTES) fail('invalid_result');
        return { text, reservationId: reservation.id, requestBytes };
    } catch (error) {
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
        if (error instanceof MonitorError) throw error;
        fail('analysis_failed'); // neither credentials nor provider error text escape
    }
}

/** Convert strictly grounded findings into the existing observation shape.
 * Filing/notification remains the shared matter service's job. This function
 * writes nothing, invents no dates and never turns missing coverage into "done". */
function observationsFor(plan, text) {
    if (!plan?.request || typeof text !== 'string' || Buffer.byteLength(text) > OUTPUT_BYTES) fail('invalid_result');
    let result, evidence;
    try { result = JSON.parse(text); evidence = JSON.parse(plan.request.messages[1].content).messages; }
    catch { fail('invalid_result'); }
    if (!result || !Array.isArray(result.findings) || result.findings.length > 10 || Object.keys(result).some(k => k !== 'findings')) fail('invalid_result');
    const byId = new Map(evidence.map(m => [m.id, m])), seen = new Set(), observations = [];
    for (const f of result.findings) {
        if (!f || !['request', 'commitment', 'change', 'blocker', 'resolution'].includes(f.kind)
            || typeof f.summary !== 'string' || !f.summary.trim() || f.summary.length > 300
            || typeof f.quote !== 'string' || !f.quote.trim() || Buffer.byteLength(f.quote) > 2000
            || !Array.isArray(f.messageIds) || !f.messageIds.length || f.messageIds.length > LIMITS.analysisMessages
            || f.messageIds.some(id => !byId.has(id))
            || Object.keys(f).some(k => !['kind', 'summary', 'quote', 'messageIds'].includes(k))) fail('ungrounded_result');
        const messages = [...new Set(f.messageIds)].map(id => byId.get(id));
        if (!messages.some(m => m.text.includes(f.quote))) fail('ungrounded_result');
        const own = messages.every(m => m.userId === plan.scope.userId);
        if (own && f.kind === 'request') continue; // never manufacture an incoming obligation from an outgoing request
        const identity = `${f.kind}:${messages.map(m => m.id).sort().join('|')}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        const id = 'slack:' + createHash('sha256').update(identity).digest('hex').slice(0, 32);
        const last = messages.map(m => m.ts).sort().at(-1);
        observations.push({ id, source: 'slack', at: new Date(Number(last.split('.')[0]) * 1000).toISOString(),
            own, title: f.summary, summary: f.summary, text: f.quote, dates: [],
            evidenceIds: messages.map(m => m.id), workspaceId: plan.scope.workspaceId,
            channelId: messages[0].channelId, kind: f.kind, coverage: plan.coverage,
            sourceUrl: `https://slack.com/app_redirect?team=${plan.scope.workspaceId}&channel=${messages[0].channelId}` });
    }
    return observations;
}

module.exports = { serializeRequest, sendBounded, observationsFor };
