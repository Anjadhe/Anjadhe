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
let workroomsFlag = false;
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
w.FEATURES = { isEnabled: name => name === 'workrooms' && workroomsFlag };
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
w.eval(source + '\nwindow.subject = SimpleExperience;');
const s = w.subject;
const before = w.document.body.innerHTML;
// The default shell since 2026-09-20: absent means on, and only an explicit
// 'off' restores the full one — a default experience has to be one you can
// leave, which is why this is a preference and not a feature flag.
assert.equal(s.isOn(), true, 'no stored preference means the simple shell');
w.localStorage.setItem(s.PREF_KEY, 'off');
assert.equal(s.isOn(), false, 'turned off is honoured');
s.init();
assert.equal(w.document.body.innerHTML, before, 'turned off does not change the DOM');
s.setOn(true);
assert.equal(w.localStorage.getItem(s.PREF_KEY), null, 'on is the absence of the key');
s.init(); s.init();
assert.equal(w.document.querySelectorAll('.nv-nav').length, 1, 'initialization is idempotent');
// The nenva shell's left nav (2026-10-01): Now · Chats · Jobs · Settings.
assert.equal(Array.from(w.document.querySelectorAll('.nv-items button'), b => b.textContent).join(','), 'Now,Chats,Jobs,Routines,Widgets,Settings');
assert.equal(s.navKey(null), 'now');
assert.equal(s.navKey('agent'), 'chats', 'Chats stays lit inside a chat');
assert.equal(s.navKey('prompts'), 'routines', 'Routines are a nav item (2026-10-01)');
assert.equal(s.navKey('fyi'), 'now', 'an insight is reached from Now');
w.document.querySelector('.nv-items [data-id="jobs"]').click();
assert.equal(w.AppManager.currentApp, 'jobs');
s.onNavigate('jobs');
assert.equal(w.document.querySelector('.nv-items .is-on').dataset.id, 'jobs');
w.AppManager.currentApp = null;
assert.equal(w.document.querySelector('#updates-view #dash-widgets') !== null, true);
assert.equal(w.document.querySelector('#updates-view .dash-agent-hero'), null, 'updates excludes the composer');
assert.equal(w.document.querySelector('#dashboard-view #dash-widgets'), null, 'widgets move, never duplicate');
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
// Later hides a card on this Mac; it never touches the record.
s.cardAct('task:due', 'later');
assert.equal(s.cards().some(c => c.key === 'task:due'), false, 'Later hides it');
assert.equal(s.allCards().some(c => c.key === 'task:due'), true, 'the record is untouched');
w.localStorage.removeItem('now-cards');
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
locks = new Set(['prompts']);
assert.equal(s.routineUpdates().length, 0, 'a locked Routines app contributes no results');
locks = new Set(['notes']);
assert.equal(s.routineUpdates().length, 0, 'and neither do locked Notes, where the posts live');
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
    page.querySelector('[data-job-act="back"]').click();
    assert.equal(page.querySelectorAll('[data-job]').length, 1, 'back to the list');
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
    let unread = [];
    let connectedAt = new Date().toISOString();
    let opened = null;
    const read = [];
    w.AccountsManager = { getAll: () => [{ services: { mail: true }, connectedAt }] };
    // The REAL EmailHome (its statusLine is the shared wording), with the
    // data-reading halves stubbed.
    w.Widgets = { register() {}, rows() {}, more() {}, refresh() {} };
    w.eval(fs.readFileSync(path.join(__dirname, '../js/apps/email/email-widget.js'), 'utf8'));
    Object.assign(w.EmailHome, {
        progress: () => prog, loaded: () => true, unreadInsights: () => unread,
        whenLabel: a => a.when || '',
        typeLabel: a => ({ bill: 'Bills' })[a.type] || ''
    });
    w.UIUtils.humanizeIsoDates = t => t;
    w.FyiPage = { openTo: id => { opened = id; }, openSingle: id => { opened = id; } };
    w.EmailApp = { markAnalysisRead: id => read.push(id) };
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
    // Insights are NEXT rows: the summary, the reason, one action.
    prog = { connected: true, loading: false, queued: 0, blocked: null };
    unread = [
        { id: 'm1', a: { summary: '<b>Car registration</b> expires', actionRequired: true, when: 'in 3 days' }, email: { gmail: true } },
        { id: 'm2', a: { summary: 'Water bill', type: 'bill', amount: '$41.00' }, email: {} }
    ];
    s.render();
    assert.equal(rows().map(r => r.id).join(','), 'm1,m2');
    assert.equal(rows()[0].action, 'Done', 'Gmail is on the insight\u2019s own page, not the card (2026-10-02)');
    assert.equal(rows()[0].urgent, true);
    assert.equal(rows()[1].detail, '$41.00 · Bills');
    assert.equal(rows()[1].action, 'Done');
    assert.equal(w.document.querySelector('.nv-card b, .nv-card-more b'), null, 'summaries are escaped');
    s.nextAct('insight:m1', false);
    assert.equal(opened, 'm1', 'the title opens the insight');
    s.nextAct('insight:m1', true);
    s.nextAct('insight:m2', true);
    assert.deepEqual([...read], ['m1', 'm2'], 'the pill marks it done');
    // Locked Insights contributes nothing.
    locks = new Set(['fyi']);
    assert.equal(rows().length, 0);
    locks = new Set();
    // Not connected: the offer to connect is the row.
    prog = { connected: false };
    unread = [];
    assert.equal(rows()[0].kind, 'connect');
    assert.equal(rows()[0].action, 'Connect');
    // One wording for Home and Insights: a stuck queue never says "reading".
    assert.equal(w.EmailHome.statusLine({ connected: true, queued: 5, blocked: 'model' }).kind, 'blocked');
    assert.equal(w.EmailHome.statusLine({ connected: true, queued: 5, blocked: null }).title, 'Reading your email \u00b7 5 to go');
    assert.equal(w.EmailHome.statusLine({ connected: true, queued: 0, blocked: 'privacy' }), null, 'privacy with nothing queued is not news');
    assert.equal(w.EmailHome.statusLine({ connected: false }), null);
    delete w.EmailHome; delete w.AccountsManager; delete w.FyiPage; delete w.EmailApp; delete w.Widgets;
}

// ── Widgets (2026-10-01): a nav item, not a row on Now ────────────────
// None by default (the page opens on the switches); the chosen ones show
// live on the page, only the chosen ones, minus a locked app's.
{
    const painted = [];
    w.Widgets = {
        list: () => [
            { id: 'actions-overdue', title: 'Overdue', app: 'actions', description: 'Tasks past their date' },
            { id: 'portfolio', title: 'Portfolio', app: 'portfolio' },
            { id: 'spending', title: 'Spending', app: 'spending' }
        ],
        render: async (host, opts) => { painted.push(opts.only.join(',')); host.innerHTML = '<section class="widget-card"></section>'; return 1; }
    };
    locks = new Set();
    w.localStorage.removeItem(s.WIDGETS_KEY);
    s.render();
    assert.equal(w.document.querySelector('#dashboard-view .simple-widgets'), null, 'no widgets on Now');
    assert.ok(w.document.querySelector('.nv-items [data-id="widgets"]'), 'Widgets is a nav item');
    s.go('widgets');
    assert.equal(w.AppManager.currentApp, 'widgets');
    const page = w.document.getElementById('widgets-view');
    assert.equal(page.querySelector('.simple-widget-list').hidden, false, 'nothing chosen: the page opens on the switches');
    assert.equal(painted.length, 0);
    const boxes = page.querySelectorAll('[data-widget-pick]');
    assert.equal(boxes.length, 3);
    for (const i of [0, 2]) {   // re-query: each switch redraws the list
        const box = page.querySelectorAll('[data-widget-pick]')[i];
        box.checked = true; box.dispatchEvent(new w.Event('change', { bubbles: true }));
    }
    page.querySelector('[data-widgets-act="edit"]').click();   // Done
    assert.equal(page.querySelector('.simple-widget-list').hidden, true);
    assert.equal(painted.at(-1), 'actions-overdue,spending', 'only the chosen widgets, in page order');
    locks = new Set(['spending']);
    s.renderWidgetsPage();
    assert.equal(painted.at(-1), 'actions-overdue', 'a locked app’s widget drops out');
    locks = new Set();
    page.querySelector('[data-widgets-act="edit"]').click();   // Edit
    assert.equal(page.querySelector('.simple-widget-list').hidden, false);
    w.localStorage.removeItem(s.WIDGETS_KEY);
    s._widgetsEditing = false;
    w.AppManager.currentApp = null;
    delete w.Widgets;
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
