// A goal is one thread (js/core/threads-page.js + ThingCapture T6, 2026-10-11):
// a step never gets a thread of its own; it lives in its goal's thread as a
// member, a step key opens the goal's thread, and a message there reaches
// the step the person means. Model answers are scripted.
const assert = require('assert');
global.MatterCapture = require('../js/agent/matter-capture.js');
global.OccurrenceCapture = require('../js/agent/occurrence-capture.js');
const C = require('../js/core/commitments.js');
global.CommitmentKinds = require('../js/core/commitment-kinds.js');
const TP = require('../js/core/threads-page.js');
const T = require('../js/agent/thing-capture.js');

(async () => {
    const store = {};
    global.StorageManager = { get: k => store[k] ? structuredClone(store[k]) : null, set: (k, v) => { store[k] = structuredClone(v); } };
    global.Commitments = C;
    global.FEATURES = { isEnabled: () => true };
    global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    C._inited = true;
    const today = C.today();
    const at = '2026-10-10T06:00:00Z';
    const goal = { ...C.blank('goal', at), title: 'Sleep — get to 7 hours a night', kind: 'goal', state: 'open', when: { date: null, time: null, end: null } };
    const log = { ...C.blank('log', at), title: 'Log sleep', state: 'open', parent: 'goal', when: { date: '2026-09-01', time: '07:15', end: null }, repeat: { rule: 'daily' } };
    const cutoff = { ...C.blank('cut', at), title: 'Close the laptop at 10:30', state: 'open', parent: 'goal', when: { date: '2026-09-01', time: '22:30', end: null }, repeat: { rule: 'daily' } };
    const sub = { ...C.blank('sub', at), title: 'Set up the YouTube block', state: 'open', parent: 'cut', when: { date: today, time: null, end: null } };
    const alone = { ...C.blank('toy', at), title: 'Buy the dumpling toy', state: 'open', when: { date: today, time: null, end: null } };
    store[C.KEY] = { items: [goal, log, cutoff, sub, alone], ledger: [], tombstones: {} };
    C._data = null;

    // Which thread holds a commitment.
    assert.strictEqual(TP.goalKeyOf('task:log'), 'task:goal');
    assert.strictEqual(TP.goalKeyOf('task:sub'), 'task:goal', 'a step of a step goes to the top');
    assert.strictEqual(TP.goalKeyOf('task:goal'), 'task:goal');
    assert.strictEqual(TP.goalKeyOf('task:toy'), 'task:toy', 'a commitment with no family keeps its own');
    assert.strictEqual(TP.goalKeyOf('matter:x'), 'matter:x');

    // One row per family: the goal holds its steps; the step rows are gone.
    const rows = TP._commitmentRows(Date.now(), Date.now() - 14 * 86400000, {});
    assert.deepStrictEqual(rows.map(r => r.key).sort(), ['task:goal', 'task:toy']);
    const g = rows.find(r => r.key === 'task:goal');
    assert.deepStrictEqual(g.members.sort(), ['task:cut', 'task:log', 'task:sub']);
    assert.strictEqual(g.avatar, 'goal');
    assert.strictEqual(g.memberRows[0].key, 'task:goal', 'the goal leads its own thread');
    assert.ok(g.items.some(i => i.member === 'task:log' && i.about === 'Log sleep'), 'a step\'s events are tagged with its name');
    assert.ok(!g.items.some(i => i.member === 'task:goal' && i.about), 'the goal\'s own events are not tagged');

    // A step placed in a sender stays the sender's.
    const held = new Set(['task:cut']);
    const g2 = TP._commitmentRows(Date.now(), Date.now() - 14 * 86400000, {}, held).find(r => r.key === 'task:goal');
    assert.ok(!g2.members.includes('task:cut'));

    // A step's key opens the goal's thread.
    assert.strictEqual(TP.rowFor('task:log').key, 'task:goal');
    assert.strictEqual(TP.rowFor('task:toy').key, 'task:toy');

    // In the goal's thread, "slept 11:30 to 7:45" reaches Log sleep (T6 over the steps).
    const said = 'in bed at 11:30 and up at 7:45';
    const answers = [
        { item: 2 },   // [1] the goal, [2] Log sleep, ...
        { report: 'done', quote: said, day: today, measures: [{ name: 'bedtime', value: '23:30', unit: 'time' }], card: 'keep' }
    ];
    const tags = [];
    global.AgentService = { model: 'test', numCtx: 8192, conversations: [] };
    global.LLMLogger = { call: async (tag, p) => { tags.push(tag); return { message: { content: JSON.stringify(answers.shift() || {}) } }; } };
    const conv = { id: 'conv_goal', todayKey: 'task:goal', messages: [] };
    const out = await T.beforeReply({ conv, userText: said });
    assert.ok(out, 'the step was judged');
    assert.strictEqual(C.get('log').history[today], 'done', 'filed on the step, not the goal');
    assert.ok(!C.get('goal').history || !C.get('goal').history[today]);
    assert.match(out.line, /^Log sleep/);
    assert.strictEqual(tags.length, 2, 'one pick, then the step\'s own judgment');

    // Nothing about a step: the goal itself is judged.
    answers.push({ item: 0 }, { record: 'none', report: 'none', quote: '', card: 'keep' });
    tags.length = 0;
    await T.beforeReply({ conv, userText: 'is this plan too ambitious?' });
    assert.strictEqual(tags.length, 2);

    // The reply hears the steps by name and id.
    global.SimpleExperience = undefined;
    const ctx = TP._commitmentContext('task:goal');
    assert.match(ctx, /ONE goal/);
    assert.match(ctx, /Log sleep \(id log, repeats daily\)/);
    assert.match(TP._commitmentContext('task:toy'), /ONE commitment/);
    console.log('goal-thread: a step lives in its goal\'s thread, opens it, and a message there reaches the step; passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
