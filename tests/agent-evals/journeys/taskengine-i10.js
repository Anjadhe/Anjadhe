/**
 * TASK_ENGINE.md I10 — engine-conditional foreach concurrency (2026-08-31).
 *
 * The law: chunk passes may overlap in wall clock ONLY on a brain whose
 * engine serves real concurrent requests on the user's own key
 * ('openai'/'anthropic') AND when every tool in the step's set is
 * read-only. Local (one llama-server), Anjadhe Cloud (quota-bound), custom
 * (unknowable) and every write-bearing fan-out stay strictly sequential —
 * the sequential order is what keeps I8's reconcile-first promise
 * (_priorWritesNote sees every prior write) airtight.
 *
 * Deterministic: the model is stubbed at the TaskService._chat seam with a
 * fixed per-call delay; overlap is measured as max calls in flight. The
 * metered call spacing is shrunk (not disabled) so the slot-reservation
 * pacing is exercised without making the journey wait out real 2.5s gaps.
 */

/** A foreach task seeded at the step under test. */
const SEED = (id, goal, items) => ({
  id, conversationId: null, goal,
  plan: [
    { kind: 'single', step: 'list them', tools: [], status: 'done', note: '', result: 'listed' },
    { kind: 'foreach', step: 'handle each', tools: [], status: 'active', note: '', itemsFrom: 1, perItem: 'handle it' }
  ],
  results: { '1': { items } },
  status: 'running', note: '', stepIndex: 1, retried: false, toolCalls: 0,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  log: [], toolLog: []
});

/** Shared driver: stubs the brain seam + engine entry + toolset, runs the
 *  foreach, and reports overlap. Runs inside page.evaluate. */
const DRIVER = async (seedSrc, taskId, engine, toolNames, itemCount) => {
  const SEED = eval(seedSrc);
  const items = Array.from({ length: itemCount }, (_, i) => `Item number ${i + 1}`);
  const tasks = StorageManager.get('agent-tasks') || [];
  tasks.unshift(SEED(taskId, 'handle each item', items));
  StorageManager.set('agent-tasks', tasks);

  const tools = toolNames.map(n => ({ type: 'function', function: { name: n, parameters: {} } }));
  const origChat = TaskService._chat;
  const origEntry = AgentService.getDefaultEntry;
  const origTools = TaskService._toolsForGroups;
  const origSpacing = TaskService.TASK_CALL_SPACING_MS;
  let inFlight = 0, maxInFlight = 0;
  try {
    AgentService.getDefaultEntry = () => ({ engine, model: 'stub' });
    TaskService._toolsForGroups = () => tools;
    TaskService.TASK_CALL_SPACING_MS = 10;
    const itemsFrom = (messages) => {
      const m = messages.map(x => typeof x.content === 'string' ? x.content : '').join('\n')
        .match(/Items \(\d+\):\n([\s\S]*?)$/);
      return m ? [...m[1].matchAll(/^\d+\. (.+)$/gm)].map(x => x[1].trim()) : [];
    };
    TaskService._chat = async (params) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 60));
      inFlight--;
      if (!params.format) return { message: { content: 'handled', tool_calls: [] } };
      const asked = itemsFrom(params.messages);
      return { message: { content: JSON.stringify({
        status: 'done', rows: asked.map(it => ({ item: it, data: 'done' })), note: 'b'
      }) } };
    };
    const conc = TaskService._foreachConcurrency(tools);
    const out = await TaskService._runForeach(taskId, 1);
    const rows = (TaskService.get(taskId).results['2'] || {}).rows || [];
    return { conc, maxInFlight, ok: out.ok === true, covered: rows.length, wanted: itemCount };
  } finally {
    TaskService._chat = origChat;
    AgentService.getDefaultEntry = origEntry;
    TaskService._toolsForGroups = origTools;
    TaskService.TASK_CALL_SPACING_MS = origSpacing;
  }
};

module.exports = [
  {
    id: 'i10-readonly-parallel-overlaps',
    name: 'read-only chunks on an openai brain overlap in flight and still cover every item (I10)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async ({ seedSrc, driverSrc }) => {
        const driver = eval(driverSrc);
        // 12 items = 3 chunks = one full wave at FOREACH_CONCURRENCY 3.
        const r = await driver(seedSrc, 'task_i10a', 'openai', ['get_email', 'web_search'], 12);
        const pass = r.conc === TaskService.FOREACH_CONCURRENCY
          && r.maxInFlight >= 2            // passes genuinely overlapped
          && r.ok && r.covered === r.wanted;
        return { pass, detail: JSON.stringify(r) };
      }, { seedSrc: SEED.toString(), driverSrc: DRIVER.toString() });
    }
  },
  {
    id: 'i10-writes-stay-sequential',
    name: 'a write-bearing toolset stays strictly sequential even on a parallel-capable brain (I10/I8)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async ({ seedSrc, driverSrc }) => {
        const driver = eval(driverSrc);
        const r = await driver(seedSrc, 'task_i10b', 'openai', ['get_email', 'create_schedule_item'], 10);
        const pass = r.conc === 1 && r.maxInFlight === 1 && r.ok && r.covered === r.wanted;
        return { pass, detail: JSON.stringify(r) };
      }, { seedSrc: SEED.toString(), driverSrc: DRIVER.toString() });
    }
  },
  {
    id: 'i10-local-stays-sequential',
    name: 'a local brain stays strictly sequential — one llama-server slot (I10)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async ({ seedSrc, driverSrc }) => {
        const driver = eval(driverSrc);
        const r = await driver(seedSrc, 'task_i10c', 'llamacpp', ['get_email'], 10);
        const pass = r.conc === 1 && r.maxInFlight === 1 && r.ok && r.covered === r.wanted;
        return { pass, detail: JSON.stringify(r) };
      }, { seedSrc: SEED.toString(), driverSrc: DRIVER.toString() });
    }
  }
];
