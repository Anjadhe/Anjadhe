'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { LLMScheduler } = require('../js/main/llm-scheduler');
const { createLLMResourceResolver } = require('../js/main/llm-resource');
const Logger = require('../js/agent/llm-logger');
const Capture = require('../js/agent/thing-capture');

const main = fs.readFileSync(require.resolve('../main.js'), 'utf8');
function section(start, end) {
    const a = main.indexOf(start);
    assert.ok(a >= 0, start);
    const b = main.indexOf(end, a);
    assert.ok(b > a, end);
    return main.slice(a, b);
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

async function run() {
    const events = [], clamped = [], streams = new Map();
    const scheduler = new LLMScheduler({ cooldownMs: 0 });
    const resolver = createLLMResourceResolver({ networkInterfaces: () => ({}), hostname: () => 'test' });
    const context = vm.createContext({ AbortController, Date, activeLLMStreams: streams,
        llmScheduler: scheduler, _aiActivitySeq: 0,
        settingsStore: { get: (key, fallback) => key === 'llmProvider' ? 'local' : fallback },
        clampBackgroundPrompt: params => clamped.push(params),
        emitAIActivity: event => events.push(event),
        llmSchedulingResource: params => resolver(params) });
    vm.runInContext(section('function isLocalLLMJob(params) {', '\n// --- AI activity feed ---')
        + section('const withLLMScheduler = ', '\n// Logged once per session:')
        + '\nglobalThis.wrap = withLLMScheduler; globalThis.classify = isLocalLLMJob;', context);
    let finish;
    const dispatches = [];
    const request = context.wrap('interactive', async (_, params) => {
        dispatches.push(params);
        if (params.model === 'held') await new Promise(resolve => { finish = resolve; });
        if (params.model === 'error') throw new Error('fixture failure');
        return { message: { content: 'fixture answer' }, prompt_eval_count: 12,
            timings: { cache_n: 7, prompt_n: 5, prompt_ms: 2, predicted_ms: 3 } };
    });
    const params = (model, extra = {}) => ({ engine: 'server', baseUrl: 'http://127.0.0.1:8080/v1', model,
        messages: [{ role: 'user', content: 'synthetic' }], ...extra });
    const held = request({}, params('held'));
    await flush();
    const queued = request({}, params('cancelled', { streamId: 'stopped' }));
    await flush();
    assert.equal(dispatches.length, 1);
    assert.equal(typeof streams.get('stopped'), 'function', 'Stop works before HTTP dispatch');
    streams.get('stopped')();
    assert.equal((await queued).aborted, true);
    assert.equal(streams.has('stopped'), false);
    assert.equal(events.filter(e => e.event === 'end' && e.aborted).length, 1);

    // Both frontier adapters can dispatch while the local resource is occupied.
    for (const engine of ['openai', 'anthropic', 'anjadhe']) {
        const result = await request({}, { model: 'cloud', engine, messages: [] });
        assert.equal(result._scheduling.resourceId, null);
    }
    finish();
    const result = await held;
    assert.equal(result._scheduling.resourceId, 'local-inference');
    assert.equal(result.message.content, 'fixture answer');
    assert.equal(context.classify(params('test')), false, 'legacy disclosure/clamp classification is preserved');
    const background = context.wrap('background', async () => ({ message: { content: 'background' } }));
    await background({}, params('bg'));
    assert.equal(clamped.length, 1, 'a same-Mac server retains the existing off-device clamp contract');
    await assert.rejects(request({}, params('error')), /fixture failure/);
    assert.equal(scheduler.snapshot().interactiveActive, 0, 'errors release the permit');
    assert.equal(scheduler.snapshot().backgroundActive, 0);
    assert.ok(!dispatches.some(p => p.model === 'cancelled'));
    assert.ok(events.some(e => e.event === 'run' && e.resource === 'local-inference' && e.queueWaitMs >= 0));

    const timing = Logger._timingMeta(result);
    assert.equal(timing.resourceId, 'local-inference');
    assert.equal(timing.cacheTokens, 7);
    assert.equal(timing.prefillTokens, 5);
    assert.equal(timing.prefillMs, 2);
    assert.equal(timing.generationMs, 3);
    assert.deepEqual(Logger._timingMeta({ timings: { cache_n: Infinity, prompt_ms: -1 } }), {});

    // Exercise the actual picker/router/judge without records or network. The
    // cancellation callback stays in the renderer and is never sent over IPC.
    global.AgentService = { model: 'fixture', numCtx: 8192 };
    const captureRequests = [];
    global.LLMLogger = { call: async (_, p) => {
        captureRequests.push(p);
        return { message: { content: '{"item":1,"claims":[]}' } };
    } };
    const capture = Object.create(Capture);
    capture._memberLine = key => key;
    const conv = { id: 'conversation', messages: [] };
    const meta = { turnId: 'turn', isCancelled: () => false };
    await capture._pickAmong(conv, ['task:a', 'task:b'], ['task:a', 'task:b'], 'fixture', null, meta);
    capture.routeCandidates = () => [];
    await capture.routeGeneral(conv, 'fixture', meta);
    capture.facts = () => ({ commitment: { title: 'fixture' } });
    capture._prompt = () => 'fixture';
    capture.planFor = () => ({});
    await capture._judge({ type: 'task', id: 'a' }, 'fixture', null, { requestMeta: { ...meta, convId: conv.id } });
    for (const p of captureRequests) {
        assert.equal(p.jobClass, 'interactive');
        assert.equal(p.convId, conv.id);
        assert.equal(p.turnId, 'turn');
        assert.equal(p.think, false);
        assert.equal('isCancelled' in p, false);
    }
    assert.equal(captureRequests.length, 3);
    await capture._pickAmong(conv, ['task:a', 'task:b'], ['task:a', 'task:b'], 'fixture', null,
        { ...meta, jobClass: 'background' });
    assert.equal(captureRequests.at(-1).jobClass, 'background', 'explicit deferred work keeps its own class');
    let cancelled = false;
    global.LLMLogger.call = async () => { cancelled = true; return { message: { content: '{}' } }; };
    assert.equal(await capture._judge({ type: 'task', id: 'a' }, 'fixture', null,
        { requestMeta: { isCancelled: () => cancelled } }), null, 'late capture results cannot write after Stop');

    // The production claim-check callback supplies the turn's effective class.
    const agent = fs.readFileSync(require.resolve('../js/agent/agent-service'), 'utf8');
    const a = agent.indexOf('const checkParams = { ...p, jobClass:');
    const b = agent.indexOf('\n                    });', a);
    assert.ok(a >= 0 && b > a);
    const calls = [];
    const checkContext = vm.createContext({ opts: {}, streamId: 'turn', targetConvId: 'conversation',
        LLMLogger: { call: (source, p) => { calls.push({ source, p }); } } });
    const check = vm.runInContext('(p) => {' + agent.slice(a, b) + '\n}', checkContext);
    check({ think: false });
    assert.equal(calls[0].p.jobClass, 'interactive');
    assert.equal(calls[0].p.turnId, 'turn');
    checkContext.opts.jobClass = 'background';
    check({ think: false });
    assert.equal(calls[1].p.jobClass, 'background');
    console.log('LLM scheduling integration: main dispatch, queued Stop, permit cleanup, clamp/routing preservation, diagnostics and reply dependencies passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
