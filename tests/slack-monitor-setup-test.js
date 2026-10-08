'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { SlackMonitorSetup, modelFor } = require('../js/main/slack-monitor-setup');
const { SlackMonitorIntake } = require('../js/main/slack-monitor-intake');
const scope = { workspaceId: 'T123', userId: 'U123', conversationIds: ['D123'] };
const code = value => error => error.code === value;

function fixture() {
    let data, available = true, time = 1770000000000, confirm = async () => true, reads = 0, reviewed;
    const frame = {}, event = { sender: { id: 1, mainFrame: frame }, senderFrame: frame };
    const models = [{ id: 'local', model: 'model-12b', label: 'nenva local', engine: 'llamacpp', privateKey: 'CANARY' },
        { id: 'cloud', model: 'nenva-cloud', label: 'nenva cloud', engine: 'anjadhe' }];
    let reader = { identity: async () => ({ ...scope, workspaceName: 'Test workspace' }),
        conversations: async ({ cursor }) => { reads++; return { ...scope, conversations: cursor
            ? [{ id: 'C456', name: 'launch', type: 'public_channel' }] : [{ id: 'D123', name: '<img src=x onerror=bad()>', type: 'im', peerId: 'U456' }], nextCursor: cursor ? '' : 'page2' }; } };
    const store = { get: () => data, set: (_, value) => { data = structuredClone(value); } };
    const mcp = { slackReader: () => reader };
    const intake = new SlackMonitorIntake({ store, readerFor: () => reader, allowed: () => true, now: () => time });
    const runtime = { enabled: () => available, intake, status: () => ({ ...intake.status(), available }) };
    const setup = new SlackMonitorSetup({ runtime, mcp, models: () => models,
        trusted: e => e.sender.id === 1 && e.senderFrame === e.sender.mainFrame,
        confirm: async (e, review) => { reviewed = review; return confirm(e, review); }, now: () => time });
    return { event, setup, runtime, models, get data() { return data; }, get reads() { return reads; }, get reviewed() { return reviewed; },
        disable() { available = false; }, advance(ms) { time += ms; }, confirm(fn) { confirm = fn; },
        switchReader() { reader = { ...reader }; }, setReader(value) { reader = value; } };
}

async function boundary() {
    for (const model of ['x'.repeat(201), 'has\ncontrol', ' ']) {
        assert.throws(() => modelFor({ id: 'model', engine: 'llamacpp', model }), code('model_unavailable'));
    }
    let f = fixture();
    assert.equal(f.setup.status(f.event).configured, false);
    await assert.rejects(f.setup.begin({ ...f.event, senderFrame: {} }, 'slack'), code('app_window_required'));
    assert.equal(f.reads, 0);
    f.disable(); await assert.rejects(f.setup.begin(f.event, 'slack'), code('not_available'));
    assert.equal(f.reads, 0, 'release gate blocks even picker reads');
    f = fixture();
    const draft = await f.setup.begin(f.event, 'slack');
    assert.ok(!JSON.stringify(draft).includes('CANARY'));
    assert.equal(f.data, undefined, 'browsing choices stores no observation consent');
    await assert.rejects(f.setup.review(f.event, { session: draft.session, conversationIds: ['C999'], modelId: 'local' }), code('invalid_scope'));
    await assert.rejects(f.setup.review(f.event, { session: draft.session, conversationIds: ['D123'], modelId: 'invented' }), code('model_unavailable'));
    assert.equal(f.reviewed, undefined);
    await f.setup.more(f.event, draft.session);
    f.confirm(async () => false);
    assert.equal((await f.setup.review(f.event, { session: draft.session, conversationIds: ['D123'], modelId: 'local' })).cancelled, true);
    assert.equal(f.data, undefined);
    f.confirm(async () => true);
    await f.setup.review(f.event, { session: draft.session, conversationIds: ['D123', 'C456'], modelId: 'cloud' });
    assert.equal(f.data.config.destination, 'cloud');
    assert.equal(f.data.config.analysisModel.id, 'cloud');
    assert.equal(f.reviewed.destination, 'nenva cloud');
    assert.deepEqual(f.data.config.scope.conversationIds, ['C456', 'D123']);
    assert.equal(f.reads, 2, 'activation does not read message history');
    assert.equal(f.setup.sessions.size, 0, 'review session is consumed once');
    await assert.rejects(f.setup.review(f.event, { session: draft.session, conversationIds: ['D123'], modelId: 'cloud' }), code('setup_expired'));
    f.setup.control(f.event, 'pause');
    f.models[1].model = 'different-cloud-model';
    assert.throws(() => f.setup.control(f.event, 'resume'), code('model_changed'));
    f.setup.control(f.event, 'stop'); assert.equal(f.data.config, null);

    for (const change of ['model', 'window', 'connection', 'expiry', 'gate', 'stop']) {
        f = fixture(); const d = await f.setup.begin(f.event, 'slack');
        f.confirm(async () => {
            if (change === 'model') f.models[0].engine = 'anjadhe';
            if (change === 'window') f.setup.close(1);
            if (change === 'connection') f.switchReader();
            if (change === 'expiry') f.advance(11 * 60000);
            if (change === 'gate') f.disable();
            if (change === 'stop') f.runtime.intake.stop();
            return true;
        });
        await assert.rejects(f.setup.review(f.event, { session: d.session, conversationIds: ['D123'], modelId: 'local' }));
        assert.ok(!f.data?.config, `${change} during review invalidates approval`);
    }

    f = fixture();
    let finish;
    f.setReader({ identity: () => new Promise(resolve => { finish = resolve; }), conversations() { throw new Error('must not run'); } });
    const pending = f.setup.begin(f.event, 'slack');
    f.setup.cancel(f.event); finish(scope);
    await assert.rejects(pending, code('setup_expired'));
    assert.equal(f.data, undefined);
}

async function ui() {
    const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' }), w = dom.window;
    w.eval(fs.readFileSync('js/core/slack-connector.js', 'utf8') + '\nwindow.connector = SlackConnector;');
    const c = w.connector, esc = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
    c._monitor = { available: false, configured: false };
    assert.equal(c.monitoringHtml(esc), '', 'unreleased feature has no working-looking switch');
    c._monitor = { available: true, configured: false };
    assert.match(c.monitoringHtml(esc), /Set up monitoring/);
    c._setup = { workspaceName: 'Team', selected: new Set(), modelId: '', conversations: [{ id: 'D123', name: '<img src=x onerror=bad()>', type: 'im' }],
        models: [{ id: 'local', label: 'nenva local', engine: 'llamacpp' }], more: false };
    const main = w.document.querySelector('main'); main.innerHTML = c.monitoringHtml(esc);
    assert.equal(main.querySelector('img'), null, 'Slack names are data, never markup');
    const input = main.querySelector('input'); input.checked = true; c.monitoringChange(input);
    assert.deepEqual([...c._setup.selected], ['D123']);
    const select = main.querySelector('select'); select.value = 'local'; c.monitoringChange(select);
    assert.equal(c._setup.modelId, 'local');
    for (let i = 0; i < 20; i++) c._setup.selected.add(`C${i}`);
    input.dataset.slackConversation = 'D999'; input.checked = true; c.monitoringChange(input);
    assert.equal(input.checked, false);
    c._monitor = { available: false, configured: true, paused: true };
    assert.match(c.monitoringHtml(esc), /Monitoring unavailable/);
    assert.doesNotMatch(c.monitoringHtml(esc), /slack-monitor-resume|slack-monitor-review/);
    w.electronMCP = { listServers: async () => [{ name: 'slack', url: c.URL, auth: 'oauth', enabled: true, authStatus: 'connected' }] };
    w.electronSlackMonitor = { status: async () => { throw new Error('unavailable'); } };
    await c.refresh();
    assert.equal(c.status().on, true);
    assert.equal(c.status().error, false, 'monitor status failure cannot break on-demand Slack');
    assert.equal(c._monitor, null);
    dom.window.close();
}

(async () => { await boundary(); await ui(); console.log('Slack monitoring setup: trusted review, pinned scope/model, stale consent and UI passed'); })()
    .catch(error => { console.error(error); process.exitCode = 1; });
