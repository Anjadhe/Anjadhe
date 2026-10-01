/**
 * iMessage reader test (js/main/imessage-reader.js), headless.
 *
 * Pins the pure parts — nothing here opens the real chat.db:
 *   - the typedstream body decoder reads the NSString payload for the
 *     one-byte, 0x81 (uint16) and 0x82 (uint32) length shapes, strips the
 *     attachment placeholder, and returns '' on anything it does not
 *     recognise (never a guess);
 *   - Apple dates convert from nanoseconds AND legacy seconds;
 *   - errors map to one plain sentence with a reason class (Full Disk
 *     Access is the one that matters);
 *   - readSince against a synthetic chat.db (better-sqlite3, in a temp
 *     file) returns decoded rows, excludes tapbacks / group events, honours
 *     the first-run lookback and advances maxRowid.
 *
 * Run: node tests/imessage-reader-test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createIMessageReader, decodeAttributedBody, appleDateToIso, explainError, APPLE_EPOCH_S } = require('../js/main/imessage-reader');

function typedstream(text, lenShape = 'auto') {
    const payload = Buffer.from(text, 'utf8');
    let len;
    if (lenShape === 'u16' || (lenShape === 'auto' && payload.length >= 0x80 && payload.length <= 0xffff)) {
        len = Buffer.alloc(3); len[0] = 0x81; len.writeUInt16LE(payload.length, 1);
    } else if (lenShape === 'u32') {
        len = Buffer.alloc(5); len[0] = 0x82; len.writeUInt32LE(payload.length, 1);
    } else {
        len = Buffer.from([payload.length]);
    }
    return Buffer.concat([
        Buffer.from('040b73747265616d747970656481e8038401408484841241747472696275746564537472696e6700848484084e53537472696e670194840 12b'.replace(/ /g,''), 'hex'),
        len, payload,
        Buffer.from('8684024e5386', 'hex'), // trailing attribute noise
    ]);
}

// --- decoder ------------------------------------------------------------
assert.strictEqual(decodeAttributedBody(typedstream('Dentist Tue 3pm — reply C to confirm')), 'Dentist Tue 3pm — reply C to confirm');
const long = 'x'.repeat(300);
assert.strictEqual(decodeAttributedBody(typedstream(long, 'u16')), long, 'uint16 length');
assert.strictEqual(decodeAttributedBody(typedstream('hi', 'u32')), 'hi', 'uint32 length');
assert.strictEqual(decodeAttributedBody(typedstream('￼photo')), 'photo', 'attachment placeholder stripped');
assert.strictEqual(decodeAttributedBody(Buffer.from('nothing here')), '', 'no marker → empty, not a guess');
assert.strictEqual(decodeAttributedBody(null), '');
assert.strictEqual(decodeAttributedBody(Buffer.from('NSString\x01+\x50short')), '', 'length past the end → empty');

// --- dates --------------------------------------------------------------
const t = Date.UTC(2026, 8, 10, 15, 4, 5) / 1000; // 2026-09-10T15:04:05Z
assert.strictEqual(appleDateToIso((t - APPLE_EPOCH_S) * 1e9), '2026-09-10T15:04:05.000Z', 'nanoseconds');
assert.strictEqual(appleDateToIso(t - APPLE_EPOCH_S), '2026-09-10T15:04:05.000Z', 'legacy seconds');
assert.strictEqual(appleDateToIso(0), null);
assert.strictEqual(appleDateToIso('junk'), null);

// --- errors -------------------------------------------------------------
assert.strictEqual(explainError({ code: 'SQLITE_AUTH', message: 'authorization denied' }).reason, 'fda');
assert.ok(/Full Disk Access/.test(explainError(new Error('unable to open database "x": authorization denied')).text));
assert.strictEqual(explainError({ code: 'SQLITE_CANTOPEN', message: 'unable to open database file' }).reason, 'missing');
assert.strictEqual(explainError(new Error('database is locked')).reason, 'busy');
assert.strictEqual(explainError(new Error('weird\nsecond line')).text, 'weird');
// The FDA case as SQLite actually reports it: "unable to open" + a folder
// that cannot be listed → fda; the same words with a listable folder → missing.
assert.strictEqual(explainError({ code: 'SQLITE_CANTOPEN', message: 'unable to open database file' }, path.join(os.tmpdir(), 'nope', 'chat.db')).reason, 'missing');
if (process.platform === 'darwin') {
    const real = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
    let listable = true; try { fs.readdirSync(path.dirname(real)); } catch { listable = false; }
    const got = explainError({ code: 'SQLITE_CANTOPEN', message: 'unable to open database file' }, real).reason;
    assert.strictEqual(got, listable ? 'missing' : 'fda', 'folder listability decides');
}

// --- readSince over a synthetic chat.db ----------------------------------
// better-sqlite3 is built for Electron's ABI (package.json postinstall), so
// under a plain `node` it may not load; the SQL half then skips. Run it
// under Electron's own runtime to cover it:
//   ELECTRON_RUN_AS_NODE=1 npx electron tests/imessage-reader-test.js
let Database = null;
try { Database = require('better-sqlite3'); new Database(':memory:').close(); } catch { Database = null; }
if (!Database || process.platform !== 'darwin') {
    console.log('imessage-reader-test: pure parts OK (readSince skipped: better-sqlite3 not loadable under this runtime)');
    process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anj-imsg-'));
const file = path.join(dir, 'chat.db');
const db = new Database(file);
db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT, style INTEGER, service_name TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, date INTEGER,
        is_from_me INTEGER, handle_id INTEGER, cache_has_attachments INTEGER, service TEXT,
        item_type INTEGER DEFAULT 0, associated_message_type INTEGER DEFAULT 0);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
`);
db.prepare('INSERT INTO handle VALUES (1, ?, ?)').run('+14255550100', 'iMessage');
db.prepare('INSERT INTO chat VALUES (1, ?, ?, ?, 45, ?)').run('iMessage;-;+14255550100', '+14255550100', '', 'iMessage');
db.prepare('INSERT INTO chat VALUES (2, ?, ?, ?, 43, ?)').run('iMessage;+;chat123', 'chat123', 'Soccer parents', 'iMessage');
const appleNs = (isoOrMs) => ((new Date(isoOrMs).getTime() / 1000) - APPLE_EPOCH_S) * 1e9;
const now = Date.now();
const ins = db.prepare('INSERT INTO message (ROWID, guid, text, attributedBody, date, is_from_me, handle_id, cache_has_attachments, service, item_type, associated_message_type) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
const join = db.prepare('INSERT INTO chat_message_join VALUES (?, ?)');
// 1: old (10 days ago), text column set
ins.run(1, 'g1', 'old news', null, appleNs(now - 10 * 86400000), 0, 1, 0, 'iMessage', 0, 0); join.run(1, 1);
// 2: recent, body only
ins.run(2, 'g2', null, typedstream('Your package arrives tomorrow'), appleNs(now - 3600000), 0, 1, 0, 'SMS', 0, 0); join.run(1, 2);
// 3: my reply
ins.run(3, 'g3', 'thanks', null, appleNs(now - 3500000), 1, 0, 0, 'iMessage', 0, 0); join.run(1, 3);
// 4: a tapback (excluded)
ins.run(4, 'g4', 'Loved “thanks”', null, appleNs(now - 3400000), 0, 1, 0, 'iMessage', 0, 2000); join.run(1, 4);
// 5: group event (excluded)
ins.run(5, 'g5', null, null, appleNs(now - 3300000), 0, 1, 0, 'iMessage', 1, 0); join.run(2, 5);
// 6: group chat message with attachment
ins.run(6, 'g6', null, typedstream('￼Practice moved to 5pm Saturday'), appleNs(now - 3000000), 0, 1, 1, 'iMessage', 0, 0); join.run(2, 6);
db.close();

const reader = createIMessageReader({ Database, dbPath: file });
const p = reader.probe();
assert.ok(p.ok, 'probe opens the synthetic db');
assert.strictEqual(p.count, 6);
assert.strictEqual(p.maxRowid, 6);

// First run honours the lookback: row 1 (10 days old) stays out.
let r = reader.readSince({ afterRowid: 0, sinceIso: new Date(now - 3 * 86400000).toISOString() });
assert.ok(r.ok);
assert.deepStrictEqual(r.rows.map(x => x.rowid), [2, 3, 6], 'lookback, tapback and group event applied');
assert.strictEqual(r.maxRowid, 6);
const pkg = r.rows[0];
assert.strictEqual(pkg.text, 'Your package arrives tomorrow', 'body decoded when text is NULL');
assert.strictEqual(pkg.fromMe, false);
assert.strictEqual(pkg.handle, '+14255550100');
assert.strictEqual(pkg.isGroup, false);
assert.strictEqual(pkg.service, 'SMS');
assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(pkg.at));
assert.strictEqual(r.rows[1].fromMe, true, 'my own reply is marked');
const grp = r.rows[2];
assert.strictEqual(grp.isGroup, true);
assert.strictEqual(grp.chatName, 'Soccer parents');
assert.strictEqual(grp.text, 'Practice moved to 5pm Saturday', 'attachment placeholder stripped');
assert.strictEqual(grp.hasAttachment, true);

// Cursor: nothing after 6.
r = reader.readSince({ afterRowid: 6 });
assert.strictEqual(r.rows.length, 0);
assert.strictEqual(r.maxRowid, 6, 'cursor never rewinds');

// A path that does not exist reads as "missing", never a thrown error.
const missing = createIMessageReader({ Database, dbPath: path.join(dir, 'nope.db') }).probe();
assert.strictEqual(missing.ok, false);
assert.strictEqual(missing.reason, 'missing');

fs.rmSync(dir, { recursive: true, force: true });
console.log('imessage-reader-test: OK');
