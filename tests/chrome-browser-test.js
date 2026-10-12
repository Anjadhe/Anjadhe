'use strict';
const assert = require('node:assert/strict'), net = require('node:net'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once } = require('node:events'), { spawn } = require('node:child_process');
const { encode, reader, MAX_FRAME } = require('../js/main/browser/protocol');
const NativeBridge = require('../js/main/browser/native-bridge');
const { ChromeRuntime } = require('../js/main/browser/chrome-runtime');
(async () => {
    const values = new Map([['workroom-browser-engine', 'chrome']]);
    const runtime = new ChromeRuntime({ userData: '/tmp/unused-browser-unit-fixture', settings: { get: key => values.get(key) } });
    let launches = 0, ensures = 0, release;
    runtime.prepare = async () => {};
    runtime.connection = { socket: null, request: async operation => { assert.equal(operation, 'ensure'); ensures++; } };
    runtime.spawnChrome = async options => { assert.equal(options.background, true); launches++; await new Promise(resolve => { release = () => { runtime.connection.socket = true; resolve(); }; }); };
    const pending = [runtime.ensure(), runtime.ensure()];
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runtime.state().starting, true); assert.equal(launches, 1, 'Concurrent requests start one Chrome process');
    release(); await Promise.all(pending);
    assert.equal(ensures, 2); assert.equal(runtime.state().starting, false);
    await runtime.ensure(); assert.equal(launches, 1, 'A connected browser is reused');
    runtime.connection.socket = null;
    const cancelled = assert.rejects(runtime.ensure(), /cancelled/);
    await new Promise(resolve => setImmediate(resolve));
    await runtime.takeover(); release(); await cancelled;
    runtime.connection.socket = null; runtime.retryAfter = Date.now() + 30000;
    await assert.rejects(runtime.ensure(), /could not reconnect/);
    assert.equal(launches, 2, 'A failed launch cannot cause a rapid restart loop');
    runtime.retryAfter = 0; values.clear();
    await assert.rejects(runtime.ensure(), /set up the browser/);
    assert.equal(launches, 2, 'An unconfigured runtime does not launch Chrome');
    // An older loaded copy is asked ONCE to reload itself, only while nobody drives and nothing records.
    const asked = [];
    runtime.sourceVersion = '0.1.2'; runtime.connection.socket = true;
    runtime.connection.request = async operation => { asked.push(operation); };
    runtime.extensionVersion = '0.1.2'; assert.equal(runtime.maybeReload(), false, 'Same version: nothing to do');
    runtime.extensionVersion = '0.1.1'; runtime.target = { control: 'agent' }; assert.equal(runtime.maybeReload(), false, 'Never under a driving agent');
    runtime.target = { control: 'human', recording: { active: true } }; assert.equal(runtime.maybeReload(), false, 'Never during a recording');
    runtime.target = { control: 'human' }; assert.equal(runtime.maybeReload(), true); assert.equal(runtime.maybeReload(), false, 'Asked once per loaded version');
    assert.deepEqual(asked, ['reload']); assert.equal(runtime.state().stale, true); assert.equal(runtime.state().extensionVersion, '0.1.1');
    runtime.extensionVersion = undefined; runtime.connection.socket = null;
    // Setting up (docs/TEACH.md): the host name is the one the packaged extension carries; the
    // store listing opens in nenva's own profile and the flow waits for the connection; with no
    // listing yet it is chrome://extensions plus the folder.
    assert.equal(ChromeRuntime.HOST_NAME, fs.readFileSync(path.resolve(__dirname, '../browser-extension/config.js'), 'utf8').match(/'([^']+)'/)[1]);
    const opened = [], shown = [];
    let remote = { storeUrl: 'https://chromewebstore.google.com/detail/nenva-browser/abc' };
    runtime.remote = () => remote; runtime.findChrome = () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    runtime.spawnChrome = async options => { opened.push(options.url); setTimeout(() => { runtime.connection.socket = true; }, 30); };
    let setup = await runtime.setUp({ waitMs: 2000, showFolder: file => shown.push(file) });
    assert.deepEqual([setup.connected, setup.mode, opened, shown], [true, 'store', [remote.storeUrl], []], 'The store page, in the dedicated profile, and the connection noticed');
    assert.deepEqual(await runtime.setUp({ waitMs: 0 }), { connected: true, already: true });
    runtime.connection.socket = null; remote = { storeUrl: 'https://evil.example/x' };
    runtime.spawnChrome = async options => { opened.push(options.url); };
    setup = await runtime.setUp({ waitMs: 0, showFolder: file => shown.push(file) });
    assert.deepEqual([setup.connected, setup.mode, opened.at(-1)], [false, 'unpacked', 'chrome://extensions/'], 'Only a Chrome Web Store address is a listing; otherwise the unpacked steps');
    assert.match(shown[0], /manifest\.json$/);
    runtime.findChrome = () => null;
    assert.deepEqual(await runtime.setUp({ waitMs: 0 }), { connected: false, chromeMissing: true });
    runtime.findChrome = () => null;
    const received = [], errors = [], read = reader(value => received.push(value), error => errors.push(error));
    const frame = encode({ text: 'fragmented 🌍' });
    for (const byte of frame) read(Buffer.from([byte]));
    read(Buffer.concat([encode({ n: 1 }), encode({ n: 2 })]));
    assert.deepEqual(received, [{ text: 'fragmented 🌍' }, { n: 1 }, { n: 2 }]);
    const oversized = Buffer.alloc(4); oversized.writeUInt32LE(MAX_FRAME + 1); read(oversized); read(frame);
    assert.equal(errors.length, 1); assert.equal(received.length, 3);
    assert.throws(() => encode({ text: 'x'.repeat(MAX_FRAME) }), /large/);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anjadhe-chrome-protocol-'));
    const bridge = new NativeBridge({ extensionId: 'a'.repeat(32) });
    let host;
    try {
        const port = await bridge.listen();
        const forged = net.connect(port, '127.0.0.1');
        forged.on('error', () => {});
        forged.write(encode({ kind: 'hello', token: '0'.repeat(64), extensionId: bridge.extensionId }));
        await once(forged, 'close'); assert.ok(!bridge.socket, 'Forged clients cannot connect');
        const config = path.join(root, 'host.json');
        fs.writeFileSync(config, JSON.stringify({ port, token: bridge.token, extensionId: bridge.extensionId }), { mode: 0o600 });
        const hostPath = path.resolve(__dirname, '../js/main/browser/native-host.js');
        const denied = spawn(process.execPath, [hostPath, config, 'chrome-extension://' + 'b'.repeat(32) + '/']);
        assert.equal((await once(denied, 'exit'))[0], 1, 'Another extension cannot use the host');
        const electronHost = process.env.ANJADHE_TEST_ELECTRON === '1';
        const hostEnv = { ...process.env, ANJADHE_DATA_ROOT: root }; delete hostEnv.ELECTRON_RUN_AS_NODE;
        host = spawn(electronHost ? require('electron') : process.execPath,
            [...(electronHost ? [path.resolve(__dirname, '..'), '--anjadhe-browser-host'] : [hostPath]), config, 'chrome-extension://' + bridge.extensionId + '/'], { env: hostEnv });
        host.stdout.on('data', reader(message => {
            if (message.kind === 'command' && message.operation !== 'timeout') host.stdin.write(encode({ kind: 'result', id: message.id, value: { fixture: true } }));
        }, error => { throw error; }));
        await once(bridge, 'connected');
        assert.deepEqual(await bridge.request('ensure'), { fixture: true });
        await assert.rejects(bridge.request('timeout', {}, 30), /did not finish/);
        await once(host, 'exit'); host = null;
        assert.ok(!bridge.socket, 'Timeout disconnects to invalidate queued input');
    } finally { host?.kill(); bridge.close(); fs.rmSync(root, { recursive: true, force: true }); }
    console.log('Chrome: background startup/reuse/cancellation, fragmented frames, bounds, forged client, extension origin, native host and timeout passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
