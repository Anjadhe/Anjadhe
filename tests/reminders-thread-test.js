// Reminders (js/core/senders.js + threads-page.js, 2026-10-11): every loose
// to-do lives in one built-in thread pinned under nenva, never a thread
// each; a word there reaches the to-do it is about; the grouping may answer
// "Reminders" for a to-do with no home, which is final and places nothing.
const assert = require('assert');
global.MatterCapture = require('../js/agent/matter-capture.js');
global.OccurrenceCapture = require('../js/agent/occurrence-capture.js');
const C = require('../js/core/commitments.js');
const S = require('../js/core/senders.js');
const TP = require('../js/core/threads-page.js');
const T = require('../js/agent/thing-capture.js');

(async () => {
    const store = {};
    global.StorageManager = { get: k => store[k] ? structuredClone(store[k]) : null, set: (k, v) => { store[k] = structuredClone(v); } };
    global.Commitments = C;
    global.Senders = S;
    global.FEATURES = { isEnabled: () => true };
    global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    C._inited = true;
    const today = C.today();
    const at = '2026-10-10T06:00:00Z';
    const goal = { ...C.blank('goal', at), title: 'Sleep better', state: 'open', when: { date: null, time: null, end: null } };
    const log = { ...C.blank('log', at), title: 'Log sleep', state: 'open', parent: 'goal', when: { date: '2026-09-01', time: '07:15', end: null }, repeat: { rule: 'daily' } };
    const toy = { ...C.blank('toy', at), title: 'Buy a dumpling toy for the kid', state: 'open', when: { date: today, time: null, end: null } };
    const call = { ...C.blank('call', at), title: 'Call the plumber', state: 'open', when: { date: null, time: null, end: null } };
    const daily = { ...C.blank('walk', at), title: 'Evening walk', state: 'open', when: { date: '2026-09-01', time: '19:00', end: null }, repeat: { rule: 'daily' } };
    const coached = { ...C.blank('bp', at), title: 'Bring my blood pressure down', state: 'open', domain: 'health', when: { date: null, time: null, end: null } };
    store[C.KEY] = { items: [goal, log, toy, call, daily, coached], ledger: [], tombstones: {} };
    C._data = null;
    const all = C.all();

    // The shape of a loose to-do.
    assert.strictEqual(S.isToDo(C.get('toy'), all), true);
    assert.strictEqual(S.isToDo(C.get('call'), all), true, 'undated is still a to-do');
    assert.strictEqual(S.isToDo(C.get('log'), all), false, 'a step lives with its goal');
    assert.strictEqual(S.isToDo(C.get('goal'), all), false, 'a commitment with steps is a goal');
    assert.strictEqual(S.isToDo(C.get('walk'), all), false, 'a repeat keeps its own thread');
    assert.strictEqual(S.isToDo(C.get('bp'), all), false, 'a coached goal keeps its own thread');
    assert.deepStrictEqual(S.members(S.REMINDERS).sort(), ['task:call', 'task:toy']);
    assert.strictEqual(S.get(S.REMINDERS).builtIn, true);

    // The thread list: nenva, then Reminders holding both to-dos; no to-do has a thread of its own.
    const rows = TP.threads();
    const keys = rows.map(r => r.key);
    assert.strictEqual(keys[0], 'nenva');
    assert.strictEqual(keys[1], S.REMINDERS, 'Reminders sits under nenva');
    assert.ok(!keys.includes('task:toy') && !keys.includes('task:call'));
    assert.ok(keys.includes('task:goal') && keys.includes('task:walk') && keys.includes('task:bp'));
    const r = rows[1];
    assert.deepStrictEqual(r.members.sort(), ['task:call', 'task:toy']);
    assert.ok(r.pinned, 'it is not deleted like a thread');

    // Every door to a to-do lands in Reminders.
    assert.strictEqual(TP.threadKeyOf('task:toy'), S.REMINDERS);
    assert.strictEqual(TP.rowFor('task:toy').key, S.REMINDERS);
    assert.strictEqual(TP.threadKeyOf('task:log'), 'task:goal');

    // A to-do that a sender holds leaves Reminders.
    store.senders = { version: 1, senders: { 'sender:kids-1': { id: 'sender:kids-1', name: 'Kids', state: 'active' } }, place: { 'task:toy': { sender: 'sender:kids-1', by: 'you' } }, aliases: {}, tries: {} };
    S._data = null;
    assert.deepStrictEqual(S.members(S.REMINDERS), ['task:call']);
    assert.strictEqual(TP.threadKeyOf('task:toy'), 'sender:kids-1');
    delete store.senders; S._data = null;

    // In the Reminders thread, "got the toy" reaches the toy (T6 over its members).
    const said = 'got the dumpling toy today';
    const answers = [{ item: 1 }, { record: 'done', report: 'done', quote: 'got the dumpling toy', card: 'keep' }];
    global.AgentService = { model: 'test', numCtx: 8192, conversations: [] };
    global.LLMLogger = { call: async () => ({ message: { content: JSON.stringify(answers.shift() || {}) } }) };
    // Members are listed in store order: [1] the toy, [2] the plumber.
    const conv = { id: 'conv_rem', todayKey: S.REMINDERS, messages: [] };
    const out = await T.beforeReply({ conv, userText: said });
    assert.ok(out, 'the to-do was judged');
    assert.strictEqual(C.get('toy').state, 'done', 'the toy is done');
    assert.strictEqual(C.get('call').state, 'open');

    // The grouping: "Reminders" for a to-do is final and places nothing; never for mail.
    const items = [{ key: 'task:call', kind: 'commitment', text: '(their to-do) Call the plumber' }, { key: 'matter:m1', kind: 'matter', text: '(order) Shoes' }];
    const placements = S.vet({ placements: [{ item: 'I1', sender: 'Reminders' }, { item: 'I2', sender: 'Reminders' }] }, items, []);
    assert.deepStrictEqual(placements[0], { key: 'task:call', reminders: true });
    assert.ok(!placements[1].reminders, 'a folder from mail is never a reminder');
    const d = S.empty();
    S.apply(d, [placements[0]]);
    assert.strictEqual(d.place['task:call'], undefined, 'nothing is placed');
    assert.strictEqual(d.tries['task:call'], S.TRIES_MAX, 'and it is not asked again');
    assert.match(S.prompt(items, []), /goes in "Reminders"/);
    console.log('reminders-thread: loose to-dos live in Reminders under nenva, every door lands there, a word there reaches the to-do, the grouping may answer Reminders; passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
