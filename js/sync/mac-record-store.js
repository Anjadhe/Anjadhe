'use strict';
// Mac counterpart of AnjadheCore.LocalRecordStore. Uses the EXISTING app DB
// so a UI write and its journal/operation can share one SQLite transaction.
// M1 Commit operations, projections, local changes and receipts together.
// M2 Received operations never become local work or local outbox entries.
// M3 Unsupported/gapped input stays pending; a receipt only names applied dots.
// M4 Retry saved ciphertext; never replace an already published identity.
// M5 No clocks, model calls, scheduler hooks, or automatic dataset enrollment.
const crypto = require('node:crypto');
const Merge = require('./record-merge');
const Envelope = require('./encrypted-operation');
const Conversations = require('../shared/conversation-sync');
const Senders = require('../shared/sender-sync');
const Commitments = require('../shared/commitment-sync');
const stores = new WeakMap();
const positive = n => Number.isSafeInteger(n) && n > 0;
const counter = n => Number.isSafeInteger(n) && n >= 0;
const json = value => { const text = JSON.stringify(value); if (text === undefined) throw new Error('Invalid stored value'); return text; };
const parse = row => row ? JSON.parse(row.payload) : undefined;
const fields = { app_notes: 'notes', app_schedule: 'scheduleItems' };
function partition(value, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value[field])) return null;
    const items = new Map();
    for (const [position, item] of value[field].entries()) {
        if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !item.id || items.has(item.id)) return null;
        items.set(item.id, { position, value: item });
    }
    const metadata = { ...value }; delete metadata[field];
    return { items, metadata };
}

class MacRecordStore {
    constructor(db) {
        this.db = db;
        if (db.inTransaction) throw new Error('Store must open outside a transaction');
        const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_v2_meta'").get();
        if (exists && db.prepare("SELECT value FROM sync_v2_meta WHERE key = 'schema'").get()?.value !== '1') throw new Error('Unsupported sync store schema');
        db.pragma('synchronous = FULL');
        this._transaction(() => {
            if (!exists) db.exec(`
                CREATE TABLE sync_v2_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                INSERT INTO sync_v2_meta VALUES ('schema', '1');
                CREATE TABLE sync_v2_datasets (id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, writer TEXT NOT NULL);
                CREATE TABLE sync_v2_operations (dataset TEXT NOT NULL, writer TEXT NOT NULL, sequence INTEGER NOT NULL,
                    type TEXT NOT NULL, id TEXT NOT NULL, applied INTEGER NOT NULL, local INTEGER NOT NULL, payload TEXT NOT NULL,
                    PRIMARY KEY(dataset, writer, sequence));
                CREATE INDEX sync_v2_pending ON sync_v2_operations(dataset, applied, writer, sequence);
                CREATE INDEX sync_v2_history ON sync_v2_operations(dataset, type, id, applied);
                CREATE TABLE sync_v2_frontiers (dataset TEXT NOT NULL, writer TEXT NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY(dataset, writer));
                CREATE TABLE sync_v2_records (dataset TEXT NOT NULL, type TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(dataset, type, id));
                CREATE TABLE sync_v2_envelopes (dataset TEXT NOT NULL, writer TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(dataset, writer, sequence));
                CREATE TABLE sync_v2_crypto (dataset TEXT PRIMARY KEY, key_digest TEXT NOT NULL, signing_public_key TEXT NOT NULL);
                CREATE TABLE sync_v2_delivery (dataset TEXT PRIMARY KEY, cursor TEXT NOT NULL, uploaded INTEGER NOT NULL);
                CREATE TABLE sync_v2_kv_baselines (key TEXT PRIMARY KEY, existed INTEGER NOT NULL, payload TEXT);
                CREATE TABLE sync_v2_kv_changes (sequence INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL);
            `);
            for (const sql of [
                'SELECT key, value FROM kv LIMIT 0', 'SELECT id, epoch, writer FROM sync_v2_datasets LIMIT 0',
                'SELECT dataset, writer, sequence, type, id, applied, local, payload FROM sync_v2_operations LIMIT 0',
                'SELECT dataset, writer, sequence FROM sync_v2_frontiers LIMIT 0',
                'SELECT dataset, type, id, payload FROM sync_v2_records LIMIT 0',
                'SELECT dataset, writer, sequence, payload FROM sync_v2_envelopes LIMIT 0',
                'SELECT dataset, key_digest, signing_public_key FROM sync_v2_crypto LIMIT 0',
                'SELECT dataset, cursor, uploaded FROM sync_v2_delivery LIMIT 0',
                'SELECT key, existed, payload FROM sync_v2_kv_baselines LIMIT 0',
                'SELECT sequence, payload FROM sync_v2_kv_changes LIMIT 0'
            ]) db.prepare(sql).all();
        });
    }
    _transaction(fn) {
        if (this.db.inTransaction) throw new Error('Nested sync transaction is not supported');
        return this.db.transaction(fn).immediate();
    }
    createDataset(dataset, writer, epoch = 1) {
        if (!Merge.token(dataset) || !Merge.token(writer) || !positive(epoch)) throw new Error('Invalid dataset');
        this._transaction(() => {
            this.db.prepare('INSERT OR IGNORE INTO sync_v2_datasets VALUES (?, ?, ?)').run(dataset, epoch, writer);
            if (this._writer(dataset, epoch) !== writer) throw new Error('Dataset identity changed');
            this.db.prepare("INSERT OR IGNORE INTO sync_v2_delivery VALUES (?, '', 0)").run(dataset);
        });
    }
    _writer(dataset, epoch) {
        const row = this.db.prepare('SELECT epoch, writer FROM sync_v2_datasets WHERE id = ?').get(dataset);
        if (!row || row.epoch !== epoch) throw new Error('Unknown dataset or epoch');
        return row.writer;
    }
    frontier(dataset, epoch = 1) {
        this._writer(dataset, epoch);
        return Object.fromEntries(this.db.prepare('SELECT writer, sequence FROM sync_v2_frontiers WHERE dataset = ?').all(dataset).map(r => [r.writer, r.sequence]));
    }
    record(dataset, type, id) { return parse(this.db.prepare('SELECT payload FROM sync_v2_records WHERE dataset = ? AND type = ? AND id = ?').get(dataset, type, id)); }
    outbox(dataset, after = 0, limit = 100) {
        if (!counter(after) || !positive(limit) || limit > 256) throw new Error('Invalid outbox page');
        return this.db.prepare('SELECT payload FROM sync_v2_operations WHERE dataset = ? AND local = 1 AND sequence > ? ORDER BY sequence LIMIT ?').all(dataset, after, limit).map(parse);
    }
    appendLocal({ dataset, epoch = 1, type, id, mutation, expectedFrontier, kvWrites = [] }) {
        return this._transaction(() => {
            const writer = this._writer(dataset, epoch), frontier = this.frontier(dataset, epoch);
            if (Merge.stable(frontier) !== Merge.stable(expectedFrontier)) throw new Error('Stale frontier');
            const sequence = Merge.counterAt(frontier, writer) + 1;
            if (!positive(sequence)) throw new Error('Sequence exhausted');
            const operation = { protocolVersion: 2, schemaVersion: 1, datasetId: dataset, membershipEpoch: epoch,
                deviceId: writer, sequence, dependencies: frontier, recordType: type, recordId: id, mutation };
            if (!Merge.supports(operation)) throw new Error('Unsupported local mutation');
            this._ingest([operation], dataset, epoch, writer, true);
            // Future record adapters must pass before-images for their exact
            // compatibility writes. No callback can perform external effects
            // inside this transaction or publish before COMMIT.
            if (!Array.isArray(kvWrites) || kvWrites.length > 2) throw new Error('Invalid local writes');
            for (const write of kvWrites) {
                if (!Object.hasOwn(fields, write.key) || !Object.hasOwn(write, 'expected')) throw new Error('Expected local snapshot required');
                this._writeKV(write.key, write.value, write.delete === true, { expected: write.expected }, 'local-v2');
            }
            return operation;
        });
    }
    conversationRecords(dataset, epoch = 1) {
        this._writer(dataset, epoch);
        return this.db.prepare("SELECT payload FROM sync_v2_records WHERE dataset = ? AND type IN ('conversation', 'conversation-message') ORDER BY type, id").all(dataset).map(parse);
    }
    conversationProjection(dataset, epoch = 1) { return Conversations.project(this.conversationRecords(dataset, epoch)); }
    // Explicit enrollment/bootstrap caller only. This is not installed on
    // dataStore writes until pairing and the runtime projection gates pass.
    commitConversations(options) {
        return this._commitTypedSnapshot(options, 'app_agent-conversations', Conversations, this.conversationRecords);
    }
    senderRecords(dataset, epoch = 1) {
        this._writer(dataset, epoch);
        return this.db.prepare("SELECT payload FROM sync_v2_records WHERE dataset = ? AND type IN ('sender', 'sender-placement') ORDER BY type, id").all(dataset).map(parse);
    }
    senderProjection(dataset, epoch = 1) { return Senders.project(this.senderRecords(dataset, epoch)); }
    commitSenders(options) {
        return this._commitTypedSnapshot(options, 'app_senders', Senders, this.senderRecords);
    }
    commitmentRecords(dataset, epoch = 1) {
        this._writer(dataset, epoch);
        return this.db.prepare("SELECT payload FROM sync_v2_records WHERE dataset = ? AND type IN ('commitment', 'commitment-day') ORDER BY type, id").all(dataset).map(parse);
    }
    commitmentProjection(dataset, epoch = 1) { return Commitments.project(this.commitmentRecords(dataset, epoch)); }
    commitCommitments(options) {
        return this._commitTypedSnapshot(options, 'app_commitments', Commitments, this.commitmentRecords);
    }
    _commitTypedSnapshot({ dataset, epoch = 1, value, expected, expectedFrontier }, key, adapter, records) {
        return this._transaction(() => {
            const writer = this._writer(dataset, epoch);
            let frontier = this.frontier(dataset, epoch);
            if (Merge.stable(frontier) !== Merge.stable(expectedFrontier)) throw new Error('Stale frontier');
            const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
            const before = row ? JSON.parse(row.value) : undefined;
            if (Merge.stable(before) !== Merge.stable(expected)) throw new Error('Stale local snapshot');
            const plan = adapter.plan(before ?? (key === 'app_senders' ? { senders: {}, place: {} } : key === 'app_commitments' ? { items: [] } : { conversations: [] }), value, records.call(this, dataset, epoch));
            for (const change of plan.mutations) {
                const sequence = Merge.counterAt(frontier, writer) + 1;
                if (!positive(sequence)) throw new Error('Sequence exhausted');
                const operation = { protocolVersion: 2, schemaVersion: 1, datasetId: dataset, membershipEpoch: epoch,
                    deviceId: writer, sequence, dependencies: frontier, recordType: change.type, recordId: change.id, mutation: change.mutation };
                this._ingest([operation], dataset, epoch, writer, true);
                frontier = this.frontier(dataset, epoch);
            }
            this._writeKV(key, plan.value, false, { expected }, 'local-v2');
            return { frontier, value: plan.value };
        });
    }
    ingest(operations, dataset, epoch = 1) {
        return this._transaction(() => this._ingest(operations, dataset, epoch, this._writer(dataset, epoch), false));
    }
    _ingest(operations, dataset, epoch, writer, local) {
        if (!Array.isArray(operations) || operations.length > 256) throw new Error('Invalid inbox batch');
        let bytes = 0;
        for (const op of operations) {
            Merge.validate(op, dataset, epoch);
            const payload = Merge.stable(op), size = Buffer.byteLength(payload); bytes += size;
            if (size > 1048576 || bytes > 8388608) throw new Error('Inbox batch too large');
            const existing = this.db.prepare('SELECT payload FROM sync_v2_operations WHERE dataset = ? AND writer = ? AND sequence = ?').get(dataset, op.deviceId, op.sequence);
            if (existing) {
                if (Merge.stable(parse(existing)) !== payload) throw new Error('Operation identity reused');
                continue;
            }
            if (!local && op.deviceId === writer) throw new Error('Remote cannot author local operations');
            this.db.prepare('INSERT INTO sync_v2_operations VALUES (?, ?, ?, ?, ?, 0, ?, ?)').run(dataset, op.deviceId, op.sequence, op.recordType, op.recordId, local ? 1 : 0, payload);
        }
        const pendingSize = this.db.prepare('SELECT coalesce(sum(length(CAST(payload AS BLOB))), 0) AS n FROM sync_v2_operations WHERE dataset = ? AND applied = 0').get(dataset).n;
        if (pendingSize > 25165824) throw new Error('Pending inbox too large');
        const remaining = this.db.prepare('SELECT payload FROM sync_v2_operations WHERE dataset = ? AND applied = 0 ORDER BY writer, sequence LIMIT 4353').all(dataset).map(parse);
        if (remaining.length > 4352) throw new Error('Too many pending operations');
        const frontier = this.frontier(dataset, epoch), changed = new Map();
        let progress = true, applied = 0;
        const lookup = (author, sequence) => parse(this.db.prepare('SELECT payload FROM sync_v2_operations WHERE dataset = ? AND writer = ? AND sequence = ? AND applied = 1').get(dataset, author, sequence));
        while (progress) {
            progress = false;
            for (let i = 0; i < remaining.length;) {
                const op = remaining[i]; Merge.validate(op, dataset, epoch);
                if (!Merge.supports(op) || Merge.counterAt(frontier, op.deviceId) !== op.sequence - 1 || Object.entries(op.dependencies).some(([w, n]) => Merge.counterAt(frontier, w) < n)) { i++; continue; }
                const key = `${op.recordType}/${op.recordId}`;
                const history = changed.get(key) || this.db.prepare('SELECT payload FROM sync_v2_operations WHERE dataset = ? AND type = ? AND id = ? AND applied = 1 ORDER BY writer, sequence').all(dataset, op.recordType, op.recordId).map(parse);
                Merge.validateReady(op, lookup, () => history.some(p => p.mutation.kind === 'delete' && Merge.counterAt(op.dependencies, p.deviceId) >= p.sequence));
                history.push(op); changed.set(key, history);
                this.db.prepare('UPDATE sync_v2_operations SET applied = 1 WHERE dataset = ? AND writer = ? AND sequence = ?').run(dataset, op.deviceId, op.sequence);
                frontier[op.deviceId] = op.sequence;
                this.db.prepare('INSERT INTO sync_v2_frontiers VALUES (?, ?, ?) ON CONFLICT(dataset, writer) DO UPDATE SET sequence=excluded.sequence').run(dataset, op.deviceId, op.sequence);
                remaining.splice(i, 1); applied++; progress = true;
            }
        }
        if (remaining.length > 4096) throw new Error('Too many pending operations');
        for (const history of changed.values()) {
            const record = Merge.materialize(history);
            this.db.prepare('INSERT INTO sync_v2_records VALUES (?, ?, ?, ?) ON CONFLICT(dataset, type, id) DO UPDATE SET payload=excluded.payload').run(dataset, record.type, record.id, Merge.stable(record));
        }
        return { frontier, applied, pending: remaining.length };
    }
    encryptedOutbox({ dataset, epoch = 1, datasetKey, signingSeed, after = 0, limit = 100 }) {
        if (!counter(after) || !positive(limit) || limit > 256) throw new Error('Invalid outbox page');
        if (!Buffer.isBuffer(datasetKey) || datasetKey.length !== 32 || !Buffer.isBuffer(signingSeed) || signingSeed.length !== 32) throw new Error('Invalid sync keys');
        const privateKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), signingSeed]), format: 'der', type: 'pkcs8' });
        const senderKey = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
        return this._transaction(() => {
            const writer = this._writer(dataset, epoch), digest = crypto.createHash('sha256').update(datasetKey).digest('hex'), pub = senderKey.toString('hex');
            this.db.prepare('INSERT OR IGNORE INTO sync_v2_crypto VALUES (?, ?, ?)').run(dataset, digest, pub);
            const pinned = this.db.prepare('SELECT key_digest, signing_public_key FROM sync_v2_crypto WHERE dataset = ?').get(dataset);
            if (pinned.key_digest !== digest || pinned.signing_public_key !== pub) throw new Error('Sync keys changed');
            const result = []; let bytes = 0, plainBytes = 0;
            // Read one operation at a time so a page of large notes cannot
            // allocate limit × maximum-operation-size before its byte cap.
            const nextRow = this.db.prepare('SELECT payload FROM sync_v2_operations WHERE dataset = ? AND writer = ? AND local = 1 AND sequence > ? ORDER BY sequence LIMIT 1');
            let sequence = after;
            for (let i = 0; i < limit; i++) {
                const row = nextRow.get(dataset, writer, sequence);
                if (!row) break;
                const op = parse(row);
                sequence = op.sequence;
                if (op.deviceId !== writer) throw new Error('Corrupt local operation');
                const cached = this.db.prepare('SELECT payload FROM sync_v2_envelopes WHERE dataset = ? AND writer = ? AND sequence = ?').get(dataset, writer, op.sequence);
                const envelope = cached ? parse(cached) : Envelope.seal(op, datasetKey, signingSeed);
                const opened = Envelope.open(envelope, { datasetId: dataset, membershipEpoch: epoch, datasetKey, authorizedWriters: { [writer]: senderKey } });
                if (Merge.stable(opened) !== Merge.stable(op)) throw new Error('Corrupt cached envelope');
                const payload = json(envelope), size = Buffer.byteLength(payload), plainSize = Buffer.byteLength(json(op));
                if (bytes + size > 12582912 || plainBytes + plainSize > 8388608) break;
                bytes += size; plainBytes += plainSize;
                if (!cached) this.db.prepare('INSERT INTO sync_v2_envelopes VALUES (?, ?, ?, ?)').run(dataset, writer, op.sequence, payload);
                result.push(envelope);
            }
            return result;
        });
    }
    deliveryState(dataset, epoch = 1) {
        this._writer(dataset, epoch);
        const state = this.db.prepare('SELECT cursor, uploaded AS uploadedSequence FROM sync_v2_delivery WHERE dataset = ?').get(dataset);
        if (!state || typeof state.cursor !== 'string' || !counter(state.uploadedSequence)) throw new Error('Corrupt delivery state');
        return state;
    }
    ingestEncryptedPage({ dataset, epoch = 1, datasetKey, authorizedWriters, envelopes, expectedCursor, nextCursor }) {
        const cursor = v => typeof v === 'string' && Buffer.byteLength(v) <= 2048 && !v.includes('\0');
        if (!cursor(expectedCursor) || !cursor(nextCursor) || !Array.isArray(envelopes) || envelopes.length > 256 || (envelopes.length && nextCursor === expectedCursor)) throw new Error('Invalid encrypted page');
        let bytes = 0;
        const operations = envelopes.map(envelope => {
            const size = Buffer.byteLength(json(envelope)); bytes += size;
            if (size > 1400000 || bytes > 12582912) throw new Error('Encrypted page too large');
            return Envelope.open(envelope, { datasetId: dataset, membershipEpoch: epoch, datasetKey, authorizedWriters });
        });
        return this._transaction(() => {
            if (this.deliveryState(dataset, epoch).cursor !== expectedCursor) throw new Error('Stale download cursor');
            const receipt = this._ingest(operations, dataset, epoch, this._writer(dataset, epoch), false);
            this.db.prepare('UPDATE sync_v2_delivery SET cursor = ? WHERE dataset = ?').run(nextCursor, dataset);
            return receipt;
        });
    }
    confirmUpload(dataset, epoch, expectedSequence, through) {
        if (!counter(expectedSequence) || !positive(through) || through <= expectedSequence) throw new Error('Invalid upload receipt');
        this._transaction(() => {
            const writer = this._writer(dataset, epoch);
            if (this.deliveryState(dataset, epoch).uploadedSequence !== expectedSequence) throw new Error('Stale upload receipt');
            const count = this.db.prepare('SELECT count(*) AS n FROM sync_v2_envelopes WHERE dataset = ? AND writer = ? AND sequence > ? AND sequence <= ?').get(dataset, writer, expectedSequence, through).n;
            if (count !== through - expectedSequence) throw new Error('Upload receipt skips unsaved envelopes');
            this.db.prepare('UPDATE sync_v2_delivery SET uploaded = ? WHERE dataset = ?').run(through, dataset);
        });
    }
    // Runtime compatibility journal. These before/after deltas are NOT v2
    // operations and never enter the outbox. A record adapter/bootstrap must
    // deliberately author operations against observed causal state.
    setKV(key, value) { return this._transaction(() => this._writeKV(key, value, false)); }
    deleteKV(key) { return this._transaction(() => this._writeKV(key, undefined, true)); }
    clearKV() {
        return this._transaction(() => {
            for (const key of Object.keys(fields)) this._writeKV(key, undefined, true);
            this.db.exec('DELETE FROM kv');
        });
    }
    _writeKV(key, value, deleted, options = {}, origin = 'legacy') {
        const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
        const before = row ? JSON.parse(row.value) : undefined, after = deleted ? undefined : json(value);
        if (Object.hasOwn(options, 'expected') && Merge.stable(before) !== Merge.stable(options.expected)) throw new Error('Stale local snapshot');
        if (row?.value === after) return false;
        const field = key === 'app_commitments' && origin === 'local-v2' ? 'items'
            : key === 'app_senders' && origin === 'local-v2' ? 'senders'
            : key === 'app_agent-conversations' && origin === 'local-v2' ? 'conversations'
            : Object.hasOwn(fields, key) ? fields[key] : null;
        if (field) {
            this.db.prepare('INSERT OR IGNORE INTO sync_v2_kv_baselines VALUES (?, ?, ?)').run(key, row ? 1 : 0, row?.value ?? null);
            const previous = partition(before, field), next = partition(deleted ? undefined : JSON.parse(after), field);
            let delta;
            if (previous && next) {
                const items = [];
                for (const id of new Set([...previous.items.keys(), ...next.items.keys()])) {
                    const a = previous.items.get(id), b = next.items.get(id);
                    if (Merge.stable(a) !== Merge.stable(b)) items.push({ id, before: a ?? null, after: b ?? null });
                }
                delta = { field, beforeMetadata: previous.metadata, afterMetadata: next.metadata, items };
            } else delta = { before: before ?? null, beforeExists: !!row, after: deleted ? null : JSON.parse(after), afterExists: !deleted };
            this.db.prepare('INSERT INTO sync_v2_kv_changes(payload) VALUES (?)').run(json({ key, origin, ...delta }));
        }
        if (deleted) this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
        else this.db.prepare('INSERT OR REPLACE INTO kv(key, value) VALUES (?, ?)').run(key, after);
        return true;
    }
}
function forDatabase(db) {
    if (!stores.has(db)) stores.set(db, new MacRecordStore(db));
    return stores.get(db);
}
module.exports = { MacRecordStore, forDatabase };
