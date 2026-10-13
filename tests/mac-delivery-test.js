'use strict';
if (!process.versions.electron) {
    const run = require('node:child_process').spawnSync(require('electron'), [__filename], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit'
    });
    if (run.error) throw run.error;
    process.exit(run.status ?? 1);
}
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3');
const { MacRecordStore } = require('../js/sync/mac-record-store');
const { MailboxClient, MacDeliveryCoordinator } = require('../js/sync/mailbox-client');
const vector = require('../fixtures/encrypted-operation/vector.json');
const credential = 'nsync_' + '1'.repeat(64);
const datasetKey = Buffer.from(vector.datasetKey, 'hex'), signingSeed = Buffer.from(vector.signingSeed, 'hex');
const authorizedWriters = { a: Buffer.from(vector.publicKey, 'hex') };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
async function run() {
    const calls = [];
    const client = new MailboxClient({ credential, fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return response(calls.length === 1 ? { storedThrough: 1 } : calls.length === 2 ? { envelopes: [], nextCursor: 'next', hasMore: false } : { accepted: true });
    } });
    assert.equal(await client.upload({ dataset: 'fixture', envelopes: [vector.envelope] }), 1);
    assert.equal((await client.download({ dataset: 'fixture', cursor: 'opaque+/&?' })).nextCursor, 'next');
    await client.acknowledge({ dataset: 'fixture', frontier: { a: 1 } });
    assert.equal(calls[1].url.searchParams.get('after'), 'opaque+/&?');
    for (const { url, options } of calls) {
        assert.equal(url.origin, 'https://api.nenva.co');
        assert.equal(options.headers.Authorization, `Bearer ${credential}`);
        assert.equal(options.headers['X-Sync-Epoch'], '1');
        assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
        assert.ok(!url.href.includes(credential));
    }
    assert.deepEqual(JSON.parse(calls[2].options.body), { frontier: { a: 1 } });
    for (const baseURL of ['http://example.invalid', 'https://user:password@example.invalid', 'https://example.invalid/path', 'https://example.invalid/?key=value']) {
        assert.throws(() => new MailboxClient({ credential, baseURL }));
    }
    assert.throws(() => new MailboxClient({ credential: 'anck_inference-key' }));
    assert.throws(() => new MailboxClient({ credential: credential + '\n' }));
    for (const [body, status, code] of [
        [{ error: 'private server detail' }, 500, 'request_failed'],
        [{ error: 'storage_quota' }, 507, 'storage_quota'],
        [null, 200, 'invalid_response'],
        [{ envelopes: [], nextCursor: 'next', hasMore: 'yes' }, 200, 'invalid_response']
    ]) {
        const invalid = new MailboxClient({ credential, fetchImpl: async () => response(body, status) });
        await assert.rejects(invalid.download({ dataset: 'fixture', cursor: '' }), { code });
    }
    const oversized = new MailboxClient({ credential, fetchImpl: async () => new Response(new Uint8Array(13 * 1024 * 1024 + 1)) });
    await assert.rejects(oversized.download({ dataset: 'fixture', cursor: '' }), { code: 'invalid_response' });
    const redirect = new MailboxClient({ credential, fetchImpl: async () => ({ redirected: true }) });
    await assert.rejects(redirect.download({ dataset: 'fixture', cursor: '' }), { code: 'invalid_response' });
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(client.download({ dataset: 'fixture', cursor: '', signal: aborted.signal }), { code: 'canceled' });
    assert.equal(calls.length, 3);

    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'nenva-mac-delivery-'));
    let db;
    try {
        let store;
        const open = () => {
            db = new Database(path.join(folder, 'store.sqlite'));
            db.exec('CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT)');
            store = new MacRecordStore(db); store.createDataset('fixture', 'a');
        };
        open();
        store.appendLocal({ dataset: 'fixture', type: 'note', id: 'n', mutation: { kind: 'edit', fields: { content: 'Mac edit' } }, expectedFrontier: {} });
        const uploads = [], cursors = [], receipts = [];
        let loseUpload = true, loseReceipt = true;
        const transport = {
            async upload({ envelopes }) {
                uploads.push(structuredClone(envelopes));
                if (loseUpload) { loseUpload = false; throw new Error('lost upload ACK'); }
                return envelopes.at(-1).sequence;
            },
            async download({ cursor }) {
                cursors.push(cursor);
                return { envelopes: cursor ? [] : uploads[0], nextCursor: '1', hasMore: false };
            },
            async acknowledge({ frontier }) {
                receipts.push(frontier);
                if (loseReceipt) { loseReceipt = false; throw new Error('lost applied receipt'); }
            }
        };
        const coordinator = t => new MacDeliveryCoordinator({ store, transport: t, dataset: 'fixture', datasetKey, signingSeed, authorizedWriters });
        await assert.rejects(coordinator(transport).synchronize(), /lost upload ACK/);
        assert.equal(store.deliveryState('fixture').uploadedSequence, 0);
        db.close(); open();
        await assert.rejects(coordinator(transport).synchronize(), /lost applied receipt/);
        assert.deepEqual(uploads[0], uploads[1], 'restart retries exact ciphertext');
        assert.deepEqual(store.deliveryState('fixture'), { uploadedSequence: 1, cursor: '1' });
        db.close(); open();
        await coordinator(transport).synchronize();
        assert.deepEqual(cursors, ['', '1']); assert.deepEqual(receipts, [{ a: 1 }, { a: 1 }]);
        assert.equal(store.outbox('fixture').length, 1, 'download never echoes into outbox');
        assert.equal(uploads.length, 2);

        store.appendLocal({ dataset: 'fixture', type: 'note', id: 'n', mutation: { kind: 'edit', fields: { content: 'Next edit' } }, expectedFrontier: { a: 1 } });
        await assert.rejects(coordinator({ ...transport, upload: async () => 100 }).synchronize(), { code: 'invalid_acknowledgment' });
        assert.equal(store.deliveryState('fixture').uploadedSequence, 1);
        let release;
        const pending = coordinator({ ...transport, upload: () => new Promise(resolve => { release = resolve; }) });
        const controller = new AbortController();
        const pass = pending.synchronize({ signal: controller.signal });
        await assert.rejects(pending.synchronize(), { code: 'already_running' });
        controller.abort(); release(2);
        await assert.rejects(pass, { code: 'canceled' });
        assert.equal(store.deliveryState('fixture').uploadedSequence, 1);
        assert.equal(pending.running, false);
        await assert.rejects(coordinator(transport).synchronize({ pageBudget: 33 }), { code: 'invalid_budget' });
        await assert.rejects(coordinator({ ...transport, download: async () => ({ envelopes: [], nextCursor: '1', hasMore: true }) }).synchronize(), { code: 'invalid_page' });
        assert.equal(store.deliveryState('fixture').cursor, '1');
        console.log('Mac delivery: HTTPS boundaries, restart, lost ACKs, cancellation and overlap passed');
    } finally { if (db?.open) db.close(); fs.rmSync(folder, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
