'use strict';
// Opt-in three-runtime check: Electron SQLite ↔ Connect HTTP ↔ Swift SQLite.
// Every database and credential belongs to this throwaway loopback fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
async function macPeer() {
    const Database = require('better-sqlite3');
    const crypto = require('node:crypto');
    const { MacRecordStore } = require('../js/sync/mac-record-store');
    const { MailboxClient, MacDeliveryCoordinator } = require('../js/sync/mailbox-client');
    const vector = require('../fixtures/encrypted-operation/vector.json');
    const [mode, file, endpoint] = process.argv.slice(2);
    const base = new URL(endpoint);
    assert.equal(base.hostname, '127.0.0.1'); assert.equal(base.protocol, 'http:'); assert.ok(base.port);
    const db = new Database(file);
    try {
        db.pragma('journal_mode = WAL'); db.exec('CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT)');
        const store = new MacRecordStore(db); store.createDataset('fixture', 'a');
        const peerKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]), format: 'der', type: 'pkcs8' });
        const peerPublic = crypto.createPublicKey(peerKey).export({ format: 'der', type: 'spki' }).subarray(-32);
        const transport = new MailboxClient({ baseURL: 'https://fixture.invalid', credential: 'nsync_' + '1'.repeat(64), fetchImpl: (url, options) => {
            const local = new URL(url); local.protocol = base.protocol; local.host = base.host;
            return fetch(local, options);
        } });
        const delivery = new MacDeliveryCoordinator({ store, transport, dataset: 'fixture', datasetKey: Buffer.from(vector.datasetKey, 'hex'),
            signingSeed: Buffer.from(vector.signingSeed, 'hex'), authorizedWriters: { a: Buffer.from(vector.publicKey, 'hex'), b: peerPublic } });
        if (mode === '--prepare') store.appendLocal({ dataset: 'fixture', type: 'note', id: 'n', mutation: { kind: 'edit', fields: { content: 'Written on device A' } }, expectedFrontier: {} });
        await delivery.synchronize();
        if (mode === '--finish') {
            assert.deepEqual(store.frontier('fixture'), { a: 1, b: 1 });
            assert.equal(store.record('fixture', 'note', 'n').fields.content.value, 'Edited on device B');
            assert.equal(store.outbox('fixture').length, 1);
            assert.equal(store.deliveryState('fixture').uploadedSequence, 1);
            console.log('Mac → encrypted HTTP mailbox → Swift → encrypted HTTP mailbox → reopened Mac store: passed');
        }
    } finally { db.close(); }
}
async function integration() {
    const fixture = path.join(process.env.NENVA_CONNECT_REPO || path.resolve(root, '../anjadhe-connect'), 'test/sync-native-fixture.js');
    assert.ok(fs.existsSync(fixture), 'Connect fixture required; set NENVA_CONNECT_REPO');
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'nenva-sync-interop-'));
    const server = spawn(process.execPath, [fixture], { stdio: ['ignore', 'pipe', 'inherit'] });
    const stopped = new Promise(resolve => server.once('exit', resolve));
    const run = (command, args, env = {}) => new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' });
        child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
    });
    try {
        const endpoint = await new Promise((resolve, reject) => {
            let output = '';
            const timer = setTimeout(() => reject(new Error('Fixture startup timed out')), 15000);
            const finish = (fn, value) => { clearTimeout(timer); fn(value); };
            server.once('error', e => finish(reject, e));
            server.once('exit', code => finish(reject, new Error(`Fixture exited ${code}`)));
            server.stdout.on('data', data => {
                output += data;
                const match = output.match(/^http:\/\/127\.0\.0\.1:\d+$/m);
                if (match) finish(resolve, match[0]);
            });
        });
        const file = path.join(folder, 'mac.sqlite');
        await run(require('electron'), [__filename, '--prepare', file, endpoint], { ELECTRON_RUN_AS_NODE: '1' });
        await run('swift', ['test', '--package-path', 'ios-engine/Anjadhe', '--scratch-path', path.join(os.tmpdir(), 'nenva-standalone-build'),
            '--disable-sandbox', '-Xswiftc', '-module-cache-path', '-Xswiftc', path.join(os.tmpdir(), 'nenva-swift-cache'),
            '--filter', 'SyncHTTPTransportTests/testNativePeerWithMacStore'], {
            NENVA_SYNC_MAC_TEST_ENDPOINT: endpoint, CLANG_MODULE_CACHE_PATH: path.join(os.tmpdir(), 'nenva-clang-cache'),
            SWIFTPM_MODULECACHE_OVERRIDE: path.join(os.tmpdir(), 'nenva-swift-cache')
        });
        await run(require('electron'), [__filename, '--finish', file, endpoint], { ELECTRON_RUN_AS_NODE: '1' });
    } finally {
        if (server.exitCode === null) { server.kill('SIGTERM'); await stopped; }
        fs.rmSync(folder, { recursive: true, force: true });
    }
}
(process.versions.electron ? macPeer() : integration()).catch(error => { console.error(error); process.exitCode = 1; });
