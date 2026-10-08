// LicenseStore — pins the license format shared with Connect's lib/license.js
// (mint here with the same algorithm, verify with the app's code), the
// tamper cases, and status. Since 2026-09-30 nenva is free for good: no
// trial, no update gate (the test pins that none is left). Pure Node:
// node tests/license-store-test.js
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const LicenseStore = require('../js/main/license-store');

// A throwaway keypair; the production public key is only checked for shape.
const seed = crypto.randomBytes(32);
const priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
const pubB64 = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
process.env.ANJADHE_LICENSE_PUBLIC_KEY = pubB64;

const sub = (email) => crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32);
function mint(over = {}) {
    const payload = { v: 1, id: crypto.randomBytes(8).toString('hex'), class: 'alpha', sub: sub('Ram@Example.com'), issuedAt: '2026-09-01', updatesUntil: null, ...over };
    const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
    const sig = crypto.sign(null, bytes, priv);
    return { key: `ANJ1.${bytes.toString('base64url')}.${sig.toString('base64url')}`, payload };
}

// Production key shape: 32 raw bytes.
assert.strictEqual(Buffer.from(LicenseStore.PUBLIC_KEY_B64, 'base64').length, 32);

// ── verify ────────────────────────────────────────────────────────────
const alpha = mint();
let v = LicenseStore.verify(alpha.key);
assert.ok(v.ok, v.error);
assert.strictEqual(v.payload.class, 'alpha');
assert.ok(LicenseStore.matchesEmail(v.payload, 'ram@example.com'));
assert.ok(!LicenseStore.matchesEmail(v.payload, 'other@example.com'));

// Wrong public key → forged.
assert.strictEqual(LicenseStore.verify(alpha.key, crypto.randomBytes(32).toString('base64')).ok, false);
// Flip a payload byte (class alpha → paid) with the old signature → refused.
{
    const [, p, s] = alpha.key.split('.');
    const tampered = Buffer.from(JSON.stringify({ ...alpha.payload, class: 'paid' })).toString('base64url');
    assert.strictEqual(LicenseStore.verify(`ANJ1.${tampered}.${s}`).ok, false);
    assert.strictEqual(LicenseStore.verify(`ANJ2.${p}.${s}`).ok, false);
    assert.strictEqual(LicenseStore.verify('').ok, false);
    assert.strictEqual(LicenseStore.verify('hello').ok, false);
}
// A validly signed but malformed payload is still refused.
assert.strictEqual(LicenseStore.verify(mint({ class: 'gold' }).key).ok, false);
assert.strictEqual(LicenseStore.verify(mint({ updatesUntil: 'someday' }).key).ok, false);
assert.strictEqual(LicenseStore.verify(mint({ v: 2 }).key).ok, false);

// extractKey: pasted with whitespace, a JSON file, prose around it.
assert.strictEqual(LicenseStore.extractKey(`  ${alpha.key}\n`), alpha.key);
assert.strictEqual(LicenseStore.extractKey(JSON.stringify({ license: alpha.key })), alpha.key);
assert.strictEqual(LicenseStore.extractKey(`Your key: ${alpha.key} — thanks`), alpha.key);

// ── storage + status ──────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lic-test-'));
LicenseStore.init({ filePath: path.join(dir, 'license.json') });

// No key: unclaimed.
let s = LicenseStore.status();
assert.strictEqual(s.state, 'unclaimed');
assert.strictEqual(s.licensed, false);
// Nothing gates updates any more, and no trial clock exists.
assert.strictEqual(typeof LicenseStore.updateAllowed, 'undefined');
assert.strictEqual('trial' in s, false);

// Bad key refused, nothing written.
assert.ok(LicenseStore.save('ANJ1.nope.nope').error);
assert.ok(!fs.existsSync(path.join(dir, 'license.json')));

// Claim: saved with the email it was issued to.
s = LicenseStore.save(alpha.key, 'Ram@Example.com');
assert.strictEqual(s.state, 'alpha');
assert.strictEqual(s.email, 'ram@example.com');
assert.strictEqual(s.updatesUntil, null);
assert.strictEqual(fs.statSync(path.join(dir, 'license.json')).mode & 0o777, 0o600);
// An email the key was NOT issued to is not displayed.
assert.strictEqual(LicenseStore.save(alpha.key, 'stranger@example.com').email, null);

// Free: the class minted after the alpha — verifies and reads as itself.
const free = mint({ class: 'free' });
assert.ok(LicenseStore.verify(free.key).ok);
s = LicenseStore.save(free.key, 'ram@example.com');
assert.strictEqual(s.state, 'free');
assert.strictEqual(s.licensed, true);

// Paid still verifies (a future paid integration may use it).
const paid = mint({ class: 'paid', updatesUntil: '2027-09-01' });
s = LicenseStore.save(paid.key);
assert.strictEqual(s.state, 'paid');
assert.strictEqual(s.updatesUntil, '2027-09-01');

// Remove → unclaimed again.
s = LicenseStore.clear();
assert.strictEqual(s.state, 'unclaimed');

// A stored key that stops verifying is reported, not silently dropped.
fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify({ key: alpha.key.slice(0, -4) + 'AAAA' }));
LicenseStore._cache = undefined;
s = LicenseStore.status();
assert.strictEqual(s.licensed, false);
assert.ok(s.invalid);

fs.rmSync(dir, { recursive: true, force: true });
console.log('license-store-test: all assertions passed');
