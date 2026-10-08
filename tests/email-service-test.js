// Email capabilities work without an Inbox DOM or registered email app.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://local.test' });
const persisted = [], sent = [], opened = [], chats = [], notices = [];
const store = new Map();
const ctx = {
    console, document: dom.window.document, DOMParser: dom.window.DOMParser, Event: dom.window.Event,
    localStorage: dom.window.localStorage, setTimeout: () => 1, clearTimeout() {},
    window: { addEventListener() {}, electronEmail: {
        sendEmail: async (account, params) => { sent.push({ account, params }); return { messageId: 'sent1' }; },
        markRead: async () => ({}), modifyLabels: async () => ({}), trash: async () => ({}),
        readAttachmentText: async () => ({ kind: 'pdf', text: 'Invoice total: $42' }),
        fetchEmails: async () => ({ emails: [] })
    }, electronEmailDb: {
        upsertBatch: async rows => persisted.push(...JSON.parse(JSON.stringify(rows))),
        searchBodies: async () => ({ invoice: ['abc123'] })
    } },
    LLMLogger: { call: async () => ({ message: { content: JSON.stringify({ relevant: true, data: { action: 'Review the contract' } }) } }) },
    StorageManager: { get: key => store.get(key), set: (key, value) => store.set(key, value) },
    AppManager: { currentApp: 'agent', updateStats() {}, register() { assert.fail('Email must not register a view'); },
        openApp: app => opened.push(app), openExternal: url => opened.push(url) },
    UIUtils: { showToast: text => notices.push(text), escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') },
    AgentService: { openScopedConversation: opts => { chats.push(opts); return { id: 'draft', messages: [] }; },
        _saveConversations() {}, loadConversation() {}, getActiveEntry: () => ({}), supportsVision: () => false },
};
vm.createContext(ctx);
for (const [file, name] of [['js/apps/email/email-app.js', 'EmailApp'], ['js/apps/email/email-ui.js', 'EmailUI'], ['js/agent/agent-tools.js', 'AgentTools'], ['js/agent/permission-manager.js', 'PermissionManager']]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8') + `\nthis.${name} = ${name};`, ctx);
}
const E = ctx.EmailApp, T = ctx.AgentTools;
const mail = { messageId: 'abc123', account: 'me@example.com', from: 'Sam <sam@example.com>', to: 'me@example.com',
    subject: 'Contract', snippet: 'Please review', bodyText: 'Can you review the contract?', threadId: 'thread1',
    messageIdHeader: '<original@example.com>', date: '2026-10-06T12:00:00Z', labels: ['INBOX', 'UNREAD'], isRead: false,
    attachments: [{ filename: 'invoice.pdf', attachmentId: 'att1', mimeType: 'application/pdf', size: 100 }] };
const outbound = { ...mail, messageId: 'abc124', from: 'me@example.com', to: 'Sam <sam@example.com>', labels: ['SENT'] };
let loads = 0;
E.loadData = async () => {
    // Do not fill until the next microtask: every tool must await this on cold start.
    await Promise.resolve(); loads++;
    E.accounts = [{ email: 'me@example.com' }]; E.emails = [mail, outbound];
    E._resetEmailIndex(); E._dataLoaded = true; E.contacts = [];
    E.priorityAnalyses = { abc123: { summary: 'Review contract', analyzedAt: mail.date } };
};
const cold = async (name, args) => {
    E.accounts = []; E.emails = []; E._dataLoaded = false; E._resetEmailIndex();
    const result = await T.execute(name, args, {});
    assert.ok(!result.error, `${name}: ${result.error}`);
    return result;
};
(async () => {
    // List, body search, full body, attachments and analyses remain available.
    assert.equal((await cold('list_emails', { query: 'invoice' })).emails[0].id, mail.messageId);
    const read = await cold('get_email', { id: mail.messageId });
    assert.equal(read.body, mail.bodyText); assert.equal(read.attachments[0].filename, 'invoice.pdf');
    assert.equal((await cold('read_email_attachment', { id: mail.messageId })).text, 'Invoice total: $42');
    assert.equal((await cold('list_email_analyses', {})).analyses[0].summary, 'Review contract');

    const scanned = await cold('scan_emails', { instruction: 'Find requested actions', fields: ['action'], limit: 1 });
    assert.equal(scanned.rows[0].action, 'Review the contract');
    const older = await cold('sync_older_emails', { until_date: '2026-09-01', account: 'me@example.com' });
    assert.equal(older.results[0].reachedTarget, true, 'an exhausted mailbox completes older-mail sync');

    // Read/archive/trash update the cache AND survive the next load from SQLite.
    assert.equal((await cold('mark_email_read', { id: mail.messageId })).success, true);
    assert.equal(persisted.at(-1).isRead, true);
    assert.equal((await cold('archive_email', { id: mail.messageId })).success, true);
    assert.ok(!persisted.at(-1).labels.includes('INBOX'));
    assert.equal((await cold('trash_email', { id: mail.messageId })).success, true);
    assert.deepEqual(persisted.at(-1).labels, ['TRASH']);

    // Sending goes through the Gmail bridge, with account and thread intact.
    assert.equal((await cold('send_email', { replyToId: outbound.messageId, to: 'sam@example.com', body: 'Checking in.\nThanks <Sam>' })).success, true);
    assert.equal(sent[0].account, 'me@example.com');
    assert.equal(sent[0].params.to, 'sam@example.com');
    assert.equal(sent[0].params.threadId, 'thread1');
    assert.equal(sent[0].params.inReplyTo, '<original@example.com>');
    assert.match(sent[0].params.body, /&lt;Sam&gt;/);
    assert.equal((await cold('send_email', { to: 'sam@example.com', subject: 'Hello', body: 'Hello' })).success, true);
    assert.equal(sent[1].params.threadId, undefined);
    const bad = await T.execute('send_email', { account: 'stranger@example.com', to: 'sam@example.com', body: 'Hello' }, {});
    assert.match(bad.error, /not connected/); assert.equal(sent.length, 2);
    assert.ok(ctx.PermissionManager.ASK_TOOLS.has('send_email'), 'sending retains its approval gate');

    // Reviewing never sends or opens Gmail: incoming replies and sent follow-ups
    // retain the draft and address the other person in an email-scoped chat.
    for (const id of [mail.messageId, outbound.messageId]) {
        await E.openFollowUp(id, { draft: 'Could you take a look?' });
        const chat = chats.at(-1);
        assert.equal(chat.domains[0], 'email'); assert.match(chat.greeting, /Could you take a look/);
        assert.match(chat.greeting, /```email\nTo: sam@example.com\nSubject:/, 'prepared drafts use the email preview');
        const metadata = JSON.parse(chat.extraContext.split('\n').at(-1));
        assert.equal(metadata.to, 'sam@example.com'); assert.equal(metadata.replyToId, id);
        assert.equal(metadata.account, 'me@example.com');
    }
    assert.equal(sent.length, 2, 'reviewing a draft never sends');
    assert.ok(opened.every(app => app === 'agent'));
    await E.openFollowUp('missing', { draft: 'Do not send' });
    assert.equal(chats.length, 2); assert.match(notices.at(-1), /no longer available/);

    // The headless bootstrap still starts all background work without UI nodes.
    const calls = [];
    for (const name of ['backfillScheduleSync', 'startSmartSync', 'setupSyncLifecycle', 'deltaSync', 'requeueMissedAnalyses', 'retriageAfterLexiconChange', 'drainAnalysisQueue']) E[name] = () => calls.push(name);
    const before = loads;
    await Promise.all([E.init(), E.init()]);
    assert.equal(loads, before + 1, 'concurrent bootstraps share one load');
    assert.equal(calls.length, 7);
    assert.equal(E.openCompose, undefined); assert.equal(E.openViewer, undefined);
    const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
    for (const id of ['email-view', 'email-compose-view', 'email-priority-view']) assert.ok(!html.includes(`id="${id}"`));
    assert.ok(!html.includes('data-app="email"'));
    console.log('email-service: headless reads, attachments, writes, sends, draft review and bootstrap passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
