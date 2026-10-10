/**
 * Model journeys — the per-model scorecard (docs/COWORK_AGENT.md C8.8).
 * These answer "is this model better FOR THESE TASKS": each drives the full
 * agent (real prompts, real tools) and asserts both the CALLS made and the
 * OUTCOME. Minutes each; run with --model <name> (default qwen3.5:9b).
 *
 * Long generations are fire-and-poll: kick sendMessage off in one evaluate,
 * poll window.__evalChat with short evaluates — a minutes-long evaluate
 * holding the renderer has crashed the app.
 */
async function pollChat(page, timeoutMs = 5 * 60 * 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await page.evaluate(() => window.__evalChat);
    if (r) return r;
    await new Promise(res => setTimeout(res, 2000));
  }
  return { type: 'error', content: 'chat did not settle in time' };
}
module.exports = [
  {
    id: 'model-note-write',
    name: 'chat: create a note; pills + undo scope ride the reply',
    kind: 'model',
    async run({ page }) {
      return await page.evaluate(async () => {
        const conv = AgentService.createConversation();
        const res = await AgentService.sendMessage('Create a note titled "Eval Note" saying exactly: model journey. Use the create_note tool.', { convId: conv.id });
        await NotesApp.loadNotes?.();
        const created = (NotesApp.notes || []).some(n => n.title === 'Eval Note');
        const called = window.__eval.calls.some(c => c.name === 'create_note');
        const msg = [...conv.messages].reverse().find(m => m.role === 'assistant' && m.metadata);
        const pass = res?.type === 'text' && created && called
          && !!msg?.metadata?.records?.length && !!msg?.metadata?.undoScope;
        return { pass, detail: JSON.stringify({ type: res?.type, created, called, pills: msg?.metadata?.records?.length, undo: !!msg?.metadata?.undoScope }) };
      });
    }
  },
  {
    id: 'model-pdf-read',
    name: 'chat: answer a question from a PDF\'s contents (never the filename)',
    kind: 'model',
    async run({ page, docs }) {
      return await page.evaluate(async (dir) => {
        const conv = AgentService.createConversation();
        const res = await AgentService.sendMessage(`Read the file ${dir}/statement.pdf and tell me the closing balance. Use fs_read.`, { convId: conv.id });
        const readCalled = window.__eval.calls.some(c => c.name === 'fs_read' && /statement\.pdf/.test(c.args?.path || ''));
        const pass = res?.type === 'text' && readCalled && (res.content || '').includes('913.37');
        return { pass, detail: JSON.stringify({ type: res?.type, readCalled, content: (res?.content || '').slice(0, 80) }) };
      }, docs);
    }
  },
  {
    id: 'model-truncation-recovery',
    name: 'chat: a cut-off tool call gets the make-it-smaller nudge, never {} args',
    kind: 'model',
    async run({ page }) {
      await page.evaluate(() => {
        window.__evalWarns = [];
        window.__evalOrigWarn = console.warn.bind(console);
        console.warn = (...a) => { window.__evalWarns.push(a.join(' ')); window.__evalOrigWarn(...a); };
        window.__evalSavedCap = AgentService.defaultNumPredict;
        AgentService.defaultNumPredict = 200;
        const conv = AgentService.createConversation();
        conv.thinkMode = 'off';
        window.__evalChat = null;
        AgentService.sendMessage('Create a note titled Oceans whose content is a 400-word essay about oceans. Use the create_note tool.', { convId: conv.id })
          .then(r => { window.__evalChat = r; }).catch(e => { window.__evalChat = { type: 'error', content: e.message }; });
      });
      const res = await pollChat(page);
      return await page.evaluate(async (r) => {
        AgentService.defaultNumPredict = window.__evalSavedCap;
        console.warn = window.__evalOrigWarn;
        await NotesApp.loadNotes?.();
        const emptyArg = (NotesApp.notes || []).some(n => (!n.title || n.title === 'Untitled') && !(n.content || '').length);
        const nudged = window.__evalWarns.some(w => w.includes('unparseable arguments'));
        return { pass: nudged && !emptyArg, detail: JSON.stringify({ nudged, emptyArg, type: r?.type }) };
      }, res);
    }
  },
  {
    id: 'model-invoices-criterion',
    name: 'success criterion #6 (small): total two invoices into a note',
    kind: 'model',
    async run({ page, docs }) {
      await page.evaluate(async (dir) => {
        // Two tiny invoice files (text — the PDF path has its own journeys).
        await window.electronAgentFS.write(dir + '/invoices/inv-001.txt', 'INVOICE 001\nVendor: Acme\nTotal: $120.00\n');
        await window.electronAgentFS.write(dir + '/invoices/inv-002.txt', 'INVOICE 002\nVendor: Bolt\nTotal: $80.50\n');
        const conv = AgentService.createConversation();
        window.__evalChat = null;
        AgentService.sendMessage(
          `Read the two invoice files in ${dir}/invoices and create a note titled "Invoice Totals" with each vendor's total and the grand total. Use fs_list, fs_read and create_note.`,
          { convId: conv.id })
          .then(r => { window.__evalChat = r; }).catch(e => { window.__evalChat = { type: 'error', content: e.message }; });
      }, docs);
      const res = await pollChat(page);
      return await page.evaluate(async (r) => {
        await NotesApp.loadNotes?.();
        const note = (NotesApp.notes || []).find(n => /Invoice Totals/i.test(n.title || ''));
        const body = (note?.content || '') + ' ' + (r?.content || '');
        const grand = /200\.50|200\.5/.test(body);
        const reads = window.__eval.calls.filter(c => c.name === 'fs_read').length;
        return { pass: !!note && grand && reads >= 2, detail: JSON.stringify({ note: !!note, grand, reads, body: body.slice(0, 100) }) };
      }, res);
    }
  }
];
