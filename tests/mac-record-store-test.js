'use strict';
// Use the app's actual SQLite build, not a mock or a second database library.
if (!process.versions.electron) {
    const run = require('node:child_process').spawnSync(require('electron'), [__filename], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit'
    });
    if (run.error) throw run.error;
    process.exit(run.status ?? 1);
}
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { MacRecordStore } = require('../js/sync/mac-record-store');
const Merge = require('../js/sync/record-merge');
const fixtures = require('../fixtures/record-merge/cases.json');
const edit = text => ({ kind: 'edit', fields: { content: text } });
function open(file, writer = 'mac') {
    const db = new Database(file); db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT)');
    const store = new MacRecordStore(db); store.createDataset('fixture', writer);
    return { db, store };
}
if (process.argv[2] === '--crash-after-commit') {
    const { store } = open(process.argv[3]);
    store.appendLocal({ dataset: 'fixture', type: 'note', id: 'n', mutation: edit('crash-safe'), expectedFrontier: {},
        kvWrites: [{ key: 'app_notes', expected: undefined, value: { notes: [{ id: 'n', content: 'crash-safe' }] } }] });
    process.exit(0); // no close/checkpoint/callback
}
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'nenva-mac-store-'));
let checks = 0;
try {
    for (const fixture of fixtures) {
        const file = path.join(folder, crypto.randomUUID() + '.sqlite');
        let connection = open(file, 'fixture-local'), received = [];
        if (fixture.error) {
            assert.throws(() => connection.store.ingest(fixture.operations, 'fixture'), fixture.name);
            assert.deepEqual(connection.store.frontier('fixture'), {}); checks += 2;
        } else {
            for (const op of [...fixture.operations].reverse()) {
                received.push(op);
                const receipt = connection.store.ingest([op, op], 'fixture');
                const expected = Merge.reduce(received, 'fixture');
                assert.deepEqual(receipt.frontier, expected.frontier, fixture.name);
                assert.equal(receipt.pending, expected.pending.length, fixture.name);
                assert.deepEqual(connection.store.outbox('fixture'), []); checks += 3;
                connection.db.close(); connection = open(file, 'fixture-local');
            }
            const receipt = connection.store.ingest([], 'fixture');
            assert.deepEqual(receipt.frontier, fixture.expected.frontier, fixture.name);
            for (const record of fixture.expected.records) {
                assert.deepEqual(connection.store.record('fixture', record.type, record.id), record, fixture.name); checks++;
            }
            checks++;
        }
        connection.db.close();
    }

    // Typed sender snapshot + placement + outbox are one commit, including a
    // late failure after both operations have already been reduced.
    {
        const connection = open(path.join(folder, 'senders.sqlite'));
        const { db, store } = connection;
        const value = { senders: { dental: { id: 'dental', name: 'Your dental', allGood: 'Healthy teeth.', state: 'active', confirmed: true, by: 'you', createdAt: '2026-10-12' } },
            place: { 'task:visit': { sender: 'dental', by: 'you', at: '2026-10-12' } }, tries: { local: 'LOCAL_ONLY' } };
        const save = () => store.commitSenders({ dataset: 'fixture', expectedFrontier: {}, value });
        db.exec("CREATE TRIGGER fail_sender BEFORE INSERT ON kv BEGIN SELECT RAISE(ABORT, 'fixture'); END");
        assert.throws(save);
        assert.deepEqual(store.frontier('fixture'), {});
        assert.deepEqual(store.outbox('fixture'), []);
        assert.deepEqual(store.senderRecords('fixture'), []);
        assert.equal(db.prepare('SELECT count(*) AS n FROM sync_v2_kv_changes').get().n, 0);
        db.exec('DROP TRIGGER fail_sender');
        save();
        assert.equal(store.outbox('fixture').length, 2);
        assert.doesNotMatch(JSON.stringify(store.outbox('fixture')), /LOCAL_ONLY/);
        assert.equal(store.senderProjection('fixture').place['task:visit'].sender, 'dental');
        assert.throws(save, /Stale frontier/);
        assert.throws(() => store.commitSenders({ dataset: 'fixture', expectedFrontier: { mac: 2 }, value }), /Stale local snapshot/);
        store.ingest([{ protocolVersion: 2, schemaVersion: 1, datasetId: 'fixture', membershipEpoch: 1, deviceId: 'phone', sequence: 1,
            dependencies: { mac: 2 }, recordType: 'sender', recordId: 'dental', mutation: { kind: 'edit', fields: { name: 'Our dental' } } }], 'fixture');
        assert.throws(() => store.commitSenders({ dataset: 'fixture', expectedFrontier: { mac: 2, phone: 1 }, expected: value, value }), /conflict review/);
        assert.equal(store.outbox('fixture').length, 2);
        assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM kv WHERE key = ?').get('app_senders').value), value);
        db.close();
        const reopened = open(path.join(folder, 'senders.sqlite'));
        assert.equal(reopened.store.senderProjection('fixture').senders.dental.name, 'Our dental');
        reopened.db.close(); checks += 14;
    }

    // Modern goal + recurrence + quoted day evidence commit as one snapshot.
    {
        const file = path.join(folder, 'commitments.sqlite');
        let { db, store } = open(file);
        const value = require('../fixtures/commitment-sync/snapshot.json');
        const save = () => store.commitCommitments({ dataset: 'fixture', expectedFrontier: {}, value });
        db.exec("CREATE TRIGGER fail_commitment BEFORE INSERT ON kv BEGIN SELECT RAISE(ABORT, 'fixture'); END");
        assert.throws(save);
        assert.deepEqual(store.frontier('fixture'), {});
        assert.deepEqual(store.outbox('fixture'), []);
        assert.deepEqual(store.commitmentRecords('fixture'), []);
        assert.equal(db.prepare('SELECT count(*) AS n FROM sync_v2_kv_changes').get().n, 0);
        assert.equal(db.prepare('SELECT count(*) AS n FROM kv').get().n, 0);
        db.exec('DROP TRIGGER fail_commitment'); save();
        assert.equal(store.outbox('fixture').length, 4);
        assert.doesNotMatch(JSON.stringify(store.outbox('fixture')), /LOCAL_ONLY/);
        assert.equal(store.commitmentProjection('fixture').items.find(c => c.id === 'run').moved['2026-10-12'].time, '18:00');
        assert.throws(save, /Stale frontier/);
        assert.throws(() => store.commitCommitments({dataset:'fixture',expectedFrontier:{mac:4},value}), /Stale local snapshot/);
        const cleared = structuredClone(value);
        delete cleared.items[1].history['2026-10-11']; delete cleared.items[1].log['2026-10-11'];
        store.commitCommitments({dataset:'fixture',expectedFrontier:{mac:4},expected:value,value:cleared});
        assert.equal(store.outbox('fixture').length,5);
        store.commitCommitments({dataset:'fixture',expectedFrontier:{mac:5},expected:cleared,value:cleared});
        assert.equal(store.outbox('fixture').length,5,'no-change save authors no extra operations');
        store.commitCommitments({dataset:'fixture',expectedFrontier:{mac:5},expected:cleared,value});
        assert.equal(store.outbox('fixture').length,6);
        db.close(); ({db,store}=open(file));
        assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM kv WHERE key = ?').get('app_commitments').value),value);
        assert.equal(store.commitmentProjection('fixture').items.find(c=>c.id==='run').log['2026-10-11'][0].measures[0].value,4);
        store.ingest([{protocolVersion:2,schemaVersion:1,datasetId:'fixture',membershipEpoch:1,deviceId:'phone',sequence:1,
            dependencies:{mac:6},recordType:'commitment',recordId:'run',mutation:{kind:'edit',fields:{title:'Run gently'}}}], 'fixture');
        assert.throws(()=>store.commitCommitments({dataset:'fixture',expectedFrontier:{mac:6,phone:1},expected:value,value}), /conflict review/);
        assert.equal(store.outbox('fixture').length,6);
        assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM kv WHERE key = ?').get('app_commitments').value),value,'incoming records do not replace or activate the live snapshot');
        db.close(); checks += 21;
    }

    const file = path.join(folder, 'local.sqlite');
    let { db, store } = open(file);
    const original = { notes: Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, content: 'large note '.repeat(300) })), customMetadata: { retained: true } };
    // Existing user data is not rewritten or replaced by schema initialization.
    db.prepare('INSERT INTO kv VALUES (?, ?)').run('app_notes', JSON.stringify(original));
    const edited = structuredClone(original); edited.notes[5].content = 'one edit';
    store.setKV('app_notes', edited);
    const baseline = db.prepare('SELECT * FROM sync_v2_kv_baselines WHERE key = ?').get('app_notes');
    assert.equal(baseline.payload, JSON.stringify(original)); checks++;
    const delta = JSON.parse(db.prepare('SELECT payload FROM sync_v2_kv_changes').get().payload);
    assert.equal(delta.items.length, 1); assert.equal(delta.items[0].id, 'n5');
    assert.ok(JSON.stringify(delta).length < JSON.stringify(original).length / 50); checks += 3;
    assert.deepEqual(store.outbox('fixture'), [], 'legacy data is not silently published'); checks++;
    assert.equal(store.setKV('app_notes', edited), false); checks++;
    assert.equal(db.prepare('SELECT count(*) AS n FROM sync_v2_kv_changes').get().n, 1); checks++;

    db.exec("CREATE TRIGGER fail_journal BEFORE INSERT ON sync_v2_kv_changes BEGIN SELECT RAISE(ABORT, 'test'); END");
    const next = { notes: [{ id: 'n', content: 'v2' }] };
    const append = () => store.appendLocal({ dataset: 'fixture', type: 'note', id: 'n', mutation: edit('v2'), expectedFrontier: {},
        kvWrites: [{ key: 'app_notes', expected: edited, value: next }] });
    assert.throws(append); assert.deepEqual(store.frontier('fixture'), {});
    assert.deepEqual(store.outbox('fixture'), []); assert.equal(store.record('fixture', 'note', 'n'), undefined);
    assert.equal(db.prepare('SELECT value FROM kv WHERE key = ?').get('app_notes').value, JSON.stringify(edited)); checks += 5;
    assert.throws(() => store.clearKV());
    assert.equal(db.prepare('SELECT count(*) AS n FROM kv').get().n, 1); checks += 2;
    db.exec('DROP TRIGGER fail_journal');
    assert.equal(append().sequence, 1); checks++;
    assert.throws(() => store.appendLocal({ dataset: 'fixture', type: 'note', id: 'n', mutation: edit('stale'), expectedFrontier: { mac: 1 },
        kvWrites: [{ key: 'app_notes', expected: edited, value: next }] }));
    assert.deepEqual(store.frontier('fixture'), { mac: 1 }); checks += 2;
    const concurrent = open(file);
    assert.throws(() => concurrent.store.appendLocal({ dataset: 'fixture', type: 'note', id: 'n', mutation: edit('unseen'), expectedFrontier: {} }));
    concurrent.db.close(); checks++;

    const datasetKey = Buffer.alloc(32, 1), signingSeed = Buffer.alloc(32, 2);
    const privateKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), signingSeed]), format: 'der', type: 'pkcs8' });
    const publicKey = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
    db.exec("CREATE TRIGGER fail_envelope BEFORE INSERT ON sync_v2_envelopes BEGIN SELECT RAISE(ABORT, 'test'); END");
    const encrypt = options => store.encryptedOutbox({ dataset: 'fixture', datasetKey, signingSeed, ...options });
    assert.throws(() => encrypt());
    assert.equal(db.prepare('SELECT count(*) AS n FROM sync_v2_envelopes').get().n, 0); checks += 2;
    db.exec('DROP TRIGGER fail_envelope');
    const page = encrypt();
    db.close(); ({ db, store } = open(file));
    assert.deepEqual(encrypt(), page); checks++;
    store.appendLocal({ dataset: 'fixture', type: 'note', id: 'n', mutation: edit('next'), expectedFrontier: { mac: 1 } });
    assert.throws(() => encrypt({ datasetKey: Buffer.alloc(32, 3), after: 1 })); checks++;
    const secondPage = encrypt({ after: 1 });
    assert.throws(() => store.confirmUpload('fixture', 1, 0, 3));
    store.confirmUpload('fixture', 1, 0, 2);
    assert.equal(store.deliveryState('fixture').uploadedSequence, 2); checks += 2;

    const receiver = open(path.join(folder, 'receiver.sqlite'), 'phone');
    const receive = (envelopes, expectedCursor, nextCursor) => receiver.store.ingestEncryptedPage({ dataset: 'fixture', datasetKey,
        authorizedWriters: { mac: publicKey }, envelopes, expectedCursor, nextCursor });
    receiver.db.exec("CREATE TRIGGER fail_cursor BEFORE UPDATE ON sync_v2_delivery BEGIN SELECT RAISE(ABORT, 'test'); END");
    assert.throws(() => receive(page, '', '1'));
    assert.deepEqual(receiver.store.frontier('fixture'), {}); assert.equal(receiver.store.record('fixture', 'note', 'n'), undefined); checks += 3;
    receiver.db.exec('DROP TRIGGER fail_cursor');
    assert.equal(receive(secondPage, '', '2').pending, 1);
    assert.deepEqual(receiver.store.frontier('fixture'), {}); checks += 2;
    assert.deepEqual(receive(page, '2', '3').frontier, { mac: 2 }); checks++;
    assert.deepEqual(receiver.store.record('fixture', 'note', 'n'), store.record('fixture', 'note', 'n')); checks++;
    assert.deepEqual(receiver.store.outbox('fixture'), []); checks++;
    const damaged = { ...page[0], signature: 'A'.repeat(86) };
    assert.throws(() => receive([damaged], '3', '4'));
    assert.equal(receiver.store.deliveryState('fixture').cursor, '3'); checks += 2;
    assert.throws(() => receive([], 'old', '4')); checks++;
    receiver.db.close();

    const malformed = { notes: [{ content: 'no id' }, { id: 'dup' }, { id: 'dup', extra: true }], unknown: 'keep' };
    store.setKV('app_notes', malformed); store.deleteKV('app_notes');
    const recovery = JSON.parse(db.prepare('SELECT payload FROM sync_v2_kv_changes ORDER BY sequence DESC LIMIT 1').get().payload);
    assert.deepEqual(recovery.before, malformed); assert.equal(recovery.afterExists, false); checks += 2;
    assert.equal(db.prepare('SELECT payload FROM sync_v2_kv_baselines WHERE key = ?').get('app_notes').payload, JSON.stringify(original)); checks++;
    db.exec("UPDATE sync_v2_meta SET value = '99' WHERE key = 'schema'");
    assert.throws(() => new MacRecordStore(db), /Unsupported/); checks++;
    db.close();

    const crashFile = path.join(folder, 'crash.sqlite');
    const child = spawnSync(process.execPath, [__filename, '--crash-after-commit', crashFile], { env: process.env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr); checks++;
    const recovered = open(crashFile);
    assert.deepEqual(recovered.store.frontier('fixture'), { mac: 1 });
    assert.equal(recovered.store.outbox('fixture').length, 1);
    assert.equal(JSON.parse(recovered.db.prepare('SELECT value FROM kv WHERE key = ?').get('app_notes').value).notes[0].content, 'crash-safe'); checks += 3;
    recovered.db.close();

    const named = open(path.join(folder, 'named.sqlite'), 'constructor');
    named.store.appendLocal({ dataset: 'fixture', type: 'note', id: 'n', mutation: edit('ordinary writer'), expectedFrontier: {} });
    assert.deepEqual(named.store.frontier('fixture'), { constructor: 1 }); checks++;
    named.db.close();

    const large = open(path.join(folder, 'large.sqlite'));
    for (let i = 0; i < 12; i++) large.store.appendLocal({ dataset: 'fixture', type: 'note', id: `n${i}`,
        mutation: edit('x'.repeat(900000)), expectedFrontier: i ? { mac: i } : {} });
    const first = large.store.encryptedOutbox({ dataset: 'fixture', datasetKey, signingSeed, limit: 256 });
    assert.ok(first.length > 0 && first.length < 12);
    assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 12582912);
    assert.equal(large.db.prepare('SELECT count(*) AS n FROM sync_v2_envelopes').get().n, first.length);
    const rest = large.store.encryptedOutbox({ dataset: 'fixture', datasetKey, signingSeed, after: first.at(-1).sequence });
    assert.equal(rest.length + first.length, 12); checks += 4;
    large.db.close();
    const chats = open(path.join(folder, 'conversations.sqlite'));
    const conversation = { conversations: [{ id: 'chat', title: 'School', createdAt: '2026-10-12', messages: [
        { id: 'user1', role: 'user', content: 'Tuition deadline?', timestamp: '2026-10-12' }
    ] }, { private: true, messages: [{ content: 'PRIVATE_NEVER_SAVED' }] }] };
    chats.db.exec("CREATE TRIGGER fail_chat_save BEFORE INSERT ON kv WHEN NEW.key = 'app_agent-conversations' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    assert.throws(() => chats.store.commitConversations({ dataset: 'fixture', value: conversation, expectedFrontier: {} }));
    assert.deepEqual(chats.store.frontier('fixture'), {});
    assert.equal(chats.store.outbox('fixture').length, 0);
    assert.equal(chats.db.prepare('SELECT count(*) AS n FROM sync_v2_records').get().n, 0);
    chats.db.exec('DROP TRIGGER fail_chat_save');
    const written = chats.store.commitConversations({ dataset: 'fixture', value: conversation, expectedFrontier: {} });
    assert.deepEqual(written.frontier, { mac: 2 });
    assert.equal(written.value.conversations.length, 1);
    assert.doesNotMatch(JSON.stringify(chats.store.outbox('fixture')), /PRIVATE_NEVER_SAVED/);
    assert.doesNotMatch(JSON.stringify(chats.db.prepare('SELECT * FROM sync_v2_kv_changes').all()), /PRIVATE_NEVER_SAVED/);
    const nextChat = structuredClone(written.value); nextChat.conversations[0].title = 'School payments';
    chats.store.setKV('app_agent-conversations', { ...written.value, unrelatedEdit: true });
    assert.throws(() => chats.store.commitConversations({ dataset: 'fixture', value: nextChat, expected: written.value, expectedFrontier: written.frontier }), /Stale local/);
    assert.equal(chats.store.outbox('fixture').length, 2);
    assert.equal(chats.store.conversationProjection('fixture').conversations[0].messages[0].content, 'Tuition deadline?');
    chats.db.close(); checks += 10;
    console.log(`mac record store: ${fixtures.length} shared fixtures, ${checks} checks passed`);
} finally { fs.rmSync(folder, { recursive: true, force: true }); }
