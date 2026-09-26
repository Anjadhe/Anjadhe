/**
 * Chat tool loop — the ceilings a small model can and cannot see
 * (2026-09-09). Deterministic: the model is stubbed at LLMLogger.callStream,
 * tools at AgentTools.execute, and the runs are headless (a routine's
 * shape) so nothing asks a dialog.
 *
 * The finding: a routine on Qwen3.8 Flash fired four reworded web searches
 * per round for ten rounds, never wrote a word, and posted the "I've
 * paused after 42 actions" stop message to the feed — forty searches of
 * research thrown away. Two laws now hold:
 *   1. web_search runs out VISIBLY: past the per-turn budget the tool
 *      returns "budget spent, answer now" instead of results.
 *   2. A cap hit (total ceiling or identical-call loop) runs the tools-free
 *      synthesis pass first; the canned stop message is only the fallback.
 */
function withStubs(page, body) {
  return page.evaluate(async (bodySrc) => {
    const orig = {
      call: LLMLogger.callStream,
      exec: AgentTools.execute,
      model: AgentService.model,
      unset: AgentService._webSearchUnset,
      ready: AgentService._webSearchReady,
      ensure: AgentService._ensureWebSearchState,
      grants: PermissionManager._grants,
      session: PermissionManager._sessionGrants,
    };
    try {
      PermissionManager._grants = [];
      PermissionManager._sessionGrants = new Set();
      if (!AgentService.model) AgentService.model = 'eval-model';
      // The first-search opt-in gate belongs to a present user; these runs
      // are about the loop, not that consent. The loop re-derives the
      // state through _ensureWebSearchState every turn (the contextBridge
      // object underneath is not writable), so stub that seam.
      AgentService._ensureWebSearchState = async () => {
        AgentService._webSearchUnset = false;
        AgentService._webSearchReady = true;
        return true;
      };
      AgentService._webSearchUnset = false;
      AgentService._webSearchReady = true;
      // eslint-disable-next-line no-new-func
      return await (new Function('return (' + bodySrc + ')')())();
    } finally {
      LLMLogger.callStream = orig.call;
      AgentTools.execute = orig.exec;
      AgentService.model = orig.model;
      AgentService._webSearchUnset = orig.unset;
      AgentService._webSearchReady = orig.ready;
      AgentService._ensureWebSearchState = orig.ensure;
      PermissionManager._grants = orig.grants;
      PermissionManager._sessionGrants = orig.session;
    }
  }, body.toString());
}

module.exports = [
  {
    id: 'loop-search-budget-visible',
    name: 'past the per-turn search budget, web_search answers "budget spent" and the model writes',
    kind: 'det',
    async run({ page }) {
      return await withStubs(page, async () => {
        let rounds = 0;
        let searched = 0;
        let spentSeen = null;
        LLMLogger.callStream = async (_tag, params) => {
          rounds++;
          const spent = (params.messages || []).find(m => m.role === 'tool' && /Search budget for this turn is spent \((\d+) searches\)/.test(m.content || ''));
          if (spent) {
            spentSeen = Number(spent.content.match(/\((\d+) searches\)/)[1]);
            return { message: { content: 'written from what I had', tool_calls: [] } };
          }
          if (rounds > 30) return { message: { content: 'gave up', tool_calls: [] } };
          // Four reworded searches a round — distinct args, so the
          // identical-call breaker never sees a loop.
          return { message: { content: '', tool_calls: [0, 1, 2, 3].map(k => ({
            id: `s${rounds}_${k}`, function: { name: 'web_search', arguments: JSON.stringify({ query: `news topic ${rounds} wording ${k}` }) }
          })) } };
        };
        AgentTools.execute = async (name) => {
          if (name === 'web_search') searched++;
          return { results: [{ title: 'r', url: 'https://example.com/' + searched, snippet: 's' }] };
        };
        const res = await AgentService.runHeadless('eval search budget', { readOnly: true });
        const pass = !!res && res.type === 'text' && /written from what I had/.test(res.content || '')
          && spentSeen !== null && searched === spentSeen;
        return { pass, detail: JSON.stringify({ type: res && res.type, rounds, searched, spentSeen, head: (res && res.content || '').slice(0, 60) }) };
      });
    }
  },
  {
    id: 'loop-total-cap-synthesises',
    name: 'the total tool-call cap runs the tools-free synthesis pass instead of the stop message',
    kind: 'det',
    async run({ page }) {
      return await withStubs(page, async () => {
        let rounds = 0;
        let synthesisPrompted = false;
        LLMLogger.callStream = async (_tag, params) => {
          rounds++;
          const recovery = (params.messages || []).some(m => m.role === 'user' && /Automatic recovery/.test(m.content || ''));
          if (recovery) {
            synthesisPrompted = !params.tools || params.tools.length === 0;
            return { message: { content: 'summary from gathered results', tool_calls: [] } };
          }
          if (rounds > 40) return { message: { content: 'gave up', tool_calls: [] } };
          // A model that never stops gathering: four distinct reads a round.
          return { message: { content: '', tool_calls: [0, 1, 2, 3].map(k => ({
            id: `g${rounds}_${k}`, function: { name: 'get_note', arguments: JSON.stringify({ id: `note-${rounds}-${k}` }) }
          })) } };
        };
        let executed = 0;
        AgentTools.execute = async () => { executed++; return { id: 'n', title: 't', content: 'c' }; };
        const res = await AgentService.runHeadless('eval total cap', { readOnly: true });
        const content = (res && res.content) || '';
        const pass = !!res && res.type === 'text'
          && /^summary from gathered results/.test(content)
          && /reached my tool limit for this run/.test(content)
          && !/I've paused after/.test(content)
          && synthesisPrompted
          && executed >= AgentService.totalToolHardBreak;
        return { pass, detail: JSON.stringify({ type: res && res.type, rounds, executed, synthesisPrompted, head: content.slice(0, 90) }) };
      });
    }
  },
  {
    id: 'loop-stuck-cap-synthesises',
    name: 'an identical-call loop synthesises too, and the note names the repeated action',
    kind: 'det',
    async run({ page }) {
      return await withStubs(page, async () => {
        let rounds = 0;
        LLMLogger.callStream = async (_tag, params) => {
          rounds++;
          const recovery = (params.messages || []).some(m => m.role === 'user' && /Automatic recovery/.test(m.content || ''));
          if (recovery) return { message: { content: 'what I found before looping', tool_calls: [] } };
          if (rounds > 20) return { message: { content: 'gave up', tool_calls: [] } };
          // The same call, same args, every round.
          return { message: { content: '', tool_calls: [
            { id: `r${rounds}`, function: { name: 'list_notes', arguments: JSON.stringify({ query: 'same' }) } }
          ] } };
        };
        AgentTools.execute = async () => ({ items: [] });
        const res = await AgentService.runHeadless('eval stuck loop', { readOnly: true });
        const content = (res && res.content) || '';
        const pass = !!res && res.type === 'text'
          && /^what I found before looping/.test(content)
          && /repeating the same action \(list notes\)/.test(content)
          && rounds <= AgentService.perToolRunBreak + 2;
        return { pass, detail: JSON.stringify({ type: res && res.type, rounds, head: content.slice(0, 120) }) };
      });
    }
  },
];
