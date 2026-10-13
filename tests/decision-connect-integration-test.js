'use strict';
// Real desktop host -> HTTP -> Connect auth/reservation/receipt -> host reuse.
// Only the inference adapter is a synthetic fixture. No real data or secrets.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const C = require('../js/shared/decision-contract');
const choiceAnswers = require('./fixtures/decision-answers');
const { createDecisionClient } = require('../js/main/decision-client');
const connect = path.resolve(process.argv[2] || path.resolve(__dirname, '../../anjadhe-connect'));
if (!fs.existsSync(path.join(connect, 'lib/decisions.js'))) {
    console.error('Connect checkout with decision support is required for this integration test.'); process.exit(1);
}
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
Object.assign(process.env, { DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'nenva-decision-wire-')),
    NODE_ENV: 'test', SEARCH_MOCK: '1', LLM_MOCK: '1', DECISION_MOCK: '1', DECISION_MODE: 'active',
    ADMIN_TOKEN: 'synthetic-admin-only', LICENSE_SIGNING_KEY: '',
    LLM_TIER_QUOTAS: '{"free":{"requests":100,"tokens":1000000}}', LLM_BUDGET_TOKENS: '2000000' });
const canary = 'private-decision-wire-canary';
const consoleLines = [];
const originals = {};
for (const method of ['log','warn','error','info','debug']) {
    originals[method] = console[method]; console[method] = (...values) => consoleLines.push(values.map(String).join(' '));
}
const adapter = require(path.join(connect, 'lib/decisions'));
const realEvaluate = adapter.evaluate, realCapability = adapter.capability;
const llm = require(path.join(connect, 'lib/llm'));
const originalChat = llm.chat, originalCatalog = llm.catalog, originalAvailable = llm.available;
let probability = 1, hold = null, off = false, evaluations = 0;
adapter.capability = opts => off ? { schemaVersion: C.VERSION, mode: 'off' } : realCapability(opts);
adapter.evaluate = async () => {
    evaluations++;
    if (hold) await hold;
    return { answers: choiceAnswers(probability),
        usage: { tokensIn: 100, tokensOut: 0, costMicros: 5, estimated: false } };
};
const app = require(path.join(connect, 'server'));
const db = require(path.join(connect, 'lib/db'));
const params = { engine: 'anjadhe', model: 'nenva-cloud-lite', jobClass: 'background', useCase: C.USE_CASE,
    state: C.stateFor({ text: canary + ': Harbor insurance renewal.' },
        { name: 'Harbor insurance', allGood: 'Covered.', from: [{ name: 'Harbor', key: 'harbor.example' }], holds: [] }) };
function memoryStore() {
    const data = {};
    return { data, get: (key, fallback) => structuredClone(data[key] ?? fallback), set: (key, value) => { data[key] = structuredClone(value); } };
}
async function main() {
    const server = app.listen(0, '127.0.0.1');
    try {
        await new Promise((resolve,reject) => { server.once('listening',resolve); server.once('error',reject); });
        const baseUrl = 'http://127.0.0.1:' + server.address().port;
        const mint = await fetch(baseUrl+'/v1/keys', { method: 'POST', headers: { 'Content-Type':'application/json' },
            body: JSON.stringify({ installId: 'synthetic-decision-wire-install' }) });
        const key = (await mint.json()).apiKey;
        const owner = db.hashInstallId('synthetic-decision-wire-install');
        const make = (store = memoryStore(), fetcher = fetch, getKey = async () => key) => ({ store,
            args: { baseUrl, store, resolveKey: getKey, acquire: async () => () => {}, fetch: fetcher } });
        const first = make();
        const host = createDecisionClient(first.args);
        const accepted = await host.evaluate(params);
        assert.equal(accepted.status, 'scored'); assert.equal(C.interpret(accepted.answers, accepted.policy), true);
        assert.equal(evaluations, 1); assert.equal(db.llmUsed(owner).requests, 1);
        const restart = createDecisionClient(first.args);
        assert.equal((await restart.evaluate(params)).cached, true);
        assert.equal(evaluations, 1);
        probability = 0;
        const rejected = await restart.evaluate({ ...params, model: 'nenva-cloud-pro' });
        assert.equal(C.interpret(rejected.answers, rejected.policy), false);
        assert.equal(db.llmUsed(owner).requests, 2, 'pro and lite share the same accounting owner');

        // A caller that arrives after the server reserved tokens still shares
        // the live result. Only its initiating caller carries the audit.
        let release; hold = new Promise(resolve => { release = resolve; }); probability = 1;
        const overlapping = make(); const simultaneous = createDecisionClient(overlapping.args);
        const before = evaluations;
        const a = simultaneous.evaluate(params);
        while (evaluations === before) await new Promise(resolve => setTimeout(resolve, 1));
        const b = simultaneous.evaluate(params);
        release(); const [ra, rb] = await Promise.all([a,b]); hold = null;
        assert.equal(ra.status, 'scored'); assert.equal(rb.status, 'scored');
        assert.equal(rb.joined, true); assert.equal(rb.audit, undefined);
        assert.equal(evaluations, before+1);

        // Lose the response after Connect committed its score. Restart must
        // preserve uncertainty; status contains accounting, never the answer.
        const lost = make(memoryStore(), async (url, options) => {
            const res = await fetch(url, options);
            if (url.endsWith('/v1/decisions')) { await res.text(); throw new Error('response_lost'); }
            return res;
        });
        const lostResult = await createDecisionClient(lost.args).evaluate(params);
        assert.equal(lostResult.status, 'unknown');
        const countAfterLoss = evaluations;
        const restarted = await createDecisionClient(lost.args).evaluate(params);
        assert.equal(restarted.code, 'outcome_unknown'); assert.equal(evaluations, countAfterLoss);
        const statusResponse = await fetch(baseUrl+'/v1/decisions/status', { method:'POST',
            headers: { Authorization:'Bearer '+key, 'Content-Type':'application/json' },
            body: JSON.stringify({ requestId:lostResult.requestId }) });
        const status = await statusResponse.json();
        assert.equal(status.status, 'scored'); assert.equal(status.usage.tokensIn, 100);
        assert.equal('answers' in status, false);

        // Before-dispatch auth rejection can be repaired without classifying
        // it as an uncertain paid request or retrying it in the same call.
        let credential = 'anck_'+'0'.repeat(48);
        const auth = make(memoryStore(), fetch, async () => credential);
        const denied = await createDecisionClient(auth.args).evaluate(params);
        assert.equal(denied.status, 'not_dispatched'); assert.equal(denied.code, 'auth');
        assert.equal(evaluations, countAfterLoss); assert.deepEqual(auth.store.data.decisionDispatches, {});
        credential = key;
        assert.equal((await createDecisionClient(auth.args).evaluate(params)).status, 'scored');

        // Exercise qualification over the real HTTP routes too, preserving
        // the requested tier and counting BOTH halves of the comparison.
        const E = require('../scripts/evaluate-decisions');
        const examples = require('./fixtures/decision-sender-membership');
        const cases = [examples.find(c => c.expected === true), examples.find(c => c.expected === false), examples.find(c => c.expected === null)];
        adapter.evaluate = async request => {
            evaluations++;
            const example = cases.find(c => c.state.item.text === request.state.item.text);
            assert.ok(example);
            return { answers: choiceAnswers(example.expected === null ? 0.5 : Number(example.expected)),
                usage: { tokensIn: 100, tokensOut: 0, costMicros: 5, estimated: false } };
        };
        llm.available = () => [...C.CLOUD_MODELS];
        llm.catalog = () => C.CLOUD_MODELS.map(id => ({ id, label: id }));
        llm.chat = async (model, body) => {
            assert.equal(model, 'nenva-cloud-pro');
            const example = cases.find(c => body.messages[1].content.includes(c.state.item.text));
            assert.ok(example);
            const usage = { prompt_tokens: 200, completion_tokens: 8 };
            return { json: { choices: [{ message: { content: JSON.stringify({ same: example.expected === true }) } }], usage }, usage };
        };
        const usedBeforeEval = db.llmUsed(owner).requests;
        const report = await E.evaluate({ base: baseUrl, key, cloudModel: 'nenva-cloud-pro', compareCurrent: true, cases,
            reportFile: path.join(process.env.DATA_DIR, 'evaluation.json') });
        assert.equal(report.qualification, 'unqualified');
        assert.equal(report.summary.decision.thresholds[0].passesSyntheticScreening, true);
        assert.equal(report.summary.baseline.costMicros, null);
        assert.equal(db.llmUsed(owner).requests, usedBeforeEval + cases.length * 2);

        // The second question over the same wire: Matters' narrow look.
        const MATTER = 'matter-membership';
        const matterParams = { ...params, useCase: MATTER, state: C.USE_CASES[MATTER].stateFor(
            { title: 'Dental cleaning', kind: 'appointment', when: '2026-10-08', from: 'Okonkwo Dental', latest: canary },
            { title: 'Reminder', kind: 'appointment', when: '2026-10-08', from: 'portal.example' }, 'both on 2026-10-08') };
        adapter.evaluate = async request => {
            evaluations++;
            return { answers: { [C.USE_CASES[request.useCase].question]: choiceAnswers(1).same_sender },
                usage: { tokensIn: 100, tokensOut: 0, costMicros: 5, estimated: false }, model: 'mock-decision' };
        };
        const matterHost = createDecisionClient(make().args);
        const matterScored = await matterHost.evaluate(matterParams);
        assert.equal(matterScored.status, 'scored'); assert.equal(C.interpret(matterScored.answers, matterScored.policy, MATTER), true);
        assert.equal((await matterHost.evaluate(matterParams)).cached, true);
        // Connect's terminal word after dispatch (the provider's answer unusable) is terminal
        // on the device too: recorded, reported again without a request, and /status agrees.
        adapter.evaluate = async () => { evaluations++; return { error: 'invalid_response', usage: null }; };
        const terminalStore = memoryStore();
        const terminal = await createDecisionClient(make(terminalStore).args).evaluate(params);
        assert.equal(terminal.status, 'invalid'); assert.equal(terminal.code, 'invalid_response');
        const terminalCount = evaluations;
        const terminalAgain = await createDecisionClient(make(terminalStore).args).evaluate(params);
        assert.equal(terminalAgain.status, 'invalid'); assert.equal(terminalAgain.cached, true);
        assert.equal(evaluations, terminalCount, 'a terminal outcome is never re-dispatched');
        assert.equal(db.decisionGet(owner, terminal.requestId).status, 'invalid');
        assert.equal(db.decisionGet(owner, terminal.requestId).estimated, 1, 'no usage from the provider stays estimated');
        // A lost answer settles from Connect's accounting on the next look, ids only.
        adapter.evaluate = async () => { evaluations++; return { answers: choiceAnswers(1),
            usage: { tokensIn: 100, tokensOut: 0, costMicros: 5, estimated: false }, model: 'mock-decision' }; };
        const lostAgain = make(memoryStore(), async (url, options) => {
            const res = await fetch(url, options);
            if (url.endsWith('/v1/decisions')) { await res.text(); throw new Error('response_lost'); }
            return res;
        });
        assert.equal((await createDecisionClient({ ...lostAgain.args, settleAfterMs: 0 }).evaluate(params)).status, 'unknown');
        const settledCount = evaluations;
        const settled = await createDecisionClient({ ...lostAgain.args, fetch, settleAfterMs: 0 }).evaluate(params);
        assert.equal(settled.status, 'invalid'); assert.equal(settled.code, 'answer_lost');
        assert.equal(evaluations, settledCount, 'settling a lost answer buys nothing');
        assert.deepEqual(await createDecisionClient({ ...lostAgain.args, fetch, settleAfterMs: 0 }).reconcile(), { open: 0, settled: 0, dropped: 0 });

        off = true;
        assert.equal((await createDecisionClient(make().args).evaluate(params)).handled, false);
        const legacy = make(memoryStore(), (url, options) => url.endsWith('/capabilities')
            ? Promise.resolve(new Response('{"error":"Not found"}', { status:404 })) : fetch(url, options));
        assert.equal((await createDecisionClient(legacy.args).evaluate(params)).handled, false);
        const calls = evaluations;
        for (const engine of ['llamacpp','server','openai','anthropic']) {
            assert.equal((await createDecisionClient(make().args).evaluate({ ...params, engine })).handled, false);
        }
        assert.equal(evaluations, calls);
        db.checkpoint();
        for (const file of fs.readdirSync(process.env.DATA_DIR)) {
            if (file.startsWith('connect.db')) assert.equal(fs.readFileSync(path.join(process.env.DATA_DIR,file)).includes(Buffer.from(canary)), false);
        }
        assert.equal(consoleLines.some(line => line.includes(canary)), false);
    } finally {
        adapter.evaluate = realEvaluate; adapter.capability = realCapability;
        llm.chat = originalChat; llm.catalog = originalCatalog; llm.available = originalAvailable;
        if (server.listening) await new Promise(resolve => server.close(resolve));
        for (const method of Object.keys(originals)) console[method] = originals[method];
    }
    console.log('Decision HTTP integration: lite/pro, overlap, replay, loss, auth repair, paired qualification, old services and privacy passed');
}
main().catch(error => { for (const method of Object.keys(originals)) console[method] = originals[method]; console.error(error); process.exitCode=1; });
