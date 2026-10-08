/** Outgoing Gmail MIME shared by sending and draft creation/update. */
const path = require('node:path');

// Minimal extension → MIME map for outgoing attachments. Gmail is the one
// actually rendering these, so we only need to cover the common cases; anything
// else falls through to application/octet-stream which Gmail handles fine.
const MIME_TYPES_BY_EXT = {
    pdf: 'application/pdf',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', heic: 'image/heic',
    txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', html: 'text/html',
    json: 'application/json', xml: 'application/xml',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    zip: 'application/zip',
    mp3: 'audio/mpeg', mp4: 'video/mp4', mov: 'video/quicktime', wav: 'audio/wav'
};

function mimeTypeForFilename(filename) {
    const ext = path.extname(filename || '').replace('.', '').toLowerCase();
    return MIME_TYPES_BY_EXT[ext] || 'application/octet-stream';
}

// RFC 2047 encoded-words identify the header's charset independently of the
// HTML body's charset. Gmail's outer base64url wrapper does not do this.
function subjectHeader(subject) {
    const text = String(subject || '').replace(/[\x00-\x1f\x7f]+/g, ' ');
    if (/^[\x20-\x7e]*$/.test(text) && text.length <= 67) return `Subject: ${text}`;
    const words = [];
    let chunk = '', bytes = 0;
    // 39 UTF-8 bytes -> at most 64 ASCII chars including the encoded-word
    // delimiters. Even the first line, with "Subject: ", stays under 76.
    // Iterate code points so every word is independently valid UTF-8.
    for (const char of text) {
        const size = Buffer.byteLength(char, 'utf8');
        if (bytes + size > 39) {
            words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
            chunk = ''; bytes = 0;
        }
        chunk += char; bytes += size;
    }
    if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
    return `Subject: ${words.join('\r\n ')}`;
}

function base64Lines(text) {
    return Buffer.from(text, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
}

function buildMimeMessage({ from, to, cc, bcc, subject, body, inReplyTo, references, attachments }) {
    const headers = [];
    headers.push(`From: ${from}`);
    if (to) headers.push(`To: ${to}`);
    if (cc) headers.push(`Cc: ${cc}`);
    if (bcc) headers.push(`Bcc: ${bcc}`);
    headers.push(subjectHeader(subject));
    if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
    if (references) headers.push(`References: ${references}`);
    headers.push('MIME-Version: 1.0');

    // Wrap body in a proper HTML email template with Inter font
    const htmlBody = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
body { margin: 0; padding: 0; }
</style>
</head>
<body>
<div style="font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a;padding:16px 0;">
${body || ''}
</div>
</body>
</html>`;

    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

    if (!hasAttachments) {
        headers.push('Content-Type: text/html; charset=utf-8');
        headers.push('Content-Transfer-Encoding: base64');
        headers.push('');
        headers.push(base64Lines(htmlBody));
        return headers.join('\r\n');
    }

    // multipart/mixed: one text/html body part + one part per attachment.
    // Boundary must not appear in any part, so we use a random token.
    const boundary = `=_anj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    headers.push('');

    const parts = [];
    parts.push(`--${boundary}`);
    parts.push('Content-Type: text/html; charset=utf-8');
    parts.push('Content-Transfer-Encoding: base64');
    parts.push('');
    parts.push(base64Lines(htmlBody));

    for (const att of attachments) {
        const safeName = String(att.filename || 'attachment').replace(/["\r\n]/g, '');
        const mime = att.mimeType || mimeTypeForFilename(safeName);
        const data = String(att.data || '').replace(/\s+/g, '');
        // Wrap base64 at 76 chars per RFC 2045. Gmail is lenient but other
        // receiving servers can choke on unwrapped lines.
        const wrapped = data.replace(/(.{76})/g, '$1\r\n');
        parts.push(`--${boundary}`);
        parts.push(`Content-Type: ${mime}; name="${safeName}"`);
        parts.push(`Content-Disposition: attachment; filename="${safeName}"`);
        parts.push('Content-Transfer-Encoding: base64');
        parts.push('');
        parts.push(wrapped);
    }

    parts.push(`--${boundary}--`);

    return headers.join('\r\n') + '\r\n' + parts.join('\r\n');
}

module.exports = { buildMimeMessage, mimeTypeForFilename };
