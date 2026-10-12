// Integration test: LibraryStore with the sqlite-vec index (docs/LIBRARY.md,
// vector-search section). Fake embedder (deterministic 8-dim), temp corpus,
// temp DB — nothing touches real data. better-sqlite3 is built for
// Electron's ABI, so this runs under ELECTRON_RUN_AS_NODE:
//
//   npm run test:vec
//
// Pins: ingest fills the vec0 index; KNN ordering ≡ linear-scan ordering
// (unit vectors); collection scoping; backfill from a pre-upgrade DB;
// delete hygiene; model-change wipe+rebuild; and the full no-extension
// fallback (the degrade path a packaging failure would land on).
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = require('path').join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anjadhe-vec-test-'));
process.env.ANJADHE_LIBRARY_DIR = path.join(tmp, 'library');
fs.mkdirSync(process.env.ANJADHE_LIBRARY_DIR, { recursive: true });

const Database = require(path.join(ROOT, 'node_modules/better-sqlite3'));
const sqliteVec = require(path.join(ROOT, 'node_modules/sqlite-vec'));
const LibraryStore = require(path.join(ROOT, 'js/main/library-store.js'));

let failures = 0;
const check = (name, cond, detail) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  <-- ' + (detail || '')}`);
    if (!cond) failures++;
};

// Deterministic toy embedder: 8 dims, unit vectors from char trigram counts.
const DIMS = 8;
const embedText = (t) => {
    const v = new Float32Array(DIMS);
    const s = String(t).toLowerCase();
    for (let i = 0; i < s.length; i++) v[s.charCodeAt(i) % DIMS] += 1;
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    for (let i = 0; i < DIMS; i++) v[i] /= n;
    return v;
};
const fakeEmbed = {
    spec: { name: 'fake-embed', dims: DIMS, storeDims: DIMS },
    isInstalled: () => true,
    embed: async (texts) => texts.map(embedText)
};

const dbPath = path.join(tmp, 'test.db');
const makeDb = (withVec) => {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    if (withVec) sqliteVec.load(db);
    db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)');
    db.exec(LibraryStore.DDL);
    return db;
};
let db = makeDb(true);

LibraryStore.init({
    getDb: () => db,
    embed: fakeEmbed,
    extractPdf: async () => ({ error: 'no pdf in test' }),
    broadcast: () => {}
});

// Corpus: two collections, distinct vocabulary.
const lib = process.env.ANJADHE_LIBRARY_DIR;
fs.mkdirSync(path.join(lib, 'voiceA'));
fs.mkdirSync(path.join(lib, 'other'));
fs.writeFileSync(path.join(lib, 'voiceA', 'gardening.md'),
    '# Tomatoes\n\nGrowing tomatoes needs patient watering and rich compost soil.\n\nMulch the beds before summer heat arrives.');
fs.writeFileSync(path.join(lib, 'voiceA', 'orchard.md'),
    '# Apples\n\nPruning apple trees in winter shapes the orchard canopy.\n\nGraft new varieties onto old rootstock in spring.');
fs.writeFileSync(path.join(lib, 'other', 'sailing.md'),
    '# Knots\n\nA bowline holds fast under load yet unties easily.\n\nReef the mainsail before the squall reaches the boat.');

(async () => {
    // 1) scan + drain → indexed with vec rows
    LibraryStore.scan();
    await LibraryStore.drain();
    const st = LibraryStore.status();
    check('all docs indexed', st.indexed === 3, JSON.stringify(st));
    check('status reports vec index', st.vectorIndex === 'vec', st.vectorIndex);
    const chunkCount = db.prepare('SELECT COUNT(*) c FROM library_chunks WHERE vector IS NOT NULL').get().c;
    const vecCount = db.prepare('SELECT COUNT(*) c FROM library_vec').get().c;
    check('vec index row per embedded chunk', chunkCount > 0 && vecCount === chunkCount, `chunks=${chunkCount} vec=${vecCount}`);

    // 2) search hits through KNN, and matches the linear-scan ordering
    const r1 = await LibraryStore.search('watering tomato compost', { k: 4 });
    check('semantic search returns results', r1.results.length > 0 && !r1.keywordOnly, JSON.stringify(r1).slice(0, 200));
    const qvec = embedText('watering tomato compost');
    const knn = LibraryStore._vectorRank(qvec, 10);
    const scan = LibraryStore._vectorScanRank(qvec, 10);
    check('KNN ordering == linear-scan ordering', JSON.stringify(knn) === JSON.stringify(scan), `knn=${knn} scan=${scan}`);

    // 3) collection-scoped search stays inside the collection
    const r2 = await LibraryStore.search('holds fast under load', { k: 4, collection: 'other' });
    check('scoped search returns only its collection',
        r2.results.length > 0 && r2.results.every(r => r.collection === 'other'), JSON.stringify(r2.results.map(r => r.collection)));

    // 4) backfill migration: empty the vec table (pre-upgrade install), sync refills
    db.prepare('DELETE FROM library_vec').run();
    LibraryStore._syncVecIndex();
    const refilled = db.prepare('SELECT COUNT(*) c FROM library_vec').get().c;
    check('backfill refills index from BLOBs', refilled === chunkCount, `refilled=${refilled}`);

    // 5) deleting a doc's file drops its chunks from the vec index too
    fs.rmSync(path.join(lib, 'other', 'sailing.md'));
    LibraryStore.scan();
    await LibraryStore.drain();
    const afterDel = db.prepare(
        'SELECT COUNT(*) c FROM library_vec WHERE chunk_id NOT IN (SELECT id FROM library_chunks)').get().c;
    const stillConsistent = db.prepare('SELECT COUNT(*) c FROM library_vec').get().c ===
        db.prepare('SELECT COUNT(*) c FROM library_chunks WHERE vector IS NOT NULL').get().c;
    check('doc delete leaves no vec orphans', afterDel === 0 && stillConsistent, `orphans=${afterDel}`);

    // 6) model-stamp change wipes vec rows and re-queues
    fakeEmbed.spec = { name: 'fake-embed-v2', dims: DIMS, storeDims: DIMS };
    LibraryStore.scan();
    check('model change empties vec index', db.prepare('SELECT COUNT(*) c FROM library_vec').get().c === 0);
    await LibraryStore.drain();
    check('rebuild after model change repopulates',
        db.prepare('SELECT COUNT(*) c FROM library_vec').get().c ===
        db.prepare('SELECT COUNT(*) c FROM library_chunks WHERE vector IS NOT NULL').get().c);

    // 7) no-extension connection: everything still works via linear scan
    db.close();
    db = makeDb(false);
    LibraryStore._vecCache = null;
    LibraryStore._matrixCache = null;
    const st2 = LibraryStore.status();
    check('no-vec connection reports linear', st2.vectorIndex === 'linear', st2.vectorIndex);
    const r3 = await LibraryStore.search('pruning apple orchard', { k: 4 });
    check('search still works without extension', r3.results.length > 0 && !r3.keywordOnly, JSON.stringify(r3).slice(0, 200));
    // scan() on a no-vec connection must not throw over vec maintenance
    let scanOk = true;
    try { LibraryStore.scan(); await LibraryStore.drain(); } catch (e) { scanOk = false; console.log('   scan threw: ' + e.message); }
    check('scan/drain survive a no-vec connection', scanOk);

    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL GREEN');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error('CRASH:', e); process.exit(2); });
