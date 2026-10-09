#!/usr/bin/env node
// Coaching on commitments (docs/COACH.md §1–4, 2026-10-09): domain, aim,
// stages that end (`until`), measures kept from the person's own words
// (CO2), and the one progress reader (CO3).
const assert = require('assert');
const C = require('../js/core/commitments.js');
let store = null;
global.StorageManager = { get: k => (k === C.KEY ? store : null), set: (k, v) => { if (k === C.KEY) store = JSON.parse(JSON.stringify(v)); } };
const reset = () => { store = null; C._data = null; };
const eq = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);

// ── Units and words ──
{
    eq(C.unit('Miles'), 'mi'); eq(C.unit('lbs'), 'lb'); eq(C.unit(''), ''); eq(C.unit('bpm'), 'bpm');
    eq(C.convert(10, 'km', 'mi'), 6.21); eq(C.convert(1, 'h', 'min'), 60); eq(C.convert(5, 'kg', 'mi'), null, 'different kinds never convert');
    eq(C.nums('ran 5.2 miles in 48 min, 1,200 kcal, BP 128/82'), [5.2, 48, 1200, 128, 82]);
    assert.ok(C.clocks('in bed 11:40').has(23 * 60 + 40), 'an unsaid half of the day reads both ways');
    assert.ok(C.clocks('up at 6:15am').has(6 * 60 + 15)); assert.ok(!C.clocks('up at 6:15am').has(18 * 60 + 15));
    eq(C.clockValue('11:40 pm'), 1420); eq(C.clockValue('23:40'), 1420); eq(C.clockValue(1420), 1420); eq(C.clockValue('25:00'), null);
}

// ── CO2: a figure is kept only when it is in the words ──
{
    const q = 'ran 5.2 miles in 48 min, legs heavy';
    const r = C.vetMeasures([{ name: 'Distance', value: 5.2, unit: 'miles' }, { name: 'duration', value: 48, unit: 'min' }, { name: 'pace', value: 9.2, unit: 'min/mi' }], q);
    eq(r.kept, [{ name: 'distance', value: 5.2, unit: 'mi' }, { name: 'duration', value: 48, unit: 'min' }]);
    eq(r.refused.map(x => x.name), ['pace'], 'a pace the model worked out is not their figure');
    eq(C.vetMeasures([{ name: 'distance', value: 8, unit: 'km' }], 'did 8 km today', { distance: 'mi' }).kept, [{ name: 'distance', value: 4.97, unit: 'mi' }], 'kept in the goal\'s unit, converted by code');
    eq(C.vetMeasures([{ name: 'distance', value: 8, unit: 'kg' }], 'did 8', { distance: 'mi' }).kept, [], 'an inconvertible unit is refused');
    eq(C.vetMeasures([{ name: 'systolic', value: 128, unit: 'mmHg' }, { name: 'diastolic', value: 82, unit: 'mmHg' }], 'BP 128/82 this morning').kept.length, 2);
    eq(C.vetMeasures([{ name: 'bedtime', value: '23:40', unit: 'time' }], 'in bed 11:40 last night').kept, [{ name: 'bedtime', value: 1420, unit: 'time' }]);
    eq(C.vetMeasures([{ name: 'bedtime', value: '23:10', unit: 'time' }], 'in bed 11:40').kept, [], 'a different time is refused');
}

// ── Aims, domain and until through the one door ──
{
    eq(C.vetAim({ measure: '10K time', target: 60, unit: 'minutes', from: { value: 72, day: '2026-10-01' } }), { measure: '10k time', target: 60, unit: 'min', dir: 'down', from: { value: 72, day: '2026-10-01' } }, 'direction from the first figure');
    eq(C.vetAim({ measure: 'bedtime', target: '23:00', unit: 'time', dir: 'down' }).target, 1380);
    eq(C.vetAim({ measure: '', target: 3 }), null);
    const { fields, dropped } = C.vetFields({ domain: 'Fitness', aim: { measure: 'distance', target: 6.2, unit: 'mi' }, until: '2026-10-19' }, {}, null);
    eq(fields.domain, 'fitness'); eq(fields.aim, { measure: 'distance', target: 6.2, unit: 'mi', dir: 'up' }); eq(fields.until, '2026-10-19'); eq(dropped, []);
    eq(C.vetFields({ domain: 'cooking', aim: { measure: 'x' }, until: '2026-02-30' }, {}, null).dropped.sort(), ['aim', 'domain', 'until']);
    eq(C.vetFields({ domain: '' }, {}, null).fields.domain, null, '"" clears it');
}

// ── A stage ends: occursOn, the old task shape ──
{
    const stage = { when: { date: '2026-10-05' }, repeat: { rule: 'weekly', days: [1, 3, 5] }, until: '2026-10-18' };
    assert.ok(C.occursOn(stage, '2026-10-16')); assert.ok(!C.occursOn(stage, '2026-10-19'), 'not after its last day');
    eq(C.nextOn(stage, '2026-10-17'), null, 'no next day once it has ended');
    const t = C.toTask({ ...C.blank('s1', '2026-10-01T00:00:00Z'), title: 'Easy runs', ...stage });
    eq(t.repeatUntil, '2026-10-18', 'the old shape carries the end');
    assert.ok(!('legacy' in C.fromTask(t)), 'and reads it back as no stray field');
}

// ── A 10K plan: reports with figures, progress by arithmetic ──
{
    reset();
    const g = C.create({ title: 'Run a 10K', outcome: 'Finish under an hour', by: '2027-03-01', domain: 'fitness', aim: { measure: 'distance', target: 6.2, unit: 'mi' } });
    const s1 = C.create({ title: 'Easy runs, 3 mi', parent: g.id, when: { date: '2026-10-05' }, repeat: { rule: 'weekly', days: [1, 3, 5] }, until: '2026-10-18' });
    const s2 = C.create({ title: 'Runs with a long one', parent: g.id, when: { date: '2026-10-19' }, repeat: { rule: 'weekly', days: [1, 3, 6] }, until: '2026-11-01' });
    eq(C.domainOf(C.get(s1.id)), 'fitness', 'a step reads its goal\'s domain');
    const day = (d, q, ms) => C.report(s1.id, { day: d, how: 'done', quote: q, measures: ms });
    // report() refuses a day after today; pin "today" for this block.
    const realToday = C.today; C.today = (n) => n === undefined ? '2026-10-12' : realToday.call(C, n);
    try {
        const r1 = day('2026-10-05', 'ran 3 miles', [{ name: 'distance', value: 3, unit: 'mi' }]);
        eq(r1.measures, [{ name: 'distance', value: 3, unit: 'mi' }]);
        day('2026-10-07', 'did 5 km, easy', [{ name: 'distance', value: 5, unit: 'km' }]);
        const r3 = day('2026-10-09', 'ran 3.5 miles in 34 min', [{ name: 'distance', value: 3.5, unit: 'mi' }, { name: 'duration', value: 34, unit: 'min' }, { name: 'pace', value: 9.7, unit: 'min/mi' }]);
        eq(r3.refused.map(x => x.name), ['pace']);
        C.report(s1.id, { day: '2026-10-12', how: 'dropped', quote: 'skipped, knee sore' });
        const again = C.report(s1.id, { day: '2026-10-09', quote: 'ran 3.5 miles in 34 min', measures: [{ name: 'distance', value: 3.5, unit: 'mi' }] });
        eq(again.changed, [], 'the same words and figures again write nothing');

        const p = C.progress(C.get(g.id), C.all(), '2026-10-12');
        eq(p.domain, 'fitness');
        eq(p.measure.points, [{ day: '2026-10-05', value: 3 }, { day: '2026-10-07', value: 3.11 }, { day: '2026-10-09', value: 3.5 }], '5 km kept as 3.11 mi');
        eq([p.measure.first.value, p.measure.last.value, p.measure.best, p.measure.toGo], [3, 3.5, 3.5, 2.7]);
        eq(p.stage.id, s1.id); eq([p.stage.planned, p.stage.done, p.stage.skipped], [4, 3, 1], 'Mon Wed Fri Mon');
        eq(p.names, ['distance', 'duration']);
        const lines = C.progressLines(p, C.get(g.id)).join('\n');
        assert.ok(/Aim: distance 6\.2 mi or more by 2027-03-01/.test(lines), lines);
        assert.ok(/distance: 3\.5 mi on 2026-10-09, from 3 mi on 2026-10-05, best 3\.5 mi, 2\.7 mi to go/.test(lines), lines);
        assert.ok(/This stage: Easy runs, 3 mi, from 2026-10-05 to 2026-10-18, 3 of 4 done so far, 1 skipped/.test(lines), lines);
        assert.ok(/Measures kept \(reuse these names and units\): distance \(mi\), duration \(min\)/.test(lines), lines);
        const standing = C.standing(C.get(s1.id), '2026-10-12', 'Run a 10K').join('\n');
        assert.ok(/Repeats until: .*2026-10-18/.test(standing) && /Its goal: Run a 10K/.test(standing) && /Coached as: fitness/.test(standing), standing);

        // Undo takes the figures back with the words.
        const r4 = C.report(s1.id, { day: '2026-10-12', quote: 'actually did 2 miles later', measures: [{ name: 'distance', value: 2, unit: 'mi' }] });
        assert.ok(C.undo(r4.ledgerId).ok);
        eq(C.series(C.get(g.id), 'distance').length, 3);
        eq(C.get(s2.id).until, '2026-11-01');
    } finally { C.today = realToday; }
}

// ── A bedtime aim, coming down ──
{
    reset();
    const realToday = C.today; C.today = (n) => n === undefined ? '2026-10-12' : realToday.call(C, n);
    try {
        const g = C.create({ title: 'In bed by 11', domain: 'health', when: { date: '2026-10-01' }, repeat: { rule: 'daily' }, aim: { measure: 'bedtime', target: '23:00', unit: 'time', dir: 'down' } });
        C.report(g.id, { day: '2026-10-10', quote: 'in bed 11:40', measures: [{ name: 'bedtime', value: '23:40', unit: 'time' }] });
        C.report(g.id, { day: '2026-10-11', quote: 'lights out at 11:15', measures: [{ name: 'bedtime', value: '23:15', unit: 'time' }] });
        const p = C.progress(C.get(g.id), C.all(), '2026-10-12');
        eq([p.measure.best, p.measure.toGo], [1395, 15]);
        eq(C.figure(1395, 'time'), '11:15 PM'); eq(C.aimText(p.aim), 'bedtime by 11:00 PM');
    } finally { C.today = realToday; }
}

// ── A money goal: its amount is its aim, its accounts the source of its figure ──
{
    reset();
    const realToday = C.today; C.today = (n) => n === undefined ? '2026-10-12' : realToday.call(C, n);
    let planStore = null;
    const SM = global.StorageManager;
    global.StorageManager = { get: k => (k === C.KEY ? store : k === 'money-plan' ? planStore : null), set: (k, v) => { if (k === C.KEY) store = JSON.parse(JSON.stringify(v)); else if (k === 'money-plan') planStore = JSON.parse(JSON.stringify(v)); } };
    global.Commitments = C; C._inited = true;
    const MP = require('../js/core/money-plan.js');
    try {
        const g = C.create({ title: 'Emergency fund', outcome: '$20,000 set aside', by: '2027-06-01' });
        MP.save({ id: g.id, amount: 20000, title: 'Emergency fund', accounts: ['Savings'] });
        assert.ok(MP.syncAim(g.id));
        eq(C.get(g.id).domain, 'money'); eq(C.get(g.id).aim, { measure: 'saved', target: 20000, unit: '$', dir: 'up' });
        assert.ok(!MP.syncAim(g.id), 'the same amount again writes nothing');
        const t0 = Date.parse('2026-10-01T09:00:00');
        assert.ok(MP.observe(g.id, 10000, '2026-10-01', t0));
        assert.ok(!MP.observe(g.id, 10000.4, '2026-10-01', t0 + 7200000), 'under a dollar is no change');
        assert.ok(!MP.observe(g.id, 10200, '2026-10-01', t0 + 600000), 'at most hourly within a day');
        assert.ok(MP.observe(g.id, 12400, '2026-10-12', t0 + 11 * 86400000));
        const p = C.progress(C.get(g.id), C.all(), '2026-10-12');
        eq(p.measure.points, [{ day: '2026-10-01', value: 10000 }, { day: '2026-10-12', value: 12400 }], 'the accounts\' figure, a point a day');
        eq([p.measure.last.value, p.measure.toGo], [12400, 7600]);
        assert.ok(C.progressLines(p, C.get(g.id)).some(l => l === 'Progress: saved: $12,400 on 2026-10-12, from $10,000 on 2026-10-01, $7,600 to go, 2 readings'), C.progressLines(p, C.get(g.id)).join(' | '));
        eq(C.aimText(p.aim), 'saved $20,000 or more');
        eq(C.get(g.id).log, undefined, 'nothing is written into what the person said');
    } finally { C.today = realToday; global.StorageManager = SM; delete global.Commitments; }
}

console.log('commitment-measures-test: ok');
