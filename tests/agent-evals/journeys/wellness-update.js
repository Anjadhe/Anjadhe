/**
 * Wellness corrections update in place (2026-08-09: "I started at 11:20"
 * after logging a workout produced a SECOND workout — the model's only
 * wellness write tool was log_wellness, so a correction could only re-log).
 * Pinned:
 *  - update_wellness edits the existing entry: same id, no new entry.
 *  - a misfiled text detail on update APPENDS to existing notes; an
 *    explicit notes arg replaces them.
 *  - delete_wellness removes the entry and errors on an unknown id.
 */
module.exports = [
  {
    id: 'wellness-correction-updates-in-place',
    name: 'update_wellness corrects an entry in place — never a second entry',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const logged = await AgentTools.handlers.log_wellness({
          kind: 'activity', activityType: 'Strength training', duration: 45,
          time: '2026-08-09T12:55',
          notes: 'bicep curls, skull crushers'
        });
        const before = WellnessApp.entries.length;

        // The duplicate-report shape: a follow-up correcting the start time.
        const updated = await AgentTools.handlers.update_wellness({
          id: logged.entry.id, time: '2026-08-09T11:20'
        });
        const inPlace = updated.success
          && updated.entry.id === logged.entry.id
          && updated.entry.time === '2026-08-09T11:20'
          && updated.entry.notes === 'bicep curls, skull crushers'
          && WellnessApp.entries.length === before;

        // A misfiled text param (description on an activity) appends to the
        // existing notes instead of replacing them.
        const misfiled = await AgentTools.handlers.update_wellness({
          id: logged.entry.id, description: 'chin ups too'
        });
        const appended = misfiled.success
          && misfiled.entry.notes.includes('bicep curls')
          && misfiled.entry.notes.includes('chin ups too');

        // An explicit notes arg is the full corrected text — it replaces.
        const rewrote = await AgentTools.handlers.update_wellness({
          id: logged.entry.id, notes: 'arms day: curls, chin ups'
        });
        const replaced = rewrote.success && rewrote.entry.notes === 'arms day: curls, chin ups';

        await AgentTools.handlers.delete_wellness({ id: logged.entry.id });
        const pass = inPlace && appended && replaced;
        return { pass, detail: JSON.stringify({ inPlace, appended, replaced }) };
      });
    }
  },
  {
    id: 'wellness-delete-entry',
    name: 'delete_wellness removes the entry; unknown ids error',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const logged = await AgentTools.handlers.log_wellness({
          kind: 'water', amount: 8
        });
        const del = await AgentTools.handlers.delete_wellness({ id: logged.entry.id });
        const gone = del.success
          && !WellnessApp.entries.some(e => e.id === logged.entry.id);
        const missing = await AgentTools.handlers.delete_wellness({ id: 'no-such-id' });
        const errs = !!missing.error;
        const pass = gone && errs;
        return { pass, detail: JSON.stringify({ gone, errs }) };
      });
    }
  }
];
