#!/usr/bin/env node
/**
 * Routines and results as Standing chats (2026-10-07,
 * js/apps/notes/note-prompts.js): the facade over `conv.standing`, runs as
 * messages, and the one-time move out of the `notes` blob.
 *
 * The move's law (CLAUDE.md, any move of a person's writing): a backup
 * first, every record survives with its text and dates, and a round-trip
 * check — here, every word of each post's HTML is in its Markdown, and a
 * post whose words did not all survive keeps its original HTML too.
 *
 *   node tests/standing-routines-test.js
 */
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<body></body>');
global.document = dom.window.document;

// The world the facade lives in: a store, and AgentService's save funnel.
const store = {};
global.StorageManager = {
    get: k => (store[k] === undefined ? null : JSON.parse(JSON.stringify(store[k]))),
    set: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); }
};
let saves = 0;
global.AgentService = {
    conversations: [],
    activeConversationId: null,
    _saveConversations() { saves++; store['agent-conversations'] = { conversations: JSON.parse(JSON.stringify(this.conversations)) }; },
    deleteConversation(id) { this.conversations = this.conversations.filter(c => c.id !== id); this._saveConversations(); }
};
let n = 0;
global.UIUtils = { generateId: () => `id${++n}` };
const NP = require('../js/apps/notes/note-prompts.js');

const t = (d, h = 8) => new Date(Date.UTC(2026, 9, d, h)).toISOString();

// ── The facade: create / list / config / update / remove ──
{
    const r = NP.create({ title: 'Morning News', body: 'Tell me the news.\n\nShort.', config: { offline: true, interval: 'daily', time: '08:00' } });
    const conv = AgentService.conversations[0];
    assert.ok(conv.standing, 'a routine is a Standing conversation');
    assert.equal(conv.todayKey, `routine:${r.id}`, 'its chat key resolves');
    assert.equal(conv.recordKey, `prompts:${r.id}`, 'its record key resolves');
    assert.equal(NP.list().length, 1);
    assert.equal(NP.bodyText(NP.get(r.id)), 'Tell me the news.\n\nShort.', 'the prompt is plain text, kept whole');
    assert.equal(NP.config(NP.get(r.id)).time, '08:00');
    assert.ok(NP.isRoutine(NP.get(r.id)));
    NP.update(r.id, { title: 'News', config: { web: true } });
    assert.equal(NP.get(r.id).title, 'News');
    assert.equal(NP.config(NP.get(r.id)).web, true);
    assert.equal(NP.config(NP.get(r.id)).time, '08:00', 'an update merges the config');
    assert.equal(NP.list().find(x => x.id === r.id).template, 'prompt', 'readers still see a prompt-shaped record');

    // Runs are messages: posted, read, removed; what was said stays.
    conv.messages.push({ role: 'user', content: 'make it shorter' });
    const card = NP.appendRun(r.id, { content: '**Calm** day.', model: 'nenva cloud lite' });
    assert.equal(card.promptId, r.id);
    assert.equal(card.read, false);
    assert.equal(NP.unreadRuns(conv), 1);
    assert.equal(NP.findRun(card.id).msg.content, '**Calm** day.', 'the run is the Markdown as written');
    assert.equal(NP.markRunRead(card.id), true);
    assert.equal(NP.markRunRead(card.id), false, 'reading twice writes once');
    const failed = NP.appendRun(r.id, { error: 'Model returned an empty response' });
    assert.match(NP.findRun(failed.id).msg.content, /didn’t finish/, 'a failed run says so, in code’s words');
    assert.equal(failed.content, '', 'and carries no content');
    assert.equal(NP.markRunsRead(r.id), 1);
    assert.equal(NP.removeRun(failed.id), true);
    assert.equal(conv.removedMessages.length, 1, 'a removed run leaves its key');
    assert.equal(conv.messages.filter(m => m.role === 'user').length, 1, 'what the person said is never touched');

    // The cap.
    for (let i = 0; i < NP.RUN_KEEP + 3; i++) NP.appendRun(r.id, { content: `Edition ${i}`, at: t(1 + (i % 28), 1 + i) });
    assert.equal(NP.runs(r.id).length, NP.RUN_KEEP, 'a routine keeps RUN_KEEP runs');

    assert.equal(NP.remove(r.id), true);
    assert.equal(NP.list().length, 0, 'deleting a routine deletes its chat');
}

// An instruction to a watcher (docs/ROUTINES_UX.md I2): kept when it names one, dropped otherwise.
assert.equal(NP.config({ standing: { config: { watcher: 'mail' } } }).watcher, 'mail');
assert.equal(NP.config({ standing: { config: { watcher: 'money' } } }).watcher, 'money');
assert.equal(NP.config({ standing: { config: { watcher: 'news' } } }).watcher, null);
assert.equal(NP.config({ standing: { config: {} } }).watcher, null);

// I9: the confirmed sentence, its when written by the app
{
    const c = (p) => NP.config({ standing: { config: p } });
    assert.equal(NP.sentence(c({ interval: 'daily', time: '08:00', saysBack: 'I will check the visa bulletin and tell you only when the dates change.' })),
        'Every day at 8:00 AM, I’ll check the visa bulletin and tell you only when the dates change.');
    assert.equal(NP.sentence(c({ watcher: 'mail', saysBack: 'Tell you right away when the USPTO writes' })), 'As your mail and texts arrive, I’ll tell you right away when the USPTO writes.');
    assert.equal(NP.sentence(c({ watcher: 'money', saysBack: 'tell you when a sleeve leaves its band' })), 'When the money coach looks at your money, I’ll tell you when a sleeve leaves its band.');
    assert.equal(NP.sentence(c({ watcher: 'money', interval: 'weekdays', time: '08:00', saysBack: 'review Core Growth' })), 'Every weekday at 8:00 AM, I’ll review Core Growth.');
    assert.equal(NP.sentence(c({ trigger: { type: 'email', from: 'billing@x.com' }, saysBack: 'file the invoice' })), 'When a new email from "billing@x.com" arrives, I’ll file the invoice.');
    assert.equal(NP.sentence(c({})), null, 'no sentence, nothing said');
    assert.equal(c({ tells: 'change' }).tells, 'change');
    assert.equal(c({ tells: 'sometimes' }).tells, null);
}

console.log('standing routines: facade and runs passed');
