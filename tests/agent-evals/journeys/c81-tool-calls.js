/**
 * C8.1 regression net — truncation-aware tool calls (findings 13/18/19/27).
 * Deterministic: the model is stubbed at the TaskService seam.
 */
module.exports = [
  {
    id: 'c81-verify-loop-broken-args',
    name: 'task verify loop feeds an error instead of running a tool on {} args',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const tasks = StorageManager.get('agent-tasks') || [];
        tasks.unshift({
          id: 'task_c81v', conversationId: null, goal: 'broken args test',
          plan: [{ step: 'x', tools: [], status: 'done', note: '', result: 'r' }],
          status: 'verifying', note: '', stepIndex: 1, retried: false, toolCalls: 0,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [], toolLog: []
        });
        StorageManager.set('agent-tasks', tasks);
        let fed = null;
        const origChat = TaskService._chat;
        let n = 0;
        TaskService._chat = async ({ messages }) => {
          n++;
          if (n === 1) return { message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'list_notes', arguments: '{"query":"cut off mid-str' } }] } };
          // Capture ONLY the verify loop's second turn — the later verdicts
          // call has no tool messages and must not overwrite the capture.
          if (n === 2) fed = messages.find(m => m.role === 'tool');
          return { message: { content: '1. OK', tool_calls: [] } };
        };
        const before = window.__eval.calls.length;
        await TaskService._verify('task_c81v');
        TaskService._chat = origChat;
        const executed = window.__eval.calls.length - before;
        const pass = executed === 0 && !!fed && /cut off or invalid/.test(fed.content || '');
        return { pass, detail: JSON.stringify({ executed, fed: (fed?.content || '').slice(0, 80) }) };
      });
    }
  },
  {
    id: 'c81-jsonchat-schema-downgrade',
    name: 'schema-rejecting server downgrades once to plain json',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const seen = [];
        const origChat = TaskService._chat;
        TaskService._chat = async (params) => {
          seen.push(params.format);
          if (seen.length === 1) return { error: 'response_format not supported' };
          return { message: { content: '{"ok":true}' } };
        };
        const resp = await TaskService._jsonChat({ messages: [], logTag: 'eval' }, { type: 'object', properties: {} });
        TaskService._chat = origChat;
        const pass = seen.length === 2 && typeof seen[0] === 'object' && seen[1] === 'json' && !resp.error;
        return { pass, detail: JSON.stringify({ formats: seen.map(f => typeof f === 'object' ? 'schema' : f) }) };
      });
    }
  },
  {
    id: 'c81-create-note-empty-args',
    name: 'create_note refuses empty args (the {} truncation fallback)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const before = ((StorageManager.get('notes')?.notes) || []).length;
        const r = await AgentTools.execute('create_note', {});
        const after = ((StorageManager.get('notes')?.notes) || []).length;
        const pass = !!r.error && /cut off/.test(r.error) && after === before;
        return { pass, detail: r.error || 'created an empty note' };
      });
    }
  },
  {
    id: 'c81-plan-schema-enum',
    name: 'plan schema constrains tool groups to the live enum (shape only)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        let captured = null;
        const origChat = TaskService._chat;
        TaskService._chat = async (params) => {
          captured = params.format;
          return { message: { content: '{"steps":[{"step":"do it","tools":[],"check":{"kind":"none","arg":""}}]}' } };
        };
        await TaskService._planChat('goal', TaskService._availableGroups(), 'core');
        TaskService._chat = origChat;
        const enumOk = JSON.stringify(captured).includes('"enum"');
        const checkOk = JSON.stringify(captured).includes('file_exists');
        return { pass: enumOk && checkOk, detail: JSON.stringify({ enumOk, checkOk }) };
      });
    }
  }
];
