// CommitmentKinds (js/core/commitment-kinds.js, 2026-10-11): a commitment is
// shown as what it is (goal, project, habit, task); the assistant names it,
// code only defaults what was never judged, the person's word wins.
const assert = require('assert');
const C = require('../js/core/commitments.js');
const K = require('../js/core/commitment-kinds.js');

(async () => {
    const store = {};
    global.StorageManager = { get: k => store[k] ? structuredClone(store[k]) : null, set: (k, v) => { store[k] = structuredClone(v); } };
    global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    global.Commitments = C;
    C._inited = true;
    const at = '2026-10-10T06:00:00Z';
    const mk = (id, extra) => ({ ...C.blank(id, at), title: id, ...extra });
    store[C.KEY] = { items: [
        mk('sleep', { domain: 'health' }),
        mk('log', { parent: 'sleep', repeat: { rule: 'daily', days: [] }, when: { date: '2026-09-01', time: '07:15', end: null } }),
        mk('news', { outcome: 'Issue 3 out' }),
        mk('remodel', {}), mk('demo', { parent: 'remodel' }),
        mk('toy', {}),
        mk('said', { kind: 'project' })
    ], ledger: [], tombstones: {} };
    C._data = null;
    const all = C.all();

    // The default, only for what was never judged.
    assert.strictEqual(C.kindOf(C.get('sleep'), all), 'goal', 'a coached one is a goal');
    assert.strictEqual(C.kindOf(C.get('log'), all), 'habit', 'a repeat is a habit');
    assert.strictEqual(C.kindOf(C.get('news'), all), 'project', 'an outcome without an aim is a project');
    assert.strictEqual(C.kindOf(C.get('remodel'), all), 'project', 'something with tasks under it is a project');
    assert.strictEqual(C.kindOf(C.get('demo'), all), 'task');
    assert.strictEqual(C.kindOf(C.get('toy'), all), 'task');
    assert.strictEqual(C.kindOf(C.get('said'), all), 'project', 'a given kind wins over the facts');

    // The field is checked like any other.
    assert.deepStrictEqual(C.vetFields({ kind: 'Habit' }, {}).fields, { kind: 'habit' });
    assert.deepStrictEqual(C.vetFields({ kind: 'chore' }, {}).dropped, ['kind']);
    const made = C.create({ title: 'Plan the trip', kind: 'project' }, { by: 'assistant' });
    assert.strictEqual(C.get(made.id).kind, 'project');

    // The registry: four kinds, each with its words and icon.
    assert.deepStrictEqual(K.ids(), ['goal', 'project', 'habit', 'task']);
    assert.deepStrictEqual(K.ids(), C.KINDS, 'the store and the registry agree');
    assert.strictEqual(K.label(C.get('log')), 'Habit');
    assert.strictEqual(K.get('nope').id, 'task', 'an unknown kind reads as a task');
    assert.ok(K.all().every(k => k.icon && k.about && k.plural));
    assert.match(K.guide(), /"habit": something they repeat/);

    // K1: one pass asks for every commitment without a kind; K2: a kind set meanwhile is never overwritten.
    const unjudged = K.unjudged(C.all()).map(c => c.id);
    assert.ok(!unjudged.includes('said') && !unjudged.includes(made.id), 'judged ones are not asked');
    assert.ok(unjudged.indexOf('sleep') < unjudged.indexOf('log'), 'top-level first');
    const batch = K.unjudged(C.all());
    const vetted = K.vet({ kinds: [{ item: 1, kind: 'goal' }, { item: 1, kind: 'task' }, { item: 99, kind: 'goal' }, { item: 2, kind: 'chore' }] }, batch);
    assert.deepStrictEqual([...vetted], [[batch[0].id, 'goal']], 'real items, real kinds, each once');

    global.AgentService = { model: 'test', numCtx: 8192 };
    let prompt = '';
    global.LLMLogger = { call: async (tag, p) => {
        prompt = p.messages[1].content;
        const b = K.unjudged(C.all());
        // Meanwhile the person says the toy is a project: their word must stand.
        C.change('toy', { kind: 'project' }, { by: 'you' });
        return { message: { content: JSON.stringify({ kinds: b.map((c, i) => ({ item: i + 1, kind: c.id === 'log' ? 'habit' : c.id === 'toy' ? 'task' : 'goal' })) }) } };
    } };
    const out = await K.adopt();
    assert.ok(out.done >= 4);
    assert.match(prompt, /part of "sleep"/, 'a step names what it belongs to');
    assert.strictEqual(C.get('log').kind, 'habit');
    assert.strictEqual(C.get('toy').kind, 'project', 'the person\'s word wins');
    const entry = C._load().ledger.find(e => e.target === 'log' && e.by === 'nenva');
    assert.ok(entry, 'ledgered, with Undo');
    assert.ok(C.undo(entry.id).ok);
    assert.ok(!C.get('log').kind, 'Undo takes the kind back');
    assert.strictEqual(K.unjudged(C.all()).length, 1, 'only what was undone is left to ask');
    console.log('commitment-kinds: the default, the field, the registry, the one-time pass and the person\'s word; passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
