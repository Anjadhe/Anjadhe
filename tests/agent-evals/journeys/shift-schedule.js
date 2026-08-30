/**
 * Bulk reschedule: shift_schedule_items + the goal-scoped list_schedule
 * (2026-08-19).
 *
 * Born from a real failure: a 36-task goal asked to "start from today"
 * left the agent unable to even enumerate the task ids (list_goals'
 * nested tasks array byte-trimmed to a JSON preview; list_schedule
 * capped at 25 rows), then facing 40+ individual update_schedule_item
 * round-trips it never finished. The laws under test:
 *
 *  - the shift is ARITHMETIC, atomic, and scoped by goal or ids: the
 *    model states intent (anchor "today"), the app computes every date,
 *    one write moves them all with spacing preserved;
 *  - resolved one-time tasks and undated to-dos stay in place, and the
 *    result says so;
 *  - preserve_weekday_cadence rounds UP to whole weeks (first task on or
 *    after the anchor, weekday kept);
 *  - weekly/custom recurrences carry their stored weekday fields when
 *    the delta breaks weekdays (ScheduleApp.repeatsOnDay keys on them);
 *  - the tool always ASKS, and the consent dialog renders the SAME plan
 *    the handler applies (one builder — approving it is approving exact
 *    counts and dates);
 *  - a big goal's task list is enumerable end to end: list_schedule
 *    {goal} survives agent-service's trims whole, and list_goals caps a
 *    big goal's nested tasks STRUCTURALLY (taskCount + pointer), never
 *    as a mid-record byte-trim.
 */

module.exports = [
  {
    id: 'ss-anchor-shifts-goal-plan',
    name: 'anchor_date:"today" shifts a goal\'s live tasks by one computed delta; resolved and undated stay',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const iso = (off) => {
          const d = new Date(); d.setDate(d.getDate() + off);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        };
        const TITLE = 'eval shift goal anchor';
        try {
          await AgentTools.handlers.create_goal({ title: TITLE });
          const mk = async (title, date) => {
            const r = await AgentTools.handlers.create_schedule_item({
              title, goalTitle: TITLE, ...(date ? { scheduledDate: date } : {})
            });
            return r.item?.id || r.id;
          };
          const t1 = await mk('eval ss run week one', iso(-9));
          const t2 = await mk('eval ss run week two', iso(-7));
          const t3 = await mk('eval ss run week three', iso(2));
          const t4 = await mk('eval ss already done', iso(-8));
          const t5 = await mk('eval ss undated todo', null);
          await AgentTools.handlers.complete_task({ id: t4 });
          // create_schedule_item defaults scheduledDate to today — a truly
          // undated to-do only exists by clearing it.
          const seeded = StorageManager.get('schedule');
          seeded.scheduleItems.find(i => i.id === t5).scheduledDate = '';
          StorageManager.set('schedule', seeded);

          // Always asks — the dialog is the consent AND the preview.
          const asks = PermissionManager.resolve('shift_schedule_items', {}).decision === 'ask';
          const dialog = AgentUI._describeToolAction('shift_schedule_items',
            { goal_search: TITLE, anchor_date: 'today' });
          const dialogNames = dialog.includes('3 task') && dialog.includes(TITLE)
            && dialog.includes(iso(0));

          const res = await AgentTools.handlers.shift_schedule_items({
            goal_search: TITLE, anchor_date: 'today'
          });
          const byId = new Map((StorageManager.get('schedule')?.scheduleItems || []).map(i => [i.id, i]));
          const moved = byId.get(t1).scheduledDate === iso(0)
            && byId.get(t2).scheduledDate === iso(2)
            && byId.get(t3).scheduledDate === iso(11);   // spacing preserved
          const untouched = byId.get(t4).scheduledDate === iso(-8)
            && !byId.get(t5).scheduledDate;
          const reported = res.success && res.count === 3 && res.shiftedDays === 9
            && res.firstDate === iso(0) && res.undatedLeftInPlace === 1;

          return {
            pass: asks && dialogNames && moved && untouched && reported,
            detail: JSON.stringify({ asks, dialogNames, moved, untouched, reported, res })
          };
        } finally {
          await AgentTools.handlers.delete_goal({ search: TITLE });
        }
      });
    }
  },
  {
    id: 'ss-cadence-rounds-to-whole-weeks',
    name: 'preserve_weekday_cadence rounds the delta up to whole weeks, landing on or after the anchor',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const iso = (off) => {
          const d = new Date(); d.setDate(d.getDate() + off);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        };
        const dow = (s) => new Date(s + 'T00:00:00').getDay();
        const TITLE = 'eval shift goal cadence';
        try {
          await AgentTools.handlers.create_goal({ title: TITLE });
          const a = await AgentTools.handlers.create_schedule_item({
            title: 'eval ss cadence one', goalTitle: TITLE, scheduledDate: iso(-9) });
          const idA = a.item?.id || a.id;
          await AgentTools.handlers.create_schedule_item({
            title: 'eval ss cadence two', goalTitle: TITLE, scheduledDate: iso(-2) });

          const res = await AgentTools.handlers.shift_schedule_items({
            goal_search: TITLE, anchor_date: 'today', preserve_weekday_cadence: true
          });
          // Raw delta 9 → rounded up to 14: whole weeks, first task ≥ today.
          const first = (StorageManager.get('schedule')?.scheduleItems || [])
            .find(i => i.id === idA);
          const rounded = res.shiftedDays === 14 && first.scheduledDate === iso(5);
          const weekdayKept = dow(first.scheduledDate) === dow(iso(-9));
          const onOrAfter = first.scheduledDate >= iso(0);

          return {
            pass: rounded && weekdayKept && onOrAfter,
            detail: JSON.stringify({ rounded, weekdayKept, onOrAfter, res })
          };
        } finally {
          await AgentTools.handlers.delete_goal({ search: TITLE });
        }
      });
    }
  },
  {
    id: 'ss-shift-days-carries-weekly-dow',
    name: 'an ids-scoped shift_days moves a weekly recurrence AND its stored dayOfWeek together',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const iso = (off) => {
          const d = new Date(); d.setDate(d.getDate() + off);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        };
        let id = null;
        try {
          const made = await AgentTools.handlers.create_schedule_item({
            title: 'eval ss weekly recurrence', scheduledDate: iso(3) });
          id = made.item?.id || made.id;
          // repeatsOnDay keys weekly items on stored dayOfWeek, not the
          // anchor date — seed it the way the schedule UI does.
          const sched = StorageManager.get('schedule');
          const it = sched.scheduleItems.find(i => i.id === id);
          it.repeat = 'weekly';
          it.dayOfWeek = new Date(iso(3) + 'T00:00:00').getDay();
          StorageManager.set('schedule', sched);
          const oldDow = it.dayOfWeek;

          const res = await AgentTools.handlers.shift_schedule_items({
            ids: [id], shift_days: 9
          });
          const after = (StorageManager.get('schedule')?.scheduleItems || [])
            .find(i => i.id === id);
          const dateMoved = after.scheduledDate === iso(12);
          const dowCarried = after.dayOfWeek === (oldDow + 2) % 7;
          // The recurrence still fires on its (new) anchor date.
          const stillOccurs = ScheduleApp.occursOn(after, after.scheduledDate);

          return {
            pass: res.success && res.count === 1 && dateMoved && dowCarried && stillOccurs,
            detail: JSON.stringify({ dateMoved, dowCarried, stillOccurs, res })
          };
        } finally {
          if (id) await AgentTools.handlers.delete_schedule_item({ id });
        }
      });
    }
  },
  {
    id: 'ss-args-validation',
    name: 'bad scopes and ambiguous amounts come back as errors, never partial writes',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const iso = (off) => {
          const d = new Date(); d.setDate(d.getDate() + off);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        };
        let id = null;
        try {
          const made = await AgentTools.handlers.create_schedule_item({
            title: 'eval ss validation task', scheduledDate: iso(0) });
          id = made.item?.id || made.id;

          const noScope = (await AgentTools.handlers.shift_schedule_items({ shift_days: 3 })).error || '';
          const both = (await AgentTools.handlers.shift_schedule_items({
            ids: [id], shift_days: 3, anchor_date: 'tomorrow' })).error || '';
          const badGoal = (await AgentTools.handlers.shift_schedule_items({
            goal_search: 'eval ss no such goal xyz', shift_days: 3 })).error || '';
          const zero = (await AgentTools.handlers.shift_schedule_items({
            ids: [id], anchor_date: 'today' })).error || '';

          const untouched = (StorageManager.get('schedule')?.scheduleItems || [])
            .find(i => i.id === id)?.scheduledDate === iso(0);

          return {
            pass: /goal_search|ids/.test(noScope) && /not both/i.test(both)
              && /list_goals/.test(badGoal) && /0 days/.test(zero) && untouched,
            detail: JSON.stringify({ noScope, both, badGoal, zero, untouched })
          };
        } finally {
          if (id) await AgentTools.handlers.delete_schedule_item({ id });
        }
      });
    }
  },
  {
    id: 'ss-big-goal-enumerable-and-shifts-whole',
    name: 'a 36-task goal lists end to end through the trims and shifts in ONE call',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const iso = (off) => {
          const d = new Date(); d.setDate(d.getDate() + off);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        };
        const TITLE = 'eval shift goal big';
        try {
          await AgentTools.handlers.create_goal({ title: TITLE });
          for (let i = 0; i < 36; i++) {
            await AgentTools.handlers.create_schedule_item({
              title: `eval ss big run ${i + 1}`, goalTitle: TITLE, scheduledDate: iso(-9 + i * 2)
            });
          }

          // The goal-scoped read returns the WHOLE list, and agent-service's
          // trims must not re-hide it (the 25-item cap / 6k byte-trim were
          // exactly how a 36-task goal became unenumerable).
          const listed = await AgentTools.handlers.list_schedule({ goal: TITLE }, {});
          const trimmed = AgentService._truncateToolResult('list_schedule', listed);
          const wholeList = listed.itemCount === 36
            && Array.isArray(trimmed.items) && trimmed.items.length === 36
            && trimmed.items.every(r => r.id && r.date);

          // list_goals self-caps the nested array STRUCTURALLY — taskCount +
          // a pointer at the full read, never a mid-record byte preview.
          const lg = await AgentTools.handlers.list_goals({}, {});
          const g = lg.goals.find(x => x.title === TITLE);
          const structuralCap = g && g.tasks && g.tasks._truncated === true
            && g.tasks.taskCount === 36 && g.tasks.items.length === 12
            && /list_schedule/.test(g.tasks.note || '');

          // One call moves all 36, spacing preserved.
          const res = await AgentTools.handlers.shift_schedule_items({
            goal_search: TITLE, anchor_date: 'tomorrow'
          });
          const after = await AgentTools.handlers.list_schedule({ goal: TITLE }, {});
          const dates = after.items.map(r => r.date);
          const shiftedWhole = res.success && res.count === 36 && res.shiftedDays === 10
            && dates[0] === iso(1) && dates[35] === iso(71)
            && dates.every((d, i) => i === 0 || d === iso(1 + i * 2));

          return {
            pass: wholeList && structuralCap && shiftedWhole,
            detail: JSON.stringify({ wholeList, structuralCap, shiftedWhole,
              itemCount: listed.itemCount, res })
          };
        } finally {
          await AgentTools.handlers.delete_goal({ search: TITLE });
        }
      });
    }
  },
  {
    id: 'shift-all-scope-and-window',
    name: 'all:true shifts the whole schedule; a date window bounds it; done stays put',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const iso = (off) => {
          const d = new Date(); d.setDate(d.getDate() + off);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        };
        try {
          const mk = async (title, date) => {
            const r = await AgentTools.handlers.create_schedule_item({ title, scheduledDate: date });
            return r.item?.id || r.id;
          };
          // Fixtures live in a far-future window so EXECUTING an all-scope
          // shift can be bounded to them — the demo persona's own tasks
          // must never move under a shared-state journey.
          const a1 = await mk('eval allscope in-window one', iso(300));
          const a2 = await mk('eval allscope in-window two', iso(301));
          const b1 = await mk('eval allscope outside', iso(305));
          const d1 = await mk('eval allscope done', iso(300));
          await AgentTools.handlers.complete_task({ id: d1 });

          // The dialog derives from the same plan (the one-builder rule):
          // the no-window all-scope names the whole schedule.
          const dlg = AgentUI._describeToolAction('shift_schedule_items', { all: true, shift_days: 7 });
          const dialogNames = dlg.includes('whole schedule');

          // Bare all-scope PLAN (no write): must include our live fixtures
          // and exclude the completed one.
          const plan = AgentTools._shiftPlan({ all: true, shift_days: 7 });
          const ids = new Set((plan.items || []).map(i => i.id));
          const planScopes = !plan.error && ids.has(a1) && ids.has(b1) && !ids.has(d1);

          // EXECUTE all+window, +1 day — the "sick day" phrasing bounded
          // to the fixture window.
          const r1 = await AgentTools.handlers.shift_schedule_items({
            all: true, date_from: iso(300), date_to: iso(302), shift_days: 1 });
          const get = (id) => (StorageManager.get('schedule')?.scheduleItems || []).find(i => i.id === id);
          const windowed = !r1.error
            && get(a1).scheduledDate === iso(301) && get(a2).scheduledDate === iso(302)
            && get(b1).scheduledDate === iso(305)  // outside the window
            && get(d1).scheduledDate === iso(300); // completed = not live, never moved

          // Exactly-one-scope law holds.
          const stillRequires = (AgentTools._shiftPlan({ shift_days: 7 }).error || '').includes('all:true');

          return { pass: dialogNames && planScopes && windowed && stillRequires,
            detail: JSON.stringify({ dialogNames, planScopes, windowed, stillRequires }) };
        } finally {
          const sched = StorageManager.get('schedule') || {};
          sched.scheduleItems = (sched.scheduleItems || []).filter(i => !/eval allscope/.test(i.title || ''));
          StorageManager.set('schedule', sched);
        }
      });
    }
  },
  {
    id: 'schedule-phrasings-ship-tools',
    name: 'consumer phrasings ("on my list", "whats tomorrow look like") ship schedule tools',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        const hits = [
          'put "drop off the donation box" on my list for sunday',
          'whats tomorrow look like',
          "what's on my plate today",
          'hows friday looking for me — anything on my day?',
          'take the dry cleaning off my list',
        ].map(t => AgentTools._domainsForMessage(t).has('schedule'));
        const misses = [
          'whats a good recipe for chicken thighs',   // no schedule words
          'my listing on airbnb got a review',        // "list" inside a word
        ].map(t => AgentTools._domainsForMessage(t).has('schedule'));
        const pass = hits.every(Boolean) && misses.every(v => !v);
        return { pass, detail: JSON.stringify({ hits, misses }) };
      });
    }
  }
];
