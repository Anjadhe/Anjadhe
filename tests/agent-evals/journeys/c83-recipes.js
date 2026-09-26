/**
 * C8.3 regression net — recipes: replay, slots, divergence, eligibility.
 */
module.exports = [
  {
    id: 'c83-replay-slot-fill',
    name: 'run_recipe substitutes slots and counts uses',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        StorageManager.set('agent-recipes', [{
          id: 'rec_e1', name: 'note-for-topic', description: 'test',
          slots: [{ name: 'topic', description: 'topic' }],
          steps: [{ tool: 'create_note', args: { title: 'Eval: {{topic}}', content: 'about {{topic}}' } }],
          sourceGoal: 't', createdAt: new Date().toISOString(), uses: 0
        }]);
        const out = await AgentTools.execute('run_recipe', { name: 'note-for-topic', params: { topic: 'Wind Power' } });
        await NotesApp.loadNotes?.();
        const found = (NotesApp.notes || []).some(n => n.title === 'Eval: Wind Power');
        const uses = RecipeService.get('note-for-topic')?.uses;
        return { pass: out?.ok === true && found && uses === 1, detail: JSON.stringify({ ok: out?.ok, found, uses }) };
      });
    }
  },
  {
    id: 'c83-missing-param',
    name: 'missing recipe parameter is a named error',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        StorageManager.set('agent-recipes', [{
          id: 'rec_e2', name: 'needs-param', description: 't',
          slots: [{ name: 'city', description: 'which city' }],
          steps: [{ tool: 'create_note', args: { title: '{{city}}' } }],
          sourceGoal: 't', createdAt: new Date().toISOString(), uses: 0
        }]);
        const out = await RecipeService.run('needs-param', {});
        return { pass: !!out.error && out.error.includes('city'), detail: out.error };
      });
    }
  },
  {
    id: 'c83-divergence-handback',
    name: 'a failing step stops the replay with repair context',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        StorageManager.set('agent-recipes', [{
          id: 'rec_e3', name: 'diverges', description: 't', slots: [],
          steps: [
            { tool: 'create_note', args: { title: 'Div A', content: '1' } },
            { tool: 'fs_read', args: { path: '/nonexistent-eval-path/x.txt' } },
            { tool: 'create_note', args: { title: 'Div C', content: '3' } }
          ],
          sourceGoal: 't', createdAt: new Date().toISOString(), uses: 0
        }]);
        const out = await AgentTools.execute('run_recipe', { name: 'diverges' });
        await NotesApp.loadNotes?.();
        const a = (NotesApp.notes || []).some(n => n.title === 'Div A');
        const c = (NotesApp.notes || []).some(n => n.title === 'Div C');
        const pass = out?.ok === false && out.failedStep?.step === 2 && out.remainingSteps?.length === 1
          && !!out.advice && a && !c && out.completedSteps?.length === 1;
        return { pass, detail: JSON.stringify({ failed: out?.failedStep?.step, a, c }) };
      });
    }
  },
  {
    id: 'c83-dirty-verify-ineligible',
    name: 'a failed verdict blocks recipe eligibility and prunes the log',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({
          id: 'task_e_neg', conversationId: null, goal: 'neg',
          plan: [{ step: 's', tools: [], status: 'done', note: '', result: 'r' }],
          status: 'verifying', note: '', stepIndex: 1, retried: true, toolCalls: 1,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          log: [], toolLog: [{ step: 1, tool: 'create_note', args: { title: 'x' }, ok: true }]
        });
        StorageManager.set('agent-tasks', tasks);
        await TaskService._report('task_e_neg', [{ ok: false, issue: 'nope' }]);
        const t = TaskService.get('task_e_neg');
        return { pass: t.recipeEligible === false && !t.toolLog, detail: JSON.stringify({ eligible: t.recipeEligible, hasLog: !!t.toolLog }) };
      });
    }
  },
  {
    id: 'c83-briefing-lists-recipes',
    name: 'saved recipes ride the briefing with their params',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        StorageManager.set('agent-recipes', [{
          id: 'rec_e4', name: 'weekly-filing', description: 'Files the weekly report',
          slots: [{ name: 'week', description: 'w' }],
          steps: [{ tool: 'create_note', args: { title: 'w{{week}}' } }],
          sourceGoal: 't', createdAt: new Date().toISOString(), uses: 0
        }]);
        AgentService._briefingCache.clear();
        const b = AgentService._buildBriefing();
        const pass = b.includes('weekly-filing') && b.includes('run_recipe') && b.includes('week');
        return { pass, detail: pass ? 'listed' : 'missing from briefing' };
      });
    }
  }
];
