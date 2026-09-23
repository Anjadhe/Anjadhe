/**
 * The user-content folder: ~/nenva (2026-09-22, the nenva rename).
 *
 * Notes and Journal as Markdown, the Documents library and user-built apps
 * live in one folder in the home directory. It was ~/Anjadhe; it is ~/nenva.
 * An install that still has ~/Anjadhe moves it ONCE, at startup, before any
 * store, watcher or file handle touches it: a rename on the same volume
 * (atomic, nothing copied, nothing deleted), then a ~/Anjadhe symlink back
 * to ~/nenva so an Obsidian vault, a coding agent's config or a Finder
 * favourite that remembers the old path keeps working.
 *
 * Laws — every branch below exists for one of them:
 *  - Move only when unambiguous: ~/Anjadhe is a real folder AND ~/nenva does
 *    not exist. Both present means we cannot know which one is the user's,
 *    so nothing moves and ~/Anjadhe stays in use.
 *  - A ~/Anjadhe symlink is either our own (points at ~/nenva: done) or the
 *    user's (points anywhere else, e.g. another drive): the user's is left
 *    alone and stays in use — following it to an empty ~/nenva would look
 *    like lost data.
 *  - Any failure keeps ~/Anjadhe. The folder name is cosmetic; the data is
 *    not.
 *  - Under ANJADHE_DATA_ROOT the same rule runs inside the test root, never
 *    against the real home folder.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const NEW_NAME = 'nenva';
const OLD_NAME = 'Anjadhe';

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
    const newSt = _lstat(newDir);

    if (oldSt && oldSt.isSymbolicLink()) {
        // Ours points at ~/nenva; anything else is the user's own link.
        const target = _real(oldDir);
        if (target && newSt && target === _real(newDir)) return (_root = newDir);
        log.warn(`[content-root] ${oldDir} is a link to ${target || 'nowhere'}; keeping it`);
        return (_root = oldDir);
    }
    if (oldSt && oldSt.isDirectory()) {
        if (newSt) {
            log.warn(`[content-root] both ${oldDir} and ${newDir} exist; keeping ${oldDir}`);
            return (_root = oldDir);
        }
        try {
            fs.renameSync(oldDir, newDir);
        } catch (e) {
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
