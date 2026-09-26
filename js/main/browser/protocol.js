'use strict';
const MAX_FRAME = 1024 * 1024;
function encode(value) {
    const body = Buffer.from(JSON.stringify(value));
    if (!body.length || body.length > MAX_FRAME) throw new Error('Browser message is too large');
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    return Buffer.concat([header, body]);
}
function reader(onMessage, onError) {
    let buffer = Buffer.alloc(0), failed = false;
    return chunk => {
        if (failed) return;
        try {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= 4) {
                const length = buffer.readUInt32LE(0);
                if (!length || length > MAX_FRAME) throw new Error('Invalid browser message length');
                if (buffer.length < length + 4) return;
                const message = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'));
                buffer = buffer.subarray(length + 4);
                if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid browser message');
                onMessage(message);
            }
        } catch (error) { failed = true; buffer = Buffer.alloc(0); onError(error); }
    };
}
module.exports = { MAX_FRAME, encode, reader };

