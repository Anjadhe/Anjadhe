#!/usr/bin/env node
// Commitments (js/core/commitments.js, docs/COMMITMENTS.md phase 1): the
// facts (dates, recurrence), the one door to change and its checks, Undo,
// and the migration from the old Tasks / Projects stores.
const assert = require('assert');
const C = require('../js/core/commitments.js');
let store = null;
global.StorageManager = { get: k => (k === C.KEY ? store : null), set: (k, v) => { if (k === C.KEY) store = JSON.parse(JSON.stringify(v)); } };
const reset = () => { store = null; C._data = null; };
const eq = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);

// ── Dates and recurrence (C1) ──
{
    assert.equal(C.day('2026-02-30'), null, 'not a real day'); assert.equal(C.day('2026-02-28'), '2026-02-28');
    assert.equal(C.time('9:05'), '09:05'); assert.equal(C.time('24:00'), null);
    const weekly = { when: { date: '2026-10-05' }, repeat: { rule: 'weekly', days: [1, 3] } };   // Mon, Wed
    assert.ok(C.occursOn(weekly, '2026-10-07')); assert.ok(!C.occursOn(weekly, '2026-10-06'));
    assert.ok(!C.occursOn({ ...weekly, when: { date: '2026-10-08' } }, '2026-10-07'), 'never before its start');
    const monthly = { when: { date: '2026-01-31' }, repeat: { rule: 'monthly', days: [] } };
    assert.ok(C.occursOn(monthly, '2026-02-28'), 'the 31st falls on a short month\'s last day');
    assert.ok(C.occursOn({ when: { date: '2024-02-29' }, repeat: { rule: 'yearly', days: [] } }, '2026-02-28'));
    assert.equal(C.nextOn(weekly, '2026-10-08'), '2026-10-12');
    assert.equal(C.nextOn({ when: { date: '2026-11-01' }, repeat: { rule: 'none', days: [] } }, '2026-10-08'), '2026-11-01');
}

// ── The checks on a write ──
{
    const items = { p: { id: 'p', parent: null }, k: { id: 'k', parent: 'p' } };
    const { fields, dropped } = C.vetFields({ title: '  Call  the vet ', when: { date: '2026-02-30' }, repeat: { rule: 'weekly', days: [] },
        parent: 'nope', by: '2026-11-01', state: 'whatever', remind: { minutesBefore: 30, daysBefore: [1, 1, 99] } }, items, null);
    eq(fields.title, 'Call the vet'); assert.equal(fields.by, '2026-11-01'); eq(fields.remind, { minutesBefore: 30, daysBefore: [1] });
    eq(dropped.sort(), ['parent', 'repeat', 'state', 'when'].sort(), 'a bad date, an empty weekly, an unknown parent and a bad state are left out, never guessed');
    eq(C.vetFields({ parent: 'k' }, items, 'p').dropped, ['parent'], 'no cycles');
}

// ── The one door: create, change, resolve, undo, remove ──
{
    reset();
    const p = C.create({ title: 'Run a 10K', outcome: 'Finish the Oct 18 race', by: '2026-10-18' });
    const s = C.create({ title: 'Long run', parent: p.id, when: { date: '2026-10-10', time: '07:00' } });
    assert.ok(p.ok && s.ok); eq(C.children(p.id).map(c => c.id), [s.id]);
    const ch = C.change(s.id, { when: { date: '2026-10-11', time: '07:00' } }, { by: 'assistant' });
    eq(ch.changed, ['when']);
    eq(C.change(s.id, { when: { date: '2026-10-11', time: '07:00' } }).changed, [], 'the same write writes nothing');
    const ledgerBefore = store.ledger.length;
    C.change(s.id, { title: 'Long run' }); assert.equal(store.ledger.length, ledgerBefore, 'no ledger entry for a no-op');
    const done = C.resolve(s.id, 'done', { date: '2026-10-11' });
    assert.equal(C.get(s.id).state, 'done');
    assert.ok(!C.undo(ch.ledgerId).ok, 'a change cannot be undone after a later one');
    assert.ok(C.undo(done.ledgerId).ok); assert.equal(C.get(s.id).state, 'open'); eq(C.get(s.id).history, {}, 'undo restores exactly');
    const habit = C.create({ title: 'Stretch', when: { date: '2026-10-01' }, repeat: { rule: 'daily' } });
    C.resolve(habit.id, 'done', { date: '2026-10-03' });
    assert.equal(C.get(habit.id).state, 'open', 'a repeat stays open'); assert.ok(C.isDone(C.get(habit.id), '2026-10-03')); assert.ok(!C.isDone(C.get(habit.id), '2026-10-04'));
    const rm = C.remove(p.id);
    assert.ok(store.tombstones[p.id], 'removal tombstones'); assert.equal(C.get(s.id).parent, null, 'its steps are kept, a level up');
    C.undo(rm.ledgerId); assert.equal(C.get(s.id).parent, p.id, 'undo puts the project and its steps back');
    assert.ok(!store.tombstones[p.id]);
}

// ── Migration from the old stores (§7) ──
{
    const schedule = { scheduleItems: [
        { id: 't1', title: 'Sign up for the 10K', scheduledDate: '2026-10-05', startTime: '09:00', endTime: '09:30', notifyBefore: 10, repeat: 'none', history: {}, lastCompletedDate: null, tags: ['health'], createdAt: '2026-09-01T00:00:00Z', modifiedAt: '2026-09-02T00:00:00Z' },
        { id: 't2', title: 'Run', scheduledDate: '2026-09-01', repeat: 'custom', repeatDays: [1, 3, 6], startTime: '07:00', history: { '2026-10-01': 'done', '2026-10-02': 'abandoned' } },
        { id: 't3', title: 'Pay water bill', scheduledDate: '2026-10-12', repeat: 'none', lastCompletedDate: '2026-10-02', reminderDaysBefore: [0, 1], source: 'email', sourceEmailId: 'm1', sourceMatterId: 'matter:m1', workSession: null, reminderStrategy: 'due' },
        { id: 't4', title: 'Old thing', repeat: 'none', history: { '2026-09-01': 'abandoned' } },
        { id: 't5', title: 'Weekly review', repeat: 'weekly', dayOfWeek: 0, scheduledDate: '2026-09-07' },
        { id: 'g1', title: 'clash with a project id' }
    ] };
    const goals = { goals: [
        { id: 'g1', title: 'Run a 10K', description: 'Finish the race in under an hour', why: 'Health', obstacles: 'Knees', group: 'Health', targetDate: '2026-10-18', status: 'not-started', createdAt: '2026-08-01T00:00:00Z' },
        { id: 'g2', title: 'Old project', status: 'completed', completedAt: '2026-07-01T10:00:00Z' },
        { id: 'g3', title: 'Half-planned', status: 'draft' }
    ] };
    const links = { links: [
        { sourceApp: 'schedule', sourceId: 't1', targetApp: 'goals', targetId: 'g1' },
        { sourceApp: 'goals', sourceId: 'g1', targetApp: 'schedule', targetId: 't2' },
        { sourceApp: 'schedule', sourceId: 't2', targetApp: 'goals', targetId: 'g2' },
        { sourceApp: 'notes', sourceId: 'n1', targetApp: 'goals', targetId: 'g1' }
    ] };
    const { items, report } = C.migrate(schedule, goals, links);
    const by = Object.fromEntries(items.map(c => [c.id, c]));
    assert.equal(items.length, 8); eq(report.idClashes, ['g1'], 'a clashing id is reported, not overwritten');
    assert.equal(report.linked, 2); eq(report.extraLinks, [{ task: 't2', project: 'g2' }]);
    eq(by.t1.when, { date: '2026-10-05', time: '09:00', end: '09:30' }); assert.equal(by.t1.parent, 'g1'); eq(by.t1.remind, { minutesBefore: 10, daysBefore: [] });
    eq(by.t2.repeat, { rule: 'custom', days: [1, 3, 6] }); eq(by.t2.history, { '2026-10-01': 'done', '2026-10-02': 'dropped' }); assert.equal(by.t2.state, 'open');
    assert.equal(by.t3.state, 'done'); eq(by.t3.history, { '2026-10-02': 'done' }); eq(by.t3.origin, { kind: 'matter', ref: 'matter:m1' });
    eq(by.t3.remind, { minutesBefore: null, daysBefore: [1] }); eq(by.t3.legacy, { reminderStrategy: 'due' }, 'unknown fields are kept, not lost');
    assert.equal(by.t4.state, 'dropped'); assert.equal(by.t4.when, null);
    eq(by.t5.repeat, { rule: 'weekly', days: [0] });
    assert.equal(by.g1.outcome, 'Finish the race in under an hour'); assert.equal(by.g1.by, '2026-10-18');
    assert.equal(by.g1.note, 'Why: Health\n\nObstacles: Knees'); eq(by.g1.tags, ['Health']);
    assert.equal(by.g2.state, 'done'); eq(by.g2.history, { '2026-07-01': 'done' }); assert.ok(by.g3.legacy.draft);
    // Every migrated record passes the same checks a write would.
    for (const c of items) {
        const { dropped } = C.vetFields({ title: c.title, when: c.when, by: c.by, repeat: c.repeat, remind: c.remind, state: c.state }, by, c.id);
        eq(dropped, [], `${c.id} is well-formed`);
    }
}
console.log('commitments: dates, recurrence, checks, the one door, undo, migration passed');

// ── Phase 2: capture's checks, and what goes where on the page ──
{
    const items = { g: { id: 'g', title: 'Run a 10K', outcome: 'race', parent: null } };
    const parents = [items.g];
    const NOW = Date.parse('2026-10-03T10:00:00');
    const out = C.vetCapture({ items: [
        { title: 'Buy race shoes', date: '2026-10-06', time: '17:00', parent: 'P1', repeat: 'none' },
        { title: 'Stretch', repeat: 'weekly', days: [1, 4] },
        { title: 'Call the vet', date: '2026-02-30', parent: 'P9', repeat: 'whatever' },
        { title: '   ' }
    ] }, parents, items, null, NOW);
    assert.equal(out.length, 3, 'an empty title is not a commitment');
    assert.equal(out[0].fields.parent, 'g'); assert.equal(out[0].parentTitle, 'Run a 10K'); eq(out[0].fields.when, { date: '2026-10-06', time: '17:00', end: null });
    eq(out[1].fields.repeat, { rule: 'weekly', days: [1, 4] }); assert.equal(out[1].fields.when.date, '2026-10-05', 'a repeat with no date starts on its next day (Mon)');
    assert.ok(out[2].dropped.includes('when'), 'Feb 30 is left out, never guessed');
    assert.equal(out[2].fields.parent, null, 'a parent it was not shown is not used');
    eq(out[2].fields.repeat, { rule: 'none', days: [] });
    eq(C.vetCapture({ items: [{ title: 'Step', parent: 'P1' }] }, [], items, 'g', NOW)[0].fields.parent, 'g', 'a step added on a sheet keeps that parent');

    // The page's box may also propose a change to one it was shown (2026-10-04).
    const its = {
        a: { ...C.blank('a', ''), title: 'Call the dentist', when: { date: '2026-10-06', time: '15:00', end: null } },
        b: { ...C.blank('b', ''), title: 'Renew passport' }
    };
    const shown = [{ id: 'a' }, { id: 'b' }];
    const ch = C.vetCaptureChanges({ changes: [
        { ref: 'C1', do: 'change', date: '2026-10-09' },
        { ref: 'C2', do: 'done' },
        { ref: 'C7', do: 'done' },
        { ref: 'C1', do: 'drop' },
        { ref: 'C2', do: 'explode' }
    ] }, shown, its, NOW);
    assert.equal(ch.length, 2, 'only ones it was shown, one change each, known verbs only');
    eq(ch[0].fields.when, { date: '2026-10-09', time: '15:00', end: null }); assert.equal(ch[0].kind, 'change', 'a move keeps the time');
    assert.equal(ch[1].op, 'done'); assert.equal(ch[1].id, 'b');
    eq(C.vetCaptureChanges({ changes: [{ ref: 'C1', do: 'change', date: '2026-10-06' }] }, shown, its, NOW), [], 'a change that changes nothing is not proposed');
    eq(C.vetCaptureChanges({ changes: [{ ref: 'C1', do: 'change', date: '2026-02-30' }] }, shown, its, NOW), [], 'a bad date is never a move');
    eq(C.vetCaptureChanges({ changes: [{ ref: 'C2', do: 'someday' }] }, shown, its, NOW), [], 'someday is retired (2026-10-06): not a verb the capture knows');

    global.Commitments = C;
    const P = require('../js/apps/commitments/commitments-page.js');
    const today = '2026-10-03';
    const mk = (id, x) => ({ ...C.blank(id, '2026-09-01T00:00:00Z'), title: id, ...x });
    const all = [
        mk('big', { outcome: 'race', by: '2026-10-18' }),
        mk('step-today', { parent: 'big', when: { date: '2026-10-03', time: '07:00' } }),
        mk('step-later', { parent: 'big', when: { date: '2026-10-09' } }),
        mk('late', { when: { date: '2026-10-01' } }),
        mk('habit', { when: { date: '2026-09-01' }, repeat: { rule: 'daily', days: [] } }),
        mk('habit-done', { when: { date: '2026-09-01' }, repeat: { rule: 'daily', days: [] }, history: { '2026-10-03': 'done' } }),
        mk('waits', { waitingOn: { who: 'Dana', since: '2026-10-01' } }),
        mk('loose', { when: { date: '2026-10-20' } }),
        mk('finished', { state: 'done', doneAt: '2026-10-02T10:00:00Z' })
    ];
    const s = P.sections(all, today);
    eq(s.today.map(c => c.id), ['late', 'step-today', 'habit'], 'overdue first, then by time; a step due today comes to Today; a habit done today leaves');
    eq(s.moving.map(c => c.id), ['big']); eq(s.waiting.map(c => c.id), ['waits']);
    eq(s.later.map(c => c.id), ['habit-done', 'loose'], 'a step of an open big one lives under it, not in Later; a habit done today is next due tomorrow');
    assert.ok(!('someday' in s), 'no Someday section'); eq(s.done.map(c => c.id), ['finished']);
    assert.equal(P.line(s, today), '3 for today, 1 overdue, 1 bigger one moving, 1 waiting on others.');
}
console.log('commitments: capture checks and the page sections passed');

// ── Phase 3: the read and its checks ──
{
    const today = '2026-10-03';
    const mk = (id, x) => ({ ...C.blank(id, '2026-09-01T00:00:00Z'), title: id, ...x });
    const goal = mk('goal', { outcome: 'Finish the race', by: '2026-10-18' });
    const step = mk('step', { parent: 'goal', when: { date: '2026-09-28' } });
    const waits = mk('waits', { waitingOn: { who: 'Dana', since: '2026-09-20' } });
    const habit = mk('habit', { when: { date: '2026-09-01' }, repeat: { rule: 'daily', days: [] }, history: { '2026-10-02': 'done' } });
    const all = [goal, step, waits, habit];
    // What may be offered depends on the facts.
    assert.ok(C.allowedOffers(waits, all).includes('follow_up')); assert.ok(!C.allowedOffers(step, all).includes('follow_up'));
    assert.ok(C.allowedOffers(goal, all).includes('plan')); assert.ok(!C.allowedOffers(habit, all).includes('move'), 'a habit is not moved');
    const f = C.readFacts(step, all, today);
    assert.equal(f.status, 'overdue'); assert.equal(f.partOf, 'goal');
    assert.equal(C.readFacts(habit, all, today).last14Days, '1 marked done, 13 not marked, 0 skipped of 14 due', 'an unticked day is not marked, never missed');
    assert.equal(C.readFacts(habit, all, today).everMarked, '1 marked done of 32 since it began');
    assert.ok(!C.allowedOffers(habit, all).includes('plan'), 'a plain repeat has nothing to plan');
    eq(C.readFacts(goal, all, today).steps, '0 done, 1 open');
    eq(C.readFacts(goal, all, today).openSteps, ['step on 2026-09-28'], 'the steps themselves are shown, not just a count');
    {
        const ahead = mk('ahead', { parent: 'g2', when: { date: '2026-10-10' } });
        const g2 = mk('g2', { outcome: 'x' });
        assert.ok(!C.allowedOffers(g2, [g2, ahead], today).includes('plan'), 'every open step on a day ahead: nothing to plan');
        assert.ok(C.allowedOffers(g2, [g2, { ...ahead, when: null }], today).includes('plan'), 'an undated step: planning may be offered');
    }
    // Everything is due for a first read; a read stays until its facts change or its day comes.
    eq(C.dueForRead(all, today).length, 4);
    const batch = [step, waits, goal];
    const reads = C.vetReads({ reads: [
        { id: 'C1', stance: 'slipping', why: 'It was due Sep 28, 11 days ago.', offer: { kind: 'move', date: '2026-10-05', label: 'Move to Monday' }, look_again_days: 2 },
        { id: 'C2', stance: 'waiting', why: 'Dana has had it since Sep 20.', offer: { kind: 'follow_up' }, look_again_days: 90 },
        { id: 'C3', stance: 'fine', why: '', offer: { kind: 'follow_up' } },
        { id: 'C9', stance: 'stuck' }, { id: 'C1', stance: 'drop?' }
    ] }, batch, all, today);
    eq(Object.keys(reads).sort(), ['goal', 'step', 'waits'], 'an id it was not shown is ignored, and so is a second read of one');
    assert.equal(reads.step.why, '', 'a wrong number (11 days; it is 5) drops the why');
    assert.equal(C.vetReads({ reads: [{ id: 'C1', stance: 'slipping', why: 'It was due Sep 28, 5 days ago.' }] }, batch, all, today).step.why, 'It was due Sep 28, 5 days ago.', 'a true distance is a fact');
    eq(reads.step.offer, { kind: 'move', date: '2026-10-05', label: 'Move to Monday' }); assert.equal(reads.step.next, '2026-10-05');
    assert.equal(reads.waits.why, 'Dana has had it since Sep 20.'); assert.equal(reads.waits.next, '2026-11-02', 'look again at most 30 days out');
    assert.equal(reads.goal.offer, null, 'an offer this one may not make is dropped');
    assert.equal(C.vetReads({ reads: [{ id: 'C1', stance: 'slipping', offer: { kind: 'move', date: '2026-09-30' } }] }, batch, all, today).step.offer, null, 'a move into the past is dropped');
    step.read = { ...reads.step, fp: C.readFp(step, all, today) };
    assert.ok(C.shownRead(step, all, today));
    assert.ok(!C.dueForRead(all, today).includes(step), 'read and unchanged: not read again yet');
    step.when = { date: '2026-10-04' };
    assert.equal(C.shownRead(step, all, today), null, 'once its facts change the old read is not shown');
    assert.ok(C.dueForRead(all, today).includes(step));
}
console.log('commitments: the read and its checks passed');

// ── Phase 4: the bridge (projection out, import in) ──
{
    const schedule = { scheduleItems: [
        { id: 't1', title: 'Sign up', scheduledDate: '2026-10-05', startTime: '09:00', endTime: '09:30', notifyBefore: 10, repeat: 'none', history: {}, lastCompletedDate: null, tags: ['health'], reminderDaysBefore: [0, 1], createdAt: '2026-09-01T00:00:00Z', modifiedAt: '2026-09-02T00:00:00Z' },
        { id: 't2', title: 'Run', scheduledDate: '2026-09-01', repeat: 'custom', repeatDays: [1, 3, 6], startTime: '07:00', history: { '2026-10-01': 'done', '2026-10-02': 'abandoned' }, lastCompletedDate: '2026-10-01' },
        { id: 't3', title: 'Pay water bill', scheduledDate: '2026-10-12', repeat: 'none', lastCompletedDate: '2026-10-02', history: { '2026-10-02': 'done' }, sourceMatterId: 'matter:m1', reminderStrategy: 'due' },
        { id: 't5', title: 'Weekly review', repeat: 'weekly', dayOfWeek: 0, scheduledDate: '2026-09-07', timerStartedAt: null, totalTimeSpent: 120000 },
        { id: 't6', title: 'From mail', source: 'email', sourceEmailId: 'e9', sourceEmailSubject: 'Hi', scheduledDate: '2026-10-08', repeat: 'none' }
    ], emailActionLedger: { e1: 1 } };
    const goals = { goals: [{ id: 'g1', title: 'Run a 10K', description: 'Under an hour', targetDate: '2026-10-18', status: 'not-started', group: 'Health', createdAt: '2026-08-01T00:00:00Z' },
        { id: 'g3', title: 'Half-planned', status: 'draft' }] };
    const links = { links: [{ id: 'L1', sourceApp: 'schedule', sourceId: 't1', targetApp: 'goals', targetId: 'g1' }, { id: 'N1', sourceApp: 'notes', sourceId: 'n1', targetApp: 'goals', targetId: 'g1' }] };
    const { items: list } = C.migrate(schedule, goals, links);
    const items = Object.fromEntries(list.map(c => [c.id, c]));
    const p = C.projection(items, { schedule, goals, links });
    assert.equal(p.schedule.emailActionLedger.e1, 1, 'other fields of the old blob are kept');
    eq(p.links.links.map(l => l.id).sort(), ['L1', 'N1'], 'other links kept; the project link kept as it was');
    const none = C.importDiff(items, p.schedule, p.goals, p.links);
    eq([none.creates.length, none.updates.length, none.removes.length], [0, 0, 0], 'projection then import changes nothing (no churn)');
    const t1 = p.schedule.scheduleItems.find(t => t.id === 't1');
    eq([t1.scheduledDate, t1.startTime, t1.endTime, t1.notifyBefore, t1.reminderDaysBefore], ['2026-10-05', '09:00', '09:30', 10, [0, 1]]);
    const t2 = p.schedule.scheduleItems.find(t => t.id === 't2');
    eq([t2.repeat, t2.repeatDays, t2.history['2026-10-02'], t2.lastCompletedDate], ['custom', [1, 3, 6], 'abandoned', '2026-10-01']);
    eq(p.schedule.scheduleItems.find(t => t.id === 't5').repeat, 'weekly'); assert.equal(p.schedule.scheduleItems.find(t => t.id === 't5').dayOfWeek, 0);
    assert.equal(p.schedule.scheduleItems.find(t => t.id === 't3').reminderStrategy, 'due', 'legacy fields go back out');
    eq(p.goals.goals.map(g => g.status), ['not-started', 'draft']);

    // Old writers' edits come in as exactly those changes.
    const s2 = JSON.parse(JSON.stringify(p.schedule));
    s2.scheduleItems.find(t => t.id === 't6').lastCompletedDate = '2026-10-03';
    s2.scheduleItems.find(t => t.id === 't6').history = { '2026-10-03': 'done' };
    s2.scheduleItems.find(t => t.id === 't1').title = 'Sign up for the 10K';
    s2.scheduleItems = s2.scheduleItems.filter(t => t.id !== 't5');
    s2.scheduleItems.push({ id: 't9', title: 'New from Apple', repeat: 'none', scheduledDate: '2026-10-20', sourceReminderId: 'r9' });
    const g2 = JSON.parse(JSON.stringify(p.goals)); g2.goals.find(g => g.id === 'g1').status = 'completed';
    const l2 = { links: [...p.links.links, { id: 'L2', sourceApp: 'goals', sourceId: 'g1', targetApp: 'schedule', targetId: 't6' }] };
    const d = C.importDiff(items, s2, g2, l2);
    eq(d.creates.map(c => [c.id, c.shape, c.origin.kind]), [['t9', 'task', 'apple']]);
    eq(d.removes, ['t5']);
    const up = Object.fromEntries(d.updates.map(u => [u.id, u.fields]));
    eq(Object.keys(up).sort(), ['g1', 't1', 't6']);
    eq(up.t1, { title: 'Sign up for the 10K' }); assert.equal(up.t6.state, 'done'); assert.equal(up.t6.parent, 'g1'); assert.ok(up.t6.doneAt);
    assert.equal(up.g1.state, 'done');
    // A blob that was not given is not read as "everything removed".
    eq(C.importDiff(items, p.schedule, null, p.links).removes, []);
    // A step nested under a task (the page can) keeps its parent: no link exists in the old world for it.
    items.t6.parent = 't1';
    assert.ok(!C.importDiff(items, C.projection(items, { schedule, goals, links }).schedule, p.goals, C.projection(items, { schedule, goals, links }).links).updates.some(u => u.id === 't6'));
}
// Someday retired (2026-10-06): a row an older writer parked comes back as itself, open; the state is never written again.
{
    const c = { ...C.blank('s1', '2026-09-01T00:00:00Z'), title: 'Once parked', shape: 'task', state: 'open', when: { date: '2025-02-01', time: '09:00', end: null }, repeat: { rule: 'weekly', days: [1] } };
    const t = C.toTask(c);
    assert.ok(!t.someday && !t.somedayHold && t.scheduledDate === '2025-02-01' && t.repeat === 'weekly', 'the old shape carries the real day and repeat, no parked flag');
    assert.ok(!C.STATES.includes('someday'));
    assert.deepEqual(C.vetFields({ state: 'someday' }, {}, null, Date.now()).dropped, ['state'], 'someday is not a state the door accepts');
    // A row parked by an older writer (phone, old blob) is un-parked with the day and repeat it held.
    const imp = C.fromTask({ id: 'r1', title: 'Old reminder', scheduledDate: '', startTime: '', repeat: 'none', someday: true, somedayHold: { scheduledDate: '2025-02-01', startTime: '', endTime: '', repeat: 'none', dayOfWeek: null, repeatDays: [], reminderDaysBefore: [0] }, sourceReminderId: 'EXT-1' });
    assert.equal(imp.state, 'open'); assert.equal(imp.when.date, '2025-02-01'); assert.ok(!imp.legacy || !imp.legacy.someday);
}
console.log('commitments: the bridge round trip and imports passed');

// Where a commitment stands, said both ways (2026-10-05): the chat that
// answered "It's set for 9:00 AM tomorrow" was looking at a day-old "tomorrow".
{
    const c = { id: 'w1', title: 'Log weight and waist', state: 'open', when: { date: '2026-10-05', time: '09:00', end: null }, repeat: { rule: 'none', days: [] }, history: {} };
    const on = (today) => Commitments.standing(c, today).join('\n');
    assert.ok(/When: Monday, October 5 \(2026-10-05\), which is tomorrow at 09:00/.test(on('2026-10-04')));
    assert.ok(/which is today at 09:00/.test(on('2026-10-05')));
    assert.ok(/which is yesterday/.test(on('2026-10-06')) && /Status: open, overdue/.test(on('2026-10-06')));
    const r = { ...c, repeat: { rule: 'weekly', days: [1] } };
    assert.ok(/Repeats: weekly on Mon at 09:00/.test(Commitments.standing(r, '2026-10-06').join('\n')));
    assert.ok(/Next time: Monday, October 12 \(2026-10-12\), which is in 6 days/.test(Commitments.standing(r, '2026-10-06').join('\n')));
    console.log('commitments: where it stands passed');
}

// ── One day at another time, that day only (moveDay, 2026-10-05) ──
{
    reset();
    const today = C.today();
    const w = C.create({ title: 'Workout B', when: { date: '2026-06-01', time: '08:45', end: '09:45' }, repeat: { rule: 'daily', days: [] } });
    const tomorrow = C.iso(new Date(new Date(`${today}T12:00:00`).getTime() + 86400000));
    const m = C.moveDay(w.id, { day: today, time: '18:30' });
    assert.ok(m.ok && m.ledgerId); eq([m.time, m.end, m.moved], ['18:30', '19:30', true], 'the usual length is kept');
    const c = C.get(w.id);
    eq(c.when, { date: '2026-06-01', time: '08:45', end: '09:45' }, 'the repeat and its usual time are untouched');
    eq(C.timeOn(c, today), { time: '18:30', end: '19:30', moved: true });
    eq(C.timeOn(c, tomorrow), { time: '08:45', end: '09:45', moved: false }, 'every other day keeps the usual time');
    assert.ok(/Next time: .* at 18:30 to 19:30 \(moved for that day only/.test(C.standing(c, today).join('\n')));
    assert.ok(/at 08:45 to 09:45 \(the usual time/.test(C.standing(c, today).join('\n')));
    eq(C.readFacts(c, [c], today).movedDays, [`${today} at 18:30, that day only`]);
    eq(C.moveDay(w.id, { day: today, time: '18:30' }).changed, [], 'the same again writes nothing');
    assert.ok(!C.moveDay(w.id, { day: '2020-01-01', time: '10:00' }).ok, 'a past day');
    assert.ok(!C.moveDay(w.id, { day: today, time: '25:00' }).ok, 'a bad time');
    const once = C.create({ title: 'Dentist', when: { date: tomorrow, time: '11:00' } });
    assert.ok(!C.moveDay(once.id, { time: '12:00' }).ok, 'only a repeat has days');

    // The old blobs show the day's own time while it is that day, and the
    // bridge never takes that back in as a new usual time.
    eq([C.toTask(c, today).startTime, C.toTask(c, today).endTime], ['18:30', '19:30']);
    eq([C.toTask(c, tomorrow).startTime, C.toTask(c, tomorrow).endTime], ['08:45', '09:45']);
    const echo = C.importDiff({ [c.id]: c }, { scheduleItems: [C.toTask(c, today)] }, null, null, today);
    eq(echo.updates, [], 'its own projection is not an edit');
    eq(C.importDiff({ [c.id]: c }, { scheduleItems: [C.toTask(c, today)] }, null, null, tomorrow).updates, [], 'nor just after midnight');
    const real = C.importDiff({ [c.id]: c }, { scheduleItems: [{ ...C.toTask(c, today), startTime: '07:00', endTime: '08:00' }] }, null, null, today);
    eq(real.updates[0].fields.when, { date: '2026-06-01', time: '07:00', end: '08:00' }, 'a real edit in the old shape still comes in');

    // Undo, and the usual time said again clears the day.
    assert.ok(C.undo(m.ledgerId).ok); assert.ok(!C.get(w.id).moved, 'Undo takes the day back');
    C.moveDay(w.id, { day: today, time: '18:30', end: '19:00' });
    eq(C.get(w.id).moved[today], { time: '18:30', end: '19:00' });
    assert.ok(C.moveDay(w.id, { day: today, time: '' }).ok); assert.ok(!C.get(w.id).moved, 'back to its usual time');
    C.moveDay(w.id, { day: today, time: '08:45' }); assert.ok(!C.get(w.id).moved, 'the usual time is no exception');

    // A plan for later that day is kept as words, flagged.
    const r = C.report(w.id, { day: today, quote: 'will do it this evening', plan: true });
    assert.ok(r.ok); eq(C.get(w.id).log[today].map(e => !!e.plan), [true]);
    assert.ok(/their plan for later that day/.test(C.readFacts(C.get(w.id), C.all(), today).saidOnDays[0]));
    console.log('commitments: one day at another time passed');
}

// ── Attached: files, text documents, links (2026-10-08) ──
{
    reset();
    const v = C.vetFields({ attached: [{ id: 'd1', title: ' Lease  2026.pdf ' }, { kind: 'file', id: 'd1', title: 'again' }, { kind: 'note', id: 'd1', title: 'Notes on it' },
        { kind: 'link', id: 'notion.so/acme/Lease-renewal-3f2a9c0e1b2d4e5f6a7b8c9d0e1f2a3b' }, { kind: 'link', id: 'javascript:alert(1)' }, { title: 'no id' }, null] }, {}, null);
    eq(v.fields.attached, [{ kind: 'file', id: 'd1', title: 'Lease 2026.pdf' }, { kind: 'note', id: 'd1', title: 'Notes on it' },
        { kind: 'link', id: 'https://notion.so/acme/Lease-renewal-3f2a9c0e1b2d4e5f6a7b8c9d0e1f2a3b', title: 'Lease renewal' }],
        'a file by default, once per kind and id, a pasted link made https and named from its slug, a script URL and rows without an id left out');
    assert.equal(C.linkUrl('see notion'), null); assert.equal(C.linkUrl('ftp://x.com/a'), null); assert.equal(C.linkUrl('https://localhost'), null);
    assert.equal(C.linkTitle('https://docs.google.com/document/d/1AbCdEf9GhIjK2lMnOp/edit'), 'docs.google.com', 'an id-only path falls back to the host');
    assert.equal(C.linkTitle('https://www.example.com/'), 'example.com');

    const r = C.create({ title: 'Renew the lease' });
    const a = C.change(r.id, { attached: [{ kind: 'file', id: 'd1', title: 'Lease 2026.pdf' }, { kind: 'note', id: 'n1', title: 'Questions' }, { kind: 'link', id: 'https://notion.so/x/Plan-0123456789abcdef0123456789abcdef' }] });
    assert.ok(a.ok && a.ledgerId); eq(a.changed, ['attached']);
    eq(C.change(r.id, { attached: C.get(r.id).attached }).changed, [], 'the same list again writes nothing');
    const said = C.standing(C.get(r.id)).join('\n');
    assert.ok(/read_library_doc docId d1/.test(said) && /get_note id n1/.test(said) && /read_url/.test(said), 'the assistant is told what is attached and how to read each');
    assert.ok(C.undo(a.ledgerId).ok); assert.ok(!(C.get(r.id).attached || []).length, 'Undo takes it back');
    assert.ok(!/Attached to it/.test(C.standing(C.get(r.id)).join('\n')), 'nothing said when nothing is attached');

    const P = require('../js/apps/commitments/commitments-page.js');
    global.Commitments = C;
    const rows = [{ key: 'document', ref: 'd1', title: 'Lease 2026.pdf', at: 3, fileKind: 'PDF' }, { key: 'note', ref: 'n1', title: 'Lease questions', at: 5 },
        { key: 'document', ref: 'd3', title: 'Lease 2025.pdf', at: 1, fileKind: 'PDF' }];
    eq(P.attachPicks(rows, [{ kind: 'file', id: 'd1' }], 'lease').items.map(x => `${x.kind}:${x.id}`), ['note:n1', 'file:d3'], 'files and text documents together, attached ones not offered, newest first');
    eq(P.attachPicks(rows, [], 'lease 2025').items.map(x => x.id), ['d3'], 'every word must match');
    const l = P.attachPicks(rows, [], 'https://www.notion.so/Team-notes-0123456789abcdef0123456789abcdef');
    eq([l.link.title, l.items.length], ['Team notes', 0], 'a pasted link is offered as a link');
    assert.ok(P.attachPicks(rows, [{ kind: 'link', id: l.link.url }], l.link.url).link.attached, 'an attached link is said to be attached');
    console.log('commitments: attached passed');
}

// ── What they said in its chat carries the day it was said (2026-10-08) ──
{
    reset();
    const today = C.today();
    const yday = C.iso(new Date(Date.parse(`${today}T12:00:00`) - 86400000));
    const r = C.create({ title: 'Fix replying to a text', when: { date: today } });
    global.AgentService = { conversations: [{ id: 'v', todayKey: `task:${r.id}`, createdAt: `${yday}T09:00:00`, messages: [
        { role: 'user', content: 'lets do it tomorrow', timestamp: `${yday}T18:00:00` },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'no stamp here' }] }] };
    C._saidMemo = null;
    const c = C.get(r.id);
    eq(C.readFacts(c, C.all(), today, { relative: true }).theySaid, [`${yday} (yesterday): "lets do it tomorrow"`, '"no stamp here"'], 'each line says the day it was said, and how long ago for the prompt');
    eq(C.readFacts(c, C.all(), today).theySaid, [`${yday}: "lets do it tomorrow"`, '"no stamp here"'], 'the fingerprint keeps only the date, so it does not change every day');
    assert.ok(/counted from the day it was said/.test(C._readPrompt([c], C.all(), today, [])), 'the prompt says how to read "tomorrow"');
    // nenva's own replies are part of the latest word (2026-10-09): the
    // sheet's line went stale when a reply settled something.
    eq(C.readFacts(c, C.all(), today).youSaid, ['"ok"'], 'what nenva said in its chat is a fact the read sees');
    const d = C._load().items[r.id];
    d.read = { stance: 'slipping', why: 'It is due today.', offer: { kind: 'move', date: today, label: 'Move it' }, fp: C.readFp(d, C.all(), today), at: new Date().toISOString() };
    assert.ok(C.shownRead(d, C.all(), today), 'shown while nothing moved');
    global.AgentService.conversations[0].messages.push({ role: 'assistant', content: 'Done: moved to Friday.', timestamp: `${today}T10:00:00` });
    C._saidMemo = null;
    assert.strictEqual(C.shownRead(d, C.all(), today), null, 'a reply that settles it hides the old suggestion until it is read again');
    assert.ok(/Never offer again what that conversation already settled/.test(C._readPrompt([c], C.all(), today, [])));
    delete global.AgentService; C._saidMemo = null;
    console.log('commitments: dated chat lines passed');
}
