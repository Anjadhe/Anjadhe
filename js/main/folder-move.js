/**
 * Move one of the app's folders to its nenva name, once (2026-09-30).
 *
 * The product is nenva, and the folders a person can find on their drive say
 * so: the user-content root (~/nenva), the app's internal data
 * (~/Library/Application Support/nenva), the local AI engine (~/.nenva_llamacpp)
 * and the iCloud sync journal and backups (.nenva_sync, .nenva_backup). Each
 * used to carry the Anjadhe name. This is the one mover all of them use.
 *
 * Laws — every branch below exists for one of them:
 *  - A move is a rename on the same volume: atomic, nothing copied, nothing
 *    deleted. It runs at startup before any store, watcher or process opens
 *    the folder.
 *  - Move only when unambiguous: the old folder is real AND the new name is
 *    either absent or OUR OWN link back to the old folder (what an earlier
 *    rename left behind). Two real folders: `onConflict` decides which one
 *    stays in use ('old', the default, for folders holding the user's only
 *    copy; 'new' for the iCloud folders, where a stale Mac on an old build
 *    re-creating the old name must not pull this Mac back), and nothing moves.
 *  - An old-name symlink is either ours (points at the new folder: done) or
 *    the user's (points anywhere else): the user's is left alone and stays in
 *    use — following it to an empty new folder would look like lost data.
 *  - `link: true` leaves a symlink at the old name so a remembered path (an
 *    Obsidian vault, a coding agent's config, an absolute path stored in the
 *    data) keeps working. Not in iCloud Drive, which does not sync links.
 *  - Any failure keeps the old folder. The name is cosmetic; the data is not.
 */
'use strict';
const fs = require('fs');

function _lstat(p) {
    try { return fs.lstatSync(p); } catch { return null; }
}

function _real(p) {
    try { return fs.realpathSync(p); } catch { return null; }
}

/** Returns the folder to use: newDir, or oldDir when it could not move. */
function moveOnce(oldDir, newDir, { link = true, onConflict = 'old', log = console } = {}) {
    const oldSt = _lstat(oldDir);
    let newSt = _lstat(newDir);

    if (oldSt && oldSt.isSymbolicLink()) {
        // Ours points at the new folder; anything else is the user's own link.
        const target = _real(oldDir);
        if (target && newSt && target === _real(newDir)) return newDir;
        if (onConflict === 'new' && newSt) return newDir;
        log.warn(`[folder-move] ${oldDir} is a link to ${target || 'nowhere'}; keeping it`);
        return oldDir;
    }
    if (oldSt && oldSt.isDirectory()) {
        // An earlier rename (the other way) left the new name as a link to
        // the old folder. That link is ours: it goes first, so the folder can
        // take the name.
        let removedLink = false;
        if (newSt && newSt.isSymbolicLink() && _real(newDir) === _real(oldDir)) {
            try {
                fs.unlinkSync(newDir);
                newSt = null;
                removedLink = true;
            } catch (e) {
                log.warn(`[folder-move] could not remove the old link ${newDir} (${e.code || e.message}); keeping ${oldDir}`);
                return oldDir;
            }
        }
        if (newSt) {
            const keep = onConflict === 'new' ? newDir : oldDir;
            log.warn(`[folder-move] both ${oldDir} and ${newDir} exist; keeping ${keep}`);
            return keep;
        }
        try {
            fs.renameSync(oldDir, newDir);
        } catch (e) {
            // Put our link back if we removed it, so nothing changed at all.
            if (removedLink) { try { if (!_lstat(newDir)) fs.symlinkSync(oldDir, newDir, 'dir'); } catch { /* best effort */ } }
            log.warn(`[folder-move] could not move ${oldDir} to ${newDir} (${e.code || e.message}); keeping ${oldDir}`);
            return oldDir;
        }
        if (link) {
            try {
                fs.symlinkSync(newDir, oldDir, 'dir');
            } catch (e) {
                log.warn(`[folder-move] moved to ${newDir}, but the ${oldDir} link failed (${e.code || e.message})`);
            }
        }
        log.log(`[folder-move] moved ${oldDir} to ${newDir}`);
        return newDir;
    }
    return newDir;
}

module.exports = { moveOnce };
