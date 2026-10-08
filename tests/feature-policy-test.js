// Release flags: local experiment opt-ins cannot release unfinished features.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Policy = require('../js/core/feature-policy');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const bundled = JSON.parse(read('remote-config.json'));
assert.equal(bundled.featureFlags.brokerage, false, 'institution linking is not released');
assert.equal(bundled.featureFlags.teach, false, 'taught tasks are not released');
assert.equal(Policy.resolve().teach, false, 'missing config fails closed');
for (const value of ['true', 1, null, [], {}]) {
    assert.equal(Policy.resolve(bundled, { featureFlags: { teach: value } }).teach, false);
}
assert.equal(Policy.resolve(bundled, {}).brokerage, false, 'older remote/cache cannot remove bundled restriction');
for (const value of ['true', 1, null, [], {}]) {
    assert.equal(Policy.resolve(bundled, { featureFlags: { brokerage: value } }).brokerage, false);
}
assert.equal(Policy.resolve(bundled, { featureFlags: { brokerage: true } }).brokerage, true);
assert.equal(Policy.resolve({ featureFlags: { brokerage: true } }, { featureFlags: { brokerage: false } }).brokerage, false);

function renderer(flags, offline = false) {
    const store = new Map([['anjadheFeatures', 'brokerage,teach,sharing,mobilesync,unknown']]);
    const sources = [];
    const ctx = vm.createContext({
        window: { electronConfig: { featureFlags() { if (offline) throw Error('Unavailable'); return flags; } } },
        localStorage: { getItem: k => store.get(k), setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
        Sources: { register: def => sources.push(def) },
    });
    vm.runInContext(read('js/core/feature-policy.js'), ctx);
    vm.runInContext(read('js/core/features.js'), ctx);
    vm.runInContext(read('js/core/source-adapters.js'), ctx);
    const registered = [];
    ctx.AgentTools = { GROUP_INFO: {}, register: def => registered.push(def.function.name) };
    vm.runInContext(read('js/core/taught-tasks.js'), ctx);
    vm.runInContext(read('js/agent/teach-tools.js'), ctx);
    vm.runInContext(read('js/core/simple-settings.js'), ctx);
    vm.runInContext(read('js/core/simple-settings-pages.js'), ctx);
    vm.runInContext(read('js/agent/help-docs.js'), ctx);
    return { features: ctx.window.FEATURES, store, sources, ctx, registered };

}
for (const [flags, offline] of [[{}, false], [{ brokerage: false }, false], [{}, true]]) {
    const { features, sources, store, ctx, registered } = renderer(flags, offline);
    assert.equal(features.isEnabled('brokerage'), false, 'old local opt-in cannot bypass release policy');
    assert.equal(features.all().brokerage, false);
    assert.equal(features.experimental, undefined, 'experiment listing API is retired');
    assert.equal(features.setOverride, undefined, 'local override API is retired');
    assert.equal(sources.some(s => s.id === 'institutions'), false, 'no connector or Privacy row');
    assert.equal(features.isEnabled('teach'), false);
    assert.equal(features.isEnabled('teach'), false, 'local override cannot release teaching');
    assert.equal(registered.length, 0, 'no teaching tools or group registered');
    assert.equal(ctx.AgentTools.GROUP_INFO.teach, undefined);
    assert.equal(vm.runInContext('SimpleSettings._taughtRowHtml()', ctx), '');
    assert.equal(vm.runInContext('SimpleSettings._taughtHtml()', ctx), '');
    assert.equal(vm.runInContext("JSON.stringify(HelpDocs).includes('Teach it a website task')", ctx), false);
    // A stale page route returns to Memory without browser setup/polling.
    ctx.document = { querySelector: () => ({}) };
    vm.runInContext(`
        SimpleSettings._page = 'taught';
        SimpleSettings._lit = SimpleSettings._returnMemoryPage = SimpleSettings._stopPoll = () => {};
        SimpleSettings._renderMemory = () => { globalThis.memoryShown = true; };
        SimpleSettings.render();
    `, ctx);
    assert.equal(ctx.memoryShown, true);
    assert.equal(features.isEnabled('brokerage'), false);
    assert.equal(features.isEnabled('sharing'), false, 'old sharing opt-in is ignored');
    assert.equal(features.isEnabled('mobilesync'), false, 'old paired-device opt-in is ignored');
    assert.equal(features.isEnabled('commitments'), true, 'other code defaults still apply');
    assert.equal(features.isEnabled('unknown'), false, 'stale unknown overrides stay inert');
    assert.ok(store.get('anjadheFeatures').includes('sharing'), 'legacy data need not be deleted');
}
const released = renderer({ brokerage: true, teach: true, sharing: true, mobilesync: true });
assert.equal(released.features.isEnabled('teach'), true);
assert.equal(released.registered.length, 5, 'explicit release enables the teaching tools');
assert.equal(vm.runInContext("JSON.stringify(HelpDocs).includes('Teach it a website task')", released.ctx), true);
assert.equal(released.features.isEnabled('brokerage'), true);
assert.ok(released.sources.some(s => s.id === 'institutions'));
assert.equal(released.features.isEnabled('sharing'), true);
assert.equal(released.features.isEnabled('mobilesync'), true);
for (const name of ['sharing', 'mobilesync']) {
    assert.equal(bundled.featureFlags[name], false);
    assert.equal(Policy.resolve()[name], false);
    for (const value of ['true', 1, null]) {
        assert.equal(Policy.resolve(bundled, { featureFlags: { [name]: value } })[name], false);
    }
}
assert.equal(read('index.html').includes('settings-experimental-card'), false);
assert.equal(read('js/apps/settings/settings-app.js').includes('_renderExperimental'), false);

// Exercise the real Connect request boundary with injected dependencies.
// Every brokerage route is blocked before credentials, network or browser use.
(async () => {
    const src = read('main.js');
    const start = src.indexOf('async function connectCall(');
    const end = src.indexOf('function brokerageResult(', start);
    let enabled = false, migrated = 0, requests = 0;
    const ctx = vm.createContext({
        currentFeatureFlags: () => ({ brokerage: enabled }),
        migrateConnectInstallId: async () => { migrated++; },
        getSearchApiKey: () => 'fixture-key', CONNECT_API_URL: 'https://fixture.invalid',
        AbortSignal,
        fetch: async () => { requests++; return { status: 200, text: async () => '{"ok":true}' }; },
    });
    vm.runInContext(src.slice(start, end) + '\nthis.call = connectCall;', ctx);
    for (const route of ['link', 'link/fixture-token', 'items', 'holdings', 'transactions', 'accounts', 'transactions/sync', 'unlink']) {
        const result = await ctx.call('/v1/brokerage/' + route);
        assert.equal(result.data.code, 'disabled', route);
    }
    assert.equal(migrated, 0);
    assert.equal(requests, 0);
    assert.equal((await ctx.call('/v1/search')).data.ok, true, 'other Connect services unaffected');
    enabled = true;
    assert.equal((await ctx.call('/v1/brokerage/items')).data.ok, true, 'published true permits the existing route');
    enabled = false;
    assert.equal((await ctx.call('/v1/brokerage/items')).data.code, 'disabled', 'loaded kill switch applies to next call');
    assert.equal(requests, 2);
    // Exercise the actual browser IPC boundary: no recorder starts while off.
    let browserHandler, starts = 0, stops = 0;
    const frame = {}, event = { sender: { id: 1, mainFrame: frame }, senderFrame: frame };
    const browserCtx = vm.createContext({
        ipcMain: { handle: (_name, handler) => { browserHandler = handler; } },
        backgroundMode: { windows: new Map([[1, true]]) },
        currentFeatureFlags: () => ({ teach: enabled }),
        workroomBrowser: {
            startRecording: () => { starts++; return { ok: true }; },
            stopRecording: () => { stops++; return { ok: true }; },
            recordingStatus: () => ({ recording: true }),
        },
        chromeBrowser: { state: () => ({ connected: true }) },
    });
    const browserStart = src.indexOf("ipcMain.handle('agent-browser',");
    const browserEnd = src.indexOf("ipcMain.handle('workrooms',", browserStart);
    vm.runInContext(src.slice(browserStart, browserEnd), browserCtx);
    await assert.rejects(browserHandler(event, 'record-start'), /not enabled/);
    await assert.rejects(browserHandler(event, 'record-status'), /not enabled/);
    assert.equal(starts, 0);
    assert.equal((await browserHandler(event, 'chrome-state')).connected, true);
    enabled = true;
    assert.equal((await browserHandler(event, 'record-start')).ok, true);
    assert.equal(starts, 1);
    enabled = false;
    await assert.rejects(browserHandler(event, 'record-start'), /not enabled/);
    await browserHandler(event, 'record-stop');
    assert.equal(stops, 1, 'can still clean up a recording started before disabling');
    // The real channel initializers must not even import/connect while off.
    let channelAttempts = 0;
    const channelCtx = vm.createContext({
        currentFeatureFlags: () => ({ sharing: enabled, mobilesync: enabled }),
        require: () => { channelAttempts++; throw Error('fixture import boundary'); },
        console: { warn() {} },
    });
    const phoneStart = src.indexOf('let channelInitStarted = false;');
    const phoneEnd = src.indexOf('// IPC: phone<->Mac', phoneStart);
    const peerStart = src.indexOf('let peerChannel = null;');
    const peerEnd = src.indexOf('function peersInfo()', peerStart);
    vm.runInContext(src.slice(phoneStart, phoneEnd) + src.slice(peerStart, peerEnd), channelCtx);
    await channelCtx.initDesktopChannel();
    await channelCtx.initPeerChannel();
    assert.equal(channelAttempts, 0, 'off means no channel imports or connections');
    enabled = true;
    await channelCtx.initDesktopChannel();
    await channelCtx.initPeerChannel();
    assert.equal(channelAttempts, 2, 'explicit release allows each initializer');

    // Disabled IPC calls cannot pair, invite, send or start either channel,
    // even if an older window/channel is still around.
    enabled = false;
    const handlers = new Map();
    let ipcEffects = 0;
    const effect = () => { ipcEffects++; return { ok: true }; };
    const ipcCtx = vm.createContext({
        currentFeatureFlags: () => ({ sharing: enabled, mobilesync: enabled }),
        ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
        initDesktopChannel: effect, initPeerChannel: effect,
        desktopChannel: { beginPairing: effect },
        peerChannel: { createInvite: effect, acceptInvite: effect, send: effect },
    });
    for (const name of ['channel-ensure', 'channel-begin-pairing', 'peers-ensure', 'peers-create-invite', 'peers-accept-invite', 'peers-send', 'channel-remote-access-set']) {
        const at = src.indexOf(`ipcMain.handle('${name}',`);
        const end = src.indexOf('\n});', at) + 4;
        vm.runInContext(src.slice(at, end), ipcCtx);
        assert.match((await handlers.get(name)({}, true, {})).error, /not enabled/, name);
    }
    assert.equal(ipcEffects, 0);
    enabled = true;
    for (const name of ['channel-ensure', 'peers-ensure', 'peers-create-invite', 'peers-accept-invite', 'peers-send']) {
        assert.equal((await handlers.get(name)({}, 'fixture', {})).ok, true, name);
    }
    assert.equal(ipcEffects, 5);
    console.log('feature-policy: defaults, retired overrides/UI, tools, Connect, recording and channel gates passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
