#!/usr/bin/env node
// Finance's chat box (2026-10-09, docs/COACH.md §7): every Finance page
// offers the assistant's box (PageChat) instead of "Add a note" and the
// Decisions list. One conversation per page or record; a record's chat
// carries its record key, so its block, its notes and its tools ride every
// turn.
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

// ── The Finance page: the box replaced the note door and Decisions ──
{
    const app = read('js/apps/portfolio/portfolio-app.js');
    const view = read('js/apps/portfolio/view.html');
    const ui = read('js/apps/portfolio/portfolio-ui.js');
    assert.ok(view.includes('id="portfolio-chat"'), 'a box on the page');
    assert.ok(!view.includes('portfolio-decisions'), 'no Decisions list');
    assert.ok(!/add\('note'/.test(app), 'no "Add a note" in the menu');
    assert.ok(!/DecisionsUI/.test(app), 'decisions are kept through the chat (save_decision)');
    assert.ok(/chatBoxHtml\('ticker', ticker\)/.test(ui), 'the ticker page has its own box');
    assert.ok(/renderLinkedNotes/.test(ui) && !/linked-items-create-btn/.test(app), 'old linked notes stay readable; none are created here');
    assert.ok(/rest\.startsWith\('ticker:'\)/.test(app), 'a ticker\'s chat resolves to its block');
    assert.ok(/save_decision so it rides every later read/.test(app), 'the assistant is told where notes about it live');
    const plan = read('js/apps/portfolio/portfolio-strategy-page.js');
    assert.ok(/portfolio:strategy:\$\{id\}/.test(plan) && /recordKey: key/.test(plan), 'a plan has its own chat, carrying its record');
    assert.ok(!/DecisionsUI|data-ask-open/.test(plan), 'no Decisions list and no separate "Ask about" door on a plan');
    assert.ok(/PageChat\.open\(this\._chatKey\(this\._openId\), b\.dataset\.ask\)/.test(plan), 'a plan\'s quoted questions go into its own chat');
    assert.ok(/save_decision \(type strategy\)/.test(app));
}

console.log('finance-chat: the box, the record it carries, and notes as decisions passed');
