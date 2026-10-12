/**
 * C8.2 regression net — documents as first-class input.
 * All through the real fs_read IPC path (grants, caps, extraction, OCR).
 */
module.exports = [
  {
    id: 'c82-pdf-text',
    name: 'fs_read extracts a text PDF with page markers',
    kind: 'det',
    async run({ page, docs }) {
      const r = await page.evaluate((p) => window.electronAgentFS.read(p), docs + '/statement.pdf');
      const pass = !r.error && r.kind === 'pdf' && r.text.includes('[Page 1]') && r.text.includes('913.37') && !r.ocr;
      return { pass, detail: r.error || (r.text || '').slice(0, 60) };
    }
  },
  {
    id: 'c82-pdf-ocr',
    name: 'image-only PDF falls back to macOS Vision OCR',
    kind: 'det',
    async run({ page, docs }) {
      const r = await page.evaluate((p) => window.electronAgentFS.read(p), docs + '/scan.pdf');
      const pass = !r.error && r.ocr === true && r.text.includes('482.19');
      return { pass, detail: r.error || `ocr=${r.ocr} ${(r.text || '').slice(0, 60)}` };
    }
  },
  {
    id: 'c82-pdf-offset-cache',
    name: 'offset paging over extracted text hits the cache',
    kind: 'det',
    async run({ page, docs }) {
      const r = await page.evaluate(async (p) => {
        const full = await window.electronAgentFS.read(p);
        const t0 = Date.now();
        const paged = await window.electronAgentFS.read(p, 10);
        return { match: paged.text === full.text.slice(10), ms: Date.now() - t0, offset: paged.offset };
      }, docs + '/statement.pdf');
      return { pass: r.match && r.offset === 10 && r.ms < 500, detail: JSON.stringify(r) };
    }
  },
  {
    id: 'c82-xlsx',
    name: 'xlsx arrives as tab-separated sheets the model can total',
    kind: 'det',
    async run({ page, docs }) {
      const r = await page.evaluate((p) => window.electronAgentFS.read(p), docs + '/test.xlsx');
      const pass = !r.error && r.kind === 'xlsx' && r.text.includes('## Sheet: Invoices') && r.text.includes('Acme & Sons\t1250.5');
      return { pass, detail: r.error || (r.text || '').slice(0, 60) };
    }
  },
  {
    id: 'c82-docx',
    name: 'docx paragraphs + tables extract to totable text',
    kind: 'det',
    async run({ page, docs }) {
      const r = await page.evaluate((p) => window.electronAgentFS.read(p), docs + '/test.docx');
      const pass = !r.error && r.kind === 'docx' && r.text.includes('$1,250.50') && r.text.includes('Widget & Co\t42');
      return { pass, detail: r.error || (r.text || '').slice(0, 60) };
    }
  },
  {
    id: 'c82-image-vision-payload',
    name: 'image files return the vision hand-off shape, never text',
    kind: 'det',
    async run({ page, docs }) {
      const r = await page.evaluate((p) => window.electronAgentFS.read(p), docs + '/scan.png');
      const pass = !r.error && r.kind === 'image' && Array.isArray(r.images)
        && /^data:image\/png;base64,/.test(r.images[0]?.dataUrl || '');
      return { pass, detail: r.error || `kind=${r.kind} images=${(r.images || []).length}` };
    }
  },
  {
    id: 'c82-binary-refusal-copy',
    name: 'other binaries refuse, and the copy names the readable kinds',
    kind: 'det',
    async run({ page, docs }) {
      const r = await page.evaluate((p) => window.electronAgentFS.read(p), docs + '/opaque.bin');
      const pass = !!r.error && /Binary file/.test(r.error) && /PDF, xlsx, docx and image files ARE readable/.test(r.error);
      return { pass, detail: r.error || 'unexpectedly readable' };
    }
  }
];
