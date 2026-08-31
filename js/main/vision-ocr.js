/**
 * OCR via the macOS Vision framework (C8.2) — the fallback for scanned
 * PDFs and images with no extractable text layer.
 *
 * No bundled OCR engine (tesseract et al. are multi-hundred-MB and this is
 * a Mac app): a JXA script run by /usr/bin/osascript bridges into Vision +
 * PDFKit directly. No compiled helper, no new dependency, fully local.
 * VNImageRequestHandler.performRequests:error: is synchronous and fills
 * request.results, so the script needs no ObjC blocks — the one JXA bridge
 * limitation that would have sunk this approach.
 *
 * Callers gate on "extraction yielded near-zero text" so the common
 * text-PDF path never pays the OCR cost.
 */

const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const OCR_TIMEOUT_MS = 120000;   // scanned statements are ~2-4s/page
const OCR_MAX_PAGES = 20;

// argv: <filePath> <maxPages>. Emits JSON {pages:[text,…]} or {error} on
// stdout. PDF pages are rasterized at 2x letter size — enough for Vision's
// accurate mode on ordinary scans without ballooning memory on big docs.
const JXA_SOURCE = `
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('Quartz');
ObjC.import('Vision');

function ocrImage(nsImage) {
    const tiff = nsImage.TIFFRepresentation;
    if (tiff.isNil()) return '';
    const handler = $.VNImageRequestHandler.alloc.initWithDataOptions(tiff, $.NSDictionary.dictionary);
    const req = $.VNRecognizeTextRequest.alloc.init;
    req.recognitionLevel = 0;           // VNRequestTextRecognitionLevelAccurate
    req.usesLanguageCorrection = true;
    const err = Ref();
    const ok = handler.performRequestsError($.NSArray.arrayWithObject(req), err);
    if (!ok) return '';
    let text = '';
    const results = req.results;
    if (!results.isNil()) {
        for (let i = 0; i < results.count; i++) {
            const cands = results.objectAtIndex(i).topCandidates(1);
            if (cands.count > 0) text += ObjC.unwrap(cands.objectAtIndex(0).string) + '\\n';
        }
    }
    return text.trim();
}

function run(argv) {
    try {
        const filePath = argv[0];
        const maxPages = Math.max(1, parseInt(argv[1] || '20', 10));
        const url = $.NSURL.fileURLWithPath(filePath);
        const pages = [];
        if (filePath.toLowerCase().endsWith('.pdf')) {
            const doc = $.PDFDocument.alloc.initWithURL(url);
            if (doc.isNil()) return JSON.stringify({ error: 'could not open PDF' });
            const n = Math.min(doc.pageCount, maxPages);
            for (let i = 0; i < n; i++) {
                const page = doc.pageAtIndex(i);
                const img = page.thumbnailOfSizeForBox({ width: 1700, height: 2200 }, $.kPDFDisplayBoxMediaBox);
                pages.push(img.isNil() ? '' : ocrImage(img));
            }
            return JSON.stringify({ pages, totalPages: doc.pageCount });
        }
        const img = $.NSImage.alloc.initWithContentsOfURL(url);
        if (img.isNil()) return JSON.stringify({ error: 'could not open image' });
        pages.push(ocrImage(img));
        return JSON.stringify({ pages, totalPages: 1 });
    } catch (e) {
        return JSON.stringify({ error: String(e && e.message || e) });
    }
}
`;

/**
 * OCR a PDF or image file. Resolves {pages: [text,…], totalPages} or
 * {error}. Never rejects — OCR is a best-effort fallback and the caller
 * degrades to "no text found".
 */
function ocrFile(filePath, maxPages = OCR_MAX_PAGES) {
    return new Promise((resolve) => {
        // osascript takes the program via -e; the file path rides argv so no
        // quoting/injection surface exists.
        execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_SOURCE, filePath, String(maxPages)], {
            timeout: OCR_TIMEOUT_MS,
            maxBuffer: 8 * 1024 * 1024
        }, (err, stdout, stderr) => {
            if (err && !stdout) {
                resolve({ error: `OCR failed: ${(stderr || err.message || '').toString().slice(0, 300)}` });
                return;
            }
            try {
                const parsed = JSON.parse(String(stdout).trim());
                if (parsed && typeof parsed === 'object') {
                    // JXA serializes bridged NSNumber (pageCount) as a string.
                    if (parsed.totalPages != null) parsed.totalPages = parseInt(parsed.totalPages, 10) || 0;
                    resolve(parsed);
                } else resolve({ error: 'OCR returned no result' });
            } catch {
                resolve({ error: `OCR returned unparseable output: ${String(stdout).slice(0, 200)}` });
            }
        });
    });
}

module.exports = { ocrFile, OCR_MAX_PAGES };
