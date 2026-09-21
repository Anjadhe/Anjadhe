/**
 * Wellness logging — the user's details are never dropped (2026-08-08:
 * "strength training with these exercises" logged as a bare activity type,
 * no notes). Two layers pinned:
 *  - notes passed properly land on the entry (the kind's notes field).
 *  - details the model misfiles into a wrong-but-present TEXT param
 *    (description on an activity) fold into notes instead of vanishing.
 */
module.exports = [
  {
    id: 'wellness-notes-never-dropped',
    name: 'log_wellness keeps notes, and folds misfiled text details into notes',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const direct = await AgentTools.handlers.log_wellness({
          kind: 'activity', activityType: 'Strength training', duration: 45,
          notes: 'bench press 3x8, squats 3x10, felt strong'
        });
        const directOk = direct.success && direct.entry.notes === 'bench press 3x8, squats 3x10, felt strong';

        const misfiled = await AgentTools.handlers.log_wellness({
          kind: 'activity', activityType: 'Strength training',
          description: 'deadlifts 5x5, overhead press 3x8'
        });
        const foldedOk = misfiled.success
          && (misfiled.entry.notes || '').includes('deadlifts 5x5');

        // A param the kind DOES consume is not duplicated into notes.
        const meal = await AgentTools.handlers.log_wellness({
          kind: 'meal', mealType: 'Lunch', description: 'dal and rice'
        });
        const mealOk = meal.success && meal.entry.description === 'dal and rice'
          && !(meal.entry.notes || '').includes('dal and rice');

        const pass = directOk && foldedOk && mealOk;
        return { pass, detail: JSON.stringify({ directOk, foldedOk, mealOk, foldedNotes: misfiled.entry && misfiled.entry.notes }) };
      });
    }
  }
];
