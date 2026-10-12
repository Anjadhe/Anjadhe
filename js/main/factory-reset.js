/**
 * Erase all content and settings (2026-10-11, by request: "like how it works
 * in iOS. clean up everything and have user start using it from scratch").
 *
 * Everything nenva keeps on this Mac goes, so the next launch is the first
 * one: chats, memory, commitments, threads, connectors and their tokens,
 * settings, the model list, the license, pairing, the Chrome profile nenva
 * drives, and the ~/nenva folder (documents, the library). The app's own
 * Chromium storage (localStorage, IndexedDB) lives in userData and goes with
 * it.
 *
 * Laws:
 *   F1  Nothing is erased while it is open. The request only writes a
 *       marker beside userData and relaunches; the NEXT process moves the
 *       folders before any store, window or database exists (main.js calls
 *       runPending right after the paths are decided).
 *   F2  Moved, never rm -rf'd. Everything lands in ONE folder,
 *       "nenva-erased-<when>", which goes to the Trash once the app is ready.
 *       A mistake is recoverable from the Trash until the person empties it.
 *   F3  What a person keeps outside this Mac's nenva stays: iCloud backups
 *       and the backup key (.nenva_backup / .nenva_sync, how they could come
 *       back), the downloaded local model weights (~/.nenva_llamacpp, shared
 *       multi-GB machine assets, like iOS keeping the OS) and the Keychain
 *       item (only a key, useless without the erased data).
 *   F4  A folder that cannot be moved is left in place and named in the
 *       log; the move never falls back to deleting.
 *   F5  The marker is read once and removed before anything is moved, so a
 *       crash mid-move cannot erase a second time on the launch after.
 *   F6  Our old-name links to an erased folder go with it (see runPending).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MARKER = 'nenva-erase-pending.json';
const STAGING_PREFIX = 'nenva-erased-';

function markerPath(userData) { return path.join(path.dirname(userData), MARKER); }

/** F1: ask for an erase on the next launch. `extra` = absolute paths outside userData (a custom DB folder's files). */
function request(userData, { extra = [], now = new Date() } = {}) {
    const file = markerPath(userData);
    fs.writeFileSync(file, JSON.stringify({ requestedAt: now.toISOString(), extra: extra.filter(p => typeof p === 'string' && path.isAbsolute(p)) }, null, 2));
    return file;
}

function _exists(p) { try { fs.lstatSync(p); return true; } catch { return false; } }

/**
 * F1/F2/F4/F5: run a pending erase. `targets` are the folders this process
 * resolved (userData, the content root); the marker adds what only the old
 * settings knew. Returns null when nothing was pending, else
 * { staging, moved: [paths], kept: [{path, error}] }.
 */
function runPending({ userData, targets = [], links = [], log = console, now = new Date() } = {}) {
    const file = markerPath(userData);
    let marker;
    try { marker = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    try { fs.unlinkSync(file); } catch (e) { log.warn?.('[erase] could not remove the marker; not erasing:', e.message); return null; }

    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const staging = path.join(path.dirname(userData), STAGING_PREFIX + stamp);
    fs.mkdirSync(staging, { recursive: true });
    const moved = [], kept = [];
    const all = [...new Set([...targets, ...((marker && marker.extra) || [])].filter(Boolean).map(p => path.resolve(p)))];
    // F6: our old-name links (~/Anjadhe -> ~/nenva, the userData one) go
    // with what they point at. Left behind they would dangle, and the next
    // launch's folder-move would keep the dangling name in use.
    const real = p => { try { return fs.realpathSync(p); } catch { return null; } };
    const reals = new Set(all.map(real).filter(Boolean));
    links.forEach((l, i) => {
        try {
            if (!l || !fs.lstatSync(l).isSymbolicLink()) return;
            const t = real(l);
            if (!t || !reals.has(t)) return;
            fs.renameSync(l, path.join(staging, `link-${i}-${path.basename(l)}`));
        } catch { /* absent, or not ours */ }
    });
    all.forEach((src, i) => {
        if (!_exists(src)) return;
        if (src === staging || staging.startsWith(src + path.sep)) { kept.push({ path: src, error: 'contains the erase folder' }); return; }
        const dest = path.join(staging, `${i}-${path.basename(src)}`);
        try { fs.renameSync(src, dest); moved.push(src); }
        catch (e) { kept.push({ path: src, error: e.message }); log.warn?.(`[erase] kept ${src}: ${e.message}`); }
    });
    return { staging, moved, kept };
}

/** F2: once Electron is ready, the erased folder goes to the Trash (left in place if that fails). */
async function trash(staging, shell, log = console) {
    if (!staging || !_exists(staging)) return false;
    try { await shell.trashItem(staging); return true; }
    catch (e) { log.warn?.(`[erase] could not move ${staging} to the Trash: ${e.message}`); return false; }
}

module.exports = { request, runPending, trash, markerPath, MARKER, STAGING_PREFIX };
