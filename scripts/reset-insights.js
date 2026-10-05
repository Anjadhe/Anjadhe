/*
 * Reset email + text insights from the console.
 *
 * The same thing is a button now: Settings › Developer › Reset insights
 * (EmailApp.resetInsights). This file is the console form of it, for
 * scripted testing. Paste it into nenva's DevTools console, then:
 *
 *   nenvaInsightsReset.preview()          counts what would go, changes nothing
 *   nenvaInsightsReset.run({ days: 14 })  clears it and reads the last 14 days again
 *
 * Options: { tasks: 'untouched' (default) | 'all' | 'none' } for the tasks
 * made from messages.
 */
(() => {
    window.nenvaInsightsReset = {
        preview(opts = {}) {
            const { taskIds, ...p } = EmailApp.resetInsightsPlan(opts);
            const out = { ...p, tasksRemoved: taskIds.length };
            console.table(out);
            return out;
        },
        run(opts = {}) {
            const { taskIds, ...out } = EmailApp.resetInsights(opts);
            console.table(out);
            return out;
        }
    };
    console.log('Loaded. nenvaInsightsReset.preview(), then nenvaInsightsReset.run({ days: 14 }).');
})();
