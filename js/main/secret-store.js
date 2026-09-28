/**
 * Every safeStorage call in the main process goes through here.
 *
 * WHY (2026-08-02): Chromium resolves the OS keychain secret on FIRST use and
 * caches it for the life of the process. Before `app.whenReady()` it has not
 * adopted the app's name yet, so it reaches for a generic shared keychain item
 * instead of "Anjadhe Safe Storage" — and because the resolution is cached, a
 * single pre-ready call poisons EVERY secret that run touches: API keys, OAuth
 * tokens and the sync-key cache all get written under, or read against, the
 * wrong key. That is exactly what happened when the H6 sync-passphrase work
 * (1523feb, 2026-07-16) added a safeStorage read to module scope: every launch
 * after it silently lost the keys saved before it, and stored new secrets under
 * a keychain item shared with other Chromium-based apps rather than Anjadhe's
 * own. See docs/SECURITY-AUDIT.md and js/main/legacy-secret-migration.js.
 *
 * So: these wrappers THROW when called before ready rather than quietly using
 * the wrong key. Fail closed — a thrown error means a secret is not read and
 * not written, which every call site already handles; the wrong key means
 * silent, permanent data loss. Callers must not "fix" a throw by falling back
 * to plaintext storage.
 *
 * The one intentional bypass is the child process in
 * legacy-secret-migration.js, which uses raw safeStorage pre-ready precisely
 * BECAUSE that yields the old, wrong key it needs to read legacy values.
 */

const { app, safeStorage } = require('electron');

function assertReady(op) {
    if (app.isReady()) return;
    throw new Error(
        `[secret-store] safeStorage.${op}() called before app ready — this would use the wrong ` +
        `keychain key for the whole process. Move the call inside app.whenReady().`
    );
}

module.exports = {
    isEncryptionAvailable() {
        assertReady('isEncryptionAvailable');
        return safeStorage.isEncryptionAvailable();
    },

    encryptString(plainText) {
        assertReady('encryptString');
        return safeStorage.encryptString(plainText);
    },

    decryptString(buffer) {
        assertReady('decryptString');
        return safeStorage.decryptString(buffer);
    }
};
