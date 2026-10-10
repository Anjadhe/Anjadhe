// Shell regression checks: the preference, privacy, lock boundaries and navigation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const PrivateChat = require('../js/agent/private-chat');
const source = fs.readFileSync(path.join(__dirname, '../js/core/simple-experience.js'), 'utf8');
const html = '<body><div id="app-views"></div><header><button id="titlebar-apps-btn"></button><div class="titlebar-actions"></div></header><main id="dashboard-view" class="view"><div class="dashboard-container"><section class="dash-agent-hero"></section><section id="dash-widgets"></section><section class="dash-feed-section"></section></div></main></body>';
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
w.ScheduleApp = {
    loadData() {},
    getGroupedItems(opts) { groupedOptions = opts; return { overdue: [{ id: 'due', title: 'Due task' }], todayActive: [{ id: 'today', title: 'Today task' }] }; }
};
// Raises (docs/NOW.md): a card is a record in a synced store; the test
// keeps it in memory.
const store = {};
w.StorageManager = { get: k => store[k] ? JSON.parse(JSON.stringify(store[k])) : null, set: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
w.eval(fs.readFileSync(path.join(__dirname, '../js/core/raises.js'), 'utf8') + '\nwindow.Raises = Raises;');
w.eval(source + '\nwindow.subject = SimpleExperience;');
const s = w.subject;
// The one shell since 2026-10-05 (the full shell and its switch are gone).
assert.equal(s.isOn(), true, 'the simple shell is always on');
s.init(); s.init();
assert.equal(w.document.querySelectorAll('.nv-nav').length, 1, 'initialization is idempotent');
// The nenva shell's left nav (2026-10-01), Jobs and Widgets folded away 2026-10-06.
assert.equal(Array.from(w.document.querySelectorAll('.nv-items button'), b => b.textContent).join(','), 'Now,Pinned,Chats,Memory,Settings');
assert.equal(s.navKey(null), 'now');
assert.equal(s.navKey('agent'), 'chats', 'Chats stays lit inside a chat');
assert.equal(s.navKey('prompts'), 'chats', 'a routine is a standing chat (2026-10-06): its page keeps Chats lit');
assert.equal(s.navKey('fyi'), 'memory', 'the folders from mail are Memory\u2019s (2026-10-07)');
assert.equal(s.navKey('commitments'), 'memory', 'Commitments is a door on Memory');
assert.equal(s.navKey('matter'), 'memory');
assert.equal(w.document.querySelector('.nv-items [data-id="jobs"]'), null, 'Jobs is not a nav item (folded into Chats, 2026-10-06)');
s.onNavigate('jobs');
assert.equal(w.document.querySelector('.nv-items .is-on').dataset.id, 'chats', 'a job view keeps Chats lit');
w.AppManager.currentApp = null;
assert.equal(w.document.querySelector('#updates-view'), null, 'the Updates page is gone (2026-10-09)');
assert.equal(w.document.querySelector('#dash-widgets'), null, 'the old home content is dropped, not shown on Now');
assert.notEqual(w.document.querySelector('.dash-agent-hero'), null, 'Now keeps its composer');
assert.deepEqual(Array.from(s.conversations(), c => c.id), ['new', 'old']);
s.render();
assert.equal(groupedOptions.applySearch, false, 'home ignores task search');
assert.equal(groupedOptions.applySidebarFilter, false, 'home ignores task sidebar filters');
// ── Now as a walk-through (2026-10-01) ────────────────────────────────
// A note, ONE card at a time (kind eyebrow, title, body, one main action,
// Later, Talk it through), "N more" behind it, TODAY, and a presence line.
const home = () => w.document.getElementById('simple-home-sections');
assert.equal(w.document.querySelector('.simple-app-shortcuts'), null, 'no app buttons on Now');
assert.ok(w.document.querySelector('.nv-dock .dash-agent-hero'), 'the composer is docked');
assert.ok(w.document.querySelector('.nv-dock [data-simple="nav"][data-id="chats"]'), 'with a Chats door beside it');
assert.match(w.document.querySelector('.nv-briefing').textContent, /^(Still up\?|Morning\.|Afternoon\.|Evening\.) (One thing needs|2 things need) you\./,
    'the note is a greeting and counts, never prose about prose');
// The data under the cards: the request for judgment first, then the overdue task.
const next = s.nextRows();
assert.equal(next.map(r => r.kind).join(','), 'ask,task');
assert.match(next[0].detail, /plan ready/);
assert.equal(next[1].title, 'Due task');
const firstCards = s.cards();
assert.equal(firstCards[0].kind, 'decide');
assert.equal(firstCards[1].key, 'task:due');
assert.equal(w.document.querySelectorAll('.nv-card').length, 1, 'one card at a time');
assert.equal(w.document.querySelector('.nv-card-eyebrow').textContent.includes('Needs you'), true);
w.document.querySelector('.nv-card-title[data-act="open"]').click();
assert.equal(resumed, 'new', 'a request opens its conversation, never a task editor');
w.AppManager.currentApp = null;
let completed = null;
w.ScheduleApp.toggleComplete = id => { completed = id; };
s.cardAct('task:due', 'primary');
assert.equal(completed, 'due', 'an overdue card’s main action completes the task');
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
const grouped = w.ScheduleApp.getGroupedItems;
w.ScheduleApp.getGroupedItems = (opts) => { groupedOptions = opts; return { overdue: [{ id: 'due', title: 'Due task', scheduledDate: '2026-09-01' }], todayActive: [{ id: 'today', title: 'Today task' }] }; };
const back = s.cards().find(c => c.key === 'task:due');
assert.ok(back, 'back on Now with new facts');
assert.equal(back.reopened.why, w.Raises.REOPEN_LINE);
s._front = 'task:due'; s._homeMarkup = null; s.render();
assert.match(w.document.querySelector('#simple-home-sections').textContent, /New since you set this aside/);
w.ScheduleApp.getGroupedItems = grouped;
w.Raises._data = null; delete store.raises; s._front = null; s._frontIndex = 0; s._deck = null;   // a clean slate for what follows
// Many: one card, four named behind it, the rest counted; a pick brings one forward.
const listWork = w.TeamJobs.all;
w.TeamJobs.all = () => Array.from({ length: 6 }, (_, i) => ({ id: 'request-' + i, conversationId: 'new', status: 'awaiting_user', goal: 'Request ' + i }));
s.render();
assert.equal(w.document.querySelectorAll('.nv-card').length, 1);
assert.equal(w.document.querySelectorAll('.nv-card-pick').length, 4);
assert.match(w.document.querySelector('.nv-card-more').textContent, /6 more:.*and 2 more/s);
w.document.querySelectorAll('.nv-card-pick')[1].click();
assert.equal(w.document.querySelector('.nv-card-title').textContent, 'Request 2', 'a pick comes to the front');
s._front = null;
w.TeamJobs.all = listWork;
s.render();
// A running job is said on the presence line, not as a card.
assert.match(home().querySelector('.nv-presence').textContent, /Working on: Working task/);
// TODAY: today's tasks as one line.
// TODAY is a list: one row per item, a task reads "Anytime".
const todayRows = home().querySelectorAll('.nv-today .nv-today-row');
assert.ok(todayRows.length >= 1);
assert.match(todayRows[todayRows.length - 1].textContent, /Anytime\s*Today task/);
assert.equal(s.workMessage({ status: 'awaiting_user', plan: [] }).includes('plan ready'), false, 'never claim a missing plan exists');
assert.equal(w.document.querySelector('#simple-home-sections img'), null, 'titles are text, never markup');
assert.equal(home().textContent.includes('SECRET'), false);
assert.equal(home().textContent.includes('Finished task'), false, 'an old finished job is not news');
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
assert.equal(w.document.querySelector('.nv-card-more img, .nv-card img'), null, 'routine titles are text, never markup');
s.cardAct(routineCard.key, 'primary');
assert.equal(openedPost.id, 'p1', 'the card opens the newest edition');
assert.equal(openedPost.opts.back, 'Home', 'and names the way back for a shell with no feed');
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
locks = new Set(['schedule']);
assert.equal(s.nextRows().some(r => r.kind === 'task'), false, 'locked tasks contribute no Now rows');
assert.equal(s.todayItems().length, 0, 'nor today’s titles');
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
s._today = s.todayItems(now);
const gi = s._today.findIndex(t => t.title === 'Google one');
const ai = s._today.findIndex(t => t.title === 'Apple one');
s.openToday(gi);
assert.equal(externalUrl, 'https://calendar.google.com/event?eid=x');
s.openToday(ai);
assert.equal(appleId, 'ABC-123:DEF');
// A task's title opens the task in Tasks (2026-10-02), never a calendar.
assert.equal(s._today.find(t => t.title === 'Today task').open.task, 'today', 'a task opens in Tasks');
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
    s._today = s.todayItems(now);
    const di = s._today.findIndex(t => t.title === 'Dentist');
    assert.equal(s._today[di].open.matter, 'matter:dentist', 'an event with a folder opens the folder');
    assert.equal(s._today[di].open.url, undefined);
    s.openToday(di);
    assert.equal(pageOpened, 'matter:dentist');
    assert.equal(externalUrl, null, 'the calendar is not opened from the title');
    assert.equal(s._today[gi].open.url, 'https://calendar.google.com/event?eid=x', 'an event with no folder still opens in its calendar');
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
        // No day open by default; an open day folds on leaving Now.
        s._comingOpen = true;
        s._comingDay = '2026-09-17';
        s.onNavigate('chats');
        assert.equal(s._comingDay, null, 'a day shown is a look, never a state Now carries');
        assert.equal(s._comingOpen, false, 'Coming up folds again on leaving Now (2026-10-08)');
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
locks = new Set(['calendar', 'actions']);
assert.equal(s.todayItems(now).length, 0, 'locked calendar and tasks reveal no details or counts');
locks = new Set();
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
assert.match(w.document.getElementById('simple-home-sections').textContent, /Approve more tool calls/);
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
    const lede = () => w.document.querySelector('.nv-lede-line').textContent;
    const rows = () => s.nextRows().filter(r => r.kind !== 'ask' && r.kind !== 'task');
    w.EmailApp.gmailUrl = e => e.gmail ? 'https://mail.google.com/x' : null;
    w.EmailApp.openMessageFrom = id => { opened = 'gmail:' + id; };

    // Reading a new mailbox: the lede line says so, with the queue's count.
    prog = { connected: true, loading: true, queued: 0, blocked: null };
    s.render();
    assert.match(lede(), /Getting your recent email/);
    prog = { connected: true, loading: false, queued: 37, blocked: null };
    s.render();
    assert.match(lede(), /Reading your email · 37 to go/);
    // A queue that cannot move never claims to be reading: it is a NEXT
    // row that names the fix.
    prog = { ...prog, blocked: 'model' };
    s.render();
    assert.doesNotMatch(lede(), /to go/);
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
    const mail = () => s.deckCards().filter(c => c.matter).map(c => c.matter).join(',');
    folders = [folder('m1', 'Car registration', { what: 'Renew it', how: 'link', url: 'https://x' }), folder('m2', 'Water bill', { what: 'Pay it', how: 'none', yours: true })];
    s._deck = null; s._mailShown = null; s._readMark = null;
    s.render();
    assert.equal(rows().length, 0, 'no per-message rows');
    assert.equal(mail(), 'matter:m1,matter:m2', 'one card per folder');
    const m1 = s.deckCards().find(c => c.matter === 'matter:m1');
    assert.equal(m1.primary, 'Open the link'); assert.equal(m1.dismiss, 'Already done');
    assert.equal(s.deckCards().find(c => c.matter === 'matter:m2').dismiss, '', 'a plain step\u2019s one button is Done');
    assert.equal(s.thingKey(m1), 'matter:m1', 'the card\u2019s chat is the folder\u2019s');
    // While the mailbox is being read, what it finds waits (2026-10-05):
    // no card comes or goes mid-read, the note counts them, the lede turns.
    {
        folders = [folder('m3', 'Passport renewal', { what: 'Renew', how: 'none', yours: true })];
        s._deck = null; s._mailShown = null; s._readMark = null;
        prog = { connected: true, loading: false, queued: 12, blocked: null };
        s.render();
        assert.equal(mail(), '', 'held while reading');
        assert.ok(w.document.querySelector('.nv-lede-line .nv-lede-busy'), 'the status shows it is moving');
        assert.match(w.document.querySelector('.nv-briefing').textContent, /One thing so far; I’ll show it when I’m done\./);
        prog = { ...prog, queued: 0 };
        s.render();
        assert.equal(mail(), 'matter:m3', 'shown once the read is done');
        assert.equal(w.document.querySelector('.nv-lede-busy'), null);
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
        folders = []; prog = { ...prog, queued: 0 }; s._deck = null;
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

// Now's order (AI native 2026-10-02): the assistant's order, approvals always first.
{
    const SE2 = w.SimpleExperience;
    if (SE2 && SE2.applyOrder) {
        const cards = [{ key: 'a', kind: 'checkin' }, { key: 'b', kind: 'decide' }, { key: 'c', kind: 'approval' }, { key: 'd', kind: 'headsup' }];
        const out = SE2.applyOrder(cards, ['d', 'a', 'b']).map(c => c.key).join('');
        if (out !== 'cdab') throw new Error(`applyOrder: got ${out}, want cdab`);
        if (SE2.applyOrder(cards, null).map(c => c.key).join('') !== 'cabd') throw new Error('applyOrder without an answer keeps the rank order, approvals first');
        console.log('simple-experience: Now order passed');
    }
}

// A card's chat sets the card aside (2026-10-03): "let it go" runs the card's
// own button. "just ignore it" on a follow-up used to get "Dropped." with the
// card still there.
{
    const SE3 = w.SimpleExperience;
    assert.equal(SE3.letGoAct({ kind: 'approval' }, true), null, 'an approval waits on the person');
    assert.equal(SE3.letGoAct({ kind: 'offer', row: { kind: 'ask' }, dismiss: 'Not now' }, true), 'dismiss', 'a follow-up ends with its own Not now');
    assert.equal(SE3.letGoAct({ kind: 'decide', matter: 'matter:x' }, true), 'ignore');
    assert.equal(SE3.letGoAct({ kind: 'checkin', checkin: 'c1' }, true), 'stop');
    assert.equal(SE3.letGoAct({ kind: 'decide', row: { kind: 'task' } }, true), 'gotit');
    assert.equal(SE3.letGoAct({ kind: 'decide', matter: 'matter:x' }, false), 'later', 'for now is Show later');
    const acted = [];
    const orig = { all: SE3.allCards, act: SE3.cardAct };
    SE3.allCards = () => [{ key: 'ask:followup:a:m1', kind: 'offer', title: 'Follow up with Ashwin?', dismiss: 'Not now', row: { kind: 'ask', id: 'followup:a:m1' } }];
    SE3.cardAct = (key, act) => acted.push(`${key}|${act}`);
    assert.equal(JSON.stringify(SE3.letGoFromChat('ask:followup:a:m1', true)), JSON.stringify({ done: true, title: 'Follow up with Ashwin?', how: 'for good' }));
    assert.equal(acted.join(), 'ask:followup:a:m1|dismiss');
    assert.ok(SE3.letGoFromChat(null, true).error, 'a chat with no card');
    assert.ok(SE3.letGoFromChat('task:gone', true).note, 'a card already gone');
    SE3.allCards = orig.all; SE3.cardAct = orig.act;
    console.log('simple-experience: a card\'s chat sets its card aside passed');
}

// Where a thing stands (2026-10-07): the card carries one vetted line after
// its chat, never the transcript (the earlier messages made the card noisy).
{
    const SE4 = w.SimpleExperience;
    const known = 'Title: Pay the water bill\nCard: $142.50 due Oct 10.\nFacts: {"id":"m1"}\nThem: I will pay it Friday\nYou: Noted, Friday it is.';
    assert.equal(SE4.vetStanding({ line: 'You plan to pay the $142.50 bill on Friday; nothing is due from you before then.' }, known), 'You plan to pay the $142.50 bill on Friday; nothing is due from you before then.');
    assert.equal(SE4.vetStanding({ line: '' }, known), '', 'an empty line means the card already says it all');
    assert.equal(SE4.vetStanding({ line: 'Pay $150 by Friday.' }, known), null, 'a number the facts and the chat lack is refused');
    assert.equal(SE4.vetStanding({ line: 'Did you pay it yet?' }, known), null, 'a question is not a status');
    assert.equal(SE4.vetStanding({ line: 'One. Two. Three sentences here.' }, known), null, 'two sentences at most');
    assert.equal(SE4.vetStanding({ line: 'x'.repeat(201) }, known), null, 'over the cap');
    assert.equal(SE4.vetStanding({ line: 42 }, known), null);
    assert.equal(SE4.vetStanding(null, known), null);
    assert.equal(SE4.vetStanding({ line: '**Paid** on _Friday_' }, known), 'Paid on Friday', 'markdown is stripped');

    // The fallback is what the record kept of the chat, in their words.
    w.Commitments = { _inited: true, get: id => id === 't1' ? { id: 't1', log: { '2026-10-05': [{ quote: 'did it at lunch' }], '2026-10-06': [{ quote: 'this evening', plan: true }] } } : null };
    assert.equal(SE4.standingFallback({ commitment: 't1' }, new Date('2026-10-07T09:00:00')), 'Your plan on Oct 6: “this evening”');
    assert.equal(SE4.standingFallback({ commitment: 't1' }, new Date('2026-10-06T21:00:00')), 'Your plan today: “this evening”');
    assert.equal(SE4.standingFallback({ commitment: 'none' }), '');
    delete w.Commitments;

    // The card's block: the line and the doors, not one message of the chat.
    conversations.push({ id: 'tied', title: 'Water bill', updatedAt: '2026-10-07', todayKey: 'task:t9',
        messages: [{ role: 'user', content: 'SECRET EARLIER LINE' }, { role: 'assistant', content: 'Noted.' }, { role: 'user', content: 'pay it friday' }, { role: 'assistant', content: 'Friday it is.', metadata: { records: [{ action: 'updated', title: 'Water bill' }] } }] });
    const html = SE4.cardStandingHtml({ key: 'task:t9', kind: 'decide', title: 'Water bill', body: 'Due Oct 10.', row: { kind: 'task', id: 't9' } }, w.UIUtils.escapeHtml);
    assert.ok(!html.includes('SECRET EARLIER LINE') && !html.includes('pay it friday') && !html.includes('Friday it is.'), 'no line of the transcript on the card');
    assert.ok(!html.includes('Earlier messages'), 'no unfold button');
    assert.ok(html.includes('Changed: Water bill'), 'the latest change stays');
    assert.ok(html.includes('data-simple="card-open-conv" data-id="tied"'), 'the chat is a door away');
    assert.equal(SE4.cardStandingHtml({ key: 'task:t8', kind: 'decide', title: 'Quiet', row: { kind: 'task', id: 't8' } }, w.UIUtils.escapeHtml), '', 'nothing for a thing nobody talked about');
    conversations.pop();
    console.log('simple-experience: where a thing stands passed');
}

// A repeat's past day with nothing said about it stays on Now until its next day (2026-10-08).
{
    const C = require('../js/core/commitments.js');
    w.Commitments = C;
    const SE = w.SimpleExperience;
    const today = '2026-10-08';   // a Thursday
    const plants = { id: 'p', title: 'Water plants', state: 'open', when: { date: '2026-09-29', time: '18:00' }, repeat: { rule: 'weekly', days: [3] }, history: {} };   // Wednesdays
    const rows = SE.missedRows([plants], today);
    assert.equal(rows.length, 1); assert.equal(rows[0].missedDay, '2026-10-07'); assert.equal(rows[0].detail, 'Not marked yesterday');
    assert.equal(SE.missedRows([{ ...plants, history: { '2026-10-07': 'done' } }], today).length, 0, 'a marked day is answered');
    assert.equal(SE.missedRows([{ ...plants, log: { '2026-10-07': [{ quote: 'did it' }] } }], today).length, 0, 'words about the day answer it too');
    assert.equal(SE.missedRows([{ ...plants, repeat: { rule: 'daily', days: [] } }], today).length, 0, 'a repeat due today: today\'s row stands for it');
    assert.equal(SE.missedRows([{ ...plants, read: { askAfter: true } }], today).length, 0, 'AskAfter asks about those days itself');
    const tue = SE.missedRows([{ ...plants, repeat: { rule: 'weekly', days: [2] } }], today)[0];
    assert.equal(tue.missedDay, '2026-10-06'); assert.ok(/^Not marked Tue/.test(tue.detail), 'an older day is named, still shown until the next one');
    assert.equal(SE.missedRows([{ ...plants, repeat: { rule: 'monthly', days: [] }, when: { date: '2026-09-15' } }], today).length, 0, 'a day more than two weeks back (Sep 15) is let be');
    // No start date: it begins the day it was made (2026-10-09, a Saturday weekly made on Friday was asked about the Saturday before).
    const madeFri = { id: 'k', title: 'Kids logistics block', state: 'open', when: { time: '10:00' }, repeat: { rule: 'weekly', days: [6] }, history: {}, createdAt: new Date(2026, 9, 9, 22, 30).toISOString() };
    assert.equal(SE.missedRows([madeFri], '2026-10-09').length, 0, 'a day before it existed is never asked about');
    assert.equal(C.occursOn(madeFri, '2026-10-10'), true, 'its first day is the next Saturday');
    assert.equal(SE.missedRows([madeFri], '2026-10-12')[0].missedDay, '2026-10-10', 'once that day passes it is asked about');
    delete w.Commitments;
    console.log('simple-experience: a repeat\'s missed day passed');
}

// A card's buttons: one list for Now and the phone (cardActs), and how each
// runs from Telegram, where no page can open (phonePlan, 2026-10-09).
{
    const SE = w.SimpleExperience;
    const labels = (c) => Array.from(SE.cardActs(c), a => `${a.act}=${a.label}`);
    const plan = (c, act) => JSON.parse(JSON.stringify(SE.phonePlan(c, act)));
    assert.deepEqual(labels({ kind: 'headsup', primary: 'Join call' }), ['primary=Join call', 'gotit=Got it', 'later=Show later']);
    assert.deepEqual(labels({ kind: 'checkin', primary: 'Yes', choices: ['Maybe'] }), ['primary=Yes', 'choice:1=Maybe', 'later=Not now', 'stop=Don’t ask about this']);
    assert.deepEqual(labels({ kind: 'approval', primary: 'Review and approve' }), ['primary=Review and approve'], 'an approval cannot be set aside');
    assert.deepEqual(labels({ kind: 'decide', primary: 'Mark done', dismiss: 'Not now' }), ['primary=Mark done', 'dismiss=Not now']);

    assert.equal(SE.phonePlan({ kind: 'headsup' }, 'later').how, 'do', 'a quiet button changes a record and runs as on the Mac');
    assert.deepEqual(plan({ kind: 'headsup', meeting: {}, url: 'https://meet.example/x' }, 'primary'), { how: 'url', url: 'https://meet.example/x' }, 'a call link is a link button');
    assert.equal(SE.phonePlan({ kind: 'offer', work: { kind: 'job', id: 'j' } }, 'primary').how, 'none', 'opening a job needs the Mac');
    assert.equal(SE.phonePlan({ kind: 'offer', pref: 'p' }, 'choice:1').how, 'do', 'a preference answer is a tap');
    assert.deepEqual(plan({ kind: 'offer', coach: 's', talk: 'Help me with my savings.' }, 'primary'), { how: 'ask', text: 'Help me with my savings.' }, 'a coach offer continues in the Telegram chat');
    w.Matters = {
        get: (id) => ({ id }), titleOf: () => 'Water bill',
        openStep: (m) => m.id === 'link' ? { how: 'link', url: 'https://pay.example' } : m.id === 'reply' ? { how: 'reply', reply: 'Paid, thanks' } : { how: 'none' },
        messagesOf: () => [],
    };
    assert.deepEqual(plan({ kind: 'decide', matter: 'link' }, 'primary'), { how: 'url', url: 'https://pay.example' });
    assert.equal(SE.phonePlan({ kind: 'decide', matter: 'reply' }, 'primary').how, 'ask');
    assert.match(SE.phonePlan({ kind: 'decide', matter: 'reply' }, 'primary').text, /Water bill.*Paid, thanks.*only once I approve/);
    assert.equal(SE.phonePlan({ kind: 'decide', matter: 'none' }, 'primary').how, 'do', 'a plain step is marked done');
    delete w.Matters;
    console.log('simple-experience: card buttons on the phone passed');
}

// The note on Now says what is true of the day and the cards (2026-10-09,
// reported: "Nothing needs you right now" with meetings scheduled today).
{
    const SE = w.SimpleExperience;
    const saved = { emailHome: SE.emailHome, busy: SE._busyJobs };
    SE.emailHome = () => null;
    SE._busyJobs = () => [];
    const at = (h, m = 0) => new Date(2026, 9, 9, h, m);
    const now = at(14, 0);
    const meeting = (title, h1, h2) => ({ title, time: at(h1).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), mins: h1 * 60, ev: { start: at(h1), end: at(h2) } });
    const lines = (cards, today) => [...SE.noteParts(cards, now, today).lines];

    assert.deepEqual(lines([], []), ['Nothing needs you, and the rest of today is clear.'], 'an empty day with no cards');
    const later = [meeting('Design review', 15, 16), meeting('1:1 with Sam', 16, 17)];
    assert.deepEqual(lines([], later), [`Next up: Design review at ${later[0].time}, then one more.`, 'Nothing else needs you right now.'], 'meetings later today are named, never "nothing"');
    const inOne = [meeting('Standup', 13, 15), meeting('Design review', 15, 16)];
    assert.match(lines([], inOne)[0], /^You’re in Standup until .*; next is Design review at /, 'a meeting under way');
    const untimed = [{ title: 'Pay the water bill', time: '', mins: Infinity, taskId: 't' }];
    assert.equal(lines([], untimed)[0], 'Still on today: Pay the water bill.', 'an untimed row still counts');
    assert.equal(lines([], [...untimed, { title: 'Offsite', time: '', mins: Infinity, ev: { allDay: true, start: at(0), end: at(23) } }])[0], '2 things are still on today’s list.');
    const cards = [{ kind: 'headsup' }, { kind: 'checkin' }, { kind: 'checkin' }];
    assert.deepEqual(lines(cards, []), ['Below: a heads-up and 2 check-ins.'], 'cards are named by kind');
    assert.ok(!lines(cards, []).some(l => /Nothing/.test(l)), 'never "nothing" with a card');
    assert.deepEqual(lines([{ kind: 'decide' }, { kind: 'offer' }], later).slice(0, 2), ['One thing needs you.', `Next up: Design review at ${later[0].time}, then one more.`]);
    SE.emailHome = saved.emailHome; SE._busyJobs = saved.busy;
    console.log('simple-experience: the note on Now passed');
}
