// Check-ins (js/core/check-ins.js; AI-native 2026-10-02): the facts the
// assistant is shown, the checks on what it picks, and the daily budget.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/core/check-ins.js'), 'utf8') + '\nthis.CheckIns = CheckIns;', ctx);
const C = ctx.CheckIns;

const now = new Date('2026-10-01T18:00:00');
const daysAgo = n => new Date(now.getTime() - n * 86400000).toISOString();
const iso = n => C._iso(new Date(now.getTime() - n * 86400000));

// The facts: arithmetic only, no thresholds deciding what is worth asking.
const run = { id: 'run', title: 'Morning run', repeat: 'daily', createdAt: daysAgo(30), history: { [iso(2)]: 'done' } };
const standup = { id: 'standup', title: 'Team standup', repeat: 'weekdays', createdAt: daysAgo(60), history: {} };
const old = { id: 'old', title: 'Sort the garage', createdAt: daysAgo(40) };
const subjects = C.subjects({
    tasks: [run, standup, old],
    occursOn: () => true,
    goals: [{ id: 'g', title: 'Kitchen remodel', status: 'not-started', total: 6, done: 1, targetDate: C._iso(new Date(now.getTime() + 10 * 86400000)), createdAt: daysAgo(30), lastUpdate: daysAgo(16) },
        { id: 'done', title: 'Old', status: 'completed', total: 1, done: 1 }],
    facts: [{ id: 'p1', heading: 'plans', text: 'Learn to make bread', createdAt: daysAgo(20) }],
    stale: [{ id: 'm1', text: 'Works at Fernwood' }]
}, now);
const by = s => subjects.find(x => x.subject === s);
// A plan said in a commitment's own chat belongs to that commitment, not to check-ins.
assert.equal(C.subjects({ facts: [{ id: 'p2', heading: 'plans', text: 'Plans to do the workout this evening', convId: 'cv1', createdAt: daysAgo(0) },
    { id: 'p3', heading: 'plans', text: 'Learn to make bread', convId: 'cv2', createdAt: daysAgo(3) }], tiedConvs: new Set(['cv1']) }, now).map(s => s.subject).join(), 'plan:p3');
assert.match(by('habit:run').facts, /due 7 days in the last week, done 1\./);
assert.match(by('habit:standup').facts, /never once marked done/, 'the assistant is told, not filtered by code');
assert.match(by('project:g').facts, /1 of 6 tasks done; target .* \(10 days from today\); started 30 days ago; last update 16 days ago\./);
assert.ok(!by('project:done'), 'a finished project is not a subject');
assert.match(by('plan:p1').facts, /20 days ago: "Learn to make bread"\. Their open projects and tasks: "Kitchen remodel"/);
assert.match(by('lingering:old').facts, /not been touched in 40 days/);
assert.equal(by('memory:m1').kind, 'memory');

// The checks on the assistant's picks.
const idx = s => `S${subjects.findIndex(x => x.subject === s) + 1}`;
const picks = C.vet({ checkins: [
    { subject: idx('habit:run'), title: 'Morning run: 1 of 7 this week', body: 'It slipped this week. Want to find two mornings that work?', offer: 'Plan it', ask: 'Help me fit my morning run in this week; ask before adding anything.' },
    { subject: 'S99', title: 'x', body: 'y' },
    { subject: idx('project:g'), title: 'Kitchen remodel is due in 3 days', body: 'Only 1 of 6 done.' },
    { subject: idx('memory:m1'), title: 'Still at Fernwood?', body: 'You have not mentioned work in a while.', offer: 'Still true', ask: 'ignored' }
] }, subjects);
assert.equal(picks.map(p => p.subject).join(), 'habit:run,memory:m1', 'an unknown subject and a number the facts lack are dropped');
assert.equal(picks[0].prompt, 'Help me fit my morning run in this week; ask before adding anything.');
assert.equal(picks[1].prompt, '', 'a memory check-in opens the editor, never a chat');
assert.equal(C.vet({ checkins: [] }, subjects).length, 0, 'none is a fine answer');
assert.equal(C.vet(null, subjects).length, 0);
assert.equal(C.vet({ checkins: [1, 2, 3].map(() => ({ subject: idx('habit:run'), title: 'a', body: 'b' })) }, subjects).length, 1, 'one card per subject');

// The nudge: once a day, inside the window, never while looking.
{
    const st = { subjects: {}, nudged: '' };
    const cards = [{ subject: 'habit:run', title: 'T', body: 'B' }];
    assert.equal(C.nudgeChoice(cards, st, new Date('2026-10-01T08:00:00')), null, 'before the window');
    assert.equal(C.nudgeChoice(cards, st, new Date('2026-10-01T11:00:00')).subject, 'habit:run');
    assert.equal(C.nudgeChoice(cards, st, new Date('2026-10-01T11:00:00'), { looking: true }), null);
    assert.equal(C.nudgeChoice(cards, { ...st, nudged: '2026-10-01' }, new Date('2026-10-01T11:00:00')), null, 'once a day');
}

// The whole picture (2026-10-05): a plan is read against the person's own
// list, newest first, with when each thing happens and what changed lately.
{
    const data = {
        facts: [{ id: 'p9', heading: 'plans', text: 'Wants the weekly workouts rearranged', createdAt: daysAgo(0) }],
        commitments: [
            { title: 'Old errand', when: 'no date', parent: '', createdAt: daysAgo(90), touchedAt: daysAgo(90) },
            { title: 'Workout A', when: 'repeats weekly on Tue at 08:45, next 2026-10-06', parent: 'Strength base', createdAt: daysAgo(2), touchedAt: daysAgo(0) }
        ],
        changes: [{ at: daysAgo(0), what: 'changed', title: 'Workout A' }]
    };
    const plan = C.subjects(data, now).find(x => x.subject === 'plan:p9');
    assert.equal(plan.facts, 'A plan they told you 0 days ago: "Wants the weekly workouts rearranged".', 'the list is shown once, not per plan');
    const pic = C.picture(data, now);
    assert.ok(pic.indexOf('"Workout A": repeats weekly on Tue at 08:45, next 2026-10-06; part of "Strength base"; made 2 days ago') < pic.indexOf('"Old errand"'), 'most recently touched first');
    assert.match(pic, /WHAT CHANGED ON THAT LIST LATELY\n- today: changed "Workout A"/);
    const many = { commitments: Array.from({ length: 200 }, (_, i) => ({ title: `T${i}`, when: 'no date', touchedAt: daysAgo(i) })) };
    const shown = C.picture(many, now);
    assert.ok(shown.includes('"T0"') && !shown.includes('"T199"'), 'the cap drops the oldest, never the newest');
    assert.equal(C.picture({}, now), '', 'nothing to show, nothing said');
}
console.log('check-ins: facts, checks on the picks, nudge passed');
