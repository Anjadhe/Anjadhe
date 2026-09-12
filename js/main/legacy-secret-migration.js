/**
 * Carries secrets encrypted under the WRONG keychain key over to the right one.
 *
 * Background: between 1523feb (2026-07-16) and 2026-08-02 the main process
 * touched safeStorage at module load — before `app.whenReady()` — so Chromium
 * cached a generic shared keychain secret for the whole run instead of the
 * app's own "Anjadhe Safe Storage" item (see js/main/secret-store.js). Secrets
 * written before that regression are unreadable by those builds; secrets
 * written during it are unreadable by the fixed build. Either way the user sees
 * "could not be decrypted" and is silently signed out of things they never
 * disconnected.
 *
 * A process can only ever hold ONE of the two keys — the resolution is cached
 * on first use and there is no API to re-resolve it. So the recovery is a
 * short-lived CHILD copy of the app launched with --anjadhe-read-legacy-secrets:
 * it touches safeStorage before ready (deliberately, to get the legacy key),
 * decrypts the blobs it is handed on stdin, writes the plaintext back on
 * stdout, and exits without ever opening a window, a store or the database.
 * The parent — post-ready, holding the correct key — re-encrypts and saves.
 * Plaintext exists only in the pipe between two processes of the same app, and
 * only for the values that were already going to be lost.
 *
 * Nothing is deleted: a value that neither key can read is left exactly as it
 * is and reported, so a transient keychain denial can never turn into data
 * loss. The scan is cheap and runs every launch; the child is spawned only when
 * something is actually unreadable, and not again for a set of values already
 * proven unrecoverable.
 */

const { app, safeStorage } = require('electron');
const fs = require('fs');
const { spawn } = require('child_process');

const CHILD_FLAG = '--anjadhe-read-legacy-secrets';
const MARKER_KEY = 'legacySecretMigration';
const CHILD_TIMEOUT_MS = 20000;

// safeStorage ciphertext is Chromium's OSCrypt format: an ASCII version tag
// ("v10"/"v11") followed by the ciphertext. Matching on the tag keeps the walk
// from mistaking ordinary base64 (the phone channel's raw keypair, ids, hashes)
// for something to decrypt.
function isSafeStorageBlob(value) {
    if (typeof value !== 'string' || value.length < 24 || value.length % 4 !== 0) return false;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
    let head;
    try { head = Buffer.from(value, 'base64').subarray(0, 3).toString('latin1'); }
    catch { return false; }
    return head === 'v10' || head === 'v11';
}

// Every encrypted string in the settings tree, with the object that holds it so
// a recovered value can be written back in place. Nested because tokens live
// under per-account objects (and electron-store's dot-paths split the "." in an
// email address, so path strings are for logging only — never for writing).
function collectBlobs(node, path, out) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return out;
    for (const [key, value] of Object.entries(node)) {
        const here = path ? `${path}.${key}` : key;
        if (isSafeStorageBlob(value)) out.push({ parent: node, key, path: here, value });
        else if (value && typeof value === 'object') collectBlobs(value, here, out);
    }
    return out;
}

/**
 * Child mode. Runs at the very top of main.js, BEFORE app ready and before any
 * store or window exists, so safeStorage hands back the legacy key. Reads
 * {blobs:{id:base64}} from stdin, writes {plain:{id:string|null}} to stdout.
 */
function runChildMode() {
    let payload = { plain: {}, error: null };
    try {
        const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
        for (const [id, b64] of Object.entries(input.blobs || {})) {
            try { payload.plain[id] = safeStorage.decryptString(Buffer.from(b64, 'base64')); }
            catch { payload.plain[id] = null; }
        }
    } catch (err) {
        payload.error = err.message;
    }
    // writeSync, not console.log: stdout is a pipe here, and an async write can
    // be truncated by the exit below.
    try { fs.writeSync(1, JSON.stringify(payload)); } catch { /* parent gave up */ }
    process.exit(0);
}

function readLegacyValues(blobs) {
    return new Promise((resolve) => {
        // Dev runs `electron .`, so the app path is an argument; a packaged
        // build IS the executable and must not be handed one.
        const args = app.isPackaged ? [CHILD_FLAG] : [app.getAppPath(), CHILD_FLAG];
        let child;
        try {
            child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'ignore'] });
        } catch (err) {
            resolve({ error: err.message });
            return;
        }
        let out = '';
        let settled = false;
        const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish({ error: 'timed out' }); }, CHILD_TIMEOUT_MS);

        child.stdout.on('data', (chunk) => { out += chunk.toString(); });
        child.on('error', (err) => { clearTimeout(timer); finish({ error: err.message }); });
        child.on('close', () => {
            clearTimeout(timer);
            // Chromium may print its own noise on stdout before our reply, so
            // take the JSON object rather than the whole stream.
            const start = out.indexOf('{');
            const end = out.lastIndexOf('}');
            try { finish(JSON.parse(start >= 0 && end > start ? out.slice(start, end + 1) : '{}')); }
            catch (err) { finish({ error: `unreadable reply: ${err.message}` }); }
        });
        try { child.stdin.end(JSON.stringify({ blobs })); }
        catch (err) { clearTimeout(timer); finish({ error: err.message }); }
    });
}

/**
 * Parent side. Call once, inside app.whenReady(), BEFORE anything reads a
 * secret — the sync key cache is one of the values this repairs.
 * Returns {scanned, stuck, recovered, unresolved[]}.
 */
async function migrate(settingsStore) {
    const result = { scanned: 0, stuck: 0, recovered: 0, unresolved: [] };
    let root;
    try {
        if (!safeStorage.isEncryptionAvailable()) return result;
        root = settingsStore.store;
    } catch (err) {
        console.warn('[secret-migration] skipped:', err.message);
        return result;
    }

    const blobs = collectBlobs(root, '', []);
    result.scanned = blobs.length;
    const stuck = blobs.filter((b) => {
        try { safeStorage.decryptString(Buffer.from(b.value, 'base64')); return false; }
        catch { return true; }
    });
    result.stuck = stuck.length;

    const marker = settingsStore.get(MARKER_KEY, null);
    if (!stuck.length) {
        if (marker) settingsStore.delete(MARKER_KEY);
        return result;
    }

    // Don't relaunch a child every boot for values the legacy key couldn't read
    // either (a foreign backup, a keychain reset). Any NEW unreadable value
    // changes the signature and gets its own attempt.
    const signature = stuck.map(b => b.path).sort().join('|');
    if (marker && marker.signature === signature) {
        result.unresolved = stuck.map(b => b.path);
        return result;
    }

    console.warn(`[secret-migration] ${stuck.length} stored secret(s) unreadable with this Mac's key — trying the legacy key`);
    const payload = {};
    stuck.forEach((b, i) => { payload[String(i)] = b.value; });
    const reply = await readLegacyValues(payload);
    if (reply.error) console.warn('[secret-migration] legacy reader failed:', reply.error);

    const plain = (reply && reply.plain) || {};
    stuck.forEach((b, i) => {
        const value = plain[String(i)];
        if (typeof value !== 'string') { result.unresolved.push(b.path); return; }
        try {
            b.parent[b.key] = safeStorage.encryptString(value).toString('base64');
            result.recovered++;
        } catch (err) {
            console.warn(`[secret-migration] could not re-encrypt ${b.path}:`, err.message);
            result.unresolved.push(b.path);
        }
    });

    if (result.recovered) {
        // Assign the whole tree back: the per-account token keys contain dots,
        // which electron-store's dot-path setter would split into nested keys.
        settingsStore.store = root;
        console.warn(`[secret-migration] recovered ${result.recovered} secret(s) under this Mac's own keychain key`);
    }
    // The marker means "the legacy key was asked and had nothing either" — only
    // a reader that actually ran can say that. If the child never launched
    // (spawn refused, timed out, unreadable reply) leave no marker, so the next
    // launch tries again instead of writing the values off.
    if (!reply.error) {
        settingsStore.set(MARKER_KEY, {
            at: new Date().toISOString(),
            recovered: result.recovered,
            unresolved: result.unresolved,
            signature: result.unresolved.length ? result.unresolved.slice().sort().join('|') : ''
        });
    }
    if (result.unresolved.length) {
        console.warn(`[secret-migration] still unreadable (left untouched): ${result.unresolved.join(', ')}`);
    }
    return result;
}

module.exports = { CHILD_FLAG, runChildMode, migrate, isSafeStorageBlob, collectBlobs };
