/**
 * Email attachments as agent input (2026-08-03).
 *
 * The gap this closes: get_email returned headers + body text only and never
 * mentioned attachments, so a routine asked to pull a due date out of an
 * attached invoice had no way to reach it — and invented one instead. These
 * journeys pin the two halves of the fix: get_email ADMITS the attachment
 * exists, and read_email_attachment can resolve + read it.
 *
 * Deterministic: they drive the tool handlers over a seeded local message.
 * The Gmail fetch itself is stubbed — these test the tool contract, not
 * Google's API.
 */
// Two things this seed has to get right, both learned by running it
// (2026-08-03 — these journeys were written blind and every one failed):
//
//   1. Messages do NOT live in the `email` blob. They live in the per-message
//      SQLite table behind `window.electronEmailDb`; the blob's `emails` array
//      is a legacy shape that loadData() migrates out on sight. Seeding the
//      blob wrote to a field the app deletes.
//   2. The message needs a CONNECTED ACCOUNT. get_email reads
//      EmailApp.getProfileEmails(), which keeps only messages whose `account`
//      matches one in `accounts` — so a seeded message with no account is
//      invisible, which is what "No email with id" was really saying.
//
// loadData() is async, and the unawaited version raced every assertion — so
// this string EVALUATES TO A PROMISE and every call site does
// `await eval(seed)`. A bare `await` inside the string does not work: the
// journey function is itself re-created by Playwright, and the eval'd code
// parses outside its async context ("await is not defined").
const SEED = `
  (async () => {
    const blob = StorageManager.get('email') || {};
    const accounts = Array.isArray(blob.accounts) ? blob.accounts : [];
    if (!accounts.some(a => a && a.email === 'eval@example.com')) {
      accounts.push({ email: 'eval@example.com', name: 'Eval Account' });
    }
    blob.accounts = accounts;
    StorageManager.set('email', blob);
    await window.electronEmailDb.upsertBatch([{
      messageId: 'eval_attach_1', threadId: 'eval_attach_t1', account: 'eval@example.com',
      from: 'billing@acme.com', to: 'me@example.com', subject: 'Invoice 4471',
      date: new Date().toISOString(), isRead: false, labels: ['INBOX'],
      bodyText: 'Please see the attached invoice for details.',
      snippet: 'Please see the attached invoice for details.',
      attachments: [
        { filename: 'invoice-4471.pdf', mimeType: 'application/pdf', size: 20480, attachmentId: 'att_pdf_1' },
        { filename: 'terms.txt', mimeType: 'text/plain', size: 120, attachmentId: 'att_txt_1' }
      ]
    }]);
    await EmailApp.loadData();
  })()
`;

module.exports = [
  {
    id: 'c10-get-email-admits-attachments',
    name: 'get_email lists attachments and says their contents are not included',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (seed) => {
        await eval(seed);
        const r = await AgentTools.handlers.get_email({ id: 'eval_attach_1' });
        const pass = !r.error
          && Array.isArray(r.attachments) && r.attachments.length === 2
          && r.attachments[0].attachmentId === 'att_pdf_1'
          && /read_email_attachment/.test(r.attachmentNote || '')
          // The body must NOT be presented as if it were the whole story.
          && /not in the body/i.test(r.attachmentNote || '');
        return { pass, detail: JSON.stringify({ count: r.attachments?.length, note: (r.attachmentNote || '').slice(0, 60) }) };
      }, SEED);
    }
  },
  {
    id: 'c10-attachment-resolution',
    name: 'an attachment resolves by id, by filename, and refuses ambiguity',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (seed) => {
        await eval(seed);
        const calls = [];
        const orig = window.electronEmail.readAttachmentText;
        window.electronEmail.readAttachmentText = async (p) => {
          calls.push(p.attachmentId);
          return { name: p.filename, kind: 'pdf', pages: 1, text: 'Amount due $412.00\nDue date: 2026-09-12' };
        };
        const byId = await AgentTools.handlers.read_email_attachment({ id: 'eval_attach_1', attachmentId: 'att_txt_1' });
        const byName = await AgentTools.handlers.read_email_attachment({ id: 'eval_attach_1', filename: 'invoice-4471.pdf' });
        const byPartial = await AgentTools.handlers.read_email_attachment({ id: 'eval_attach_1', filename: 'invoice' });
        // Neither id nor filename, and TWO attachments — must ask rather
        // than silently read the first one.
        const ambiguous = await AgentTools.handlers.read_email_attachment({ id: 'eval_attach_1' });
        window.electronEmail.readAttachmentText = orig;
        const pass = calls[0] === 'att_txt_1' && calls[1] === 'att_pdf_1' && calls[2] === 'att_pdf_1'
          && /Due date: 2026-09-12/.test(byName.text || '')
          && byId.kind === 'pdf' && !byPartial.error
          && !!ambiguous.error && Array.isArray(ambiguous.attachments) && ambiguous.attachments.length === 2;
        return { pass, detail: JSON.stringify({ calls, ambiguous: ambiguous.error }) };
      }, SEED);
    }
  },
  {
    id: 'c10-attachment-errors-are-honest',
    name: 'an unreadable attachment reports the failure instead of returning empty text',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (seed) => {
        await eval(seed);
        const orig = window.electronEmail.readAttachmentText;
        window.electronEmail.readAttachmentText = async () => ({ error: 'The PDF had no readable text, even after OCR.' });
        const r = await AgentTools.handlers.read_email_attachment({ id: 'eval_attach_1', attachmentId: 'att_pdf_1' });
        const noAtt = await AgentTools.handlers.read_email_attachment({ id: 'no_such_email' });
        window.electronEmail.readAttachmentText = orig;
        const pass = !!r.error && /OCR/.test(r.error) && r.filename === 'invoice-4471.pdf'
          && r.text === undefined
          && !!noAtt.error;
        return { pass, detail: JSON.stringify({ err: r.error, filename: r.filename, missing: noAtt.error }) };
      }, SEED);
    }
  },
  {
    id: 'c10-attachment-text-capped',
    name: 'a long attachment is truncated and says so',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (seed) => {
        await eval(seed);
        const orig = window.electronEmail.readAttachmentText;
        window.electronEmail.readAttachmentText = async () => ({ name: 'big.pdf', kind: 'pdf', text: 'x'.repeat(50000) });
        const r = await AgentTools.handlers.read_email_attachment({ id: 'eval_attach_1', attachmentId: 'att_pdf_1' });
        window.electronEmail.readAttachmentText = orig;
        const pass = r.truncated === true && r.text.length < 21000 && /…\(truncated\)$/.test(r.text);
        return { pass, detail: JSON.stringify({ len: r.text?.length, truncated: r.truncated }) };
      }, SEED);
    }
  }
];
