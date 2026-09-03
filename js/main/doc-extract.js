/**
 * Dependency-free extractors for zip-based Office documents (C8.2).
 *
 * .xlsx and .docx are both zip archives of XML. The app deliberately has no
 * zip dependency (yauzl exists only transitively via electron-updater, which
 * could drop it in any release), and both formats need only "read a few
 * known entries" — so this is a minimal central-directory reader over
 * Node's zlib, not a general zip library. Anything exotic (zip64, encrypted,
 * multi-disk) errors out cleanly rather than half-parsing.
 *
 * Output contract matches what a small model can actually use: plain text,
 * tables as tab-separated lines (totable, not markup), one `## Sheet:` header
 * per worksheet. Callers cap/page the text — extractors only bound their own
 * work (row/char guards) so a pathological file can't wedge the main process.
 */

const zlib = require('zlib');

const MAX_TEXT = 200 * 1024;        // same ceiling as the PDF extractor
const MAX_ROWS_PER_SHEET = 2000;

// ── minimal zip reader ────────────────────────────────────────────────────

/** Map of entryName -> Buffer for the entries we ask for (lazy inflate). */
function unzipEntries(buf, wantedNames) {
    // EOCD: scan the last 64KB + 22 bytes for the signature.
    const tail = Math.max(0, buf.length - 65558);
    let eocd = -1;
    for (let i = buf.length - 22; i >= tail; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error('not a zip file (no end-of-central-directory)');
    const count = buf.readUInt16LE(eocd + 10);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff) throw new Error('zip64 archives are not supported');

    const out = new Map();
    let p = cdOffset;
    for (let i = 0; i < count && p + 46 <= buf.length; i++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) break;
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        p += 46 + nameLen + extraLen + commentLen;

        if (!wantedNames.some(w => (w instanceof RegExp ? w.test(name) : w === name))) continue;
        // Local header repeats name/extra with possibly DIFFERENT extra len.
        if (buf.readUInt32LE(localOffset) !== 0x04034b50) continue;
        const lNameLen = buf.readUInt16LE(localOffset + 26);
        const lExtraLen = buf.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + lNameLen + lExtraLen;
        const raw = buf.subarray(dataStart, dataStart + compSize);
        if (method === 0) out.set(name, Buffer.from(raw));
        else if (method === 8) out.set(name, zlib.inflateRawSync(raw));
        else throw new Error(`unsupported zip compression method ${method}`);
    }
    return out;
}

// ── shared XML helpers ────────────────────────────────────────────────────

function xmlDecode(s) {
    return s
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&amp;/g, '&');
}

// ── xlsx ──────────────────────────────────────────────────────────────────

function colIndex(ref) {
    // "BC12" -> column 54 (0-based). Letters only; digits are the row.
    let n = 0;
    for (let i = 0; i < ref.length; i++) {
        const c = ref.charCodeAt(i);
        if (c < 65 || c > 90) break;
        n = n * 26 + (c - 64);
    }
    return n - 1;
}

/**
 * Worksheet XML -> rows of cell strings. Regex-walked on purpose: the shapes
 * we need (<row>, <c r= t=>, <v>, <is><t>) are fixed by the spec, and a DOM
 * parse of a 50k-row sheet would cost far more than it buys.
 */
function parseSheet(xml, shared) {
    const rows = [];
    const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(xml)) && rows.length < MAX_ROWS_PER_SHEET) {
        const cells = [];
        const cellRe = /<c([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
        let cm;
        while ((cm = cellRe.exec(rm[1]))) {
            const attrs = cm[1] || '';
            const body = cm[2] || '';
            const ref = (attrs.match(/\br="([A-Z]+)\d+"/) || [])[1];
            const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || '';
            let val = '';
            if (type === 'inlineStr') {
                val = (body.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [])
                    .map(t => t.replace(/<[^>]+>/g, '')).join('');
            } else {
                const v = (body.match(/<v[^>]*>([\s\S]*?)<\/v>/) || [])[1] || '';
                if (type === 's') val = shared[parseInt(v, 10)] || '';
                else if (type === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
                else val = v;
            }
            const col = ref ? colIndex(ref) : cells.length;
            while (cells.length < col) cells.push('');
            cells[col] = xmlDecode(val).trim();
        }
        rows.push(cells);
    }
    const more = rows.length >= MAX_ROWS_PER_SHEET && rowRe.exec(xml) !== null;
    return { rows, truncated: more };
}

function extractXlsx(buf) {
    const entries = unzipEntries(buf, [
        'xl/workbook.xml',
        'xl/sharedStrings.xml',
        'xl/_rels/workbook.xml.rels',
        /^xl\/worksheets\/sheet\d+\.xml$/
    ]);
    const wb = entries.get('xl/workbook.xml');
    if (!wb) throw new Error('not an xlsx workbook (no xl/workbook.xml)');

    // Shared strings: <si> items, each possibly several rich-text <t> runs.
    const shared = [];
    const ss = entries.get('xl/sharedStrings.xml');
    if (ss) {
        const siRe = /<si>([\s\S]*?)<\/si>/g;
        let m;
        while ((m = siRe.exec(ss.toString('utf8')))) {
            shared.push(xmlDecode((m[1].match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [])
                .map(t => t.replace(/^<t[^>]*>/, '').replace(/<\/t>$/, '')).join('')));
        }
    }

    // Sheet display names in workbook order, mapped to their part via rels.
    const rels = new Map();
    const relsXml = entries.get('xl/_rels/workbook.xml.rels');
    if (relsXml) {
        const relRe = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/>/g;
        let m;
        const s = relsXml.toString('utf8');
        while ((m = relRe.exec(s))) rels.set(m[1], m[2].replace(/^\/?(xl\/)?/, 'xl/'));
    }
    const sheets = [];
    const sheetRe = /<sheet\b([^>]*)\/>/g;   // attr order varies by producer
    let sm;
    const wbXml = wb.toString('utf8');
    while ((sm = sheetRe.exec(wbXml))) {
        const name = (sm[1].match(/\bname="([^"]*)"/) || [])[1];
        const rid = (sm[1].match(/\br:id="([^"]+)"/) || [])[1];
        if (name !== undefined) sheets.push({ name: xmlDecode(name), part: rels.get(rid) });
    }
    if (!sheets.length) {
        // Rels missing or nonstandard ids — fall back to part order.
        for (const name of entries.keys()) {
            if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) sheets.push({ name: name.replace(/^xl\/worksheets\/|\.xml$/g, ''), part: name });
        }
    }

    let text = '';
    let truncated = false;
    for (const sheet of sheets) {
        const xml = sheet.part && entries.get(sheet.part);
        if (!xml) continue;
        const { rows, truncated: rowsCut } = parseSheet(xml.toString('utf8'), shared);
        truncated = truncated || rowsCut;
        const body = rows
            .filter(cells => cells.some(c => c !== ''))
            .map(cells => cells.join('\t')).join('\n');
        text += (text ? '\n\n' : '') + `## Sheet: ${sheet.name}\n` + body;
        if (rowsCut) text += `\n[…more rows in this sheet — first ${MAX_ROWS_PER_SHEET} shown]`;
        if (text.length >= MAX_TEXT) { truncated = true; break; }
    }
    return { text: text.slice(0, MAX_TEXT), sheets: sheets.length, truncated: truncated || text.length > MAX_TEXT };
}

// ── docx ──────────────────────────────────────────────────────────────────

function extractDocx(buf) {
    const entries = unzipEntries(buf, ['word/document.xml']);
    const doc = entries.get('word/document.xml');
    if (!doc) throw new Error('not a docx document (no word/document.xml)');
    const xml = doc.toString('utf8');

    // Single pass over the tokens that carry layout meaning. Table cells
    // become tabs and rows newlines so totals stay totable.
    let text = '';
    // NB: `<w:t` must not also match <w:tbl>/<w:tc>/<w:tr> openers, hence
    // the explicit space-or-close boundary after the tag name.
    const tokRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<\/w:p>|<\/w:tc>|<\/w:tr>/g;
    let m;
    while ((m = tokRe.exec(xml)) && text.length < MAX_TEXT) {
        if (m[1] !== undefined) text += xmlDecode(m[1]);
        else if (m[0].startsWith('<w:tab')) text += '\t';
        else if (m[0].startsWith('<w:br')) text += '\n';
        else if (m[0] === '</w:tc>') text += '\t';
        else text += '\n';   // paragraph or table row end
    }
    // Inside tables every cell's closing paragraph emits \n before the
    // cell's \t — collapse those so a row reads "Item\tCost", not stairs.
    text = text.replace(/\n+\t/g, '\t').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT };
}

/**
 * PowerPoint: one section per slide, in slide order. Slide XML holds text
 * in <a:t> runs; paragraphs (<a:p>) become lines. Notes are skipped.
 */
function extractPptx(buf) {
    const entries = unzipEntries(buf, [/^ppt\/slides\/slide\d+\.xml$/]);
    const names = [...entries.keys()].sort((a, b) =>
        parseInt(a.match(/slide(\d+)/)[1], 10) - parseInt(b.match(/slide(\d+)/)[1], 10));
    const out = [];
    names.forEach((name, i) => {
        const xml = entries.get(name).toString('utf8');
        const paras = [];
        for (const p of xml.split(/<\/a:p>/)) {
            const runs = [...p.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map(m => xmlDecode(m[1]));
            const line = runs.join('').trim();
            if (line) paras.push(line);
        }
        if (paras.length) out.push(`## Slide ${i + 1}\n\n${paras.join('\n')}`);
    });
    return { text: out.join('\n\n'), slides: names.length };
}

module.exports = { extractXlsx, extractDocx, extractPptx, unzipEntries };
