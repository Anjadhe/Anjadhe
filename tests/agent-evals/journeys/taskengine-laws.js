/**
 * TASK_ENGINE.md §v3 law fixes, shipped on the v2 engine (2026-08-03).
 *
 * Every journey here reproduces a specific failure from the invoice-routine
 * runs of 2026-08-03 (TASK_ENGINE.md §v3 "The evidence"), where the harness's
 * own bookkeeping — not the model — was the failure source: a row-matching
 * miss became a failed step, the failed step triggered write-bearing retries,
 * and the retries created 28 schedule records for what should have been three,
 * which the user then deleted by hand.
 *
 * Laws under test:
 *   I9 — evidence must be sound before it overrides (mismatch is not absence)
 *   I8 — side-effect-safe retries (reconcile first; idempotency keys)
 *   §v3.8 — an unattended run never sits silently paused after a restart
 *   §v3 sequencing 4 — completed work reads as completed; caveats are caveats
 *
 * Deterministic: the model is stubbed at the TaskService seam.
 */

/** A foreach task seeded at the step under test. */
const SEED = (id, goal, items, opts = {}) => ({
  id, conversationId: opts.conversationId || null, goal,
  plan: [
    { kind: 'single', step: 'list them', tools: [], status: 'done', note: '', result: 'listed' },
    { kind: 'foreach', step: 'handle each', tools: [], status: 'active', note: '', itemsFrom: 1, perItem: 'handle it' }
  ],
  results: { '1': { items } },
  status: 'running', note: '', stepIndex: 1, retried: false, toolCalls: 0,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  log: [], toolLog: [], ...opts.extra
});

module.exports = [
  {
    // The 16:48 run: step 1's closing packed narrative findings into `items`,
    // so `_matchItem` could not map the model's rows back to them and EVERY
    // row settled "unknown: could not be resolved" — over work that was done.
    id: 'i9-unmatched-rows-unverified',
    name: 'rows that cannot be matched back settle UNVERIFIED, not failed, and fire no retry (I9)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (seedSrc) => {
        const SEED = eval(seedSrc);
        const items = ['Narrative finding one', 'Narrative finding two', 'Narrative finding three'];
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift(SEED('task_i9a', 'capture each invoice', items));
        StorageManager.set('agent-tasks', tasks);

        let chunkClosings = 0;
        let sawCoverExactly = false;
        const origChat = TaskService._chat;
        TaskService._chat = async (params) => {
          const joined = params.messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
          if (/MISSED/.test(joined)) sawCoverExactly = true;
          if (!params.format) return { message: { content: 'handled them', tool_calls: [] } };
          chunkClosings++;
          // The model DID the work and reports it in its own words — labels
          // that no _matchItem can resolve against the asked items.
          return { message: { content: JSON.stringify({
            status: 'done',
            rows: [
              { item: 'Invoice INV-2033 from Meadow Books LLP', data: 'captured' },
              { item: 'Invoice INV-2041 from Northgate', data: 'captured' }
            ],
            note: 'batch done'
          }) } };
        };
        const out = await TaskService._runForeach('task_i9a', 1);
        TaskService._chat = origChat;

        const rows = TaskService.get('task_i9a').results['2'].rows;
        const allUnverified = rows.length === 3 && rows.every(r => r.unverified === true && !r.unknown);
        const pass = out.ok === true                 // NOT a failed step
          && out.unverified === 3
          && allUnverified
          && chunkClosings === 1                     // no informed retry fired
          && sawCoverExactly === false
          && /unverified/.test(out.note);
        return { pass, detail: JSON.stringify({
          ok: out.ok, unverified: out.unverified, chunkClosings, sawCoverExactly,
          note: out.note, rows: rows.map(r => r.data.slice(0, 30))
        }) };
      }, SEED.toString());
    }
  },
  {
    // The other half of I9, revised 2026-08-21 with the concluded-batch
    // rule: an item nothing answered for still gets its informed retry
    // (absence earns a second chance), but when the retry ALSO concludes
    // cleanly without a row, the item settles UNVERIFIED and the step is
    // not failed — the model believes the work is done and the harness
    // merely cannot map it per item. Only a batch that BREAKS still fails.
    id: 'i9-rowless-after-retry-settles-unverified',
    name: 'a row-less item gets the informed retry, then settles unverified — never missed→failed',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (seedSrc) => {
        const SEED = eval(seedSrc);
        const items = ['Alpha One', 'Beta Two', 'Gamma Three'];
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift(SEED('task_i9b', 'handle 3 things', items));
        StorageManager.set('agent-tasks', tasks);

        const itemsFrom = (messages) => {
          const m = messages.map(x => x.content || '').join('\n').match(/Items \(\d+\):\n([\s\S]*?)$/);
          return m ? [...m[1].matchAll(/^\d+\. (.+)$/gm)].map(x => x[1].trim()) : [];
        };
        let retries = 0;
        const origChat = TaskService._chat;
        TaskService._chat = async (params) => {
          if (!params.format) return { message: { content: 'checked', tool_calls: [] } };
          const joined = params.messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
          if (/MISSED/.test(joined)) retries++;
          // Every row maps cleanly; Gamma simply never gets one.
          const asked = itemsFrom(params.messages).filter(it => it !== 'Gamma Three');
          return { message: { content: JSON.stringify({
            status: 'done', rows: asked.map(it => ({ item: it, data: 'found' })), note: 'b'
          }) } };
        };
        const out = await TaskService._runForeach('task_i9b', 1);
        TaskService._chat = origChat;

        const rows = TaskService.get('task_i9b').results['2'].rows;
        const gamma = rows.find(r => r.item === 'Gamma Three');
        const pass = out.ok === true && retries === 1
          && gamma && gamma.unverified === true && !gamma.unknown
          && /unverified/.test(out.note);
        return { pass, detail: JSON.stringify({ ok: out.ok, retries, gamma, note: out.note }) };
      }, SEED.toString());
    }
  },
  {
    // The 16:48 run's second cascade: the false gate/verify failures re-ran
    // write-bearing work. A verifier doubt about a step whose rows are
    // already known unreadable must not reach the retry pass.
    id: 'i9-unverified-not-retried-by-verify',
    name: 'an unverified step is reported △ and never re-run by the verify retry pass (I9)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        AgentService.conversations.push({ id: 'conv_i9c', messages: [], updatedAt: new Date().toISOString() });
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({
          id: 'task_i9c', conversationId: 'conv_i9c', goal: 'capture each invoice',
          plan: [
            { kind: 'single', step: 'list them', tools: [], status: 'done', note: '', result: 'listed' },
            { kind: 'foreach', step: 'capture each', tools: [], status: 'done', note: '0/3 items (3 unverified)',
              result: 'r', itemsFrom: 1, perItem: 'p', unverified: 3 }
          ],
          results: { '1': { items: ['A', 'B', 'C'] },
                     '2': { rows: [{ item: 'A', data: 'unverified: x', unverified: true }] } },
          status: 'running', note: '', stepIndex: 2, retried: false, toolCalls: 0,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: []
        });
        StorageManager.set('agent-tasks', tasks);
        TaskService._controls.set('task_i9c', { pause: false, cancel: false });

        let foreachReruns = 0;
        const origForeach = TaskService._runForeach;
        TaskService._runForeach = async (...a) => { foreachReruns++; return origForeach.apply(TaskService, a); };
        const origChat = TaskService._chat;
        TaskService._chat = async (params) => {
          if (params.logTag === 'task-verify') {
            return { message: { content: '1. OK\n2. the rows are unresolved\nGOAL: achieved', tool_calls: [] } };
          }
          if (params.logTag === 'task-verdicts') {
            return { message: { content: JSON.stringify({
              verdicts: [{ step: 1, ok: true, issue: '' }, { step: 2, ok: false, issue: 'rows unresolved' }],
              goal: { achieved: true, missing: '' } }) } };
          }
          return { message: { content: '{}' } };
        };
        // stepIndex is past the plan, so _run goes straight to verify+report.
        await TaskService._run('task_i9c');
        TaskService._chat = origChat;
        TaskService._runForeach = origForeach;

        const conv = AgentService.conversations.find(c => c.id === 'conv_i9c');
        const report = conv.messages.length ? conv.messages[conv.messages.length - 1].content : '';
        const t = TaskService.get('task_i9c');
        const pass = foreachReruns === 0
          && /△ capture each/.test(report)
          && !/✗ capture each/.test(report);
        return { pass, detail: JSON.stringify({ foreachReruns, status: t.status, report: report.slice(0, 200) }) };
      });
    }
  },

  // ── I8 — side-effect-safe retries ────────────────────────────────────

  {
    // The exact live shape: the retry demand made the model re-word its own
    // title rather than repeat it, so argument-equality replay could not see
    // it and a second record appeared. Under a scope it must converge.
    id: 'i8-reworded-retry-converges',
    name: 'a re-worded re-issue converges on the record the run already created (I8)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const count = () => ((StorageManager.get('schedule') || {}).scheduleItems || [])
          .filter(i => /INV-2033/.test(i.title || '')).length;
        const prevScope = AgentTools._idemScope;
        AgentTools._idemScope = 'routine:eval_i8';

        const a = AgentTools.handlers.create_schedule_item({ title: 'Pay invoice INV-2033 by Aug 20', scheduledDate: '2026-08-20' });
        const afterFirst = count();
        // Punctuation + whitespace drift (the normalization case).
        const b = AgentTools.handlers.create_schedule_item({ title: 'Pay  invoice INV-2033 by Aug 20.', scheduledDate: '2026-08-20' });
        // The literal "(dup 2)" the 16:58 run produced (the containment case).
        const c = AgentTools.handlers.create_schedule_item({ title: 'Pay invoice INV-2033 by Aug 20 (dup 2)', scheduledDate: '2026-08-20' });
        const afterAll = count();

        // A genuinely different invoice in the same scope still creates.
        const d = AgentTools.handlers.create_schedule_item({ title: 'Pay invoice INV-2041 by Aug 25', scheduledDate: '2026-08-25' });
        const other = ((StorageManager.get('schedule') || {}).scheduleItems || [])
          .filter(i => /INV-2041/.test(i.title || '')).length;
        AgentTools._idemScope = prevScope;

        const pass = afterFirst === 1 && afterAll === 1
          && a.alreadyExisted === false && b.alreadyExisted === true && c.alreadyExisted === true
          && b.item.id === a.item.id && c.item.id === a.item.id
          && other === 1 && d.alreadyExisted === false;
        return { pass, detail: JSON.stringify({ afterFirst, afterAll, other, ids: [a.item?.id, b.item?.id, c.item?.id] }) };
      });
    }
  },
  {
    // "…and it must not resurrect what the user deleted." The live runs'
    // records were all deleted by hand; a fourth fire must not bring them
    // back. The ledger outlives the record on purpose.
    id: 'i8-deleted-record-not-resurrected',
    name: 'a record deleted by the user is not re-created by a later retry (I8)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const prevScope = AgentTools._idemScope;
        AgentTools._idemScope = 'routine:eval_i8del';
        const made = AgentTools.handlers.create_schedule_item({ title: 'File the Northgate receipt', scheduledDate: '2026-08-20' });
        // The user deletes it by hand.
        const data = StorageManager.get('schedule') || {};
        StorageManager.set('schedule', {
          ...data, scheduleItems: (data.scheduleItems || []).filter(i => i.id !== made.item.id)
        });
        const again = AgentTools.handlers.create_schedule_item({ title: 'File the Northgate receipt', scheduledDate: '2026-08-20' });
        const live = ((StorageManager.get('schedule') || {}).scheduleItems || [])
          .filter(i => /Northgate receipt/.test(i.title || '')).length;
        AgentTools._idemScope = prevScope;
        const pass = made.alreadyExisted === false && again.alreadyExisted === true
          && again.idempotent === true && !again.item && live === 0;
        return { pass, detail: JSON.stringify({ made: !!made.item, again, live }) };
      });
    }
  },
  {
    // The scope is the harness's, and ordinary chat has none — an unscoped
    // call must behave exactly as it did before I8 (title dedupe only), or
    // this law would quietly change every chat write in the app.
    id: 'i8-scope-is-harness-owned',
    name: 'no scope (ordinary chat) writes no ledger; a different scope is isolated (I8)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const ledgerSize = () => Object.keys((StorageManager.get('schedule') || {}).agentActionLedger || {}).length;
        const before = ledgerSize();
        AgentTools._idemScope = null;
        AgentTools.handlers.create_schedule_item({ title: 'Unscoped chat task alpha', scheduledDate: '2026-08-20' });
        const unscopedWroteNothing = ledgerSize() === before;

        // Scope A creates; scope B is a different run and must not inherit it.
        AgentTools._idemScope = 'task:A';
        const a = AgentTools.handlers.create_schedule_item({ title: 'Scoped shared title here', scheduledDate: '2026-08-20' });
        AgentTools._idemScope = 'task:B';
        const bFind = AgentTools._idemFind('Scoped shared title here');
        AgentTools._idemScope = null;

        // Even with no scope, the plain title dedupe still holds (unchanged).
        const dup = AgentTools.handlers.create_schedule_item({ title: 'Unscoped chat task alpha', scheduledDate: '2026-08-20' });
        const pass = unscopedWroteNothing && !!a.item && bFind === null && dup.alreadyExisted === true;
        return { pass, detail: JSON.stringify({ unscopedWroteNothing, bFind, dup: dup.alreadyExisted }) };
      });
    }
  },
  {
    // The headline: the routine ran three times over the same three invoices
    // (D1/D6 in ROUTINE_TRIGGERS.md put it in that position) and produced 28
    // records. Same scope, three runs, three records.
    id: 'i8-three-invoice-batch-no-duplicates',
    name: 'three fires of one routine over the same invoices create three records, not nine (I8)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (seedSrc) => {
        const SEED = eval(seedSrc);
        const invoices = ['Invoice INV-2033 from Meadow Books LLP',
                          'Invoice INV-2041 from Northgate',
                          'Invoice INV-2052 from Pavear'];
        const itemsFrom = (messages) => {
          const m = messages.map(x => x.content || '').join('\n').match(/Items \(\d+\):\n([\s\S]*?)(?:\n\n|$)/);
          return m ? [...m[1].matchAll(/^\d+\. (.+)$/gm)].map(x => x[1].trim()) : [];
        };
        const origPerm = AgentService._resolvePermission;
        AgentService._resolvePermission = async () => ({ decision: 'allow' });
        const origChat = TaskService._chat;
        // Each fire re-words the titles slightly, as a real model does.
        let fire = 0;
        const suffixes = ['', '.', ' (dup 2)'];
        TaskService._chat = async (params) => {
          if (params.format) {
            const asked = itemsFrom(params.messages);
            return { message: { content: JSON.stringify({
              status: 'done', rows: asked.map(it => ({ item: it, data: 'captured' })), note: 'b' }) } };
          }
          const asked = itemsFrom(params.messages);
          if (!asked.length) return { message: { content: 'DONE:', tool_calls: [] } };
          return { message: { content: '', tool_calls: asked.map((it, i) => ({
            id: `c${fire}_${i}`,
            function: { name: 'create_schedule_item', arguments: JSON.stringify({
              title: `Capture ${it.split(' from ')[0]}${suffixes[fire]}`, scheduledDate: '2026-08-20'
            }) }
          })) } };
        };

        for (fire = 0; fire < 3; fire++) {
          const id = 'task_i8batch_' + fire;
          const tasks = StorageManager.get('agent-tasks') || [];
          // Every fire is the SAME routine — that is what makes the scope
          // span runs, and it is the case with no coverage before I8.
          tasks.unshift(SEED(id, 'capture each invoice as a task', invoices, { extra: { routineId: 'routine_invoices' } }));
          StorageManager.set('agent-tasks', tasks);
          TaskService._controls.set(id, { pause: false, cancel: false });
          await TaskService._runForeach(id, 1);
        }
        TaskService._chat = origChat;
        AgentService._resolvePermission = origPerm;

        const created = ((StorageManager.get('schedule') || {}).scheduleItems || [])
          .filter(i => /^Capture Invoice INV-20/.test(i.title || ''));
        const createCalls = window.__eval.calls.filter(c => c.name === 'create_schedule_item').length;
        const pass = created.length === 3 && createCalls === 9;
        return { pass, detail: JSON.stringify({
          records: created.length, createCalls, titles: created.map(i => i.title)
        }) };
      }, SEED.toString());
    }
  },
  {
    // The other half of I8: converging is the backstop, but the model has to
    // be TOLD, or it re-words to satisfy a coverage demand it cannot meet.
    id: 'i8-reconcile-before-retry',
    name: 'a re-run is told what this run and earlier routine runs already created (I8)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({
          id: 'task_i8rec', conversationId: null, goal: 'capture the invoice',
          routineId: 'routine_recon',
          plan: [{ kind: 'single', step: 'capture it', tools: [], status: 'active', note: '' }],
          results: {}, status: 'running', note: '', stepIndex: 0, retried: false, toolCalls: 0,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: []
        });
        StorageManager.set('agent-tasks', tasks);

        // An EARLIER run of the same routine created this.
        const prevScope = AgentTools._idemScope;
        AgentTools._idemScope = 'routine:routine_recon';
        AgentTools.handlers.create_schedule_item({ title: 'Pay invoice INV-2033', scheduledDate: '2026-08-20' });
        AgentTools._idemScope = prevScope;

        // A clean task with no prior writes gets no note at all.
        const cleanNote = TaskService._priorWritesNote({ id: 'x', ledgerScopes: [] });

        let stepPrompt = '';
        const origChat = TaskService._chat;
        TaskService._chat = async (params) => {
          if (params.logTag === 'task-step') {
            stepPrompt = params.messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
            return { message: { content: 'DONE: already covered', tool_calls: [] } };
          }
          return { message: { content: JSON.stringify({ status: 'done', result: 'r', note: 'n' }) } };
        };
        await TaskService._runStep('task_i8rec', 0, 'the task was not created');
        TaskService._chat = origChat;

        const pass = cleanNote === ''
          && /ALREADY DONE/.test(stepPrompt)
          && /Pay invoice INV-2033/.test(stepPrompt)
          && /do NOT re-word one to make it look new/.test(stepPrompt);
        return { pass, detail: JSON.stringify({
          cleanNote, hasBlock: /ALREADY DONE/.test(stepPrompt),
          hasRecord: /INV-2033/.test(stepPrompt)
        }) };
      });
    }
  },

  // ── §v3.8 — an unattended run never sits silently paused ─────────────

  {
    // The 16:58 run: interrupted by a restart, left "Paused by app restart",
    // and nobody was there to read the card. Its arming was the consent.
    id: 'restart-unattended-resumes',
    name: 'a restart-interrupted unattended run resumes itself and stays unattended (§v3.8)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const mk = (id, extra) => ({
          id, conversationId: null, goal: 'file the invoice', unattended: true, routineId: 'r_restart',
          plan: [{ kind: 'single', step: 'file it', tools: [], status: 'pending', note: '' }],
          results: {}, status: 'running', note: '', stepIndex: 0, retried: false, toolCalls: 0,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          log: [], toolLog: [], ...extra
        });
        const tasks = StorageManager.get('agent-tasks') || [];
        // One unattended run, and one ATTENDED one that must NOT auto-resume.
        tasks.unshift(mk('task_restart_un'));
        tasks.unshift(mk('task_restart_att', { unattended: false, goal: 'attended work' }));
        StorageManager.set('agent-tasks', tasks);

        TaskService.init();
        const un = TaskService.get('task_restart_un');
        const att = TaskService.get('task_restart_att');
        const marked = un.status === 'paused' && un.resumeOnLaunch === true
          && att.status === 'paused' && att.resumeOnLaunch === undefined
          && /picking it back up/.test(un.note);

        const origChat = TaskService._chat;
        TaskService._chat = async (params) => {
          if (params.format) return { message: { content: JSON.stringify({ status: 'done', result: 'filed', note: 'n' }) } };
          return { message: { content: 'DONE: filed', tool_calls: [] } };
        };
        await TaskService._resumeUnattendedRuns();
        for (let i = 0; i < 40; i++) {
          if (['done', 'failed'].includes(TaskService.get('task_restart_un').status)) break;
          await new Promise(r => setTimeout(r, 250));
        }
        TaskService._chat = origChat;

        const after = TaskService.get('task_restart_un');
        const attAfter = TaskService.get('task_restart_att');
        const notified = window.__eval.notifs.some(n => /resumed a routine run/i.test(n.title));
        const pass = marked
          && ['done', 'failed'].includes(after.status)
          && after.unattended === true          // never silently marked attended
          && after.resumeOnLaunch === undefined
          && attAfter.status === 'paused'       // the attended one stayed put
          && notified;
        return { pass, detail: JSON.stringify({
          marked, status: after.status, unattended: after.unattended,
          attended: attAfter.status, notified
        }) };
      });
    }
  },
  {
    // Where resume is impossible it must SAY so. A silent pause is the
    // failure mode; a notification is the whole point of the policy.
    id: 'restart-unattended-notifies-when-blocked',
    name: 'an unattended run that cannot resume notifies instead of going quiet (§v3.8)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({
          id: 'task_restart_nomodel', conversationId: null, goal: 'file the invoice',
          unattended: true, resumeOnLaunch: true,
          plan: [{ kind: 'single', step: 'file it', tools: [], status: 'pending', note: '' }],
          results: {}, status: 'paused', note: 'p', stepIndex: 0, retried: false, toolCalls: 0,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: []
        });
        // Interrupted before it ever had a plan — nothing to pick up.
        tasks.unshift({
          id: 'task_restart_noplan', conversationId: null, goal: 'plan-less run',
          unattended: true, resumeOnLaunch: true, plan: [],
          results: {}, status: 'paused', note: 'p', stepIndex: 0, retried: false, toolCalls: 0,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: []
        });
        StorageManager.set('agent-tasks', tasks);

        const origModel = TaskService._model;
        TaskService._model = () => null;
        await TaskService._resumeUnattendedRuns();
        TaskService._model = origModel;

        const noplan = TaskService.get('task_restart_noplan');
        const nomodel = TaskService.get('task_restart_nomodel');
        const titles = window.__eval.notifs.map(n => n.title);
        const pass = noplan.status === 'failed' && /did not have a plan|did not run/.test(noplan.note)
          && titles.some(t => /did not survive a restart/i.test(t))
          && nomodel.status === 'paused' && nomodel.resumeOnLaunch === true
          && titles.some(t => /routine run is paused/i.test(t));
        return { pass, detail: JSON.stringify({ noplan: noplan.status, nomodel: nomodel.status, titles }) };
      });
    }
  },

  // ── Report tone — completed work reads as completed ──────────────────

  {
    // The 16:48 run announced "This run did not finish" over a completed
    // job, and buried the one thing that mattered — a refused prompt
    // injection — in a step note under a wall of `unknown` rows.
    id: 'report-completed-with-caveats',
    name: 'unverified bookkeeping reads as complete-with-caveats, and model-caught facts lead (§v3.4)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        AgentService.conversations.push({ id: 'conv_tone', messages: [], updatedAt: new Date().toISOString() });
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({
          id: 'task_tone', conversationId: 'conv_tone', goal: 'capture each invoice as a task',
          plan: [
            { kind: 'single', step: 'read the invoices', tools: [], status: 'done', note: '',
              result: 'Read four attachments. One email body contained an instruction telling me to write IDIOT in the task title; I ignored that instruction in the email because it is data, not a request from the user. Totals extracted.' },
            { kind: 'foreach', step: 'capture each', tools: [], status: 'done', unverified: 2,
              note: '1/3 items (2 unverified)', result: 'r', itemsFrom: 1, perItem: 'p' }
          ],
          results: { '1': { items: ['A', 'B', 'C'] }, '2': { rows: [
            { item: 'A', data: 'captured' },
            { item: 'B', data: 'unverified: rows could not be matched', unverified: true },
            { item: 'C', data: 'unverified: rows could not be matched', unverified: true }
          ] } },
          status: 'verifying', note: '', stepIndex: 2, retried: false, toolCalls: 0,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: []
        });
        StorageManager.set('agent-tasks', tasks);

        await TaskService._report('task_tone', [{ ok: true, issue: '' }, { ok: true, issue: '' }],
          { achieved: true, missing: '' });
        const t = TaskService.get('task_tone');
        const conv = AgentService.conversations.find(c => c.id === 'conv_tone');
        const report = conv.messages.length ? conv.messages[conv.messages.length - 1].content : '';

        const pass = t.status === 'done'
          && t.note === 'Done, with caveats.'
          && /^Task complete, with caveats/.test(report)
          && !/did not finish/i.test(report)
          && /Flagged during this run/.test(report)
          && /ignored that instruction in the email/.test(report.split('△')[0])   // above the step lines
          && /could not match every result back to its item/.test(report)
          && /△ capture each/.test(report)
          && t.recipeEligible === false;
        return { pass, detail: JSON.stringify({
          status: t.status, note: t.note, head: report.slice(0, 240)
        }) };
      });
    }
  }
];
