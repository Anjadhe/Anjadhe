'use strict';
const assert = require('node:assert/strict');
const { serializeRequest, sendBounded, observationsFor } = require('../js/main/slack-monitor-inference');
const { SlackAnalysisBudget, planAnalysis, LIMITS } = require('../js/main/slack-monitor-policy');
const scope = { workspaceId: 'T123', userId: 'U123', conversationIds: ['D123'] };
const message = { workspaceId: 'T123', channelId: 'D123', userId: 'U456', ts: '1770000000.000001', text: 'Please review the launch plan.' };
const plan = planAnalysis({ scope, messages: [message], readComplete: false });
const body = { model: 'model-12b', messages: plan.request.messages, stream: false, max_tokens: 1024, response_format: { type: 'json_object' } };
const code = value => error => error.code === value;
const fixture = () => {
    let ledger, calls = 0;
    const budget = new SlackAnalysisBudget({ store: { get: () => ledger, set: (_, value) => { ledger = structuredClone(value); } } });
    const opts = { scope, body, url: 'https://model.example/v1/chat/completions', headers: { Authorization: 'Bearer CANARY' }, budget, authorize: () => true,
        fetch: async (url, input) => { calls++; assert.equal(input.redirect, 'error'); assert.equal(ledger.reservations.at(-1).bytes, Buffer.byteLength(input.body));
            assert.equal(input.body, serializeRequest(body)); return Response.json({ choices: [{ message: { content: '{"findings":[]}' }, finish_reason: 'stop' }] }); } };
    return { opts, get calls() { return calls; }, get ledger() { return ledger; } };
};

(async () => {
    for (const bad of [{ ...body, tools: [] }, { ...body, max_tokens: 1025 }, { ...body, stream: true },
        { ...body, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: 'secret' }] }] },
        { ...body, messages: [...body.messages, ...body.messages] }, { ...body, extraHistory: 'CANARY' }]) assert.throws(() => serializeRequest(bad));
    const large = { ...body, messages: [{ role: 'system', content: 'x'.repeat(LIMITS.requestBytes - 60) }] };
    assert.throws(() => serializeRequest(large), code('request_limit'), 'provider fields count toward the final wire cap');
    let f = fixture();
    assert.equal((await sendBounded(f.opts)).text, '{"findings":[]}');
    assert.equal(f.calls, 1);
    f = fixture();
    await assert.rejects(sendBounded({ ...f.opts, authorize: () => false }), e => e.code === 'not_authorized' && !e.attempted, 'nothing sent, nothing for the ledger');
    assert.equal(f.calls, 0); assert.equal(f.ledger, undefined);
    let authChecks = 0;
    await assert.rejects(sendBounded({ ...f.opts, authorize: () => ++authChecks === 1 }), code('not_authorized'));
    assert.equal(f.calls, 0); assert.equal(f.ledger.reservations.length, 1, 'revocation after reservation does not refund it');
    f = fixture();
    for (let i = 0; i < 2; i++) await assert.rejects(sendBounded({ ...f.opts, fetch: async () => { throw new Error('CANARY private transport error'); } }), e => e.code === 'analysis_failed' && !e.message.includes('CANARY') && e.attempted === true);
    assert.equal(f.ledger.reservations.length, 2, 'caller retry pays again; transport itself never retries');
    let cancelled = false;
    await assert.rejects(sendBounded({ ...f.opts, fetch: async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; } })) }), code('response_limit'));
    assert.equal(cancelled, true);
    await assert.rejects(sendBounded({ ...f.opts, fetch: async () => Response.json({ choices: [{ message: { content: '{}' }, finish_reason: 'length' }] }) }), code('incomplete_result'));
    await assert.rejects(sendBounded({ ...f.opts, fetch: async () => Response.json({ choices: [{ message: { content: '{}', tool_calls: [{}] } }] }) }), code('invalid_result'));
    const abort = new AbortController();
    await assert.rejects(sendBounded({ ...f.opts, signal: abort.signal, fetch: async () => { abort.abort(); return Response.json({ choices: [{ message: { content: '{}' } }] }); } }), code('not_authorized'));

    // The ledger entry names where the call went (CLOUD_PRIVACY.md L1).
    const { destinationOf, logEntry } = require('../js/main/slack-monitor-client');
    assert.deepEqual(destinationOf({ engine: 'llamacpp' }), { left: false, destination: 'This Mac' });
    assert.deepEqual(destinationOf({ engine: 'anjadhe', label: 'nenva cloud lite' }), { left: true, destination: 'nenva cloud lite' });
    assert.equal(destinationOf({ engine: 'server' }).destination, 'Your server');
    const failed = logEntry({ engine: 'openai', model: 'gpt' }, body.messages, { startedAt: Date.now(), error: { code: 'analysis_failed', message: 'CANARY' } });
    assert.equal(failed.left, true); assert.equal(failed.destination, 'OpenAI (your key)'); assert.ok(!failed.error.includes('CANARY'));

    const finding = { kind: 'request', summary: 'Review the launch plan', quote: message.text, messageIds: plan.messageIds };
    const parse = findings => observationsFor(plan, JSON.stringify({ findings }));
    assert.deepEqual(parse([]), []);
    const out = parse([finding, { ...finding, summary: 'Different wording' }]);
    assert.equal(out.length, 1, 'same evidence and kind do not multiply observations when wording changes');
    assert.equal(out[0].source, 'slack'); assert.equal(out[0].own, false); assert.equal(out[0].coverage.complete, false);
    assert.deepEqual(out[0].dates, [], 'the adapter creates no inferred deadline');
    for (const bad of [{ ...finding, messageIds: ['invented'] }, { ...finding, quote: 'Invented deadline tomorrow' },
        { ...finding, quote: ' ' }, { ...finding, action: 'send_email' }]) assert.throws(() => parse([bad]), code('ungrounded_result'));
    const ownPlan = planAnalysis({ scope, messages: [{ ...message, userId: scope.userId }] });
    assert.deepEqual(observationsFor(ownPlan, JSON.stringify({ findings: [{ ...finding, messageIds: ownPlan.messageIds }] })), []);
    console.log('Slack inference: final wire caps, durable attempts, cancellation and grounded observations passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
