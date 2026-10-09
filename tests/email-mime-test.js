// Outgoing Gmail bytes must round-trip Unicode independently of a client's
// default charset. Exercise the shared builder and the actual IPC handlers,
// with Gmail mocked: no email is sent by this test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildMimeMessage, mimeTypeForFilename } = require('../js/main/email-mime');
const decoder = new TextDecoder('utf-8', { fatal: true });
const example = 'Briefing: Tasks for Oct 7 – Oct 22, 2026';
const body = '<p>“Today’s briefing” – café, ₹42, தமிழ், 日本語, 🎉</p>';
const base = { from: 'me@example.com', to: 'sam@example.com', body };
function headers(message) { return message.split('\r\n\r\n', 1)[0]; }
function subject(message) {
    const unfolded = headers(message).replace(/\r\n[ \t]+/g, ' ');
    const value = unfolded.match(/^Subject: (.*)$/m)[1].trimEnd();
    // Adjacent RFC 2047 words ignore intervening folding whitespace.
    return value.replace(/\?=\s+(?==\?)/g, '?=')
        .replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, data) => decoder.decode(Buffer.from(data, 'base64')));
}
function bodyOf(part) {
    assert.match(headers(part), /Content-Transfer-Encoding: base64/);
    const encoded = part.slice(part.indexOf('\r\n\r\n') + 4).trim();
    for (const line of encoded.split('\r\n')) assert.ok(line.length <= 76, 'base64 lines are wrapped');
    return decoder.decode(Buffer.from(encoded, 'base64'));
}
for (const title of [example, 'Re: “Café” — résumé ✓', 'தமிழ் 📬 日本語', 'Hello', '', 'a'.repeat(1000), ('a'.repeat(38) + '😀தமிழ் ').repeat(12)]) {
    const wire = Buffer.from(buildMimeMessage({ ...base, subject: title }), 'utf8').toString('base64url');
    const message = Buffer.from(wire, 'base64url').toString('utf8');
    assert.equal(subject(message), title);
    assert.match(headers(message), /^[\x00-\x7f]*$/, 'subject headers are ASCII on the wire');
    for (const word of headers(message).match(/=\?UTF-8\?B\?[^?]+\?=/g) || []) assert.ok(word.length <= 75);
    for (const line of headers(message).split('\r\n')) assert.ok(line.length <= 76);
    assert.ok(bodyOf(message).includes(body), 'HTML Unicode survives without attachments');
}
const mixed = buildMimeMessage({ ...base, subject: example, inReplyTo: '<original@example.com>', references: '<original@example.com>',
    attachments: [{ filename: 'note.txt', data: Buffer.from('attachment – café').toString('base64') }] });
const boundary = headers(mixed).match(/boundary="([^"]+)"/)[1];
const parts = mixed.split(`--${boundary}`);
assert.equal(subject(mixed), example);
assert.ok(bodyOf(parts[1].replace(/^\r\n/, '')).includes(body), 'HTML Unicode survives with attachments');
assert.match(parts[2], /filename="note.txt"/);
assert.equal(bodyOf(parts[2].replace(/^\r\n/, '')), 'attachment – café');
assert.match(headers(mixed), /In-Reply-To: <original@example.com>/);
assert.match(headers(mixed), /References: <original@example.com>/);
assert.equal(mimeTypeForFilename('REPORT.PDF'), 'application/pdf');
assert.equal(mimeTypeForFilename('file.unknown'), 'application/octet-stream');
const injected = buildMimeMessage({ ...base, subject: 'Hello\r\nBcc: other@example.com' });
assert.equal(subject(injected), 'Hello Bcc: other@example.com');
assert.doesNotMatch(headers(injected), /^Bcc:/m, 'subject cannot insert a new header');

const handlers = {}, requests = [];
const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const start = main.indexOf("ipcMain.handle('email-send',");
const end = main.indexOf("ipcMain.handle('email-delete-draft',", start);
assert.ok(start >= 0 && end > start);
vm.runInNewContext(main.slice(start, end), {
    Buffer, buildMimeMessage, console: { log() {}, error() {} },
    ipcMain: { handle: (name, handler) => { handlers[name] = handler; } },
    gmailApiCall: async (account, method, endpoint, payload) => {
        requests.push({ account, method, endpoint, payload });
        return { id: 'id1', message: { id: 'message1' } };
    }
});
(async () => {
    const params = { ...base, subject: example, threadId: 'thread1', inReplyTo: '<original@example.com>' };
    assert.equal((await handlers['email-send']({}, base.from, params)).success, true);
    assert.equal((await handlers['email-create-draft']({}, base.from, params)).success, true);
    assert.equal((await handlers['email-update-draft']({}, base.from, 'draft1', params)).success, true);
    assert.deepEqual(requests.map(r => r.method), ['POST', 'POST', 'PUT']);
    for (const req of requests) {
        const message = req.payload.message || req.payload;
        assert.equal(message.threadId, 'thread1');
        const mime = Buffer.from(message.raw, 'base64url').toString('utf8');
        assert.equal(subject(mime), example);
        assert.ok(bodyOf(mime).includes(body));
    }
    console.log('email-mime: Unicode subjects/body, folding, attachments, threading, send and drafts passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
