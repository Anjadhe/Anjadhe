'use strict';
const assert = require('node:assert/strict');
const S = require('../js/core/senders');
const C = require('../js/shared/decision-contract');
const choiceAnswers = require('./fixtures/decision-answers');
const item = { key: 'matter:test', kind: 'matter', text: 'A Google Cloud account notice.', from: { name: 'Google', key: 'google.example' } };
const sender = { id: 'sender:test', name: 'Other vendor account', allGood: 'Current.',
    from: [{ name: 'Other', key: 'other.example' }], holds: [] };
const policy = { acceptAt: 0.99, differentAt: 0.99, qualification: 'test-only' };
global.AgentService = { model: 'nenva-cloud-lite' };
S.get = () => sender;
S._matterOf = () => item;
S.judge = async () => ({ placements: [{ key: item.key, sender: sender.id }] });
let generated = 0;
global.LLMLogger = { call: async () => { generated++; return { message: { content: '{"same":true}' } }; } };
async function main() {
    LLMLogger.decide = async () => ({ handled: false });
    assert.equal(await S.sameSender(item, sender), true);
    assert.equal(generated, 1, 'unsupported capability retains the existing judgment');
    for (const result of [{ handled: true, status: 'unknown' },
        { handled: true, policy, answers: choiceAnswers(0.5) },
        { handled: true, policy, answers: {} }]) {
        LLMLogger.decide = async () => result;
        const placed = await S.place([item], [sender]);
        assert.deepEqual(placed.placements, [], 'uncertainty must not approve a disputed join');
    }
    assert.equal(generated, 1, 'dispatched decisions do not silently fall back to generation');
    LLMLogger.decide = async () => ({ handled: true, policy, answers: choiceAnswers(1) });
    assert.equal((await S.place([item], [sender])).placements.length, 1);
    const original = sender.name;
    LLMLogger.decide = async () => { sender.name = 'Changed while scoring'; return { handled: true, policy, answers: choiceAnswers(1) }; };
    assert.deepEqual((await S.place([item], [sender])).placements, [], 'stale record state is deferred');
    sender.name = original;
    // Invalid is Connect's word that the decision ended with no usable answer
    // and will not be asked again for this state: the look it replaced runs.
    LLMLogger.decide = async () => ({ handled: true, status: 'invalid', code: 'invalid_response' });
    assert.equal((await S.place([item], [sender])).placements.length, 1);
    assert.equal(generated, 2, 'a terminal decision runs the generative look it stood in for, once');
    // The bridge itself failing sent nothing: the generative path keeps (D4).
    LLMLogger.decide = async () => { throw new Error('no bridge'); };
    assert.equal(await S.sameSender(item, sender), true);
    assert.equal(generated, 3);

    // A join the facts do not argue with (same domain) is still checked by the
    // decision, never by a generative call: only a confident "different" sends
    // it back to the judgment with that sender refused.
    const sameDomain = { ...sender, id: 'sender:google', name: 'Google Cloud account', from: [{ name: 'Google', key: 'google.example' }] };
    assert.equal(S.argues(item, sameDomain), '');
    const judged = [];
    S.judge = async (items, shown, now, not = {}) => { judged.push(not); return { placements: [{ key: item.key, ...(not[item.key] ? { new: { name: 'Something else', allGood: '' } } : { sender: sameDomain.id }) }] }; };
    S.get = () => sameDomain;
    const decided = [];
    for (const [result, keeps] of [
        [{ handled: true, policy, answers: choiceAnswers(0) }, false],
        [{ handled: true, policy, answers: { same_sender: { type: 'choice', choice: 'different', probabilities: { same: 0.1, different: 0.6, inconclusive: 0.3 } } } }, true],
        [{ handled: true, policy, answers: choiceAnswers(0.5) }, true],
        [{ handled: true, policy, answers: choiceAnswers(1) }, true],
        [{ handled: true, status: 'unknown' }, true],
        [{ handled: true, status: 'invalid' }, true],
        [{ handled: false }, true]]) {
        LLMLogger.decide = async (_tag, p) => { decided.push(p.state.reason); return result; };
        const before = generated;
        const placed = await S.place([item], [sameDomain]);
        assert.equal(generated, before, 'verifying an unargued join never costs a generative call');
        if (keeps) assert.deepEqual(placed.placements, [{ key: item.key, sender: sameDomain.id }], JSON.stringify(result));
        else { assert.deepEqual(placed.placements, [{ key: item.key, new: { name: 'Something else', allGood: '' } }]); assert.equal(placed.refused, 1); assert.equal(judged.at(-1)[item.key].id, sameDomain.id); }
    }
    assert.ok(decided.every(reason => reason === ''), 'an unargued join carries no reason');
    LLMLogger.decide = async () => ({ handled: true, policy, answers: choiceAnswers(0) });
    const task = { key: 'task:1', kind: 'commitment', text: 'Renew the policy' };
    S.judge = async () => ({ placements: [{ key: task.key, sender: sameDomain.id }] });
    assert.equal((await S.place([task], [sameDomain])).placements.length, 1, 'a to-do of theirs is never second-guessed');
    const noMail = { ...sameDomain, from: [] };
    S.judge = async () => ({ placements: [{ key: item.key, sender: noMail.id }] });
    assert.equal((await S.place([item], [noMail])).placements.length, 1, 'a sender with no mail of its own is never second-guessed');
    // An ACTIVITY (mail from several companies already: Subscriptions, Auto insurance with its
    // quotes) is never second-guessed for "another company": that is its normal state (the demo
    // screening, 2026-10-13: Netflix's receipt was read as different from Subscriptions).
    const activity = { ...sameDomain, from: [{ name: 'Google', key: 'google.example' }, { name: 'Netflix', key: 'netflix.example' }] };
    S.get = () => activity; let verified = 0;
    LLMLogger.decide = async () => { verified++; return { handled: true, policy, answers: choiceAnswers(0) }; };
    S.judge = async () => ({ placements: [{ key: item.key, sender: activity.id }] });
    assert.equal((await S.place([item], [activity])).placements.length, 1, 'an activity sender keeps the judgment\'s placement');
    assert.equal(verified, 0, 'and is not even asked');
    S.get = () => sender;

    // The real logger routes decisions from the original source, preserving
    // user surface assignments and auditing only exact inference dispatches.
    const fs = require('node:fs'), vm = require('node:vm');
    const entries = []; let invocations = 0;
    const sandbox = { performance, console, window: { electronLLM: { decide: async params => {
        invocations++; assert.equal(params.model, 'nenva-cloud-pro'); assert.equal(params.activityTag, 'senders-decision');
        const request = { schemaVersion: C.VERSION, state: params.state, cloudModel: params.model, requestId: 'audit-id' };
        return { handled: true, audit: { request }, answers: choiceAnswers(0.5),
            usage: { tokensIn: 100, tokensOut: 0, costMicros: 5, estimated: false } };
    } } }, AgentService: { surfaceRouting: () => ({ engine: 'server', model: 'chosen-local-server' }) }, ModelRouting: {} };
    vm.createContext(sandbox); vm.runInContext(fs.readFileSync(require.resolve('../js/agent/llm-logger'), 'utf8'), sandbox);
    const logger = vm.runInContext('LLMLogger', sandbox); logger.addEntry = entry => entries.push(entry);
    assert.equal((await logger.decide('senders', { model: 'nenva-cloud-lite', state: C.stateFor(item, sender) })).handled, false);
    assert.equal(invocations, 0, 'a cloud default cannot bypass a server surface assignment');
    sandbox.AgentService.surfaceRouting = () => ({ engine: 'anjadhe', model: 'nenva-cloud-pro' });
    await logger.decide('senders', { model: 'local-default', state: C.stateFor(item, sender) });
    assert.equal(invocations, 1); assert.equal(entries.length, 1);
    assert.equal(entries[0].request.cloudModel, 'nenva-cloud-pro'); assert.equal(entries[0].left, true);
    console.log('sender-decision-test: deferred/stale joins, unchanged fallback, source routing and audit passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
