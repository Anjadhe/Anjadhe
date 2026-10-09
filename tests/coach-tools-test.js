#!/usr/bin/env node
// The assistant sees a coached goal's whole shape (docs/COACH.md §4,
// 2026-10-09): the commitment tools take domain / aim / until, file figures
// on a report, and return the progress arithmetic with its views.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../js/core/commitments.js');
let store = null;
global.StorageManager = { get: k => (k === C.KEY ? store : null), set: (k, v) => { if (k === C.KEY) store = JSON.parse(JSON.stringify(v)); } };
global.Commitments = C;
global.CoachDomains = require('../js/core/coach-domains.js');
global.FEATURES = { isEnabled: () => true };
const tools = {};
global.AgentTools = { GROUP_INFO: {}, register: (def, handler, opts) => { tools[def.function.name] = { def: def.function, handler, opts }; } };
eval(fs.readFileSync(path.join(__dirname, '../js/agent/commitment-tools.js'), 'utf8'));
const call = (name, args) => tools[name].handler(args, {});
const realToday = C.today; C.today = (n) => n === undefined ? '2026-10-12' : realToday.call(C, n);

try {
    // ── The catalog says what a goal can carry ──
    assert.match(AgentTools.GROUP_INFO.commitments, /coached goals/);
    const props = tools.add_commitment.def.parameters.properties;
    for (const k of ['domain', 'aim_measure', 'aim_target', 'aim_unit', 'aim_direction', 'aim_start', 'until']) assert.ok(props[k], k);
    assert.ok(tools.report_on_commitment.def.parameters.properties.measures);

    // ── The approval shows it as a person would say it ──
    const ask = tools.add_commitment.opts.describe({ title: 'Run a 10K', domain: 'fitness', aim_measure: 'distance', aim_target: '6.2', aim_unit: 'mi', aim_start: '3' });
    assert.match(ask, /Coached as.*Fitness/); assert.match(ask, /Distance 6\.2 mi or more/); assert.match(ask, /Starting from.*3 mi/);

    // ── A goal, a stage, figures from a report ──
    const g = call('add_commitment', { title: 'Run a 10K', outcome: 'Finish the race', by: '2027-03-01', domain: 'fitness', aim_measure: 'distance', aim_target: '6.2', aim_unit: 'mi', aim_start: '3' });
    assert.ok(g.success, JSON.stringify(g));
    assert.strictEqual(g.item.domain, 'fitness'); assert.strictEqual(g.item.aim, 'distance 6.2 mi or more');
    assert.deepStrictEqual(C.get(g.id).aim.from, { value: 3, day: '2026-10-12' });
    const s = call('add_commitment', { title: 'Easy runs', parent: g.id, date: '2026-10-05', repeat: 'weekly', days: ['mon', 'wed', 'fri'], until: '2026-10-18' });
    assert.strictEqual(s.item.until, '2026-10-18'); assert.strictEqual(s.item.domain, 'fitness', 'a step reads its goal\'s domain');

    const r = call('report_on_commitment', { id: s.id, date: '2026-10-09', how: 'done', quote: 'ran 3.5 miles in 34 min', measures: [{ name: 'distance', value: '3.5', unit: 'mi' }, { name: 'duration', value: '34', unit: 'min' }, { name: 'pace', value: '9.7', unit: 'min/mi' }] });
    assert.deepStrictEqual(r.figuresKept, ['distance 3.5 mi', 'duration 34 min']);
    assert.deepStrictEqual(r.figuresRefused.map(x => x.name), ['pace']);
    call('report_on_commitment', { id: s.id, date: '2026-10-07', how: 'done', quote: 'did 5 km', measures: [{ name: 'distance', value: '5', unit: 'km' }] });

    // ── get_commitment: progress, guidance, measure names ──
    const got = call('get_commitment', { id: s.id });
    assert.strictEqual(got.progress.goal, 'Run a 10K');
    assert.strictEqual(got.progress.aim, 'distance 6.2 mi or more by 2027-03-01');
    assert.strictEqual(got.progress.measure.last, '3.5 mi on 2026-10-09');
    assert.strictEqual(got.progress.measure.first, '3 mi on 2026-10-12', 'the start they gave');
    assert.strictEqual(got.progress.measure.toGo, '2.7 mi');
    assert.deepStrictEqual(got.progress.measuresInUse, [{ name: 'distance', unit: 'mi' }, { name: 'duration', unit: 'min' }]);
    assert.ok(got.coaching && /rest day/.test(got.coaching[0]), 'the domain\'s know-how');

    // ── The views draw from that result (AnswerBlocks B1) ──
    const line = tools.get_commitment.opts.views.progress(got);
    assert.strictEqual(line.kind, 'line'); assert.deepStrictEqual(line.points.map(p => p.y), [3.11, 3.5]);
    const nums = tools.get_commitment.opts.views.progress_numbers(got);
    assert.deepStrictEqual(nums.items.map(i => i.label), ['distance now (mi)', 'To go', 'This stage', 'Done so far']);
    assert.strictEqual(tools.get_commitment.opts.views.progress({ id: 'x' }), null, 'nothing to draw: no block');

    // ── plan_outcome asks for what a coached goal still lacks ──
    const plan = call('plan_outcome', { id: g.id });
    assert.ok(plan.missing.some(m => /next stage: "Easy runs" ends 2026-10-18/.test(m)), JSON.stringify(plan.missing));
    assert.match(plan.how, /plan in STAGES/);
    const loose = call('add_commitment', { title: 'Repaint the porch', outcome: 'Done before winter' });
    assert.ok(call('plan_outcome', { id: loose.id }).missing.some(m => /whether this is something to coach/.test(m)));

    // ── Change and clear through the same fields ──
    const ch = call('change_commitment', { id: g.id, aim_target: '6.5' });
    assert.deepStrictEqual(ch.changed, ['aim']); assert.strictEqual(C.get(g.id).aim.target, 6.5); assert.strictEqual(C.get(g.id).aim.from.value, 3, 'the start is kept');
    call('change_commitment', { id: g.id, aim_measure: '' });
    assert.strictEqual(C.get(g.id).aim, null);
    const bed = call('add_commitment', { title: 'In bed by 11', domain: 'health', date: '2026-10-01', repeat: 'daily', aim_measure: 'bedtime', aim_target: '23:00', aim_unit: 'time', aim_direction: 'down' });
    assert.strictEqual(bed.item.aim, 'bedtime by 11:00 PM');
} finally { C.today = realToday; }

console.log('coach-tools: the shape, the approvals, the figures and the progress views passed');

// ── The sheet's progress block and its sentence (docs/COACH.md §6) ──
{
    let step = null, plain = null;
    global.AnswerBlocks = require('../js/components/answer-blocks.js');
    const P = require('../js/apps/commitments/commitments-page.js');
    C.today = (n) => n === undefined ? '2026-10-12' : realToday.call(C, n);
    try {
        const all = C.all();
        const goal = all.find(c => c.title === 'Run a 10K');
        call('change_commitment', { id: goal.id, aim_measure: 'distance', aim_target: '6.2', aim_unit: 'mi' });
        step = all.find(c => c.title === 'Easy runs');
        const html = P.progressHtml(C.get(step.id), '2026-10-12', C.all());
        assert.match(html, /cm-progress/); assert.match(html, /ab-line/, 'the chat\'s own line chart');
        assert.match(html, /data-cm="open" data-id="[^"]+">Run a 10K</, 'a step names its goal, one tap away');
        assert.match(html, /Distance 3\.5 mi \(Fri, Oct 9\), up from 3\.11 mi \(Wed, Oct 7\) · 2\.7 mi to go by /);
        assert.match(html, /This stage: Easy runs, until [^·]+· 2 of 4 done/);
        plain = C.create({ title: 'Buy milk' });
        assert.strictEqual(P.progressHtml(C.get(plain.id), '2026-10-12', C.all()), '', 'nothing coached: no block');
        assert.match(P.factsSummary(C.get(goal.id), '2026-10-12', C.all()), /^Fitness · /, 'the domain word leads the facts');
        const fresh = C.create({ title: 'Read 12 books', domain: 'learning', aim: { measure: 'books', target: 12, unit: '' } });
        assert.match(P.progressHtml(C.get(fresh.id), '2026-10-12', C.all()), /Aiming for books 12 or more\. Tell me a figure below/);
    } finally { C.today = realToday; }
    // The phone gets the same block as data (MobileViews._progress).
    global.Commitments._inited = true;
    global.CommitmentsPage = P;
    const src = fs.readFileSync(path.join(__dirname, '../js/agent/mobile-views.js'), 'utf8');
    const MV = new Function('Commitments', 'CommitmentsPage', 'CoachDomains', src + '\nreturn MobileViews;')(C, P, global.CoachDomains);
    C.today = (n) => n === undefined ? '2026-10-12' : realToday.call(C, n);
    const prog = MV._progress(step.id);
    C.today = realToday;
    assert.strictEqual(prog.goalTitle, 'Run a 10K'); assert.strictEqual(prog.isGoal, false); assert.strictEqual(prog.domain, 'Fitness');
    assert.match(prog.sentence, /^Distance 3\.5 mi \(Fri, Oct 9\), up from 3\.11 mi/);
    assert.match(prog.stage, /^This stage: Easy runs/);
    assert.deepStrictEqual(prog.measure.points.map(x => x.value), [3.11, 3.5]);
    assert.strictEqual(MV._progress(plain.id), null, 'nothing coached: nothing sent');
    console.log('coach-tools: the sheet\'s progress block passed');
}
