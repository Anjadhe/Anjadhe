/**
 * LicenseStore — the app's one-time license, verified OFFLINE.
 *
 * A license is a short signed string (docs/BUSINESS_MODEL.md "License"):
 *
 *     ANJ1.<payload b64url>.<Ed25519 signature b64url>
 *
 * payload = {v:1, id, class:'alpha'|'paid', sub, issuedAt, updatesUntil}
 * where `sub` is a hash of the claimant's email (never the address) and
 * `updatesUntil` is a date or null (= forever, the alpha class). Anjadhe
 * Connect mints (lib/license.js there, same format; a test on each side
 * pins it) with a private seed this repo never sees; this file carries the
 * matching PUBLIC key and can therefore check a license with no network,
 * no account and nothing sent anywhere — which is what keeps the
 * "no account" promise in POSITIONING.md true after money enters.
 *
 * What a license DOES: names the class, and bounds which releases the
 * updater may install (`updateAllowed`). What it does NOT do: lock any
 * feature. Enforcement is honour-system by construction (the source is
 * public); an unlicensed install past its trial keeps working and simply
 * stops receiving updates, with a Settings row that says so.
 *
 * Stored per Mac at <userData>/license.json — {key, email, savedAt}. The
 * email is the one the user typed to claim (shown back on the card), kept
 * locally only; it is not in the key. Deliberately not synced: a license
 * covers every Mac the person uses, and each Mac claims or pastes it once.
 *
 * Pure Node — no Electron import — so tests/license-store-test.js can run
 * it directly. Paths and the settings store are injected via init().
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');

const PREFIX = 'ANJ1';
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const CLASSES = new Set(['alpha', 'paid']);
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

const LicenseStore = {
    // The production signing key's public half (Ed25519, raw 32 bytes,
    // base64). Connect logs its public key at boot and /admin/licenses
    // shows it — the two MUST match or every minted key reads as forged.
    // ANJADHE_LICENSE_PUBLIC_KEY overrides for local testing against a
    // Connect running with a throwaway seed.
    PUBLIC_KEY_B64: 'EhX5QC71GfPXESUShSeL6JnntVb3RwMAUgWUeFj7vaw=',

    // Unlicensed installs after the paid cutover get this long before the
    // updater stops offering newer builds. Overridable from remote-config
    // `licensing.trialDays`.
    TRIAL_DAYS: 14,

    _filePath: null,
    _settings: null,
    _getPolicy: null,
    _cache: undefined,

    /**
     * @param {object} o
     * @param {string} o.filePath   where license.json lives (userData)
     * @param {object} o.settings   per-Mac settings store (get/set/delete) — trial clock
     * @param {function} [o.getPolicy] () => remote-config `licensing` block
     */
    init({ filePath, settings, getPolicy }) {
        this._filePath = filePath;
        this._settings = settings;
        this._getPolicy = typeof getPolicy === 'function' ? getPolicy : (() => ({}));
        this._cache = undefined;
    },

    publicKeyB64() {
        return process.env.ANJADHE_LICENSE_PUBLIC_KEY || this.PUBLIC_KEY_B64;
    },

    /**
     * Verify a license string. Returns {ok:true, payload} or {ok:false, error}.
     * Signature first, then shape — a malformed payload with a valid
     * signature would mean our own minter is wrong, and is still refused.
     */
    verify(key, publicKeyB64 = this.publicKeyB64()) {
        try {
            const parts = String(key || '').trim().split('.');
            if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, error: 'Not an Anjadhe license key' };
            const bytes = Buffer.from(parts[1], 'base64url');
            const sig = Buffer.from(parts[2], 'base64url');
            const raw = Buffer.from(publicKeyB64, 'base64');
            if (raw.length !== 32) return { ok: false, error: 'License public key is misconfigured' };
            const pub = { key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' };
            if (sig.length !== 64 || !crypto.verify(null, bytes, pub, sig)) return { ok: false, error: 'This key was not issued by Anjadhe (signature does not match)' };
            const p = JSON.parse(bytes.toString('utf8'));
            if (p.v !== 1 || !CLASSES.has(p.class) || !/^[a-f0-9]{16}$/.test(p.id || '')
                || !/^[a-f0-9]{32}$/.test(p.sub || '') || !DATE_RX.test(p.issuedAt || '')
                || (p.updatesUntil !== null && !DATE_RX.test(p.updatesUntil || ''))) {
                return { ok: false, error: 'License payload is malformed' };
            }
            return { ok: true, payload: p };
        } catch {
            return { ok: false, error: 'License key could not be read' };
        }
    },

    /** Does this key belong to that email? (sub = first 32 hex of SHA-256(lowercased email)) */
    matchesEmail(payload, email) {
        if (!payload || !email) return false;
        const h = crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex').slice(0, 32);
        return h === payload.sub;
    },

    /** Normalise pasted text or a file's contents to the bare key. */
    extractKey(text) {
        const s = String(text || '');
        try {
            const j = JSON.parse(s);
            if (j && typeof j.license === 'string') return j.license.trim();
            if (j && typeof j.key === 'string') return j.key.trim();
        } catch { /* not JSON */ }
        const m = s.match(/ANJ1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
        return m ? m[0] : s.trim();
    },

    // ── storage ─────────────────────────────────────────────────────────
    read() {
        if (this._cache !== undefined) return this._cache;
        let rec = null;
        try {
            if (this._filePath && fs.existsSync(this._filePath)) {
                const j = JSON.parse(fs.readFileSync(this._filePath, 'utf8'));
                if (j && typeof j.key === 'string') rec = { key: j.key, email: j.email || null, savedAt: j.savedAt || null };
            }
        } catch (e) {
            console.warn('[license] could not read license file:', e.message);
        }
        this._cache = rec;
        return rec;
    },

    /** Verify and persist. Returns the new status, or {error}. */
    save(keyText, email = null) {
        const key = this.extractKey(keyText);
        const v = this.verify(key);
        if (!v.ok) return { error: v.error };
        const rec = { key, email: email ? String(email).trim().toLowerCase().slice(0, 200) : null, savedAt: new Date().toISOString() };
        if (rec.email && !this.matchesEmail(v.payload, rec.email)) rec.email = null; // don't display an address the key wasn't issued to
        try {
            fs.writeFileSync(this._filePath, JSON.stringify(rec, null, 2), { mode: 0o600 });
        } catch (e) {
            return { error: `Could not save the license: ${e.message}` };
        }
        this._cache = rec;
        return this.status();
    },

    clear() {
        try { if (this._filePath && fs.existsSync(this._filePath)) fs.unlinkSync(this._filePath); } catch { /* best effort */ }
        this._cache = null;
        return this.status();
    },

    // ── policy ──────────────────────────────────────────────────────────
    /** {alphaClosesAt: 'YYYY-MM-DD'|null, trialDays, price} from remote-config, with defaults. */
    policy() {
        let p = {};
        try { p = this._getPolicy ? (this._getPolicy() || {}) : {}; } catch { p = {}; }
        const alphaClosesAt = DATE_RX.test(p.alphaClosesAt || '') ? p.alphaClosesAt : null;
        const trialDays = Number.isFinite(p.trialDays) && p.trialDays > 0 ? Math.floor(p.trialDays) : this.TRIAL_DAYS;
        return { alphaClosesAt, trialDays, price: typeof p.price === 'string' ? p.price : 'about $79' };
    },

    alphaOpen(today = _today()) {
        const { alphaClosesAt } = this.policy();
        return !alphaClosesAt || today < alphaClosesAt;
    },

    /**
     * The trial clock starts the first time an UNLICENSED install is seen
     * after the alpha has closed — never before (the alpha era has no
     * trial: the app is simply free, and the claim is what to do). Stored
     * per Mac; a license clears nothing, the clock just stops mattering.
     */
    _trial(today = _today()) {
        if (!this._settings || this.alphaOpen(today) || this.read()) return null;
        let startedAt = this._settings.get('trialStartedAt', null);
        if (!DATE_RX.test(startedAt || '')) {
            startedAt = today;
            try { this._settings.set('trialStartedAt', startedAt); } catch { /* read-only store in tests */ }
        }
        const { trialDays } = this.policy();
        const endsAt = _addDays(startedAt, trialDays);
        const daysLeft = Math.max(0, Math.ceil((Date.parse(endsAt) - Date.parse(today)) / 86400000));
        return { startedAt, endsAt, daysLeft, ended: today >= endsAt };
    },

    /**
     * One object the Settings card, About and the updater all read.
     * state: 'alpha' | 'paid' | 'unclaimed' (alpha open, no key) |
     *        'trial' | 'trial-ended' (alpha closed, no key)
     */
    status(today = _today()) {
        const rec = this.read();
        const pol = this.policy();
        const out = {
            licensed: false, state: 'unclaimed', class: null, id: null, issuedAt: null,
            updatesUntil: null, updatesActive: null, email: rec?.email || null,
            alphaOpen: this.alphaOpen(today), alphaClosesAt: pol.alphaClosesAt, price: pol.price,
            trial: null, invalid: null
        };
        if (rec) {
            const v = this.verify(rec.key);
            if (v.ok) {
                const p = v.payload;
                out.licensed = true;
                out.state = p.class;
                out.class = p.class;
                out.id = p.id;
                out.issuedAt = p.issuedAt;
                out.updatesUntil = p.updatesUntil;
                out.updatesActive = p.updatesUntil === null || today <= p.updatesUntil;
                out.key = rec.key; // for the card's "Show key" — the user's own key, on their own Mac
                return out;
            }
            // A stored key that no longer verifies (public key rotated,
            // file edited): say so rather than silently treating as none.
            out.invalid = v.error;
        }
        if (!out.alphaOpen) {
            const t = this._trial(today);
            out.trial = t;
            out.state = t && t.ended ? 'trial-ended' : 'trial';
        }
        return out;
    },

    /**
     * May the updater install a build released on `releaseDate`?
     * - alpha license: always.
     * - paid license: while the release date is within updatesUntil.
     * - no license: always while the alpha is open; during the trial after
     *   it closes; not after the trial ends.
     * Returns {allowed, reason} — reason names the row the UI should show.
     */
    updateAllowed(releaseDate, today = _today()) {
        const s = this.status(today);
        const rel = typeof releaseDate === 'string' && releaseDate.length >= 10 ? releaseDate.slice(0, 10) : today;
        if (s.licensed) {
            if (s.updatesUntil === null || rel <= s.updatesUntil) return { allowed: true, reason: s.class };
            return { allowed: false, reason: 'updates-ended', updatesUntil: s.updatesUntil };
        }
        if (s.alphaOpen) return { allowed: true, reason: 'alpha-open' };
        if (s.trial && !s.trial.ended) return { allowed: true, reason: 'trial' };
        return { allowed: false, reason: 'trial-ended' };
    }
};

function _today() { return new Date().toISOString().slice(0, 10); }
function _addDays(isoDay, n) {
    const d = new Date(isoDay + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

module.exports = LicenseStore;
