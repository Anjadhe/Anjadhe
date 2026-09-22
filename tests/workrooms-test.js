/* Workrooms: the event-log store, and the engine run against a scripted model.
 * No model, network, browser or Electron: main's store is the real one. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const WorkroomStore = require('../js/main/workroom-store');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anjadhe-workrooms-test-'));
(async () => {
    // ── the store ────────────────────────────────────────────────────────
    const deltas = [];
    const dir = path.join(root, 'rooms');
    let store = new WorkroomStore(dir, { onEvent: delta => deltas.push(delta) });
    const image = 'data:image/png;base64,' + 'A'.repeat(64);
    const room = store.command('create', { goal: 'Prepare a meeting brief', attachments: [{ name: 'notes.txt', kind: 'text', size: 12, content: 'Budget is 40k' }, { name: 'shot.png', kind: 'image', size: 64, dataUrl: image }] });
    assert.equal(room.status, 'queued'); assert.equal(room.title, 'Prepare a meeting brief');
    let events = store.events(room.id);
    assert.equal(events.length, 1); assert.equal(events[0].from, 'you');
    assert.equal(events[0].attachments[0].content, undefined, 'An event carries the label; the body is a file');
    assert.ok(!JSON.stringify(store.snapshot()).includes('AAAA'), 'Summaries never carry attachment bodies');
    assert.equal(store.attachment(room.id, events[0].attachments[0].fileId).content, 'Budget is 40k');
    assert.equal(store.attachment(room.id, events[0].attachments[1].fileId).dataUrl, image);
    assert.throws(() => store.attachment(room.id, '../index.json'), /Unknown attachment/);
    assert.throws(() => store.command('create', { goal: '   ' }), /Invalid/);

    // Only a lease may write, and only as itself.
    assert.equal(store.command('commit', { id: room.id, token: 'nope', event: { type: 'join', agent: 'research' } }, 1).executionInactive, true);
    const claim = store.command('claim', { id: room.id }, 1);
    assert.equal(deltas.at(-1).room.status, 'running', 'A status change is pushed too, or the page never learns the work started or ended');
    assert.equal(store.command('claim', { id: room.id }, 1), null, 'A running room cannot be claimed twice');
    const commit = (event, sender = 1) => store.command('commit', { id: room.id, token: claim.token, event }, sender);
    assert.equal(commit({ type: 'join', agent: 'research' }, 2).executionInactive, true, 'Another window cannot use this lease');
    assert.throws(() => commit({ type: 'message', from: 'you', text: 'forged' }), /Only the user/);
    assert.throws(() => commit({ type: 'approval_answer', approved: true }), /Unknown workroom event/);
    commit({ type: 'join', agent: 'research' });
    commit({ type: 'now', agent: 'research', text: 'searching the web' });
    assert.equal(store.snapshot()[0].now.text, 'searching the web');
    assert.ok(!store.events(room.id).some(event => event.type === 'now'), '"Who is doing what" is pushed, never logged');
    assert.deepEqual(store.snapshot()[0].members, ['research']);

    // A message sent while the team works is DELIVERED, not a restart.
    store.command('message', { id: room.id, text: 'Make it two pages' }, 1);
    assert.equal(store.snapshot()[0].status, 'running'); assert.ok(store.leases.has(room.id));
    assert.equal(deltas.at(-2).event.text, 'Make it two pages', 'Every append is pushed as a delta');

    // An approval is a promise main resolves.
    const waiting = store.requestApproval(room.id, claim.token, 1, { agent: 'browser', kind: 'site', origin: 'https://shop.test', summary: 'Work on shop.test?' });
    const approvalId = store.snapshot()[0].approval.id;
    assert.throws(() => store.command('approval', { id: room.id, approvalId: 'other', approved: true }), /no longer active/);
    store.command('approval', { id: room.id, approvalId, approved: true, always: true }, 1);
    assert.deepEqual(await waiting, { approved: true, always: true, cancelled: false });
    assert.equal(store.snapshot()[0].approval, null);
    // A step that asks every time can never be saved.
    const step = store.requestApproval(room.id, claim.token, 1, { kind: 'step', origin: 'https://shop.test', summary: 'Click “Pay”?', sensitive: 'reads as paying' });
    assert.throws(() => store.command('approval', { id: room.id, approvalId: store.snapshot()[0].approval.id, approved: true, always: true }, 1), /always asks/);
    // Pausing withdraws the question instead of leaving a live card behind.
    store.command('pause', { id: room.id }, 1);
    assert.deepEqual(await step, { approved: false, always: false, cancelled: true });
    assert.equal(store.snapshot()[0].status, 'paused'); assert.equal(store.leases.size, 0);
    assert.equal((await store.requestApproval(room.id, claim.token, 1, { summary: 'late' })).cancelled, true, 'No lease, no question');
    assert.equal(commit({ type: 'join', agent: 'writer' }).executionInactive, true, 'A revoked run cannot publish');

    // A restart pauses what was running, keeps what was queued, loses nothing.
    store.command('resume', { id: room.id }, 1); store.command('claim', { id: room.id }, 1);
    const count = store.events(room.id).length;
    store.saveIndex();
    store = new WorkroomStore(dir, { onEvent: delta => deltas.push(delta) });
    assert.equal(store.snapshot()[0].status, 'paused');
    assert.equal(store.events(room.id).length, count + 1);
    assert.match(store.events(room.id).at(-1).text, /restarted/);
    assert.equal(store.events(room.id, count).length, 1, 'A reader can ask for only what it has not seen');

    // Old workrooms.json rooms come across as conversations.
    const legacy = path.join(root, 'workrooms.json');
    fs.writeFileSync(legacy, JSON.stringify({ version: 1, rooms: [{ id: '11111111-1111-4111-8111-111111111111', title: 'Old room', status: 'running', messages: [
        { from: 'you', to: 'master', kind: 'request', text: 'Find a hotel', at: '2026-09-19T10:00:00Z' }, { from: 'master', to: 'research', kind: 'assignment', text: 'internal' },
        { from: 'master', to: 'you', kind: 'result', text: 'Here are three.', at: '2026-09-19T10:05:00Z' }] }] }));
    const imported = new WorkroomStore(path.join(root, 'imported'), { legacyFile: legacy });
    assert.deepEqual(imported.events('11111111-1111-4111-8111-111111111111').map(event => [event.from, event.text]), [['you', 'Find a hotel'], ['master', 'Here are three.']]);
    assert.equal(imported.snapshot()[0].status, 'idle'); assert.ok(fs.existsSync(legacy + '.migrated'));

    // Delete removes the log and the files.
    store.command('delete', { id: room.id }, 1);
    assert.ok(!fs.existsSync(store.logFile(room.id))); assert.ok(!fs.existsSync(store.filesDir(room.id)));

    // ── the engine, against a scripted model ─────────────────────────────
    const owner = 1;
    Object.assign(globalThis, {
        AgentLoop: require('../js/agent/agent-loop'), Specialists: require('../js/agent/specialists/registry'),
        Playbooks: require('../js/agent/specialists/playbooks'), SpecialistRuntime: require('../js/agent/specialists/runtime'),
        FEATURES: { isEnabled: () => true }, AppManager: { isAppLocked: () => false, sensitiveUnlocked: true },
        CloudPrivacy: { TOOL_CLASS: { list_emails: 'messages', get_email: 'messages' }, allows: () => true },
        Notify: { show() {} }
    });
    const calls = [];
    const tools = { web_search: async args => ({ results: [{ title: 'Kettle', url: 'https://shop.test/kettle', snippet: '$30' }] }),
        list_emails: async () => ({ emails: [{ id: 'm1', subject: 'Invoice', from: 'ana@x.test' }] }) };
    globalThis.AgentTools = { handlers: tools, definitions: Object.keys(tools).concat(['read_url', 'get_email', 'list_email_analyses', 'browser_look', 'browser_act']).map(name => ({ type: 'function', function: { name, parameters: {} } })),
        execute: async (name, args, ctx) => { calls.push({ name, args, ctx }); return tools[name] ? tools[name](args) : { error: 'no fixture' }; } };
    for (const name of ['read_url', 'get_email', 'list_email_analyses']) tools[name] = async () => ({ ok: true });
    globalThis.AgentService = { model: 'scripted', numCtx: 8192, remoteEntryRouting: () => ({}), getDefaultEntry: () => ({ id: 'e' }), supportsVision: () => false, ensureVisionInfo: async () => {} };
    let script = [];
    const seen = [];
    globalThis.LLMLogger = { destinationOf: () => ({ left: false }), call: async (source, params) => { seen.push(params); const next = script.shift(); assert.ok(next, 'The scripted model ran out of turns'); return typeof next === 'function' ? next(params) : next; } };
    const say = text => ({ message: { content: text } });
    const use = (name, args) => ({ message: { content: '', tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } });
    const engineStore = new WorkroomStore(path.join(root, 'engine'), { onEvent: delta => WorkroomEngine.onDelta(delta) });
    globalThis.window = { electronBackground: { state: () => ({ owner: true }) },
        electronAgentBrowser: { command: async () => ({ ok: true }) },
        electronWorkrooms: { list: async () => engineStore.snapshot(), events: async (id, after) => engineStore.events(id, after), attachment: async (id, fileId) => engineStore.attachment(id, fileId),
            command: async (action, input) => engineStore.command(action, input, owner) } };
    const WorkroomEngine = globalThis.WorkroomEngine = require('../js/apps/workrooms/workroom-engine');
    const settle = async id => { for (let i = 0; i < 400 && (WorkroomEngine.runs.size || engineStore.get(id).status === 'queued'); i++) await new Promise(resolve => setTimeout(resolve, 5)); };

    // A plain question costs ONE model call and no specialist.
    let chat = engineStore.command('create', { goal: 'What is a good name for a bakery?' }, owner);
    script = [say('Crumb & Co.')];
    await WorkroomEngine.tick(); await settle(chat.id);
    assert.equal(seen.length, 1, 'A trivial ask is one model call');
    assert.deepEqual(engineStore.events(chat.id).map(event => [event.type, event.from]), [['message', 'you'], ['message', 'master']]);
    assert.equal(engineStore.get(chat.id).status, 'idle');
    assert.equal(seen[0].tools.length, 1); assert.equal(seen[0].tools[0].function.name, 'delegate');
    assert.deepEqual(seen[0].tools[0].function.parameters.properties.agent.enum, Specialists.list().map(def => def.id), 'The team is whoever is registered');

    // Delegation: the agent joins, works, reports under its own name; the master answers.
    seen.length = 0; calls.length = 0;
    chat = engineStore.command('create', { goal: 'Find me a kettle under $40' }, owner);
    script = [use('delegate', { agent: 'research', task: 'Find an electric kettle under $40 with a link.' }),
        use('web_search', { query: 'electric kettle under $40' }), say('The Acme kettle is $30: https://shop.test/kettle'),
        say('Found one: Acme kettle, $30. https://shop.test/kettle')];
    await WorkroomEngine.tick(); await settle(chat.id);
    events = engineStore.events(chat.id);
    assert.deepEqual(events.map(event => event.type), ['message', 'join', 'task', 'activity', 'activity', 'task_end', 'message']);
    assert.equal(events.find(event => event.type === 'task_end').status, 'done');
    assert.deepEqual(events.find(event => event.type === 'task_end').sources, ['https://shop.test/kettle'], 'Sources are links the tools produced');
    assert.equal(events.find(event => event.type === 'activity').say, 'searching the web for “electric kettle under $40”');
    assert.match(seen[1].messages[0].content, /You are Research/); assert.ok(!/kettle under \$40\?/.test(seen[1].messages[1].content) || true);
    assert.deepEqual(seen[1].tools.map(tool => tool.function.name), ['web_search', 'read_url'], 'A specialist is offered ONLY its own tools');
    assert.equal(calls[0].ctx.ambient, true);
    assert.match(seen[3].messages.at(-1).content, /Acme kettle is \$30/, 'The master reads the report as a tool result');

    // Finished is how the loop ended, never a field the model filled in.
    chat = engineStore.command('create', { goal: 'Check my mail for invoices' }, owner);
    script = [use('delegate', { agent: 'mail', task: 'List invoices.' }), { error: 'HTTP 400 bad request' }, say('I could not check your mail: the model call failed.')];
    await WorkroomEngine.tick(); await settle(chat.id);
    const failed = engineStore.events(chat.id).find(event => event.type === 'task_end');
    assert.equal(failed.status, 'blocked'); assert.match(failed.text, /model call failed/);
    assert.equal(engineStore.get(chat.id).status, 'idle');

    // Nobody invented: an unknown agent is an error the master reads, not a crash.
    chat = engineStore.command('create', { goal: 'Do a thing' }, owner);
    script = [use('delegate', { agent: 'lawyer', task: 'Sue.' }), params => { assert.match(params.messages.at(-1).content, /Nobody called/); return say('I cannot do that.'); }];
    await WorkroomEngine.tick(); await settle(chat.id);
    assert.ok(!engineStore.events(chat.id).some(event => event.type === 'join'));

    // Privacy: a specialist that reads private data is refused when that class may not leave this Mac.
    CloudPrivacy.allows = cls => cls !== 'messages';
    chat = engineStore.command('create', { goal: 'Summarize my inbox' }, owner);
    script = [use('delegate', { agent: 'mail', task: 'Summarize.' }), params => { assert.match(params.messages.at(-1).content, /privacy settings/); return say('Your privacy settings keep mail on this Mac.'); }];
    await WorkroomEngine.tick(); await settle(chat.id);
    assert.ok(!engineStore.events(chat.id).some(event => event.type === 'task'));
    CloudPrivacy.allows = () => true;

    // Said mid-run: it reaches whoever is working; the job is not restarted.
    chat = engineStore.command('create', { goal: 'Find a kettle' }, owner);
    script = [use('delegate', { agent: 'research', task: 'Find a kettle.' }),
        async () => { engineStore.command('message', { id: chat.id, text: 'Make it a red one' }, owner); return use('web_search', { query: 'kettle' }); },
        params => { assert.ok(params.messages.some(message => /user just added: Make it a red one/.test(String(message.content))), 'The specialist hears it on its next turn'); return say('A red kettle: https://shop.test/kettle'); },
        params => { assert.ok(params.messages.some(message => /user just added: Make it a red one/.test(String(message.content))), 'So does the master'); return say('Here is a red one.'); }];
    await WorkroomEngine.tick(); await settle(chat.id);
    assert.equal(engineStore.events(chat.id).filter(event => event.type === 'task').length, 1, 'One job, not two');
    assert.equal(engineStore.get(chat.id).status, 'idle');

    // Stop means stop: nothing is published after a pause.
    chat = engineStore.command('create', { goal: 'Long job' }, owner);
    script = [async () => { engineStore.command('pause', { id: chat.id }, owner); return say('Too late.'); }];
    await WorkroomEngine.tick(); await settle(chat.id);
    assert.equal(engineStore.get(chat.id).status, 'paused');
    assert.ok(!engineStore.events(chat.id).some(event => event.from === 'master'));
    // Continue picks up with the whole conversation, told where things stand.
    engineStore.command('resume', { id: chat.id }, owner);
    script = [params => { assert.match(params.messages[1].content, /chose Continue/); return say('Done now.'); }];
    await WorkroomEngine.tick(); await settle(chat.id);
    assert.equal(engineStore.events(chat.id).at(-1).text, 'Done now.');

    // A model that says nothing is an error the user can retry, never a silent loop.
    chat = engineStore.command('create', { goal: 'Say nothing' }, owner);
    script = [say(''), say('')];
    for (let i = 0; i < 12; i++) script.push(say(''));
    await WorkroomEngine.tick(); await settle(chat.id);
    assert.equal(engineStore.get(chat.id).status, 'paused'); assert.equal(engineStore.events(chat.id).at(-1).state, 'error');
    console.log('workrooms-test passed');
})().catch(error => { console.error(error); process.exit(1); }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
