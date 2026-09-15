/**
 * Wellness coach (docs/WELLNESS_COACH.md W1+W3+W7).
 *  - W1: trends() is pure arithmetic — streaks, BP drift, gaps — and quiet
 *    input means an EMPTY attention list (the section must have the right
 *    to not render).
 *  - The quick-log door pre-scopes the conversation (wellness tools ship
 *    whatever the wording) and greets.
 *  - W3: arm buttons create the review routines once, digest+context.
 *  - W7: wellness READS are untrusted-blocked; the WRITE stays.
 */
module.exports = [
  {
    id: 'wellness-trends-arithmetic',
    name: 'trends(): streaks, BP drift, gaps computed; quiet data → empty attention',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        const saved = WellnessApp.entries;
        const day = (n, hhmm = '09:00') => {
          const d = new Date();
          d.setDate(d.getDate() - n);
          return d.toISOString().slice(0, 10) + 'T' + hhmm;
        };
        try {
          // Quiet: nothing logged → nothing to say.
          WellnessApp.entries = [];
          const quiet = WellnessApp.trends();
          const quietOk = quiet.attention.length === 0 && quiet.today.length === 0;

          // A 4-day activity streak + BP drifting up (7d avg well above
          // the prior month's) + a weight habit gone quiet.
          const entries = [];
          for (let n = 0; n < 4; n++) entries.push({ id: 'a' + n, kind: 'activity', time: day(n), activityType: 'Run', duration: 30 });
          for (let n = 1; n <= 6; n++) entries.push({ id: 'b' + n, kind: 'bp', time: day(n), systolic: 138, diastolic: 90 });
          for (let n = 10; n <= 34; n += 5) entries.push({ id: 'c' + n, kind: 'bp', time: day(n), systolic: 122, diastolic: 80 });
          for (let n = 14; n <= 44; n += 2) entries.push({ id: 'w' + n, kind: 'weight', time: day(n), value: 80, unit: 'kg' });
          WellnessApp.entries = entries;
          const t = WellnessApp.trends();
          const streak = t.attention.find(a => a.id === 'activity-streak');
          const drift = t.attention.find(a => a.id === 'bp-drift-up');
          const gap = t.attention.find(a => a.id === 'gap-weight');
          const todayOk = t.today.some(x => x.kind === 'activity');
          const pass = quietOk && !!streak && /4-day/.test(streak.text)
            && !!drift && drift.tone === 'warn' && /138\/90/.test(drift.text)
            && !!gap && todayOk;
          return { pass, detail: JSON.stringify({ quietOk, streak: streak && streak.text, drift: drift && drift.text, gap: gap && gap.text, todayOk }) };
        } finally {
          WellnessApp.entries = saved;
        }
      });
    }
  },
  {
    id: 'wellness-quicklog-prescoped',
    name: 'the quick-log door pre-scopes wellness tools, bakes the instruction, and greets',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        const conv = AgentService.openScopedConversation({
          domains: ['wellness'],
          extraContext: 'test instruction log_wellness',
          greeting: 'What should I log?'
        });
        const domains = (conv.scopedDomains || []).includes('wellness');
        const extra = (conv.extraContext || '').includes('log_wellness');
        const greeted = conv.messages.some(m => m.role === 'assistant' && /What should I log/.test(m.content));
        const toolShips = AgentTools.definitionsFor('did some exercise stuff', conv.scopedDomains)
          .some(d => d.function.name === 'log_wellness');
        const pass = domains && extra && greeted && toolShips;
        return { pass, detail: JSON.stringify({ domains, extra, greeted, toolShips }) };
      });
    }
  },
  {
    id: 'wellness-reviews-armed-once',
    name: 'arm buttons create the coach routines (digest, context, scheduled) exactly once',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        WellnessApp.armReview('weekly');
        WellnessApp.armReview('weekly');   // idempotent
        WellnessApp.armReview('daily');
        const routines = NotePrompts.list().filter(n => NotePrompts.config(n).offline);
        const weekly = routines.filter(n => n.title === 'Wellness Review');
        const daily = routines.filter(n => n.title === 'Daily Wellness Check-in');
        const wcfg = weekly[0] && NotePrompts.config(weekly[0]);
        const dcfg = daily[0] && NotePrompts.config(daily[0]);
        const pass = weekly.length === 1 && daily.length === 1
          && wcfg.runMode === 'digest' && wcfg.useContext === true && !wcfg.web
          && wcfg.interval === 'weekly' && wcfg.time === '09:00'
          && dcfg.interval === 'daily' && dcfg.time === '07:30'
          && /wellness_summary/.test(NotePrompts.bodyText(weekly[0]))
          && /never .*diagnos|never a diagnosis|never diagnose/i.test(NotePrompts.bodyText(weekly[0]));
        return { pass, detail: JSON.stringify({ weekly: weekly.length, daily: daily.length, wcfg, dcfg }) };
      });
    }
  },
  {
    id: 'wellness-reads-untrusted-blocked',
    name: 'W7: wellness reads are untrusted-blocked; the write stays available',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        const blocked = AgentService.UNTRUSTED_BLOCKED_TOOLS;
        const pass = blocked.has('list_wellness') && blocked.has('wellness_summary')
          && blocked.has('update_wellness') && blocked.has('delete_wellness')
          && !blocked.has('log_wellness');
        return { pass, detail: JSON.stringify({ list: blocked.has('list_wellness'), summary: blocked.has('wellness_summary'), update: blocked.has('update_wellness'), del: blocked.has('delete_wellness'), logStays: !blocked.has('log_wellness') }) };
      });
    }
  }
];
