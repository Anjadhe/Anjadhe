/**
 * @-mention record attachment (2026-08-19) — js/components/record-mention.js.
 *
 * The laws under test:
 *  - the candidate index offers EXACTLY the record types with an
 *    AgentContext record resolver (task/goal/note/routine/strategy/
 *    account), with the exact recordKey formats those resolvers expect;
 *    routine-output feed posts and external-content types (email/insight/
 *    browse) never appear;
 *  - attaching is in-place (never a conversation switch), seeds the record
 *    type's tool domains, and detaching clears the record while leaving
 *    the monotonic scopedDomains alone;
 *  - a pending mention (home composer / no conversation at select time)
 *    attaches at dispatch via consumePending.
 */

module.exports = [
  {
    id: 'rm-candidates-cover-resolver-types-only',
    name: 'the mention index offers resolver-backed types with their exact recordKey formats',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const made = [];
        try {
          const g = await AgentTools.handlers.create_goal({ title: 'eval rm goal alpha' });
          const t = await AgentTools.handlers.create_schedule_item({ title: 'eval rm task alpha' });
          const n = await AgentTools.handlers.create_note({ title: 'eval rm note alpha', content: 'body' });
          made.push(['goal', g.goal.id], ['task', t.item?.id || t.id], ['note', n.note.id]);

          // Strategy + account fixtures straight into the blob (the eval
          // root is throwaway; unique ids avoid collisions).
          const pf = StorageManager.get('portfolio') || {};
          pf.accounts = (pf.accounts || []).concat({
            id: 'rmacct1', name: 'eval rm account alpha', type: 'Brokerage',
            updatedAt: new Date().toISOString() });
          pf.strategies = (pf.strategies || []).concat({
            id: 'rmstrat1', name: 'eval rm strategy alpha', objective: 'grow',
            updatedAt: new Date().toISOString() });
          StorageManager.set('portfolio', pf);

          const hits = RecordMention._candidates('eval rm alpha');
          const key = (type) => hits.find(h => h.type === type)?.key || '';
          const covered = key('Goal').startsWith('goals:')
            && key('Task').startsWith('schedule:')
            && key('Note').startsWith('notes:')
            && key('Account') === 'portfolio:account:rmacct1'
            && key('Strategy') === 'portfolio:strategy:rmstrat1';

          // Every offered key must have a registered record resolver prefix
          // — the external-content law by construction.
          const prefixes = new Set(RecordMention._index().map(h => h.key.split(':')[0]));
          const resolverBacked = [...prefixes].every(p =>
            ['goals', 'schedule', 'notes', 'prompts', 'portfolio'].includes(p));
          const noExternal = ![...prefixes].some(p => ['email', 'insight', 'browse'].includes(p));

          return {
            pass: covered && resolverBacked && noExternal,
            detail: JSON.stringify({ covered, resolverBacked, noExternal,
              hits: hits.map(h => ({ type: h.type, key: h.key })) })
          };
        } finally {
          for (const [kind, id] of made) {
            if (kind === 'goal') await AgentTools.handlers.delete_goal({ id });
            if (kind === 'task') await AgentTools.handlers.delete_schedule_item({ id });
            if (kind === 'note') await AgentTools.handlers.delete_note?.({ id });
          }
        }
      });
    }
  },
  {
    id: 'rm-attach-in-place-seeds-domains-detach-clears',
    name: 'attach retags the current conversation and seeds domains; detach clears the record only',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const g = await AgentTools.handlers.create_goal({ title: 'eval rm attach goal' });
        try {
          const conv = AgentService.createConversation();
          const activeBefore = AgentService.activeConversationId;

          AgentService.attachRecordToConversation(conv.id, 'goals:' + g.goal.id, 'eval rm attach goal');
          const c = AgentService.conversations.find(x => x.id === conv.id);
          const attached = c.recordKey === 'goals:' + g.goal.id
            && c.recordLabel === 'eval rm attach goal';
          // goals seeds goals AND schedule — goal tasks are schedule items.
          const domains = new Set(c.scopedDomains || []);
          const seeded = domains.has('goals') && domains.has('schedule');
          // In-place: attaching must never switch the active conversation.
          const noSwitch = AgentService.activeConversationId === activeBefore;

          AgentService.detachRecordFromConversation(conv.id);
          const detached = !c.recordKey && !c.recordLabel;
          // scopedDomains are monotonic (cache) — detach leaves them.
          const domainsKept = (c.scopedDomains || []).includes('goals');

          AgentService.deleteConversation(conv.id);
          return {
            pass: attached && seeded && noSwitch && detached && domainsKept,
            detail: JSON.stringify({ attached, seeded, noSwitch, detached, domainsKept })
          };
        } finally {
          await AgentTools.handlers.delete_goal({ id: g.goal.id });
        }
      });
    }
  },
  {
    id: 'rm-type-filter-and-diversity',
    name: 'one flooding type cannot bury another; "@goal …" narrows to goals',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        // The reported failure: 36 "Run N mi" tasks buried the one goal
        // about running — "@run" showed only tasks.
        const made = [];
        try {
          const g = await AgentTools.handlers.create_goal({ title: 'eval rmdiv running goal' });
          made.push(['goal', g.goal.id]);
          for (let i = 0; i < 6; i++) {
            const t = await AgentTools.handlers.create_schedule_item({
              title: `eval rmdiv Run ${i + 1} mi`, scheduledDate: '2026-12-0' + (i + 1) });
            made.push(['task', t.item?.id || t.id]);
          }

          // Unfiltered: the per-type cap keeps the goal visible among the
          // prefix-matching tasks.
          const mixed = RecordMention._candidates('rmdiv run');
          const goalSurvives = mixed.some(h => h.type === 'Goal')
            && mixed.some(h => h.type === 'Task');

          // "@goal <query>" and "@goals: <query>" both narrow to goals.
          const spaceForm = RecordMention._candidates('goal rmdiv run');
          const colonForm = RecordMention._candidates('goals: rmdiv');
          const narrowed = spaceForm.length > 0 && colonForm.length > 0
            && spaceForm.every(h => h.type === 'Goal')
            && colonForm.every(h => h.type === 'Goal');

          // A type-word PREFIX mid-typing is a normal search, not a filter.
          const midTyping = RecordMention._parseQuery('goa').type === null;

          // A filtered miss keeps the filter state (the popover shows
          // "No strategys match" instead of silently closing).
          const miss = RecordMention._candidates('strategy zzz-rmdiv-nomatch');
          const emptyKeepsFilter = miss.length === 0
            && RecordMention._typeFilter === 'Strategy';

          return {
            pass: goalSurvives && narrowed && midTyping && emptyKeepsFilter,
            detail: JSON.stringify({ goalSurvives, narrowed, midTyping, emptyKeepsFilter,
              mixed: mixed.map(h => h.type) })
          };
        } finally {
          RecordMention._typeFilter = null;
          for (const [kind, id] of made) {
            if (kind === 'goal') await AgentTools.handlers.delete_goal({ id });
            if (kind === 'task') await AgentTools.handlers.delete_schedule_item({ id });
          }
        }
      });
    }
  },
  {
    id: 'rm-pending-consumed-at-dispatch',
    name: 'a pending mention attaches to whatever conversation the message lands in',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        const t = await AgentTools.handlers.create_schedule_item({ title: 'eval rm pending task' });
        const id = t.item?.id || t.id;
        try {
          RecordMention.pending = { key: 'schedule:' + id, label: 'eval rm pending task' };
          const conv = AgentService.createConversation();
          RecordMention.consumePending(conv.id);
          const c = AgentService.conversations.find(x => x.id === conv.id);
          const attached = c.recordKey === 'schedule:' + id;
          const cleared = RecordMention.pending === null;
          // Consuming again is a no-op, never a re-attach of stale state.
          RecordMention.consumePending(conv.id);
          AgentService.deleteConversation(conv.id);
          return { pass: attached && cleared, detail: JSON.stringify({ attached, cleared }) };
        } finally {
          RecordMention.pending = null;
          await AgentTools.handlers.delete_schedule_item({ id });
        }
      });
    }
  }
];
