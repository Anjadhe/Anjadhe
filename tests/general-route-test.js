// ThingCapture T7 (js/agent/thing-capture.js, 2026-10-11): a report said in
// a GENERAL chat reaches the commitment it is about, through the same
// judgment and door as the commitment's own chat, and nenva's note lands in
// that thing's thread. The model's answers are scripted.
const assert = require('assert');
global.MatterCapture = require('../js/agent/matter-capture.js');
global.OccurrenceCapture = require('../js/agent/occurrence-capture.js');
const C = require('../js/core/commitments.js');
const T = require('../js/agent/thing-capture.js');
global.ThreadsPage = require('../js/core/threads-page.js');

(async () => {
    const store = {};
    global.StorageManager = { get: k => store[k] ? structuredClone(store[k]) : null, set: (k, v) => { store[k] = structuredClone(v); } };
    global.Commitments = C;
    global.FEATURES = { isEnabled: () => true };
    const conversations = [];
    let saved = 0;
    global.AgentService = { model: 'test', numCtx: 8192, conversations, _saveConversations: () => { saved++; } };
    C._inited = true;
    const today = C.today();
    const goal = { ...C.blank('goal', '2026-09-01T00:00:00Z'), title: 'Sleep — get to 7 hours a night', state: 'open', when: { date: null, time: null, end: null } };
    const log = { ...C.blank('log', '2026-09-01T00:00:00Z'), title: 'Log sleep', state: 'open', parent: 'goal', when: { date: '2026-09-01', time: '07:15', end: null }, repeat: { rule: 'daily' } };
    store[C.KEY] = { items: [goal, log], ledger: [], tombstones: {} };
    C._data = null;

    // The thread of a thing with no sender is its own chat (the shape of SimpleExperience._cardConv).
    global.SimpleExperience = {
        cardForThing: () => null,
        _cardConv: ({ key, title }) => {
            let conv = conversations.find(c => c.todayKey === key);
            if (!conv) { conv = { id: `conv_${key}`, title, messages: [], todayKey: key }; conversations.push(conv); }
            return { conv };
        }
    };

    const said = 'slept well, in bed at 11:30 and up at 7:45. Also send me a daily summary of AI agent news';
    const prompts = [];
    const answers = [
        { items: [{ item: 0, quote: 'nope' }, { item: 1, quote: 'in bed at 11:30 and up at 7:45' }], repeat: 'send me a daily summary of AI agent news' },
        { report: 'done', quote: 'in bed at 11:30 and up at 7:45', day: today, measures: [{ name: 'bedtime', value: '23:30', unit: 'time' }, { name: 'wake', value: '07:45', unit: 'time' }], card: 'keep' }
    ];
    global.LLMLogger = { call: async (tag, p) => { prompts.push({ tag, text: p.messages[1].content }); return { message: { content: JSON.stringify(answers.shift() || {}) } }; } };

    const general = { id: 'conv_general', title: 'Morning', messages: [{ role: 'user', content: said }] };
    conversations.push(general);
    const out = await T.beforeReply({ conv: general, userText: said });
    assert.ok(out, 'the general chat acted');
    assert.strictEqual(prompts[0].tag, 'general-route');
    assert.ok(prompts[0].text.indexOf('Log sleep') < prompts[0].text.indexOf('Sleep — get to 7'), 'repeating things are listed first');
    assert.ok(/part of "Sleep — get to 7 hours a night"/.test(prompts[0].text), 'a step names the goal it is part of');

    // The report landed on the log, today, with figures.
    const entry = (C.get('log').log || {})[today];
    assert.ok(entry && entry.length === 1, 'filed on today\'s log');
    assert.strictEqual(C.get('log').history[today], 'done');
    assert.match(out.line, /Log sleep/);
    assert.ok(out.wrote.includes('change'));

    // The receipt names the thing and its thread; Undo works through it.
    const r = out.receipts[0].routed[0];
    assert.match(r.occurrence.text, /^Log sleep · /);
    assert.deepStrictEqual(r.thread, { key: 'task:goal', name: 'Sleep — get to 7 hours a night' }, 'a step\'s thread is its goal\'s');

    // nenva's note in the goal's thread (where the step lives), linking back.
    assert.ok(!conversations.some(c => c.todayKey === 'task:log'), 'no thread of its own for the step');
    const thread = conversations.find(c => c.todayKey === 'task:goal');
    assert.ok(thread && thread.texting);
    const note = thread.messages.at(-1);
    assert.strictEqual(note.role, 'assistant');
    assert.strictEqual(note.metadata.handoff.from, 'conv_general');
    assert.ok(saved >= 1);

    // The repeat request writes nothing and asks the reply for a routine.
    assert.match(out.ask, /create_routine/);
    assert.match(out.ask, /daily summary of AI agent news/);

    assert.ok(C.undo(r.occurrence.ledgerId).ok);
    assert.ok(!C.get('log').history[today], 'Undo takes the day back');

    // Small talk: one routing call, nothing written, nothing returned.
    prompts.length = 0;
    answers.push({ items: [], repeat: '' });
    assert.strictEqual(await T.beforeReply({ conv: general, userText: 'thanks, that helps' }), null);
    assert.strictEqual(prompts.length, 1);

    // Never from a private chat.
    global.PrivateChat = { isPrivate: () => true };
    prompts.length = 0;
    assert.strictEqual(await T.beforeReply({ conv: general, userText: said }), null);
    assert.strictEqual(prompts.length, 0);
    console.log('general-route: a report in a general chat lands on its commitment, its thread hears it, a repeat asks for a routine; gates passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
