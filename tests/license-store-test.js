// LicenseStore — pins the license format shared with Connect's lib/license.js
// (mint here with the same algorithm, verify with the app's code), the
// tamper cases, and the update-gate matrix. Pure Node: node tests/license-store-test.js
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

// ── storage + status + update gate ────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lic-test-'));
const settings = { _m: new Map(), get(k, d) { return this._m.has(k) ? this._m.get(k) : d; }, set(k, v) { this._m.set(k, v); }, delete(k) { this._m.delete(k); } };
let policy = {};
LicenseStore.init({ filePath: path.join(dir, 'license.json'), settings, getPolicy: () => policy });

// Alpha era, no key: unclaimed, updates allowed, no trial clock.
let s = LicenseStore.status('2026-09-01');
assert.strictEqual(s.state, 'unclaimed');
assert.strictEqual(s.licensed, false);
assert.strictEqual(s.trial, null);
assert.deepStrictEqual(LicenseStore.updateAllowed('2026-09-15', '2026-09-01'), { allowed: true, reason: 'alpha-open' });
assert.strictEqual(settings.get('trialStartedAt', null), null);

// Bad key refused, nothing written.
assert.ok(LicenseStore.save('ANJ1.nope.nope').error);
assert.ok(!fs.existsSync(path.join(dir, 'license.json')));

// Claim: saved with the email it was issued to.
s = LicenseStore.save(alpha.key, 'Ram@Example.com');
assert.strictEqual(s.state, 'alpha');
assert.strictEqual(s.email, 'ram@example.com');
assert.strictEqual(s.updatesUntil, null);
assert.strictEqual(s.updatesActive, true);
assert.strictEqual(fs.statSync(path.join(dir, 'license.json')).mode & 0o777, 0o600);
// An email the key was NOT issued to is not displayed.
assert.strictEqual(LicenseStore.save(alpha.key, 'stranger@example.com').email, null);
// Alpha: updates forever, even long after the alpha closes.
policy = { alphaClosesAt: '2027-01-01' };
assert.deepStrictEqual(LicenseStore.updateAllowed('2031-06-01', '2031-06-01'), { allowed: true, reason: 'alpha' });

// Paid: updates until the date, then not.
const paid = mint({ class: 'paid', updatesUntil: '2027-09-01' });
s = LicenseStore.save(paid.key);
assert.strictEqual(s.state, 'paid');
assert.strictEqual(LicenseStore.updateAllowed('2027-09-01', '2027-09-01').allowed, true);
assert.strictEqual(LicenseStore.updateAllowed('2027-08-01', '2028-01-01').allowed, true, 'an old release stays installable after the year');
let g = LicenseStore.updateAllowed('2027-09-02', '2027-09-02');
assert.deepStrictEqual(g, { allowed: false, reason: 'updates-ended', updatesUntil: '2027-09-01' });
assert.strictEqual(LicenseStore.status('2027-10-01').updatesActive, false);

// Remove → back to unlicensed; alpha closed → trial clock starts today.
LicenseStore.clear();
s = LicenseStore.status('2027-02-01');
assert.strictEqual(s.state, 'trial');
assert.strictEqual(s.trial.startedAt, '2027-02-01');
assert.strictEqual(s.trial.endsAt, '2027-02-15');
assert.strictEqual(s.trial.daysLeft, 14);
assert.deepStrictEqual(LicenseStore.updateAllowed('2027-02-10', '2027-02-10'), { allowed: true, reason: 'trial' });
s = LicenseStore.status('2027-02-15');
assert.strictEqual(s.state, 'trial-ended');
assert.deepStrictEqual(LicenseStore.updateAllowed('2027-02-20', '2027-02-20'), { allowed: false, reason: 'trial-ended' });
// The clock does not restart.
assert.strictEqual(LicenseStore.status('2027-03-01').trial.startedAt, '2027-02-01');
// trialDays from policy.
policy = { alphaClosesAt: '2027-01-01', trialDays: 30 };
assert.strictEqual(LicenseStore.status('2027-02-01').trial.endsAt, '2027-03-03');

// A stored key that stops verifying is reported, not silently dropped.
fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify({ key: alpha.key.slice(0, -4) + 'AAAA' }));
LicenseStore._cache = undefined;
s = LicenseStore.status('2027-02-01');
assert.strictEqual(s.licensed, false);
assert.ok(s.invalid);

fs.rmSync(dir, { recursive: true, force: true });
console.log('license-store-test: all assertions passed');
