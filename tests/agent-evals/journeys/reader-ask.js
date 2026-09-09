/**
 * "Ask about this document" (2026-08-09: over an open document in Reader,
 * the assistant answered "I don't have a tool available to read documents"
 * and offered to summarize the book FROM ITS OWN RECALL — the user's
 * message, "give me a summary of this doucment", typo and all, matched no
 * library keyword, so read_library_doc never shipped; and the chat carried
 * no record of the doc). Pinned:
 *  - the Reader CURRENT DOCUMENT provider emits
 *    recordKey 'librarydoc:<docId>' so the chat attaches to the doc;
 *  - a librarydoc-attached conversation seeds the library domain and a
 *    durable extraContext pointer (RECORD_DOMAINS — the openBuildConversation
 *    lesson: the follow-up wording can't be trusted to carry a keyword);
 *  - "document" (singular included) now ships the library group by keyword;
 *  - the record banner names the type "Document".
 */
module.exports = [
  {
    id: 'reader-ask-attaches-document',
    name: 'Reader CURRENT DOCUMENT block carries the librarydoc recordKey',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        const prevApp = AppManager.currentApp;
        const prevReader = ReaderApp._reader;
        try {
          AppManager.currentApp = 'reader';
          ReaderApp._reader = {
            active: true,
            doc: { docId: 'doc_eval_1', title: 'Wings of Fire', collection: '' }
          };
          const block = AgentContext.getActiveBlock();
          const keyed = block
            && block.recordKey === 'librarydoc:doc_eval_1'
            && block.recordLabel === 'Wings of Fire'
            && block.body.includes('read_library_doc');
          const banner = AgentUI._recordTypeLabel('librarydoc:doc_eval_1') === 'Document';
          return { pass: !!(keyed && banner), detail: JSON.stringify({ keyed: !!keyed, banner }) };
        } finally {
          AppManager.currentApp = prevApp;
          ReaderApp._reader = prevReader;
        }
      });
    }
  },
  {
    id: 'reader-doc-conversation-ships-library-tools',
    name: 'a librarydoc-attached conversation seeds the library domain + doc pointer',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        const conv = AgentService.createConversation('librarydoc:doc_eval_2', 'Wings of Fire');
        try {
          AgentService._seedRecordDomains(conv);
          const domains = conv.scopedDomains || [];
          const seeded = domains.includes('library');
          // The durable pointer: survives navigating away mid-chat, names
          // the docId, and forbids answering a familiar title from recall.
          const ctx = String(conv.extraContext || '');
          const pointed = ctx.includes('doc_eval_2') && ctx.includes('read_library_doc')
            && ctx.includes('never answer from your own recall');

          // The keyword door for chats NOT attached to a doc: "document",
          // singular included, ships the library group.
          const kw = AgentTools._domainsForMessage('summarize the kalam document').has('library');

          return { pass: seeded && pointed && kw, detail: JSON.stringify({ seeded, pointed, kw }) };
        } finally {
          AgentService.deleteConversation(conv.id);
        }
      });
    }
  }
];
