/**
 * Model journeys — the per-model scorecard (docs/COWORK_AGENT.md C8.8).
 * These answer "is this model better FOR THESE TASKS": each drives the full
 * agent (real prompts, real tools) and asserts both the CALLS made and the
 * OUTCOME. Minutes each; run with --model <name> (default qwen3.5:9b).
 *
 * Long generations are fire-and-poll: kick sendMessage off in one evaluate,
 * poll window.__evalChat with short evaluates — a minutes-long evaluate
 * holding the renderer has crashed the app.
 */
async function pollChat(page, timeoutMs = 5 * 60 * 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await page.evaluate(() => window.__evalChat);
    if (r) return r;
    await new Promise(res => setTimeout(res, 2000));
  }
  return { type: 'error', content: 'chat did not settle in time' };
}
module.exports = [
  {
    id: 'model-note-write',
    name: 'chat: create a note; pills + undo scope ride the reply',
    kind: 'model',
    async run({ page }) {
      return await page.evaluate(async () => {
        const conv = AgentService.createConversation();
        const res = await AgentService.sendMessage('Create a note titled "Eval Note" saying exactly: model journey. Use the create_note tool.', { convId: conv.id });
        await NotesApp.loadNotes?.();
        const created = (NotesApp.notes || []).some(n => n.title === 'Eval Note');
        const called = window.__eval.calls.some(c => c.name === 'create_note');
        const msg = [...conv.messages].reverse().find(m => m.role === 'assistant' && m.metadata);
        const pass = res?.type === 'text' && created && called
          && !!msg?.metadata?.records?.length && !!msg?.metadata?.undoScope;
        return { pass, detail: JSON.stringify({ type: res?.type, created, called, pills: msg?.metadata?.records?.length, undo: !!msg?.metadata?.undoScope }) };
      });
    }
  },
  {
    id: 'model-pdf-read',
    name: 'chat: answer a question from a PDF\'s contents (never the filename)',
    kind: 'model',
    async run({ page, docs }) {
      return await page.evaluate(async (dir) => {
        const conv = AgentService.createConversation();
        const res = await AgentService.sendMessage(`Read the file ${dir}/statement.pdf and tell me the closing balance. Use fs_read.`, { convId: conv.id });
        const readCalled = window.__eval.calls.some(c => c.name === 'fs_read' && /statement\.pdf/.test(c.args?.path || ''));
        const pass = res?.type === 'text' && readCalled && (res.content || '').includes('913.37');
        return { pass, detail: JSON.stringify({ type: res?.type, readCalled, content: (res?.content || '').slice(0, 80) }) };
      }, docs);
    }
  },
  {
    id: 'model-task-pipeline',
    name: 'task: plan → run → verify clean → recipe-eligible',
    kind: 'model',
    async run({ page, docs }) {
      // A minutes-long page.evaluate holding the renderer while a task runs
      // has crashed the app twice — start fire-and-forget, then poll with
      // SHORT evaluates from the node side.
      await page.evaluate((dir) => {
        window.__evalTask = { started: null };
        const conv = AgentService.createConversation();
        TaskService.start(
          `Read the file ${dir}/statement.txt and create a note titled "Eval Statement Note" containing the closing balance.`, conv.id
        ).then(r => {
          window.__evalTask.started = r;
          if (!r.error) TaskService.approve(r.taskId);
        }).catch(e => { window.__evalTask.started = { error: e.message }; });
      }, docs);
      const t0 = Date.now();
      while (Date.now() - t0 < 360000) {
        const st = await page.evaluate(() => {
          const s = window.__evalTask.started;
          if (!s) return { phase: 'planning' };
          if (s.error) return { phase: 'error', detail: s.error };
          const t = TaskService.get(s.taskId);
          return { phase: t.status, taskId: s.taskId, note: t.note, eligible: t.recipeEligible, toolLog: (t.toolLog || []).length };
        });
        if (st.phase === 'error') return { pass: false, detail: st.detail };
        if (['awaiting_user', 'paused'].includes(st.phase)) return { pass: false, detail: `stuck: ${st.phase} — ${st.note}` };
        if (['done', 'failed'].includes(st.phase)) {
          const pass = st.phase === 'done' && st.eligible === true && st.toolLog > 0;
          return { pass, detail: JSON.stringify(st) };
        }
        await new Promise(r => setTimeout(r, 3000));
      }
      return { pass: false, detail: 'task did not settle within 6 minutes' };
    }
  },
  {
    id: 'model-recipe-derive',
    name: 'model derives a recipe from the clean run (selects steps, names slots)',
    kind: 'model',
    async run({ page }) {
      return await page.evaluate(async () => {
        const task = TaskService._all().find(t => t && t.recipeEligible && t.toolLog && !t.recipeId);
        if (!task) return { pass: false, detail: 'no eligible task from prior journey' };
        const out = await TaskService.saveAsRecipe(task.id);
        if (out.error) return { pass: false, detail: out.error };
        const r = out.recipe;
        const pass = r.steps.length > 0 && r.steps.every(s => s.tool && s.args !== undefined);
        return { pass, detail: JSON.stringify({ name: r.name, steps: r.steps.map(s => s.tool), slots: (r.slots || []).map(s => s.name) }) };
      });
    }
  },
  {
    id: 'model-recipe-replay-via-chat',
    name: 'chat: the model replays a saved recipe with parameters',
    kind: 'model',
    async run({ page }) {
      await page.evaluate(() => {
        StorageManager.set('agent-recipes', [{
          id: 'rec_m1', name: 'note-for-topic', description: 'Create a summary note about a topic',
          slots: [{ name: 'topic', description: 'What the note is about' }],
          steps: [{ tool: 'create_note', args: { title: 'Summary: {{topic}}', content: 'Notes about {{topic}}.' } }],
          sourceGoal: 't', createdAt: new Date().toISOString(), uses: 0
        }]);
        AgentService._briefingCache.clear();
        const conv = AgentService.createConversation();
        window.__evalChat = null;
        AgentService.sendMessage('Run the note-for-topic recipe with topic "Geothermal".', { convId: conv.id })
          .then(r => { window.__evalChat = r; }).catch(e => { window.__evalChat = { type: 'error', content: e.message }; });
      });
      const res = await pollChat(page);
      return await page.evaluate(async (r) => {
        await NotesApp.loadNotes?.();
        const ran = window.__eval.calls.some(c => c.name === 'run_recipe');
        const made = (NotesApp.notes || []).some(n => n.title === 'Summary: Geothermal');
        return { pass: r?.type === 'text' && ran && made, detail: JSON.stringify({ type: r?.type, ran, made }) };
      }, res);
    }
  },
  {
    id: 'model-truncation-recovery',
    name: 'chat: a cut-off tool call gets the make-it-smaller nudge, never {} args',
    kind: 'model',
    async run({ page }) {
      await page.evaluate(() => {
        window.__evalWarns = [];
        window.__evalOrigWarn = console.warn.bind(console);
        console.warn = (...a) => { window.__evalWarns.push(a.join(' ')); window.__evalOrigWarn(...a); };
        window.__evalSavedCap = AgentService.defaultNumPredict;
        AgentService.defaultNumPredict = 200;
        const conv = AgentService.createConversation();
        conv.thinkMode = 'off';
        window.__evalChat = null;
        AgentService.sendMessage('Create a note titled Oceans whose content is a 400-word essay about oceans. Use the create_note tool.', { convId: conv.id })
          .then(r => { window.__evalChat = r; }).catch(e => { window.__evalChat = { type: 'error', content: e.message }; });
      });
      const res = await pollChat(page);
      return await page.evaluate(async (r) => {
        AgentService.defaultNumPredict = window.__evalSavedCap;
        console.warn = window.__evalOrigWarn;
        await NotesApp.loadNotes?.();
        const emptyArg = (NotesApp.notes || []).some(n => (!n.title || n.title === 'Untitled') && !(n.content || '').length);
        const nudged = window.__evalWarns.some(w => w.includes('unparseable arguments'));
        return { pass: nudged && !emptyArg, detail: JSON.stringify({ nudged, emptyArg, type: r?.type }) };
      }, res);
    }
  },
  {
    id: 'model-invoices-criterion',
    name: 'success criterion #6 (small): total two invoices into a note',
    kind: 'model',
    async run({ page, docs }) {
      await page.evaluate(async (dir) => {
        // Two tiny invoice files (text — the PDF path has its own journeys).
        await window.electronAgentFS.write(dir + '/invoices/inv-001.txt', 'INVOICE 001\nVendor: Acme\nTotal: $120.00\n');
        await window.electronAgentFS.write(dir + '/invoices/inv-002.txt', 'INVOICE 002\nVendor: Bolt\nTotal: $80.50\n');
        const conv = AgentService.createConversation();
        window.__evalChat = null;
        AgentService.sendMessage(
          `Read the two invoice files in ${dir}/invoices and create a note titled "Invoice Totals" with each vendor's total and the grand total. Use fs_list, fs_read and create_note.`,
          { convId: conv.id })
          .then(r => { window.__evalChat = r; }).catch(e => { window.__evalChat = { type: 'error', content: e.message }; });
      }, docs);
      const res = await pollChat(page);
      return await page.evaluate(async (r) => {
        await NotesApp.loadNotes?.();
        const note = (NotesApp.notes || []).find(n => /Invoice Totals/i.test(n.title || ''));
        const body = (note?.content || '') + ' ' + (r?.content || '');
        const grand = /200\.50|200\.5/.test(body);
        const reads = window.__eval.calls.filter(c => c.name === 'fs_read').length;
        return { pass: !!note && grand && reads >= 2, detail: JSON.stringify({ note: !!note, grand, reads, body: body.slice(0, 100) }) };
      }, res);
    }
  }
];
