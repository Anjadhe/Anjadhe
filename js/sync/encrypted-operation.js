'use strict';
// Experimental v2 envelope. Key enrollment/rotation and durable upload are
// separate gates. Never accept a sender key supplied by the envelope itself.
const crypto = require('node:crypto');
const { validate, stable } = require('./record-merge');
const MAX = 1_048_576;
const token = s => typeof s === 'string' && s.length >= 1 && s.length <= 80 && !/[^a-z0-9-]/.test(s);
const positive = n => Number.isSafeInteger(n) && n > 0;
const reject = () => { throw new Error('Invalid encrypted sync operation'); };
const privatePrefix = Buffer.from('302e020100300506032b657004220420', 'hex');
const publicPrefix = Buffer.from('302a300506032b6570032100', 'hex');
function header(e) {
    if (e?.protocolVersion !== 2 || !token(e.datasetId) || !token(e.deviceId) || !positive(e.membershipEpoch) || !positive(e.sequence)) reject();
    return Buffer.from(`nenva-sync-operation-v2\n${e.datasetId}\n${e.membershipEpoch}\n${e.deviceId}\n${e.sequence}\n`, 'utf8');
}
function key(value) { if (!Buffer.isBuffer(value) || value.length !== 32) reject(); return value; }
function writerKey(datasetKey, envelope) {
    return Buffer.from(crypto.hkdfSync('sha256', key(datasetKey), Buffer.from('nenva-sync-key-v2\n'),
        Buffer.from(`nenva-sync-writer-v2\n${envelope.datasetId}\n${envelope.membershipEpoch}\n${envelope.deviceId}\n`), 32));
}
function decode(value, length, maximum = length) {
    if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maximum * 4 / 3) || /[^A-Za-z0-9_-]/.test(value)) reject();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value || bytes.length < length || bytes.length > maximum) reject();
    return bytes;
}
function signatureInput(aad, nonce, ciphertext, tag) {
    return Buffer.concat([Buffer.from('nenva-sync-signature-v2\n'), aad, nonce, ciphertext, tag]);
}
function seal(operation, datasetKey, signingSeed) {
    const aad = header(operation);
    validate(operation, operation.datasetId, operation.membershipEpoch);
    const plaintext = Buffer.from(stable(operation));
    if (plaintext.length > MAX) reject();
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', writerKey(datasetKey, operation), nonce, { authTagLength: 16 });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]), tag = cipher.getAuthTag();
    const signer = crypto.createPrivateKey({ key: Buffer.concat([privatePrefix, key(signingSeed)]), format: 'der', type: 'pkcs8' });
    const signature = crypto.sign(null, signatureInput(aad, nonce, ciphertext, tag), signer);
    return { protocolVersion: 2, datasetId: operation.datasetId, membershipEpoch: operation.membershipEpoch,
        deviceId: operation.deviceId, sequence: operation.sequence, nonce: nonce.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'), tag: tag.toString('base64url'), signature: signature.toString('base64url') };
}
function open(envelope, { datasetId, membershipEpoch, datasetKey, authorizedWriters }) {
    const aad = header(envelope);
    const keys = ['protocolVersion', 'datasetId', 'membershipEpoch', 'deviceId', 'sequence', 'nonce', 'ciphertext', 'tag', 'signature'];
    if (Object.keys(envelope).length !== keys.length || Object.keys(envelope).some(k => !keys.includes(k)) ||
        envelope.datasetId !== datasetId || envelope.membershipEpoch !== membershipEpoch ||
        !Object.hasOwn(authorizedWriters, envelope.deviceId)) reject();
    const senderKey = key(authorizedWriters[envelope.deviceId]);
    const nonce = decode(envelope.nonce, 12), ciphertext = decode(envelope.ciphertext, 1, MAX);
    const tag = decode(envelope.tag, 16), signature = decode(envelope.signature, 64);
    const sender = crypto.createPublicKey({ key: Buffer.concat([publicPrefix, senderKey]), format: 'der', type: 'spki' });
    if (!crypto.verify(null, signatureInput(aad, nonce, ciphertext, tag), sender, signature)) reject();
    const decipher = crypto.createDecipheriv('aes-256-gcm', writerKey(datasetKey, envelope), nonce, { authTagLength: 16 });
    decipher.setAAD(aad); decipher.setAuthTag(tag);
    // Never decode or release update()'s plaintext before final() verifies.
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const operation = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    validate(operation, datasetId, membershipEpoch);
    if (operation.deviceId !== envelope.deviceId || operation.sequence !== envelope.sequence) reject();
    return operation;
}
module.exports = { seal, open };
