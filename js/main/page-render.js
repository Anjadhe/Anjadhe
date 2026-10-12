/**
 * Page rendering for vision models (2026-09-02, docs/LIBRARY.md "Read with
 * vision"): one PDF page — or one image file — as a JPEG data URL sized
 * for a vision-capable brain, so the model reads the page itself instead
 * of pdf.js's text layer.
 *
 * Same recipe as vision-ocr.js: a JXA script run by /usr/bin/osascript
 * bridges into PDFKit + AppKit directly. No canvas dependency (the packaged
 * app ships without @napi-rs/canvas, which pdf.js would need to rasterize),
 * no compiled helper, fully local. One page per call: the caller pages
 * through a document and streams the transcription as it goes, and a
 * single 1400px JPEG is ~150-250 KB, comfortably inside an osascript
 * stdout buffer.
 */
const { execFile } = require('child_process');
const path = require('path');

const RENDER_TIMEOUT_MS = 60000;
const DEFAULT_MAX_EDGE = 1400;
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.heic', '.heif', '.tif', '.tiff', '.gif', '.webp', '.bmp']);

// argv: <filePath> <pageIndex (0-based)> <maxEdge>. Emits JSON
// {dataUrl, pages, width, height} or {error}.
const JXA_SOURCE = `
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('Quartz');

// PDF pages are in points (612×792 for Letter) and rasterize crisply at any
// size, so they are scaled UP to the target edge — a vision model reads
// 10pt text at 1400px, not at 612. Images are only ever scaled down.
function fit(w, h, maxEdge, allowUp) {
    const raw = maxEdge / Math.max(w, h);
    const scale = allowUp ? raw : Math.min(1, raw);
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

// Draw an NSImage into a fresh RGB bitmap of the given size (white ground —
// PDF pages and transparent PNGs must not come out black) and JPEG it.
function jpegOf(nsImage, size) {
    const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
        null, size.width, size.height, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
    if (rep.isNil()) return null;
    $.NSGraphicsContext.saveGraphicsState;
    const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
    $.NSGraphicsContext.setCurrentContext(ctx);
    $.NSColor.whiteColor.set;
    $.NSRectFill($.NSMakeRect(0, 0, size.width, size.height));
    nsImage.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size.width, size.height), $.NSZeroRect, 2 /* source over */, 1.0);
    $.NSGraphicsContext.restoreGraphicsState;
    const props = $.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithDouble(0.82), $.NSImageCompressionFactor);
    const data = rep.representationUsingTypeProperties(3 /* JPEG */, props);
    if (data.isNil()) return null;
    return ObjC.unwrap(data.base64EncodedStringWithOptions(0));
}

function run(argv) {
    try {
        const filePath = argv[0];
        const pageIndex = Math.max(0, parseInt(argv[1] || '0', 10));
        const maxEdge = Math.max(200, parseInt(argv[2] || '1400', 10));
        const url = $.NSURL.fileURLWithPath(filePath);
        let img = null, pages = 1;
        if (filePath.toLowerCase().endsWith('.pdf')) {
            const doc = $.PDFDocument.alloc.initWithURL(url);
            if (doc.isNil()) return JSON.stringify({ error: 'could not open PDF' });
            pages = Number(doc.pageCount);
            if (pageIndex >= pages) return JSON.stringify({ error: 'no such page', pages });
            const page = doc.pageAtIndex(pageIndex);
            const box = page.boundsForBox(0 /* media box */);
            const size = fit(box.size.width, box.size.height, maxEdge, true);
            // Rasterize at the target size; drawInRect below is then 1:1.
            img = page.thumbnailOfSizeForBox({ width: size.width, height: size.height }, 0);
            if (img.isNil()) return JSON.stringify({ error: 'could not render page', pages });
            const b64 = jpegOf(img, size);
            if (!b64) return JSON.stringify({ error: 'could not encode page', pages });
            return JSON.stringify({ dataUrl: 'data:image/jpeg;base64,' + b64, pages, width: size.width, height: size.height });
        }
        img = $.NSImage.alloc.initWithContentsOfURL(url);
        if (img.isNil()) return JSON.stringify({ error: 'could not open image' });
        const isz = img.size;
        const size = fit(isz.width, isz.height, maxEdge, false);
        const b64 = jpegOf(img, size);
        if (!b64) return JSON.stringify({ error: 'could not encode image' });
        return JSON.stringify({ dataUrl: 'data:image/jpeg;base64,' + b64, pages: 1, width: size.width, height: size.height });
    } catch (e) {
        return JSON.stringify({ error: String(e && e.message || e) });
    }
}
`;

/**
 * Render one page (0-based) of a PDF, or an image file, as a JPEG data URL.
 * Resolves {dataUrl, pages, width, height} or {error}. Never rejects.
 */
function renderPage(filePath, pageIndex = 0, maxEdge = DEFAULT_MAX_EDGE) {
    return new Promise((resolve) => {
        const ext = path.extname(String(filePath || '')).toLowerCase();
        if (ext !== '.pdf' && !IMAGE_EXTS.has(ext)) { resolve({ error: 'not a PDF or image' }); return; }
        execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_SOURCE, filePath, String(pageIndex), String(maxEdge)], {
            timeout: RENDER_TIMEOUT_MS,
            maxBuffer: 24 * 1024 * 1024
        }, (err, stdout, stderr) => {
            if (err && !stdout) {
                resolve({ error: `page render failed: ${(stderr || err.message || '').toString().slice(0, 300)}` });
                return;
            }
            try { resolve(JSON.parse(String(stdout).trim())); }
            catch { resolve({ error: 'page render returned no JSON' }); }
        });
    });
}

module.exports = { renderPage, DEFAULT_MAX_EDGE, IMAGE_EXTS };
