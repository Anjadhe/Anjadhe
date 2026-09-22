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
    currentApp: null, sensitiveUnlocked: false, apps: { email: {}, calendar: {}, actions: {}, portfolio: {}, prompts: {} },
    register(name, app) { this.apps[name] = app; },
    isAppLocked: app => locks.has(app),
    journalNudgeDue: () => journalDue,
    openApp(app) { if (!locks.has(app)) this.currentApp = app; }
};
w.UIUtils = { escapeHtml: s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') };
w.AgentService = {
    conversations,
    getConversationList: () => PrivateChat.persistable(conversations).map(c => ({ ...c, messageCount: c.messages.length })),
    isConversationStreaming: () => false,
    loadConversation: id => { resumed = id; }
};
w.AgentUI = { closeProfilePanel() {}, renderAppView() { rendered++; }, formatTimeAgo: () => 'today' };
w.TaskService = { list: () => [
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
assert.equal(w.document.querySelectorAll('.simple-nav').length, 1, 'initialization is idempotent');
assert.equal(w.document.querySelector('#updates-view #dash-widgets') !== null, true);
assert.equal(w.document.querySelector('#updates-view .dash-agent-hero'), null, 'updates excludes the composer');
assert.equal(w.document.querySelector('#dashboard-view #dash-widgets'), null, 'widgets move, never duplicate');
w.document.querySelector('[data-simple="updates"]').click();
assert.equal(w.AppManager.currentApp, 'updates');
assert.deepEqual(Array.from(s.conversations(), c => c.id), ['new', 'old']);
s.render();
assert.equal(groupedOptions.applySearch, false, 'home ignores task search');
assert.equal(groupedOptions.applySidebarFilter, false, 'home ignores task sidebar filters');
assert.equal(w.document.querySelectorAll('.simple-app-shortcuts button').length, 5);
assert.equal(w.document.querySelector('.simple-app-shortcuts .is-nudge'), null, 'no nudge until journalling is overdue');
// "Log journal" leads the pills when the classic home would have nudged.
// The RULE is AppManager's; the shell only asks.
journalDue = true;
s.render();
const nudgePill = w.document.querySelector('.simple-app-shortcuts button');
assert.ok(nudgePill.classList.contains('is-nudge'), 'the nudge leads the row');
assert.match(nudgePill.textContent, /Log journal/);
assert.equal(w.document.querySelectorAll('.simple-app-shortcuts button').length, 6, 'added to the row, not replacing a shortcut');
// When Journal IS one of the shortcuts, its own pill steps aside: two
// pills to the same place, one of them asking, would read as a bug.
w.AppManager.apps.journal = {};
w.GlobalSearch = { allApps: () => [{ id: 'journal', title: 'Journal' }, { id: 'email' }, { id: 'calendar' }, { id: 'actions' }, { id: 'portfolio' }, { id: 'prompts' }] };
w.AppManager.getFrequentApps = () => ['journal'];   // most-used, so it earns a pill
s.render();
assert.equal(w.document.querySelectorAll('[data-simple="launch"][data-id="journal"]').length, 0, 'no second door to Journal while the nudge is up');
journalDue = false;
s.render();
assert.equal(w.document.querySelectorAll('[data-simple="launch"][data-id="journal"]').length, 1, 'and it comes back when the nudge goes');
journalDue = true;
delete w.GlobalSearch;
delete w.AppManager.getFrequentApps;
// apps.journal stays: the real predicate refuses without it, and so does
// the door — a nudge can never name an uninstalled package.
s.render();
// Re-query: every render rewrites the row, and the captured node is stale.
w.document.querySelector('.simple-app-shortcuts .is-nudge').click();
assert.equal(w.AppManager.currentApp, 'journal');
w.AppManager.currentApp = null;
// A locked Journal still gets the nudge: the classic home's strip does not
// check either, the row already lists locked apps as ordinary shortcuts, and
// the pill carries no content — openApp puts the unlock overlay in the way.
locks = new Set(['journal']);
s.render();
assert.ok(w.document.querySelector('.simple-app-shortcuts .is-nudge'), 'a locked Journal is still nudged, like every other surface');
w.AppManager.currentApp = null;
w.document.querySelector('.simple-app-shortcuts .is-nudge').click();
assert.equal(w.AppManager.currentApp, null, 'and the lock, not the pill, is what refuses the door');
locks = new Set();
journalDue = false;
s.render();
assert.equal(w.document.querySelector('#updates-view .simple-app-shortcuts'), null);
w.document.querySelector('[data-simple="launch"][data-id="portfolio"]').click();
assert.equal(w.AppManager.currentApp, 'portfolio');
assert.match(w.document.getElementById('simple-home-sections').textContent, /1 overdue task/);
assert.equal(s.attention().length, 1, 'only a request for user judgment needs attention');
assert.equal(w.document.querySelectorAll('.simple-attention-message').length, 1);
assert.match(w.document.querySelector('.simple-attention-message').textContent, /plan ready/);
assert.equal(w.document.querySelectorAll('[data-simple="task"]').length, 0);
assert.match(w.document.querySelector('.simple-working').textContent, /Working task/);
w.document.querySelector('[data-simple="later"]').click();
assert.ok(s.deferredUntil(s.attention()[0]) > Date.now());
assert.match(w.document.querySelector('.simple-attention-message').textContent, /Shows again at/);
assert.equal(s.deferredUntil(s.attention()[0], Date.now() + 3600001), 0, 'timer expires without changing work');
const original = s.attention()[0];
assert.equal(s.deferredUntil({ ...original, revision: 'new request' }), 0, 'changed request resurfaces');
assert.equal(w.localStorage.getItem('simple-attention-later').includes('Approve plan'), false, 'reminder stores no message content');
w.document.querySelector('[data-simple="restore"]').click();
assert.equal(s.deferredUntil(s.attention()[0]), 0);
w.document.querySelector('[data-simple="review"]').click();
assert.equal(resumed, 'new', 'attention opens its conversation, never a task editor');
rendered = 0;
const listWork = w.TaskService.list;
w.TaskService.list = () => Array.from({ length: 5 }, (_, i) => ({ id: 'request-' + i, conversationId: 'new', status: 'awaiting_user', goal: 'Request ' + i }));
s.render();
assert.equal(w.document.querySelectorAll('.simple-attention-message').length, 3);
w.document.querySelector('[data-simple="attention"]').click();
assert.equal(w.document.querySelectorAll('.simple-attention-message').length, 5);
w.TaskService.list = listWork;
s._allAttention = false;
s.render();
assert.equal(s.workMessage({ status: 'awaiting_user', plan: [] }).includes('plan ready'), false, 'never claim a missing plan exists');
assert.equal(w.document.querySelector('#simple-home-sections img'), null, 'titles are text, never markup');
assert.equal(w.document.getElementById('simple-home-sections').textContent.includes('SECRET'), false);
assert.equal(w.document.getElementById('simple-home-sections').textContent.includes('Finished task'), false);
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
    { id: 'pub', published: true, promptTitle: 'From Anjadhe', createdAt: '2026-09-20T08:00:00Z' }
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
assert.equal(updates.some(u => u.title === 'From Anjadhe'), false, 'an announcement is not something a routine did');
assert.equal(updates[0].summary, 'Summary of p1', 'the summary is PromptFeed\u2019s, never the shell\u2019s');
s.render();
const routineSection = w.document.querySelector('.simple-routines');
assert.ok(routineSection, 'the section renders when a routine has posted');
assert.match(routineSection.textContent, /Morning News/);
assert.equal(routineSection.querySelector('img'), null, 'routine titles are text, never markup');
routineSection.querySelector('[data-simple="post"]').click();
assert.equal(openedPost.id, 'p1', 'the row opens the newest edition');
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
w.TaskService.list = () => [{ id: 'ask', routineId: 'r2', status: 'awaiting_user', note: 'Which account should I use?' }];
const ask = s.attention().find(item => item.kind === 'routine');
assert.ok(ask, 'an ambient routine ask is not hidden by the conversation scope');
assert.equal(ask.title, 'Market Review', 'the row names the routine, not the task id');
assert.match(ask.message, /Which account/);
s.render();
assert.match(w.document.querySelector('.simple-attention-message').textContent, /Open the routine/);
s.review(ask.id);
assert.equal(w.AppManager.currentApp, 'prompts');
assert.equal(openedRoutine.id, 'r2', 'on the routine the run belongs to');
locks = new Set(['prompts']);
assert.equal(s.attention().some(item => item.kind === 'routine'), false, 'a locked Routines app asks nothing');
locks = new Set();
w.TaskService.list = listWork;
w.AppManager.currentApp = null;
s.render();

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
assert.equal(s.attention().some(r => r.action === 'task'), false);
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
w.AppManager.getFrequentApps = () => ['prompts', 'calendar', 'prompts', 'missing'];
assert.deepEqual(Array.from(s.shortcuts(), app => app.id).slice(0, 2), ['prompts', 'calendar']);
assert.equal(new Set(s.shortcuts().map(app => app.id)).size, s.shortcuts().length);
w.AppManager.getHiddenApps = () => new Set(['calendar']);
assert.equal(s.shortcuts().some(app => app.id === 'calendar'), false);
w.AppManager.getHiddenApps = () => new Set();
// Upcoming and ongoing meetings are visible independently of AI approvals.
locks = new Set();
const now = new Date('2026-09-18T10:00:00');
w.CalendarApp = { loadData() {}, getAccounts: () => [{ email: 'test' }], events: [
    { summary: 'Soon', account: 'test', start: new Date('2026-09-18T10:20:00'), end: new Date('2026-09-18T11:00:00') },
    { summary: 'Past', account: 'test', start: new Date('2026-09-18T09:00:00'), end: new Date('2026-09-18T09:30:00') },
    { summary: 'Other account', account: 'removed', start: new Date('2026-09-18T10:10:00') }
] };
assert.equal(s.dayAhead(now)[0].title, 'Soon');
assert.equal(s.dayAhead(now)[0].meta, 'In 20 min');
locks = new Set(['calendar', 'actions']);
assert.equal(s.dayAhead(now).length, 0, 'locked calendar and tasks reveal no details or counts');
delete w.AppManager.apps.portfolio;
assert.equal(s.shortcuts().some(app => app.id === 'portfolio'), false, 'uninstalled app has no broken shortcut');
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
dom.window.close();
console.log('simple-experience: preference, rendering, routine results and asks, private chats, locks and resume passed');
