/**
 * C9.1–C9.3 regression net — typed plans (foreach), harness-carried state
 * (results map), typed step endings. Deterministic: the model is stubbed at
 * the TaskService seam. The engine contract under test: the model plans the
 * shape and performs one unit per call; the harness owns loop, state,
 * evidence.
 */

module.exports = [
  {
    id: 'c9-plan-schema-foreach',
    name: 'plan schema carries kind/items_from/per_item; parse validates and downgrades',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        let captured = null;
        const origChat = TaskService._chat;
        TaskService._chat = async (params) => {
          captured = params.format;
          return { message: { content: '{"steps":[]}' } };
        };
        await TaskService._planChat('goal', TaskService._availableGroups(), 'core');
        TaskService._chat = origChat;
        const schemaStr = JSON.stringify(captured);
        const schemaOk = schemaStr.includes('"foreach"') && schemaStr.includes('items_from') && schemaStr.includes('per_item');

        const parse = (steps) => TaskService._parsePlanSteps({ message: { content: JSON.stringify({ steps }) } }, []);
        const valid = parse([
          { kind: 'single', step: 'list the movies', tools: [], items_from: '', per_item: '', check: { kind: 'none', arg: '' } },
          { kind: 'foreach', step: 'look each up', tools: [], items_from: '$1', per_item: 'look it up', check: { kind: 'none', arg: '' } }
        ]);
        const forwardRef = parse([
          { kind: 'foreach', step: 'x', tools: [], items_from: '$3', per_item: 'y', check: { kind: 'none', arg: '' } }
        ]);
        const noPerItem = parse([
          { kind: 'single', step: 'a', tools: [], items_from: '', per_item: '', check: { kind: 'none', arg: '' } },
          { kind: 'foreach', step: 'b', tools: [], items_from: '$1', per_item: '  ', check: { kind: 'none', arg: '' } }
        ]);
        const parseOk = valid[1].kind === 'foreach' && valid[1].itemsFrom === 1 && valid[1].perItem === 'look it up'
          && forwardRef[0].kind === 'single' && noPerItem[1].kind === 'single';
        return { pass: schemaOk && parseOk, detail: JSON.stringify({ schemaOk, parseOk }) };
      });
    }
  },
  {
    id: 'c9-foreach-chunking',
    name: 'foreach runs harness-owned chunks of 5 and aggregates all rows',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const items = Array.from({ length: 12 }, (_, i) => `Item${String(i + 1).padStart(2, '0')}`);
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({
          id: 'task_c9f', conversationId: null, goal: 'look up 12 things',
          plan: [
            { kind: 'single', step: 'list them', tools: [], status: 'done', note: '', result: 'listed' },
            { kind: 'foreach', step: 'look each up', tools: [], status: 'active', note: '', itemsFrom: 1, perItem: 'look it up' }
          ],
          results: { '1': { items } },
          status: 'running', note: '', stepIndex: 1, retried: false, toolCalls: 0,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: []
        });
        StorageManager.set('agent-tasks', tasks);

        const itemsFrom = (messages) => {
          const m = messages.map(x => x.content || '').join('\n').match(/Items \(\d+\):\n([\s\S]*?)$/);
          if (!m) return [];
          return [...m[1].matchAll(/^\d+\. (.+)$/gm)].map(x => x[1].trim());
        };
        const chunkSizes = [];
        const origChat = TaskService._chat;
        TaskService._chat = async (params) => {
          if (!params.format) return { message: { content: 'checked them', tool_calls: [] } };
          const asked = itemsFrom(params.messages);
          chunkSizes.push(asked.length);
          return { message: { content: JSON.stringify({
            status: 'done',
            rows: asked.map(it => ({ item: it, data: `data for ${it}` })),
            note: 'batch done'
          }) } };
        };
        const out = await TaskService._runForeach('task_c9f', 1);
        TaskService._chat = origChat;

        const t = TaskService.get('task_c9f');
        const rows = t.results && t.results['2'] && t.results['2'].rows;
        const pass = out.ok === true
          && JSON.stringify(chunkSizes) === JSON.stringify([5, 5, 2])
          && Array.isArray(rows) && rows.length === 12
          && rows[0].data === 'data for Item01'
          && /covered all 12 items/.test(out.note)
          && t.plan[1].note === '12/12 items';
        return { pass, detail: JSON.stringify({ chunkSizes, rowCount: rows ? rows.length : 0, note: out.note }) };
      });
    }
  },
  {
    id: 'c9-foreach-count-check-retry',
    name: 'a chunk that drops an item gets one informed retry scoped to the missing',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const items = ['Alpha One', 'Beta Two', 'Gamma Three', 'Delta Four', 'Epsilon Five', 'Zeta Six'];
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({
          id: 'task_c9r', conversationId: null, goal: 'look up 6 things',
          plan: [
            { kind: 'single', step: 'list', tools: [], status: 'done', note: '', result: 'listed' },
            { kind: 'foreach', step: 'look each up', tools: [], status: 'active', note: '', itemsFrom: 1, perItem: 'look it up' }
          ],
          results: { '1': { items } },
          status: 'running', note: '', stepIndex: 1, retried: false, toolCalls: 0,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: []
        });
        StorageManager.set('agent-tasks', tasks);

        const itemsFrom = (messages) => {
          const m = messages.map(x => x.content || '').join('\n').match(/Items \(\d+\):\n([\s\S]*?)$/);
          if (!m) return [];
          return [...m[1].matchAll(/^\d+\. (.+)$/gm)].map(x => x[1].trim());
        };
        let retryPrompts = 0;
        const origChat = TaskService._chat;
        TaskService._chat = async (params) => {
          if (!params.format) return { message: { content: 'checked', tool_calls: [] } };
          const joined = params.messages.map(x => x.content || '').join('\n');
          const asked = itemsFrom(params.messages);
          const isRetry = /MISSED/.test(joined);
          if (isRetry) retryPrompts++;
          // First pass silently drops the last item — the small-model
          // failure the count check exists to catch. Retries answer fully.
          const rows = (isRetry ? asked : asked.slice(0, -1))
            .map(it => ({ item: it, data: `found ${it}` }));
          return { message: { content: JSON.stringify({ status: 'done', rows, note: 'b' }) } };
        };
        const out = await TaskService._runForeach('task_c9r', 1);
        TaskService._chat = origChat;

        const rows = TaskService.get('task_c9r').results['2'].rows;
        const pass = out.ok === true && rows.length === 6 && retryPrompts >= 1;
        return { pass, detail: JSON.stringify({ rowCount: rows.length, retryPrompts, note: out.note }) };
      });
    }
  },
  {
    id: 'c9-foreach-unknown-rows',
    name: 'unresolved items get explicit placeholder rows (no silent holes) and are re-attempted on retry',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const items = ['Alpha One', 'Beta Two', 'Gamma Three'];
        const seed = () => {
          const tasks = StorageManager.get('agent-tasks') || [];
          const existing = tasks.find(x => x.id === 'task_c9u');
          if (!existing) {
            tasks.unshift({
              id: 'task_c9u', conversationId: null, goal: 'look up 3 things',
              plan: [
                { kind: 'single', step: 'list', tools: [], status: 'done', note: '', result: 'listed' },
                { kind: 'foreach', step: 'look each up', tools: [], status: 'active', note: '', itemsFrom: 1, perItem: 'look it up' }
              ],
              results: { '1': { items } },
              status: 'running', note: '', stepIndex: 1, retried: false, toolCalls: 0,
              createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: []
            });
            StorageManager.set('agent-tasks', tasks);
          }
        };
        seed();
        const itemsFrom = (messages) => {
          const m = messages.map(x => x.content || '').join('\n').match(/Items \(\d+\):\n([\s\S]*?)$/);
          if (!m) return [];
          return [...m[1].matchAll(/^\d+\. (.+)$/gm)].map(x => x[1].trim());
        };
        const origChat = TaskService._chat;
        // Pass 1: 'Gamma Three' never resolves, even on the informed retry.
        TaskService._chat = async (params) => {
          if (!params.format) return { message: { content: 'checked', tool_calls: [] } };
          const asked = itemsFrom(params.messages).filter(it => it !== 'Gamma Three');
          return { message: { content: JSON.stringify({ status: 'done', rows: asked.map(it => ({ item: it, data: 'found' })), note: 'b' }) } };
        };
        const out1 = await TaskService._runForeach('task_c9u', 1);
        const rows1 = TaskService.get('task_c9u').results['2'].rows;
        // I9 (2026-08-21): every batch here CONCLUDED cleanly (typed 'done',
        // nothing broke), so the row-less item settles as an explicit
        // UNVERIFIED row — unresolved, not proven absent — and the step is
        // NOT failed. The old law (unknown row + failed step) burned the
        // step over completed work; mismatch is not absence.
        const unresolvedRow = rows1.find(r => r.item === 'Gamma Three');
        const holeFilled = out1.ok === true && rows1.length === 3
          && unresolvedRow && unresolvedRow.unverified === true
          && /unresolved/.test(unresolvedRow.data)
          && /unverified/.test(out1.note);

        // Pass 2 (verify-retry): the unknown row is re-attempted and resolves.
        TaskService._chat = async (params) => {
          if (!params.format) return { message: { content: 'checked', tool_calls: [] } };
          const asked = itemsFrom(params.messages);
          return { message: { content: JSON.stringify({ status: 'done', rows: asked.map(it => ({ item: it, data: 'found on retry' })), note: 'b' }) } };
        };
        const out2 = await TaskService._runForeach('task_c9u', 1, 'Gamma Three was unknown');
        TaskService._chat = origChat;
        const rows2 = TaskService.get('task_c9u').results['2'].rows;
        const gamma = rows2.find(r => r.item === 'Gamma Three');
        const retried = out2.ok === true && rows2.length === 3
          && gamma && !gamma.unknown && !gamma.unverified && gamma.data === 'found on retry';
        return { pass: holeFilled && retried, detail: JSON.stringify({ holeFilled, retried, note1: out1.note }) };
      });
    }
  },
  {
    id: 'c9-typed-ending',
    name: 'typed closing replaces sentinels; items land in the results map for a downstream foreach',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({
          id: 'task_c9t', conversationId: null, goal: 'typed ending test',
          plan: [
            { kind: 'single', step: 'produce the list', tools: [], status: 'active', note: '' },
            { kind: 'foreach', step: 'process each', tools: [], status: 'pending', note: '', itemsFrom: 1, perItem: 'process it' }
          ],
          results: {},
          status: 'running', note: '', stepIndex: 0, retried: false, toolCalls: 0,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: []
        });
        StorageManager.set('agent-tasks', tasks);

        let closingSchema = null;
        const origChat = TaskService._chat;
        TaskService._chat = async (params) => {
          // Loop reply: plain prose, NO sentinel — under the old contract
          // this would have been guessed at; now the closing call decides.
          if (!params.format) return { message: { content: 'Here is what I gathered.', tool_calls: [] } };
          closingSchema = params.format;
          return { message: { content: JSON.stringify({
            status: 'done', result: 'THE CONCRETE DATA', note: 'produced 2 items',
            items: ['first thing', 'second thing']
          }) } };
        };
        const out = await TaskService._runStep('task_c9t', 0);
        TaskService._chat = origChat;

        const res = TaskService.get('task_c9t').results['1'];
        const schemaAsksItems = JSON.stringify(closingSchema || {}).includes('"items"');
        const pass = out.ok === true && out.result === 'THE CONCRETE DATA'
          && schemaAsksItems && res && Array.isArray(res.items) && res.items.length === 2;
        return { pass, detail: JSON.stringify({ ok: out.ok, schemaAsksItems, items: res && res.items }) };
      });
    }
  },
  {
    id: 'c9-typed-ending-failed',
    name: 'a closing that reports failed fails the step even without a FAILED: sentinel',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({
          id: 'task_c9x', conversationId: null, goal: 'failed ending test',
          plan: [{ kind: 'single', step: 'do a thing', tools: [], status: 'active', note: '' }],
          results: {},
          status: 'running', note: '', stepIndex: 0, retried: false, toolCalls: 0,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: []
        });
        StorageManager.set('agent-tasks', tasks);
        const origChat = TaskService._chat;
        TaskService._chat = async (params) => {
          if (!params.format) return { message: { content: 'That mostly went fine I think.', tool_calls: [] } };
          return { message: { content: JSON.stringify({ status: 'failed', result: '', note: 'the source was unreachable' }) } };
        };
        const out = await TaskService._runStep('task_c9x', 0);
        TaskService._chat = origChat;
        const pass = out.ok === false && /unreachable/.test(out.note);
        return { pass, detail: JSON.stringify(out) };
      });
    }
  },
  {
    id: 'c9-plan-shape-lint',
    name: 'a per-item goal with a mega-step plan gets one revision, then the harness fan-out plan (finding #46)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const mega = JSON.stringify({ steps: [{ kind: 'single', step: 'Search availability for the whole list of movies', tools: [], items_from: '', per_item: '', check: { kind: 'none', arg: '' } }] });
        // Case 1: the model repeats the mega-step on revision → harness
        // plan, with GOAL-SPECIFIC wording from the fill-in call (the
        // structure is the harness's; the words on the approval card must
        // be the goal's, not "list every item the goal asks to process").
        let planCalls = 0;
        const origChat = TaskService._chat;
        TaskService._chat = async (params) => {
          if (params.logTag === 'task-plan') { planCalls++; return { message: { content: mega } }; }
          if (params.logTag === 'task-plan-fill') return { message: { content: JSON.stringify({
            list_step: 'Extract the 100 movie titles from the list',
            work_step: 'Find streaming availability for each movie in small batches',
            per_item: 'Search streaming availability for this movie',
            deliver_step: 'Compile the availability results into a table'
          }) } };
          return { message: { content: '{}' } };
        };
        const r1 = await TaskService.start('For each of the 100 movies in the list, find streaming availability', null);
        const t1 = TaskService.get(r1.taskId);
        const fallbackUsed = planCalls === 2 && t1.status === 'awaiting_user'
          && t1.plan.length === 3 && t1.plan[0].kind === 'single' && t1.plan[1].kind === 'foreach'
          && t1.plan[1].itemsFrom === 1
          && t1.plan[0].step === 'Extract the 100 movie titles from the list'
          && t1.plan[1].perItem === 'Search streaming availability for this movie'
          && t1.plan[2].kind === 'single'
          && t1.plan[2].step === 'Compile the availability results into a table';
        TaskService.cancel(r1.taskId);

        // Case 2: the revision emits a proper foreach → it is accepted.
        const good = JSON.stringify({ steps: [
          { kind: 'single', step: 'List the movies', tools: [], items_from: '', per_item: '', check: { kind: 'none', arg: '' } },
          { kind: 'foreach', step: 'Look each movie up', tools: [], items_from: '$1', per_item: 'find availability', check: { kind: 'none', arg: '' } }
        ] });
        let n = 0;
        TaskService._chat = async (params) => {
          if (params.logTag === 'task-plan') { n++; return { message: { content: n === 1 ? mega : good } }; }
          return { message: { content: '{}' } };
        };
        // An accepted foreach-last revision gains the harness deliver step.
        const r2 = await TaskService.start('For each of the 100 movies in the list, find streaming availability', null);
        const t2 = TaskService.get(r2.taskId);
        const revisionAccepted = n === 2 && t2.plan.length === 3
          && t2.plan[1].kind === 'foreach' && t2.plan[1].perItem === 'find availability'
          && t2.plan[2].kind === 'single' && /Compile the per-item results/.test(t2.plan[2].step);
        TaskService.cancel(r2.taskId);

        // Case 3: a non-item goal never triggers the lint.
        let n3 = 0;
        TaskService._chat = async (params) => {
          if (params.logTag === 'task-plan') { n3++; return { message: { content: JSON.stringify({ steps: [{ kind: 'single', step: 'write the note', tools: [], items_from: '', per_item: '', check: { kind: 'none', arg: '' } }] }) } }; }
          return { message: { content: '{}' } };
        };
        const r3 = await TaskService.start('Write me a note about my week', null);
        const lintQuiet = n3 === 1 && TaskService.get(r3.taskId).plan.length === 1;
        TaskService.cancel(r3.taskId);
        TaskService._chat = origChat;

        const pass = fallbackUsed && revisionAccepted && lintQuiet;
        return { pass, detail: JSON.stringify({ fallbackUsed, revisionAccepted, lintQuiet, planCalls }) };
      });
    }
  },
  {
    id: 'c9-journal-exactly-once',
    name: 'a completed WRITE replays from the run journal on re-run; activity + prune ride the report (C9.5)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({
          id: 'task_c9j', conversationId: null, goal: 'journal test',
          plan: [{ kind: 'single', step: 'make the note', tools: [], status: 'active', note: '' }],
          results: {},
          status: 'running', note: '', stepIndex: 0, retried: false, toolCalls: 0,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: []
        });
        StorageManager.set('agent-tasks', tasks);
        localStorage.removeItem('task-journal-task_c9j');
        window.__eval.stubs.create_note = { created: true, noteId: 'n_journal' };
        const origPerm = AgentService._resolvePermission;
        AgentService._resolvePermission = async () => ({ decision: 'allow' });
        const origChat = TaskService._chat;
        const mkChat = () => {
          let n = 0;
          return async (params) => {
            if (params.format) return { message: { content: JSON.stringify({ status: 'done', result: 'made it', note: 'n' }) } };
            n++;
            if (n === 1) return { message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'create_note', arguments: '{"title":"Journal Test","content":"x"}' } }] } };
            return { message: { content: 'DONE: made it', tool_calls: [] } };
          };
        };
        const unitOpts = { roundCap: 4, closing: { schema: { type: 'object', properties: { status: { type: 'string', enum: ['done', 'failed'] }, result: { type: 'string' }, note: { type: 'string' } }, required: ['status', 'result', 'note'] }, instruction: 'report' } };
        const msgs = () => [{ role: 'system', content: 's' }, { role: 'user', content: 'make the note' }];

        TaskService._chat = mkChat();
        const before = window.__eval.calls.length;
        await TaskService._runUnit('task_c9j', 0, msgs(), [], unitOpts);
        const firstExecs = window.__eval.calls.length - before;

        // Second run of the same unit (a gate re-run / resume): the write
        // must REPLAY from the journal, not execute again.
        TaskService._chat = mkChat();
        const mid = window.__eval.calls.length;
        const m2 = msgs();
        await TaskService._runUnit('task_c9j', 0, m2, [], unitOpts);
        const secondExecs = window.__eval.calls.length - mid;
        const replayedResult = m2.filter(m => m.role === 'tool').some(m => /n_journal/.test(m.content));

        // Report: activity derives from the journal, then the journal dies.
        await TaskService._report('task_c9j', null);
        TaskService._chat = origChat;
        AgentService._resolvePermission = origPerm;
        delete window.__eval.stubs.create_note;
        const t = TaskService.get('task_c9j');
        const pass = firstExecs === 1 && secondExecs === 0 && replayedResult
          && /create note/.test(t.activity || '')
          && localStorage.getItem('task-journal-task_c9j') === null;
        return { pass, detail: JSON.stringify({ firstExecs, secondExecs, replayedResult, activity: t.activity }) };
      });
    }
  },
  {
    id: 'c9-recite-and-fold',
    name: 'long units get recitation every 4 rounds and ONE transcript fold past 24k (C9.6)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({
          id: 'task_c9f6', conversationId: null, goal: 'long unit',
          plan: [{ kind: 'single', step: 'read a lot', tools: [], status: 'active', note: '' }],
          results: {},
          status: 'running', note: '', stepIndex: 0, retried: false, toolCalls: 0,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: []
        });
        StorageManager.set('agent-tasks', tasks);
        window.__eval.stubs.list_notes = { notes: 'x'.repeat(7000) };
        const origPerm = AgentService._resolvePermission;
        AgentService._resolvePermission = async () => ({ decision: 'allow' });
        const origChat = TaskService._chat;
        let n = 0;
        TaskService._chat = async (params) => {
          if (params.format) return { message: { content: JSON.stringify({ status: 'done', result: 'r', note: 'n' }) } };
          n++;
          if (n <= 6) return { message: { content: '', tool_calls: [{ id: 'c' + n, function: { name: 'list_notes', arguments: JSON.stringify({ query: 'q' + n }) } }] } };
          return { message: { content: 'DONE: r', tool_calls: [] } };
        };
        const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'read a lot' }];
        await TaskService._runUnit('task_c9f6', 0, messages, [], {
          roundCap: 10,
          recite: 'You are on step #1: "read a lot".',
          closing: { schema: { type: 'object', properties: { status: { type: 'string', enum: ['done', 'failed'] }, result: { type: 'string' }, note: { type: 'string' } }, required: ['status', 'result', 'note'] }, instruction: 'report' }
        });
        TaskService._chat = origChat;
        AgentService._resolvePermission = origPerm;
        delete window.__eval.stubs.list_notes;
        const recitations = messages.filter(m => m.role === 'user' && /^Progress check:/.test(m.content || '')).length;
        const foldedMsgs = messages.filter(m => m.role === 'tool' && /^\(earlier .* result folded/.test(m.content || '')).length;
        const intactTail = messages.filter(m => m.role === 'tool' && !/^\(earlier/.test(m.content || '')).length;
        const pass = recitations >= 1 && foldedMsgs >= 1 && intactTail >= 1;
        return { pass, detail: JSON.stringify({ recitations, foldedMsgs, intactTail, rounds: n }) };
      });
    }
  },
  {
    id: 'c9-model-routing',
    name: 'harness routes by capability: vision call to a vision model, task-grade advice on the card (never silent swaps)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        AgentService.conversations.push({ id: 'conv_c9m', messages: [
          { role: 'user', content: 'find these movies',
            attachments: [{ kind: 'image', name: 'list.png', dataUrl: 'data:image/png;base64,AAAA' }] }
        ], updatedAt: new Date().toISOString() });
        const orig = {
          vision: AgentService.supportsVision, ensure: AgentService.ensureVisionInfo,
          grade: AgentService.isTaskGrade, list: AgentService.getModelList,
          entry: AgentService.getActiveEntry, chat: TaskService._chat
        };
        // Active brain: no vision, not task-grade. Installed: a vision model
        // and a task-grade model.
        AgentService.ensureVisionInfo = async () => {};
        AgentService.getActiveEntry = () => ({ engine: 'llamacpp', model: 'chat-brain' });
        AgentService.supportsVision = (e) => !!e && e.model === 'vision-brain';
        AgentService.isTaskGrade = (e) => !!e && e.model === 'task-brain';
        AgentService.getModelList = () => [
          { id: 'm1', engine: 'llamacpp', model: 'vision-brain' },
          { id: 'm2', engine: 'llamacpp', model: 'task-brain' }
        ];
        let extractModel = 'NOT-CALLED';
        TaskService._chat = async (params) => {
          if (params.logTag === 'task-image-extract') { extractModel = params.model || null; return { message: { content: '1. A\n2. B' } }; }
          if (params.logTag === 'task-plan') return { message: { content: JSON.stringify({ steps: [
            { kind: 'single', step: 'do it', tools: [], items_from: '', per_item: '', check: { kind: 'none', arg: '' } }
          ] }) } };
          return { message: { content: '{}' } };
        };
        const r = await TaskService.start('Find where to watch these movies', 'conv_c9m');
        Object.assign(AgentService, { supportsVision: orig.vision, ensureVisionInfo: orig.ensure, isTaskGrade: orig.grade, getModelList: orig.list, getActiveEntry: orig.entry });
        TaskService._chat = orig.chat;
        const t = TaskService.get(r.taskId);
        const pass = extractModel === 'vision-brain'
          && t.brainAdvice && t.brainAdvice.recommended === 'task-brain'
          && t.brainAdvice.current === 'chat-brain'
          && /1\. A/.test(t.context || '');
        TaskService.cancel(r.taskId);
        return { pass, detail: JSON.stringify({ extractModel, advice: t.brainAdvice }) };
      });
    }
  },
  {
    id: 'c9-intake-gate',
    name: 'a goal referencing absent material stops at intake, before planning (I1)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        let intakeCalls = 0;
        const origChat = TaskService._chat;
        TaskService._chat = async (params) => {
          if (params.logTag === 'task-intake') {
            intakeCalls++;
            return { message: { content: JSON.stringify({ ready: false, missing: 'the movie list the goal refers to' }) } };
          }
          if (params.logTag === 'task-plan') return { message: { content: JSON.stringify({ steps: [
            { kind: 'single', step: 'write it', tools: [], items_from: '', per_item: '', check: { kind: 'none', arg: '' } }
          ] }) } };
          return { message: { content: '{}' } };
        };
        const r = await TaskService.start('Find availability for each movie in the provided list', null);
        const gated = !!r.error && /missing input/.test(r.error);
        const t = TaskService.list().find(x => x.goal.startsWith('Find availability'));
        const noted = t && t.status === 'failed' && /Can't start:/.test(t.note) && t.plan.length === 0;

        // A goal with no material references never pays for the check.
        const before = intakeCalls;
        const r2 = await TaskService.start('Write a note about my week', null);
        const skipped = intakeCalls === before && !r2.error;
        TaskService.cancel(r2.taskId);
        TaskService._chat = origChat;
        return { pass: gated && noted && skipped, detail: JSON.stringify({ gated, noted, skipped, intakeCalls }) };
      });
    }
  },
  {
    id: 'c9-step-gate-pipeline',
    name: 'the run loop gates each step: an items-less producer is re-run before the foreach consumes it (I3)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        AgentService.conversations.push({ id: 'conv_c9w', messages: [], updatedAt: new Date().toISOString() });
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({
          id: 'task_c9w', conversationId: 'conv_c9w', goal: 'look up two things',
          plan: [
            { kind: 'single', step: 'list them', tools: [], status: 'pending', note: '' },
            { kind: 'foreach', step: 'look each up', tools: [], status: 'pending', note: '', itemsFrom: 1, perItem: 'look it up' }
          ],
          results: {},
          status: 'running', note: '', stepIndex: 0, retried: false, toolCalls: 0,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: []
        });
        StorageManager.set('agent-tasks', tasks);
        TaskService._controls.set('task_c9w', { pause: false, cancel: false });
        let listClosings = 0;
        const origChat = TaskService._chat;
        TaskService._chat = async (params) => {
          const tag = params.logTag;
          if (tag === 'task-step') return { message: { content: 'Here is the list.', tool_calls: [] } };
          if (tag === 'task-close') {
            const joined = params.messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
            if (/Items \(\d+\)/.test(joined)) {
              const asked = [...joined.matchAll(/^\d+\. (.+)$/gm)].map(x => x[1].trim()).slice(-2);
              return { message: { content: JSON.stringify({ status: 'done', rows: asked.map(it => ({ item: it, data: 'found' })), note: 'b' }) } };
            }
            listClosings++;
            // First closing forgets the items; the gate must force a re-run.
            return { message: { content: JSON.stringify(listClosings === 1
              ? { status: 'done', result: 'produced the list but kept it to myself', note: 'n', items: [] }
              : { status: 'done', result: 'the two things', note: 'n', items: ['Alpha', 'Beta'] }) } };
          }
          if (tag === 'task-verify') return { message: { content: '1. OK\n2. OK\nGOAL: achieved', tool_calls: [] } };
          if (tag === 'task-verdicts') return { message: { content: JSON.stringify({
            verdicts: [{ step: 1, ok: true, issue: '' }, { step: 2, ok: true, issue: '' }],
            goal: { achieved: true, missing: '' } }) } };
          return { message: { content: '{}' } };
        };
        await TaskService._run('task_c9w');
        TaskService._chat = origChat;
        const t = TaskService.get('task_c9w');
        const conv = AgentService.conversations.find(c => c.id === 'conv_c9w');
        const report = conv && conv.messages.length ? conv.messages[conv.messages.length - 1].content : '';
        const pass = listClosings === 2
          && t.status === 'done'
          && t.plan.every(s => s.status === 'done')
          && /Alpha: found/.test(report) && /Beta: found/.test(report);
        return { pass, detail: JSON.stringify({ listClosings, status: t.status, steps: t.plan.map(s => s.status), reported: /Alpha: found/.test(report) }) };
      });
    }
  },
  {
    id: 'c9-image-context',
    name: 'attached-image data is transcribed into task context; text attachments fold into the snapshot (finding #48)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        AgentService.conversations.push({ id: 'conv_c9i', messages: [
          { role: 'user', content: 'Identify all the movies in this list and find where to watch them',
            attachments: [
              { kind: 'image', name: 'list.png', dataUrl: 'data:image/png;base64,AAAA' },
              { kind: 'text', name: 'notes.txt', content: 'TEXT-FILE-CONTENT-MARKER' }
            ] }
        ], updatedAt: new Date().toISOString() });
        const origVision = AgentService.supportsVision;
        const origEnsure = AgentService.ensureVisionInfo;
        AgentService.supportsVision = () => true;
        AgentService.ensureVisionInfo = async () => {};
        let extractSawImage = false;
        const origChat = TaskService._chat;
        TaskService._chat = async (params) => {
          if (params.logTag === 'task-image-extract') {
            const u = params.messages.find(m => Array.isArray(m.content));
            extractSawImage = !!(u && u.content.some(p => p.type === 'image_url'));
            return { message: { content: '1. Alpha One (2007)\n2. Beta Two (2013)' } };
          }
          if (params.logTag === 'task-plan') return { message: { content: JSON.stringify({ steps: [
            { kind: 'single', step: 'List the movies', tools: [], items_from: '', per_item: '', check: { kind: 'none', arg: '' } },
            { kind: 'foreach', step: 'Look each up', tools: [], items_from: '$1', per_item: 'find availability', check: { kind: 'none', arg: '' } }
          ] }) } };
          return { message: { content: '{}' } };
        };
        const r = await TaskService.start('For each of the movies in the attached list, find availability', 'conv_c9i');
        TaskService._chat = origChat;
        AgentService.supportsVision = origVision;
        AgentService.ensureVisionInfo = origEnsure;
        const t = TaskService.get(r.taskId);
        const ctx = t.context || '';
        const pass = extractSawImage
          && /Alpha One \(2007\)/.test(ctx)
          && /TEXT-FILE-CONTENT-MARKER/.test(ctx)
          && t.plan.length === 3 && t.plan[1].kind === 'foreach' && t.plan[2].kind === 'single';
        TaskService.cancel(r.taskId);
        return { pass, detail: JSON.stringify({ extractSawImage, hasList: /Alpha One/.test(ctx), hasFile: /MARKER/.test(ctx), plan: t.plan.length }) };
      });
    }
  },
  {
    id: 'c9-foreach-items-salvage',
    name: 'foreach salvages the item list from the producer\'s result text when items are missing (finding #47)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({
          id: 'task_c9s', conversationId: null, goal: 'look things up',
          plan: [
            { kind: 'single', step: 'list them', tools: [], status: 'done', note: '', result: 'listed' },
            { kind: 'foreach', step: 'look each up', tools: [], status: 'active', note: '', itemsFrom: 1, perItem: 'look it up' }
          ],
          // The producing step's closing failed to carry `items` — but its
          // result text holds a numbered list (the truncated-closing case).
          results: { '1': { result: 'Here is the list:\n1. Alpha One (2007)\n2. Beta Two (2013)\n3. Gamma Three (2014)' } },
          status: 'running', note: '', stepIndex: 1, retried: false, toolCalls: 0,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: []
        });
        StorageManager.set('agent-tasks', tasks);
        const itemsFrom = (messages) => {
          const m = messages.map(x => x.content || '').join('\n').match(/Items \(\d+\):\n([\s\S]*?)$/);
          if (!m) return [];
          return [...m[1].matchAll(/^\d+\. (.+)$/gm)].map(x => x[1].trim());
        };
        const origChat = TaskService._chat;
        TaskService._chat = async (params) => {
          if (!params.format) return { message: { content: 'checked', tool_calls: [] } };
          const asked = itemsFrom(params.messages);
          return { message: { content: JSON.stringify({ status: 'done', rows: asked.map(it => ({ item: it, data: 'found' })), note: 'b' }) } };
        };
        const out = await TaskService._runForeach('task_c9s', 1);
        TaskService._chat = origChat;
        const rows = TaskService.get('task_c9s').results['2'].rows;
        const pass = out.ok === true && rows.length === 3 && rows[0].item === 'Alpha One (2007)';
        return { pass, detail: JSON.stringify({ ok: out.ok, rows: rows.map(r => r.item) }) };
      });
    }
  },
  {
    id: 'c9-replan-keeps-fanout',
    name: 'a replan revision that drops the fan-out for a per-item goal gets the harness tail (finding #47)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({
          id: 'task_c9k', conversationId: null, goal: 'For each of the 100 movies in the list, find availability',
          plan: [
            { kind: 'single', step: 'list them', tools: [], status: 'done', note: '', result: 'listed' },
            { kind: 'foreach', step: 'look each up', tools: [], status: 'failed', note: 'step 1 did not produce the item list', itemsFrom: 1, perItem: 'look it up' }
          ],
          results: { '1': { result: 'no list here' } },
          status: 'running', note: '', stepIndex: 1, retried: false, toolCalls: 0,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: []
        });
        StorageManager.set('agent-tasks', tasks);
        const origChat = TaskService._chat;
        TaskService._chat = async (params) => {
          // The model's revision drops the foreach — prep again.
          if (params.logTag === 'task-replan') return { message: { content: JSON.stringify({ steps: [
            { kind: 'single', step: 'Create a list of all 100 movies', tools: [], items_from: '', per_item: '', check: { kind: 'none', arg: '' } }
          ] }) } };
          if (params.logTag === 'task-plan-fill') return { message: { content: JSON.stringify({
            list_step: 'Extract the 100 movie titles', work_step: 'Find availability for each movie', per_item: 'Find availability for this movie', deliver_step: 'Compile the availability table'
          }) } };
          return { message: { content: '{}' } };
        };
        const ok = await TaskService._replan('task_c9k', 1);
        TaskService._chat = origChat;
        const t = TaskService.get('task_c9k');
        const pass = ok === true && t.plan.length === 5
          && t.plan[1].status === 'replanned'
          && t.plan[2].kind === 'single' && t.plan[2].step === 'Extract the 100 movie titles'
          && t.plan[3].kind === 'foreach' && t.plan[3].itemsFrom === 3
          && t.plan[4].kind === 'single';
        return { pass, detail: JSON.stringify({ ok, kinds: t.plan.map(s => `${s.kind}:${s.status}`) }) };
      });
    }
  },
  {
    id: 'c9-goal-count-gate',
    name: 'a goal naming N items rejects a shorter list at the gate (finding #53)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        // Count extraction: conservative, never years.
        const countsOk = TaskService._goalItemCount('find availability for the 10 movies in the list') === 10
          && TaskService._goalItemCount('process 100 invoices from 2026') === 100
          && TaskService._goalItemCount('summarize my week in 2026') === 0
          && TaskService._goalItemCount('watch 1 movie') === 0;

        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({
          id: 'task_c9c', conversationId: null, goal: 'find availability for the 10 movies in the list',
          plan: [
            { kind: 'single', step: 'list them', tools: [], status: 'done', note: '' },
            { kind: 'foreach', step: 'look each up', tools: [], status: 'pending', note: '', itemsFrom: 1, perItem: 'p' }
          ],
          results: { '1': { items: ['Only One Movie'] } },
          status: 'running', note: '', stepIndex: 0, retried: false, toolCalls: 0,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: []
        });
        StorageManager.set('agent-tasks', tasks);
        const short = await TaskService._gateStep('task_c9c', 0);
        // Full list passes.
        const t = TaskService.get('task_c9c');
        const tasks2 = StorageManager.get('agent-tasks') || [];
        tasks2.find(x => x.id === 'task_c9c').results['1'].items =
          Array.from({ length: 10 }, (_, i) => 'Movie ' + (i + 1));
        StorageManager.set('agent-tasks', tasks2);
        const full = await TaskService._gateStep('task_c9c', 0);
        const pass = countsOk && short.ok === false && /names 10 items but this step produced only 1/.test(short.reason)
          && full.ok === true;
        return { pass, detail: JSON.stringify({ countsOk, short, full }) };
      });
    }
  },
  {
    id: 'c9-implied-files-group',
    name: 'file-shaped goals imply the files group on every step (finding #52)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const g = (goal) => TaskService._impliedGroups(goal);
        const pass = g('For each PDF invoice in the folder "/tmp/x/Invoices", extract the total').includes('files')
          && g('Read the documents in ~/Downloads and summarize').includes('files')
          && g('organize the files on my desktop').includes('files')
          && !g('research streaming availability for these movies').includes('files')
          && !g('summarize my week').includes('files');
        return { pass, detail: JSON.stringify({
          folder: g('For each PDF invoice in the folder "/tmp/x/Invoices", extract the total'),
          movies: g('research streaming availability for these movies')
        }) };
      });
    }
  },
  {
    id: 'c9-delivery-append',
    name: 'a foreach-last plan gains the harness deliver step; others are untouched (I5, finding #50)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const mk = (kinds) => kinds.map((k, i) => (k === 'foreach'
          ? { kind: 'foreach', step: 's' + i, tools: ['email'], status: 'pending', note: '', itemsFrom: i, perItem: 'p' }
          : { kind: 'single', step: 's' + i, tools: [], status: 'pending', note: '' }));
        const a = TaskService._ensureDeliveryStep(mk(['single', 'foreach']));
        const b = TaskService._ensureDeliveryStep(mk(['single', 'foreach', 'single']));
        const c = TaskService._ensureDeliveryStep(mk(['single']));
        const full = TaskService._ensureDeliveryStep(mk(new Array(TaskService.MAX_STEPS).fill('single').map((x, i) => i === TaskService.MAX_STEPS - 1 ? 'foreach' : 'single')));
        const pass = a.length === 3 && a[2].kind === 'single' && /Compile the per-item results/.test(a[2].step)
          && JSON.stringify(a[2].tools) === JSON.stringify(['email'])
          && b.length === 3 && c.length === 1
          && full.length === TaskService.MAX_STEPS;
        return { pass, detail: JSON.stringify({ a: a.length, b: b.length, c: c.length, full: full.length }) };
      });
    }
  },
  {
    id: 'c9-boundary-prune',
    name: 'a finished step prunes obviated remaining steps; growing revisions are ignored (C9.4)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const seed = () => {
          const tasks = StorageManager.get('agent-tasks') || [];
          tasks.unshift({
            id: 'task_c9b', conversationId: null, goal: 'collect the info and write a note',
            plan: [
              { kind: 'single', step: 'find the info', tools: [], status: 'done', note: '', result: 'found everything including the totals' },
              { kind: 'single', step: 'compute the totals', tools: [], status: 'pending', note: '' },
              { kind: 'single', step: 'write the note', tools: [], status: 'pending', note: '' }
            ],
            results: {},
            status: 'running', note: '', stepIndex: 0, retried: false, toolCalls: 0,
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: []
          });
          StorageManager.set('agent-tasks', tasks);
        };
        const origChat = TaskService._chat;

        // Case 1: the prune drops the obviated step.
        seed();
        TaskService._chat = async (params) => {
          if (params.logTag === 'task-prune') return { message: { content: JSON.stringify({ steps: [
            { kind: 'single', step: 'write the note', tools: [], items_from: '', per_item: '', check: { kind: 'none', arg: '' } }
          ] }) } };
          return { message: { content: '{}' } };
        };
        await TaskService._boundaryPrune('task_c9b', 0);
        const t1 = TaskService.get('task_c9b');
        const pruned = t1.plan.length === 2 && t1.plan[1].step === 'write the note';
        StorageManager.set('agent-tasks', (StorageManager.get('agent-tasks') || []).filter(x => x.id !== 'task_c9b'));

        // Case 2: a GROWING revision is ignored — prune-only by law.
        seed();
        TaskService._chat = async (params) => {
          if (params.logTag === 'task-prune') return { message: { content: JSON.stringify({ steps: [
            { kind: 'single', step: 'a', tools: [], items_from: '', per_item: '', check: { kind: 'none', arg: '' } },
            { kind: 'single', step: 'b', tools: [], items_from: '', per_item: '', check: { kind: 'none', arg: '' } },
            { kind: 'single', step: 'c', tools: [], items_from: '', per_item: '', check: { kind: 'none', arg: '' } }
          ] }) } };
          return { message: { content: '{}' } };
        };
        await TaskService._boundaryPrune('task_c9b', 0);
        const t2 = TaskService.get('task_c9b');
        const growIgnored = t2.plan.length === 3 && t2.plan[1].step === 'compute the totals';
        TaskService._chat = origChat;
        return { pass: pruned && growIgnored, detail: JSON.stringify({ pruned, growIgnored, len1: t1.plan.length, len2: t2.plan.length }) };
      });
    }
  },
  {
    id: 'c9-goal-verdict-blocks-complete',
    name: 'steps clean + goal unmet = honest failure, never "Task complete" (finding #45)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        AgentService.conversations.push({ id: 'conv_c9g', messages: [], updatedAt: new Date().toISOString() });
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({
          id: 'task_c9g', conversationId: 'conv_c9g', goal: 'research availability for 99 movies',
          plan: [
            { kind: 'single', step: 'search availability', tools: [], status: 'replanned', note: 'failed — revised the plan around it' },
            { kind: 'single', step: 'divide the list into batches of 5', tools: [], status: 'done', note: '', result: 'divided into 20 batches' }
          ],
          results: {},
          status: 'verifying', note: '', stepIndex: 2, retried: false, toolCalls: 0,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: []
        });
        StorageManager.set('agent-tasks', tasks);
        const origChat = TaskService._chat;
        TaskService._chat = async (params) => {
          if (!params.format) return { message: { content: '1. OK\n2. OK\nGOAL: not achieved — no availability data exists for any movie', tool_calls: [] } };
          return { message: { content: JSON.stringify({
            verdicts: [{ step: 1, ok: true, issue: '' }, { step: 2, ok: true, issue: '' }],
            goal: { achieved: false, missing: 'no availability data for any movie' }
          }) } };
        };
        const v = await TaskService._verify('task_c9g');
        await TaskService._report('task_c9g', v.verdicts, v.goal);
        TaskService._chat = origChat;
        const t = TaskService.get('task_c9g');
        const conv = AgentService.conversations.find(c => c.id === 'conv_c9g');
        const report = conv && conv.messages.length ? conv.messages[conv.messages.length - 1].content : '';
        const pass = t.status === 'failed'
          && /goal is not achieved/.test(t.note)
          && /WITHOUT achieving the goal/.test(report)
          && !/^Task complete/.test(report);
        return { pass, detail: JSON.stringify({ status: t.status, note: t.note.slice(0, 80) }) };
      });
    }
  },
  {
    id: 'c9-verdict-corroboration',
    name: 'a goal verdict contradicted by mechanical evidence becomes a caveat, not a failure (finding #51)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        AgentService.conversations.push({ id: 'conv_c9v', messages: [], updatedAt: new Date().toISOString() });
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({
          id: 'task_c9v', conversationId: 'conv_c9v', goal: 'look up both things and compile',
          plan: [
            { kind: 'single', step: 'list', tools: [], status: 'done', note: '', result: 'listed' },
            { kind: 'foreach', step: 'look up', tools: [], status: 'done', note: '2/2 items', result: 'r', itemsFrom: 1, perItem: 'p' },
            { kind: 'single', step: 'compile', tools: [], status: 'done', note: '', result: 'compiled' }
          ],
          results: { '1': { items: ['A', 'B'] }, '2': { rows: [{ item: 'A', data: 'found' }, { item: 'B', data: 'found' }] } },
          status: 'verifying', note: '', stepIndex: 3, retried: false, toolCalls: 0,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: []
        });
        StorageManager.set('agent-tasks', tasks);
        // The verifier doubts "accuracy" — a quality doubt, while every
        // foreach row is present and clean.
        await TaskService._report('task_c9v',
          [{ ok: true, issue: '' }, { ok: false, issue: 'could not confirm accuracy' }, { ok: true, issue: '' }],
          { achieved: false, missing: 'accurate verified search results' });
        const t = TaskService.get('task_c9v');
        const conv = AgentService.conversations.find(c => c.id === 'conv_c9v');
        const report = conv && conv.messages.length ? conv.messages[conv.messages.length - 1].content : '';
        const pass = t.status === 'done' && t.note === 'Done.'
          && /^Task complete/.test(report)
          && /Verifier caveat, not fatal/.test(report)
          && /accurate verified search results/.test(report);
        return { pass, detail: JSON.stringify({ status: t.status, caveat: /Verifier caveat/.test(report) }) };
      });
    }
  },
  {
    id: 'c9-goal-verdict-clean',
    name: 'goal achieved keeps a clean run reading Done',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({
          id: 'task_c9h', conversationId: null, goal: 'small goal',
          plan: [{ kind: 'single', step: 'do it', tools: [], status: 'done', note: '', result: 'did it' }],
          results: {},
          status: 'verifying', note: '', stepIndex: 1, retried: false, toolCalls: 0,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: []
        });
        StorageManager.set('agent-tasks', tasks);
        const origChat = TaskService._chat;
        TaskService._chat = async (params) => {
          if (!params.format) return { message: { content: '1. OK\nGOAL: achieved', tool_calls: [] } };
          return { message: { content: JSON.stringify({
            verdicts: [{ step: 1, ok: true, issue: '' }],
            goal: { achieved: true, missing: '' }
          }) } };
        };
        const v = await TaskService._verify('task_c9h');
        await TaskService._report('task_c9h', v.verdicts, v.goal);
        TaskService._chat = origChat;
        const t = TaskService.get('task_c9h');
        const pass = t.status === 'done' && t.note === 'Done.';
        return { pass, detail: JSON.stringify({ status: t.status, note: t.note }) };
      });
    }
  },
  {
    id: 'c9-report-rows-and-prune',
    name: 'the report compiles full foreach rows; the results map is pruned on settle',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        AgentService.conversations.push({ id: 'conv_c9', messages: [], updatedAt: new Date().toISOString() });
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({
          id: 'task_c9p', conversationId: 'conv_c9', goal: 'report test',
          plan: [
            { kind: 'single', step: 'list', tools: [], status: 'done', note: '', result: 'listed' },
            { kind: 'foreach', step: 'look up', tools: [], status: 'done', note: '2/2 items', result: 'short render', itemsFrom: 1, perItem: 'p' }
          ],
          results: { '1': { items: ['A', 'B'] }, '2': { rows: [{ item: 'A', data: 'data-A' }, { item: 'B', data: 'data-B' }] } },
          status: 'verifying', note: '', stepIndex: 2, retried: false, toolCalls: 0,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: []
        });
        StorageManager.set('agent-tasks', tasks);
        await TaskService._report('task_c9p', [{ ok: true, issue: '' }, { ok: true, issue: '' }]);
        const t = TaskService.get('task_c9p');
        const conv = AgentService.conversations.find(c => c.id === 'conv_c9');
        const report = conv && conv.messages.length ? conv.messages[conv.messages.length - 1].content : '';
        const pass = t.status === 'done' && t.results === undefined
          && /A: data-A/.test(report) && /B: data-B/.test(report);
        return { pass, detail: JSON.stringify({ status: t.status, pruned: t.results === undefined, hasRows: /data-B/.test(report) }) };
      });
    }
  }
];
