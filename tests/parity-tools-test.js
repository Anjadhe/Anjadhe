// The assistant can read what Settings and Now show, and make the same
// preference choices a tap makes (2026-10-08, docs/AI_NATIVE.md "the agent
// can do everything the person can"; the parity inventory there).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const store = new Map();
const facts = [];
let toasts = 0;
const MemoryManager = {
    all: () => facts,
    get: (id) => facts.find(f => f.id === id) || null,
    remember(f) {
        const i = facts.findIndex(x => x.subject && x.subject === f.subject);
        const fact = { id: i >= 0 ? facts[i].id : `f${facts.length + 1}`, text: f.text, heading: f.heading, subject: f.subject, meta: f.meta };
        if (i >= 0) facts[i] = fact; else facts.push(fact);
        return { fact, status: 'saved' };
    },
    edit(id, { text }) { const f = facts.find(x => x.id === id); if (f) f.text = text; return f; }
};
const cards = [
    { key: 'matter:m1', kind: 'decide', title: 'Car insurance renews on the 21st', body: '<b>From</b> your insurer, Monday.', primary: 'Plan a look', choices: [], dismiss: 'Not now', matter: 'm1', reopened: { why: 'It changed: the amount went up.' } },
    { key: 'checkin:habit:run', kind: 'checkin', title: 'Three runs this week, two done', body: 'Tomorrow is clear before 8 AM.', primary: 'Plan the third', checkin: 'habit:run' }
];
const ctx = vm.createContext({
    console, Date, JSON, Math, Map, Set, Promise,
    localStorage: { getItem: (k) => store.get(k) || null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    UIUtils: { showToast: () => { toasts++; } },
    MemoryManager,
    PermissionManager: { ASK_TOOLS: new Set() },
    AccountsManager: { getAll: () => [] },
    Sources: { privacyLines: () => [
        { id: 'texts', label: 'Texts', on: true, value: 'This Mac', reads: 'Your messages', ai: 'Read on this Mac; kept from your AI unless you allow it.' },
        { id: 'apple-notes', label: 'Apple Notes', on: false, value: '', reads: 'Note text', ai: '' }
    ] },
    SimpleSettings: {
        leftRows: () => [
            { ts: new Date().toISOString(), service: 'nenva cloud', kind: 'Chat' },
            { ts: new Date().toISOString(), service: 'nenva cloud', kind: 'Mail and texts' },
            { ts: new Date().toISOString(), service: 'nenva agent web search', kind: 'Web search' },
            { ts: '2020-01-01T00:00:00Z', service: 'nenva cloud', kind: 'Chat' }
        ],
        _kindOfSource: () => 'Chat'
    },
    LLMLogger: { logs: [] }, SearchLogger: { logs: [] }, AIActivity: { recent: [] },
    PlanUsage: { fetch: async () => ({}), view: () => ({ state: 'ok', plan: 'Free', resets: 'November 1', ai: { percent: 42, backgroundPercent: 10 }, searches: { used: 12, allowance: 100 }, billing: {} }) },
    AppManager: { authEnabled: true, autoLockTimeout: 10 },
    AnalyticsManager: { isEnabled: () => false },
    SimpleExperience: {
        cards: () => cards, deckCards: () => cards,
        thingKey: (c) => c.matter ? `matter:${c.matter}` : c.key,
        sourceOf: (c) => c.matter ? 'email' : 'tasks',
        ledeLine: () => 'Thursday, 8 October',
        todayItems: () => [{ time: '9:00 AM', title: 'Dentist', help: { line: 'Leave by 8:40' } }],
        todayLine: () => 'One appointment and two tasks today.'
    },
    window: {
        electronBackup: { getSettings: async () => ({ enabled: true, frequency: 'daily', lastBackup: '2026-10-07T22:00:00Z', backupPath: '/Users/someone/private/folder' }) },
        electronTelegram: { getStatus: async () => ({ configured: true, chat: 12345, enabled: true, token: 'secret-token' }) },
        electronChannel: { getInfo: async () => ({ available: true, devices: [{ name: 'iPhone', pairedAt: '2026-09-01', pub: 'secret-key' }] }) },
        electronBackground: { state: () => ({ enabled: true, paused: true, openAtLogin: false }) },
        electronSystem: { getInfo: async () => { throw new Error('no info'); } }
    }
});
ctx.globalThis = ctx;
vm.runInContext(read('js/agent/agent-tools.js') + '\nthis.AgentTools = AgentTools;', ctx);
vm.runInContext(read('js/core/pref-asks.js') + '\nthis.PrefAsks = PrefAsks;', ctx);
vm.runInContext(read('js/agent/now-tools.js'), ctx);
vm.runInContext(read('js/agent/preference-tools.js'), ctx);
vm.runInContext(read('js/agent/undo-tools.js'), ctx);
vm.runInContext(read('js/agent/triage-tools.js'), ctx);
vm.runInContext(read('js/agent/run-tools.js'), ctx);
vm.runInContext(read('js/agent/upkeep-tools.js'), ctx);
vm.runInContext(read('js/apps/reader/library-upkeep-tools.js'), ctx);
const run = (name, args = {}) => ctx.AgentTools.execute(name, args, {});

(async () => {
    // ── Settings: everything a person sees there, read-only ──
    const st = await run('get_setup_status');
    assert.equal(st.sources.length, 2);
    assert.equal(st.sources[0].name, 'Texts');
    assert.equal(st.sources[0].on, true);
    assert.match(st.sources[0].ai, /kept from your AI/);
    assert.equal(st.leftThisMac.last7Days, 3, 'only the last 7 days');
    assert.equal(st.leftThisMac.byService['nenva cloud'], 2);
    assert.equal(st.plan.cloudPercentUsed, 42);
    assert.equal(st.plan.searchesUsed, 12);
    assert.equal(st.backup.on, true);
    assert.equal(st.backup.lastBackup, '2026-10-07T22:00:00Z');
    assert.equal(st.lock.on, true);
    assert.equal(st.lock.afterMinutesIdle, 10);
    assert.equal(st.usageStatistics.sharing, false);
    assert.deepEqual({ ...st.telegram }, { setUp: true, linked: true, on: true });
    assert.equal(st.pairedDevices[0].name, 'iPhone');
    assert.equal(st.background.routinesPaused, true);
    assert.equal(st.version, undefined, 'a part that fails is left out, never guessed');
    assert.doesNotMatch(JSON.stringify(st), /secret-|private\/folder|12345/, 'presence only: no tokens, keys, chat ids or paths');

    // ── Now: the cards the person sees, with keys a record tool can use ──
    const now = await run('read_now');
    assert.equal(now.cards.length, 2);
    assert.equal(now.cards[0].key, 'matter:m1');
    assert.equal(now.cards[0].why, 'From your insurer, Monday.', 'markup stripped');
    assert.equal(now.cards[0].source, 'email');
    assert.deepEqual([...now.cards[0].buttons], ['Plan a look', 'Not now']);
    assert.match(now.cards[0].reopened, /amount went up/);
    assert.equal(now.cards[1].key, 'checkin:habit:run');
    assert.equal(now.lede, 'Thursday, 8 October');
    assert.equal(now.today[0].help, 'Leave by 8:40');
    assert.equal(now.todayLine, 'One appointment and two tasks today.');

    // ── Preferences: the sentence and the value move together ──
    ctx.PrefAsks.register({ id: 'portfolio-brief', default: true, question: 'Keep writing the brief?',
        choices: [{ value: true, label: 'Yes, keep them', sentence: 'Write me a daily market brief.' },
                  { value: false, label: 'No thanks', sentence: "Don't write market briefs." }] });
    let list = await run('list_preferences');
    assert.equal(list.preferences[0].current, 'Yes, keep them');
    assert.equal(list.preferences[0].chosenByPerson, false);
    const set = await run('set_preference', { id: 'portfolio-brief', choice: 'No thanks' });
    assert.equal(set.success, true);
    assert.equal(ctx.PrefAsks.value('portfolio-brief'), false, 'the app now does what the sentence says');
    assert.equal(facts.find(f => f.subject === 'pref:portfolio-brief').text, "Don't write market briefs.");
    assert.equal(toasts, 1, 'announced like a tap');
    assert.equal((await run('set_preference', { id: 'portfolio-brief', choice: 'true' })).success, true, 'a value works as well as a label');
    assert.equal(ctx.PrefAsks.value('portfolio-brief'), true);
    assert.ok((await run('set_preference', { id: 'portfolio-brief', choice: 'sometimes' })).error, 'only its own choices');
    assert.ok((await run('set_preference', { id: 'nope', choice: 'x' })).error);

    // The bug this closes: the memory tools changed the words, not the value.
    const before = facts.length;
    assert.match((await run('save_memory', { text: 'No brief', heading: 'preferences', subject: 'pref:portfolio-brief' })).error, /set_preference/);
    assert.equal(facts.length, before);
    const prefFact = facts.find(f => f.subject === 'pref:portfolio-brief');
    assert.match((await run('update_memory', { id: prefFact.id, text: 'No brief' })).error, /set_preference/);
    assert.equal(ctx.PrefAsks.value('portfolio-brief'), true, 'value untouched');

    // ── stop_asking: the card's own "Don't ask about this" ──
    const stopped = [];
    ctx.CheckIns = { state: () => ({ cards: [{ subject: 'habit:run', name: 'running' }] }), respond: (s, how) => stopped.push([s, how]) };
    const r = await run('stop_asking', { checkin: 'checkin:habit:run' });
    assert.equal(r.success, true);
    assert.deepEqual(stopped, [['habit:run', 'stop']]);
    assert.ok((await run('stop_asking', { checkin: 'checkin:nope' })).error);
    assert.ok((await run('stop_asking', {})).error);

    // ── Undo: "undo that" uses the same ledgers as the Undo buttons ──
    const scopes = {
        wl_a: { id: 'wl_a', at: '2026-10-08T09:00:00Z', label: 'move my run to Saturday', entries: [{ tool: 'change_commitment', action: 'Updated', target: 'Run' }, { tool: 'send_email', target: 'coach@example.test', external: true }] },
        wl_b: { id: 'wl_b', at: '2026-10-08T08:00:00Z', label: 'already undone', entries: [{ tool: 'change_commitment', target: 'Run' }] }
    };
    const undone = [];
    ctx.WriteLedger = {
        getScope: (id) => scopes[id] || null,
        undoPreview: (id) => id === 'wl_a' && !undone.includes(id) ? { keys: 1 } : null,
        undoScope: async (id) => { undone.push(id); return { restoredKeys: ['commitments'], restoredFiles: [], conflictKeys: [], failedFiles: [], external: ['send_email (coach@example.test)'] }; }
    };
    ctx.AgentService = { conversations: [{ id: 'c1', messages: [
        { role: 'assistant', metadata: { undoScope: 'wl_b' } }, { role: 'assistant', metadata: { undoScope: 'wl_a' } }] }] };
    const ledger = [
        { id: 'l1', op: 'change', target: 'k1', at: '2026-10-08T07:00:00Z', by: 'you' },
        { id: 'l2', op: 'done', target: 'k2', at: '2026-10-08T07:30:00Z', by: 'chat', why: 'answered how it went' },
        { id: 'l3', op: 'change', target: 'k1', at: '2026-10-08T07:40:00Z', by: 'assistant' },
        { id: 'l4', op: 'bridge', target: 'k3', at: '2026-10-08T07:50:00Z' }
    ];
    const cundo = [];
    ctx.Commitments = { _load: () => ({ ledger, items: { k1: { title: 'Run' }, k2: { title: 'Take vitamins' } } }), undo: (id) => { cundo.push(id); return { ok: true, id }; } };
    const ch = await ctx.AgentTools.execute('list_recent_changes', {}, { convId: 'c1' });
    assert.deepEqual([...ch.turns].map(t => t.ref), ['turn:wl_a'], 'only turns of this chat that still undo');
    assert.deepEqual([...ch.turns[0].cannotUndo], ['send_email (coach@example.test)'], 'says what cannot come back');
    assert.deepEqual([...ch.commitments].map(c => c.ref), ['commitment:l3', 'commitment:l2'], 'newest first; l1 was changed again since; bridge writes are not changes');
    assert.equal(ch.commitments[1].what, 'Take vitamins: marked done');
    assert.ok(ctx.PermissionManager.ASK_TOOLS.has('undo_change'), 'undo asks every time');
    let u = await ctx.AgentTools.execute('undo_change', { ref: 'turn:wl_a' }, { convId: 'c1' });
    assert.equal(u.success, true);
    assert.deepEqual([...u.cannotUndo], ['send_email (coach@example.test)']);
    assert.ok((await ctx.AgentTools.execute('undo_change', { ref: 'turn:wl_a' }, { convId: 'c1' })).error, 'not twice');
    assert.ok((await ctx.AgentTools.execute('undo_change', { ref: 'turn:wl_a' }, { convId: 'other' })).error, 'only this chat\'s turns');
    u = await ctx.AgentTools.execute('undo_change', { ref: 'commitment:l2' }, { convId: 'c1' });
    assert.equal(u.success, true);
    assert.deepEqual(cundo, ['l2']);
    assert.ok((await ctx.AgentTools.execute('undo_change', { ref: 'commitment:l1' }, { convId: 'c1' })).error, 'changed again since: refused');
    assert.ok((await ctx.AgentTools.execute('undo_change', { ref: 'nope' }, {})).error);

    // ── Triage: the card and folder buttons, from any chat ──
    const calls = [];
    ctx.SimpleExperience.letGoFromChat = (key, forGood) => { calls.push(['letGo', key, forGood]); return key === 'approval:1' ? { error: 'waiting for approval' } : { done: true, title: 'Car insurance', how: forGood ? 'for good' : 'for now' }; };
    ctx.SimpleExperience.render = () => {};
    const m1 = { id: 'm1', state: 'open', next: { what: 'Pay $612', state: 'open' } };
    ctx.Matters = { get: (id) => id === 'm1' ? m1 : null, titleOf: () => 'Car insurance', stepText: () => '',
        markStep: (id, _s, st, by) => { calls.push(['markStep', id, st, by]); m1.next.state = st; }, ignore: (id) => { calls.push(['ignore', id]); m1.state = 'ignored'; } };
    ctx.EmailApp = { priorityAnalyses: { e1: { type: 'bill' } },
        emailById: (id) => id === 'e1' ? { id: 'e1', subject: 'Renewal' } : null, senderAddress: () => 'insurer@example.test',
        muteSenderOf: (id) => calls.push(['mute', id]), unmuteSender: (a) => calls.push(['unmute', a]),
        recordInsightFeedback: (id, useful) => calls.push(['feedback', id, useful]), deleteInsight: (id) => { calls.push(['delete', id]); return id === 'e1'; } };
    const plans = { t1: { status: 'proposed', title: 'Tax return', plan: { sessions: [] } } };
    ctx.WorkPlans = { _state: () => ({ byTask: plans }), accept: (id) => { calls.push(['accept', id]); return 2; }, decline: (id) => calls.push(['decline', id]),
        replan: (id) => calls.push(['replan', id]), unarrange: (id) => { calls.push(['unarrange', id]); return 2; } };

    assert.equal((await run('set_card_aside', { key: 'matter:m1', for_good: false })).how, 'for now');
    assert.ok((await run('set_card_aside', { key: 'approval:1', for_good: true })).error, 'an approval waits on the person');
    assert.equal((await run('finish_matter_step', { id: 'm1' })).done, 'Pay $612');
    assert.ok((await run('finish_matter_step', { id: 'm1' })).error, 'no open step twice');
    assert.equal((await run('ignore_matter', { id: 'm1' })).success, true);
    assert.ok((await run('ignore_matter', { id: 'nope' })).error);
    assert.equal((await run('mute_sender', { message_id: 'e1' })).muted, 'insurer@example.test');
    assert.equal((await run('mute_sender', { unmute: true, address: 'Insurer@Example.test' })).unmuted, 'insurer@example.test');
    assert.ok((await run('mute_sender', { message_id: 'nope' })).error);
    assert.equal((await run('insight_feedback', { message_id: 'e1', useful: false })).useful, false);
    assert.equal((await run('delete_insight', { message_id: 'e1' })).success, true);
    assert.ok((await run('delete_insight', { message_id: 'e2' })).error);
    assert.equal((await run('answer_work_plan', { id: 't1', answer: 'schedule' })).scheduled, 2);
    assert.equal((await run('answer_work_plan', { id: 't1', answer: 'undo_sessions' })).removed, 2);
    assert.ok((await run('answer_work_plan', { id: 'zz', answer: 'schedule' })).error);
    assert.deepEqual(calls.map(c => c.join(' ')), ['letGo matter:m1 false', 'letGo approval:1 true', 'markStep m1 done chat', 'ignore m1', 'mute e1', 'unmute insurer@example.test',
        'feedback e1 false', 'delete e1', 'delete e2', 'accept t1', 'unarrange t1'], 'each tool runs the button\'s own function');
    for (const n of ['mute_sender', 'delete_insight', 'answer_work_plan']) assert.ok(ctx.PermissionManager.ASK_TOOLS.has(n), `${n} asks`);
    for (const n of ['set_card_aside', 'finish_matter_step', 'ignore_matter', 'insight_feedback']) assert.ok(!ctx.PermissionManager.ASK_TOOLS.has(n), `${n} is the person's own word`);

    // ── Run things: Run now, Stop, Continue, Pause, Back up now ──
    const runs = [];
    ctx.NotePrompts = { list: () => [{ id: 'r1', title: 'Morning briefing' }] };
    ctx.PromptFeed = { _busy: false, runNow: async (id) => { runs.push(['run', id]); }, stopCurrent: () => { runs.push(['stop']); return true; } };
    const jobs = [{ id: 'j1', goal: 'Find a plumber', status: 'running', note: 'Browser is looking.', changes: [], routineId: 'r1', updatedAt: '2026-10-08' }];
    ctx.TeamJobs = { all: () => jobs, get: (id) => jobs.find(j => j.id === id) || null, isJob: (id) => id === 'j1',
        stop: async (id) => runs.push(['jobstop', id]), resume: async (id) => runs.push(['jobresume', id]), remove: async (id) => runs.push(['jobdelete', id]) };
    let paused = false, backups = 0;
    ctx.window.electronBackground = { state: () => ({ paused }), set: async (p) => { paused = p.paused; } };
    ctx.window.electronBackup.backupNow = async () => { backups++; return { success: true }; };
    const person = { convId: 'c1' };
    assert.match((await ctx.AgentTools.execute('run_routine', { id: 'r1' }, person)).status, /started/);
    assert.ok((await ctx.AgentTools.execute('run_routine', { id: 'r1' }, { unattended: true })).error, 'a run cannot start runs');
    assert.ok((await ctx.AgentTools.execute('run_routine', { id: 'r1' }, { private: true })).error);
    assert.ok((await ctx.AgentTools.execute('run_routine', { id: 'zz' }, person)).error);
    assert.equal((await ctx.AgentTools.execute('stop_routine_run', {}, person)).success, true);
    const lj = await ctx.AgentTools.execute('list_jobs', {}, person);
    assert.equal(lj.jobs[0].fromRoutine, 'Morning briefing');
    assert.equal((await ctx.AgentTools.execute('control_job', { id: 'j1', action: 'stop' }, person)).stopped, 'j1');
    assert.equal((await ctx.AgentTools.execute('control_job', { id: 'j1', action: 'resume' }, person)).resumed, 'j1');
    assert.ok((await ctx.AgentTools.execute('control_job', { id: 'zz', action: 'stop' }, person)).error);
    assert.equal((await ctx.AgentTools.execute('delete_job', { id: 'j1' }, person)).deleted, 'j1');
    assert.ok(ctx.PermissionManager.ASK_TOOLS.has('delete_job'), 'deleting a job asks');
    assert.equal((await ctx.AgentTools.execute('pause_routines', { paused: true }, person)).routinesPaused, true);
    assert.equal(paused, true);
    assert.equal((await ctx.AgentTools.execute('backup_now', {}, person)).success, true);
    assert.equal(backups, 1);
    ctx.window.electronBackup.getSettings = async () => ({ enabled: false });
    assert.match((await ctx.AgentTools.execute('backup_now', {}, person)).error, /Backup is off/, 'turning backup on stays the person\'s');
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(runs.map(r => r.join(' ')), ['run r1', 'stop', 'jobstop j1', 'jobresume j1', 'jobdelete j1']);

    // ── Batch 6: chats, trips, memory, theme, documents ──
    const convs = [
        { id: 'c1', title: 'This chat', messages: [] },
        { id: 'c2', title: 'Dentist', updatedAt: '2026-10-07', messages: [{ role: 'user', content: 'move my dentist appointment' }], recordKey: 'task:t9', recordLabel: 'Dentist' },
        { id: 'c3', title: 'Morning briefing', standing: { body: 'x' }, messages: [] },
        { id: 'c4', title: 'Secret', private: true, messages: [] }
    ];
    const deleted = [], detached = [];
    ctx.AgentService = { conversations: convs, isConversationStreaming: () => false,
        getConversationList: () => convs.filter(c => !c.private).map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, messageCount: c.messages.length, preview: '', recordKey: c.recordKey || null, recordLabel: c.recordLabel || null, standing: !!c.standing })),
        deleteConversation: (id) => deleted.push(id), detachRecordFromConversation: (id) => detached.push(id) };
    const chats = await ctx.AgentTools.execute('list_chats', { query: 'dentist' }, { convId: 'c1' });
    assert.deepEqual([...chats.chats].map(c => c.id), ['c2'], 'by words; not this chat, routines or private chats');
    assert.equal((await ctx.AgentTools.execute('list_chats', {}, { convId: 'c1' })).count, 1);
    assert.ok((await ctx.AgentTools.execute('delete_chat', { id: 'c1' }, { convId: 'c1' })).error, 'not this chat');
    assert.ok((await ctx.AgentTools.execute('delete_chat', { id: 'c3' }, { convId: 'c1' })).error, 'not a routine');
    assert.ok((await ctx.AgentTools.execute('delete_chat', { id: 'c4' }, { convId: 'c1' })).error, 'never a private chat');
    assert.equal((await ctx.AgentTools.execute('delete_chat', { id: 'c2' }, { convId: 'c1' })).deleted, 'Dentist');
    assert.equal((await ctx.AgentTools.execute('detach_chat_record', { id: 'c2' }, { convId: 'c1' })).detachedFrom, 'Dentist');
    assert.deepEqual([deleted, detached].map(x => x.join()), ['c2', 'c2']);
    assert.ok(ctx.PermissionManager.ASK_TOOLS.has('delete_chat'));

    ctx.Trips = { all: () => [{ key: 'k', name: 'Lisbon', start: '2026-11-01', end: '2026-11-04', review: { brief: 'Flights are set.', offers: [{ label: 'Find a hotel', ask: 'Find me a hotel' }] } }],
        dates: () => 'Nov 1–4', itinerary: () => [{ line: 'Flight: TAP · Sat, Nov 1' }], gaps: () => ['2026-11-03'] };
    const tr = await run('list_trips');
    assert.equal(tr.trips[0].name, 'Lisbon');
    assert.deepEqual([...tr.trips[0].nightsWithNoStay], ['2026-11-03']);
    assert.deepEqual([...tr.trips[0].offers], ['Find a hotel']);

    const stale = { id: 'f9', text: 'Lives in Austin', heading: 'about', starred: false };
    facts.push(stale);
    MemoryManager.needsLook = () => [stale];
    let edits = [];
    MemoryManager.edit = (id, patch) => { edits.push([id, JSON.stringify(patch)]); const f = facts.find(x => x.id === id); if (f && patch.starred !== undefined) f.starred = patch.starred; return f; };
    assert.equal((await run('memory_needs_look')).facts[0].id, 'f9');
    assert.equal((await run('star_memory', { id: 'f9', starred: true })).starred, true);
    assert.equal((await run('confirm_memory', { id: 'f9' })).success, true);
    assert.deepEqual(edits.map(e => e.join(' ')), ['f9 {"starred":true}', 'f9 {}'], 'the star and Still true call the page\'s own edit');

    let theme = null;
    ctx.AppManager.setThemePref = (t) => { theme = t; };
    assert.equal((await run('set_theme', { theme: 'dark' })).theme, 'dark');
    assert.equal(theme, 'dark');
    assert.ok((await run('set_theme', { theme: 'blue' })).error);

    const lib = [];
    ctx.window.electronLibrary = { list: async () => ({ docs: [{ id: 'd1', relpath: 'Finance/lease.pdf' }] }), deleteDoc: async (id) => { lib.push(['trash', id]); return {}; },
        importPaths: async (paths) => { lib.push(['import', paths[0]]); return { docs: [{ id: 'd2', relpath: 'w2.pdf' }] }; } };
    ctx.DocTags = { forget: (id) => lib.push(['forget', id]), add: (id, tag) => lib.push(['tag', id, tag]), get: () => ['Taxes'], rename: (f, t) => f === 'Finance' ? 3 : 0, normalize: (t) => t };
    assert.equal((await run('trash_document', { id: 'd1' })).movedToTrash, 'lease.pdf');
    assert.ok((await run('trash_document', { id: 'zz' })).error);
    assert.ok((await run('add_file_to_documents', { path: '~/Downloads/w2.pdf' })).error, 'a full path only');
    assert.equal((await run('add_file_to_documents', { path: '/Users/someone/Downloads/w2.pdf', tag: 'Taxes' })).docId, 'd2');
    assert.equal((await run('rename_document_tag', { from: 'Finance', to: 'Money' })).documentsRetagged, 3);
    assert.ok((await run('rename_document_tag', { from: 'Nope', to: 'X' })).error);
    assert.deepEqual(lib.map(x => x.join(' ')), ['trash d1', 'forget d1', 'import /Users/someone/Downloads/w2.pdf', 'tag d2 Taxes']);
    for (const n of ['trash_document', 'add_file_to_documents', 'rename_document_tag']) assert.ok(ctx.PermissionManager.ASK_TOOLS.has(n), `${n} asks`);

    console.log('parity-tools: Settings and Now are readable; preferences, undo, triage, runs, chats, trips, memory, theme and documents go through the buttons\' own functions');
})().catch(e => { console.error(e); process.exit(1); });
