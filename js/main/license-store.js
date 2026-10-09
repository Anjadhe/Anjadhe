/**
 * LicenseStore — the app's license, verified OFFLINE.
 *
 * nenva's core is free for good (decided 2026-09-30, docs/BUSINESS_MODEL.md):
 * the license is how a person REGISTERS, and later what may unlock a paid
 * integration. It never gates updates and never locks a feature.
 *
 * A license is a short signed string:
 *
 *     ANJ1.<payload b64url>.<Ed25519 signature b64url>
 *
 * payload = {v:1, id, class:'alpha'|'free'|'paid', sub, issuedAt, updatesUntil}
 * where `sub` is a hash of the claimant's email (never the address) and
 * `updatesUntil` is a date or null (= forever: alpha and free). 'alpha' was
 * minted while the alpha was open, 'free' after; they mean the same. nenva
 * Connect mints (lib/license.js there, same format; a test on each side
 * pins it) with a private seed this repo never sees; this file carries the
 * matching PUBLIC key and can therefore check a license with no network,
 * no account and nothing sent anywhere — which is what keeps the
 * "no account" promise in POSITIONING.md true after money enters.
 *
 * Until 2026-09-30 a license also bounded which releases the updater could
 * install, with a trial for unlicensed installs; both went when the app
 * became free. Enforcement of anything future stays honour-system by
 * construction (the source is public).
 *
 * Stored per Mac at <userData>/license.json — {key, email, savedAt}. The
 * email is the one the user typed to claim (shown back on the card), kept
 * locally only; it is not in the key. Deliberately not synced: a license
 * covers every Mac the person uses, and each Mac claims or pastes it once.
 *
 * Pure Node — no Electron import — so tests/license-store-test.js can run
 * it directly. The file path is injected via init().
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');

const PREFIX = 'ANJ1';
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const CLASSES = new Set(['alpha', 'free', 'paid']);
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

const LicenseStore = {
    // The production signing key's public half (Ed25519, raw 32 bytes,
    // base64). Connect logs its public key at boot and /admin/licenses
    // shows it — the two MUST match or every minted key reads as forged.
    // ANJADHE_LICENSE_PUBLIC_KEY overrides for local testing against a
    // Connect running with a throwaway seed.
    PUBLIC_KEY_B64: 'EhX5QC71GfPXESUShSeL6JnntVb3RwMAUgWUeFj7vaw=',

    _filePath: null,
    _cache: undefined,

    /** @param {object} o  {filePath} — where license.json lives (userData) */
    init({ filePath }) {
        this._filePath = filePath;
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
            if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, error: 'Not a nenva license key' };
            const bytes = Buffer.from(parts[1], 'base64url');
            const sig = Buffer.from(parts[2], 'base64url');
            const raw = Buffer.from(publicKeyB64, 'base64');
            if (raw.length !== 32) return { ok: false, error: 'License public key is misconfigured' };
            const pub = { key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' };
            if (sig.length !== 64 || !crypto.verify(null, bytes, pub, sig)) return { ok: false, error: 'This key was not issued by nenva (signature does not match)' };
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

    /**
     * One object the Settings card, About and the claim doors read.
     * state: 'alpha' | 'free' | 'paid' (a key on this Mac) | 'unclaimed'
     */
    status() {
        const rec = this.read();
        const out = {
            licensed: false, state: 'unclaimed', class: null, id: null, issuedAt: null,
            updatesUntil: null, email: rec?.email || null, invalid: null
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
                out.key = rec.key; // for the card's "Show key" — the user's own key, on their own Mac
                return out;
            }
            // A stored key that no longer verifies (public key rotated,
            // file edited): say so rather than silently treating as none.
            out.invalid = v.error;
        }
        return out;
    }
};

module.exports = LicenseStore;
