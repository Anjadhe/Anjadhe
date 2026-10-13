'use strict';
// Matters' narrow look on the typed decision (docs/DECISION_MODELS.md,
// matter-membership): the decision first on a cloud route, the generative
// look otherwise; inconclusive and unknown keep the judgment's answer (null),
// invalid runs the look, a bounded source never asks, a folder that changed
// while the decision ran is not judged by it (D6).
const assert = require('node:assert/strict');
const M = require('../js/core/matters.js');
const C = require('../js/shared/decision-contract');
const choice = (selected, p) => ({ same_thing: { type: 'choice', choice: selected,
    probabilities: selected === 'same' ? { same: p, different: 1 - p, inconclusive: 0 }
        : selected === 'different' ? { same: 1 - p, different: p, inconclusive: 0 } : { same: 0, different: 0, inconclusive: 1 } } });
const policy = { acceptAt: 0.95, differentAt: 0.95, qualification: 'test-only' };
const folder = { id: 'matter:c', title: 'Dental cleaning', kind: 'appointment', when: '2026-10-08', time: '10:30', status: 'open', from: 'Okonkwo Dental', latest: 'See you Thursday at 10:30.', privacySources: ['email'] };
const message = { title: 'Appointment reminder', kind: 'appointment', when: '2026-10-08', time: '16:15', status: 'open', from: 'reminders@portal.example', latest: 'Your visit is at 4:15 pm.', privacySources: ['email'] };
global.AgentService = { model: 'nenva-cloud-lite', numCtx: 8192 };
let generated = 0, generativeAnswer = '{"same": true}';
const decided = [];
global.LLMLogger = { call: async () => { generated++; return { message: { content: generativeAnswer } }; } };
async function main() {
    const state = C.USE_CASES['matter-membership'].stateFor(folder, message, 'both are on 2026-10-08, but the folder is at 10:30 and this message says 16:15');
    assert.ok(state); assert.equal(state.a.title, 'Dental cleaning'); assert.equal('id' in state.a, false, 'ids and privacy never travel');
    // No decision bridge: the generative look, as before.
    assert.equal(await M.sameThing(folder, message, 'email-matter', 'why'), true);
    assert.equal(generated, 1);
    LLMLogger.decide = async (tag, p) => { decided.push({ tag, useCase: p.useCase, reason: p.state.reason }); return { handled: true, policy, answers: choice('same', 0.99) }; };
    assert.equal(await M.sameThing(folder, message, 'email-matter', 'why'), true);
    assert.equal(generated, 1, 'a scored decision replaces the generative look');
    assert.deepEqual(decided.at(-1), { tag: 'email-matter', useCase: 'matter-membership', reason: 'why' });
    LLMLogger.decide = async () => ({ handled: true, policy, answers: choice('different', 0.99) });
    assert.equal(await M.sameThing(folder, message, 'imessage-matter'), false);
    for (const result of [{ handled: true, status: 'unknown', code: 'outcome_unknown' },
        { handled: true, policy, answers: {} }]) {
        LLMLogger.decide = async () => result;
        assert.equal(await M.sameThing(folder, message), null, JSON.stringify(result));
        assert.equal(generated, 1, 'unknown keeps the judgment\'s answer without another call');
    }
    // Scored but inconclusive (or confident below the policy): the generative
    // look decides, as it did alone before the feature; a wrong fold hides a bill.
    for (const result of [{ handled: true, status: 'scored', policy, answers: choice('inconclusive', 1) },
        { handled: true, status: 'scored', policy, answers: choice('different', 0.87) }]) {
        LLMLogger.decide = async () => result;
        generativeAnswer = '{"same": false}';
        const before = generated;
        assert.equal(await M.sameThing(folder, message), false, JSON.stringify(result));
        assert.equal(generated, before + 1, 'inconclusive asks the look it stood in for');
    }
    generativeAnswer = '{"same": true}';
    LLMLogger.decide = async () => ({ handled: true, status: 'invalid', code: 'invalid_response' });
    generativeAnswer = '{"same": false}';
    assert.equal(await M.sameThing(folder, message), false);
    assert.equal(generated, 4, 'a terminal decision runs the look it stood in for');
    LLMLogger.decide = async () => ({ handled: false, status: 'unsupported' });
    assert.equal(await M.sameThing(folder, message), false);
    assert.equal(generated, 5, 'off the cloud route the look runs as it always has');
    LLMLogger.decide = async () => { throw new Error('no bridge'); };
    assert.equal(await M.sameThing(folder, message), false);
    assert.equal(generated, 6);
    // A bounded source (Slack) never reaches the decision; its own path answers.
    let asked = 0;
    LLMLogger.decide = async () => { asked++; return { handled: true, policy, answers: choice('same', 0.99) }; };
    const slack = await M.sameThing({ ...folder, privacySources: ['slack'] }, message, 'slack-matter');
    assert.equal(asked, 0); assert.equal(slack, null, 'Slack evidence is answered by its bounded path or not at all');
    // D6: the folder changed while the decision ran.
    const stored = { id: 'matter:c', title: 'Dental cleaning', kind: 'appointment', when: { date: '2026-10-08', time: '10:30' }, sources: [{ from: 'Okonkwo Dental', summary: 'See you Thursday.' }] };
    M.get = id => id === 'matter:c' ? stored : null;
    LLMLogger.decide = async () => { stored.when = { date: '2026-10-09', time: '10:30' }; return { handled: true, policy, answers: choice('same', 0.99) }; };
    assert.equal(await M.sameThing(folder, message), null, 'a folder that moved while the decision ran is not judged by it');
    LLMLogger.decide = async () => ({ handled: true, policy, answers: choice('same', 0.99) });
    assert.equal(await M.sameThing(folder, message), true);
    // A test's own inference seam owns the whole look.
    M._inference = async () => { generated++; return { message: { content: '{"same": true}' } }; };
    asked = 0;
    assert.equal(await M.sameThing(folder, message), true);
    assert.equal(asked, 0); assert.equal(generated, 7);
    console.log('matter-decision-test: decision first on the cloud route, inconclusive and unknown keep the judgment, invalid and other routes run the look, bounded sources and stale folders passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
