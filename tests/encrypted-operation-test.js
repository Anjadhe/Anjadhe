'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { seal, open } = require('../js/sync/encrypted-operation');
const fixture = require('../fixtures/encrypted-operation/vector.json');
const datasetKey = Buffer.from(fixture.datasetKey, 'hex');
const seed = Buffer.from(fixture.signingSeed, 'hex');
const publicKey = Buffer.from(fixture.publicKey, 'hex');
const context = { datasetId: 'fixture', membershipEpoch: 1, datasetKey, authorizedWriters: { a: publicKey } };
let checks = 0;
function rejects(value, ctx = context) { assert.throws(() => open(value, ctx)); checks++; }
assert.deepEqual(open(fixture.envelope, context), fixture.operation); checks++;
assert.deepEqual(open({ ...fixture.envelope, signature: fixture.cryptoKitSignature }, context), fixture.operation); checks++;
const first = seal(fixture.operation, datasetKey, seed), second = seal(fixture.operation, datasetKey, seed);
assert.notEqual(first.nonce, second.nonce);
assert.notEqual(first.ciphertext, second.ciphertext);
assert.deepEqual(open(first, context), fixture.operation); checks += 3;
for (const field of ['nonce', 'ciphertext', 'tag', 'signature']) {
    const changed = { ...fixture.envelope }, data = Buffer.from(changed[field], 'base64url');
    data[0] ^= 1; changed[field] = data.toString('base64url'); rejects(changed);
    rejects({ ...fixture.envelope, [field]: fixture.envelope[field] + '=' });
}
for (const [field, value] of [['protocolVersion', 1], ['datasetId', 'other'], ['membershipEpoch', 2], ['deviceId', 'b'], ['sequence', 2]]) rejects({ ...fixture.envelope, [field]: value });
rejects(fixture.envelope, { ...context, datasetId: 'other' });
rejects(fixture.envelope, { ...context, membershipEpoch: 2 });
rejects(fixture.envelope, { ...context, authorizedWriters: {} });
rejects(fixture.envelope, { ...context, authorizedWriters: { a: Buffer.alloc(32, 3) } });
rejects(fixture.envelope, { ...context, datasetKey: Buffer.alloc(32, 4) });
rejects({ ...fixture.envelope, injected: 'not signed' });
rejects({ ...fixture.envelope, ciphertext: 'a'.repeat(1_398_103) });
// Even a valid signer/encryption key cannot relabel plaintext as another dot.
const aad = Buffer.from('nenva-sync-operation-v2\nfixture\n1\na\n1\n');
const nonce = crypto.randomBytes(12);
const writerKey = Buffer.from(crypto.hkdfSync('sha256', datasetKey, Buffer.from('nenva-sync-key-v2\n'), Buffer.from('nenva-sync-writer-v2\nfixture\n1\na\n'), 32));
const cipher = crypto.createCipheriv('aes-256-gcm', writerKey, nonce, { authTagLength: 16 }); cipher.setAAD(aad);
const plaintext = Buffer.from(JSON.stringify({ ...fixture.operation, sequence: 2, dependencies: { a: 1 } }));
const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]), tag = cipher.getAuthTag();
const signer = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
const signature = crypto.sign(null, Buffer.concat([Buffer.from('nenva-sync-signature-v2\n'), aad, nonce, ciphertext, tag]), signer);
rejects({ ...fixture.envelope, nonce: nonce.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: tag.toString('base64url'), signature: signature.toString('base64url') });
console.log(`encrypted operation: ${checks} checks passed`);
