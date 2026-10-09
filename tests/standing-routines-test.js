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

// ── The move out of notes ──
{
    AgentService.conversations = [
        // An edit chat already tied to the routine: its turns come along.
        { id: 'conv_edit', title: 'Change routine', todayKey: 'routine:r1', messages: [{ role: 'user', content: 'make it weekly' }], updatedAt: t(3) }
    ];
    const postHtml = '<h2>Morning News</h2><p>Markets were <strong>flat</strong>. See <a href="https://example.com/a">the story</a>.</p>' +
        '<ul><li>One</li><li>Two<ul><li>Two-a</li></ul></li></ul><table><tr><th>Ticker</th><th>Move</th></tr><tr><td>AAPL</td><td>+1%</td></tr></table>';
    store.notes = { notes: [
        { id: 'mine', title: 'Packing list', content: '<p>Socks</p>', modifiedAt: t(1) },
        { id: 'r1', title: 'Morning News', template: 'prompt', content: '<p>Tell me the news &amp; markets.</p><p>Keep it short.</p>',
          prompt: { offline: true, interval: 'weekdays', time: '07:30', runMode: 'digest' }, createdAt: t(1), modifiedAt: t(2) },
        { id: 'p1', title: 'Morning News', template: 'feed', content: postHtml, feed: { promptId: 'r1', model: 'nenva cloud lite', readAt: t(4, 9) }, createdAt: t(4), modifiedAt: t(4) },
        { id: 'p2', title: 'Morning News', template: 'feed', content: '', feed: { promptId: 'r1', error: 'Model returned an empty response' }, createdAt: t(5), modifiedAt: t(5) },
        { id: 'p3', title: 'Old Routine', template: 'feed', content: '<p>From a routine since deleted.</p>', feed: { promptId: 'gone' }, createdAt: t(2), modifiedAt: t(2) }
    ] };
    const before = JSON.parse(JSON.stringify(store.notes.notes));

    const report = NP.migrateFromNotes();
    assert.equal(report.moved, 4, 'the routine and its three posts moved');

    // Backup first, verbatim.
    assert.deepEqual(store['routines-move-backup'].notes, before.filter(x => x.id !== 'mine'), 'every moved note is backed up verbatim');

    // Out of notes, with tombstones; the person's own note untouched.
    assert.deepEqual(store.notes.notes.map(x => x.id), ['mine'], 'only the person’s writing is left in notes');
    assert.deepEqual(Object.keys(store.notes.tombstones).sort(), ['p1', 'p2', 'p3', 'r1'], 'every moved note is tombstoned, so its .md file goes');

    // The routine: same id, same words, same schedule, its edit chat folded in.
    const r = NP.get('r1');
    assert.ok(r, 'the routine kept its id');
    assert.equal(NP.bodyText(r), 'Tell me the news & markets.\n\nKeep it short.', 'the prompt survived whole');
    assert.equal(NP.config(r).interval, 'weekdays');
    assert.equal(NP.config(r).time, '07:30');
    assert.equal(r.createdAt, t(1), 'its date survived');
    const conv = NP.conversationOf('r1');
    assert.ok(conv.messages.some(m => m.content === 'make it weekly'), 'the edit chat’s turns came along');
    assert.equal(AgentService.conversations.some(c => c.id === 'conv_edit'), false, 'one routine, one conversation');

    // The posts: runs on that chat, in time order, read marks and errors kept.
    const runs = NP.runs('r1');
    assert.deepEqual(runs.map(x => x.id), ['p2', 'p1'], 'newest first, ids kept');
    assert.equal(runs[1].readAt, t(4, 9), 'a read post stays read');
    assert.equal(runs[1].model, 'nenva cloud lite');
    assert.equal(runs[0].error, 'Model returned an empty response', 'a failed run stays failed');
    const md = NP.findRun('p1').msg.content;
    assert.ok(NP.roundTrips(postHtml, md), 'every word of the post is in its Markdown');
    assert.match(md, /\*\*flat\*\*/, 'emphasis carried');
    assert.match(md, /\[the story\]\(https:\/\/example\.com\/a\)/, 'links carried');
    assert.match(md, /\n  - Two-a/, 'a nested list stays nested');
    assert.match(md, /\| AAPL \| \+1% \|/, 'a table stays a table');
    assert.equal(NP.findRun('p1').msg.metadata.routineRun.html, undefined, 'a clean conversion keeps no second copy');

    // A post whose routine is gone keeps its words on a quiet, unarmed chat.
    const orphan = NP.findRun('p3');
    assert.ok(orphan, 'nothing is dropped');
    assert.equal(NP.config(orphan.conv).offline, false, 'the stand-in is never armed');
    assert.equal(orphan.conv.title, 'Old Routine');

    // Idempotent: a second start moves nothing and duplicates nothing.
    const again = NP.migrateFromNotes();
    assert.equal(again.moved, 0);
    assert.equal(NP.runs('r1').length, 2);

    // A second Mac's copy arriving later (the notes blob still holding them)
    // moves again without duplicating a run.
    store.notes = { notes: [...store.notes.notes, before.find(x => x.id === 'p1')] };
    NP.migrateFromNotes();
    assert.equal(NP.runs('r1').length, 2, 'a run already moved is not moved twice');
}

// ── A saved prompt never scheduled goes to the backup, not to Standing ──
{
    AgentService.conversations = [];
    delete store['routines-move-backup'];
    store.notes = { notes: [
        { id: 'sp1', title: 'Learn piano', template: 'prompt', content: '<p>Teach me.</p>', prompt: { offline: false } },
        { id: 'sp2', title: 'India news', template: 'prompt', content: '<p>Summarize.</p>', prompt: { offline: false } },
        { id: 'sq2', title: 'India news', template: 'feed', content: '<p>A result.</p>', feed: { promptId: 'sp2' }, createdAt: t(7) }
    ] };
    const rep = NP.migrateFromNotes();
    assert.equal(rep.dropped, 1, 'the never-run saved prompt is not made a routine');
    assert.equal(NP.conversationOf('sp1'), null, 'and is listed nowhere');
    assert.ok(store['routines-move-backup'].notes.some(n => n.id === 'sp1'), 'its words are in the backup');
    assert.deepEqual(store.notes.notes, [], 'it left Notes like the rest');
    assert.ok(NP.conversationOf('sp2'), 'a saved prompt with past results keeps its chat');
    assert.equal(NP.runs('sp2').length, 1, 'and its result');
}

// ── A conversion that loses words keeps the original ──
{
    const html = '<p>Kept</p><svg><text>lost-word</text></svg>';
    const md = NP.htmlToMarkdown(html);
    if (!NP.roundTrips(html, md)) {
        AgentService.conversations = [];
        store.notes = { notes: [
            { id: 'r9', title: 'R', template: 'prompt', content: '<p>x</p>', prompt: { offline: true } },
            { id: 'q9', title: 'R', template: 'feed', content: html, feed: { promptId: 'r9' }, createdAt: t(6) }
        ] };
        const rep = NP.migrateFromNotes();
        assert.equal(rep.unverified, 1);
        assert.equal(NP.findRun('q9').msg.metadata.routineRun.html, html, 'the original rides with the message');
    }
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

console.log('standing routines: facade, runs and the move out of notes passed');
