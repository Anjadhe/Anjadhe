/**
 * The user-content folder: ~/nenva (2026-09-30, the nenva name returned).
 *
 * Notes and Journal as Markdown, the Documents library and user-built apps
 * live in one folder in the home directory. It was ~/Anjadhe, then ~/nenva
 * (alpha.87, the nenva rebrand), ~/Anjadhe again (alpha.94) and is ~/nenva
 * again. An install that has ~/Anjadhe moves it ONCE, at startup, before any
 * store, watcher or file handle touches it: a rename on the same volume
 * (atomic, nothing copied, nothing deleted), then a ~/Anjadhe symlink back
 * to ~/nenva so an Obsidian vault, a coding agent's config or a Finder
 * favourite that remembers the Anjadhe path keeps working.
 *
 * The move itself is js/main/folder-move.js (shared with the other nenva
 * folders); its laws, applied here:
 *  - Move only when unambiguous: ~/Anjadhe is a real folder AND ~/nenva is
 *    either absent or OUR OWN link to ~/Anjadhe (what alpha.94 left behind).
 *    Two real folders means we cannot know which one is the user's, so
 *    nothing moves and ~/Anjadhe stays in use.
 *  - A ~/Anjadhe symlink is either our own (points at ~/nenva: done) or the
 *    user's (points anywhere else): the user's is left alone and stays in
 *    use — following it to an empty ~/nenva would look like lost data.
 *  - Any failure keeps ~/Anjadhe. The folder name is cosmetic; the data is not.
 *  - Under ANJADHE_DATA_ROOT the same rule runs inside the test root, never
 *    against the real home folder.
 */
'use strict';
const os = require('os');
const path = require('path');
const { moveOnce } = require('./folder-move');

const NEW_NAME = 'nenva';
const OLD_NAME = 'Anjadhe';

let _root = null;

function _base() {
    return process.env.ANJADHE_DATA_ROOT ? path.resolve(process.env.ANJADHE_DATA_ROOT) : os.homedir();
}

/** Decide (and, once, migrate) the content root. Memoised per process. */
function resolveRoot(log = console) {
    if (_root) return _root;
    const base = _base();
    return (_root = moveOnce(path.join(base, OLD_NAME), path.join(base, NEW_NAME), { log }));
}

/** Test seam: forget the memoised decision. */
function _reset() { _root = null; }

module.exports = { resolveRoot, NEW_NAME, OLD_NAME, _reset };
