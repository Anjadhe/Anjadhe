'use strict';
// Opt-in three-runtime check: Electron SQLite ↔ HTTP mailbox ↔ Swift SQLite.
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
        if (mode === '--prepare') {
            store.appendLocal({ dataset: 'fixture', type: 'note', id: 'n', mutation: { kind: 'edit', fields: { content: 'Written on device A' } }, expectedFrontier: {} });
            store.commitConversations({ dataset: 'fixture', expectedFrontier: { a: 1 }, value: { conversations: [
                { id: 'mac-chat', title: 'School', createdAt: '2026-10-12', messages: [
                    { id: 'u', role: 'user', content: 'When is tuition due?', timestamp: '2026-10-12' }
                ] }, { private: true, messages: [{ content: 'PRIVATE_NEVER_SYNC' }] }
            ] } });
            store.commitSenders({ dataset: 'fixture', expectedFrontier: { a: 3 }, value: {
                senders: { dental: { id: 'dental', name: 'Your dental', allGood: 'Healthy teeth.', state: 'active', confirmed: true, by: 'you', createdAt: '2026-10-12' } },
                place: { 'task:visit': { sender: 'dental', by: 'you', at: '2026-10-12' } }, tries: { local: 'LOCAL_ONLY' }
            } });
            store.commitCommitments({ dataset: 'fixture', expectedFrontier: { a: 5 }, value: require('../fixtures/commitment-sync/snapshot.json') });
        }
        await delivery.synchronize();
        if (mode === '--finish') {
            assert.deepEqual(store.frontier('fixture'), { a: 9, b: 7 });
            assert.equal(store.record('fixture', 'note', 'n').fields.content.value, 'Edited on device B');
            assert.equal(store.outbox('fixture').length, 9);
            assert.equal(store.deliveryState('fixture').uploadedSequence, 9);
            const chats = store.conversationProjection('fixture').conversations;
            assert.deepEqual(chats.map(c => c.id), ['mac-chat', 'phone-chat']);
            assert.equal(chats[0].messages[0].content, 'When is tuition due?');
            assert.equal(chats[1].messages[0].content, 'Written independently on the phone');
            assert.doesNotMatch(JSON.stringify(chats), /PRIVATE_NEVER_SYNC/);
            const threads = store.senderProjection('fixture');
            assert.equal(threads.senders.dental.name, 'Your dental');
            assert.equal(threads.senders.music.name, 'Music classes');
            assert.equal(threads.place['task:visit'].sender, 'dental');
            assert.equal(threads.place['task:practice'].sender, 'music');
            assert.deepEqual(threads.issues, []);
            assert.doesNotMatch(JSON.stringify(store.senderRecords('fixture')), /LOCAL_ONLY/);
            const commitments = store.commitmentProjection('fixture');
            assert.deepEqual(commitments.issues, []);
            assert.deepEqual(commitments.items.map(c => c.id), ['goal', 'phone-step', 'run']);
            const run = commitments.items.find(c => c.id === 'run');
            assert.equal(run.history['2026-10-11'], 'done');
            assert.equal(run.history['2026-10-12'], 'done');
            assert.equal(run.log['2026-10-11'][0].measures[0].value, 4);
            assert.equal(run.log['2026-10-12'][0].plan, true);
            assert.equal(run.log['2026-10-12'][1].measures[0].value, 5);
            assert.equal(run.moved['2026-10-12'].time, '18:00');
            assert.doesNotMatch(JSON.stringify(store.commitmentRecords('fixture')), /LOCAL_ONLY/);
            assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM kv WHERE key = ?').get('app_commitments').value), require('../fixtures/commitment-sync/snapshot.json'), 'Receiving data never installs the live commitment snapshot');
            console.log('Mac/native conversations, threads and modern commitment days → encrypted HTTP mailbox → reopened stores: passed');
        }
    } finally { db.close(); }
}
async function integration() {
    const connectFixture = path.join(process.env.NENVA_CONNECT_REPO || path.resolve(root, '../anjadhe-connect'), 'test/sync-native-fixture.js');
    if (process.env.NENVA_CONNECT_REPO) assert.ok(fs.existsSync(connectFixture), 'Connect fixture required at NENVA_CONNECT_REPO');
    const useConnect = fs.existsSync(connectFixture);
    const fixture = useConnect ? connectFixture : path.join(root, 'tests/sync-http-fixture.js');
    console.log(useConnect ? 'Using Connect service fixture' : 'Using app loopback mailbox fixture; Connect service acceptance is not tested');
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'nenva-sync-interop-'));
    const server = spawn(useConnect ? process.execPath : require('electron'), [fixture], { env: { ...process.env, ...(useConnect ? {} : { ELECTRON_RUN_AS_NODE: '1' }) }, stdio: ['ignore', 'pipe', 'inherit'] });
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
