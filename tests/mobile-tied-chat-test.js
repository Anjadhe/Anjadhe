// A chat the phone ties to a page or a record (2026-10-09): the phone's
// Finance screens open ONE conversation per page (`pageKey`) or thing
// (`todayKey` + `recordKey`), as the desktop's PageChat does. MobileChannel
// checks the phone's `about`, continues the conversation the phone named or
// the one already tied to that thing, and otherwise builds it under the
// phone's id with PageChat.conv's keys and opening line, so the two copies
// merge into one.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const load = (f) => (0, eval)(fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/^const (\w+) =/m, 'globalThis.$1 ='));

const results = [];
globalThis.window = { electronMobileChat: { sendResult: async (r) => { results.push(r); }, sendDelta() {}, sendAsk() {}, sendAskDone() {} } };
const sent = [];
let saves = 0, merges = 0, stored = [];
globalThis.AgentService = {
    model: 'm',
    conversations: [],
    _streamingState: new Map(),
    _saveConversations() { saves++; },
    _queueMemoryExtraction() {},
    _seedRecordDomains(conv) { if (conv.recordKey && conv.recordKey.startsWith('portfolio:')) conv.scopedDomains = ['portfolio']; },
    mergeStoredConversations() {
        merges++;
        for (const c of stored) if (!this.conversations.some(x => x.id === c.id)) this.conversations.push(c);
        stored = [];
    },
    async sendMessage(text, _x, opts) { sent.push({ text, convId: opts.convId }); return { type: 'text', content: 'ok' }; },
};
load('js/agent/mobile-channel.js');
const PageChatSrc = fs.readFileSync(path.join(__dirname, '../js/components/page-chat.js'), 'utf8');

(async () => {
    // `about` is checked: a page key, or a thing key; anything else is null.
    assert.strictEqual(MobileChannel.aboutOf({}), null);
    assert.strictEqual(MobileChannel.aboutOf({ about: { title: 'x' } }), null);
    assert.strictEqual(MobileChannel.aboutOf({ about: { todayKey: 'has space: no' } }), null);
    assert.strictEqual(MobileChannel.aboutOf({ about: { pageKey: 'page:Bad Key' } }), null);
    assert.deepStrictEqual(MobileChannel.aboutOf({ about: { pageKey: 'page:portfolio', todayKey: 'task:1', title: 'Your money' } }),
        { pageKey: 'page:portfolio', todayKey: null, recordKey: null, title: 'Your money', body: '' });
    assert.deepStrictEqual(MobileChannel.aboutOf({ about: { todayKey: 'portfolio:account:a1', recordKey: 'portfolio:account:a1', title: 'Brokerage', body: 'It is a Taxable account' } }),
        { pageKey: null, todayKey: 'portfolio:account:a1', recordKey: 'portfolio:account:a1', title: 'Brokerage', body: 'It is a Taxable account' });

    // The opening line is PageChat.conv's, word for word.
    assert(PageChatSrc.includes('content: `This chat is about “${host.title}”.${body ? ` ${/[.!?]$/.test(body) ? body : body + \'.\'}` : \'\'} What would you like to do with it?`'),
        'PageChat.conv opening line changed: keep MobileChannel.openingLine and ChatTie.opening (Assistant.swift) in step');
    assert.strictEqual(MobileChannel.openingLine('AAPL', 'It is your AAPL position'),
        'This chat is about “AAPL”. It is your AAPL position. What would you like to do with it?');
    assert.strictEqual(MobileChannel.openingLine('Plan', ''), 'This chat is about “Plan”. What would you like to do with it?');
    assert.strictEqual(MobileChannel.openingLine('Plan', 'Grow it!'), 'This chat is about “Plan”. Grow it! What would you like to do with it?');

    // A record's chat the Mac has not seen: built under the phone's id, tied, seeded, opened.
    MobileChannel.SYNC_WAIT_MS = 40; MobileChannel.SYNC_POLL_MS = 10;
    await MobileChannel._answer('How is it doing?', { convId: 'conv_1_abcd', about: { todayKey: 'portfolio:account:a1', recordKey: 'portfolio:account:a1', title: 'Brokerage', body: 'It is a Taxable account' } });
    let c = AgentService.conversations.find(x => x.id === 'conv_1_abcd');
    assert(c, 'tied conversation built under the phone id');
    assert.strictEqual(c.todayKey, 'portfolio:account:a1');
    assert.strictEqual(c.recordKey, 'portfolio:account:a1');
    assert.strictEqual(c.recordLabel, 'Brokerage');
    assert.strictEqual(c.channel, undefined, 'a tied chat is not the phone session');
    assert.deepStrictEqual(c.scopedDomains, ['portfolio']);
    assert.strictEqual(c.messages[0].content, 'This chat is about “Brokerage”. It is a Taxable account. What would you like to do with it?');
    assert.deepStrictEqual(sent.at(-1), { text: 'How is it doing?', convId: 'conv_1_abcd' });

    // The same thing again under another (stale) id continues the one already tied.
    await MobileChannel._answer('And now?', { convId: 'conv_2_zzzz', about: { todayKey: 'portfolio:account:a1', recordKey: 'portfolio:account:a1', title: 'Brokerage' } });
    assert.strictEqual(sent.at(-1).convId, 'conv_1_abcd');
    assert.strictEqual(AgentService.conversations.filter(x => x.todayKey === 'portfolio:account:a1').length, 1);

    // A page's chat: pageKey, no record key, no opening line.
    await MobileChannel._answer('What changed?', { convId: 'conv_3_page', about: { pageKey: 'page:portfolio', title: 'Your money' } });
    c = AgentService.conversations.find(x => x.id === 'conv_3_page');
    assert.strictEqual(c.pageKey, 'page:portfolio');
    assert.strictEqual(c.todayKey, undefined);
    assert.strictEqual(c.messages.length, 0);
    assert.strictEqual(c.title, 'Your money');

    // Named, with no `about` (an older Mac main that does not forward it):
    // the phone's copy arriving by sync a moment later is the one answered,
    // with its record's tools seeded.
    setTimeout(() => { stored.push({ id: 'conv_4_sync', title: 'AAPL', todayKey: 'portfolio:ticker:AAPL', recordKey: 'portfolio:ticker:AAPL', messages: [] }); }, 15);
    await MobileChannel._answer('Should I trim?', { convId: 'conv_4_sync' });
    assert.strictEqual(sent.at(-1).convId, 'conv_4_sync');
    assert.deepStrictEqual(AgentService.conversations.find(x => x.id === 'conv_4_sync').scopedDomains, ['portfolio']);

    // Named, never arriving, no `about`: the phone session takes it after the wait.
    const before = merges;
    await MobileChannel._answer('Hello', { convId: 'conv_5_gone' });
    assert(merges - before >= 2, 'it waited for sync');
    const last = AgentService.conversations.find(x => x.id === sent.at(-1).convId);
    assert.strictEqual(last.channel, 'mobile');

    // An id that is not a conversation id is not taken as one.
    await MobileChannel._answer('x', { convId: '../../etc', about: { todayKey: 'portfolio:strategy:s1', recordKey: 'portfolio:strategy:s1', title: 'Plan' } });
    assert(/^conv_\d+_/.test(sent.at(-1).convId));
    assert.notStrictEqual(sent.at(-1).convId, '../../etc');

    // The phone sends `about` through mobile-sync.
    const sync = fs.readFileSync(path.join(__dirname, '../js/adapter/mobile-sync.js'), 'utf8');
    assert(/opts\.about && typeof opts\.about === 'object' \? \{ about: opts\.about \}/.test(sync), 'mobile-sync sendChat forwards about');

    console.log('mobile-tied-chat-test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
