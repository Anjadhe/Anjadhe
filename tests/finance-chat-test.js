#!/usr/bin/env node
// Finance's chats (2026-10-09, docs/COACH.md §7; threads since 2026-10-12,
// docs/THREAD_PANELS.md step 3): one conversation per record or Your money;
// a record's chat carries its record key, so its block, its notes and its
// tools ride every turn.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// ── PageChat: a thing's chat carries its record ──
{
    global.document = undefined;
    const seeded = [];
    global.AgentService = { conversations: [], _saveConversations() {}, _seedRecordDomains(c) { seeded.push(c.recordKey); } };
    const PageChat = require('../js/components/page-chat.js');
    PageChat._wire = () => {};
    PageChat.html('portfolio:account:a1', { title: 'Brokerage', recordKey: 'portfolio:account:a1', recordLabel: 'Brokerage', body: 'It is a Brokerage account' });
    const conv = PageChat.conv('portfolio:account:a1', true);
    assert.strictEqual(conv.todayKey, 'portfolio:account:a1');
    assert.strictEqual(conv.recordKey, 'portfolio:account:a1', 'the record rides the chat');
    assert.deepStrictEqual(seeded, ['portfolio:account:a1'], 'and its tool groups are loaded');
    assert.strictEqual(PageChat.conv('portfolio:account:a1', true), conv, 'one conversation per record');
    assert.match(conv.messages[0].content, /about “Brokerage”\. It is a Brokerage account\./);
    PageChat.html('page:portfolio', { title: 'Your money' });
    const page = PageChat.conv('page:portfolio', true);
    assert.strictEqual(page.pageKey, 'page:portfolio'); assert.strictEqual(page.recordKey, undefined, 'the overview is a page, with the Finance tools by its key');
}

// ── No Finance pages (2026-10-12, docs/THREAD_PANELS.md step 3): its chats are threads ──
{
    // A host resolver titles a chat no page drew (Finance's record keys).
    const PageChat = require('../js/components/page-chat.js');
    PageChat._hosts.clear();
    PageChat.registerHosts(/^portfolio:account:/, key => ({ title: 'IRA', recordKey: key, recordLabel: 'IRA', body: 'It is your ira account' }));
    assert.strictEqual(PageChat.hostOf('portfolio:account:x9').title, 'IRA');
    assert.strictEqual(PageChat.hostOf('portfolio:strategy:s1'), null, 'a key no resolver knows has no host');
    const conv = PageChat.conv('portfolio:account:x9', true);
    assert.strictEqual(conv.recordKey, 'portfolio:account:x9', 'the record rides a resolved chat too');
    const app = read('js/apps/portfolio/portfolio-app.js');
    assert.ok(/rest\.startsWith\('ticker:'\)/.test(app), 'a ticker\'s chat resolves to its block');
    assert.ok(/save_decision so it rides every later read/.test(app), 'the assistant is told where notes about it live');
    assert.ok(/save_decision \(type strategy\)/.test(app));
    assert.ok(!/AppManager\.register|innerHTML|Modal\./.test(app), 'the data layer draws nothing');
    const manifest = JSON.parse(read('js/apps/portfolio/manifest.json'));
    assert.ok(!manifest.view && !manifest.styles.length, 'no Finance page, no Finance stylesheet');
}

console.log('finance-chat: the record each Finance chat carries, titled with no page, passed');
