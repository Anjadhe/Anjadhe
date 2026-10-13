'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const C = require('../js/shared/decision-contract');
const choiceAnswers = require('./fixtures/decision-answers');
const { createDecisionClient } = require('../js/main/decision-client');
const state = C.stateFor({ text: 'An existing policy renews next month.' },
    { name: 'Harbor insurance', allGood: 'Covered.', from: [{ name: 'Harbor', key: 'harbor.example' }], holds: ['Existing policy'] }, 'Different address.');
const cap = { schemaVersion: C.VERSION, questionVersion: C.VERSION, useCase: C.USE_CASE, mode: 'active',
    definition: JSON.stringify(C.QUESTIONS), cloudModels: [...C.CLOUD_MODELS], backendRevision: 'synthetic-v1',
    policy: { acceptAt: 0.99, differentAt: 0.99, qualification: 'test-only' } };
const params = { engine: 'anjadhe', model: 'nenva-cloud-lite', jobClass: 'background', useCase: C.USE_CASE, state };
const MATTER = 'matter-membership';
const matterState = C.USE_CASES[MATTER].stateFor(
    { id: 'm1', title: 'Dental cleaning', kind: 'appointment', when: '2026-10-20', time: '10:00', status: 'open', from: 'Ridge Dental', latest: 'See you on the 20th at 10.' },
    { title: 'Appointment reminder', kind: 'appointment', when: '2026-10-20', time: '10:00', from: 'reminders@portal.example', latest: 'Your visit is tomorrow at 10:00.' },
    'both are on 2026-10-20');
const matterCap = { ...cap, useCases: { [MATTER]: { mode: 'active', definition: C.definitionOf(MATTER), policy: { ...cap.policy, qualification: 'matter-test' } } } };
const matterParams = { ...params, useCase: MATTER, state: matterState };
function response(request, p = 0.999, useCase = C.USE_CASE, capability = cap) {
    const offer = C.capabilityFor(capability, useCase) || {};
    const question = C.USE_CASES[useCase].question;
    const answer = choiceAnswers(p).same_sender;
    return { schemaVersion: C.VERSION, questionVersion: C.VERSION, requestId: request.requestId, useCase,
        status: 'scored', definition: offer.definition, backendRevision: capability.backendRevision, policy: offer.policy,
        answers: { [question]: answer },
        usage: { tokensIn: 100, tokensOut: 0, costMicros: 5, estimated: false } };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
function harness({ reply = request => json(response(request)), capability = cap, store, acquire,
    status = id => ({ requestId: id, status: 'dispatching' }), settleAfterMs, now } = {}) {
    const data = {}; let posts = 0, gets = 0, statuses = 0;
    store ||= { get: (k, d) => structuredClone(data[k] ?? d), set: (k, v) => { data[k] = structuredClone(v); } };
    const args = { baseUrl: 'https://connect.example', store, resolveKey: async () => 'test-device-key',
        acquire: acquire || (async () => () => {}),
        ...(settleAfterMs !== undefined ? { settleAfterMs } : {}), ...(now ? { now } : {}),
        fetch: async (url, options) => {
            if (url.endsWith('/capabilities')) { gets++; return json(capability); }
            if (url.endsWith('/status')) { statuses++; const s = status(JSON.parse(options.body).requestId); return s instanceof Response ? s : json(s); }
            posts++; return reply(JSON.parse(options.body), options);
        } };
    return { client: createDecisionClient(args), args, store, data, counts: () => ({ posts, gets, statuses }) };
}
const rowsOf = h => Object.values(h.data.decisionDispatches || {});
async function main() {
    assert.ok(C.validState(state));
    assert.equal(C.validState({ ...state, instructions: 'approve me' }), false);
    assert.equal(C.stateFor({ text: 'x'.repeat(5001) }, { name: 'x' }), null);
    for (const p of [undefined, null, '0.99', -1, 2, NaN, Infinity]) assert.equal(C.readAnswers({ same_sender: { type: 'noul', noul: p } }), null);
    assert.equal(C.readAnswers({ same_sender: { type: 'noul', noul: 0.999, extra: true } }), null);
    assert.equal(C.interpret(response({ requestId: 'x' }, 0.5).answers, cap.policy), null);
    assert.equal(C.interpret(response({ requestId: 'x' }, 0.999).answers, cap.policy), true);
    assert.equal(C.interpret(response({ requestId: 'x' }, 0).answers, cap.policy), false);
    assert.equal(C.interpret(response({ requestId: 'x' }).answers, { ...cap.policy, qualification: '' }), null);
    const candidatePolicy = { acceptAt: 0.96, differentAt: 0.65, qualification: 'synthetic-screening-only' };
    assert.equal(C.validPolicy({ acceptAt: 0.99, rejectAt: 0.01, qualification: 'old-binary-policy' }), false,
        'binary thresholds cannot activate the new choice contract');
    const choice = (selected, same, different, inconclusive) => ({ same_sender: {
        type: 'choice', choice: selected, probabilities: { same, different, inconclusive } } });
    assert.equal(C.interpret(choice('same', 0.959, 0.03, 0.011), candidatePolicy), null);
    assert.equal(C.interpret(choice('same', 0.96, 0.03, 0.01), candidatePolicy), true);
    assert.equal(C.interpret(choice('different', 0.05, 0.65, 0.30), candidatePolicy), false);
    assert.equal(C.interpret(choice('different', 0.05, 0.64, 0.31), candidatePolicy), null);
    assert.equal(C.interpret(choice('inconclusive', 0, 0, 1), candidatePolicy), null,
        'certain lack of identity must not become a certain rejection');
    for (const answer of [choice('same', 1.1, 0, 0), choice('same', '1', 0, 0),
        choice('same', 0.1, 0.9, 0), choice('same', 0.9, 0.3, 0), choice('unknown', 1, 0, 0),
        { same_sender: { ...choiceAnswers(1).same_sender, probabilities: { same: 1 } } },
        { same_sender: { ...choiceAnswers(1).same_sender, probabilities: { same: 1, different: 0, inconclusive: 0, extra: 0 } } }]) {
        assert.equal(C.readAnswers(answer), null);
    }
    const withConfidence = choiceAnswers(0.97); withConfidence.same_sender.confidence = 0.01;
    assert.equal(C.interpret(withConfidence, candidatePolicy), true, 'policy uses option probability, not the distinct confidence statistic');
    assert.equal('confidence' in C.readAnswers(withConfidence).same_sender, false);

    // The registry: a second question with its own state, read through the same policy.
    assert.ok(matterState && C.validState(matterState, MATTER));
    assert.equal(C.validState(matterState), false, 'a state is valid for its own question only');
    assert.equal(C.validState(state, MATTER), false);
    assert.equal(C.USE_CASES[MATTER].stateFor({ title: 'x'.repeat(201) }, { title: 'y' }), null);
    assert.equal(C.USE_CASES[MATTER].stateFor({ title: 'a' }, { title: 'b' }).a.when, '', 'missing facts are empty strings, never dropped keys');
    assert.equal(C.readAnswers(choiceAnswers(1), MATTER), null, 'an answer keyed by another question is refused');
    assert.equal(C.interpret({ same_thing: choiceAnswers(1).same_sender }, cap.policy, MATTER), true);
    assert.equal(C.interpret({ same_thing: choiceAnswers(0.5).same_sender }, cap.policy, MATTER), null);
    assert.ok(C.validRequest({ schemaVersion: C.VERSION, questionVersion: C.VERSION, requestId: '550e8400-e29b-41d4-a716-446655440000',
        cloudModel: 'nenva-cloud-pro', useCase: MATTER, workClass: 'background', state: matterState }));
    assert.equal(C.validRequest({ schemaVersion: C.VERSION, questionVersion: C.VERSION, requestId: '550e8400-e29b-41d4-a716-446655440000',
        cloudModel: 'nenva-cloud-pro', useCase: 'thread-placement', workClass: 'background', state: matterState }), false, 'an unregistered question');
    assert.ok(C.validCapability(matterCap));
    assert.deepEqual(C.capabilityFor(matterCap, MATTER), { mode: 'active', definition: C.definitionOf(MATTER),
        policy: matterCap.useCases[MATTER].policy, backendRevision: 'synthetic-v1' });
    assert.equal(C.capabilityFor(cap, MATTER), null, 'a v2 service without the question offers nothing for it');
    assert.equal(C.capabilityFor({ ...cap, useCases: { [MATTER]: { mode: 'off' } } }, MATTER), null);
    assert.equal(C.validCapability({ ...cap, useCases: { 'thread-placement': { mode: 'active', definition: '{}', policy: cap.policy } } }), false);
    assert.equal(C.validCapability({ ...cap, useCases: { [C.USE_CASE]: { mode: 'active', definition: cap.definition, policy: cap.policy } } }), false,
        'the first question is advertised at the top level only');
    assert.equal(C.validCapability({ ...cap, useCases: { [MATTER]: { mode: 'active', definition: cap.definition, policy: cap.policy } } }), false,
        'a question advertised with another question\'s definition');
    assert.equal(C.activeFor(matterCap, MATTER), true);
    assert.equal(C.activeFor({ ...matterCap, useCases: { [MATTER]: { mode: 'evaluate', definition: C.definitionOf(MATTER) } } }, MATTER), false);
    // The same source executes without Node globals in JavaScriptCore's shape.
    const context = vm.createContext({});
    vm.runInContext(fs.readFileSync(require.resolve('../js/shared/decision-contract'), 'utf8'), context);
    assert.equal(vm.runInContext('DecisionContract.validState(' + JSON.stringify(state) + ')', context), true);
    assert.equal(vm.runInContext(`DecisionContract.validState(${JSON.stringify(matterState)}, ${JSON.stringify(MATTER)})`, context), true);

    const h = harness();
    for (const engine of ['llamacpp', 'server', 'openai', 'anthropic']) assert.equal((await h.client.evaluate({ ...params, engine })).handled, false);
    assert.deepEqual(h.counts(), { gets: 0, posts: 0, statuses: 0 });
    const [a, b] = await Promise.all([h.client.evaluate(params), h.client.evaluate(params)]);
    assert.equal(a.status, 'scored'); assert.equal(b.requestId, a.requestId);
    assert.equal(h.counts().posts, 1, 'parallel calls reuse one dispatch');
    assert.ok(a.audit.request && C.validRequest(a.audit.request));
    const cached = await createDecisionClient(h.args).evaluate(params);
    assert.equal(cached.cached, true); assert.equal(h.counts().posts, 1, 'relaunch reuses the result');
    const pro = await h.client.evaluate({ ...params, model: 'nenva-cloud-pro' });
    assert.equal(pro.status, 'scored'); assert.equal(h.counts().posts, 2);
    const off = harness({ capability: { schemaVersion: C.VERSION, mode: 'off' } });
    assert.equal((await off.client.evaluate(params)).handled, false); assert.equal(off.counts().posts, 0);
    const oldService = harness({ capability: { ...cap, schemaVersion: 1, questionVersion: 1 } });
    assert.equal((await oldService.client.evaluate(params)).handled, false);
    assert.equal(oldService.counts().posts, 0, 'a v1 service retains the generative path before dispatch');
    const evaluateCap = { ...cap, mode: 'evaluate' }; delete evaluateCap.policy;
    assert.equal(C.validCapability(evaluateCap), true);
    assert.equal(C.activeCapability(evaluateCap), false);
    assert.equal(C.validScoredResponse(response({ requestId: 'evaluation' }, 0.999, C.USE_CASE, evaluateCap), { requestId: 'evaluation' }, evaluateCap), true);
    assert.equal(C.validResponse(response({ requestId: 'evaluation' }, 0.999, C.USE_CASE, evaluateCap), { requestId: 'evaluation' }, evaluateCap), false);
    const evaluationOnly = harness({ capability: evaluateCap });
    assert.equal((await evaluationOnly.client.evaluate(params)).handled, false);
    assert.equal(evaluationOnly.counts().posts, 0, 'qualification mode must not affect normal desktop judgments');
    const unqualified = harness({ capability: { ...cap, policy: {} } });
    assert.equal((await unqualified.client.evaluate(params)).handled, false);
    const bad = harness({ reply: request => json({ ...response(request), answers: {} }) });
    assert.equal((await bad.client.evaluate(params)).status, 'unknown');
    await createDecisionClient(bad.args).evaluate(params);
    assert.equal(bad.counts().posts, 1, 'invalid answers never initiate a retry');
    const lost = harness({ reply: () => { throw new Error('network with private content'); } });
    assert.equal((await lost.client.evaluate(params)).status, 'unknown');
    const restarted = createDecisionClient({ ...lost.args, fetch: () => { throw new Error('must not contact any endpoint'); } });
    assert.equal((await restarted.evaluate(params)).code, 'outcome_unknown');
    assert.equal(lost.counts().posts, 1, 'unknown receipt survives restart and capability changes');
    // Upgrading from the binary v1 question cannot forget earlier uncertain
    // paid work, even though v2 uses a new semantic digest and answer type.
    const legacy = harness();
    const crypto = require('node:crypto');
    const secret = 'c'.repeat(64);
    legacy.data.decisionDigestKey = secret;
    const semanticV1 = { cloudModel: params.model, workClass: 'background', useCase: C.USE_CASE,
        schemaVersion: 1, questionVersion: 1, state };
    const semanticV1Key = crypto.createHmac('sha256', secret).update(JSON.stringify(C.canonical(semanticV1))).digest('hex');
    legacy.data.decisionDispatches = { ['d'.repeat(64)]: { semanticKey: semanticV1Key,
        requestId: crypto.randomUUID(), status: 'unknown', at: 1 } };
    assert.equal((await legacy.client.evaluate(params)).code, 'outcome_unknown');
    assert.deepEqual(legacy.counts(), { gets: 0, posts: 0, statuses: 1 },
        'v1 uncertainty is asked about by id only, and still blocks v2 before discovery or dispatch');
    assert.equal((await legacy.client.evaluate(params)).code, 'outcome_unknown');
    assert.equal(legacy.counts().statuses, 1, 'one receipt is asked about once per recheck window');
    const rejected = harness({ reply: () => json({ status: 'not_dispatched', code: 'quota' }, 429) });
    assert.equal((await rejected.client.evaluate(params)).handled, true);
    assert.equal(Object.keys(rejected.data.decisionDispatches).length, 0);
    assert.equal(rejected.counts().posts, 1, 'known rejection is not retried in the same call');
    const contradictory = harness({ reply: () => json({ status: 'not_dispatched', code: 'quota' }, 500) });
    assert.equal((await contradictory.client.evaluate(params)).status, 'unknown');
    await createDecisionClient(contradictory.args).evaluate(params);
    assert.equal(contradictory.counts().posts, 1, 'an unrecognized rejection preserves the uncertain intent');
    const failedSave = harness({ store: { get: (k, d) => k === 'decisionDigestKey' ? 'a'.repeat(64) : d,
        set: () => { throw new Error('disk full'); } } });
    assert.equal((await failedSave.client.evaluate(params)).code, 'storage_unavailable');
    assert.equal(failedSave.counts().posts, 0, 'intent must be durable before sending');
    const tampered = harness({ reply: request => json({ ...response(request), requestId: 'wrong' }) });
    assert.equal((await tampered.client.evaluate(params)).status, 'unknown');

    // Connect's own word that a dispatched request ended with no usable answer
    // is terminal: recorded, reported, never dispatched again for this state,
    // and the caller may run the look it stood in for.
    for (const [connectStatus, code] of [['invalid', 'invalid_response'], ['unknown', 'provider_failed']]) {
        const terminal = harness({ reply: request => json({ status: connectStatus, requestId: request.requestId, code: 'x' }, 502) });
        const first = await terminal.client.evaluate(params);
        assert.equal(first.status, 'invalid'); assert.equal(first.code, code); assert.ok(first.audit, 'the dispatch is on the ledger');
        const again = await createDecisionClient(terminal.args).evaluate(params);
        assert.equal(again.status, 'invalid'); assert.equal(again.cached, true);
        assert.equal(terminal.counts().posts, 1, 'a terminal outcome is never re-dispatched');
        const otherBackend = createDecisionClient({ ...terminal.args, fetch: async (url, options) => url.endsWith('/capabilities')
            ? json({ ...cap, backendRevision: 'synthetic-v2' }) : terminal.args.fetch(url, options) });
        assert.equal((await otherBackend.evaluate(params)).status, 'invalid');
        assert.equal(terminal.counts().posts, 1, 'a new backend does not reopen a terminal state for the same item');
        assert.equal(rowsOf(terminal)[0].status, 'invalid');
    }
    const misaddressed = harness({ reply: () => json({ status: 'invalid', requestId: 'someone-else', code: 'invalid_response' }, 502) });
    assert.equal((await misaddressed.client.evaluate(params)).status, 'unknown', 'a terminal word about another request settles nothing');

    // A lost answer settles from Connect's accounting (ids only) once the
    // receipt is old enough: finished there is terminal here, never reserved
    // there frees a fresh attempt, still in flight or unreachable stays open.
    const settleCase = async (status, expect) => {
        const h2 = harness({ reply: () => { throw new Error('lost'); }, settleAfterMs: 0, status });
        assert.equal((await h2.client.evaluate(params)).status, 'unknown');
        let dispatches = 0;   // the relaunched client's own attempts (the first harness only ever lost)
        const after = await createDecisionClient({ ...h2.args, fetch: async (url, options) => url.endsWith('/v1/decisions')
            ? (dispatches++, json(response(JSON.parse(options.body)))) : h2.args.fetch(url, options) }).evaluate(params);
        expect(after, h2, dispatches);
    };
    await settleCase(id => ({ requestId: id, status: 'scored' }), (r, h2, dispatches) => {
        assert.equal(r.status, 'invalid'); assert.equal(r.code, 'answer_lost');
        assert.equal(dispatches, 0, 'a scored request whose answer was lost is not bought twice');
    });
    await settleCase(id => ({ requestId: id, status: 'invalid' }), (r, h2, dispatches) => { assert.equal(r.code, 'invalid_response'); assert.equal(dispatches, 0); });
    await settleCase(id => ({ requestId: id, status: 'not_found' }), (r, h2, dispatches) => {
        assert.equal(r.status, 'scored'); assert.equal(dispatches, 1, 'never reserved: a fresh attempt may go');
        assert.equal(rowsOf(h2).length, 1);
    });
    await settleCase(id => ({ requestId: id, status: 'dispatching' }), (r, h2, dispatches) => {
        assert.equal(r.code, 'outcome_unknown'); assert.equal(dispatches, 0);
    });
    await settleCase(() => new Response('{"status":"not_dispatched","code":"auth"}', { status: 401 }), (r, h2, dispatches) => { assert.equal(r.code, 'outcome_unknown'); assert.equal(dispatches, 0); });
    await settleCase(() => { throw new Error('offline'); }, (r, h2, dispatches) => { assert.equal(r.code, 'outcome_unknown'); assert.equal(h2.counts().statuses, 1); assert.equal(dispatches, 0); });
    const fresh = harness({ reply: () => { throw new Error('lost'); }, settleAfterMs: 60000, status: id => ({ requestId: id, status: 'scored' }) });
    await fresh.client.evaluate(params);
    assert.equal((await createDecisionClient(fresh.args).evaluate(params)).code, 'outcome_unknown');
    assert.equal(fresh.counts().statuses, 0, 'a receipt that may still be in flight is never asked about');
    const sweep = harness({ reply: () => { throw new Error('lost'); }, settleAfterMs: 0, status: id => ({ requestId: id, status: 'scored' }) });
    await sweep.client.evaluate(params); await sweep.client.evaluate({ ...params, model: 'nenva-cloud-pro' });
    assert.deepEqual(await sweep.client.reconcile(), { open: 0, settled: 2, dropped: 0 });
    assert.deepEqual(await sweep.client.reconcile(), { open: 0, settled: 0, dropped: 0 });
    assert.equal(sweep.counts().statuses, 2);
    assert.equal((await sweep.client.evaluate(params)).code, 'answer_lost');
    assert.equal(sweep.counts().posts, 2);

    // Outside the rollout: told before dispatch, the generative path keeps,
    // and the service is not asked again for a while.
    const outside = harness({ reply: () => json({ status: 'not_dispatched', code: 'unsupported' }, 503) });
    assert.equal((await outside.client.evaluate(params)).status, 'not_dispatched');
    assert.equal((await outside.client.evaluate(params)).handled, false);
    assert.deepEqual(outside.counts(), { gets: 1, posts: 1, statuses: 0 });

    // The second question goes the same way, only where the service offers it.
    const matter = harness({ capability: matterCap, reply: request => json(response(request, 0.999, request.useCase, matterCap)) });
    const m = await matter.client.evaluate(matterParams);
    assert.equal(m.status, 'scored'); assert.equal(C.interpret(m.answers, m.policy, MATTER), true);
    assert.equal(m.audit.request.useCase, MATTER); assert.ok(C.validRequest(m.audit.request));
    assert.equal((await createDecisionClient(matter.args).evaluate(matterParams)).cached, true);
    assert.equal((await matter.client.evaluate(params)).status, 'scored', 'both questions on one service');
    assert.equal(matter.counts().posts, 2);
    const senderOnly = harness();
    assert.equal((await senderOnly.client.evaluate(matterParams)).handled, false);
    assert.equal(senderOnly.counts().posts, 0, 'a service without the question keeps the generative look before dispatch');
    const wrongQuestion = harness({ capability: matterCap, reply: request => json(response(request, 0.999, C.USE_CASE, matterCap)) });
    assert.equal((await wrongQuestion.client.evaluate(matterParams)).status, 'unknown', 'an answer to another question is no answer');
    assert.equal((await harness().client.evaluate({ ...params, useCase: 'thread-placement' })).handled, false);
    assert.equal((await harness().client.evaluate({ ...params, useCase: MATTER })).handled, false, 'a state must fit its question');

    // A late overlapping caller must wait for the actual result rather than
    // treating the live intent as an interrupted request.
    let finish, started;
    const dispatched = new Promise(resolve => { started = resolve; });
    const overlap = harness({ reply: request => { started(request); return new Promise(resolve => { finish = () => resolve(json(response(request))); }); } });
    const first = overlap.client.evaluate(params);
    await dispatched;
    const second = overlap.client.evaluate(params);
    finish();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.status, 'scored'); assert.equal(secondResult.status, 'scored');
    assert.equal(secondResult.joined, true); assert.equal(secondResult.audit, undefined, 'one dispatch creates one audit');
    assert.equal(overlap.counts().posts, 1);
    // Identity, sent state and cached evidence all use the original snapshot.
    let allowSlot;
    const queued = harness({ acquire: () => new Promise(resolve => { allowSlot = () => resolve(() => {}); }) });
    const mutable = { ...params, state: structuredClone(state) };
    const waiting = queued.client.evaluate(mutable);
    while (!allowSlot) await new Promise(resolve => setImmediate(resolve));
    mutable.state.item.text = 'Changed while the request waited';
    allowSlot();
    const snapshotted = await waiting;
    assert.equal(snapshotted.audit.request.state.item.text, state.item.text);
    const missingKey = harness();
    await missingKey.client.evaluate(params);
    delete missingKey.data.decisionDigestKey;
    assert.equal((await missingKey.client.evaluate(params)).code, 'storage_unavailable');
    assert.equal(missingKey.counts().posts, 1, 'missing receipt secrets cannot trigger redispatch');
    const corrupt = harness(); corrupt.data.decisionDispatches = { broken: { status: 'unknown' } };
    assert.equal((await corrupt.client.evaluate(params)).code, 'storage_unavailable');
    assert.equal(corrupt.counts().posts, 0);
    console.log('decision-model-test: contract, two questions, route eligibility, uncertainty, terminal outcomes, settling, rollout, durable intents and reuse passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
