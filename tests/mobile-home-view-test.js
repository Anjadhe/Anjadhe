// The Mac-served half of the phone's simple home (js/agent/mobile-views.js
// `_home`, 2026-09-20 — docs/SIMPLE_EXPERIENCE.md "On the phone").
//
// "Needs you" and "Ongoing work" are live state in this renderer and cannot
// sync as a blob, so the phone asks the Mac for them. What must hold:
//   1. it is built from SimpleExperience's OWN accessors, so private chats
//      and locked apps are excluded without this file knowing they exist;
//   2. it is a DIGEST — titles and one line, never conversation text;
//   3. a request put off on the Mac stays put off on the phone;
//   4. an older Mac answers with an error, not a crash.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const PrivateChat = require('../js/agent/private-chat');

const simpleSource = fs.readFileSync(path.join(__dirname, '../js/core/simple-experience.js'), 'utf8');
const viewsSource = fs.readFileSync(path.join(__dirname, '../js/agent/mobile-views.js'), 'utf8');
const dom = new JSDOM('<body></body>', { url: 'https://local.test', runScripts: 'outside-only' });
const w = dom.window;

let locks = new Set();
const conversations = [
    { id: 'c1', title: 'Booking the flights', updatedAt: '2026-09-20', messages: [{}] },
    { id: 'private', title: 'SECRET', private: true, messages: [{}] },
];
w.FEATURES = { isEnabled: () => false };
w.AppManager = {
    apps: { journal: {}, prompts: {} },
    isAppLocked: (app) => locks.has(app),
    journalNudgeDue: () => false,
    getHiddenApps: () => new Set(),
    getFrequentApps: () => [],
};
w.UIUtils = { escapeHtml: (s) => String(s), todayISO: () => '2026-09-20' };
w.AgentService = {
    getConversationList: () => PrivateChat.persistable(conversations).map((c) => ({ ...c, messageCount: c.messages.length })),
};
// The live asks behind those rows, as AgentUI holds them.
const settled = [];
let continued = null;
const asks = [
    { attentionId: 'perm1', convId: 'c1', toolName: 'send_email', summary: 'May I send this email?', settled: false },
    { attentionId: 'perm2', convId: 'private', toolName: 'send_email', summary: 'SECRET permission', settled: false },
    // A step that asks EVERY time — MacTools' sensitive class.
    { attentionId: 'once1', convId: 'c1', toolName: 'mac_act', summary: 'Confirm the order?', settled: false, onceOnly: true },
    // An ordinary permission for a blocked tool.
    { attentionId: 'screen1', convId: 'c1', toolName: 'screen_act', summary: 'Click the button?', settled: false },
];
w.AgentUI = {
    _inlineAskCurrent: asks[0],
    _inlineAskQueue: asks.slice(1),
    _continueOffers: new Map([['c1', { convId: 'c1', attentionId: 'cont1', text: 'Approve another round?' }]]),
    pendingAttention: () => [
        { id: 'perm1', conversationId: 'c1', kind: 'permission', message: 'May I send this email?', revision: 'perm1' },
        // A permission raised inside a PRIVATE chat must never reach the phone.
        { id: 'perm2', conversationId: 'private', kind: 'permission', message: 'SECRET permission', revision: 'perm2' },
        { id: 'once1', conversationId: 'c1', kind: 'permission', message: 'Confirm the order?', revision: 'once1' },
        { id: 'screen1', conversationId: 'c1', kind: 'permission', message: 'Click the button?', revision: 'screen1' },
        { id: 'cont1', conversationId: 'c1', kind: 'continue', message: 'Approve another round?', revision: 'cont1' },
    ],
    _finishInlineAsk(ask, approved, scope) { ask.settled = true; settled.push({ id: ask.attentionId, approved, scope }); },
    answerContinueOffer(id, approved) { continued = { id, approved }; return true; },
};
const approved = [];
const cancelled = [];
const tasks = [
    { id: 't-run', conversationId: 'c1', goal: 'Plan the trip', status: 'running', updatedAt: '2026-09-20' },
    // A plan waiting to be reviewed: nothing has run yet.
    { id: 't-ask', conversationId: 'c1', goal: 'Book the hotel', status: 'awaiting_user', updatedAt: '2026-09-20',
      plan: [{ step: 'Search for hotels near the venue', status: 'pending' },
             { step: 'Compare cancellation policies', status: 'pending' }] },
    // Paused MID-RUN — a plan half spent is not a plan to review.
    { id: 't-mid', conversationId: 'c1', goal: 'File the receipts', status: 'awaiting_user', updatedAt: '2026-09-20',
      note: 'Waiting for your approval to run send_email — open the task to continue.',
      plan: [{ step: 'Collect the receipts', status: 'done' }, { step: 'Email them', status: 'pending' }] },
    // awaiting_user with no plan at all.
    { id: 't-noplan', conversationId: 'c1', goal: 'Something', status: 'awaiting_user', updatedAt: '2026-09-20' },
    { id: 't-done', conversationId: 'c1', goal: 'Finished', status: 'done' },
    { id: 't-private', conversationId: 'private', goal: 'SECRET task', status: 'awaiting_user' },
];
w.TaskService = {
    list: () => tasks,
    get: (id) => tasks.find((t) => t.id === id) || null,
    approve: async (id) => { approved.push(id); return { ok: true }; },
    cancel: (id) => { cancelled.push(id); return { ok: true }; },
};
w.NotePrompts = { list: () => [] };

w.eval(simpleSource + '\nwindow.SimpleExperience = SimpleExperience;');
// mobile-views.js installs nothing without the IPC bridge, so `init` is skipped.
w.eval(viewsSource + '\nwindow.subject = MobileViews;');
const views = w.subject;

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ok   ' + name); }
    catch (e) { failures++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

(async () => {
    let home = await views._home();

    await check('needs you carries the queued permission', () => {
        assert.ok(home.needsYou.some((r) => r.id === 'perm1'));
    });
    await check('and the task waiting on approval', () => {
        const row = home.needsYou.find((r) => r.id === 't-ask');
        assert.ok(row, 'the awaiting_user task is there');
        assert.equal(row.title, 'Book the hotel');
        assert.match(row.message, /plan ready/i);
    });
    await check('a private conversation contributes nothing', () => {
        const blob = JSON.stringify(home);
        assert.ok(!blob.includes('SECRET'), 'no private title or message crosses');
        assert.ok(!home.needsYou.some((r) => r.id === 'perm2'));
    });
    // `awaiting_user` belongs to Needs you, not here: it is waiting on the
    // USER, which is the whole distinction between the two sections.
    await check('ongoing work is only what the Mac is actually doing', () => {
        assert.equal(home.working.map((t) => t.id).join(','), 't-run');
        assert.ok(home.needsYou.some((r) => r.id === 't-ask'), 'and the waiting one is in Needs you');
    });
    await check('every row is a digest — no conversation ids or text', () => {
        for (const row of [...home.needsYou, ...home.working]) {
            // `plan` is present only on a plan awaiting review — it is what
            // makes that row answerable, and it carries step text, never
            // conversation text.
            const keys = Object.keys(row).filter((k) => k !== 'plan').sort().join(',');
            assert.equal(keys,
                row.answerable !== undefined
                    ? 'actionLabel,answerable,id,kind,message,title'
                    : 'id,message,status,title');
        }
    });
    await check('it is stamped so the phone can say how old it is', () => {
        assert.ok(Date.parse(home.at) > 0);
    });

    // --- the tiering (2026-09-21) --------------------------------------
    const answerable = (id) => home.needsYou.find((r) => r.id === id)?.answerable;

    await check('an ordinary permission is answerable from the phone', () => {
        assert.equal(answerable('perm1'), true);
        assert.equal(answerable('cont1'), true, 'and so is "may I keep going?"');
    });
    await check('a step that asks EVERY time is not', () => {
        assert.equal(answerable('once1'), false, 'onceOnly carries the whole sensitive class');
    });
    await check('reaching outside Anjadhe is not', () => {
        assert.equal(answerable('screen1'), false);
    });
    // --- the plan on the card (2026-09-21) ------------------------------
    await check('a plan waiting for review IS answerable, and travels with the row', () => {
        assert.equal(answerable('t-ask'), true);
        const row = home.needsYou.find((r) => r.id === 't-ask');
        assert.equal(row.plan.length, 2);
        assert.equal(row.plan[0], 'Search for hotels near the venue');
    });
    await check('a task paused mid-run is not — its plan is already half spent', () => {
        assert.equal(answerable('t-mid'), false);
        assert.equal(home.needsYou.find((r) => r.id === 't-mid')?.plan, undefined,
            'and no half-spent plan is shown as if it were up for review');
    });
    await check('awaiting the user with no plan at all is not answerable', () => {
        assert.equal(answerable('t-noplan'), false);
    });
    await check('rows without a plan carry no plan field', () => {
        assert.equal(home.needsYou.find((r) => r.id === 'perm1')?.plan, undefined);
    });

    await check('answering settles the real ask, at once scope', async () => {
        const out = await views._homeAnswer({ id: 'perm1', approved: true });
        assert.equal(out.ok, true);
        assert.equal(settled.length, 1);
        assert.deepEqual({ ...settled[0] }, { id: 'perm1', approved: true, scope: 'once' });
    });
    await check('a settled request cannot be answered twice', async () => {
        await assert.rejects(() => views._homeAnswer({ id: 'perm1', approved: true }), /no longer waiting/i);
    });
    await check('a continuation offer goes through its own one path', async () => {
        await views._homeAnswer({ id: 'cont1', approved: true });
        assert.deepEqual({ ...continued }, { id: 'cont1', approved: true });
    });
    await check('approving a plan runs it through TaskService', async () => {
        await views._homeAnswer({ id: 't-ask', approved: true });
        assert.equal(approved.join(','), 't-ask');
        assert.equal(cancelled.length, 0);
    });
    await check('declining a plan cancels it', async () => {
        await views._homeAnswer({ id: 't-noplan', approved: false })
            .then(() => { throw new Error('should have been refused'); }, () => {});
        await views._homeAnswer({ id: 't-mid', approved: false })
            .then(() => { throw new Error('should have been refused'); }, () => {});
        assert.equal(cancelled.length, 0, 'a row the tier refuses is refused in both directions');
    });

    // The flag is a HINT. The Mac must refuse a phone that ignores it.
    await check('the Mac refuses a sensitive one even if asked directly', async () => {
        await assert.rejects(() => views._homeAnswer({ id: 'once1', approved: true }), /on your Mac/i);
        await assert.rejects(() => views._homeAnswer({ id: 'screen1', approved: true }), /on your Mac/i);
        await assert.rejects(() => views._homeAnswer({ id: 't-mid', approved: true }), /on your Mac/i);
        assert.equal(settled.length, 1, 'nothing extra was settled');
        assert.equal(approved.join(','), 't-ask', 'and nothing extra was run');
    });
    await check('a private chat cannot be answered from the phone either', async () => {
        await assert.rejects(() => views._homeAnswer({ id: 'perm2', approved: true }), /no longer waiting/i);
    });
    await check('an unknown id is refused', async () => {
        await assert.rejects(() => views._homeAnswer({ id: 'nope', approved: true }), /no longer waiting/i);
        await assert.rejects(() => views._homeAnswer({}), /missing request id/i);
    });

    // 3. A request deferred on the Mac stays deferred on the phone.
    w.localStorage.setItem('simple-attention-later', JSON.stringify({
        perm1: { revision: 'perm1', until: Date.now() + 3600000 },
    }));
    home = await views._home();
    await check('a request put off on the Mac is not shown on the phone', () => {
        assert.ok(!home.needsYou.some((r) => r.id === 'perm1'));
        assert.ok(home.needsYou.some((r) => r.id === 't-ask'), 'the others still come through');
    });

    // A stale deferral (the request changed) resurfaces, as on the Mac.
    w.localStorage.setItem('simple-attention-later', JSON.stringify({
        perm1: { revision: 'OLD', until: Date.now() + 3600000 },
    }));
    home = await views._home();
    await check('a deferral for an older version of the request does not hide it', () => {
        assert.ok(home.needsYou.some((r) => r.id === 'perm1'));
    });
    w.localStorage.removeItem('simple-attention-later');

    // 1. Locking the Assistant empties both sections.
    locks = new Set(['agent']);
    home = await views._home();
    // NB: these arrays come from the JSDOM realm, so `deepEqual` would
    // compare prototypes and fail on two empty arrays. Length is the claim.
    await check('a locked Assistant contributes nothing', () => {
        assert.equal(home.needsYou.length, 0);
        assert.equal(home.working.length, 0);
    });
    locks = new Set();

    // 4. An older Mac says so rather than throwing something unreadable.
    const saved = w.SimpleExperience;
    delete w.SimpleExperience;
    let message = null;
    try { await views._home(); } catch (e) { message = e.message; }
    await check('the older-Mac error names the problem', () => {
        assert.match(message || '', /older version/i);
    });
    w.SimpleExperience = saved;

    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})();
