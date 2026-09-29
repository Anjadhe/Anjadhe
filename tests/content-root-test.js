// Pins js/main/content-root.js: which folder is the user-content root, and
// the one-time ~/nenva -> ~/Anjadhe move (the name returned, 2026-09-28).
// Runs every case inside a throwaway ANJADHE_DATA_ROOT, never against the
// real home folder.
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
    return { base, oldDir: path.join(base, 'nenva'), newDir: path.join(base, 'Anjadhe') };
}

// 1. A new install: nothing exists, the root is Anjadhe and nothing is created.
{
    const { newDir, oldDir } = fresh();
    assert.strictEqual(ContentRoot.resolveRoot(quiet), newDir);
    assert.ok(!fs.existsSync(newDir) && !fs.existsSync(oldDir), 'resolving creates nothing');
}

// 2. An install that never moved (a real ~/Anjadhe, no ~/nenva): used as is.
{
    const { newDir, oldDir } = fresh();
    fs.mkdirSync(newDir);
    fs.writeFileSync(path.join(newDir, 'a.md'), 'hello');
    assert.strictEqual(ContentRoot.resolveRoot(quiet), newDir);
    assert.ok(!fs.existsSync(oldDir), 'nothing moved, no link made');
}

// 3. THE COMMON CASE: alpha.87 moved ~/Anjadhe to ~/nenva and left ~/Anjadhe
//    as a link. The link goes, the folder takes its name back, and ~/nenva
//    becomes a link so remembered paths keep working.
{
    const { oldDir, newDir } = fresh();
    fs.mkdirSync(path.join(oldDir, 'Notes'), { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'Notes', 'a.md'), 'hello');
    fs.symlinkSync(oldDir, newDir, 'dir');
    assert.strictEqual(ContentRoot.resolveRoot(quiet), newDir);
    assert.ok(fs.lstatSync(newDir).isDirectory() && !fs.lstatSync(newDir).isSymbolicLink(), 'Anjadhe is a real folder again');
    assert.strictEqual(fs.readFileSync(path.join(newDir, 'Notes', 'a.md'), 'utf8'), 'hello');
    assert.ok(fs.lstatSync(oldDir).isSymbolicLink(), 'nenva is a link now');
    assert.strictEqual(fs.readFileSync(path.join(oldDir, 'Notes', 'a.md'), 'utf8'), 'hello', 'nenva paths still resolve');
    // 4. The next launch sees our own link and uses Anjadhe, moving nothing.
    ContentRoot._reset();
    assert.strictEqual(ContentRoot.resolveRoot(quiet), newDir);
}

// 5. ~/nenva real with no ~/Anjadhe at all: moves, link left behind.
{
    const { oldDir, newDir } = fresh();
    fs.mkdirSync(oldDir);
    fs.writeFileSync(path.join(oldDir, 'b.md'), 'x');
    assert.strictEqual(ContentRoot.resolveRoot(quiet), newDir);
    assert.strictEqual(fs.readFileSync(path.join(newDir, 'b.md'), 'utf8'), 'x');
    assert.ok(fs.lstatSync(oldDir).isSymbolicLink());
}

// 6. A ~/nenva link the user made to another place is theirs: left alone, kept in use.
{
    const { base, oldDir, newDir } = fresh();
    const elsewhere = path.join(base, 'external-drive', 'nenva');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.symlinkSync(elsewhere, oldDir, 'dir');
    assert.strictEqual(ContentRoot.resolveRoot(quiet), oldDir);
    assert.ok(fs.lstatSync(oldDir).isSymbolicLink() && !fs.existsSync(newDir));
}

// 7. A ~/Anjadhe link pointing SOMEWHERE ELSE is the user's: with a real
//    ~/nenva, that's ambiguous — nothing moves, ~/nenva stays in use.
{
    const { base, oldDir, newDir } = fresh();
    fs.mkdirSync(oldDir);
    const elsewhere = path.join(base, 'other');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, newDir, 'dir');
    assert.strictEqual(ContentRoot.resolveRoot(quiet), oldDir);
    assert.ok(fs.lstatSync(newDir).isSymbolicLink(), "the user's link is untouched");
}

// 8. Both real folders: no guessing, ~/nenva stays in use, nothing moves.
{
    const { oldDir, newDir } = fresh();
    fs.mkdirSync(oldDir); fs.mkdirSync(newDir);
    fs.writeFileSync(path.join(oldDir, 'keep.md'), 'x');
    assert.strictEqual(ContentRoot.resolveRoot(quiet), oldDir);
    assert.ok(fs.existsSync(path.join(oldDir, 'keep.md')) && fs.readdirSync(newDir).length === 0);
}

// 9. The decision is made once per process.
{
    const { newDir } = fresh();
    const first = ContentRoot.resolveRoot(quiet);
    fs.mkdirSync(path.join(path.dirname(newDir), 'nenva'));
    assert.strictEqual(ContentRoot.resolveRoot(quiet), first);
}

delete process.env.ANJADHE_DATA_ROOT;
console.log('content-root: all assertions passed');
