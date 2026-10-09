'use strict';
const assert = require('node:assert/strict');
const { SlackMonitorIntake } = require('../js/main/slack-monitor-intake');
const { SlackAnalysisBudget, planAnalysis } = require('../js/main/slack-monitor-policy');
const { SlackModelClient, bodyFor } = require('../js/main/slack-monitor-client');
const { SlackInsightDelivery } = require('../js/main/slack-monitor-insights');
const { SlackMonitorWorker, WORK_KEY } = require('../js/main/slack-monitor-worker');
const { SlackMatterBridge } = require('../js/main/slack-monitor-bridge');
const { digest } = require('../js/main/slack-monitor-routines');
const { serializeRequest } = require('../js/main/slack-monitor-inference');
const Matters = require('../js/core/matters');
const Commitments = require('../js/core/commitments');
const NOW = Date.parse('2026-10-07T12:00:00Z');
const scope = { workspaceId: 'T123', userId: 'U123', conversationIds: ['D123'] };
const model = { id: 'local', engine: 'llamacpp', model: 'test-12b', label: 'Local' };
const text = 'Please review the proposal by 2026-10-12.';
const judgment = { about: 'new', kind: 'other', title: 'Proposal review', status: 'Needs your review', change: 'new', tell: 'morning',
    next: { what: 'Review proposal', quote: text, by: '2026-10-12', by_quote: 'by 2026-10-12', yours: true, how: 'none' } };
async function fixture() {
    const data = new Map(); let now = NOW, failKey = null, released = 0;
    const store = { get: k => structuredClone(data.get(k)), set(k, value) {
        if (failKey === k) { failKey = null; throw new Error('disk full'); }
        data.set(k, structuredClone(value));
    } };
    const transaction = fn => { const snapshot = structuredClone(data); try { fn(); } catch (e) { data.clear(); for (const [k, v] of snapshot) data.set(k, v); throw e; } };
    const intake = new SlackMonitorIntake({ store, readerFor: () => ({ identity: async () => scope }), allowed: () => true, now: () => now });
    await intake.configure({ serverName: 'slack', scope, analysisModel: model, destination: 'local', consent: true });
    store.set('app_agent-settings', { modelList: [model] });
    const budget = new SlackAnalysisBudget({ store, now: () => now });
    const answers = [], calls = [], audits = [];
    const client = new SlackModelClient({ store, intake, budget, catalog: () => store.get('app_agent-settings').modelList, audit: e => audits.push(e),
        resolve: async () => ({ url: 'http://127.0.0.1:12345/v1/chat/completions', headers: {} }),
        schedule: async () => ({ release: () => released++ }), fetch: async (_, request) => {
            calls.push(JSON.parse(request.body));
            const answer = answers.shift(); assert.ok(answer, 'unexpected inference');
            return typeof answer === 'function' ? answer(request) : Response.json({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }] });
        } });
    const delivery = new SlackInsightDelivery({ store, intake, budget, transaction, now: () => now,
        call: (m, o) => client.call(m, o), authorize: grant => client.authorize(grant) });
    const worker = () => new SlackMonitorWorker({ store, intake, delivery, client, now: () => now });
    return { store, intake, budget, client, delivery, worker, answers, calls, audits, transaction,
        get released() { return released; }, advance: ms => now += ms, fail: k => failKey = k,
        add(n, body = text, own = false, kind = 'request', threadTs = null) {
            const state = intake._read(); intake._ingest(state, 'D123', [{ kind: 'message', workspaceId: 'T123', channelId: 'D123',
                userId: own ? 'U123' : 'U456', ts: `1791374400.${String(n).padStart(6, '0')}`, editedTs: null, threadTs,
                text: body, attachmentsOmitted: false, hasReplies: false }]); intake._save(state);
            const plan = planAnalysis(intake.pending());
            answers.push({ findings: [{ kind, summary: 'Proposal review', quote: body, messageIds: plan.messageIds }] });
            return plan;
        },
        get matters() { return store.get('app_matters'); }
    };
}

(async () => {
    for (const engine of ['llamacpp', 'server', 'anjadhe', 'anthropic', 'openai']) {
        const body = bodyFor({ ...model, engine }, [{ role: 'system', content: 'JSON' }, { role: 'user', content: 'Synthetic' }]);
        assert.ok(serializeRequest(body));
        if (engine === 'anthropic') assert.equal(body.messages.length, 1);
        if (engine === 'openai') assert.equal(body.max_completion_tokens, 1024);
    }
    let f = await fixture(); f.add(1); f.answers.push(judgment);
    await f.worker().step();
    assert.equal(f.intake.status().pending, 0); assert.equal(f.calls.length, 2); assert.equal(f.released, 2);
    const m = Object.values(f.matters.matters)[0]; assert.ok(m.next); assert.equal(f.store.get('app_commitments'), undefined, 'new work is proposed, not silently added to Tasks');
    assert.equal(f.worker().status().usage.requestsToday, 2);
    assert.equal(f.audits.length, 2, 'every model call reaches LLM Logs');
    assert.ok(f.audits.every(a => a.source === 'slack-monitor' && a.left === false && a.destination === 'This Mac' && a.response && !a.error));
    assert.ok(f.audits[0].userPrompt.includes(text), 'the log shows what the model was given, like every other call');

    f = await fixture(); f.add(1); f.answers.push(judgment);
    for (let i = 0; i < 11; i++) f.budget.reserve(scope, 100);
    await f.worker().step();
    assert.equal(f.worker().status().analysisState, 'analysis_limit'); assert.equal(f.calls.length, 1);
    f.advance(3600001); await f.worker().step();
    assert.equal(f.intake.status().pending, 0); assert.equal(f.calls.length, 2, 'quota delay does not repeat initial analysis');

    // Analysis survives a restart after shared persistence fails. Completed
    // filing judgments are reused as well, without another paid attempt.
    f = await fixture(); f.add(1); f.answers.push(judgment); f.fail('app_matters');
    await f.worker().step(); assert.ok(f.store.get(WORK_KEY).draft); assert.equal(f.intake.status().pending, 1);
    f.advance(3600000); await f.worker().step(); assert.equal(f.calls.length, 2); assert.equal(f.intake.status().pending, 0);

    // Cancellation after transport began cannot file a late model response.
    f = await fixture(); f.add(1); f.answers.splice(0, 1, () => {
        f.intake.pause(true); return Response.json({ choices: [{ message: { content: '{"findings":[]}' } }] });
    });
    await f.worker().step(); assert.equal(f.matters, undefined); assert.equal(f.released, 1);

    // Exact linked-task resolution is atomic with the matter and receipt.
    f = await fixture(); f.add(1); f.answers.push(judgment); await f.worker().step();
    const all = f.matters, item = Object.values(all.matters)[0]; item.next.taskId = 'task1'; item.tasks = ['task1']; f.store.set('app_matters', all);
    const task = Commitments.blank('task1', new Date(NOW).toISOString()); task.title = 'Review proposal';
    f.store.set('app_commitments', { items: [task], ledger: [], tombstones: {} });
    f.store.set('app_schedule', { scheduleItems: [Commitments.toTask(task)] });
    f.advance(60000); f.add(2, 'I finished the proposal review.', true, 'resolution', '1791374400.000001');
    f.answers.push({ ...judgment, about: 'M1', change: 'done', status: 'Finished', next: null, resolution_quote: 'I finished the proposal review.' });
    f.fail('app_commitments'); await f.worker().step();
    assert.equal(f.store.get('app_commitments').items[0].state, 'open'); assert.equal(Object.values(f.matters.matters)[0].state, 'open');
    f.advance(3600000); await f.worker().step();
    assert.equal(f.store.get('app_commitments').items[0].state, 'done'); assert.equal(Object.values(f.matters.matters)[0].state, 'done');
    assert.ok(f.store.get('app_commitments').ledger.some(l => l.op === 'done'));
    const { stageTasks } = require('../js/main/slack-monitor-tasks');
    const before = { matters: { m: { id: 'm', state: 'open', next: { taskId: 'task1' } } } };
    const after = { matters: { m: { id: 'm', state: 'done', next: { taskId: 'task1' }, sources: [{ slack: { kind: 'resolution' } }] } } };
    const original = { items: [task], ledger: [], tombstones: {} };
    assert.ok(stageTasks(before, after, ['m'], original, {}));
    after.matters.m.state = 'ignored'; assert.equal(stageTasks(before, after, ['m'], original, {}), null, 'ignored never means completed');
    after.matters.m.state = 'done'; original.items[0].repeat = { rule: 'daily', days: [] };
    assert.equal(stageTasks(before, after, ['m'], original, {}), null, 'a resolution never completes a recurring series');

    // Later email uses the same approved model + quota, not the chat model.
    f = await fixture(); f.add(1); f.answers.push(judgment); await f.worker().step();
    const id = Object.keys(f.matters.matters)[0], bridge = new SlackMatterBridge(f);
    const facts = Matters.observation({ id: 'email:1', source: 'email', text: 'The proposal is now ready.', summary: 'Proposal ready' });
    f.answers.push({ ...judgment, about: 'M1', change: 'changed' });
    const result = await bridge.judge({ kind: 'judge', f: facts, candidateIds: [id], tasks: [], events: [] });
    assert.ok(result.message.content); assert.equal(f.calls.length, 3);
    const changed = f.matters; changed.matters[id].slackScopes[0].channelId = 'D999'; f.store.set('app_matters', changed);
    await assert.rejects(bridge.judge({ kind: 'same', x: { id }, y: { title: 'Proposal', privacySources: ['email'] } }), e => e.code === 'scope_changed');
    assert.equal(f.calls.length, 3);

    // Reviews consume findings, remain quiet on repeats, and never infer.
    f = await fixture(); f.add(1); f.answers.push(judgment); await f.worker().step();
    const conv = { id: 'review', standing: { config: { offline: true, slackWatch: { ...scope, kinds: ['request'], since: NOW } } } };
    f.store.set('app_agent-conversations', { conversations: [conv] });
    const review = digest({ ...f, routineId: 'review' }); assert.equal(review.items.length, 1); assert.match(review.content, /Open Slack/);
    conv.standing.slackSeen = Object.fromEntries(review.items.map(i => [i.id, i.fingerprint])); f.store.set('app_agent-conversations', { conversations: [conv] });
    assert.equal(digest({ ...f, routineId: 'review' }).content, ''); assert.equal(f.calls.length, 2);
    conv.standing.config.slackWatch.conversationIds = ['D999']; f.store.set('app_agent-conversations', { conversations: [conv] });
    assert.throws(() => digest({ ...f, routineId: 'review' }), e => e.code === 'routine_unavailable');

    f.store.set('app_agent-settings', { modelList: [{ ...model, model: 'other-model' }] });
    await assert.rejects(f.client.call([{ role: 'user', content: 'test' }], { revision: f.intake.status().revision, scope }), e => e.code === 'model_changed');

    // A general unattended routine cannot fetch raw Slack through MCP or
    // continue a prior interactive result around the bounded monitor.
    const fs = require('node:fs'), vm = require('node:vm'), handlers = new Map(); let mcpCalls = 0;
    const context = { window: { electronMCP: { callTool: async () => { mcpCalls++; return {}; }, continueOutput: async () => { mcpCalls++; return {}; } } },
        AgentTools: { register: (def, handler) => { handlers.set(def.function.name, handler); return { ok: true }; } }, console };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(require.resolve('../js/agent/mcp-tools.js'), 'utf8'), context);
    context.window.MCPTools._registerServer({ name: 'team', url: 'https://mcp.slack.com/mcp', tools: [{ name: 'read_thread', inputSchema: {} }] });
    assert.equal((await handlers.get('mcp_team_read_thread')({}, { ambient: true })).blocked, true);
    assert.equal((await handlers.get('mcp_team_continue_output')({}, { ambient: true })).blocked, true);
    assert.equal((await handlers.get('mcp_team_read_thread')({}, { unattended: true })).blocked, true);
    assert.equal(mcpCalls, 0);
    await handlers.get('mcp_team_read_thread')({}, {}); assert.equal(mcpCalls, 1);
    console.log('Slack workflow: real worker/client, provider bodies, restart, cancellation, atomic tasks, reverse filing and quiet reviews passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
