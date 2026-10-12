// Shell regression checks: navigation (Threads is home since 2026-10-11), the cards, the day, privacy and lock boundaries.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const PrivateChat = require('../js/agent/private-chat');
const source = fs.readFileSync(path.join(__dirname, '../js/core/simple-experience.js'), 'utf8');
const html = '<body><div id="app-views"></div><header><button id="titlebar-apps-btn"></button><div class="titlebar-actions"></div></header></body>';
const dom = new JSDOM(html, { url: 'https://local.test', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
let locks = new Set();
let journalDue = false;
let groupedOptions;
let resumed;
let rendered = 0;
const conversations = [
    { id: 'old', title: 'Old chat', updatedAt: '2026-01-01', messages: [{}] },
    { id: 'new', title: '<img src=x onerror=evil()>', updatedAt: '2026-09-18', messages: [{}] },
    { id: 'empty', title: 'Empty', messages: [] },
    { id: 'private', title: 'SECRET', private: true, messages: [{}] }
];
w.FEATURES = { isEnabled: () => false };
w.AppManager = {
    currentApp: null, sensitiveUnlocked: false, apps: { email: {}, fyi: {}, calendar: {}, actions: {}, notes: {}, portfolio: {}, prompts: {}, settings: {} },
    register(name, app) { this.apps[name] = app; },
    isAppLocked: app => locks.has(app),
    journalNudgeDue: () => journalDue,
    openApp(app) { if (!locks.has(app)) this.currentApp = app; },
    // A launcher door: openApp without a Back step (AppManager._navJump).
    openAppFromLauncher(app) { this.openApp(app); }
};
w.UIUtils = { escapeHtml: s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') };
w.AgentService = {
    conversations,
    getConversationList: () => PrivateChat.persistable(conversations).map(c => ({ ...c, messageCount: c.messages.length })),
    isConversationStreaming: () => false,
    loadConversation: id => { resumed = id; }
};
w.AgentUI = { closeProfilePanel() {}, renderAppView() { rendered++; }, formatTimeAgo: () => 'today' };
// Every job reaches the shell through TeamJobs.all() (js/agent/team-jobs.js).
w.TeamJobs = { isJob: () => true, waiting: () => null, stop() {}, resume() {}, all: () => [
    { id: 'working', conversationId: 'old', goal: 'Working task', status: 'running' },
    { id: 'approval', updatedAt: '2026-09-18', conversationId: 'new', goal: 'Approve plan', status: 'awaiting_user', plan: [{ step: 'Prepare a draft', status: 'pending' }] },
    { conversationId: 'private', goal: 'SECRET task', status: 'awaiting_user' },
    { conversationId: 'old', goal: 'Finished task', status: 'done' }
] };
// Now reads commitments (2026-10-11): an overdue one-time commitment and today's.
const TODAY_ISO = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const fakeItems = [{ id: 'due', title: 'Due task', state: 'open', when: { date: '2026-09-02' }, repeat: { rule: 'none' } },
    { id: 'today', title: 'Today task', state: 'open', when: { date: TODAY_ISO }, repeat: { rule: 'none' } }];
w.Commitments = { _inited: true, all: () => fakeItems, get: id => fakeItems.find(c => c.id === id) || null, today: () => TODAY_ISO,
    repeats: c => !!(c.repeat && c.repeat.rule !== 'none'), occursOn: () => false, isDone: () => false,
    timeOn: c => ({ time: (c.when && c.when.time) || null, end: null }), kindOf: () => 'task', setDone: () => ({ ok: true, changed: [] }), undo() {} };
// Raises (docs/NOW.md): a card is a record in a synced store; the test
// keeps it in memory.
const store = {};
w.StorageManager = { get: k => store[k] ? JSON.parse(JSON.stringify(store[k])) : null, set: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
w.eval(fs.readFileSync(path.join(__dirname, '../js/core/raises.js'), 'utf8') + '\nwindow.Raises = Raises;');
w.eval(source + '\nwindow.subject = SimpleExperience;');
const s = w.subject;
// Every card, approvals included, lives in a thread (docs/SENDERS.md M7);
// the Now page itself is gone (2026-10-11). The cards' mechanics below are
// what the threads read.
assert.equal(s.nowShows, undefined, 'no Now page to show cards on');
assert.equal(s.deckCards, undefined, 'no deck held still for a page');
assert.equal(s.ledeLine, undefined, 'no lede: nenva\u2019s thread says what it is reading');
assert.equal(s.noteParts, undefined, 'no note over a page');
// The one shell since 2026-10-05 (the full shell and its switch are gone).
assert.equal(s.isOn(), true, 'the simple shell is always on');
s.init(); s.init();
assert.equal(w.document.querySelectorAll('.nv-topnav').length, 1, 'initialization is idempotent');
// The nav (2026-10-01; Jobs and Widgets folded away 2026-10-06; Now retired 2026-10-11: Threads is home).
assert.equal(Array.from(w.document.querySelectorAll('.nv-items button'), b => b.textContent).join(','), 'Threads,Memory,Settings');
assert.equal(s.navKey(null), 'threads', 'home is Threads');
assert.equal(s.navKey('home'), 'threads');
assert.equal(w.document.querySelector('.nv-items [data-id="now"]'), null, 'Now is not a nav item');
assert.equal(s.navKey('agent'), 'threads', 'Chats left the nav (M7): a chat keeps Threads lit');
assert.equal(s.navKey('prompts'), 'threads', 'a routine is a standing chat, reached from Threads (M7)');
assert.equal(s.navKey('fyi'), 'memory', 'the folders from mail are Memory\u2019s (2026-10-07)');
assert.equal(s.navKey('commitments'), 'memory', 'Commitments is a door on Memory');
assert.equal(s.navKey('matter'), 'memory');
assert.equal(w.document.querySelector('.nv-items [data-id="jobs"]'), null, 'Jobs is not a nav item (folded into Chats, 2026-10-06)');
s.onNavigate('jobs');
assert.equal(w.document.querySelector('.nv-items .is-on').dataset.id, 'threads', 'a job view keeps Threads lit (M7)');
w.AppManager.currentApp = null;
assert.equal(w.document.querySelector('#updates-view'), null, 'the Updates page is gone (2026-10-09)');
assert.equal(w.document.querySelector('#simple-home-sections'), null, 'the Now page is gone (2026-10-11): the shell paints no page of its own');
assert.equal(w.document.querySelector('.nv-dock'), null, 'and no docked composer: nenva\u2019s thread has the box');
assert.deepEqual(Array.from(s.conversations(), c => c.id), ['new', 'old']);
// render() repaints Threads when it is up (every record change still calls it).
let threadsRepaints = 0;
w.ThreadsPage = { _repaint: () => { threadsRepaints++; } };
s.render();
assert.equal(threadsRepaints, 1, 'render repaints the home page');
delete w.ThreadsPage;
// ── The cards (2026-10-01), each in its thread since M7 ─────────────────
// The data under the cards: the request for judgment first, then the overdue task.
const next = s.nextRows();
assert.equal(next.map(r => r.kind).join(','), 'ask,task');
assert.match(next[0].detail, /plan ready/);
assert.equal(next[1].title, 'Due task');
const firstCards = s.cards();
assert.equal(firstCards[0].kind, 'decide');
assert.equal(firstCards[1].key, 'task:due');
w.AppManager.currentApp = null;
let completed = null;
w.Commitments.setDone = (id, done) => { completed = done ? id : null; return { ok: true, changed: ['state'] }; };
s.cardAct('task:due', 'primary');
assert.equal(completed, 'due', 'an overdue card’s main action completes the task (Commitments.setDone)');
// Later is a state on the raise (docs/NOW.md R2): the card is off Now, the
// task itself is untouched, and the raise says what was done to it.
s.cardAct('task:due', 'later');
assert.equal(s.cards().some(c => c.key === 'task:due'), false, 'Later hides it');
assert.equal(s.allCards().some(c => c.key === 'task:due'), true, 'the record is untouched');
assert.equal(w.Raises.get('task:due').state, 'later');
assert.equal(w.Raises.get('task:due').until > new Date().toISOString(), true);
assert.equal(w.localStorage.getItem('now-cards'), null, 'no per-Mac side-table');
// Set aside for good from its chat: holds while the facts hold (R3).
s.cardAct('task:due', 'gotit', { by: 'chat', quote: 'just ignore it' });
assert.equal(w.Raises.get('task:due').state, 'settled');
assert.deepEqual([w.Raises.get('task:due').settled.how, w.Raises.get('task:due').settled.by, w.Raises.get('task:due').settled.quote], ['ignore', 'chat', 'just ignore it']);
assert.equal(s.cards().some(c => c.key === 'task:due'), false, 'still off Now on the next tick');
// The facts move (its date changed): back, saying why.
fakeItems[0].when = { date: '2026-09-01' };
const back = s.cards().find(c => c.key === 'task:due');
assert.ok(back, 'back on Now with new facts');
assert.equal(back.reopened.why, w.Raises.REOPEN_LINE);
w.Raises._data = null; delete store.raises;   // a clean slate for what follows
const listWork = w.TeamJobs.all;
s.render();
// A running job is not a card (it was the presence line on Now; nenva's thread says it).
assert.equal(s.cards().some(c => /Working task/.test(c.title)), false);
// The day (schedule): today's tasks, the untimed last with no time (the thread reads "Anytime").
{
    const sched = s.schedule();
    assert.ok(sched.today.length >= 1);
    const last = sched.today[sched.today.length - 1];
    assert.equal(last.title, 'Today task'); assert.equal(last.time, '');
    assert.ok(Array.isArray(sched.flat) && sched.week && sched.week.days.length === 7, 'Coming up rides the same object');
}
assert.equal(s.workMessage({ status: 'awaiting_user', plan: [] }).includes('plan ready'), false, 'never claim a missing plan exists');
assert.equal(JSON.stringify(s.cards()).includes('SECRET'), false, 'a private chat\u2019s job is never a card');
assert.equal(s.cards().some(c => /Finished task/.test(c.title)), false, 'an old finished job is not news');
// From your routines: the home feed reduced to one row per routine. The
// shell delegates the grouping, the summary and the time to PromptFeed and
// writes no sentence of its own about a post.
let scopedUnread;
let openedPost;
w.NotePrompts = { list: () => [{ id: 'r1', title: 'Morning News' }, { id: 'r2', title: 'Market Review' }] };
const cards = [
    { id: 'p1', promptId: 'r1', promptTitle: 'Morning News', createdAt: '2026-09-20T07:00:00Z' },
    { id: 'p0', promptId: 'r1', promptTitle: 'Morning News', createdAt: '2026-09-19T07:00:00Z' },
    { id: 'p2', promptId: 'r2', promptTitle: '<img src=x onerror=evil()>', createdAt: '2026-09-20T06:00:00Z' },
    { id: 'p3', promptId: 'r3', promptTitle: 'Third', createdAt: '2026-09-20T05:00:00Z' },
    { id: 'p4', promptId: 'r4', promptTitle: 'Fourth', createdAt: '2026-09-20T04:00:00Z' },
    { id: 'pub', published: true, promptTitle: 'From nenva', createdAt: '2026-09-20T08:00:00Z' }
];
w.PromptFeed = {
    _scopedItems(unreadOnly) { scopedUnread = unreadOnly; return cards; },
    _series(items) {
        const by = new Map();
        for (const it of items) {
            const key = it.published ? 'pub:' + it.id : 'prompt:' + it.promptId;
            if (!by.has(key)) by.set(key, { key, title: it.promptTitle, published: !!it.published, editions: [] });
            by.get(key).editions.push(it);
        }
        return [...by.values()].map(sc => ({ ...sc, latest: sc.editions[0] }));
    },
    _summaryFor: it => 'Summary of ' + it.id,
    _timeAgo: () => '2h ago',
    openPost(id, opts) { openedPost = { id, opts }; }
};
assert.equal(scopedUnread, undefined);
let updates = s.routineUpdates();
assert.equal(scopedUnread, true, 'the home asks for unread editions only');
assert.equal(updates.map(u => u.id).join(','), 'p1,p2,p3', 'one row per routine, newest edition, capped');
assert.equal(updates.some(u => u.title === 'From nenva'), false, 'an announcement is not something a routine did');
assert.equal(updates[0].summary, 'Summary of p1', 'the summary is PromptFeed\u2019s, never the shell\u2019s');
s.render();
// On Now a routine's unread edition is a heads-up card, opening the post.
const routineCard = s.cards().find(c => c.post === 'p1');
assert.ok(routineCard, 'a posted routine is a card');
assert.equal(routineCard.kind, 'headsup');
s.cardAct(routineCard.key, 'primary');
assert.equal(openedPost.id, 'p1', 'the card opens the newest edition');
assert.equal(openedPost.opts.back, 'Threads', 'and names the way back: home is Threads');
// A scheduled look's report is ONE card per routine with its before → after
// lines (docs/ROUTINES_UX.md I6); a failed run raises nothing on its own (I7).
w.eval(fs.readFileSync(path.join(__dirname, '../js/core/routine-look.js'), 'utf8') + '\nwindow.RoutineLook = RoutineLook;');
w.eval(fs.readFileSync(path.join(__dirname, '../js/core/routine-failures.js'), 'utf8') + '\nwindow.RoutineFailures = RoutineFailures;');
cards[0].look = { headline: 'EB-2 India moved to 01JAN14', changes: [{ what: 'EB-2 India FAD', before: '01NOV13', after: '01JAN14' }], card: true };
cards[2].error = 'connect ECONNREFUSED 10.0.0.1:8080';
{
    let all = s.allCards();
    const look = all.find(c => c.post === 'p1');
    assert.equal(look.thing, 'routine:r1', 'one raise per routine, not per run');
    assert.equal(look.title, 'EB-2 India moved to 01JAN14');
    assert.equal(look.body, 'EB-2 India FAD: 01NOV13 → 01JAN14');
    assert.equal(all.some(c => c.post === 'p2'), false, 'a failed run raises no card');
    cards[0].look.card = false;
    assert.equal(s.allCards().some(c => c.post === 'p1'), false, 'a report the look kept in its chat raises no card');
    const iso = ms => new Date(ms).toISOString();
    const t = Date.now();
    w.RoutineEngine = { failures: () => ({
        r1: { since: iso(t - 48 * 3600000), last: iso(t), count: 3, error: 'connect ECONNREFUSED 10.0.0.1:8080', cause: 'model' },
        r2: { since: iso(t - 48 * 3600000), last: iso(t), count: 3, error: 'HTTP 403', cause: 'routine' }
    }) };
    all = s.allCards();
    const model = all.find(c => c.key === 'routines:model');
    assert.ok(model && model.modelFail, 'the model as the cause is one card');
    assert.equal(model.title, '“Morning News” can’t reach the model');
    const stuck = all.find(c => c.key === 'routine:r2');
    assert.equal(stuck.routineFail, 'r2', 'a routine that keeps failing is one card for it');
    assert.equal(stuck.title, '“Market Review” keeps failing');
    delete w.RoutineEngine;
    delete cards[0].look; delete cards[2].error;
}
locks = new Set(['prompts']);
assert.equal(s.routineUpdates().length, 0, 'a locked Routines app contributes no results');
locks = new Set(['agent']);
assert.equal(s.routineUpdates().length, 0, 'and neither do locked chats, where the results live (2026-10-07)');
locks = new Set();

// A routine stopped on a question is a real request for judgment, and it
// reaches Needs you even though no conversation owns it.
w.PromptsApp = { open(arg) { openedRoutine = arg; } };
let openedRoutine = null;
w.TeamJobs.all = () => [{ id: 'ask', engine: 'team', routineId: 'r2', status: 'awaiting_user', note: 'Which account should I use?' }];
const ask = s.attention().find(item => item.kind === 'routine');
assert.ok(ask, 'an ambient routine ask is not hidden by the conversation scope');
assert.equal(ask.title, 'Market Review', 'the row names the routine, not the task id');
assert.match(ask.message, /Which account/);
s.render();
assert.equal(s.nextRows()[0].action, 'Open the routine');
s.review(ask.id);
assert.equal(w.AppManager.currentApp, 'jobs', 'a routine run waiting on a change opens its job page');
assert.equal(s._jobOpen, 'ask', 'on the run that is waiting');
s._jobOpen = null;
locks = new Set(['prompts']);
assert.equal(s.attention().some(item => item.kind === 'routine'), false, 'a locked Routines app asks nothing');
locks = new Set();
w.TeamJobs.all = listWork;
w.AppManager.currentApp = null;
s.render();

rendered = 0;
s.resume('old');
assert.equal(resumed, 'old');
assert.equal(rendered, 1);
resumed = null;
s.resume('private');
assert.equal(resumed, null);
locks = new Set(['agent', 'actions']);
s.render();
assert.equal(s.attention().length, 0, 'locked apps contribute no attention titles');
assert.equal(s.conversations().length, 0, 'locked chats contribute no history titles');
s.resume('old');
assert.equal(resumed, null, 'stale history clicks cannot bypass app locks');
locks = new Set();
assert.equal(w.document.querySelector('dialog'), null, 'history has no modal');
s.showHistory();
assert.equal(w.AppManager.currentApp, 'conversations');
const input = w.document.querySelector('.simple-history input');
input.value = 'old';
s.renderHistory();
assert.equal(w.document.querySelectorAll('.simple-history-row').length, 1);
assert.equal(w.document.querySelector('.simple-history-row').dataset.id, 'old');
assert.equal(s.historyBucket('2026-09-18T12:00:00', new Date('2026-09-18T20:00:00')), 'Today');
assert.equal(s.historyBucket('2026-09-17T12:00:00', new Date('2026-09-18T20:00:00')), 'Yesterday');
assert.equal(s.historyPreview({messages:[{role:'user',content:'My question'}, {role:'tool',content:'SECRET TOOL'}]}), 'My question');
assert.equal(s.historyPreview({messages:[{role:'user',content:[{type:'image_url',image_url:'SECRET IMAGE'}, {type:'text',text:'A picture'}]}]}), 'A picture');
s._historyPage.scrollTop = 240;
w.AppManager.apps.conversations.onHide();
assert.equal(s._historyScroll, 240);
s.resume('old');
assert.equal(input.value, 'old', 'opening a chat preserves history search');
locks = new Set(['agent']);
s.renderHistory();
assert.equal(w.document.querySelectorAll('.simple-history-row').length, 0, 'lock clears preview rows too');
// Standing chats (2026-10-06, Routines folded into Chats): every routine
// on the Chats page with its trigger and last run, in its own words; a row
// opens the routine's detail, the last row opens the interview.
{
    locks = new Set();
    const np = w.NotePrompts;
    w.NotePrompts = { list: () => [{ id: 'r1', title: 'Morning News', prompt: { offline: true } }, { id: 'r9', title: 'Saved prompt', prompt: {} }],
        config: n => ({ offline: !!(n.prompt && n.prompt.offline) }), triggerLabel: () => 'every day at 8:00 AM',
        conversationOf: id => ({ id, messages: [] }), unreadRuns: () => 0 };
    w.RoutineEngine = { statusFor: () => ({ lastRun: '2026-09-20T07:00:00Z' }) };
    w.PromptFeed._timeAgo = () => '2h ago';
    input.value = '';
    s.renderHistory();
    // Conversations | Standing are tabs (2026-10-07): Standing is not under
    // the conversations, it is one tap away with its count.
    assert.equal(w.document.querySelector('.nv-standing'), null, 'Standing is its own tab, not under the conversations');
    const tabs = [...w.document.querySelectorAll('[data-chats-tab]')];
    assert.deepEqual(tabs.map(t => t.dataset.chatsTab), ['chats', 'standing']);
    assert.match(tabs[1].textContent, /Standing\s*2/, 'the tab carries its count');
    assert.equal(tabs[1].querySelector('.nv-chats-tab-dot'), null, 'no dot while nothing needs you');
    tabs[1].click();
    assert.equal(s.historyTab(), 'standing');
    assert.equal(input.placeholder, 'Search routines…');
    const standing = w.document.querySelector('.nv-standing');
    assert.ok(standing, 'a Standing section');
    const rows = standing.querySelectorAll('[data-simple="routine"]');
    // A saved prompt left Notes with the routines (2026-10-07): Standing is
    // its only home now, so it is listed, saying it runs when asked.
    assert.equal(rows.length, 2, 'every Standing chat: the routine and the saved prompt');
    assert.equal(rows[0].dataset.id, 'r1');
    assert.match(rows[0].textContent, /every day at 8:00 AM/);
    assert.match(rows[0].textContent, /ran 2h ago/);
    assert.match(rows[1].textContent, /when you ask/);
    assert.ok(standing.querySelector('[data-simple="routine-new"]'), 'Set up a routine');
    let opened = null, asked = false;
    w.PromptsApp = { open: a => { opened = a; }, askNewRoutine: () => { asked = true; } };
    rows[0].click();
    assert.equal(opened && opened.id, 'r1');
    standing.querySelector('[data-simple="routine-new"]').click();
    assert.equal(asked, true);
    assert.equal(w.document.querySelector('.nv-items [data-id="routines"]'), null, 'Routines is not a nav item');
    // A failed last run puts the dot on the tab, so it is seen from Conversations.
    w.RoutineEngine = { statusFor: () => ({ lastError: 'boom' }) };
    s.showHistoryTab('chats');
    assert.ok(w.document.querySelector('[data-chats-tab="standing"] .nv-chats-tab-dot'), 'a failed routine marks the Standing tab');
    assert.equal(input.placeholder, 'Search conversations…');
    w.NotePrompts = np; delete w.RoutineEngine; delete w.PromptsApp;
}
// ── Jobs (2026-10-01, nenva's job page) ───────────────────────────────
{
    locks = new Set();
    const tasks = [
        { id: 'j1', conversationId: 'old', goal: 'Compare three flights', status: 'running', updatedAt: new Date().toISOString(),
          plan: [{ step: 'Search fares', status: 'done', note: '3 found' }, { step: 'Compare', status: 'running' }, { step: 'Write it up', status: 'pending' }] },
        { id: 'j2', conversationId: 'private', goal: 'SECRET job', status: 'done' }
    ];
    let cancelled = null;
    const listJobs = w.TeamJobs.all;
    w.TeamJobs.all = () => tasks;
    w.TeamJobs.stop = id => { cancelled = id; };
    assert.equal(s.jobs().map(t => t.id).join(','), 'j1', 'a private chat\u2019s job is never listed');
    s.openJob('j1');
    assert.equal(w.AppManager.currentApp, 'jobs');
    const page = w.document.getElementById('jobs-view');
    assert.match(page.textContent, /Compare three flights/);
    assert.equal(page.querySelectorAll('.nv-step').length, 3);
    assert.match(page.textContent, /3 found/, 'a step\u2019s own note');
    assert.ok(page.querySelector('.nv-step.is-running .nv-ring'), 'the running step pulses');
    page.querySelector('[data-job-act="stop"]').click();
    assert.equal(cancelled, 'j1');
    resumed = null;
    page.querySelector('[data-job-act="chat"]').click();
    assert.equal(resumed, 'old', 'the chat door opens the chat the job reports into');
    w.AppManager.currentApp = 'jobs';
    s.openJob('j1');
    resumed = null;
    page.querySelector('[data-job-act="back"]').click();
    assert.equal(resumed, 'old', 'back is the chat the job belongs to: there is no list (2026-10-06)');
    assert.equal(page.querySelectorAll('[data-job]').length, 0);
    // The chat's row on Chats carries its job's status.
    assert.equal(s.jobOfChat('old').id, 'j1');
    s.renderHistory();
    const oldRow = w.document.querySelector('#conversations-view [data-simple="chat"][data-id="old"]');
    assert.ok(oldRow, 'the chat is listed');
    assert.equal(oldRow.querySelector('.simple-row-meta').textContent, 'Working', 'a live job speaks on its chat\u2019s row');
    w.TeamJobs.all = listJobs;
    w.AppManager.currentApp = null;
    s._jobOpen = null;
}
// TODAY: today's timed events still ahead, in order, from connected
// calendars only; locked calendar and tasks contribute nothing.
locks = new Set();
const now = new Date('2026-09-18T10:00:00');
w.CalendarApp = { loadData() {}, getAccounts: () => [{ email: 'test' }], events: [
    { summary: 'Soon', account: 'test', start: new Date('2026-09-18T10:20:00'), end: new Date('2026-09-18T11:00:00') },
    { summary: 'Past', account: 'test', start: new Date('2026-09-18T09:00:00'), end: new Date('2026-09-18T09:30:00') },
    { summary: 'Other account', account: 'removed', start: new Date('2026-09-18T10:10:00') }
] };
assert.equal(s.todayItems(now)[0].title, 'Soon');
assert.equal(s.todayItems(now).some(t => t.title === 'Past' || t.title === 'Other account'), false);
// A meeting opens in the calendar it came from (2026-10-01): Google's
// event page, or Calendar.app for an Apple one; a task is not a link.
w.CalendarApp.events.push(
    { summary: 'Google one', account: 'test', htmlLink: 'https://calendar.google.com/event?eid=x', start: new Date('2026-09-18T11:00:00'), end: new Date('2026-09-18T11:30:00') },
    { summary: 'Apple one', source: 'apple', appleEventId: 'ABC-123:DEF', start: new Date('2026-09-18T12:00:00'), end: new Date('2026-09-18T12:30:00') }
);
let externalUrl = null, appleId = null;
w.AppManager.openExternal = url => { externalUrl = url; };
w.electronAuth = { openAppleCalendarEvent: id => { appleId = id; } };
fakeItems[1].when = { date: s._iso(now) };   // "today" in this section is its fixed date
let todayRows = s.todayItems(now);
const gi = todayRows.findIndex(t => t.title === 'Google one');
const ai = todayRows.findIndex(t => t.title === 'Apple one');
s.openScheduleRow(todayRows[gi]);
assert.equal(externalUrl, 'https://calendar.google.com/event?eid=x');
s.openScheduleRow(todayRows[ai]);
assert.equal(appleId, 'ABC-123:DEF');
// A task's title opens the task's thread (2026-10-02), never a calendar.
assert.equal(todayRows.find(t => t.title === 'Today task').open.task, 'today', 'a task opens its thread');
// An event with a folder opens the folder's page (2026-10-07); the calendar
// is a row there. The same rule on Coming up.
{
    w.CalendarApp.events.push({ id: 'ev-folder', summary: 'Dentist', account: 'test', htmlLink: 'https://calendar.google.com/event?eid=y', start: new Date('2026-09-18T13:00:00'), end: new Date('2026-09-18T13:30:00') },
        { id: 'ev-later', summary: 'Dentist again', account: 'test', htmlLink: 'https://calendar.google.com/event?eid=z', start: new Date('2026-09-20T13:00:00'), end: new Date('2026-09-20T13:30:00') });
    const hadMatters = w.Matters;
    w.Matters = { forCalendarEvent: id => (id === 'ev-folder' || id === 'ev-later') ? { id: 'matter:dentist', title: 'Dentist', kind: 'appointment', state: 'open', sources: [] } : null,
        upcoming: () => [], titleOf: m => m.title, messagesOf: () => [], stepText: () => '', openStep: () => null, openDraft: () => null, actionLabel: () => '', _hm: () => null };
    let pageOpened = null;
    w.MatterPage = { open: id => { pageOpened = id; return true; } };
    externalUrl = null;
    todayRows = s.todayItems(now);
    const di = todayRows.findIndex(t => t.title === 'Dentist');
    assert.equal(todayRows[di].open.matter, 'matter:dentist', 'an event with a folder opens the folder');
    assert.equal(todayRows[di].open.url, undefined);
    // A folder's row opens its THREAD when Threads is loaded, else the folder's page.
    s.openScheduleRow(todayRows[di]);
    assert.equal(pageOpened, 'matter:dentist');
    assert.equal(externalUrl, null, 'the calendar is not opened from the title');
    assert.equal(todayRows[gi].open.url, 'https://calendar.google.com/event?eid=x', 'an event with no folder still opens in its calendar');
    const later = s.comingUp(now).flatMap(d => d.rows).find(r => r.title === 'Dentist again');
    assert.ok(later, 'the later event is on Coming up');
    assert.equal(later.open.matter, 'matter:dentist', 'Coming up follows the same rule');
    // Coming up is the next thing plus a week strip (2026-10-07): code-joined
    // from comingUp's facts, a day per slot with its count; nothing model-written.
    {
        const day = (date, rows) => ({ date, label: date, rows });
        const n = new Date('2026-09-16T09:00:00');
        const week = s.comingWeek([
            day('2026-09-17', [{ title: 'Dentist', time: '9:00 AM', kind: 'event', open: {} }, { title: 'Call the bank', time: '', kind: 'task', open: {} }]),
            day('2026-09-19', [{ title: 'Standup', time: '10:00 AM', kind: 'event' }, { title: 'Pay rent', time: '', kind: 'task' }, { title: 'Taxes', time: '', kind: 'task' }])
        ], n);
        assert.equal(week.days.length, 7, 'always seven days');
        assert.equal(week.days.map(d => d.count).join(','), '2,0,3,0,0,0,0');
        assert.equal(week.days[2].first, 2, 'a day points into the flat list');
        assert.equal(week.total, 5);
        assert.equal(JSON.stringify(week.next), JSON.stringify({ index: 0, title: 'Dentist', when: 'Tomorrow · 9:00 AM' }));
        const later = s.comingWeek([day('2026-09-19', [{ title: 'Pay rent', time: '', kind: 'task' }])], n);
        assert.equal(JSON.stringify(later.next), JSON.stringify({ index: 0, title: 'Pay rent', when: 'Saturday' }), 'a later day is named, no time when it has none');
        assert.equal(s.comingWeek([], n).next, null);
        // The same holiday from four calendars is one row (2026-10-07); a door wins; a different time stays.
        const one = s._oneOfEach([{ title: 'Columbus Day', time: '' }, { title: 'Columbus Day', time: '', open: { url: 'x' } }, { title: 'columbus  day', time: '' }, { title: 'Columbus Day', time: '9:00 AM' }]);
        assert.equal(one.length, 2);
        assert.equal(one[0].open.url, 'x', 'the row with a door is the one kept');
    }
    w.CalendarApp.events.splice(-2, 2);
    delete w.MatterPage;
    if (hadMatters) w.Matters = hadMatters; else delete w.Matters;
}
w.CalendarApp.events.splice(-2, 2);
delete w.electronAuth;
// Main's door accepts only an EventKit id and builds the ical:// URL itself.
{
    const src = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
    const handler = src.slice(src.indexOf("ipcMain.handle('open-apple-calendar-event'"), src.indexOf("ipcMain.handle('toggle-dev-tools'"));
    assert.match(handler, /\^\[A-Za-z0-9:_\.\\-\]\+\$/, 'the id is validated');
    assert.match(handler, /ical:\/\/ekevent\/\$\{id\}/);
}
// Exercise the actual chat approval state, not a mock task list.
locks = new Set();
w.eval(fs.readFileSync(path.join(__dirname, '../js/agent/agent-ui.js'), 'utf8') + '\nwindow.realAgentUI = AgentUI;');
w.AgentUI = w.realAgentUI;
const ui = w.AgentUI;
ui.hideThinking = () => {};
ui._describeToolAction = () => 'Read a document';
ui.closeProfilePanel = () => {};
ui.renderAppView = () => ui._paintInlineSlot();
const slot = w.document.createElement('div'); slot.id = 'agent-app-ask';
slot.scrollIntoView = () => {};
w.document.body.appendChild(slot);
w.SimpleExperience = s;
w.AgentService.activeConversationId = 'new';
w.AgentService.loadConversation = id => { w.AgentService.activeConversationId = id; };
w.AppManager.currentApp = null;
ui.offerContinue('new', 'Approve more tool calls?');
assert.equal(s.attention().some(item => item.kind === 'continue'), true);
ui.offerContinue('old', 'Another waiting conversation');
ui.offerContinue('private', 'SECRET continuation');
assert.equal(s.attention().filter(item => item.kind === 'continue').length, 2);
const continuation = s.attention().find(item => item.kind === 'continue' && item.conversationId === 'old');
s.review(continuation.id);
assert.equal(w.AgentService.activeConversationId, 'old');
assert.match(slot.textContent, /Another waiting conversation/);
ui.clearContinueOffer('old');
assert.equal(s.attention().some(item => item.id === continuation.id), false);
assert.equal(s.attention().some(item => item.kind === 'continue' && item.conversationId === 'new'), true);
w.AppManager.currentApp = null;
// Simple mode keeps requests raised off-page in the same live approval queue.
ui.confirmToolCall('fs_read', {}, 'Permission to read the proposal', 'new', { onceOnly: true });
ui.confirmToolCall('fs_read', {}, 'Second permission', 'old');
const permission = s.attention().find(item => item.kind === 'permission' && item.conversationId === 'old');
assert.ok(permission);
s.review(permission.id);
assert.match(slot.textContent, /Second permission/);
assert.equal(slot.querySelectorAll('input[type="radio"]').length, 3);
slot.querySelector('.agent-ask-deny').click();
assert.equal(s.attention().some(item => item.id === permission.id), false);
const once = s.attention().find(item => item.kind === 'permission');
s.review(once.id);
assert.equal(slot.querySelectorAll('input[type="radio"]').length, 1, 'once-only policy stays intact');
slot.querySelector('.agent-ask-allow').click();
assert.equal(s.attention().some(item => item.kind === 'permission'), false);
assert.equal(ui._openToolConfirms.size, 0);
locks = new Set(['agent']);
assert.equal(s.attention().length, 0, 'live chat requests also respect app locks');

// ── From your email (2026-10-01) ──────────────────────────────────────
// A tester connected Gmail and the home never changed. The section says it
// is reading, then shows what it found, and says why when it cannot read.
{
    const DAY = 86400000;
    let prog = { connected: true, loading: false, queued: 0, blocked: null };
    let connectedAt = new Date().toISOString();
    let opened = null;
    w.AccountsManager = { getAll: () => [{ services: { mail: true }, connectedAt }] };
    // The REAL EmailHome (its statusLine is the shared wording), with the
    // data-reading halves stubbed.
    w.Widgets = { register() {}, rows() {}, more() {}, refresh() {} };
    w.eval(fs.readFileSync(path.join(__dirname, '../js/apps/email/email-widget.js'), 'utf8'));
    Object.assign(w.EmailHome, {
        progress: () => prog, loaded: () => true,
        whenLabel: a => a.when || '',
        typeLabel: a => ({ bill: 'Bills' })[a.type] || ''
    });
    w.UIUtils.humanizeIsoDates = t => t;
    w.FyiPage = { openTo: id => { opened = id; }, openSingle: id => { opened = id; } };
    w.EmailApp = {};
    const rows = () => s.nextRows().filter(r => r.kind !== 'ask' && r.kind !== 'task');
    w.EmailApp.gmailUrl = e => e.gmail ? 'https://mail.google.com/x' : null;
    w.EmailApp.openMessageFrom = id => { opened = 'gmail:' + id; };

    // Reading a new mailbox: emailHome says so (nenva's thread draws the words, tests/threads-page-test.js).
    prog = { connected: true, loading: true, queued: 0, blocked: null };
    assert.equal(s.emailHome().loading, true);
    prog = { connected: true, loading: false, queued: 37, blocked: null };
    assert.deepEqual([s.emailHome().reading, s.emailHome().queued], [true, 37]);
    // A queue that cannot move never claims to be reading: it is a card
    // that names the fix.
    prog = { ...prog, blocked: 'model' };
    assert.equal(s.emailHome().blocked, 'model');
    assert.equal(rows()[0].kind, 'fix');
    assert.match(rows()[0].title, /Choose an AI model/);
    assert.equal(rows()[0].action, 'Open Settings');
    // What mail needs of the person is the folder cards (docs/MATTERS.md §17):
    // no per-message row. A folder with a step is a card with the step's
    // own button and Ignore; Not useful sits apart as feedback.
    prog = { connected: true, loading: false, queued: 0, blocked: null };
    let folders = [];
    const folder = (id, title, step) => ({ id: `matter:${id}`, kind: 'bill', state: 'open', title, status: 'Due soon', when: { date: null }, sources: [{ id: `msg-${id}`, kind: 'email', from: 'Sender', at: new Date().toISOString() }], next: { ...step, state: 'open' }, log: [] });
    w.Matters = {
        reconcileSoon() {}, all: () => folders, openMatters: () => folders.filter(m => m.state === 'open' && m.next && m.next.state === 'open'),
        openStep: m => (m.next && m.next.state === 'open' ? { ...m.next, id: 'next', kind: m.next.how } : null),
        card: m => ({ title: m.title, body: m.status, primary: m.next.how === 'none' ? 'Done' : 'Open the link', dismiss: m.next.how === 'none' ? '' : 'Already done' }),
        messagesOf: m => m.sources, checkinFor: () => null, heldBack: () => new Set(), titleOf: m => m.title, whenText: () => '',
        get: id => folders.find(m => m.id === id) || null, aliasesOf: () => [], forSource: id => folders.find(m => m.sources.some(x => x.id === id)) || null,
        upcoming: () => [], ignore: id => { const m = folders.find(x => x.id === id); if (m) m.state = 'ignored'; return {}; }, unignore() {}, markStep() {}, openDraft() {}
    };
    const mail = () => s.cards().filter(c => c.matter).map(c => c.matter).join(',');
    folders = [folder('m1', 'Car registration', { what: 'Renew it', how: 'link', url: 'https://x' }), folder('m2', 'Water bill', { what: 'Pay it', how: 'none', yours: true })];
    s._mailShown = null; s._readMark = null;
    assert.equal(rows().length, 0, 'no per-message rows');
    assert.equal(mail(), 'matter:m1,matter:m2', 'one card per folder');
    const m1 = s.cards().find(c => c.matter === 'matter:m1');
    assert.equal(m1.primary, 'Open the link'); assert.equal(m1.dismiss, 'Already done');
    assert.equal(s.cards().find(c => c.matter === 'matter:m2').dismiss, '', 'a plain step\u2019s one button is Done');
    assert.equal(s.thingKey(m1), 'matter:m1', 'the card\u2019s chat is the folder\u2019s');
    // While the mailbox is being read, what it finds waits (2026-10-05):
    // no card comes or goes mid-read; the held count is what the assistant is told.
    {
        folders = [folder('m3', 'Passport renewal', { what: 'Renew', how: 'none', yours: true })];
        s._mailShown = null; s._readMark = null;
        prog = { connected: true, loading: false, queued: 12, blocked: null };
        assert.equal(mail(), '', 'held while reading');
        assert.equal(s._heldCount, 1, 'one thing held so far');
        prog = { ...prog, queued: 0 };
        assert.equal(mail(), 'matter:m3', 'shown once the read is done');
        // A card already shown stays through a later read; a new one waits.
        folders = [...folders, folder('m4', 'Gym renewal', { what: 'Renew', how: 'none', yours: true })];
        prog = { ...prog, queued: 11 };
        assert.equal(mail(), 'matter:m3');
        // ...and through a reload of the window mid-read (2026-10-05).
        s._mailShown = null;
        assert.equal(mail(), 'matter:m3', 'a shown card is not held again after a reload');
        // A queue that stopped moving stops holding.
        s._readMark.at = Date.now() - s.READ_STALL_MS - 1;
        assert.equal(mail(), 'matter:m3,matter:m4');
        folders = []; prog = { ...prog, queued: 0 };
    }
    delete w.Matters;
    // Locked Insights contributes nothing.
    locks = new Set(['fyi']);
    assert.equal(rows().length, 0);
    locks = new Set();
    // Not connected: the offer to connect is the row.
    prog = { connected: false };
    assert.equal(rows()[0].kind, 'connect');
    assert.equal(rows()[0].action, 'Connect');
    // One wording for Home and Insights: a stuck queue never says "reading".
    assert.equal(w.EmailHome.statusLine({ connected: true, queued: 5, blocked: 'model' }).kind, 'blocked');
    assert.equal(w.EmailHome.statusLine({ connected: true, queued: 5, blocked: null }).title, 'Reading your email \u00b7 5 to go');
    assert.equal(w.EmailHome.statusLine({ connected: true, queued: 0, blocked: 'privacy' }), null, 'privacy with nothing queued is not news');
    assert.equal(w.EmailHome.statusLine({ connected: false }), null);
    delete w.EmailHome; delete w.AccountsManager; delete w.FyiPage; delete w.EmailApp; delete w.Widgets;
}

// Widgets (2026-10-06, the simplification): no Widgets page and no nav item.
{
    assert.equal(w.document.querySelector('.nv-items [data-id="widgets"]'), null, 'Widgets is not a nav item');
    assert.equal(w.document.getElementById('widgets-view'), null, 'no Widgets page');
    assert.deepEqual(w.SimpleExperience.navItems().map(x => x[0]).includes('widgets'), false);
}
dom.window.close();
console.log('simple-experience: preference, rendering, routine results and asks, private chats, locks and resume passed');

// A new install is introduced gently (2026-10-11): what nenva offers unasked
// is held to one a day for the first week, none on the setup day.
{
    const SE = w.subject;
    const DAY = 86400000;
    const since = new Date(2026, 9, 11, 10, 0).getTime();
    const cards = [
        { key: 'approval:1', kind: 'approval', rank: 5 },
        { key: 'task:a', kind: 'decide', rank: 20 },
        { key: 'coach:intro:fitness', kind: 'offer', rank: 55, intro: true },
        { key: 'checkin:S1', kind: 'checkin', rank: 52 },
        { key: 'plan:t1', kind: 'offer', rank: 22 },
        { key: 'coach:goal:g', kind: 'checkin', rank: 40, concern: true }
    ];
    const keys = r => r.cards.map(c => c.key);
    assert.deepEqual(keys(SE.gentle(cards, { since }, since + 3600000)), ['approval:1', 'task:a', 'coach:goal:g'], 'setup day: nothing offered unasked; what needs them and a concern stay');
    const d2 = SE.gentle(cards, { since }, since + DAY);
    assert.deepEqual(keys(d2), ['approval:1', 'task:a', 'plan:t1', 'coach:goal:g'], 'the next day: one suggestion, the most pressing');
    assert.equal(d2.st.key, 'plan:t1');
    const answered = cards.filter(c => c.key !== 'plan:t1');
    assert.deepEqual(keys(SE.gentle(answered, d2.st, since + DAY + 60000)), ['approval:1', 'task:a', 'coach:goal:g'], 'answering it brings no other that day');
    assert.deepEqual(keys(SE.gentle(answered, d2.st, since + 2 * DAY)), ['approval:1', 'task:a', 'checkin:S1', 'coach:goal:g'], 'the day after, the next one');
    assert.equal(SE.gentle(cards, { since }, since + 8 * DAY).cards.length, cards.length, 'after the first week every source keeps only its own budget');
    assert.equal(SE.gentle(cards, { since: 0 }, since).cards.length, cards.length, 'a Mac set up before this never counts as new');
    console.log('simple-experience: a new install is introduced gently passed');
}

// A folder's step due today is on Today, and one due tomorrow on Coming up
// (2026-10-11: mail makes folders, not tasks; the step stands for the day).
{
    const hadM = w.Matters, hadTH = w.TodayHelp;
    const day = s._iso(new Date()), tomorrow = s._iso(new Date(Date.now() + 86400000));
    w.TodayHelp = undefined;
    w.Matters = { forAmbient: () => [{ id: 'matter:b', state: 'open', kind: 'bill', title: 'Water bill' }, { id: 'matter:c', state: 'open', kind: 'bill', title: 'Power bill' }],
        openStep: m => (m.id === 'matter:b' ? { what: 'Pay $84', by: day } : { what: 'Pay', by: tomorrow }),
        titleOf: m => m.title, upcoming: () => [], forCalendarEvent: () => null, _hm: () => null };
    const today = s.todayItems(new Date());
    assert.ok(today.some(r => r.title === 'Water bill' && r.open.matter === 'matter:b'), 'the bill due today is on Today');
    assert.ok(!today.some(r => r.title === 'Power bill'), 'tomorrow’s is not');
    assert.ok(s.comingUp(new Date()).some(d => d.date === tomorrow && d.rows.some(r => r.title === 'Power bill' && r.open.matter === 'matter:c')), 'and it is on Coming up');
    if (hadM) w.Matters = hadM; else delete w.Matters;
    w.TodayHelp = hadTH;
    console.log('simple-experience: a folder’s dated step stands for its day passed');
}
