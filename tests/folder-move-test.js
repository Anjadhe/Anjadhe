// Pins js/main/folder-move.js: the one mover for the folders that carry the
// nenva name (userData, ~/.nenva_llamacpp, the iCloud journal and backups).
// The content root's own cases are in tests/content-root-test.js; these pin
// the two options it does not use. Runs in a throwaway folder.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { moveOnce } = require('../js/main/folder-move');

const quiet = { log() {}, warn() {} };
function fresh() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-move-'));
    return { base, oldDir: path.join(base, '.anjadhe_sync'), newDir: path.join(base, '.nenva_sync') };
}

// 1. link: false (iCloud) moves the folder and leaves nothing at the old name.
{
    const { oldDir, newDir } = fresh();
    fs.mkdirSync(path.join(oldDir, 'mac-a'), { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'mac-a', 'k.json'), '{}');
    assert.strictEqual(moveOnce(oldDir, newDir, { link: false, onConflict: 'new', log: quiet }), newDir);
    assert.ok(fs.existsSync(path.join(newDir, 'mac-a', 'k.json')));
    assert.ok(!fs.existsSync(oldDir) && !fs.lstatSync(newDir).isSymbolicLink(), 'no link left behind');
}

// 2. onConflict: 'new' — an older Mac re-created the old folder: the new one
//    stays in use and neither is touched.
{
    const { oldDir, newDir } = fresh();
    fs.mkdirSync(oldDir); fs.mkdirSync(newDir);
    fs.writeFileSync(path.join(oldDir, 'stale.json'), '{}');
    assert.strictEqual(moveOnce(oldDir, newDir, { link: false, onConflict: 'new', log: quiet }), newDir);
    assert.ok(fs.existsSync(path.join(oldDir, 'stale.json')) && fs.readdirSync(newDir).length === 0);
}

// 3. The default keeps the old folder when both are real (the user's only copy).
{
    const { oldDir, newDir } = fresh();
    fs.mkdirSync(oldDir); fs.mkdirSync(newDir);
    assert.strictEqual(moveOnce(oldDir, newDir, { log: quiet }), oldDir);
}

// 4. Nothing at either name: the new name is used and nothing is created.
{
    const { oldDir, newDir } = fresh();
    assert.strictEqual(moveOnce(oldDir, newDir, { log: quiet }), newDir);
    assert.ok(!fs.existsSync(oldDir) && !fs.existsSync(newDir));
}

// 5. A second run after a linked move is a no-op.
{
    const { oldDir, newDir } = fresh();
    fs.mkdirSync(oldDir);
    moveOnce(oldDir, newDir, { log: quiet });
    assert.ok(fs.lstatSync(oldDir).isSymbolicLink());
    assert.strictEqual(moveOnce(oldDir, newDir, { log: quiet }), newDir);
    assert.ok(fs.lstatSync(newDir).isDirectory() && !fs.lstatSync(newDir).isSymbolicLink());
}

console.log('folder-move: all assertions passed');
