// remote-config.json is signed (js/main/remote-config-signature.js RC1-RC3).
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const RCS = require('../js/main/remote-config-signature');

const text = fs.readFileSync(path.join(__dirname, '..', 'remote-config.json'), 'utf8');
const config = JSON.parse(text);
assert.ok(RCS.verify(config), 'remote-config.json must be signed: run node scripts/sign-remote-config.js after editing it');
assert.ok(RCS.parseVerified(text));

// RC1: formatting and key order do not matter; content does.
const reordered = Object.fromEntries(Object.entries(config).reverse());
assert.ok(RCS.verify(JSON.parse(JSON.stringify(reordered, null, 4))));
const tampered = JSON.parse(text);
tampered.llamacppInstall = { ...(tampered.llamacppInstall || {}), sha256: '0'.repeat(64) };
assert.equal(RCS.verify(tampered), false);
assert.equal(RCS.verify({ ...config, signature: undefined }), false);
assert.equal(RCS.parseVerified('{not json'), null);

// A copy signed by another key does not verify.
const { privateKey } = crypto.generateKeyPairSync('ed25519');
const forged = RCS.sign(config, privateKey.export({ type: 'pkcs8', format: 'pem' }));
assert.equal(RCS.verify(forged), false);
console.log('remote-config-signature: the committed config is signed and tampering is refused');
