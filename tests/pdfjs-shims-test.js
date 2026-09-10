// pdf.js must import and extract text in a Node/Electron-main process that
// has no DOMMatrix global and no @napi-rs/canvas — the packaged app's
// situation (the package is excluded from the build). The shim is installed
// FIRST, so pdf.js never reaches for the native package even when node_modules
// happens to have it; this test therefore exercises exactly what ships.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { installPdfjsShims, ShimDOMMatrix } = require('../js/main/pdfjs-node-shims.js');

assert.strictEqual(typeof globalThis.DOMMatrix, 'undefined', 'test must run where DOMMatrix is absent');
installPdfjsShims();
assert.strictEqual(globalThis.DOMMatrix, ShimDOMMatrix);

// 2D affine arithmetic matches the DOM spec's definitions.
const m = new DOMMatrix([2, 0, 0, 3, 10, 20]);
const t = m.translate(5, 7);                 // translate is applied first
assert.deepStrictEqual([t.a, t.b, t.c, t.d, t.e, t.f], [2, 0, 0, 3, 20, 41]);
const s = m.scale(2);
assert.deepStrictEqual([s.a, s.d, s.e, s.f], [4, 6, 10, 20]);
const inv = m.inverse();
const id = m.multiply(inv);
assert.ok(Math.abs(id.a - 1) < 1e-12 && Math.abs(id.d - 1) < 1e-12 && Math.abs(id.e) < 1e-12 && Math.abs(id.f) < 1e-12);
assert.ok(new DOMMatrix().isIdentity);

(async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const file = path.join(__dirname, '..', 'casa-evidence', 'pdf', 'CASA-1.3.4.pdf');
    const bytes = new Uint8Array(fs.readFileSync(file));
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: true });
    const doc = await task.promise;
    const tc = await (await doc.getPage(1)).getTextContent();
    await task.destroy();
    assert.ok(tc.items.length > 10, 'text extracted under the shim');
    assert.strictEqual(bytes.byteLength, fs.statSync(file).size, 'extractor must not consume the caller\'s copy');
    console.log('pdfjs-shims-test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
