/**
 * ThreadPanels (docs/THREAD_PANELS.md): what a thread is tracking, drawn
 * from its members' records. Pure: Commitments is a small stub here.
 */
const assert = require('assert');
const AnswerBlocks = require('../js/components/answer-blocks.js');
global.AnswerBlocks = AnswerBlocks;
const ThreadPanels = require('../js/core/thread-panels.js');

const today = '2026-10-11';
const addDays = (iso, n) => ThreadPanels._addDays(iso, n);

// A goal with a measure, and its daily step.
const goal = { id: 'g1', title: 'Better sleep', state: 'open' };
const step = { id: 's1', title: 'Log sleep', parent: 'g1', state: 'open', repeat: { rule: 'daily' }, when: { date: addDays(today, -6) },
    history: { [addDays(today, -6)]: 'done', [addDays(today, -5)]: 'done', [addDays(today, -3)]: 'dropped', [addDays(today, -1)]: 'done' } };
const C = {
    all: () => [goal, step],
    rootOf: (c) => (c.parent ? goal : c),
    repeats: (c) => !!(c.repeat && c.repeat.rule && c.repeat.rule !== 'none'),
    occursOn: () => true,
    unitLabel: (u) => u,
    aimText: (a) => `${a.measure} ${a.target} or more`,
    figure: (v, u) => `${v} ${u}`,
    progress: (g) => (g.id === 'g1' ? {
        aim: { measure: 'sleep', target: 8, unit: 'h', dir: 'up' },
        measure: { name: 'sleep', unit: 'h', points: [{ day: addDays(today, -6), value: 6.5 }, { day: addDays(today, -1), value: 7.2 }], last: { day: addDays(today, -1), value: 7.2 }, toGo: 0.8, reached: false },
        stage: null, overall: { planned: 7, done: 3, skipped: 1, open: 0 }
    } : null)
};
const ctx = { today, Commitments: C, upcoming: () => [] };

// V2: nothing to draw, no blocks; nenva's thread never has a drawer.
assert.deepStrictEqual(ThreadPanels.blocksFor({ type: 'nenva' }, ctx), []);
assert.deepStrictEqual(ThreadPanels.blocksFor({ type: 'other', key: 'page:x' }, ctx), []);
const bare = { key: 'task:t9', type: 'commitment', rec: { id: 't9', title: 'Call the plumber', state: 'open' }, title: 'Call the plumber' };
assert.deepStrictEqual(ThreadPanels.blocksFor(bare, { ...ctx, Commitments: { ...C, progress: () => ({ measure: null, aim: null, stage: null, overall: { planned: 0 } }), all: () => [bare.rec], rootOf: c => c } }), []);

// A goal's thread: stats, the measure's line, and the step's days.
const goalRow = { key: 'task:g1', type: 'commitment', rec: goal, title: goal.title,
    memberRows: [{ key: 'task:g1', type: 'commitment', rec: goal, title: goal.title }, { key: 'task:s1', type: 'commitment', rec: step, title: step.title }] };
const blocks = ThreadPanels.blocksFor(goalRow, ctx);
const kinds = blocks.map(b => b.block.kind);
assert.deepStrictEqual(kinds, ['stats', 'line', 'days'], `kinds: ${kinds}`);
const stats = blocks[0].block.items;
assert.strictEqual(stats[0].value, 7.2, 'the latest figure, from the record (V1)');
assert.ok(stats.some(i => i.label === 'To go' && i.value === '0.8 h'));
assert.deepStrictEqual(blocks[1].block.points.map(p => p.y), [6.5, 7.2]);
const days = blocks[2].block.days;
assert.strictEqual(days.length, 7, 'from the step\'s first day to today');
assert.deepStrictEqual(days.map(d => d.state), ['done', 'done', 'missed', 'skipped', 'missed', 'done', 'open']);
// Ids are stable (an arrangement names them): provider, then the block's own key.
assert.deepStrictEqual(blocks.map(b => b.id), ['progress:stats:g1', 'progress:line:g1:sleep', 'days:s1']);

// A sender holding bills: amounts by month and the latest ones; dated things coming up.
const bill = (id, day, amount, state = 'settled') => ({ key: `matter:${id}`, type: 'matter', title: `Water bill ${day.slice(5, 7)}`, rec: { id: `matter:${id}`, amount, when: { date: day }, state } });
const sender = { key: 'sender:utilities', type: 'sender', title: 'Utilities',
    memberRows: [bill('a', '2026-08-03', '$84.20'), bill('b', '2026-09-02', '$1,102.50'), bill('c', '2026-10-02', 'USD 91', 'open'), bill('d', '2026-10-05', 'no figure')] };
const up = [{ key: 'matter:c', title: 'Water bill 10', date: '2026-10-20' }];
const sb = ThreadPanels.blocksFor(sender, { ...ctx, upcoming: () => up });
assert.deepStrictEqual(sb.map(b => b.id), ['coming', 'amounts:months', 'amounts:latest']);
assert.strictEqual(sb[0].block.rows[0]._link, 'anjadhe://matter/matter:c');
assert.deepStrictEqual(sb[0].block.columns.map(c => c.key), ['what', 'when'], 'no Time column when nothing listed has a time');
// A to-do with a time shows it in its own column, drawn as a clock.
const timed = ThreadPanels.blocksFor(sender, { ...ctx, upcoming: () => [{ key: 'task:t1', title: 'Call the dentist', date: '2026-10-13', time: '15:30' }, ...up] });
assert.deepStrictEqual(timed[0].block.columns.map(c => c.key), ['what', 'when', 'time']);
assert.deepStrictEqual(timed[0].block.rows.map(r => r.time), [930, null]);
assert.deepStrictEqual(sb[1].block.items.map(i => i.value), [84.2, 1102.5, 91]);
assert.strictEqual(sb[2].block.rows.length, 3, 'a folder with no figure is left out');
assert.strictEqual(sb[2].block.rows[0].when, '2026-10-02', 'newest first');
// A receipt has no due date: its month is its message's (never the day the folder was made, which a backfill makes "today").
const receipt = { key: 'matter:r', type: 'matter', title: 'Policy renewed', rec: { id: 'matter:r', amount: '$612', when: null, state: 'done', createdAt: '2026-10-11T09:00:00Z', sources: [{ at: '2026-04-13T08:10:00Z' }] } };
const rb = ThreadPanels.blocksFor({ ...sender, memberRows: [...sender.memberRows, receipt] }, { ...ctx, upcoming: () => up });
assert.deepStrictEqual(rb[1].block.items.map(i => i.label.slice(0, 3)), ['Apr', 'Aug', 'Sep', 'Oct'], 'the receipt lands in April');

// One month of bills: no bar, the table only.
const one = ThreadPanels.blocksFor({ ...sender, memberRows: [bill('a', '2026-08-03', '$84.20')] }, ctx);
assert.deepStrictEqual(one.map(b => b.block.kind), ['table']);

// money(): figures people write.
assert.strictEqual(ThreadPanels.money('$1,284.50'), 1284.5);
assert.strictEqual(ThreadPanels.money('-$12'), -12);
assert.strictEqual(ThreadPanels.money('none'), null);

// V6: a package registers its own provider; a failing one is skipped, never fatal.
ThreadPanels.register({ id: 'boom', label: 'Boom', order: 5, build: () => { throw new Error('x'); } });
ThreadPanels.register({ id: 'extra', label: 'Extra', order: 99, build: () => ({ kind: 'stats', items: [{ label: 'n', value: 1 }] }) });
const warn = console.warn; console.warn = () => {};
const withExtra = ThreadPanels.blocksFor(sender, ctx);
console.warn = warn;
assert.strictEqual(withExtra[withExtra.length - 1].id, 'extra');
assert.ok(!withExtra.some(b => b.id === 'boom'));

// The days block draws, and an invented state is dropped by normalize.
const html = AnswerBlocks.render('d', { d: AnswerBlocks.normalize({ kind: 'days', title: 'Log sleep', days: [...days, { date: today, state: 'great' }] }) });
assert.ok(html.includes('ab-days') && (html.match(/class="ab-day /g) || []).length === 7);
assert.ok(html.includes('3 done'));

// ── The arrangement (V3) ──
ThreadPanels._providers = ThreadPanels._providers.filter(p => !['boom', 'extra'].includes(p.id));
// Order first, hidden dropped, unnamed blocks keep their place after; never everything hidden.
const ids = ['a', 'b', 'c', 'd'].map(id => ({ id }));
assert.deepStrictEqual(ThreadPanels.arrange(ids, { order: ['c', 'a'], hidden: ['b'] }).map(b => b.id), ['c', 'a', 'd']);
assert.deepStrictEqual(ThreadPanels.arrange(ids, { hidden: ['a', 'b', 'c', 'd'] }).map(b => b.id), ['a', 'b', 'c', 'd']);
assert.deepStrictEqual(ThreadPanels.arrange(ids, null).map(b => b.id), ['a', 'b', 'c', 'd']);

// vet: only ids the thread has, only figures it keeps (in their own spelling), never all hidden.
const v = ThreadPanels.vet({ order: ['c', 'zzz', 'c'], hidden: ['a', 'nope'], measures: ['Bedtime', 'weight', 'sleep'] }, ['a', 'b', 'c'], ['sleep', 'bedtime']);
assert.deepStrictEqual(v, { order: ['c'], hidden: ['a'], measures: ['bedtime', 'sleep'] });
assert.deepStrictEqual(ThreadPanels.vet({ hidden: ['a', 'b'] }, ['a', 'b'], []).hidden, []);

// An asked figure draws its own line, from the record (series), keyed by its name.
const C2 = { ...C, series: (g, name) => (name === 'bedtime' ? [{ day: addDays(today, -2), value: 1380 }, { day: addDays(today, -1), value: 1410 }] : []),
    progress: (g) => ({ ...C.progress(g), names: ['sleep', 'bedtime'], units: { sleep: 'h', bedtime: 'time' } }) };
const arranged = ThreadPanels.blocksFor(goalRow, { ...ctx, Commitments: C2, arrangement: { measures: ['bedtime'], order: ['days:s1'] } });
assert.deepStrictEqual(arranged.map(b => b.id), ['days:s1', 'progress:stats:g1', 'progress:line:g1:sleep', 'progress:line:g1:bedtime']);
const bed = arranged[3].block;
assert.strictEqual(bed.format, 'clock');
assert.deepStrictEqual(bed.points.map(p => p.y), [1380, 1410]);
// A figure the goal does not keep is never drawn, even when an arrangement names it.
assert.ok(!ThreadPanels.blocksFor(goalRow, { ...ctx, Commitments: C2, arrangement: { measures: ['weight'] } }).some(b => /weight/.test(b.id)));
assert.deepStrictEqual(ThreadPanels.measuresOf(goalRow, { ...ctx, Commitments: C2 }), ['sleep', 'bedtime']);

// What the assistant is shown: ids and shapes, never the numbers.
const d = ThreadPanels.describe(blocks[1]);
assert.ok(d.startsWith('progress:line:g1:sleep: Progress') && d.includes('2 points') && !d.includes('7.2'));
// The fingerprint changes with what it can draw.
assert.notStrictEqual(ThreadPanels.fingerprint(blocks, ['sleep']), ThreadPanels.fingerprint(blocks.slice(1), ['sleep']));

console.log('thread-panels-test: ok');
