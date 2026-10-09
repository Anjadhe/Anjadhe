// Now and Jobs on the phone (js/agent/mobile-views.js `_now`, `_cardAct`,
// `_jobs`/`_job`/`_jobAction`, 2026-10-02 — docs/MOBILE_NATIVE.md "Now on
// the phone"). What must hold:
//   1. every card and row is SimpleExperience's own — this file only says
//      WHERE each action runs (`does`), and drops Mac-only chores;
//   2. a card act from the phone is re-derived on the Mac and only the quiet,
//      windowless ones run (Later, Got it, Don't ask, Mark done, a folder's plain Done);
//   3. an approval is answered only through the request queue's gate;
//   4. a job's page and its Stop / Continue / wait answers go to TeamJobs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '../js/agent/mobile-views.js'), 'utf8');

const acted = [];
let brainEntry = { engine: 'anjadhe', model: 'nenva-cloud-lite', id: 'e1' };
const jobActs = [];
const cards = [
    { key: 'ask:perm1', kind: 'approval', title: 'Booking the flights', body: 'May I send this email?', primary: 'Review and approve', talk: '', row: { kind: 'ask', id: 'perm1' } },
    { key: 'ask:room1', kind: 'decide', title: 'A workroom', body: 'Open it', primary: 'Review', talk: 'Help me', row: { kind: 'ask', id: 'room1' } },
    { key: 'task:t1', kind: 'decide', title: 'Pay rent', body: 'Was due Oct 1.', primary: 'Mark done', talk: 'My task', row: { kind: 'task', id: 't1' } },
    { key: 'matter:m1:next', kind: 'decide', title: 'Water bill', body: 'Due Oct 5', primary: 'Pay', dismiss: 'Already done', talk: 'About', matter: 'm1', step: 'next' },
    { key: 'matter:m2:next', kind: 'decide', title: 'Field trip slip', body: 'Due Oct 12', primary: 'Done', dismiss: '', talk: 'About', matter: 'm2', step: 'next' },
    { key: 'matter:m3:next', kind: 'decide', title: 'Dentist', body: 'Reply to confirm', primary: 'Draft the reply', dismiss: 'Already done', talk: 'About', matter: 'm3', step: 'next' },
    { key: 'connect:google', kind: 'offer', title: 'Connect', body: '', primary: 'Connect', talk: '', row: { kind: 'connect', id: 'google' } },
    { key: 'meet:m1', kind: 'headsup', title: 'Standup at 9:30', body: 'Starts in 10 minutes.', primary: 'Join', url: 'https://meet.google.com/abc', meeting: { ev: {}, open: null }, talk: 'Help me prepare' },
    { key: 'job:j1:done', kind: 'headsup', title: 'Finished: research', body: '', primary: 'Open', job: 'j1', talk: '' },
    { key: 'post:p1', kind: 'headsup', title: 'Morning News', body: 'Three headlines', primary: 'Read', post: 'p1', talk: '' },
    { key: 'checkin:project:g1', kind: 'checkin', title: 'How is the release?', body: 'No update', primary: 'Check in on it', checkin: 'project:g1', talk: 'How is my project going?' },
];
const jobs = [
    { id: 'j1', engine: 'team', status: 'running', goal: 'Research flights', plan: [{ step: 'Search', status: 'done' }, { step: 'Compare', status: 'running' }], conversationId: 'c1' },
    { id: 'j2', engine: 'team', status: 'paused', goal: 'Plan the trip', routineId: 'r1' },
];
const ctx = {
    console, Date, JSON, Math, String, Array, Object, Number, Set, Map, Promise, Error, RegExp,
    window: {},
    SimpleExperience: {
        KIND_LABEL: { approval: 'Needs your approval', decide: 'Needs you', offer: 'I can do this', headsup: 'Heads-up', checkin: 'Check-in' },
        ledeLine: () => ({ date: 'Friday, October 2', status: 'Reading your email · 3 to go' }),
        todayItems: () => [
            { key: 'event:e9', time: '9:30 AM', title: 'Standup', ev: {}, open: { url: 'https://calendar.google.com/x' }, help: { line: 'With Ana', action: { label: 'Join', kind: 'url', url: 'https://meet.google.com/abc' } } },
            { key: 'task:t2', time: '', title: 'Draft memo', taskId: 't2', help: { line: 'Next step in Q4', action: { label: 'Break it down', kind: 'chat', prompt: 'Break down "Draft memo"' } } },
            { key: 'task:t3', time: '', title: 'Reply to Bo', taskId: 't3', help: { line: '', action: { label: 'Open the email', kind: 'email', id: 'm3' } } },
            { key: 'task:t4', time: '', title: 'Find a venue', taskId: 't4', help: { line: 'Working: searching', live: true, action: { label: 'See progress', kind: 'job', id: 'j1' } } },
            { key: 'event:e5', time: '2 PM', title: 'Call', ev: {}, help: { line: 'In a chat, 5 min ago.', action: { label: 'Open chat', kind: 'conv', id: 'c7' } } },
        ],
        cards: () => cards,
        allCards: () => cards,
        _cardByKey: (k) => cards.find((c) => c.key === k),
        cardAct: (k, a) => acted.push([k, a]),
        noteText: () => 'Morning. One thing needs you.',
        todayLine: () => 'No more meetings.',
        presence: () => ({ working: ['Research flights'], looking: ['inbox', 'calendar'] }),
        attention: () => [{ id: 'perm1', kind: 'permission' }, { id: 'room1', kind: 'workroom' }],
        render: () => {},
        jobs: () => jobs,
        jobStatus: (t) => (t.status === 'running' ? { label: 'Working', live: true } : { label: 'Paused' }),
        jobTitle: (t) => t.goal,
        jobWhen: () => '9:00 AM',
        onTaskUpdate: () => {},
    },
    AgentService: { getDefaultEntry: () => brainEntry, displayModelName: () => 'nenva cloud lite' },
    TodayHelp: { planPrompt: (rows) => `Plan my day: ${rows.map((r) => r.title).join(', ')}` },
    EmailApp: {
        gmailUrl: (m) => (m.account ? `https://mail.google.com/mail/u/0/#all/${m.id}` : null),
        emailById: (id) => ({ e1: { id: 'e1', account: 'me@gmail.com', threadId: '18f2a9c0b1d2e3f4', messageIdHeader: '<CAB123@mail.gmail.com>' },
            e2: { id: 'e2' }, m3: { id: 'm3', account: 'me@gmail.com', threadId: '18f2a9c0b1d2e3f5', messageIdHeader: '<x@y>' } })[id] || null,
    },
    Matters: {
        get: (id) => ({ m1: { id: 'm1', next: { state: 'open', how: 'link', url: 'https://pay.citywater.gov/a/1' } }, m2: { id: 'm2', next: { state: 'open', how: 'none' } }, m3: { id: 'm3', next: { state: 'open', how: 'reply' } } })[id] || null,
        openStep: (m) => (m && m.next && m.next.state === 'open' ? { ...m.next, id: 'next', kind: m.next.how } : null),
    },
    CheckIns: { respond: (s, how) => acted.push(['checkin', s, how]) },
    AgentUI: { _inlineAskCurrent: { attentionId: 'perm1', settled: false, toolName: 'create_note' }, _inlineAskQueue: [], _continueOffers: new Map() },
    TeamJobs: {
        isJob: (id) => jobs.some((j) => j.id === id),
        waiting: () => null,
        stop: async (id) => jobActs.push(['stop', id]),
        resume: async (id) => jobActs.push(['resume', id]),
        answer: (id, ok) => jobActs.push(['answer', id, ok]),
    },
};
vm.createContext(ctx);
vm.runInContext(src + '\nthis.MobileViews = MobileViews;', ctx);
const MV = ctx.MobileViews;
// Values built inside the vm realm: compare their JSON.
const plain = (x) => JSON.parse(JSON.stringify(x));

(async () => {
    const now = MV._now();
    assert.equal(now.note, 'Morning. One thing needs you.');
    assert.equal(now.date, 'Friday, October 2');
    assert.deepEqual(plain(now.working), ['Research flights']);
    const by = Object.fromEntries(now.cards.map((c) => [c.key, c]));

    // 1. Mac chores never reach the phone; everything else says where it runs.
    assert.ok(!by['connect:google'], 'connect is a Mac chore');
    assert.equal(by['ask:perm1'].primary.does, 'answer');
    assert.equal(by['ask:perm1'].answerable, true);
    assert.equal(by['ask:perm1'].quiet.length, 0, 'an approval is never put off from the phone');
    assert.equal(by['ask:room1'].primary, undefined, 'a workroom is answered on the Mac');
    assert.equal(by['task:t1'].primary.does, 'mac');
    // A folder's step (docs/MATTERS.md §17): a link opens on the phone, a
    // plain "do it" is Done on the Mac, a reply is drafted on the Mac only.
    assert.deepEqual(plain(by['matter:m1:next'].primary), { label: 'Pay', does: 'url', url: 'https://pay.citywater.gov/a/1' });
    assert.ok(by['matter:m1:next'].quiet.some((q) => q.act === 'dismiss' && q.label === 'Already done'));
    assert.deepEqual(plain(by['matter:m2:next'].primary), { label: 'Done', does: 'mac', act: 'primary' });
    assert.equal(by['matter:m3:next'].primary, undefined, 'a reply is drafted on the Mac');
    assert.equal(by['meet:m1'].primary.does, 'url');
    assert.deepEqual(plain(by['meet:m1'].quiet.map((q) => q.act)), ['gotit']);
    assert.equal(by['job:j1:done'].primary.does, 'job');
    assert.equal(by['post:p1'].primary.does, 'post');
    assert.equal(by['checkin:project:g1'].primary.does, 'chat');
    assert.equal(by['checkin:project:g1'].primary.act, 'accept');
    assert.deepEqual(plain(by['checkin:project:g1'].quiet.map((q) => q.act)), ['later', 'stop']);

    const rows = now.today.rows;
    assert.equal(rows[0].action.does, 'url');
    assert.equal(rows[0].openUrl, 'https://calendar.google.com/x');
    assert.equal(rows[1].action.does, 'chat');
    assert.equal(rows[2].action.does, 'email', 'an email opens in the mail app');
    assert.equal(rows[2].action.email.header, 'x@y');
    assert.equal(rows[3].action.does, 'job');
    assert.equal(rows[3].live, true);
    assert.equal(rows[4].action.does, 'conv');
    assert.match(now.today.plan, /^Plan my day: /);

    // 2. Only quiet acts run from the phone.
    await MV._homeAnswer({ card: 'task:t1', act: 'later' });
    await MV._homeAnswer({ card: 'task:t1', act: 'primary' });
    await MV._homeAnswer({ card: 'matter:m2:next', act: 'primary' });
    await MV._homeAnswer({ card: 'checkin:project:g1', act: 'accept' });
    await MV._homeAnswer({ card: 'matter:m1:next', act: 'dismiss' });
    assert.deepEqual(acted, [['task:t1', 'later'], ['task:t1', 'primary'], ['matter:m2:next', 'primary'], ['checkin', 'project:g1', 'accept'], ['matter:m1:next', 'dismiss']]);
    for (const [card, act] of [['matter:m1:next', 'primary'], ['matter:m3:next', 'primary'], ['ask:room1', 'primary'], ['meet:m1', 'primary'], ['task:t1', 'talk'], ['nope', 'later']]) {
        await assert.rejects(MV._homeAnswer({ card, act }), `${card} ${act} must be refused`);
    }
    assert.equal(acted.length, 5);

    // 4. Jobs.
    const list = MV._jobs();
    assert.deepEqual(plain(list.jobs.map((j) => [j.id, j.status, j.live])), [['j1', 'Working', true], ['j2', 'Paused', false]]);
    const j1 = MV._job({ id: 'j1' });
    assert.equal(j1.canStop, true);
    assert.deepEqual(plain(j1.steps.map((s) => s.status)), ['done', 'running']);
    assert.equal(j1.conversationId, 'c1');
    assert.equal(MV._job({ id: 'j2' }).canContinue, true);
    await MV._jobAction({ id: 'j1', act: 'stop' });
    await MV._jobAction({ id: 'j2', act: 'continue' });
    await assert.rejects(MV._jobAction({ id: 'j1', act: 'allow' }), /no longer waiting/);
    await assert.rejects(MV._jobAction({ id: 'j1', act: 'delete' }), /unknown action/);
    assert.throws(() => MV._job({ id: 'gone' }), /gone/);
    assert.deepEqual(jobActs, [['stop', 'j1'], ['resume', 'j2']]);

    // 5. The Mac names its default model so a phone can follow it — a cloud
    //    model by tier, anything else only by kind (never a server or key).
    assert.deepEqual(plain(MV._brain()), { engine: 'anjadhe', model: 'nenva-cloud-lite', name: 'nenva cloud lite' });
    brainEntry = { engine: 'llamacpp', model: 'gemma.gguf' };
    assert.deepEqual(plain(MV._brain()), { engine: 'local' });
    brainEntry = { engine: 'custom', model: 'x', baseUrl: 'http://10.0.0.2' };
    assert.deepEqual(plain(MV._brain()), { engine: 'other' });

    console.log('mobile-now-test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
