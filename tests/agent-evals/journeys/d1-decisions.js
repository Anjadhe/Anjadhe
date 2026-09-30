/**
 * D1 regression net — per-record decisions (DecisionStore + the
 * save/list/delete_decision tools + automatic recall).
 *
 * The laws under test:
 *  - a saved decision rides every read of its record (_withDecisions, the
 *    DECISIONS ON THIS RECORD context block) and NEVER rides an untrusted
 *    turn (ctx.untrusted / _toolsForGroups);
 *  - append-and-supersede, never edit in place (same title = the decision
 *    changed);
 *  - every removal tombstones BEFORE saving, or the record-merged sync
 *    union resurrects it (main.js RECORD_MERGED_KEYS);
 *  - budgets degrade to pointers, never to a JSON-destroying hard-trim.
 */
const RESET = `
  (() => {
    // app_agent-decisions is RECORD-MERGED: removal without a tombstone
    // unions right back from the store (the c10-routines lesson). remove()
    // stamps tombstones, so clearing through it is what makes the reset
    // stick. Reload first — the runner may have reset the store under our
    // in-memory copy.
    DecisionStore._loaded = false;
    DecisionStore.init();
    for (const d of [...DecisionStore.decisions]) DecisionStore.remove(d.id);
  })()
`;

module.exports = [
  {
    id: 'd1-save-attaches-on-read',
    name: 'a saved decision rides list_goals; a strategy saved by name keys on its id',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        // Fixture through the production write path, read where production
        // reads (the c10 fixture law).
        const goal = await AgentTools.handlers.create_goal({ title: 'eval: run a 5k' });
        const goalId = goal.goal?.id || goal.id;
        const saved = await AgentTools.handlers.save_decision({
          type: 'goal', id: goalId,
          title: 'eval: training cadence',
          decision: 'Run Tue/Thu/Sat, long run Saturday, never two hard days back to back.'
        });
        const goals = await AgentTools.handlers.list_goals({}, {});
        const mine = (goals.goals || []).find(g => g.id === goalId);
        const attached = !!(mine && (mine.decisions || []).some(d => d.title === 'eval: training cadence'));
        const noteShown = typeof goals.decisionsShown === 'string' && goals.decisionsShown.length > 0;

        // Strategy by NAME lands on the id-keyed store and rides get_strategy.
        let stratOk = true, stratDetail = 'portfolio unavailable';
        if (typeof PortfolioStrategy !== 'undefined') {
          const s = PortfolioStrategy.save({ name: 'eval: growth plan', objective: 'grow' });
          const sSaved = await AgentTools.handlers.save_decision({
            type: 'strategy', name: 'eval: growth plan',
            title: 'eval: dca plan', decision: 'Deploy $6k as $2k/month for 3 months into the core sleeve.'
          });
          const got = await AgentTools.handlers.get_strategy({ name: 'eval: growth plan' }, {});
          stratOk = sSaved.key === 'strategy:' + s.id
            && !!(got.decisions || []).some(d => d.title === 'eval: dca plan')
            && got.id === s.id;
          stratDetail = JSON.stringify({ key: sSaved.key, gotId: got.id, dec: (got.decisions || []).length });
        }
        const pass = saved.success === true && attached && noteShown && stratOk;
        return { pass, detail: JSON.stringify({ saved, attached, noteShown, stratDetail }) };
      }, RESET);
    }
  },
  {
    id: 'd1-supersede-same-title',
    name: 'same key+title supersedes; superseded hidden unless asked for',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        const goal = await AgentTools.handlers.create_goal({ title: 'eval: supersede host' });
        const goalId = goal.goal?.id || goal.id;
        const first = await AgentTools.handlers.save_decision({
          type: 'goal', id: goalId, title: 'eval: pace', decision: 'Aim for 10 min/mile.'
        });
        const second = await AgentTools.handlers.save_decision({
          type: 'goal', id: goalId, title: 'eval: pace', decision: 'Aim for 9 min/mile.'
        });
        const active = await AgentTools.handlers.list_decisions({ type: 'goal', id: goalId });
        const all = await AgentTools.handlers.list_decisions({ type: 'goal', id: goalId, include_superseded: true });
        const old = DecisionStore.get(first.id);
        const pass = second.superseded === 'eval: pace'
          && active.count === 1 && active.decisions[0].body === 'Aim for 9 min/mile.'
          && all.count === 2
          && !!old.supersededAt && old.supersededBy === second.id;
        return { pass, detail: JSON.stringify({ second, active: active.count, all: all.count, oldSup: !!old.supersededAt }) };
      }, RESET);
    }
  },
  {
    id: 'd1-delete-tombstones-before-save',
    name: 'delete_decision stamps a tombstone AND drops the record',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        const goal = await AgentTools.handlers.create_goal({ title: 'eval: tombstone host' });
        const goalId = goal.goal?.id || goal.id;
        const saved = await AgentTools.handlers.save_decision({
          type: 'goal', id: goalId, title: 'eval: doomed', decision: 'This will be deleted.'
        });
        const del = await AgentTools.handlers.delete_decision({ id: saved.id });
        const blob = StorageManager.get('agent-decisions') || {};
        const tombstoned = !!(blob.tombstones && blob.tombstones[saved.id]);
        const gone = !(blob.decisions || []).some(d => d.id === saved.id);
        const pass = del.success === true && tombstoned && gone;
        return { pass, detail: JSON.stringify({ del, tombstoned, gone }) };
      }, RESET);
    }
  },
  {
    id: 'd1-untrusted-turn-skips-recall',
    name: 'an untrusted turn gets no decisions on reads and no decision tools',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        const goal = await AgentTools.handlers.create_goal({ title: 'eval: untrusted host' });
        const goalId = goal.goal?.id || goal.id;
        await AgentTools.handlers.save_decision({
          type: 'goal', id: goalId, title: 'eval: secret plan', decision: 'Do not leak this into hostile turns.'
        });

        const trusted = await AgentTools.execute('list_goals', {}, {});
        const hostile = await AgentTools.execute('list_goals', {}, { untrusted: true });
        const tGoal = (trusted.goals || []).find(g => g.id === goalId);
        const hGoal = (hostile.goals || []).find(g => g.id === goalId);
        const trustedHas = !!(tGoal && tGoal.decisions && tGoal.decisions.length);
        const hostileClean = !!hGoal && !hGoal.decisions && !hostile.decisionsShown;

        const names = (defs) => defs.map(d => d.function.name);
        const open = names(TaskService._toolsForGroups([], [], false));
        const closed = names(TaskService._toolsForGroups([], [], true));
        const toolsOpen = ['save_decision', 'list_decisions', 'delete_decision'].every(n => open.includes(n));
        const toolsClosed = ['save_decision', 'list_decisions', 'delete_decision'].every(n => !closed.includes(n));

        const pass = trustedHas && hostileClean && toolsOpen && toolsClosed;
        return { pass, detail: JSON.stringify({ trustedHas, hostileClean, toolsOpen, toolsClosed }) };
      }, RESET);
    }
  },
  {
    id: 'd1-context-block-carries-decisions',
    name: 'the CURRENT-RECORD block carries decisions on trusted turns only',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        const goal = await AgentTools.handlers.create_goal({ title: 'eval: context host' });
        const goalId = goal.goal?.id || goal.id;
        await AgentTools.handlers.save_decision({
          type: 'goal', id: goalId, title: 'eval: standing order', decision: 'Review every Friday, never on Monday.'
        });

        // A throwaway provider + app id drives the real funnel without
        // depending on any page's own view state.
        const prevApp = AppManager.currentApp;
        AgentContext.register('evalctx', () => ({
          title: 'CURRENT GOAL', body: 'eval context body',
          recordKey: 'goals:' + goalId, recordLabel: 'eval: context host'
        }));
        AppManager.currentApp = 'evalctx';
        let trustedBlock, hostileBlock;
        try {
          trustedBlock = AgentService._buildCurrentContextBlock({});
          hostileBlock = AgentService._buildCurrentContextBlock({ untrusted: true });
        } finally {
          AppManager.currentApp = prevApp;
        }
        const carries = trustedBlock.includes('DECISIONS ON THIS RECORD')
          && trustedBlock.includes('never on Monday');
        const withheld = !hostileBlock.includes('DECISIONS ON THIS RECORD');

        // The recordKey → decision-key mapping table, asserted whole.
        const map = [
          ['schedule:x1', 'task:x1'], ['goals:x2', 'goal:x2'], ['notes:x3', 'note:x3'],
          ['prompts:x4', 'routine:x4'], ['portfolio:strategy:x5', 'strategy:x5'],
          ['portfolio:account:x6', 'account:x6'], ['email:x7', null], ['browse:http://x', null]
        ];
        const mapOk = map.every(([rk, dk]) => DecisionStore.fromRecordKey(rk) === dk);

        const pass = carries && withheld && mapOk;
        return { pass, detail: JSON.stringify({ carries, withheld, mapOk }) };
      }, RESET);
    }
  },
  {
    id: 'd1-budget-degrades-to-pointer',
    name: 'many long decisions degrade to a count+pointer, never a broken result',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        if (typeof PortfolioStrategy === 'undefined') return { pass: true, detail: 'portfolio unavailable — vacuous' };
        const s = PortfolioStrategy.save({ name: 'eval: budget plan', objective: 'grow' });
        for (let i = 0; i < 12; i++) {
          await AgentTools.handlers.save_decision({
            type: 'strategy', id: s.id,
            title: 'eval: rule ' + i,
            decision: ('Long decision body #' + i + ' — ').padEnd(600, 'x')
          });
        }
        const got = await AgentTools.handlers.get_strategy({ name: 'eval: budget plan' }, {});
        const json = JSON.stringify(got);
        const shown = (got.decisions || []).length;
        // 12 active decisions exist; the shared 2400-char budget cannot hold
        // them all, so some must ride and the rest must be a pointer.
        const pass = !got.error && shown > 0 && shown < 12
          && typeof got.decisionsMore === 'string' && got.decisionsMore.includes('list_decisions')
          && json.length < 12 * 600;
        return { pass, detail: JSON.stringify({ shown, more: got.decisionsMore, chars: json.length }) };
      }, RESET);
    }
  },
  {
    id: 'd1-merge-union-heals-renderer-write',
    name: 'a partial renderer write unions with the store; a tombstoned record stays gone',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        const mk = (id, title) => ({
          id, key: 'goal:eval-merge-host', title, body: 'body of ' + title,
          source: 'chat', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
        });
        // A exists in the store; a renderer holding a pre-merge copy writes
        // only B. The union must keep both (mergedForWrite in main.js).
        const a = mk('dec_eval_a', 'eval: A');
        DecisionStore.decisions.unshift(a);
        DecisionStore._save();
        StorageManager.set('agent-decisions', { decisions: [mk('dec_eval_b', 'eval: B')], tombstones: {} });
        DecisionStore._loaded = false;
        DecisionStore.init();
        const both = ['dec_eval_a', 'dec_eval_b'].every(id => DecisionStore.get(id));

        // Tombstone A, then a stale renderer writes it back with its OLD
        // stamp — the union must keep it dead.
        await new Promise(r => setTimeout(r, 5));  // tombstone must be newer than a's stamp
        DecisionStore.remove('dec_eval_a');
        StorageManager.set('agent-decisions', {
          decisions: [a, mk('dec_eval_c', 'eval: C')],
          tombstones: {}
        });
        DecisionStore._loaded = false;
        DecisionStore.init();
        const deadStaysDead = !DecisionStore.get('dec_eval_a') && !!DecisionStore.get('dec_eval_c');

        const pass = both && deadStaysDead;
        return { pass, detail: JSON.stringify({ both, deadStaysDead }) };
      }, RESET);
    }
  },
  {
    id: 'd1-orphan-prune-honors-grace-and-unknowable',
    name: 'the orphan sweep prunes old orphans only — grace-window and missing-store decisions survive',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        const old = new Date(Date.now() - 8 * 86400000).toISOString();  // past ORPHAN_GRACE_MS
        const backdate = (id) => { const d = DecisionStore.get(id); d.createdAt = old; DecisionStore._save(); };

        // Host A gets deleted; its OLD decision must prune, its FRESH one
        // must survive the grace window (the cross-key sync-lag defense).
        const a = await AgentTools.handlers.create_goal({ title: 'eval: orphan host' });
        const aId = a.goal.id;
        const oldOrphan = await AgentTools.handlers.save_decision({
          type: 'goal', id: aId, title: 'eval: old orphan', decision: 'x' });
        const freshOrphan = await AgentTools.handlers.save_decision({
          type: 'goal', id: aId, title: 'eval: fresh orphan', decision: 'y' });
        backdate(oldOrphan.id);

        // Host B lives; its old decision must survive.
        const b = await AgentTools.handlers.create_goal({ title: 'eval: living host' });
        const kept = await AgentTools.handlers.save_decision({
          type: 'goal', id: b.goal.id, title: 'eval: kept', decision: 'z' });
        backdate(kept.id);

        // An old task decision whose schedule blob is UNREADABLE this boot
        // must survive — unknowable is not empty.
        DecisionStore.decisions.unshift({
          id: 'dec_eval_unknowable', key: 'task:no-such-task', title: 'eval: unknowable',
          body: 'u', source: 'chat', createdAt: old, updatedAt: old });
        DecisionStore._save();

        // Delete host A directly from the goals blob (not record-merged).
        const goals = (StorageManager.get('goals') || {}).goals || [];
        StorageManager.set('goals', { goals: goals.filter(g => g.id !== aId) });

        const origGet = StorageManager.get.bind(StorageManager);
        StorageManager.get = (k) => (k === 'schedule' ? null : origGet(k));
        let pruned;
        try { pruned = DecisionStore.pruneOrphans(); }
        finally { StorageManager.get = origGet; }

        const blob = StorageManager.get('agent-decisions') || {};
        const gone = !DecisionStore.get(oldOrphan.id) && !!(blob.tombstones || {})[oldOrphan.id];
        const freshSurvives = !!DecisionStore.get(freshOrphan.id);
        const keptSurvives = !!DecisionStore.get(kept.id);
        const unknowableSurvives = !!DecisionStore.get('dec_eval_unknowable');

        // Second pass with the schedule blob readable again: the task
        // decision's host is now KNOWN missing → pruned.
        const pruned2 = DecisionStore.pruneOrphans();
        const unknowableNowGone = !DecisionStore.get('dec_eval_unknowable');

        const pass = pruned === 1 && gone && freshSurvives && keptSurvives
          && unknowableSurvives && pruned2 === 1 && unknowableNowGone;
        return { pass, detail: JSON.stringify({ pruned, gone, freshSurvives, keptSurvives, unknowableSurvives, pruned2, unknowableNowGone }) };
      }, RESET);
    }
  },
  {
    id: 'd1-save-validates-record-exists',
    name: 'save_decision refuses unknown types and missing records',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (reset) => {
        eval(reset);
        const before = DecisionStore.decisions.length;
        const badType = await AgentTools.handlers.save_decision({
          type: 'spaceship', id: 'x', title: 'eval: t', decision: 'd'
        });
        const badId = await AgentTools.handlers.save_decision({
          type: 'goal', id: 'no-such-goal-id', title: 'eval: t', decision: 'd'
        });
        const noTitle = await AgentTools.handlers.save_decision({
          type: 'goal', id: 'whatever', decision: 'd'
        });
        const after = DecisionStore.decisions.length;
        const pass = !!badType.error && !!badId.error && !!noTitle.error && before === after;
        return { pass, detail: JSON.stringify({ badType: badType.error, badId: badId.error, noTitle: noTitle.error }) };
      }, RESET);
    }
  }
];
