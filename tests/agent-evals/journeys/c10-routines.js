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
  // Routines are Standing conversations since 2026-10-07 (NotePrompts is the
  // facade); drop only the ones a journey made, so fixtures in the eval
  // profile survive. remove() goes through AgentService's save funnel,
  // which tombstones (agent-conversations is record-merged, so a removal
  // without one would union right back).
  (() => {
    for (const r of NotePrompts.list()) if (/^eval:/.test(r.title || '')) NotePrompts.remove(r.id);
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
        // AI native (2026-10-02): no phrasing decides; the catalog tells the
        // model what the group does (schedules AND triggers), and loading it
        // ships both doors. The asks are kept as the cases the line must cover.
        const entry = AgentTools.toolCatalog().find(c => c.group === 'prompts');
        const loaded = AgentTools.definitionsFor(null, ['prompts']).map(d => d.function?.name);
        const missing = entry && /trigger/.test(entry.info) && /schedule/.test(entry.info) && loaded.includes('create_routine') ? [] : asks;
        const noInterview = loaded.includes('start_routine_interview') ? [] : asks;
        // The other side of the bargain: an ordinary turn does not pay for it.
        const leaked = AgentTools.definitionsFor(null, []).some(d => d.function?.name === 'create_routine') ? ['core'] : [];
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
    // A digest that failed TRANSIENTLY (ECONNREFUSED against a rebooting
    // server, a cut stream, an empty completion) must not post its error to
    // the feed until the tick-spaced retries are spent — the observed
    // failures outlive an immediate retry, so the item rides the queue.
    // Manual "Run now" keeps posting at once: a present user should see the
    // failure now, not wait three ticks for it.
    id: 'c10-transient-digest-retries-then-posts',
    name: 'a transient failure retries across ticks and rides the backoff ladder quietly (I7: no error post, counted once per fire) until the brain returns',
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
        RoutineEngine._draining = false;
        RoutineEngine._busy = false;
        RoutineEngine.local.queue = [];

        // Since 2026-10-09 a scheduled routine runs as a LOOK (RoutineLook,
        // docs/ROUTINES_UX.md step 1) and a failed run posts nothing (I7,
        // step 2): the look is stubbed; the ladder and the queue are real.
        const orig = { run: RoutineLook.run };
        let verdicts = [];
        const report = (text) => ({ report: { kind: 'delivery', headline: text, changes: [], body: text, card: false }, keep: null, reason: '' });
        RoutineLook.run = async () => verdicts.length ? verdicts.shift() : { error: 'connect ECONNREFUSED 127.0.0.1:18434' };

        const prompt = () => NotePrompts.list().find(n => n.id === res.id);
        const cards = () => NotePrompts.runs(res.id);
        const queued = () => RoutineEngine.queue().find(q => q.routineId === res.id);
        const fails = () => (RoutineEngine.failures()[res.id] || {}).count || 0;

        try {
          // Manual path: the error comes back to the caller (a toast); nothing posts; it is counted.
          const manual = await PromptFeed._runPrompt(prompt());
          const manualQuiet = !!(manual && manual.error) && cards().length === 0 && fails() === 1;

          // Engine path: two ticks of quiet retries, then the ladder: the
          // item stays queued, carded (the failure counted once), backed off.
          RoutineEngine.enqueue(res.id, { identity: 'once' }, 'digest');
          await RoutineEngine.drain();
          const afterFirst = { attempts: queued() && queued().attempts, cards: cards().length, fails: fails(),
            noted: /retrying/i.test(RoutineEngine.state.errors[res.id] || '') };
          await RoutineEngine.drain();
          const afterSecond = { attempts: queued() && queued().attempts, cards: cards().length };
          await RoutineEngine.drain();
          const afterThird = { queued: !!queued(), carded: !!(queued() && queued().carded),
            backedOff: !!(queued() && queued().nextRetryAt > Date.now()), cards: cards().length, fails: fails() };

          // Backoff honoured: a drain inside the ladder step must not re-run the item.
          verdicts = [report('too early')];
          await RoutineEngine.drain();
          const heldBack = { queued: !!queued(), verdictUntouched: verdicts.length === 1, cards: cards().length };

          // The brain returns: retryNow() collapses the backoff and the run posts; the streak clears.
          RoutineEngine.retryNow();
          await RoutineEngine.drain();
          const recoveredLate = { queued: !!queued(), good: cards().some(n => !n.error && /too early/.test(n.content || '')),
            errorCleared: !RoutineEngine.state.errors[res.id], failsCleared: fails() === 0 };

          // Supersede: a new schedule slot's fire replaces an older slot's still-queued item.
          RoutineEngine.enqueue(res.id, { identity: 'slot:2026-01-01T07:00:00.000Z' }, 'digest');
          RoutineEngine.enqueue(res.id, { identity: 'slot:2026-01-02T07:00:00.000Z' }, 'digest');
          const slots = RoutineEngine.queue().filter(x => x.routineId === res.id);
          const superseded = slots.length === 1 && /2026-01-02/.test(slots[0].identity);
          RoutineEngine.local.queue = RoutineEngine.queue().filter(x => x.routineId !== res.id);
          RoutineEngine.saveLocal();

          // Recovery: one transient failure, then an answer.
          verdicts = [{ error: 'read ECONNRESET' }, report('All quiet on the AI front.')];
          RoutineEngine.enqueue(res.id, { identity: 'once' }, 'digest');
          await RoutineEngine.drain();
          const midRecovery = { attempts: queued() && queued().attempts };
          await RoutineEngine.drain();
          const recovered = { queued: !!queued(), cards: cards().length,
            good: cards().some(n => !n.error && /quiet/.test(n.content || '')), errorCleared: !RoutineEngine.state.errors[res.id] };

          const pass = manualQuiet
            && afterFirst.attempts === 1 && afterFirst.cards === 0 && afterFirst.noted && afterFirst.fails === 1
            && afterSecond.attempts === 2 && afterSecond.cards === 0
            && afterThird.queued && afterThird.carded && afterThird.backedOff && afterThird.cards === 0 && afterThird.fails === 2
            && heldBack.queued && heldBack.verdictUntouched && heldBack.cards === 0
            && !recoveredLate.queued && recoveredLate.good && recoveredLate.errorCleared && recoveredLate.failsCleared
            && superseded
            && midRecovery.attempts === 1
            && !recovered.queued && recovered.cards === 2 && recovered.good && recovered.errorCleared;
          return { pass, detail: JSON.stringify({ wasStuck, manualQuiet, afterFirst, afterSecond, afterThird, heldBack, recoveredLate, superseded, midRecovery, recovered }) };
        } finally {
          RoutineLook.run = orig.run;
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
  },
  {
    id: 'c10-routine-detail-renders',
    name: 'opening a routine from a feed post lands on its detail (the page must not throw)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const p = NotePrompts.create({ title: 'Detail Render Probe', body: 'probe', config: { interval: 'daily', time: '07:00' } });
        const pid = (p && p.id) || p;
        let err = null;
        try {
          PromptsApp.open({ id: pid });
        } catch (e) { err = String(e && e.message || e); }
        const main = document.getElementById('prompts-main');
        const text = (main && main.innerText) || '';
        const view = PromptsApp._view;
        // innerText carries the CSS uppercase of the property labels.
        // The title is named by the breadcrumb (the masthead's copy is hidden
        // since the calm pass), so it is read from the page or the crumb.
        const crumb = (document.getElementById('prompts-breadcrumb') || {}).textContent || '';
        const pass = !err && view === 'detail' && PromptsApp._openId === pid
          && /Detail Render Probe/.test(((main && main.textContent) || '') + crumb) && /runs when/i.test(text);
        NotePrompts.remove(pid);
        PromptsApp.open();
        return { pass, detail: JSON.stringify({ err, view, head: text.slice(0, 80) }) };
      });
    }
  }
];
