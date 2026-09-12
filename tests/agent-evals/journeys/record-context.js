/**
 * Record-attached conversation context (2026-08-06).
 *
 * The laws under test:
 *  - a conversation ATTACHED to a record (conv.recordKey) continued away
 *    from the record's page still gets its context block — the TASK/GOAL
 *    chip must never be display-only (the "which task are you referring
 *    to?" bug, reported over a chat attached to the very task it asked
 *    about);
 *  - the foreground provider wins whenever it exposes a record of its own
 *    (never two CURRENT TASK blocks);
 *  - untrusted turns get no record fallback (same policy as decisions);
 *  - external-content record types (email/insight/browse) have NO resolver
 *    at all — their blocks carry attacker-supplied text and the untrusted
 *    tool gating is keyed on the foreground app.
 */

module.exports = [
  {
    id: 'rc-attached-task-block-from-assistant-view',
    name: 'a schedule-attached conversation gets CURRENT TASK away from the task page',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const prevApp = AppManager.currentApp;
        try {
          const made = await AgentTools.handlers.create_schedule_item({
            title: 'eval: book broadway matinee', scheduledDate: '2026-08-15'
          });
          const taskId = made.item?.id || made.id;
          if (!taskId) return { pass: false, detail: 'fixture task not created: ' + JSON.stringify(made) };

          // The reported repro: the chat lives in the full Assistant view,
          // where no AgentContext provider runs.
          AppManager.currentApp = 'agent';
          const block = AgentService._buildCurrentContextBlock({ recordKey: 'schedule:' + taskId });
          const hasTask = block.includes('CURRENT TASK') && block.includes(taskId)
            && block.includes('book broadway matinee');
          // The attached framing must not claim the user is viewing it.
          const honestLead = block.includes('attached to the task');

          // A dead record resolves to nothing, never a throw.
          await AgentTools.handlers.delete_schedule_item({ id: taskId });
          const after = AgentService._buildCurrentContextBlock({ recordKey: 'schedule:' + taskId });
          const goneClean = !after.includes('CURRENT TASK');

          return {
            pass: hasTask && honestLead && goneClean,
            detail: JSON.stringify({ hasTask, honestLead, goneClean })
          };
        } finally {
          AppManager.currentApp = prevApp;
        }
      });
    }
  },
  {
    id: 'rc-foreground-record-wins',
    name: 'with a record open in the foreground, the attachment injects no second block',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const prevApp = AppManager.currentApp;
        const prevOpen = (typeof ActionsApp !== 'undefined') ? ActionsApp._openTaskId : null;
        try {
          const a = await AgentTools.handlers.create_schedule_item({ title: 'eval: foreground task' });
          const b = await AgentTools.handlers.create_schedule_item({ title: 'eval: attached task' });
          const idA = a.item?.id || a.id, idB = b.item?.id || b.id;

          // Viewing task A in Actions while the conversation is attached to
          // task B: foreground wins, one CURRENT TASK block, about A.
          AppManager.currentApp = 'actions';
          ActionsApp._openTaskId = idA;
          const block = AgentService._buildCurrentContextBlock({ recordKey: 'schedule:' + idB });
          const one = (block.match(/CURRENT TASK/g) || []).length === 1;
          const aboutA = block.includes(idA) && !block.includes(idB);

          await AgentTools.handlers.delete_schedule_item({ id: idA });
          await AgentTools.handlers.delete_schedule_item({ id: idB });
          return { pass: one && aboutA, detail: JSON.stringify({ one, aboutA }) };
        } finally {
          AppManager.currentApp = prevApp;
          if (typeof ActionsApp !== 'undefined') ActionsApp._openTaskId = prevOpen;
        }
      });
    }
  },
  {
    id: 'rc-untrusted-turn-skips-record-block',
    name: 'an untrusted turn gets no record fallback; external record types have no resolver',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const prevApp = AppManager.currentApp;
        try {
          const made = await AgentTools.handlers.create_schedule_item({ title: 'eval: untrusted host task' });
          const taskId = made.item?.id || made.id;

          AppManager.currentApp = 'agent';
          const untrusted = AgentService._buildCurrentContextBlock({
            recordKey: 'schedule:' + taskId, untrusted: true
          });
          const skipped = !untrusted.includes('CURRENT TASK');

          // email/insight/browse must never gain a resolver: their blocks
          // carry attacker-supplied text (see AgentContext.registerRecord).
          const noExternal = ['email:x', 'insight:x', 'browse:https://x'].every(
            k => AgentContext.blockForRecord(k) === null
          );

          await AgentTools.handlers.delete_schedule_item({ id: taskId });
          return { pass: skipped && noExternal, detail: JSON.stringify({ skipped, noExternal }) };
        } finally {
          AppManager.currentApp = prevApp;
        }
      });
    }
  }
];
