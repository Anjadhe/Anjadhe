/**
 * The user-content folder: ~/Anjadhe (2026-09-28, the name returned).
 *
 * Notes and Journal as Markdown, the Documents library and user-built apps
 * live in one folder in the home directory. It was ~/Anjadhe, then ~/nenva
 * (alpha.87, the nenva rebrand), and is ~/Anjadhe again: "nenva" is now a
 * separate, newer product, and this app is Anjadhe. An install that has
 * ~/nenva moves it ONCE, at startup, before any store, watcher or file
 * handle touches it: a rename on the same volume (atomic, nothing copied,
 * nothing deleted), then a ~/nenva symlink back to ~/Anjadhe so an Obsidian
 * vault, a coding agent's config or a Finder favourite that remembers the
 * nenva path keeps working.
 *
 * Laws — every branch below exists for one of them:
 *  - Move only when unambiguous: ~/nenva is a real folder AND ~/Anjadhe is
 *    either absent or OUR OWN link to ~/nenva (what alpha.87 left behind).
 *    Two real folders means we cannot know which one is the user's, so
 *    nothing moves and ~/nenva stays in use.
 *  - A ~/nenva symlink is either our own (points at ~/Anjadhe: done) or the
 *    user's (points anywhere else): the user's is left alone and stays in
 *    use — following it to an empty ~/Anjadhe would look like lost data.
 *  - Any failure keeps ~/nenva. The folder name is cosmetic; the data is not.
 *  - Under ANJADHE_DATA_ROOT the same rule runs inside the test root, never
 *    against the real home folder.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const NEW_NAME = 'Anjadhe';
const OLD_NAME = 'nenva';

let _root = null;

function _base() {
    return process.env.ANJADHE_DATA_ROOT ? path.resolve(process.env.ANJADHE_DATA_ROOT) : os.homedir();
}

function _lstat(p) {
    try { return fs.lstatSync(p); } catch { return null; }
}

function _real(p) {
    try { return fs.realpathSync(p); } catch { return null; }
}

/** Decide (and, once, migrate) the content root. Memoised per process. */
function resolveRoot(log = console) {
    if (_root) return _root;
    const base = _base();
    const oldDir = path.join(base, OLD_NAME);
    const newDir = path.join(base, NEW_NAME);
    const oldSt = _lstat(oldDir);
    let newSt = _lstat(newDir);

    if (oldSt && oldSt.isSymbolicLink()) {
        // Ours points at ~/Anjadhe; anything else is the user's own link.
        const target = _real(oldDir);
        if (target && newSt && target === _real(newDir)) return (_root = newDir);
        log.warn(`[content-root] ${oldDir} is a link to ${target || 'nowhere'}; keeping it`);
        return (_root = oldDir);
    }
    if (oldSt && oldSt.isDirectory()) {
        // alpha.87 left ~/Anjadhe as a link to ~/nenva. That link is ours:
        // it goes first, so the folder can take its name back.
        if (newSt && newSt.isSymbolicLink() && _real(newDir) === _real(oldDir)) {
            try {
                fs.unlinkSync(newDir);
                newSt = null;
            } catch (e) {
                log.warn(`[content-root] could not remove the old link ${newDir} (${e.code || e.message}); keeping ${oldDir}`);
                return (_root = oldDir);
            }
        }
        if (newSt) {
            log.warn(`[content-root] both ${oldDir} and ${newDir} exist; keeping ${oldDir}`);
            return (_root = oldDir);
        }
        try {
            fs.renameSync(oldDir, newDir);
        } catch (e) {
            // Put our link back if we removed it, so nothing changed at all.
            try { if (!_lstat(newDir)) fs.symlinkSync(oldDir, newDir, 'dir'); } catch { /* best effort */ }
            log.warn(`[content-root] could not move ${oldDir} to ${newDir} (${e.code || e.message}); keeping ${oldDir}`);
            return (_root = oldDir);
        }
        try {
            fs.symlinkSync(newDir, oldDir, 'dir');
        } catch (e) {
            log.warn(`[content-root] moved to ${newDir}, but the ${oldDir} link failed (${e.code || e.message})`);
        }
        log.log(`[content-root] moved ${oldDir} to ${newDir}`);
        return (_root = newDir);
    }
    return (_root = newDir);
}

/** Test seam: forget the memoised decision. */
function _reset() { _root = null; }

module.exports = { resolveRoot, NEW_NAME, OLD_NAME, _reset };
