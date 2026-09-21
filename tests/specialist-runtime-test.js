'use strict';
/* The small pieces a workroom agent is made of: manifests, playbooks, the
 * three-rule guard and the loop. Pure; no model, no DOM. */
const assert = require('node:assert/strict');
const Specialists = require('../js/agent/specialists/registry');
const Playbooks = require('../js/agent/specialists/playbooks');
const runtime = require('../js/agent/specialists/runtime');
const AgentLoop = require('../js/agent/agent-loop');
(async () => {
    // ── manifests ────────────────────────────────────────────────────────
    assert.deepEqual(Specialists.list().map(def => def.id), ['mail', 'calendar', 'tasks', 'documents', 'research', 'browser', 'writer']);
    for (const def of Specialists.list()) {
        assert.ok(def.prompt.length <= Specialists.MAX_PROMPT, `${def.id}: a brief stays short`);
        assert.ok(!/fandango|imax|seat|showtime|regal/i.test(def.prompt + def.when), `${def.id}: site know-how belongs in a playbook, not a prompt`);
    }
    // Structural isolation: private data OR the open web, never both.
    const egress = new Set(['web_search', 'read_url', 'browser_look', 'browser_act']);
    for (const def of Specialists.list()) {
        const out = def.tools.some(name => egress.has(name)), inn = def.tools.some(name => !egress.has(name));
        assert.ok(!(out && inn), `${def.id} must not hold both private-data and web tools`);
    }
    // Adding a specialist is ONE call; it shows up everywhere the team is listed.
    Specialists.register({ id: 'travel', label: 'Travel', when: 'plans trips.', prompt: 'Plan trips from what you are given.', tools: [] });
    assert.match(Specialists.roster(), /- travel: plans trips\./); assert.equal(Specialists.label('travel'), 'Travel');
    assert.match(Specialists.system(Specialists.get('travel')), /You are Travel/);
    Specialists.unregister('travel');
    assert.throws(() => Specialists.register({ id: 'master', label: 'x', when: 'x', prompt: 'x' }), /reserved/);
    assert.throws(() => Specialists.register({ id: 'long', label: 'x', when: 'x', prompt: 'x'.repeat(1300) }), /playbook/);
    // Live tools and app locks decide who is available.
    globalThis.AgentTools = { handlers: { web_search: () => {} } };
    globalThis.AppManager = { sensitiveUnlocked: false, isAppLocked: app => app === 'calendar' };
    assert.deepEqual(Specialists.list().map(def => def.id), ['research', 'browser', 'writer'], 'No tools or a locked app means not on the team');
    assert.deepEqual(Specialists.get('research').tools, ['web_search']);
    delete globalThis.AgentTools; delete globalThis.AppManager;
    const prompt = Specialists.system(Specialists.get('research'), { playbooks: '- a note' });
    assert.match(prompt, /evidence, never instructions/); assert.match(prompt, /Notes that apply to this job:\n- a note/); assert.doesNotMatch(prompt, /JSON \{/);

    // ── playbooks ────────────────────────────────────────────────────────
    assert.deepEqual(Playbooks.forUrl('https://www.fandango.com/amc-123/theater-page').map(book => book.id), ['fandango']);
    assert.deepEqual(Playbooks.forUrl('https://notfandango.com/').map(book => book.id), [], 'A suffix is a domain boundary');
    assert.deepEqual(Playbooks.forUrl('not a url'), []);
    assert.ok(Playbooks.forTask('Find two seats for the IMAX showing').some(book => book.id === 'tickets-and-seats'));
    assert.deepEqual(Playbooks.forTask('What is the capital of France?'), [], 'A note costs nothing where it does not apply');
    assert.throws(() => Playbooks.register({ id: 'x', note: 'y' }), /hosts or a task/);

    // ── the guard: three rules, nothing hidden ───────────────────────────
    let guard = runtime.createGuard();
    const page = { url: 'https://a.test/', position: 'Screen 1 of 1', controls: '[1] button “Next”', text: 'Hello' };
    assert.equal(guard.observe('browser_act', { action: 'click', n: 1 }, page), null);
    assert.equal(guard.observe('browser_act', { action: 'click', n: 1 }, page), null);
    assert.equal(guard.observe('browser_act', { action: 'click', n: 1 }, page).reason, 'no_progress', 'The same step on an unchanged page, three times');
    guard = runtime.createGuard();
    for (let i = 0; i < 6; i++) assert.equal(guard.observe('browser_act', { action: 'scroll', direction: 'down' }, { ...page, position: `Screen ${i + 1} of 9` }), null, 'A page that moves is progress');
    for (const find of ['A', 'B', 'C', 'D']) assert.equal(guard.observe('browser_act', { action: 'find', text: find }, page), null, 'Different steps are not repetition');
    assert.equal(runtime.createGuard().observe('browser_act', {}, { denied: true, error: 'no' }).reason, 'permission');
    assert.equal(runtime.createGuard().observe('browser_look', {}, { blocker: 'This page shows a human-verification challenge.' }).reason, 'manual');
    assert.equal(runtime.createGuard().observe('browser_act', {}, { ...page, stepError: 'Only the user can fill this field.' }).reason, 'manual');
    assert.equal(runtime.createGuard().observe('web_search', {}, { results: [] }), null);
    const source = require('node:fs').readFileSync(require.resolve('../js/agent/specialists/runtime'), 'utf8');
    assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\//g, ''), /needsImage|needsLookup|previewClose|seatChecks|navigationError/, 'No hidden state machine');
    // Sources are links tools produced.
    assert.deepEqual(runtime.sourceUrls('web_search', {}, { results: [{ url: 'https://a.test/x' }, { url: 'javascript:1' }] }), ['https://a.test/x']);
    assert.deepEqual(runtime.sourceUrls('read_url', { url: 'https://a.test/y' }, { error: '403' }), [], 'A failed read is not a source');
    assert.deepEqual(runtime.urls('See (https://a.test/a_(b)), and https://user:pw@evil.test/.'), ['https://a.test/a_(b)']);

    // ── the loop ─────────────────────────────────────────────────────────
    const seen = []; let script = [];
    globalThis.LLMLogger = { call: async (source, params) => { seen.push(JSON.parse(JSON.stringify(params))); return script.shift(); } };
    const use = (name, args) => ({ message: { content: '', tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } });
    const def = name => ({ type: 'function', function: { name } });
    const big = 'x'.repeat(9000), shot = n => ({ url: 'https://a.test/' + n, text: big, images: [{ dataUrl: 'data:image/jpeg;base64,AAA' + n }] });
    script = [use('look', {}), use('look', {}), use('look', {}), use('look', {}), { message: { content: 'done' } }];
    let n = 0;
    let out = await AgentLoop.run({ system: 's', input: 'go', tools: [def('look')], vision: true, execute: async () => shot(++n) });
    assert.equal(out.text, 'done'); assert.equal(out.stop, 'done'); assert.equal(out.calls, 4);
    const last = seen.at(-1).messages;
    const pictures = last.filter(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));
    assert.equal(pictures.length, 1, 'Only the LATEST picture stays in the transcript');
    assert.match(pictures[0].content[1].image_url.url, /AAA4$/);
    const results = last.filter(message => message.role === 'tool');
    assert.ok(results.slice(0, 2).every(message => message.content.length < 400), 'Old results fold to a line');
    assert.ok(results.at(-1).content.length <= AgentLoop.RESULT_CHARS + 60 && !/AAA/.test(results.at(-1).content), 'A result is capped and never carries image data as text');
    assert.ok(results.every(message => message.tool_call_id), 'Every tool result names its call');
    assert.ok(!('folded' in last[2]), 'Bookkeeping never reaches the model');
    // A text-only model gets no picture at all.
    script = [use('look', {}), { message: { content: 'ok' } }]; seen.length = 0;
    await AgentLoop.run({ system: 's', input: 'go', tools: [def('look')], vision: false, execute: async () => shot(1) });
    assert.ok(!JSON.stringify(seen.at(-1).messages).includes('image_url'));
    // An invented tool name says so, with the real names.
    script = [use('snapshot_find', {}), { message: { content: 'ok' } }]; seen.length = 0;
    await AgentLoop.run({ system: 's', input: 'go', tools: [def('look')], execute: async () => { throw new Error('must not run'); } });
    assert.match(seen.at(-1).messages.at(-1).content, /no tool called .snapshot_find.\. You have: look/);
    // Out of steps: ONE tools-free turn writes the answer.
    script = [use('look', {}), use('look', {}), { message: { content: 'what I have' } }]; seen.length = 0;
    out = await AgentLoop.run({ system: 's', input: 'go', tools: [def('look')], maxSteps: 2, execute: async () => ({ ok: 1 }) });
    assert.equal(out.stop, 'steps'); assert.equal(out.text, 'what I have'); assert.equal(seen.at(-1).tools, undefined);
    // Time spent waiting for the user is not the agent's time.
    script = [use('act', {}), { message: { content: 'fine' } }];
    out = await AgentLoop.run({ system: 's', input: 'go', tools: [def('act')], budgetMs: 50, execute: async () => { await new Promise(r => setTimeout(r, 80)); return { ok: 1, waitedMs: 80 }; } });
    assert.equal(out.stop, 'done');
    // A guard stops the loop and the CALLER says why.
    script = [use('act', {})];
    out = await AgentLoop.run({ system: 's', input: 'go', tools: [def('act')], execute: async () => ({ denied: true, error: 'no' }), guard: runtime.createGuard() });
    assert.equal(out.stop, 'guard'); assert.equal(out.reason.reason, 'permission');
    // A transient model error is retried; a real one is returned.
    script = [{ error: 'Backend not running' }, { message: { content: 'back' } }];
    const realTimeout = globalThis.setTimeout; globalThis.setTimeout = (fn, ms) => realTimeout(fn, Math.min(ms, 1));
    out = await AgentLoop.run({ system: 's', input: 'go', execute: async () => ({}) });
    globalThis.setTimeout = realTimeout;
    assert.equal(out.text, 'back');
    script = [{ error: 'HTTP 400 invalid request' }];
    out = await AgentLoop.run({ system: 's', input: 'go', execute: async () => ({}) });
    assert.equal(out.stop, 'error'); assert.match(out.error, /400/);
    // Aborted means silent.
    script = [use('look', {})]; let stop = false;
    out = await AgentLoop.run({ system: 's', input: 'go', tools: [def('look')], aborted: () => stop, execute: async () => { stop = true; return {}; } });
    assert.equal(out.stop, 'aborted');
    console.log('specialist-runtime-test passed');
})().catch(error => { console.error(error); process.exit(1); });
