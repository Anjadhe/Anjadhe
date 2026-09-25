// Pins js/main/content-root.js: which folder is the user-content root, and
// the one-time ~/Anjadhe -> ~/nenva move. Runs every case inside a throwaway
// ANJADHE_DATA_ROOT, never against the real home folder.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ContentRoot = require('../js/main/content-root');

const quiet = { log() {}, warn() {} };
function fresh() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'content-root-'));
    process.env.ANJADHE_DATA_ROOT = base;
    ContentRoot._reset();
    return { base, oldDir: path.join(base, 'Anjadhe'), newDir: path.join(base, 'nenva') };
}

// 1. A new install: nothing exists, the root is nenva and nothing is created.
{
    const { newDir, oldDir } = fresh();
    assert.strictEqual(ContentRoot.resolveRoot(quiet), newDir);
    assert.ok(!fs.existsSync(newDir) && !fs.existsSync(oldDir), 'resolving creates nothing');
}

// 2. An existing install: the folder moves whole and a link is left behind.
{
    const { oldDir, newDir } = fresh();
    fs.mkdirSync(path.join(oldDir, 'Notes'), { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'Notes', 'a.md'), 'hello');
    assert.strictEqual(ContentRoot.resolveRoot(quiet), newDir);
    assert.strictEqual(fs.readFileSync(path.join(newDir, 'Notes', 'a.md'), 'utf8'), 'hello');
    assert.ok(fs.lstatSync(oldDir).isSymbolicLink(), 'the old path is a link');
    assert.strictEqual(fs.readFileSync(path.join(oldDir, 'Notes', 'a.md'), 'utf8'), 'hello', 'old paths still resolve');
    // 3. The next launch sees our own link and uses nenva, moving nothing.
    ContentRoot._reset();
    assert.strictEqual(ContentRoot.resolveRoot(quiet), newDir);
}

// 4. A link the user made to another place is theirs: left alone, kept in use.
{
    const { base, oldDir } = fresh();
    const elsewhere = path.join(base, 'external-drive', 'Anjadhe');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.symlinkSync(elsewhere, oldDir, 'dir');
    assert.strictEqual(ContentRoot.resolveRoot(quiet), oldDir);
    assert.ok(fs.lstatSync(oldDir).isSymbolicLink() && !fs.existsSync(path.join(base, 'nenva')));
}

// 5. Both folders present: no guessing, the old one stays in use, nothing moves.
{
    const { oldDir, newDir } = fresh();
    fs.mkdirSync(oldDir); fs.mkdirSync(newDir);
    fs.writeFileSync(path.join(oldDir, 'keep.md'), 'x');
    assert.strictEqual(ContentRoot.resolveRoot(quiet), oldDir);
    assert.ok(fs.existsSync(path.join(oldDir, 'keep.md')) && fs.readdirSync(newDir).length === 0);
}

// 6. The decision is made once per process.
{
    const { newDir } = fresh();
    const first = ContentRoot.resolveRoot(quiet);
    fs.mkdirSync(path.join(path.dirname(newDir), 'Anjadhe'));
    assert.strictEqual(ContentRoot.resolveRoot(quiet), first);
}

delete process.env.ANJADHE_DATA_ROOT;
console.log('content-root: all assertions passed');
