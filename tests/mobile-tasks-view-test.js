// The Tasks views the phone asks the Mac for (js/agent/mobile-views.js,
// 2026-09-22 — docs/MOBILE_NATIVE.md "M3.3").
//
// The phone's Tasks screen used to be a Swift reimplementation over the synced
// blob: its own grouping, its own "due today", its own overdue. This is the
// contract that replaced it, and what must hold:
//   1. the groups, rows, counts and scopes are the DESKTOP's own accessors —
//      the phone does no date arithmetic, so the two cannot drift;
//   2. both nav dimensions cross together: "this week, tagged home" is ONE
//      scoped request, not a filter the phone applies afterwards;
//   3. a write states a DIRECTION and the Mac decides — a stale row on the
//      phone can never flip a task the wrong way;
//   4. a phone's tick is quiet on the Mac: no confetti, no Undo toast for a
//      gesture that happened somewhere else;
//   5. a served list writes only what it shows a control for — the checkbox.
//      A task's substance stays in the phone's own offline editor.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const viewsSource = fs.readFileSync(path.join(__dirname, '../js/agent/mobile-views.js'), 'utf8');
const dom = new JSDOM('<body></body>', { url: 'https://local.test', runScripts: 'outside-only' });
const w = dom.window;

const TODAY = '2026-09-22';
const calls = [];
const items = [
    { id: 't1', title: 'Pay the invoice', scheduledDate: '2026-09-20', repeat: 'none', tags: ['money'], description: 'Acme 4471' },
    { id: 't2', title: 'Standup', scheduledDate: TODAY, startTime: '09:00', repeat: 'weekdays', tags: [] },
    { id: 't3', title: 'Call the dentist', scheduledDate: TODAY, repeat: 'none', tags: ['home'], lastCompletedDate: TODAY },
    { id: 't4', title: 'Book the flights', scheduledDate: '2026-10-30', repeat: 'none', tags: ['home'] },
    { id: 't5', title: 'Someday: learn Swift', scheduledDate: '', repeat: 'none', tags: [] },
];
const byId = (id) => items.find((i) => i.id === id);

w.TaskListUI = {
    isCompleted: (i) => !!i.lastCompletedDate,
    isAbandoned: () => false,
};
w.ScheduleApp = {
    scheduleItems: items,
    getLocalToday: () => TODAY,
    isCompletedToday: (i) => i.lastCompletedDate === TODAY,
    isDone(i) { return (!i.repeat || i.repeat === 'none') ? !!i.lastCompletedDate : this.isCompletedToday(i); },
    messageSourceKind: (i) => (i.id === 't1' ? 'email' : null),
    buildTaskLinkIndex: () => ({ taskGoals: new Map([['t4', new Set(['g1'])]]) }),
    getGroupedItems() {
        calls.push('getGroupedItems');
        return { overdue: [byId('t1')], todayActive: [byId('t2')], todayCompleted: [byId('t3')],
                 tomorrow: [], later: [byId('t4')], noDate: [byId('t5')] };
    },
    toggleComplete(id, opts) { calls.push('toggleComplete:' + id + ':' + (opts && opts.quiet ? 'quiet' : 'loud')); const i = byId(id); i.lastCompletedDate = i.lastCompletedDate ? null : TODAY; },
    createTask(f) { calls.push('createTask'); const id = 'new1'; items.push({ id, ...f, repeat: 'none', tags: [] }); return { id }; },
    loadData() { calls.push('loadData'); },
};
w.ActionsApp = {
    _allGoals: () => [{ id: 'g1', title: 'Japan trip', group: 'Travel' }],
    groupPredicateFor(f) {
        calls.push('groupPredicateFor:' + f);
        if (!f) return null;
        if (f.startsWith('t:')) return (i) => (i.tags || []).includes(f.slice(2));
        if (f === 'src:email') return (i) => w.ScheduleApp.messageSourceKind(i) === 'email';
        return () => false;
    },
    _navCounts: () => ({ today: 2, tomorrow: 0, week: 1, month: 1, later: 1, all: 4,
        groups: new Map([['Travel', 1]]), unassigned: 3,
        tags: new Map([['home', 2], ['money', 1]]), anyTag: 3, fromEmail: 1, fromTexts: 0 }),
    _rangeItems: (id, pred) => ({ days: [{ date: '2026-09-24', items: [byId('t4'), byId('t1')].filter((i) => !pred || pred(i)) }], total: 2 }),
    _laterItems: (pred) => ({ months: [{ key: '2026-10', label: 'October 2026', entries: [{ item: byId('t4'), date: '2026-10-30' }] }],
        noDate: [byId('t5')].filter((i) => !pred || pred(i)), done: [], total: 2 }),
};
w.UpdateStore = { listFor: (key) => (key === 'task:t1' ? [{ id: 'u1', at: '2026-09-21T10:00:00Z', text: 'Chased them' }] : []) };
w.AgentTools = { handlers: { update_schedule_item: (args) => { calls.push('update_schedule_item'); byId(args.id).scheduledDate = args.scheduledDate; return { success: true }; } } };
w.StorageManager = { get: () => ({ scheduleItems: items }), set: () => {} };
// main names the KEY of every write to every window; MobileViews listens so a
// served view is never built from the copy ScheduleApp loaded at launch.
let keyChanged = () => {};
w.electronStore = { onKeyChanged: (cb) => { keyChanged = cb; } };
w.electronMobileViews = { onRequest: () => {}, sendResult: () => Promise.resolve() };

w.eval(viewsSource + '\nwindow.subject = MobileViews;');
const views = w.subject;
views.init();

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ok   ' + name); }
    catch (e) { failures++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
const plain = (v) => JSON.parse(JSON.stringify(v));
const group = (out, id) => out.groups.find((g) => g.id === id);

(async () => {
    console.log('\nThe list is the desktop\'s own grouping');
    await check('Today is overdue + today + done today, from getGroupedItems', async () => {
        const out = await views._tasks({});
        assert.ok(calls.includes('getGroupedItems'), 'the desktop accessor is what answers');
        assert.deepEqual(plain(group(out, 'overdue').items.map((r) => r.id)), ['t1']);
        assert.deepEqual(plain(group(out, 'today').items.map((r) => r.id)), ['t2']);
        assert.deepEqual(plain(group(out, 'done').items.map((r) => r.id)), ['t3']);
        assert.equal(out.today, TODAY, 'today is the Mac\'s, never the phone\'s clock');
    });
    await check('an empty group never reaches the phone', async () => {
        const out = await views._tasks({});
        assert.ok(!out.groups.some((g) => !g.items.length));
    });
    await check('a row carries what the row shows, and its project by name', async () => {
        const out = await views._tasks({ slice: 'later' });
        const row = group(out, '2026-10').items[0];
        assert.equal(row.title, 'Book the flights');
        assert.deepEqual(plain(row.projects), [{ id: 'g1', title: 'Japan trip' }]);
        assert.deepEqual(plain(row.tags), ['home']);
    });
    await check('Later is grouped by MONTH, as the desktop shows it', async () => {
        const out = await views._tasks({ slice: 'later' });
        assert.equal(group(out, '2026-10').label, 'October 2026');
        assert.deepEqual(plain(group(out, 'nodate').items.map((r) => r.id)), ['t5']);
    });
    await check('a range slice comes back day by day', async () => {
        const out = await views._tasks({ slice: 'week' });
        assert.equal(out.groups[0].date, '2026-09-24');
    });

    console.log('\nBoth nav dimensions cross on the Mac');
    await check('a tag scope narrows the same groups', async () => {
        const out = await views._tasks({ slice: 'today', group: 't:money' });
        assert.ok(calls.includes('groupPredicateFor:t:money'), 'scoping is the desktop\'s rule');
        assert.deepEqual(plain(group(out, 'overdue').items.map((r) => r.id)), ['t1']);
        assert.equal(group(out, 'today'), undefined, 'the untagged task is gone, not hidden on the phone');
    });
    await check('a scope crosses a range slice too', async () => {
        const out = await views._tasks({ slice: 'week', group: 'src:email' });
        assert.deepEqual(plain(out.groups[0].items.map((r) => r.id)), ['t1']);
    });
    await check('an unknown slice falls back to Today rather than emptying the screen', async () => {
        const out = await views._tasks({ slice: 'whenever' });
        assert.equal(out.slice, 'today');
    });

    console.log('\nThe nav is counts, not a second opinion');
    await check('every slice carries the desktop count; only Today wears attention', async () => {
        const out = await views._tasks({});
        assert.deepEqual(plain(out.nav.slices.map((s) => [s.id, s.count])),
            [['today', 2], ['tomorrow', 0], ['week', 1], ['month', 1], ['later', 1], ['all', 4]]);
        assert.deepEqual(plain(out.nav.slices.filter((s) => s.attention).map((s) => s.id)), ['today']);
    });
    await check('tags and projects arrive ranked, with the keys the scope takes', async () => {
        const out = await views._tasks({});
        assert.deepEqual(plain(out.nav.tags), [{ id: 't:home', name: 'home', count: 2 }, { id: 't:money', name: 'money', count: 1 }]);
        assert.deepEqual(plain(out.nav.projects), [{ id: 'g:Travel', name: 'Travel', count: 1 }]);
    });
    await check('a source appears only when it has something', async () => {
        const out = await views._tasks({});
        assert.deepEqual(plain(out.nav.sources.map((s) => s.id)), ['src:email']);
    });

    console.log('\nOne task');
    await check('the detail adds what the sheet shows and its updates', async () => {
        const out = await views._task({ id: 't1' });
        assert.equal(out.description, 'Acme 4471');
        assert.deepEqual(plain(out.updates.map((u) => u.text)), ['Chased them']);
        assert.equal(out.source, 'email');
    });
    await check('a task that is gone says so', async () => {
        await assert.rejects(() => views._task({ id: 'nope' }), /gone/);
    });

    console.log('\nWrites state a direction, and the Mac decides');
    await check('completing an open task toggles it, quietly', async () => {
        calls.length = 0;
        const out = await views._tasksAction({ action: 'complete', id: 't1' });
        assert.ok(calls.includes('toggleComplete:t1:quiet'), 'no confetti for a tap on another device');
        assert.equal(out.task.done, true);
    });
    await check('completing an ALREADY complete task changes nothing', async () => {
        calls.length = 0;
        const out = await views._tasksAction({ action: 'complete', id: 't1' });
        assert.equal(calls.filter((c) => c.startsWith('toggleComplete')).length, 0, 'a stale row cannot flip it back');
        assert.equal(out.task.done, true);
    });
    await check('reopening it is the same rule in reverse', async () => {
        const out = await views._tasksAction({ action: 'uncomplete', id: 't1' });
        assert.equal(out.task.done, false);
    });
    await check('an unknown action is refused', async () => {
        await assert.rejects(() => views._tasksAction({ action: 'delete-everything', id: 't1' }), /unknown action/);
    });

    // A served view must be built from CURRENT data. ScheduleApp loads the
    // blob once, at init, so a write from the phone or another Mac left the
    // Mac answering with rows from launch — and tapping refresh on the phone
    // could not help, because the staleness was here.
    console.log('\nThe rows are re-read when the blob changed under the Mac');
    await check('a change to app_schedule makes the next request reload', async () => {
        calls.length = 0;
        await views._tasks({});
        assert.equal(calls.filter((c) => c === 'loadData').length, 0, 'nothing changed — no reload');
        keyChanged('app_schedule');
        await views._tasks({});
        assert.equal(calls.filter((c) => c === 'loadData').length, 1, 'the blob changed — reload once');
        await views._tasks({});
        assert.equal(calls.filter((c) => c === 'loadData').length, 1, 'and only once per change');
    });
    await check('a change to somebody else\'s blob is not ours to reload for', async () => {
        calls.length = 0;
        keyChanged('app_notes');
        await views._tasks({});
        assert.equal(calls.filter((c) => c === 'loadData').length, 0);
    });
    await check('"every key changed" (null) counts as ours', async () => {
        calls.length = 0;
        keyChanged(null);
        await views._tasks({});
        assert.equal(calls.filter((c) => c === 'loadData').length, 1);
    });

    console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})();
