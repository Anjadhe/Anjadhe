/**
 * Signed remote-config (2026-10-12, the architecture review). The live
 * remote-config.json pins the llama.cpp engine and model weights by URL and
 * SHA-256, and switches features; whoever can change that file on GitHub
 * could point every install at their own build. So the file carries an
 * Ed25519 signature made with a key that never enters a repo, and main
 * keeps only a fetched or cached copy that verifies against the public key
 * baked in here (the license key's pattern, js/main/license-store.js).
 *
 *   RC1  The signature covers every field but `signature`, in a canonical
 *        form (keys sorted at every level), so formatting never matters.
 *   RC2  A remote or cached copy that does not verify is not used; main
 *        falls back to the next source. The bundled copy ships inside the
 *        signed app and is trusted as it is.
 *   RC3  Signing is `node scripts/sign-remote-config.js` with the private
 *        key outside the repo; tests/remote-config-signature-test.js fails
 *        while the committed file's signature does not match.
 */
'use strict';
const crypto = require('crypto');

const PUBLIC_KEY_B64 = 'pnqfWW2arkdzHa78x3amalWY5/E6jUURUJH2b+UnBaY=';
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}

function signedBytes(config) {
    const { signature, ...rest } = config || {};
    return Buffer.from(canonical(rest), 'utf8');
}

/** @returns {boolean} true when `config.signature` was made by the key. */
function verify(config, publicKeyB64 = process.env.ANJADHE_REMOTE_CONFIG_PUBLIC_KEY || PUBLIC_KEY_B64) {
    try {
        if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
        const sig = config.signature;
        if (!sig || sig.alg !== 'ed25519' || typeof sig.value !== 'string') return false;
        const raw = Buffer.from(publicKeyB64, 'base64');
        const bytes = Buffer.from(sig.value, 'base64');
        if (raw.length !== 32 || bytes.length !== 64) return false;
        const pub = { key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' };
        return crypto.verify(null, signedBytes(config), pub, bytes);
    } catch {
        return false;
    }
}

/** Parse JSON text and keep it only if it verifies; else null. */
function parseVerified(text) {
    try {
        const config = JSON.parse(text);
        return verify(config) ? config : null;
    } catch {
        return null;
    }
}

/** Sign with a PEM private key. Returns a copy with `signature` set. */
function sign(config, privateKeyPem) {
    const { signature, ...rest } = config || {};
    const value = crypto.sign(null, signedBytes(rest), crypto.createPrivateKey(privateKeyPem)).toString('base64');
    return { ...rest, signature: { alg: 'ed25519', value } };
}

module.exports = { PUBLIC_KEY_B64, canonical, verify, parseVerified, sign };
