#!/usr/bin/env node
/**
 * AppleImport.planImport — the arithmetic behind the iCloud Reminders →
 * Tasks import (js/core/apple-import.js). Pure planning logic, so it runs
 * standalone:
 *
 *   node tests/apple-import-test.js
 *
 * Dates that must be timezone-independent are built with the local Date
 * constructor and converted through the same helpers production uses.
 */

const AppleImport = require('../js/core/apple-import.js');

let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

// Local wall-clock ISO builders so expectations match _localYMD/_localHM in
// any timezone the test runs in.
const localISO = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).toISOString();
const NOW = localISO(2026, 8, 20, 12, 0);

const rem = (over) => ({
    externalId: 'EXT-1', title: 'Pay water bill', notes: '', list: 'Reminders',
    due: '', hasTime: false, completed: false, completionDate: '',
    lastModified: NOW, priority: 0,
    ...over,
});
const task = (over) => ({
    id: 't1', title: 'Pay water bill', description: '', startTime: '',
    scheduledDate: '', lastCompletedDate: null,
    repeat: 'none', dayOfWeek: null, repeatDays: [],
    tags: ['apple-reminders', 'Reminders'],
    source: 'reminders', sourceReminderId: 'EXT-1', sourceReminderList: 'Reminders',
    reminderSnapshot: {
        title: 'Pay water bill', description: '', scheduledDate: '', startTime: '',
        repeat: 'none', dayOfWeek: null, repeatDays: [], tags: ['apple-reminders', 'Reminders'],
    },
    ...over,
});

// ── Creation ────────────────────────────────────────────────────────────
{
    const r = rem({ due: localISO(2026, 9, 1, 9, 0), hasTime: true, notes: 'account 42', title: '⁠⁠Pay water bill' });
    const plan = AppleImport.planImport([r], [], NOW);
    check('creates one task from an incomplete reminder', plan.creates.length === 1 && plan.summary.created === 1);
    const c = plan.creates[0] || {};
    check('zero-width chars stripped from title', c.title === 'Pay water bill', JSON.stringify(c.title));
    check('due date lands as local YMD', c.scheduledDate === '2026-09-01', c.scheduledDate);
    check('timed reminder carries startTime', c.startTime === '09:00', c.startTime);
    check('notes map to description', c.description === 'account 42');
    check('stamped with source identity', c.source === 'reminders' && c.sourceReminderId === 'EXT-1' && c.sourceReminderList === 'Reminders');
    check('snapshot records what was applied', c.reminderSnapshot && c.reminderSnapshot.title === 'Pay water bill' && c.reminderSnapshot.scheduledDate === '2026-09-01');
}

{
    const plan = AppleImport.planImport([rem({})], [], NOW);
    check('undated reminder lands in the undated bucket', plan.creates[0].scheduledDate === '');
}

{
    const plan = AppleImport.planImport([rem({ completed: true, completionDate: NOW })], [], NOW);
    check('completed reminder with no task imports nothing (no history)', plan.creates.length === 0 && plan.updates.length === 0);
}

// ── Dedup + update policy ───────────────────────────────────────────────
{
    const plan = AppleImport.planImport([rem({})], [task({})], NOW);
    check('unchanged reminder produces no update', plan.updates.length === 0 && plan.creates.length === 0);
}

{
    // Reminder retitled in iCloud, local copy untouched → iCloud wins.
    const plan = AppleImport.planImport([rem({ title: 'Pay water bill (city)' })], [task({})], NOW);
    check('reminder-side change applies while local untouched', plan.updates.length === 1 && plan.updates[0].set.title === 'Pay water bill (city)');
    check('snapshot advances with the applied field', plan.updates[0].snapshot.title === 'Pay water bill (city)');
}

{
    // Both sides changed the title → the user's edit wins, forever.
    const plan = AppleImport.planImport(
        [rem({ title: 'Pay water bill (city)' })],
        [task({ title: 'Pay water + trash bill' })], NOW);
    check('local edit wins over reminder change', plan.updates.length === 0);
}

{
    // Date set in iCloud on a previously undated reminder.
    const plan = AppleImport.planImport(
        [rem({ due: localISO(2026, 9, 3), hasTime: false })],
        [task({})], NOW);
    check('new due date flows to scheduledDate', plan.updates[0] && plan.updates[0].set.scheduledDate === '2026-09-03');
}

// ── Completion mirror ───────────────────────────────────────────────────
{
    const plan = AppleImport.planImport(
        [rem({ completed: true, completionDate: localISO(2026, 8, 19, 8, 0) })],
        [task({})], NOW);
    check('completed reminder completes the open task', plan.updates[0] && plan.updates[0].set.lastCompletedDate === '2026-08-19');
    check('completion counted in summary', plan.summary.completed === 1);
}

{
    // A stale Apple completion (older than the task's own) leaves the task
    // alone; a NEWER one advances it — for repeating tasks
    // lastCompletedDate is "last done day".
    const stale = AppleImport.planImport(
        [rem({ completed: true, completionDate: localISO(2026, 8, 15, 9, 0) })],
        [task({ lastCompletedDate: '2026-08-18' })], NOW);
    check('stale Apple completion is ignored', stale.updates.length === 0);
    const newer = AppleImport.planImport(
        [rem({ completed: true, completionDate: localISO(2026, 8, 19, 9, 0) })],
        [task({ lastCompletedDate: '2026-08-18' })], NOW);
    check('newer Apple completion advances last done day', newer.updates[0]?.set.lastCompletedDate === '2026-08-19');
}

// ── Recurrence mapping ──────────────────────────────────────────────────
{
    const recur = (recurrence, due) => rem({ recurrence, due: due ?? localISO(2027, 5, 25, 9, 0), hasTime: true });
    const map = (r) => AppleImport._mapRecurrence(r);
    const simple = { interval: 1, days: [], hasEnd: false, complex: false };
    check('yearly rule → annually', map(recur({ ...simple, freq: 'yearly' })).repeat === 'annually');
    check('monthly rule → monthly', map(recur({ ...simple, freq: 'monthly' })).repeat === 'monthly');
    check('daily rule → daily', map(recur({ ...simple, freq: 'daily' })).repeat === 'daily');
    const wk = map(recur({ ...simple, freq: 'weekly' }, localISO(2026, 8, 24, 9, 0))); // a Monday
    check('bare weekly rule → weekly on the due weekday', wk.repeat === 'weekly' && wk.dayOfWeek === new Date(localISO(2026, 8, 24, 9, 0)).getDay());
    check('weekly Mon-Fri → weekdays', map(recur({ ...simple, freq: 'weekly', days: [1, 2, 3, 4, 5] })).repeat === 'weekdays');
    const cu = map(recur({ ...simple, freq: 'weekly', days: [2, 4] }));
    check('weekly multi-day → custom', cu.repeat === 'custom' && cu.repeatDays.join() === '2,4');
    check('interval > 1 falls back to none', map(recur({ ...simple, freq: 'yearly', interval: 2 })).repeat === 'none');
    check('rule with end date falls back to none', map(recur({ ...simple, freq: 'monthly', hasEnd: true })).repeat === 'none');
    check('complex rule falls back to none', map(recur({ ...simple, freq: 'monthly', complex: true })).repeat === 'none');
}

{
    // A yearly reminder creates a repeating task.
    const plan = AppleImport.planImport([rem({
        due: localISO(2026, 12, 1, 0, 0), hasTime: true,
        recurrence: { freq: 'yearly', interval: 1, days: [], hasEnd: false, complex: false },
    })], [], NOW);
    const c = plan.creates[0] || {};
    check('recurring reminder creates a repeating task', c.repeat === 'annually' && c.reminderSnapshot.repeat === 'annually');
}

{
    // Migration: a task imported BEFORE recurrence mapping existed (snapshot
    // has no repeat keys, task carries the old defaults) picks the rule up.
    const old = task({ scheduledDate: '2026-12-01', repeat: 'none', dayOfWeek: null, repeatDays: [] });
    old.reminderSnapshot = { title: 'Pay water bill', description: '', scheduledDate: '2026-12-01', startTime: '' };
    const plan = AppleImport.planImport([rem({
        due: localISO(2026, 12, 1, 0, 0), hasTime: false,
        recurrence: { freq: 'yearly', interval: 1, days: [], hasEnd: false, complex: false },
    })], [old], NOW);
    check('pre-recurrence import upgrades to the mapped rule', plan.updates[0]?.set.repeat === 'annually', JSON.stringify(plan.updates[0]?.set));
}

{
    // Recurring roll-forward: same reminder id, Apple advanced the due date
    // past the local completion → new occurrence, completion cleared.
    const snapDate = '2026-08-16';
    const plan = AppleImport.planImport(
        [rem({ due: localISO(2027, 8, 16), hasTime: false })],
        [task({
            scheduledDate: snapDate, lastCompletedDate: '2026-08-16',
            reminderSnapshot: { title: 'Pay water bill', description: '', scheduledDate: snapDate, startTime: '' },
        })], NOW);
    const u = plan.updates[0] || { set: {} };
    check('recurring reminder rolls the task forward', u.set.scheduledDate === '2027-08-16' && u.set.lastCompletedDate === null,
        JSON.stringify(u.set));
}

// ── Robustness ──────────────────────────────────────────────────────────
{
    const plan = AppleImport.planImport([rem({ externalId: '' })], [], NOW);
    check('reminder without an externalId is skipped', plan.creates.length === 0);
}

{
    const long = 'x'.repeat(5000);
    const plan = AppleImport.planImport([rem({ notes: long })], [], NOW);
    check('description capped', plan.creates[0].description.length === AppleImport.DESC_CAP);
}

// ── Tags (Reminders lists → task tags) ──────────────────────────────────
{
    const plan = AppleImport.planImport([rem({ list: 'Family Groceries' })], [], NOW);
    check('created task carries the marker tag and its list as tags',
        JSON.stringify(plan.creates[0].tags) === '["apple-reminders","Family Groceries"]', JSON.stringify(plan.creates[0].tags));
}

{
    // Pre-tags import (snapshot has no tags key, task has none) picks them up.
    const old = task({});
    delete old.tags;
    old.reminderSnapshot = { title: 'Pay water bill', description: '', scheduledDate: '', startTime: '', repeat: 'none', dayOfWeek: null, repeatDays: [] };
    const plan = AppleImport.planImport([rem({ list: 'Reminders' })], [old], NOW);
    check('pre-tags import gains tags on next run',
        JSON.stringify(plan.updates[0]?.set.tags) === '["apple-reminders","Reminders"]', JSON.stringify(plan.updates[0]?.set));
}

{
    // The user edited the tags here — their edit wins over a list rename.
    const mine = task({
        tags: ['apple-reminders', 'my-own-tag'],
        reminderSnapshot: { title: 'Pay water bill', description: '', scheduledDate: '', startTime: '', repeat: 'none', dayOfWeek: null, repeatDays: [], tags: ['apple-reminders', 'Reminders'] },
    });
    const plan = AppleImport.planImport([rem({ list: 'Renamed List' })], [mine], NOW);
    check('locally edited tags win over an Apple list rename', plan.updates.length === 0);
}

{
    const plan = AppleImport.planImport([rem({ list: 'Birthdays &amp; Anniversaries', title: 'Kiran bday &amp; party' })], [], NOW);
    check('HTML entities decoded in titles and list tags',
        plan.creates[0].title === 'Kiran bday & party' && plan.creates[0].tags[1] === 'Birthdays & Anniversaries',
        JSON.stringify(plan.creates[0].tags));
}

// ═══ Apple Notes (Phase 2) ══════════════════════════════════════════════

const nrow = (over) => ({
    id: 'x-coredata://AAA/ICNote/p1', title: 'Space stuff', folder: 'Notes', account: 'iCloud',
    modified: '2026-08-18T19:23:13.000Z', created: '2026-08-18T19:22:12.000Z', locked: false,
    ...over,
});
const nrec = (over) => ({
    id: 'n1', title: 'Space stuff', content: '<p>hi</p>', tags: ['apple-notes', 'Notes'],
    source: 'apple-notes', sourceNoteId: 'x-coredata://AAA/ICNote/p1', sourceNoteFolder: 'Notes',
    sourceNoteModifiedAt: '2026-08-18T19:23:13.000Z',
    createdAt: '2026-08-18T19:22:12.000Z', modifiedAt: '2026-08-18T19:23:13.000Z',
    ...over,
});

// ── planNotesSync ───────────────────────────────────────────────────────
{
    const plan = AppleImport.planNotesSync([nrow({})], []);
    check('new note planned for create + body fetch', plan.creates.length === 1 && plan.needBodies.length === 1);
}

{
    const plan = AppleImport.planNotesSync([nrow({ locked: true })], []);
    check('locked note skipped and counted', plan.creates.length === 0 && plan.skippedLocked === 1);
}

{
    const plan = AppleImport.planNotesSync([nrow({})], [nrec({})]);
    check('unchanged note fetches no body', plan.updates.length === 0 && plan.needBodies.length === 0);
}

{
    const plan = AppleImport.planNotesSync([nrow({ modified: '2026-08-19T10:00:00.000Z' })], [nrec({})]);
    check('Apple-side change on untouched note plans an update', plan.updates.length === 1 && plan.needBodies[0] === nrow({}).id);
}

{
    // Edited in Anjadhe after import (modifiedAt moved past the import stamp).
    const plan = AppleImport.planNotesSync(
        [nrow({ modified: '2026-08-19T10:00:00.000Z' })],
        [nrec({ modifiedAt: '2026-08-18T21:00:00.000Z' })]);
    check('locally-edited note is left alone forever', plan.updates.length === 0 && plan.skippedEdited === 1);
}

// ── Folder tags (Apple Notes folders → note tags) ───────────────────────
{
    const plan = AppleImport.planNotesSync([nrow({ folder: 'Business Ideas' })], []);
    const ops = AppleImport.buildNoteOps(plan, { [nrow({}).id]: '<div>x</div>' }, NOW);
    check('created note carries the marker tag and its folder as tags',
        JSON.stringify(ops.creates[0].tags) === '["apple-notes","Business Ideas"]' && ops.creates[0].sourceNoteFolder === 'Business Ideas',
        JSON.stringify(ops.creates[0]));
}

{
    // Pre-folder-tag import: marker only, untouched → retag, both stamps move together.
    const plan = AppleImport.planNotesSync([nrow({})], [nrec({ tags: ['apple-notes'], sourceNoteFolder: undefined })]);
    check('unchanged marker-only note plans a retag and no body fetch',
        plan.retags.length === 1 && plan.updates.length === 0 && plan.needBodies.length === 0, JSON.stringify(plan));
    const ops = AppleImport.buildNoteOps(plan, {}, NOW);
    const set = ops.retags[0]?.set || {};
    check('retag backfills the folder tag',
        JSON.stringify(set.tags) === '["apple-notes","Notes"]' && set.sourceNoteFolder === 'Notes', JSON.stringify(set));
    check('retag of an untouched note keeps modifiedAt equal to sourceNoteModifiedAt',
        set.modifiedAt === NOW && set.sourceNoteModifiedAt === NOW && ops.summary.retagged === 1, JSON.stringify(set));
}

{
    // Body edited here (stamps differ), tags still the import's → still retagged, stays "edited".
    const plan = AppleImport.planNotesSync([nrow({})], [nrec({ tags: ['apple-notes'], sourceNoteFolder: undefined, modifiedAt: '2026-08-31T00:55:38.520Z' })]);
    const ops = AppleImport.buildNoteOps(plan, {}, NOW);
    const set = ops.retags[0]?.set || {};
    check('body-edited note with untouched tags still gains its folder tag',
        JSON.stringify(set.tags) === '["apple-notes","Notes"]' && set.modifiedAt === NOW && set.sourceNoteModifiedAt === undefined,
        JSON.stringify(set));
}

{
    // The user changed the tags → theirs forever, even when the folder differs.
    const plan = AppleImport.planNotesSync([nrow({ folder: 'Creativity' })], [nrec({ tags: ['apple-notes', 'mine'] })]);
    check('user-edited tags are never retagged', plan.retags.length === 0, JSON.stringify(plan.retags));
    const plan2 = AppleImport.planNotesSync([nrow({ folder: 'Creativity' })], [nrec({ tags: [] })]);
    check('removed tags are never retagged', plan2.retags.length === 0);
}

{
    // Moved between folders in Apple (no modificationDate bump) → the folder tag follows.
    const plan = AppleImport.planNotesSync([nrow({ folder: 'Creativity' })], [nrec({})]);
    const ops = AppleImport.buildNoteOps(plan, {}, NOW);
    check('folder move retags from the old folder to the new one',
        JSON.stringify(ops.retags[0]?.set.tags) === '["apple-notes","Creativity"]', JSON.stringify(ops.retags));
}

{
    const plan = AppleImport.planNotesSync([nrow({})], [nrec({})]);
    check('note already carrying its folder tag is left alone', plan.retags.length === 0);
    const plan2 = AppleImport.planNotesSync([nrow({})], [nrec({ tags: ['notes', 'apple-notes'] })]);
    check('folder-tag comparison ignores case and order', plan2.retags.length === 0);
}

{
    // Library spelling wins a case-insensitive match; the marker is never doubled.
    const plan = AppleImport.planNotesSync([nrow({ folder: 'NOTES' })], [], { tagNames: ['notes', 'work'] });
    const ops = AppleImport.buildNoteOps(plan, { [nrow({}).id]: '<div>x</div>' }, NOW);
    check('folder tag takes the library\'s spelling', JSON.stringify(ops.creates[0].tags) === '["apple-notes","notes"]', JSON.stringify(ops.creates[0].tags));
    const plan2 = AppleImport.planNotesSync([nrow({ folder: 'Apple-Notes' })], []);
    const ops2 = AppleImport.buildNoteOps(plan2, { [nrow({}).id]: '<div>x</div>' }, NOW);
    check('a folder named like the marker yields one tag', JSON.stringify(ops2.creates[0].tags) === '["apple-notes"]');
}

{
    // Apple-side change on an untouched note: the update carries the current folder tag too.
    const plan = AppleImport.planNotesSync([nrow({ modified: '2026-08-19T10:00:00.000Z', folder: 'Creativity' })], [nrec({})]);
    const ops = AppleImport.buildNoteOps(plan, { [nrow({}).id]: '<div>new</div>' }, NOW);
    check('update carries the folder tag and folder', JSON.stringify(ops.updates[0]?.set.tags) === '["apple-notes","Creativity"]'
        && ops.updates[0]?.set.sourceNoteFolder === 'Creativity' && plan.retags.length === 0, JSON.stringify(ops.updates));
}

// ── buildNoteOps ────────────────────────────────────────────────────────
{
    const plan = AppleImport.planNotesSync([nrow({})], []);
    const ops = AppleImport.buildNoteOps(plan, { [nrow({}).id]: '<div><h1>Space stuff</h1></div>\n<div><br></div>\n<div>Only earth</div>' }, NOW);
    const c = ops.creates[0] || {};
    check('create carries identity, tag, and Apple stamps', c.sourceNoteId === nrow({}).id && c.tags[0] === 'apple-notes'
        && c.modifiedAt === '2026-08-18T19:23:13.000Z' && c.modifiedAt === c.sourceNoteModifiedAt);
    check('leading duplicated title stripped from body', !/Space stuff/.test(c.content) && /Only earth/.test(c.content), c.content);
}

{
    const plan = AppleImport.planNotesSync([nrow({})], []);
    const ops = AppleImport.buildNoteOps(plan, { [nrow({}).id]: null }, NOW);
    check('null body (locked mid-flight) writes nothing', ops.creates.length === 0);
}

{
    const dirty = '<div>ok</div><script>alert(1)</script><div onclick="x()">click</div><a href="javascript:evil()">go</a><iframe src="http://x"></iframe>';
    const clean = AppleImport._sanitizeNoteHtml(dirty);
    check('sanitize strips script/iframe/handlers/javascript URLs',
        !/script|iframe|onclick|javascript:/i.test(clean) && /ok/.test(clean) && /click/.test(clean), clean);
}

{
    const kept = AppleImport._stripLeadingTitle('<div>Different first line</div><div>rest</div>', 'Space stuff');
    check('first line kept when it is not the title', /Different first line/.test(kept));
}

{
    // IMAP-account notes are full documents; iCloud notes are bare divs.
    const doc = '<html><head><meta charset="x"></head><body style="word-wrap: break-word;"><div>the text</div></body></html>';
    const clean = AppleImport._sanitizeNoteHtml(doc);
    check('full-document body unwrapped to inner HTML', clean === '<div>the text</div>', clean);
}

// ═══ Apple Calendar (Phase 3) ═══════════════════════════════════════════

const evrow = (over) => ({
    externalId: 'EV-1', title: 'Swimming class', notes: '', location: 'Pool',
    start: localISO(2026, 8, 23, 14, 55), end: localISO(2026, 8, 23, 15, 25),
    allDay: false, calendarId: 'CAL-1', calendarTitle: 'Shared Family',
    ...over,
});

{
    const recs = AppleImport.buildCalendarEvents([evrow({})]);
    const r = recs[0] || {};
    check('timed event maps to a local calendar record', recs.length === 1
        && r.id === `EV-1:${evrow({}).start}` && r.account === 'apple' && r.source === 'apple'
        && r.summary === 'Swimming class' && r.calendarId === 'apple:CAL-1' && r.appleCalendar === 'Shared Family');
}

{
    // Recurring series: same externalId, distinct starts → distinct records.
    const a = evrow({});
    const b = evrow({ start: localISO(2026, 8, 30, 14, 55), end: localISO(2026, 8, 30, 15, 25) });
    const recs = AppleImport.buildCalendarEvents([a, b, a]);
    check('occurrences keyed by externalId+start, exact dups dropped', recs.length === 2 && recs[0].id !== recs[1].id);
}

{
    // EventKit ends an all-day event inside its last day; the renderer
    // expects the Google shape (date-only, exclusive next-morning end).
    const recs = AppleImport.buildCalendarEvents([evrow({
        allDay: true,
        start: localISO(2026, 8, 23, 0, 0),
        end: localISO(2026, 8, 23, 23, 59),
    })]);
    const r = recs[0] || {};
    check('all-day event emitted date-only with exclusive next-day end',
        r.start === '2026-08-23' && r.end === '2026-08-24' && r.allDay === true, JSON.stringify({ s: r.start, e: r.end }));
}

{
    const recs = AppleImport.buildCalendarEvents([evrow({ externalId: '' }), evrow({ start: '' })]);
    check('rows missing externalId or start are skipped', recs.length === 0);
}

{
    // The auto-refresh compares this run's mirror with the last one, so
    // the same store must serialize identically whatever order EventKit
    // returned the rows in.
    const later = evrow({ externalId: 'EV-2', start: localISO(2026, 8, 30, 9, 0), end: localISO(2026, 8, 30, 9, 30) });
    const sameDay = evrow({ externalId: 'EV-0' });
    // Write-through handles (2026-09-09): a series occurrence points at its
    // series through the shared external id, carries its rule, and knows
    // whether its calendar accepts writes.
    {
        const cals = [{ id: 'CAL-1', title: 'Shared Family', writable: true }, { id: 'CAL-RO', title: 'Holidays', writable: false }];
        const recs = AppleImport.buildCalendarEvents([
            evrow({ eventId: 'EV-1', hasRecurrence: true, rrule: 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' }),
            evrow({ externalId: 'EXT-RO', eventId: 'EV-2', calendarId: 'CAL-RO', calendarTitle: 'Holidays', start: localISO(2026, 8, 25, 9, 0), end: localISO(2026, 8, 25, 10, 0) }),
        ], cals);
        const series = recs.find(r => r.appleExternalId === 'EV-1');
        const ro = recs.find(r => r.appleExternalId === 'EXT-RO');
        check('series occurrence keys its series by external id and carries the rule',
            !!series && series.recurringEventId === 'EV-1' && Array.isArray(series.recurrence)
            && series.recurrence[0] === 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' && series.appleEventId === 'EV-1'
            && series.appleOccurrenceStart === localISO(2026, 8, 23, 14, 55) && series.appleWritable === true,
            JSON.stringify(series));
        check('a standalone event has no series pointer', !!ro && ro.recurringEventId === null && ro.recurrence === null);
        check('a read-only calendar marks its events unwritable', !!ro && ro.appleWritable === false);
        check('an unknown calendar is assumed writable (helper decides at write time)',
            AppleImport.buildCalendarEvents([evrow({ calendarId: 'CAL-NEW' })])[0].appleWritable === true);
    }

    const one = AppleImport.buildCalendarEvents([later, evrow({}), sameDay]);
    const two = AppleImport.buildCalendarEvents([sameDay, later, evrow({})]);
    check('builder output is ordered by start then id, independent of input order',
        JSON.stringify(one) === JSON.stringify(two) && one[0].id.startsWith('EV-0:') && one[2].id.startsWith('EV-2:'),
        one.map(r => r.id).join(' | '));
}

// ── pruneStaleAccountRows: Google's post-sync prune must not eat the mirror ──
{
    const rows = [
        { id: 'g1', account: 'me@gmail.com' },
        { id: 'g2', account: 'old@gmail.com' },
        { id: 'a1', account: 'apple' },
        { id: 'l1' },
    ];
    const kept = AppleImport.pruneStaleAccountRows(rows, new Set(['me@gmail.com'])).map(r => r.id);
    check('prune drops rows of a disconnected Google account', !kept.includes('g2'), kept.join(','));
    check('prune keeps rows of a connected Google account', kept.includes('g1'));
    check('prune keeps Apple mirror rows even though "apple" is never a connected account', kept.includes('a1'));
    check('prune keeps account-less rows', kept.includes('l1'));
    check('prune accepts an array of emails too',
        AppleImport.pruneStaleAccountRows(rows, ['me@gmail.com']).length === 3);
    check('prune with no connected accounts still keeps the mirror',
        AppleImport.pruneStaleAccountRows(rows, new Set()).map(r => r.id).join(',') === 'a1,l1');
}

console.log('');
if (failures) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
}
console.log('all passed');
