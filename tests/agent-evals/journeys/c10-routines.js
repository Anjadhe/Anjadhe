/**
 * C10 regression net — routines: the merged trigger union, run modes, and
 * the unattended semantics inherited from C8.5.
 *
 * Ported from c85-automations.js when Automations merged into Routines
 * (2026-08-03). The behaviours under test did not change — where they run
 * did: AutomationService's triggers now live in PromptFeed, and an armed
 * automation is a `runMode:'task'` routine note.
 */
const RESET = `
  // Routines live in the shared notes blob; drop only the ones a journey
  // made, so fixtures/user notes in the eval profile survive.
  (() => {
    // app_notes is RECORD-MERGED: a removal without a tombstone unions right
    // back from the store, so eval routines were quietly surviving their own
    // reset (found when a resurrected task-mode routine claimed another
    // journey's mail). Tombstone what we drop.
    const all = NotePrompts._readNotes();
    const notes = all.filter(n => !/^eval:/.test(n.title || ''));
    const at = new Date().toISOString();
    const tombstones = {};
    for (const n of all) if (!notes.includes(n)) tombstones[n.id] = at;
    NotePrompts._writeNotes(notes, Object.keys(tombstones).length ? tombstones : null);
    // In-memory slate only, on purpose: runs and seen UNION on write (a
    // stamp never rewinds, an identity never un-processes), so no renderer
    // write can empty the stored copies — and none needs to. The engine
    // reads its in-memory state, and every journey isolates by creating its
    // own fresh routine ids; stale stored entries for dead ids are inert.
    RoutineEngine.state.runs = {};
    RoutineEngine.state.errors = {};
    RoutineEngine.state.seen = {};
    RoutineEngine.local.queue = [];
    RoutineEngine.local.checks = {};
    RoutineEngine.saveLocal();
  })()
`;

module.exports = [
  {
    id: 'c10-arm-validation',
    name: 'create_routine validates triggers and labels them',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        const bad1 = await AgentTools.handlers.create_routine({ prompt: 'x', trigger: { type: 'email' } });
        const bad2 = await AgentTools.handlers.create_routine({ prompt: '', trigger: { type: 'time', interval: 'daily' } });
        const bad3 = await AgentTools.handlers.create_routine({ prompt: 'x', trigger: { type: 'file' } });
        const good = await AgentTools.handlers.create_routine({
          title: 'eval: daily brief', prompt: 'Summarize',
          trigger: { type: 'time', interval: 'daily', time: '07:00' }
        });
        const pass = !!bad1.error && !!bad2.error && !!bad3.error
          && good.success === true && good.trigger === 'daily at 7:00 AM'
          && good.runMode === 'digest';
        return { pass, detail: JSON.stringify({ bad1: bad1.error, bad2: bad2.error, bad3: bad3.error, label: good.trigger }) };
      }, RESET);
    }
  },
  {
    id: 'c10-time-due-logic',
    name: 'anchored slot fires once a day; an acting routine never fires retroactively',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        const now = new Date();
        const past = String(now.getHours()).padStart(2, '0') + ':' + String(Math.max(0, now.getMinutes() - 5)).padStart(2, '0');
        const later = String((now.getHours() + 2) % 24).padStart(2, '0') + ':00';
        const mk = (time, createdAt, runMode) => ({
          id: 'eval_' + Math.random().toString(36).slice(2), title: 'eval: t',
          content: '<p>go</p>', template: 'prompt', createdAt,
          prompt: { offline: true, runMode, interval: 'daily', time, trigger: { type: 'time', interval: 'daily', time } }
        });
        const yesterday = new Date(Date.now() - 86400000).toISOString();

        // Never run + slot already passed today → fires.
        const dueNow = await RoutineEngine._dueFor(mk(past, yesterday, 'digest'), Date.now());

        // Never run at all → a DIGEST fires immediately whatever its slot
        // says. Documented law, not an accident: see _retroBlocked's comment
        // and CLAUDE.md ("A digest firing immediately on creation is
        // long-standing, wanted behaviour"). Asserting the opposite here is
        // what this case did until 2026-08-03, when it was first run.
        const freshDigest = await RoutineEngine._dueFor(mk(later, new Date().toISOString(), 'digest'), Date.now());

        // Already ran today's slot → quiet until the next one. This is the
        // real anchor-to-wall-clock assertion, and it needs a run STAMP —
        // _isDue short-circuits on "never run" before it looks at the clock.
        const ran = mk(past, yesterday, 'digest');
        RoutineEngine.state.runs[ran.id] = new Date().toISOString();
        const dueAfterRun = await RoutineEngine._dueFor(ran, Date.now());

        // The guard that matters after the merge: a routine that can WRITE,
        // armed after today's slot passed, must wait for tomorrow.
        const retroTask = await RoutineEngine._dueFor(mk(past, new Date().toISOString(), 'task'), Date.now());

        const pass = !!dueNow && !!freshDigest && !dueAfterRun && !retroTask;
        return { pass, detail: JSON.stringify({
          dueNow: !!dueNow, freshDigest: !!freshDigest,
          dueAfterRun: !!dueAfterRun, retroTask: !!retroTask
        }) };
      }, RESET);
    }
  },
  {
    id: 'c10-file-trigger',
    name: 'a fresh file in the watched folder fires with its path',
    kind: 'det',
    async run({ page, docs }) {
      return await page.evaluate(async ({ dir, reset }) => {
        eval(reset);
        const res = await AgentTools.handlers.create_routine({
          title: 'eval: file it', prompt: 'file it',
          trigger: { type: 'file', folder: dir, pattern: 'fresh-*.txt' }
        });
        const note = () => NotePrompts.list().find(n => n.id === res.id);
        const pre = await RoutineEngine._dueFor(note(), Date.now());
        await window.electronAgentFS.write(dir + '/fresh-drop.txt', 'landed');
        const post = await RoutineEngine._dueFor(note(), Date.now());
        const pass = pre === null && !!post && /fresh-drop\.txt/.test(post.suffix || '');
        return { pass, detail: JSON.stringify({ pre, suffix: post?.suffix }) };
      }, { dir: docs, reset: RESET });
    }
  },
  {
    id: 'c10-email-trigger',
    name: 'a matching new email fires; one that predates arming does not',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        // Seeds EmailApp.emails, the loaded mailbox — NOT the `emails` field
        // on the email blob, which stopped existing when messages moved to
        // the SQLite table. This journey seeded the dead field and so passed
        // green for as long as the feature was completely broken; a fixture
        // has to come from the same place production reads.
        const original = EmailApp.emails;
        const loaded = EmailApp._dataLoaded;
        EmailApp._dataLoaded = true;
        const mk = (id, subject, ms) => ({
          messageId: id, id, from: 'billing@acme.com', subject,
          labels: ['INBOX'], internalDate: String(Date.now() + ms),
          date: new Date(Date.now() + ms).toISOString()
        });
        // Older than arming → must NOT fire (or arming a rule would replay
        // every matching message already in the mailbox).
        EmailApp.emails = [mk('e_old', 'Invoice 1', -86400000)];
        const res = await AgentTools.handlers.create_routine({
          title: 'eval: invoices', prompt: 'log it',
          trigger: { type: 'email', subject: 'invoice' }
        });
        const note = () => NotePrompts.list().find(n => n.id === res.id);
        const pre = await RoutineEngine._dueFor(note(), Date.now());
        EmailApp.emails = [...EmailApp.emails, mk('e_new', 'Invoice 2', 1000)];
        const post = await RoutineEngine._dueFor(note(), Date.now());
        // Sent mail matching the rule is not "an email arrived".
        EmailApp.emails = [{ ...mk('e_sent', 'Invoice 3', 2000), labels: ['SENT'] }];
        const sent = await RoutineEngine._dueFor(note(), Date.now());
        EmailApp.emails = original;
        EmailApp._dataLoaded = loaded;
        const pass = pre === null && sent === null && !!post && /Invoice 2/.test(post.suffix || '');
        return { pass, detail: JSON.stringify({ pre, sent, suffix: post?.suffix }) };
      }, RESET);
    }
  },
  {
    id: 'c10-email-trigger-body',
    name: 'a `contains` rule matches the message text, not just the subject',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        // The reported failure: "every time I get an email with an invoice"
        // where the word never appears in the subject line.
        const original = EmailApp.emails;
        const loaded = EmailApp._dataLoaded;
        const ensure = EmailApp._ensureBody;
        EmailApp._dataLoaded = true;
        EmailApp.emails = [];
        const res = await AgentTools.handlers.create_routine({
          title: 'eval: invoice text', prompt: 'log it',
          trigger: { type: 'email', contains: 'invoice' }
        });
        const note = () => NotePrompts.list().find(n => n.id === res.id);
        const mk = (id, subject, snippet, body) => ({
          messageId: id, id, from: 'ap@northgate.com', subject, snippet, bodyText: body,
          labels: ['INBOX'], internalDate: String(Date.now() + 1000),
          date: new Date(Date.now() + 1000).toISOString()
        });
        EmailApp._ensureBody = async (e) => e;   // bodies are pre-attached here
        EmailApp.emails = [mk('e_sub', 'Your monthly statement', 'Statement is ready', 'Nothing to see.')];
        const miss = await RoutineEngine._dueFor(note(), Date.now());
        EmailApp.emails = [mk('e_body', 'Your monthly statement', 'Statement is ready', 'Attached is invoice #4471, due Aug 20.')];
        const hit = await RoutineEngine._dueFor(note(), Date.now());
        EmailApp.emails = original;
        EmailApp._dataLoaded = loaded;
        EmailApp._ensureBody = ensure;
        const pass = miss === null && !!hit
          && NotePrompts.config(note()).trigger.contains === 'invoice';
        return { pass, detail: JSON.stringify({ miss, suffix: hit?.suffix }) };
      }, RESET);
    }
  },
  {
    id: 'c10-away-ask-pauses',
    name: 'an unattended ask pauses + notifies — no dialog, no silent stall',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({
          id: 'task_e_away', conversationId: null, goal: 'away eval', unattended: true, routineId: 'r1',
          plan: [{ step: 'send it', tools: ['email'], status: 'pending', note: '' }],
          status: 'running', note: '', stepIndex: 0, retried: false, toolCalls: 0,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: []
        });
        StorageManager.set('agent-tasks', tasks);
        TaskService._controls.set('task_e_away', { pause: false, cancel: false });
        let dialog = false;
        const origConfirm = AgentService._confirmWrite;
        AgentService._confirmWrite = async () => { dialog = true; return { approved: false }; };
        const origChat = TaskService._chat;
        TaskService._chat = async () => ({ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'send_email', arguments: JSON.stringify({ to: 'x@y.com', subject: 's', body: 'b' }) } }] } });
        const res = await TaskService._runStep('task_e_away', 0);
        TaskService._chat = origChat;
        AgentService._confirmWrite = origConfirm;
        const t = TaskService.get('task_e_away');
        const notified = window.__eval.notifs.some(n => /needs your approval/i.test(n.title));
        const pass = res.interrupted === true && t.status === 'awaiting_user' && !dialog && notified;
        return { pass, detail: JSON.stringify({ status: t.status, dialog, notified }) };
      });
    }
  },
  {
    id: 'c10-resume-marks-attended',
    name: 'a human resume flips the run to attended',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        // Self-contained: its own paused unattended task (journeys must not
        // depend on a prior journey's state — resetState fails leftovers).
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({
          id: 'task_e_resume', conversationId: null, goal: 'resume eval', unattended: true,
          plan: [{ step: 's', tools: [], status: 'pending', note: '' }],
          status: 'awaiting_user', note: 'waiting', stepIndex: 0, retried: false, toolCalls: 0,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: []
        });
        StorageManager.set('agent-tasks', tasks);
        const before = TaskService.get('task_e_resume').unattended;
        const origChat = TaskService._chat;
        TaskService._chat = async () => ({ message: { content: 'DONE: nothing', tool_calls: [] } });
        await TaskService.approve('task_e_resume');
        // approve() fires _run in the background — WAIT for it to settle
        // BEFORE restoring the stub, or the dangling run continues on the
        // real model and races the rest of the suite (it crashed the app).
        for (let i = 0; i < 40; i++) {
          const st = TaskService.get('task_e_resume').status;
          if (['done', 'failed'].includes(st)) break;
          await new Promise(r => setTimeout(r, 500));
        }
        TaskService._chat = origChat;
        const t = TaskService.get('task_e_resume');
        const settled = ['done', 'failed'].includes(t.status);
        return { pass: before === true && t.unattended === false && settled, detail: JSON.stringify({ before, after: t.unattended, status: t.status }) };
      });
    }
  },
  {
    id: 'c10-busy-unstamped',
    name: 'a trigger firing while a task runs stays unstamped (retries)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({ id: 'task_e_busy', goal: 'busy', plan: [], status: 'running', note: '', stepIndex: 0, retried: false, toolCalls: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: [] });
        StorageManager.set('agent-tasks', tasks);
        const res = await AgentTools.handlers.create_routine({
          title: 'eval: waits', prompt: 'waits', runMode: 'task',
          trigger: { type: 'time', interval: 'daily' }
        });
        const note = NotePrompts.list().find(n => n.id === res.id);
        const out = await PromptFeed._runAsTask(note, null);
        const stamped = RoutineEngine.state.runs[res.id] || null;
        StorageManager.set('agent-tasks', (StorageManager.get('agent-tasks') || []).filter(t => t.id !== 'task_e_busy'));
        return {
          pass: out.deferred === true && stamped === null,
          detail: JSON.stringify({ deferred: out.deferred, stamped })
        };
      }, RESET);
    }
  },
  {
    // 2026-08-03 (reversing C10's "both post to the feed"): an action run's
    // report is an execution LOG, not content — it belongs on the task
    // record, read from the routine detail's Run history, never on the feed.
    id: 'c10-task-run-log-off-feed',
    name: 'a settled task-mode run stores its log on the task, not the feed',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        const res = await AgentTools.handlers.create_routine({
          title: 'eval: logger', prompt: 'do a thing', runMode: 'task',
          trigger: { type: 'time', interval: 'daily' }
        });
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({
          id: 'task_e_log', goal: 'eval: do the thing', routineId: res.id,
          plan: [{ step: 'did the thing', status: 'done', result: 'it worked' }],
          results: {}, status: 'running', note: '', stepIndex: 1, retried: false,
          toolCalls: 0, createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(), log: [], toolLog: []
        });
        StorageManager.set('agent-tasks', tasks);
        await TaskService._report('task_e_log', [], null);
        const posts = PromptFeed._feedNotes().filter(n => n.feed?.promptId === res.id);
        const settled = (StorageManager.get('agent-tasks') || []).find(t => t.id === 'task_e_log');
        const report = settled?.report || '';
        const errored = !!(RoutineEngine.state.errors || {})[res.id];
        StorageManager.set('agent-tasks', (StorageManager.get('agent-tasks') || []).filter(t => t.id !== 'task_e_log'));
        const pass = posts.length === 0
          && /did the thing/.test(report)
          && typeof PromptFeed.postTaskResult === 'undefined'
          && !errored;
        return { pass, detail: JSON.stringify({ posts: posts.length, report: report.slice(0, 120), poster: typeof PromptFeed.postTaskResult, errored }) };
      }, RESET);
    }
  },
  {
    id: 'c10-home-machine-pin',
    name: 'a routine homed to another Mac is not run by this one',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        const mine = RoutineEngine._machineId;
        const here = RoutineEngine._runsHere({ homeMachineId: mine });
        const elsewhere = RoutineEngine._runsHere({ homeMachineId: 'some-other-mac' });
        const unpinned = RoutineEngine._runsHere({ homeMachineId: null });
        // Fails OPEN when this Mac's id is unknown: a routine that never runs
        // because an IPC call failed is a worse outcome than a duplicate post.
        const saved = RoutineEngine._machineId;
        RoutineEngine._machineId = null;
        const idUnknown = RoutineEngine._runsHere({ homeMachineId: 'some-other-mac' });
        RoutineEngine._machineId = saved;
        const pass = !!mine && here === true && elsewhere === false
          && unpinned === true && idUnknown === true;
        return { pass, detail: JSON.stringify({ mine, here, elsewhere, unpinned, idUnknown }) };
      }, RESET);
    }
  },
  {
    id: 'c10-automation-migration',
    name: 'an armed automation becomes a task-mode routine, once',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        StorageManager.set('agent-automations', [
          { id: 'a_mig', goal: 'eval: migrate me\nsecond line', trigger: { type: 'email', subject: 'receipt' },
            enabled: true, createdAt: new Date().toISOString(), lastRunAt: '2026-08-01T07:00:00.000Z' },
          { id: 'a_off', goal: 'eval: disabled one', trigger: { type: 'time', interval: 'daily' },
            enabled: false, createdAt: new Date().toISOString(), lastRunAt: null }
        ]);
        await PromptFeed._migrateAutomations();
        const all = NotePrompts.list();
        const armed = all.find(n => (n.title || '').startsWith('eval: migrate me'));
        const off = all.find(n => (n.title || '').startsWith('eval: disabled one'));
        const armedCfg = armed ? NotePrompts.config(armed) : null;
        const offCfg = off ? NotePrompts.config(off) : null;
        // Idempotent: the source key is cleared, so a second pass adds nothing.
        await PromptFeed._migrateAutomations();
        const again = NotePrompts.list().filter(n => (n.title || '').startsWith('eval: migrate me')).length;
        const pass = !!armed && armedCfg.runMode === 'task' && armedCfg.offline === true
          && armedCfg.trigger.type === 'email' && armedCfg.trigger.subject === 'receipt'
          && NotePrompts.bodyText(armed).includes('second line')
          && RoutineEngine.state.runs[armed.id] === '2026-08-01T07:00:00.000Z'
          && !!off && offCfg.offline === false
          && again === 1;
        return { pass, detail: JSON.stringify({
          runMode: armedCfg?.runMode, trigger: armedCfg?.trigger,
          disabledArmed: offCfg?.offline, copies: again
        }) };
      }, RESET);
    }
  },
  {
    // R5's queue (docs/ROUTINE_TRIGGERS.md). tick() used to start ONE
    // task-mode routine and `break`, with nothing queueing the rest — D1's
    // compounding half. Task-mode runs now go serially through TaskService's
    // single slot while digests interleave past one that is waiting, and
    // nothing is dropped or re-queued forever.
    id: 'r5-queue-drains-through-one-task-slot',
    name: 'a trigger firing while a task run is active is queued, not dropped; digests interleave',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        // The live scheduler is a real ticker in this app instance and its
        // drain holds `_draining` (which makes a second drain a no-op — by
        // design, the running one picks the work up). This journey exercises
        // the queue in isolation, so it takes the engine off the clock and
        // puts it back at the end.
        if (RoutineEngine._timer) clearInterval(RoutineEngine._timer);
        RoutineEngine._timer = null;
        RoutineEngine._draining = false;

        const digest = await AgentTools.handlers.create_routine({
          title: 'eval: digest', prompt: 'summarize',
          trigger: { type: 'time', interval: 'daily' }
        });
        const acts = await AgentTools.handlers.create_routine({
          title: 'eval: acts', prompt: 'file it', runMode: 'task',
          trigger: { type: 'time', interval: 'daily' }
        });

        // Occupy the single task slot.
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({ id: 'task_e_slot', goal: 'busy', plan: [], status: 'running', note: '',
          stepIndex: 0, retried: false, toolCalls: 0, createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(), log: [], toolLog: [] });
        StorageManager.set('agent-tasks', tasks);

        const ran = [];
        const origRun = PromptFeed.runRoutine;
        PromptFeed.runRoutine = async (p) => { ran.push(p.id); return {}; };

        // Arrival order: the task-mode routine fired first.
        RoutineEngine.enqueue(acts.id, { identity: 'slot:1', suffix: 'invoice' }, 'task');
        RoutineEngine.enqueue(digest.id, { identity: 'slot:1', suffix: null }, 'digest');
        // The same thing on the next tick must not queue twice — a queued
        // item has not stamped `runs` yet, so without the identity dedupe it
        // would re-enqueue every five minutes while it waited.
        const dup = RoutineEngine.enqueue(acts.id, { identity: 'slot:1' }, 'task');
        const queuedAfterDup = RoutineEngine.queue().length;

        await RoutineEngine.drain();
        const firstPass = [...ran];
        const stillQueued = RoutineEngine.queue().map(q => q.routineId);

        // Slot frees — the queued task-mode run gets its turn.
        StorageManager.set('agent-tasks',
          (StorageManager.get('agent-tasks') || []).filter(t => t.id !== 'task_e_slot'));
        await RoutineEngine.drain();
        PromptFeed.runRoutine = origRun;
        RoutineEngine.startScheduler();

        const pass = dup === false && queuedAfterDup === 2
          && firstPass.length === 1 && firstPass[0] === digest.id
          && stillQueued.length === 1 && stillQueued[0] === acts.id
          && ran.length === 2 && ran[1] === acts.id
          && RoutineEngine.queue().length === 0;
        return { pass, detail: JSON.stringify({ dup, queuedAfterDup, firstPass, stillQueued, ran }) };
      }, RESET);
    }
  },
  {
    // R4 (D4/T6): "nothing matched" and "broken since you armed it" looked
    // identical, and that is the only reason D0 survived from C8.5 to C10.
    // The test must report without CHANGING anything, or using it would move
    // the very marker it is meant to explain.
    id: 'r4-test-trigger-reports-and-stamps-nothing',
    name: 'Test trigger says what would fire and records nothing; the tick stamps checked/matched',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        const original = EmailApp.emails;
        const loaded = EmailApp._dataLoaded;
        EmailApp._dataLoaded = true;
        EmailApp.emails = [];
        const res = await AgentTools.handlers.create_routine({
          title: 'eval: probe', prompt: 'log it',
          trigger: { type: 'email', subject: 'invoice' }
        });
        const note = () => NotePrompts.list().find(n => n.id === res.id);
        EmailApp.emails = [{
          messageId: 'e_probe', id: 'e_probe', from: 'billing@acme.com', subject: 'Invoice 9',
          labels: ['INBOX'], internalDate: String(Date.now() + 1000),
          date: new Date(Date.now() + 1000).toISOString()
        }];

        const before = JSON.stringify({
          runs: RoutineEngine.state.runs, errors: RoutineEngine.state.errors,
          checks: RoutineEngine.local.checks
        });
        const probe = await RoutineEngine.testTrigger(note());
        const after = JSON.stringify({
          runs: RoutineEngine.state.runs, errors: RoutineEngine.state.errors,
          checks: RoutineEngine.local.checks
        });

        // A folder that cannot be read reports the problem to the CALLER
        // rather than stamping it on the routine.
        const bad = await AgentTools.handlers.create_routine({
          title: 'eval: bad folder', prompt: 'x',
          trigger: { type: 'file', folder: '/no/such/folder/anywhere' }
        });
        const badProbe = await RoutineEngine.testTrigger(NotePrompts.list().find(n => n.id === bad.id));
        const noErrorStamped = !RoutineEngine.state.errors[bad.id];

        // The real tick DOES stamp — that is what makes the page able to say
        // "checked 4 minutes ago, never matched".
        RoutineEngine.noteChecked(res.id);
        const status = RoutineEngine.statusFor(res.id);

        EmailApp.emails = original;
        EmailApp._dataLoaded = loaded;
        const pass = probe.fired === true && /Invoice 9/.test(probe.suffix || '')
          && probe.identity === 'mail:e_probe'
          && before === after
          && !!badProbe.error && noErrorStamped
          && !!status.lastCheckedAt && status.lastMatchedAt === null && status.lastRun === null;
        return { pass, detail: JSON.stringify({
          fired: probe.fired, identity: probe.identity, unchanged: before === after,
          badProbe: badProbe.error, noErrorStamped, status
        }) };
      }, RESET);
    }
  },
  {
    // The C10 merge put create_routine in the keyword-scoped 'prompts' group.
    // create_automation had been UNGROUPED (= core, every turn), so the
    // trigger phrasings below stopped shipping any routine tool and the model
    // answered "I have no create_routine function". Scoping is what makes a
    // tool reachable, so it is as load-bearing as the handler.
    id: 'c10-trigger-phrasings-ship-tools',
    name: 'trigger and automation wording ships the routine tools',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const asks = [
          'Help me setup an automation. Every time i get an email with an invoice, capture the details and create a high priority task',
          'whenever a file lands in my Downloads folder, file it',
          'when I get an email from my landlord, add it to my schedule',
          'set up a routine to review my goals on Sundays',
          'run this in the background without me',
          'every morning give me a news digest'
        ];
        const missing = asks.filter(a => !AgentTools.definitionsFor(a)
          .some(d => d.function?.name === 'create_routine'));
        // The interview door ships with the same vocabulary — the "help me
        // set up" phrasing is exactly the one the Routines page's pill sends.
        const noInterview = asks.filter(a => !AgentTools.definitionsFor(a)
          .some(d => d.function?.name === 'start_routine_interview'));
        // The other side of the bargain: ordinary asks must NOT pay for it.
        const leaked = ['what time is my dentist appointment', 'summarize this email']
          .filter(a => AgentTools._domainsForMessage(a).has('prompts'));
        return {
          pass: missing.length === 0 && noInterview.length === 0 && leaked.length === 0,
          detail: JSON.stringify({ missing, noInterview, leaked })
        };
      });
    }
  },
  {
    // The guided intake (goals pattern): the fixed agenda reaches the model
    // with its instructions and next question, and existing routines ride
    // along so a near-duplicate is continued rather than doubled.
    id: 'c10-routine-interview-agenda',
    name: 'start_routine_interview hands over the fixed agenda',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        await AgentTools.handlers.create_routine({
          title: 'eval: existing digest', prompt: 'daily digest',
          trigger: { type: 'time', interval: 'daily', time: '08:00' }
        });
        const r = AgentTools.handlers.start_routine_interview();
        const ids = (r.agenda || []).map(t => t.id);
        const pass = !r.error
          && /one topic at a time/i.test(r.instructions || '')
          && ['purpose', 'trigger', 'mode', 'review'].every(id => ids.includes(id))
          && r.nextTopic && r.nextTopic.id === 'purpose'
          && (r.context.existingRoutines || []).some(x => x.title === 'eval: existing digest');
        return { pass, detail: JSON.stringify({ ids, next: r.nextTopic && r.nextTopic.id, existing: (r.context.existingRoutines || []).length }) };
      }, RESET);
    }
  },
  {
    // Same regression, second door. "Help me set up an automation…" reaches
    // the model as a TASK (it calls start_task), and the task planner picks
    // tool groups per step — it planned one `help` step and answered "I don't
    // have a create_routine function" with the handler sitting right there.
    // _impliedGroups is the deterministic override for exactly this.
    id: 'c10-task-goal-implies-routines',
    name: 'an automation GOAL carries the routine tools on every step',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const goals = [
          'Help me setup an automation. Every time i get an email with an invoice, create a high priority task',
          'set up a routine that files my receipts',
          'whenever a file lands in Downloads, sort it'
        ];
        const missing = goals.filter(g => !TaskService
          ._toolsForGroups(['help'], TaskService._impliedGroups(g))
          .some(d => d.function?.name === 'create_routine'));
        const leaked = ['book a dentist appointment', 'summarize my inbox']
          .filter(g => TaskService._impliedGroups(g).includes('prompts'));
        return {
          pass: missing.length === 0 && leaked.length === 0,
          detail: JSON.stringify({ missing, leaked })
        };
      });
    }
  },
  {
    // A digest that failed TRANSIENTLY (ECONNREFUSED against a rebooting
    // server, a cut stream, an empty completion) must not post its error to
    // the feed until the tick-spaced retries are spent — the observed
    // failures outlive an immediate retry, so the item rides the queue.
    // Manual "Run now" keeps posting at once: a present user should see the
    // failure now, not wait three ticks for it.
    id: 'c10-transient-digest-retries-then-posts',
    name: 'a transient digest failure retries across ticks, cards once, then rides the backoff ladder until the brain returns',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        const res = await AgentTools.handlers.create_routine({
          title: 'eval: transient retry', prompt: 'Summarize the news',
          trigger: { type: 'time', interval: 'daily', time: '07:00' }
        });
        // Drive the queue by hand — the arming nudge would race our stubs,
        // and drain() no-ops while the startup tick's own drain is in
        // flight, so wait that out first.
        if (RoutineEngine._timer) { clearInterval(RoutineEngine._timer); RoutineEngine._timer = null; }
        if (RoutineEngine._nudgeTimer) clearTimeout(RoutineEngine._nudgeTimer);
        for (let i = 0; i < 40 && RoutineEngine._draining; i++) {
          await new Promise(r => setTimeout(r, 50));
        }
        const wasStuck = RoutineEngine._draining;
        // A startup drain wedged on a dead model call would no-op ours
        // forever; its snapshot predates our enqueue, so releasing the
        // latch cannot double-run the item under test.
        RoutineEngine._draining = false;
        RoutineEngine._busy = false;
        RoutineEngine.local.queue = [];

        const orig = {
          plain: PromptFeed._generatePlain,
          web: PromptFeed._generateWithWeb,
          asst: PromptFeed._generateWithAssistant
        };
        let verdicts = [];
        const stub = async () => verdicts.length
          ? verdicts.shift()
          : { content: '', error: 'connect ECONNREFUSED 127.0.0.1:18434', model: 'm' };
        PromptFeed._generatePlain = PromptFeed._generateWithWeb = PromptFeed._generateWithAssistant = stub;

        const prompt = () => NotePrompts.list().find(n => n.id === res.id);
        const cards = () => NotePrompts._readNotes()
          .filter(n => n.template === 'feed' && n.feed && n.feed.promptId === res.id);
        const queued = () => RoutineEngine.queue().find(q => q.routineId === res.id);

        try {
          // Manual path: no context → the error posts immediately.
          const manual = await PromptFeed._runPrompt(prompt());
          const manualPosted = !!(manual && manual.feed && manual.feed.error) && cards().length === 1;

          // Engine path: two ticks of silence, the card on the third — and
          // the card is visibility, not the settlement: the item stays
          // queued, carded, waiting out a backoff step (2026-08-19).
          RoutineEngine.enqueue(res.id, { identity: 'once' }, 'digest');
          await RoutineEngine.drain();
          const afterFirst = { attempts: queued() && queued().attempts, cards: cards().length,
            noted: /retrying/i.test(RoutineEngine.state.errors[res.id] || '') };
          await RoutineEngine.drain();
          const afterSecond = { attempts: queued() && queued().attempts, cards: cards().length };
          await RoutineEngine.drain();
          const afterThird = { queued: !!queued(), carded: !!(queued() && queued().carded),
            backedOff: !!(queued() && queued().nextRetryAt > Date.now()),
            cards: cards().length,
            errored: /ECONNREFUSED/.test((cards()[0] || {}).feed?.error || '') };

          // Backoff honoured: a drain inside the ladder step must not
          // re-run the item (a consumed verdict would prove it did).
          verdicts = [{ content: 'too early', error: null, model: 'm' }];
          await RoutineEngine.drain();
          const heldBack = { queued: !!queued(), verdictUntouched: verdicts.length === 1,
            cards: cards().length };

          // Brain becomes available: retryNow() collapses the backoff (the
          // _kickBackgroundAI door) and the carded run completes — the
          // success edition posts and the fire finally settles.
          RoutineEngine.retryNow();
          await RoutineEngine.drain();
          const recoveredLate = { queued: !!queued(),
            good: cards().some(n => !n.feed.error && /too early/.test(n.content || '')),
            errorCleared: !RoutineEngine.state.errors[res.id] };

          // Supersede: a new schedule slot's fire replaces an older slot's
          // still-queued digest item for the same routine.
          RoutineEngine.enqueue(res.id, { identity: 'slot:2026-01-01T07:00:00.000Z' }, 'digest');
          RoutineEngine.enqueue(res.id, { identity: 'slot:2026-01-02T07:00:00.000Z' }, 'digest');
          const slots = RoutineEngine.queue().filter(x => x.routineId === res.id);
          const superseded = slots.length === 1 && /2026-01-02/.test(slots[0].identity);
          RoutineEngine.local.queue = RoutineEngine.queue().filter(x => x.routineId !== res.id);
          RoutineEngine.saveLocal();

          // Recovery: one transient failure, then an answer — no error card,
          // the "Last problem" line cleared.
          verdicts = [
            { content: '', error: 'read ECONNRESET', model: 'm' },
            { content: 'All quiet on the AI front.', error: null, model: 'm' }
          ];
          RoutineEngine.enqueue(res.id, { identity: 'once' }, 'digest');
          await RoutineEngine.drain();
          const midRecovery = { attempts: queued() && queued().attempts };
          await RoutineEngine.drain();
          const recovered = {
            queued: !!queued(),
            cards: cards().length,
            good: cards().some(n => !n.feed.error && /quiet/.test(n.content || '')),
            errorCleared: !RoutineEngine.state.errors[res.id]
          };

          const pass = manualPosted
            && afterFirst.attempts === 1 && afterFirst.cards === 1 && afterFirst.noted
            && afterSecond.attempts === 2 && afterSecond.cards === 1
            && afterThird.queued && afterThird.carded && afterThird.backedOff
            && afterThird.cards === 2 && afterThird.errored
            && heldBack.queued && heldBack.verdictUntouched && heldBack.cards === 2
            && !recoveredLate.queued && recoveredLate.good && recoveredLate.errorCleared
            && superseded
            && midRecovery.attempts === 1
            && !recovered.queued && recovered.cards === 4 && recovered.good && recovered.errorCleared;
          return { pass, detail: JSON.stringify({ wasStuck, manualPosted, afterFirst, afterSecond, afterThird, heldBack, recoveredLate, superseded, midRecovery, recovered }) };
        } finally {
          PromptFeed._generatePlain = orig.plain;
          PromptFeed._generateWithWeb = orig.web;
          PromptFeed._generateWithAssistant = orig.asst;
        }
      }, RESET);
    }
  },
  {
    id: 'c10-headless-egress-no-dialog',
    name: 'an unattended digest never opens the egress dialog — trusted allows, untrusted denies',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        // The C2 egress gate (read_url in a tainted turn → ask) reached
        // AgentUI.confirmToolCall from runHeadless — a modal with nobody in
        // front of it. The law is the one task mode already enforces
        // (c10-away-ask-pauses): no dialog unattended. A digest has no
        // pause, so the ask resolves in place: trusted input auto-allows
        // (arming was the consent), untrusted input (email/file-triggered)
        // denies — a model-written URL is an exfil channel.
        const orig = {
          call: LLMLogger.callStream,
          exec: AgentTools.execute,
          confirm: AgentUI.confirmToolCall,
          grants: PermissionManager._grants,
          session: PermissionManager._sessionGrants,
          model: AgentService.model
        };
        try {
          PermissionManager._grants = [];
          PermissionManager._sessionGrants = new Set();
          if (!AgentService.model) AgentService.model = 'eval-model';
          let dialogs = 0;
          AgentUI.confirmToolCall = async () => { dialogs++; return { approved: false }; };
          const makeRun = () => {
            let calls = 0;
            LLMLogger.callStream = async () => {
              calls++;
              // Turn 1: a data tool + read_url together — turnHasDataTool
              // trips the gate without waiting for taint. Turn 2: done.
              if (calls === 1) return { message: { content: '', tool_calls: [
                { id: 'e1', function: { name: 'list_notes', arguments: '{}' } },
                { id: 'e2', function: { name: 'read_url', arguments: JSON.stringify({ url: 'https://example.com/page' }) } }
              ] } };
              return { message: { content: 'digest done', tool_calls: [] } };
            };
          };
          const executed = [];
          AgentTools.execute = async (name) => { executed.push(name); return { ok: true, items: [] }; };

          makeRun();
          const trusted = await AgentService.runHeadless('eval egress trusted', { readOnly: true });
          const trustedFetched = executed.includes('read_url');

          executed.length = 0;
          makeRun();
          const untrusted = await AgentService.runHeadless('eval egress untrusted', { readOnly: true, untrustedInput: true });
          const untrustedFetched = executed.includes('read_url');

          const pass = dialogs === 0
            && trusted && trusted.type === 'text' && trustedFetched
            && untrusted && untrusted.type === 'text' && !untrustedFetched;
          return { pass, detail: JSON.stringify({ dialogs, trustedFetched, untrustedFetched, trusted: trusted && trusted.type, untrusted: untrusted && untrusted.type }) };
        } finally {
          LLMLogger.callStream = orig.call;
          AgentTools.execute = orig.exec;
          AgentUI.confirmToolCall = orig.confirm;
          PermissionManager._grants = orig.grants;
          PermissionManager._sessionGrants = orig.session;
          AgentService.model = orig.model;
        }
      });
    }
  }
];
