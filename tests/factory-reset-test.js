// Pins js/main/factory-reset.js: erase all content and settings. The
// request only marks; the next launch moves everything into ONE folder
// (never deletes), takes our old-name links along, and runs once.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const FR = require('../js/main/factory-reset');

const quiet = { log() {}, warn() {} };
function fresh() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-reset-'));
    const appData = path.join(base, 'Application Support');
    const userData = path.join(appData, 'nenva');
    const content = path.join(base, 'home', 'nenva');
    fs.mkdirSync(path.join(userData, 'Local Storage'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'anjadhe-app-data.db'), 'db');
    fs.mkdirSync(path.join(content, 'library'), { recursive: true });
    fs.writeFileSync(path.join(content, 'library', 'doc.pdf'), 'pdf');
    fs.symlinkSync(userData, path.join(appData, 'Anjadhe'), 'dir');
    fs.symlinkSync(content, path.join(base, 'home', 'Anjadhe'), 'dir');
    return { base, appData, userData, content };
}

// 1. Nothing pending: nothing moves.
{
    const { userData, content } = fresh();
    assert.strictEqual(FR.runPending({ userData, targets: [userData, content], log: quiet }), null);
    assert.ok(fs.existsSync(path.join(userData, 'anjadhe-app-data.db')));
}

// 2. A request moves userData, the content folder, a custom DB file and our
//    links into ONE folder beside userData; the marker is gone (F1, F2, F5, F6).
{
    const { base, appData, userData, content } = fresh();
    const customDir = path.join(base, 'custom');
    fs.mkdirSync(customDir);
    const db = path.join(customDir, 'anjadhe-app-data.db');
    fs.writeFileSync(db, 'custom');
    FR.request(userData, { extra: [db, path.join(customDir, 'missing-wal'), 'relative/ignored'] });
    assert.ok(fs.existsSync(FR.markerPath(userData)));
    const r = FR.runPending({ userData, targets: [userData, content],
        links: [path.join(appData, 'Anjadhe'), path.join(base, 'home', 'Anjadhe')], log: quiet });
    assert.ok(r && r.staging.startsWith(path.join(appData, FR.STAGING_PREFIX)));
    assert.deepStrictEqual(r.kept, []);
    assert.strictEqual(r.moved.length, 3);
    assert.ok(!fs.existsSync(userData) && !fs.existsSync(content) && !fs.existsSync(db), 'all three moved');
    assert.ok(!fs.existsSync(FR.markerPath(userData)), 'marker read once');
    const inside = fs.readdirSync(r.staging);
    assert.strictEqual(inside.filter(n => n.startsWith('link-')).length, 2, 'both old-name links moved too');
    assert.ok(!fs.existsSync(path.join(appData, 'Anjadhe')) && !fs.existsSync(path.join(base, 'home', 'Anjadhe')));
    // Nothing was deleted: the data is all in the erase folder.
    const ud = inside.find(n => n.endsWith('-nenva') && fs.existsSync(path.join(r.staging, n, 'anjadhe-app-data.db')));
    assert.ok(ud, 'userData is in the erase folder');
    assert.ok(inside.some(n => fs.existsSync(path.join(r.staging, n, 'library', 'doc.pdf'))), 'the documents are too');
    // F5: a second launch does nothing.
    assert.strictEqual(FR.runPending({ userData, targets: [userData, content], log: quiet }), null);
}

// 3. A user's own link that points elsewhere is not ours: it stays.
{
    const { base, appData, userData, content } = fresh();
    const other = path.join(base, 'elsewhere');
    fs.mkdirSync(other);
    fs.unlinkSync(path.join(base, 'home', 'Anjadhe'));
    fs.symlinkSync(other, path.join(base, 'home', 'Anjadhe'), 'dir');
    FR.request(userData);
    FR.runPending({ userData, targets: [userData, content], links: [path.join(base, 'home', 'Anjadhe')], log: quiet });
    assert.ok(fs.lstatSync(path.join(base, 'home', 'Anjadhe')).isSymbolicLink(), 'the user\'s link stays');
    assert.ok(fs.existsSync(other));
}

// 4. trash() hands the erase folder to the shell and tolerates a failure (F2, F4).
(async () => {
    const { userData, content } = fresh();
    FR.request(userData);
    const r = FR.runPending({ userData, targets: [userData, content], log: quiet });
    let trashed = null;
    assert.strictEqual(await FR.trash(r.staging, { trashItem: async p => { trashed = p; } }, quiet), true);
    assert.strictEqual(trashed, r.staging);
    assert.strictEqual(await FR.trash(r.staging, { trashItem: async () => { throw new Error('no'); } }, quiet), false);
    assert.ok(fs.existsSync(r.staging), 'a failed trash leaves the folder, never deletes it');
    console.log('factory-reset-test: all passed');
})().catch(e => { console.error(e); process.exit(1); });
