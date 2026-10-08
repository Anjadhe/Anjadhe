// WorkPlans (js/core/work-plans.js, 2026-10-02): the facts the assistant is
// shown and the checks on the plan it proposes.
const assert = require('assert');
const W = require('../js/core/work-plans.js');
const NOW = new Date(2026, 9, 2, 18, 0).getTime();   // Fri Oct 2, 6pm
const today = W._iso(new Date(NOW));

const packet = { id: 'p', title: 'Sun, Moon, and Stars project packet', scheduledDate: '2026-10-09' };
const tasks = [packet,
    { id: 'old', title: 'Done thing', scheduledDate: '2026-10-05', lastCompletedDate: '2026-10-01' },
    { id: 'rep', title: 'Piano', scheduledDate: '2026-10-05', repeat: 'daily' },
    { id: 'far', title: 'Tax return', scheduledDate: '2026-11-30' },
    { id: 'sess', title: 'packet: draw', scheduledDate: '2026-10-05', workPlanFor: 'p' },
    { id: 'lunch', title: 'Lunch with Sam', scheduledDate: '2026-10-06', startTime: '12:00', endTime: '13:00' }];
const st = { byTask: {} };
assert.deepEqual(W.candidates(tasks, today, st).map(t => t.id), ['p', 'lunch'], 'open, one-time, due within two weeks, not a session itself');
assert.deepEqual(W.candidates(tasks, today, { byTask: { p: { status: 'declined' } } }).map(t => t.id), ['lunch'], 'Not needed is final');

const events = [{ summary: 'Soccer', start: new Date(2026, 9, 6, 17, 0), end: new Date(2026, 9, 6, 18, 30) }];
const busy = W.busy(events, tasks, NOW, '2026-10-09');
assert.ok(busy.some(b => b.date === '2026-10-06' && b.from === 17 * 60 && b.what === 'Soccer'));
assert.ok(busy.some(b => b.what === 'Lunch with Sam' && b.from === 720 && b.to === 780));

const plan = W.vetPlan({ needs_prep: true, why: 'a poster and a journal', sessions: [
    { date: '2026-10-06', time: '17:30', minutes: 60, what: 'clashes with soccer' },
    { date: '2026-10-06', time: '19:00', minutes: 60, what: 'Start the moon-phase journal' },
    { date: '2026-10-10', time: '19:00', minutes: 60, what: 'after it is due' },
    { date: '2026-10-02', time: '09:00', minutes: 60, what: 'already past' },
    { date: '2026-10-08', time: '19:00', minutes: 600, what: 'too long' },
    { date: '2026-10-08', time: '19:00', minutes: 45, what: 'Finish the poster' }
] }, packet, busy, NOW);
assert.deepEqual(plan.sessions.map(s => s.what), ['Start the moon-phase journal', 'Finish the poster'],
    'sessions that clash with the calendar, fall after the due date or in the past, or are too long are dropped');
assert.deepEqual(W.vetPlan({ needs_prep: false }, packet, busy, NOW), { needsPrep: false });
assert.equal(W.vetPlan({ needs_prep: true, sessions: [] }, packet, busy, NOW), null, 'a plan with no usable session is no plan');

const later = new Date(2026, 9, 7, 9, 0).getTime();
const planned = { byTask: { p: { status: 'planned', title: packet.title, due: packet.scheduledDate, sessionIds: ['s1', 's2'] } } };
const after = [packet, { id: 's1', scheduledDate: '2026-10-06' }, { id: 's2', scheduledDate: '2026-10-08' }];
assert.deepEqual(W.missed(planned, after, later).map(m => m.late), [['s1']], 'a session that passed undone');
assert.deepEqual(W.missed(planned, [{ ...packet, lastCompletedDate: '2026-10-07' }, ...after.slice(1)], later), [], 'nothing to replan once the task is done');
console.log('work-plans: candidates, busy time, plan checks, missed sessions passed');

// Step 5: when they like to work, learned from the sessions they completed.
{
    const s = (time, done = true) => ({ workPlanFor: 'p', startTime: time, lastCompletedDate: done ? '2026-10-05' : null });
    assert.equal(W.learnedPart([s('19:00'), s('20:30')]), null, 'too few to tell');
    assert.equal(W.learnedPart([s('19:00'), s('20:30'), s('18:15'), s('09:00')]), 'evening');
    assert.equal(W.learnedPart([s('19:00'), s('09:00'), s('14:00')]), null, 'no clear habit');
    assert.equal(W.learnedPart([s('19:00'), s('20:00', false), s('21:00', false), s('09:00'), s('14:00')]), null, 'only completed sessions count');
}
console.log('work-plans: learned work time passed');

// A proposal events overtook steps aside (2026-10-02 report).
{
    const r = { at: '2026-10-02T18:00:00Z', due: '2026-10-06' };
    assert.equal(W.changedSince({ scheduledDate: '2026-10-06', modifiedAt: '2026-10-02T17:00:00Z' }, r), false, 'changed before the proposal');
    assert.equal(W.changedSince({ scheduledDate: '2026-10-05', startTime: '18:00', modifiedAt: '2026-10-02T19:00:00Z' }, r), true, 'moved to Monday evening after it');
    assert.equal(W.changedSince({ scheduledDate: '2026-10-06', modifiedAt: '2026-10-02T19:00:00Z' }, r), false, 'a title edit alone does not overtake the plan');
}
console.log('work-plans: stale proposals passed');

// A plan's own chat that made a change handles it (only chats started after the proposal count).
{
    global.AgentService = { conversations: [
        { todayKey: 'plan:a', createdAt: '2026-10-01T00:00:00Z', messages: [{ role: 'assistant', metadata: { records: [{ app: 'schedule' }] } }] },
        { todayKey: 'plan:b', createdAt: '2026-10-03T00:00:00Z', messages: [{ role: 'assistant', metadata: { records: [{ app: 'schedule' }] } }] }] };
    assert.equal(W._chatChanged('plan:a', '2026-10-02T00:00:00Z'), false, 'an older chat does not count');
    assert.equal(W._chatChanged('plan:b', '2026-10-02T00:00:00Z'), true);
    delete global.AgentService;
}
console.log('work-plans: handled in chat passed');

// The assistant suggests, the person decides (2026-10-08): a proposal is never
// scheduled on its own, and the thing's chat sees it as not scheduled.
{
    let stored = { byTask: { t1: { status: 'proposed', due: '2026-10-09', title: 'Fix the reply error', at: '2026-10-08T06:56:09Z',
        plan: { needsPrep: true, why: 'debug and fix', sessions: [{ date: '2026-10-09', time: '08:45', minutes: 60, what: 'Reproduce it' }] } } } };
    global.StorageManager = { get: () => JSON.parse(JSON.stringify(stored)), set: (k, v) => { stored = v; } };
    assert.equal(typeof W._arrange, 'undefined', 'nothing schedules a proposal by itself');
    assert.equal(typeof W.auto, 'undefined');
    const lines = W.proposalLines('t1');
    assert.ok(/NOT scheduled/.test(lines[0]) && /debug and fix/.test(lines[0]), lines[0]);
    assert.equal(lines[1], '- 2026-10-09 08:45, 60 min: Reproduce it');
    assert.deepEqual(W.proposalLines('nope'), []);
    assert.equal(W.noteFor('t1'), null, 'a suggestion is not a scheduled note');
    assert.equal(stored.byTask.t1.status, 'proposed');
    delete global.StorageManager;
}
console.log('work-plans: suggest, never arrange passed');
