// Recipient discovery and approval use synthetic local history; no real sends.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sent = [], texts = [];
let messagesOn = true, records = [], loads = 0;
const ctx = vm.createContext({
    console, setTimeout: () => 1, clearTimeout() {},
    localStorage: { getItem: () => null },
    StorageManager: { get: () => null, set() { assert.fail('lookup must not write storage'); } },
    IMessageSource: { enabled: () => messagesOn, records: () => records },
    window: {
        electronIMessage: {
            getStatus: async () => ({ handle: '+14255550100' }),
            send: async (to, body) => { texts.push({ to, body }); return { ok: true }; }
        },
        electronEmail: { sendEmail: async (account, params) => { sent.push({ account, params }); return { messageId: 'sent' }; } }
    }
});
for (const [file, name] of [
    ['js/apps/email/email-app.js', 'EmailApp'], ['js/core/cloud-privacy.js', 'CloudPrivacy'],
    ['js/agent/agent-tools.js', 'AgentTools'], ['js/agent/permission-manager.js', 'PermissionManager'],
    ['js/agent/agent-service.js', 'AgentService']
]) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8') + `\nthis.${name} = ${name};`, ctx);
const { AgentTools: T, EmailApp: E, AgentService: S, CloudPrivacy: CP, PermissionManager: P } = ctx;
const plain = value => JSON.parse(JSON.stringify(value));
const mail = {
    from: '"Shah, Priya" <PRIYA@example.com>', to: 'Me <me@example.com>',
    cc: 'Alex <alex@example.com>', date: '2026-10-06T12:00:00Z',
    bodyText: 'Contact Secret <secret@example.com> instead.', labels: ['INBOX']
};
let emails = [mail];
let saved = [{ name: 'Dentist', email: 'office@example.com', manual: true }];
E.loadData = async () => {
    await Promise.resolve(); loads++;
    E.accounts = [{ email: 'me@example.com' }]; E.emails = emails;
    E.contacts = saved.map(c => ({ ...c }));
};
const lookup = (query, channel = 'email', context = {}) => T.execute('find_contact', { query, channel }, context);
const chat = (name, handle, isGroup = false) => ({ date: mail.date, chat: { name, handle, isGroup } });

(async () => {
    assert.ok(T.definitionsFor('', []).some(d => d.function.name === 'find_contact'), 'lookup available before any group loads');
    assert.equal(S._isReadOnlyTool('find_contact'), true);
    assert.ok(S.UNTRUSTED_BLOCKED_TOOLS.has('find_contact'));
    assert.ok((await lookup('', 'email')).error);
    assert.ok((await lookup('Priya', 'fax')).error);
    assert.equal(loads, 0);

    // Cold hydration, names with commas, saved recipients, own-address exclusion.
    const unique = await lookup('Priya');
    assert.equal(loads, 1);
    assert.equal(unique.total, 1); assert.equal(unique.ambiguous, false);
    assert.deepEqual(plain(unique.matches[0]), {
        name: 'Shah, Priya', destination: 'priya@example.com', sources: ['email_header'], lastSeen: new Date(mail.date).toISOString()
    });
    assert.equal((await lookup('Shah, Priya')).total, 1);
    assert.equal((await lookup('me@example.com')).total, 0);
    assert.equal((await lookup('Secret')).total, 0, 'never mine bodies or signatures');
    assert.deepEqual(plain((await lookup('Dentist')).matches[0].sources), ['saved_recipient']);
    assert.equal((await lookup('Alex')).matches[0].destination, 'alex@example.com');
    assert.equal((await lookup('nobody')).total, 0);
    assert.equal(P.resolve('send_email', { to: 'priya@example.com' }).decision, 'ask', 'finding an incoming address grants no send permission');
    assert.equal(E.contacts.length, 1, 'lookup does not promote harvested addresses into saved recipients');

    // Deduplicate by address, not name; do not let the result cap hide ambiguity.
    emails = [mail, { ...mail, from: 'Priya <priya@example.com>' }];
    assert.equal((await lookup('Priya')).total, 1);
    emails.push({ ...mail, from: 'Priya <priya@work.example.com>' });
    assert.equal((await lookup('Priya')).ambiguous, true);
    emails = Array.from({ length: 12 }, (_, i) => ({ ...mail, from: `Priya <p${i}@example.com>` }));
    const many = await lookup('Priya');
    assert.equal(many.total, 12); assert.equal(many.matches.length, 10); assert.equal(many.ambiguous, true);
    emails = [mail];

    // Texts stay in their channel, normalize formatting, and exclude group chats.
    records = [chat('Priya', '+1 (425) 555-0101'), chat('Priya', '+14255550101'),
        chat('Priya group', '+14255550102', true), chat('Alex', 'alex@icloud.com')];
    const text = await lookup('Priya', 'text');
    assert.equal(text.total, 1); assert.equal(text.matches[0].destination, '+14255550101');
    assert.deepEqual(plain(text.matches[0].sources), ['text_conversation']);
    assert.equal((await lookup('+1 (425) 555-0101', 'text')).total, 1);
    assert.equal((await lookup('Alex', 'text')).matches[0].destination, 'alex@icloud.com');
    assert.equal((await lookup('Priya', 'email')).matches[0].destination, 'priya@example.com');
    messagesOn = false;
    assert.ok((await lookup('Priya', 'text')).error, 'stale retained data cannot bypass the source opt-out');
    messagesOn = true;

    // Both the lookup and the existing name-send path use the same ambiguity rule.
    records.push(chat('Priya work', '+14255550103'));
    const ambiguous = await T.resolveTextRecipient('Priya');
    assert.ok(ambiguous.error); assert.equal(ambiguous.matches.length, 2);
    assert.equal((await S._resolvePermission('send_text', { to: 'Priya', body: 'Hi' })).decision, 'deny');
    assert.equal(texts.length, 0);
    records = [chat('Priya', '+14255550101')];
    const args = { to: 'Priya', body: 'See you soon.' };
    assert.equal((await S._resolvePermission('send_text', args)).decision, 'ask');
    assert.equal(args.to, '+14255550101', 'approval shows the actual destination');
    records = [chat('Priya', '+14255550999')];
    assert.equal((await T.execute('send_text', args)).success, true);
    assert.equal(texts[0].to, '+14255550101', 'approved destination stays fixed if history changes');
    const self = { to: 'me', body: 'Reminder' };
    assert.equal((await S._resolvePermission('send_text', self)).decision, 'ask');
    assert.equal(self.to, '+14255550100');

    // Preserve privacy by channel and destination; interactive lookup remains available.
    CP._load = () => ({ classes: {} });
    CP._entry = () => ({ engine: 'anjadhe', model: 'test' });
    CP._noteBlocked = () => {};
    assert.equal((await lookup('Priya', 'text', { ambient: true })).blockedClass, 'messages');
    assert.equal((await lookup('Priya', 'email', { ambient: true })).total, 1);
    assert.equal((await lookup('Priya', 'text')).total, 1);
    CP._load = () => ({ classes: { email: false, messages: true } });
    assert.equal((await lookup('Priya', 'email', { ambient: true })).blockedClass, 'email');
    assert.equal((await lookup('Priya', 'text', { ambient: true })).total, 1);
    CP._entry = () => ({ engine: 'llamacpp', model: 'test' });
    assert.equal((await lookup('Priya', 'email', { ambient: true })).total, 1);
    const before = loads;
    assert.ok((await lookup('Priya', 'email', { untrusted: true })).error);
    assert.equal(loads, before, 'untrusted lookup never reads contacts');

    // Sending a reviewed named recipient preserves the name in the existing store.
    E.saveData = () => {}; E.saveDataSoon = () => {}; E.addPrioritySenderIfNew = () => {};
    T.refreshApp = () => {};
    const result = await T.execute('send_email', { to: '"Shah, Priya" <priya@example.com>', body: 'Hello' });
    assert.equal(result.success, true);
    const remembered = E.contacts.find(c => c.email === 'priya@example.com');
    assert.equal(remembered.name, 'Shah, Priya'); assert.equal(remembered.manual, true);
    assert.equal(sent.length, 1);
    assert.equal(P.resolve('send_email', { to: 'priya@example.com' }).decision, 'ask');
    assert.deepEqual(plain(E._parseAddresses('"Shah, \\"Priya\\"" <priya@example.com>, Alex <alex@example.com>')),
        [{ name: 'Shah, "Priya"', email: 'priya@example.com' }, { name: 'Alex', email: 'alex@example.com' }]);
    console.log('contact-lookup: discovery, ambiguity, channel privacy, saved recipients and exact send approval passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
