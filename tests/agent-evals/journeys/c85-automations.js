/**
 * C8.5 regression net — automations: triggers, unattended semantics.
 */
module.exports = [
  {
    id: 'c85-arm-validation',
    name: 'arming validates triggers and labels them',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        const bad1 = AutomationService.create({ goal: 'x', trigger: { type: 'email' } });
        const bad2 = AutomationService.create({ goal: '', trigger: { type: 'time' } });
        const good = AutomationService.create({ goal: 'Summarize', trigger: { type: 'time', interval: 'daily', time: '07:00' } });
        const pass = !!bad1.error && !!bad2.error && !!good.automation
          && AutomationService.triggerLabel(good.automation) === 'daily at 07:00';
        return { pass, detail: JSON.stringify({ bad1: bad1.error, bad2: bad2.error }) };
      });
    }
  },
  {
    id: 'c85-time-due-logic',
    name: 'missed slot fires; future slot waits; no retro-fire on arm',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const now = new Date();
        const past = String(now.getHours()).padStart(2, '0') + ':' + String(Math.max(0, now.getMinutes() - 5)).padStart(2, '0');
        const future = String((now.getHours() + 2) % 24).padStart(2, '0') + ':00';
        const mk = (time, createdAt) => ({ id: 'a', goal: 'g', trigger: { type: 'time', interval: 'daily', time }, enabled: true, createdAt, lastRunAt: null });
        const dueNow = await AutomationService._checkTrigger(mk(past, new Date(Date.now() - 86400000).toISOString()), Date.now());
        const dueFuture = await AutomationService._checkTrigger(mk(future, new Date().toISOString()), Date.now());
        const armedAfterSlot = await AutomationService._checkTrigger(mk(past, new Date().toISOString()), Date.now());
        const pass = !!dueNow && !dueFuture && !armedAfterSlot;
        return { pass, detail: JSON.stringify({ dueNow: !!dueNow, dueFuture: !!dueFuture, retro: !!armedAfterSlot }) };
      });
    }
  },
  {
    id: 'c85-file-trigger',
    name: 'a fresh file in the watched folder fires with its path',
    kind: 'det',
    async run({ page, docs }) {
      return await page.evaluate(async (dir) => {
        const { automation } = AutomationService.create({ goal: 'file it', trigger: { type: 'file', folder: dir, pattern: 'fresh-*.txt' } });
        const pre = await AutomationService._checkTrigger(automation, Date.now());
        await window.electronAgentFS.write(dir + '/fresh-drop.txt', 'landed');
        const post = await AutomationService._checkTrigger(AutomationService.get(automation.id), Date.now());
        const pass = pre === null && !!post && /fresh-drop\.txt/.test(post.suffix || '');
        return { pass, detail: JSON.stringify({ pre, suffix: post?.suffix }) };
      }, docs);
    }
  },
  {
    id: 'c85-away-ask-pauses',
    name: 'an unattended ask pauses + notifies — no dialog, no silent stall',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({
          id: 'task_e_away', conversationId: null, goal: 'away eval', unattended: true, automationId: 'a1',
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
    id: 'c85-resume-marks-attended',
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
    id: 'c85-busy-unstamped',
    name: 'a trigger firing while a task runs stays unstamped (retries)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({ id: 'task_e_busy', goal: 'busy', plan: [], status: 'running', note: '', stepIndex: 0, retried: false, toolCalls: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: [] });
        StorageManager.set('agent-tasks', tasks);
        const { automation } = AutomationService.create({ goal: 'waits', trigger: { type: 'time', interval: 'daily' } });
        await AutomationService._fire(automation, null);
        const a = AutomationService.get(automation.id);
        StorageManager.set('agent-tasks', (StorageManager.get('agent-tasks') || []).filter(t => t.id !== 'task_e_busy'));
        return { pass: a.lastRunAt === null && a.lastError === null, detail: JSON.stringify({ lastRunAt: a.lastRunAt, lastError: a.lastError }) };
      });
    }
  }
];
