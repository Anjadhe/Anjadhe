'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const C = require('../js/shared/decision-contract');
const choiceAnswers = require('./fixtures/decision-answers');
const SenderRecords = require('../js/shared/senders-records');
const E = require('../scripts/evaluate-decisions');
const fixtures = require('./fixtures/decision-sender-membership');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nenva-decision-eval-test-'));
const cases = [fixtures.find(c => c.expected === true), fixtures.find(c => c.expected === false), fixtures.find(c => c.expected === null)];
const cap = { schemaVersion: C.VERSION, questionVersion: C.VERSION, useCase: C.USE_CASE, mode: 'evaluate',
    definition: JSON.stringify(C.QUESTIONS), backendRevision: 'synthetic-evaluation-v1', cloudModels: [...C.CLOUD_MODELS] };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const options = file => ({ base: 'http://127.0.0.1:9999', key: 'synthetic-secret-canary', cases, compareCurrent: true,
    cloudModel: 'nenva-cloud-pro', reportFile: path.join(dir, file) });
function provider(opts, tweak = {}) {
    const sent = [];
    let index = 0;
    const fetcher = async (url, init = {}) => {
        if (!init.method) return url.endsWith('/capabilities') ? json(tweak.cap || cap)
            : json({ models: tweak.models || [{ id: opts.cloudModel }] });
        const report = JSON.parse(fs.readFileSync(opts.reportFile, 'utf8'));
        const body = JSON.parse(init.body), endpoint = url.split('/').pop();
        sent.push({ body, endpoint });
        const receipt = report.outcomes.at(-1)[endpoint === 'decisions' ? 'decision' : 'baseline'];
        assert.equal(receipt.status, 'dispatching', 'paid intent must reach disk before POST');
        assert.equal(init.headers.Authorization, 'Bearer synthetic-secret-canary');
        assert.equal(init.redirect, 'error');
        if (tweak.fail === endpoint) throw new Error('Synthetic response lost');
        if (endpoint === 'decisions') {
            const example = cases[index];
            assert.equal(body.cloudModel, opts.cloudModel);
            assert.deepEqual(body.state, example.state);
            return json({ ...cap, status: 'scored', requestId: body.requestId,
                answers: choiceAnswers(example.expected === null ? 0.5 : Number(example.expected)),
                usage: { tokensIn: 100, tokensOut: 0, costMicros: 5, estimated: false }, ...tweak.result });
        }
        assert.equal(body.model, opts.cloudModel);
        assert.equal(body.messages[1].content, SenderRecords.samePrompt(cases[index].state.item, cases[index].state.candidate, cases[index].state.reason));
        assert.equal(body.max_tokens, 40); assert.equal(body.temperature, 0.1);
        assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
        index++;
        return json({ choices: [{ message: { content: JSON.stringify({ same: cases[index - 1].expected === true }) } }],
            usage: { prompt_tokens: 200, completion_tokens: 8 } });
    };
    return { fetcher, sent };
}
async function main() {
    E.validateCases(fixtures);
    E.validateCases(require('./fixtures/decision-sender-holdout'));
    E.validateCases(require('./fixtures/decision-matter-membership'), 'matter-membership');
    // The Threads demo as fixtures (tests/fixtures/decision-threads-demo.js): every
    // message against every sender, and the filer's folder-and-message pairs.
    const demo = require('./fixtures/decision-threads-demo');
    E.validateCases(demo.sender); E.validateCases(demo.matter, 'matter-membership');
    assert.equal(demo.sender.length, 140); assert.equal(demo.sender.filter(c => c.expected === true).length, 27);
    assert.equal(demo.sender.filter(c => c.id === 'demo-x0-inject-vs-auto-insurance')[0].expected, null, 'the look-alike mail is never a confirmed join');
    assert.ok(demo.sender.every(c => !/\{\{/.test(JSON.stringify(c.state))), 'every relative date is filled');
    assert.equal(E.USE_CASES['sender-membership'].demo, demo.sender);
    assert.throws(() => E.validateCases(demo.matter), /Invalid/, 'a set is valid for its own question only');
    const opts = options('complete.json'), p = provider(opts);
    const report = await E.evaluate({ ...opts, fetcher: p.fetcher });
    assert.equal(report.qualification, 'unqualified'); assert.equal(report.completed, true);
    assert.equal(p.sent.length, cases.length * 2);
    assert.equal(report.summary.decision.brier, 0);
    assert.equal(report.summary.decision.thresholds[0].passesSyntheticScreening, true);
    assert.equal(report.summary.baseline.ambiguousResolved, 1, 'forced baseline answers are visible');
    assert.equal(report.summary.baseline.costMicros, null, 'missing baseline pricing is unknown, not free');
    assert.equal(report.summary.decision.costMicros, 15);
    assert.equal(fs.statSync(opts.reportFile).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(opts.reportFile, 'utf8').includes(opts.key), false);
    assert.equal(fs.readFileSync(opts.reportFile, 'utf8').includes(cases[0].state.item.text), false, 'report retains fixture identity, not request content');
    await assert.rejects(E.evaluate({ ...opts, fetcher: p.fetcher }), /already exists/);
    assert.equal(p.sent.length, 6);
    await E.evaluate({ ...opts, fetcher: p.fetcher, resume: true });
    assert.equal(p.sent.length, 6, 'a completed run never dispatches during resume');
    const altered = { ...report, baselineDigest: 'changed-baseline' };
    const alteredFile = path.join(dir, 'altered.json');
    E.saveAtomic(alteredFile, altered);
    await assert.rejects(E.evaluate({ ...opts, reportFile: alteredFile, fetcher: p.fetcher, resume: true }), /Incompatible/);
    assert.equal(p.sent.length, 6, 'a changed baseline cannot be mixed into a resumed comparison');

    for (const endpoint of ['decisions', 'completions']) {
        const lostOpts = options(endpoint + '.json'), lost = provider(lostOpts, { fail: endpoint });
        await assert.rejects(E.evaluate({ ...lostOpts, fetcher: lost.fetcher }), /unresolved/);
        const before = lost.sent.length;
        let reads = 0;
        await assert.rejects(E.evaluate({ ...lostOpts, resume: true, fetcher: async () => { reads++; throw new Error(); } }), /Unresolved/);
        assert.equal(reads, 0); assert.equal(lost.sent.length, before);
        const receipt = JSON.parse(fs.readFileSync(lostOpts.reportFile, 'utf8')).outcomes.at(-1);
        assert.equal(receipt[endpoint === 'decisions' ? 'decision' : 'baseline'].status, 'unknown');
    }
    const beforeOpts = options('write-failure.json'), before = provider(beforeOpts);
    let writes = 0;
    await assert.rejects(E.evaluate({ ...beforeOpts, fetcher: before.fetcher, save: (file, data) => {
        if (++writes === 2) throw new Error('Disk full'); E.saveAtomic(file, data);
    } }), /Disk full/);
    assert.equal(before.sent.length, 0, 'no POST follows failed intent persistence');
    const wrongOpts = options('wrong-response.json'), wrong = provider(wrongOpts, { result: { backendRevision: 'changed' } });
    await assert.rejects(E.evaluate({ ...wrongOpts, fetcher: wrong.fetcher }), /unresolved/);
    assert.equal(wrong.sent.length, 1, 'a mismatched response stops the baseline and remaining fixtures');
    const missingOpts = options('missing-tier.json'), missing = provider(missingOpts, { models: [{ id: 'nenva-cloud-lite' }] });
    await assert.rejects(E.evaluate({ ...missingOpts, fetcher: missing.fetcher }), /unavailable/);
    assert.equal(missing.sent.length, 0, 'baseline discovery never silently changes tier');
    const offOpts = options('off.json'), off = provider(offOpts, { cap: { mode: 'off' } });
    await assert.rejects(E.evaluate({ ...offOpts, fetcher: off.fetcher }), /capability/);
    assert.equal(off.sent.length, 0);

    const u = { tokensIn: 1, tokensOut: 0, costMicros: 1, estimated: false };
    const stats = E.summarize([
        { expected: false, decision: { status: 'scored', choice: 'same', probability: 1, differentProbability: 0, latencyMs: 10, usage: u } },
        { expected: true, decision: { status: 'scored', choice: 'different', probability: 0, differentProbability: 1, latencyMs: 20, usage: u } },
        { expected: null, decision: { status: 'scored', choice: 'same', probability: 1, differentProbability: 0, latencyMs: 30, usage: u } }
    ]);
    assert.equal(stats.decision.brier, 1);
    assert.equal(stats.decision.thresholds[0].falseJoins, 2);
    assert.equal(stats.decision.thresholds[0].wrongRefusals, 1);
    assert.equal(stats.decision.thresholds[0].passesSyntheticScreening, false);
    assert.deepEqual(stats.decision.latencyMs, { p50: 20, p95: 30 });
    assert.equal(E.baselineResult({ choices: [{ message: { content: '```json\n{"same":true}\n```' } }] }).same, true);
    assert.equal(E.baselineResult({ choices: [{ message: { content: '{"same":"true"}' } }] }).same, null);
    console.log('Decision evaluation: paired baseline, thresholds, unknown cost, durable intents and no-retry resume passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
