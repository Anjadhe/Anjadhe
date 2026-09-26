/**
 * Documents app laws (2026-09-02; docs/LIBRARY.md "The Documents app"):
 *
 *  - TAGS ARE PATHS: "Finance/Taxes/2025" implies Finance and Finance/Taxes;
 *    the tree carries counts that include descendants; docsWithTag matches
 *    the tag and everything under it, case-insensitively; rename moves
 *    children.
 *  - TAGS SYNC, THE INDEX DOESN'T: docTags ride the record-merged
 *    app_library blob (an unloaded record survives a write; removal is
 *    tombstone-only).
 *  - THE ASSISTANT ORGANIZES ON REQUEST: list_documents lists by tag with
 *    the tree, search_library scopes by tag, tag_document adds/removes and
 *    returns the record the write ledger's pill opens; every read is
 *    untrusted-blocked.
 *  - IMPORT REPORTS WHAT LANDED (ids), so a drop on a tag can tag it; the
 *    store takes the wider file set (images, csv, pptx, rtf/doc).
 */
const fs = require('fs');
const path = require('path');

module.exports = [
  {
    id: 'docs-tags-are-paths',
    name: 'tags are paths: tree, descendant counts, matching, rename',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        const ids = ['doc_t1', 'doc_t2', 'doc_t3'];
        for (const id of ids) DocTags.forget(id);
        DocTags.set('doc_t1', ['Finance/Taxes/2025', 'Home'], 'a.pdf');
        DocTags.set('doc_t2', [' finance / taxes '], 'b.pdf');
        DocTags.set('doc_t3', ['Home/Insurance'], 'c.pdf');
        const norm = DocTags.get('doc_t2')[0] === 'finance/taxes';
        const under = new Set(DocTags.docsWithTag('FINANCE'));
        const scoped = under.has('doc_t1') && under.has('doc_t2') && !under.has('doc_t3');
        const leaf = DocTags.docsWithTag('Finance/Taxes/2025');
        const leafOk = leaf.length === 1 && leaf[0] === 'doc_t1';
        const tree = DocTags.tree();
        const fin = tree.find(n => n.name.toLowerCase() === 'finance');
        const taxes = fin && fin.children.find(n => n.name.toLowerCase() === 'taxes');
        const treeOk = !!fin && fin.count === 2 && !!taxes && taxes.count === 2
          && taxes.children.length === 1 && taxes.children[0].count === 1 && taxes.children[0].depth === 2;
        const home = tree.find(n => n.name === 'Home');
        const homeOk = !!home && home.count === 2 && home.children.length === 1;
        const renamed = DocTags.rename('Finance/Taxes', 'Money/Tax');
        const afterRename = DocTags.get('doc_t1').includes('Money/Tax/2025') && DocTags.get('doc_t2').includes('Money/Tax')
          && DocTags.docsWithTag('Finance').length === 0;
        DocTags.remove('doc_t1', 'home');
        const removed = !DocTags.get('doc_t1').some(t => t.toLowerCase() === 'home');
        for (const id of ids) DocTags.forget(id);
        const gone = DocTags.tree().length === 0 || !DocTags.tree().some(n => /money|home/i.test(n.name));
        const pass = norm && scoped && leafOk && treeOk && homeOk && renamed === 2 && afterRename && removed && gone;
        return { pass, detail: JSON.stringify({ norm, scoped, leafOk, treeOk, homeOk, renamed, afterRename, removed, gone }) };
      });
    }
  },
  {
    id: 'docs-tags-record-merged',
    name: 'docTags ride the record-merged library blob: unloaded records survive, tombstones remove',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        const mk = (id, updatedAt) => ({ id, relpath: id + '.pdf', tags: ['Merge/' + id], createdAt: '2026-01-01T00:00:00Z', updatedAt });
        const base = StorageManager.get('library') || {};
        StorageManager.set('library', { ...base, docTags: [mk('doc_m_a', '2026-01-01T00:00:00Z')] });
        StorageManager.set('library', { ...base, docTags: [mk('doc_m_b', '2026-01-02T00:00:00Z')] });
        const ids = (StorageManager.get('library').docTags || []).map(r => r.id);
        const union = ids.includes('doc_m_a') && ids.includes('doc_m_b');
        DocTags.forget('doc_m_a');
        const after = StorageManager.get('library');
        const ids2 = (after.docTags || []).map(r => r.id);
        const removed = !ids2.includes('doc_m_a') && ids2.includes('doc_m_b') && !!after.tombstones.doc_m_a;
        DocTags.forget('doc_m_b');
        const pass = union && removed;
        return { pass, detail: JSON.stringify({ union, ids, removed, ids2 }) };
      });
    }
  },
  {
    id: 'docs-tools-list-search-tag',
    name: 'list_documents / search_library scope by tag; tag_document organizes and returns the pill record; reads untrusted-blocked',
    kind: 'det',
    async run({ page, docs }) {
      const lib = path.join(docs, '.library');
      fs.mkdirSync(lib, { recursive: true });
      fs.writeFileSync(path.join(lib, 'lease-agreement.md'), '# Lease agreement\n\nPets are allowed with a deposit of four hundred dollars. The lease runs twelve months from March.\n');
      fs.writeFileSync(path.join(lib, 'dishwasher-receipt.txt'), 'Receipt: Bosch dishwasher, total 749.00, purchased at Home Depot. Warranty two years.\n');
      const out = await page.evaluate(async () => {
        await window.electronLibrary.scan();
        for (let i = 0; i < 80; i++) {
          const s = await window.electronLibrary.status();
          if (!s.queued && !s.indexing && s.docs >= 2) break;
          await new Promise(r => setTimeout(r, 250));
        }
        const listing = await window.electronLibrary.list();
        const lease = listing.docs.find(d => /lease-agreement/.test(d.relpath));
        const receipt = listing.docs.find(d => /dishwasher-receipt/.test(d.relpath));
        if (!lease || !receipt) return { error: 'fixtures not indexed', docs: listing.docs.map(d => d.relpath) };

        const tagged = await AgentTools.handlers.tag_document({ docId: lease.id, add: ['Home/Lease', ' home / lease '] });
        const tagOk = tagged.success && tagged.added.length === 1 && tagged.added[0] === 'Home/Lease'
          && tagged.document && tagged.document.id === lease.id && tagged.tags.length === 1;
        await AgentTools.handlers.tag_document({ docId: receipt.id, add: ['Home/Appliances'] });

        const listed = await AgentTools.handlers.list_documents({ tag: 'home' });
        const listOk = listed.total === 2 && listed.tags.some(t => t.tag === 'Home' && t.documents === 2)
          && listed.documents.every(d => d.tags.length === 1);
        const untagged = await AgentTools.handlers.list_documents({ untagged: true });
        const untaggedOk = !untagged.documents.some(d => d.docId === lease.id || d.docId === receipt.id);

        const s1 = await AgentTools.handlers.search_library({ query: 'pets deposit', tag: 'Home/Lease' });
        const scopedOk = s1.count >= 1 && s1.results.every(r => r.docId === lease.id) && s1.results[0].tags[0] === 'Home/Lease';
        const s2 = await AgentTools.handlers.search_library({ query: 'pets deposit', tag: 'Home/Appliances' });
        const scopedOutOk = s2.count === 0;
        const s3 = await AgentTools.handlers.search_library({ query: 'anything', tag: 'Nope/Never' });
        const missingTagOk = Array.isArray(s3.results) && s3.results.length === 0 && /No document carries/.test(s3.note || '');

        // search_all finds a document by CONTENT ("warranty" is not in the
        // title), and the ⌘K listing is fresh without the page ever opening.
        const all = await AgentTools.handlers.search_all({ query: 'warranty two years' });
        const allHit = all.results.find(r => r.app === 'reader' && r.id === receipt.id);
        const searchAllOk = !!allHit && allHit.kind === 'document' && /warranty/i.test(allHit.snippet || '') && allHit.tags[0] === 'Home/Appliances';
        const listingFresh = (ReaderApp._listing.docs || []).some(d => d.id === receipt.id);
        // Inline link grammar: anjadhe://document/<id> is a registered type
        // that opens the document in the reader (it used to dead-end on Home).
        const linkType = !!RecordLinks.TYPES.document && /document/.test(RecordLinks.promptTypes());
        const parsed = RecordLinks.parse ? RecordLinks.parse(`anjadhe://document/${receipt.id}`) : null;
        RecordLinks.open('document', receipt.id);
        await new Promise(r => setTimeout(r, 400));
        const linkOpened = document.querySelector('.view.active')?.id === 'reader-view' && ReaderApp._reader.docId === receipt.id;
        const linkExists = RecordLinks.TYPES.document.exists(receipt.id) === true && RecordLinks.TYPES.document.exists('doc_nope') === false;
        ReaderApp._reader.close();
        // Sources: reads name the records they drew on, as in-app keys.
        const rd = await AgentTools.handlers.read_library_doc({ docId: receipt.id });
        const srcRead = AgentTools.sourcesFor('read_library_doc', { docId: receipt.id }, rd);
        const srcSearch = AgentTools.sourcesFor('search_library', { query: 'x' }, s1);
        const srcAll = AgentTools.sourcesFor('search_all', { query: 'x' }, all);
        const noteRes = { id: 'n1', title: 'A note' };
        const srcNote = AgentTools.sourcesFor('get_note', { id: 'n1' }, noteRes);
        const srcNone = AgentTools.sourcesFor('get_note', { id: 'n1' }, { error: 'nope' });
        const sourcesOk = srcRead.length === 1 && srcRead[0].key === `librarydoc:${receipt.id}` && /dishwasher/.test(srcRead[0].title)
          && srcSearch.some(x => x.key === `librarydoc:${lease.id}`)
          && srcAll.some(x => x.key === `librarydoc:${receipt.id}`)
          && srcNote[0].key === 'notes:n1' && srcNone.length === 0;
        // Found through search_all with no documents word in the message →
        // the read tool must already be there (core), and the hit seeds the
        // library domain for the follow-up.
        const readIsCore = AgentTools._toolGroups.read_library_doc === 'core'
          && AgentTools.definitionsFor('until when is my ead active', []).some(d => d.function.name === 'read_library_doc');
        const conv = AgentService.createConversation();
        await AgentTools.handlers.search_all({ query: 'warranty two years' }, { convId: conv.id });
        const seeded = (AgentService.conversations.find(c => c.id === conv.id).scopedDomains || []).includes('library');
        const kK = GlobalSearch.data('dishwasher-receipt', 5).some(h => h.app === 'reader' && h.id === receipt.id);

        const removed = await AgentTools.handlers.tag_document({ docId: lease.id, remove: ['HOME/LEASE'] });
        const removeOk = removed.success && removed.removed.length === 1 && removed.tags.length === 0;

        const blocked = ['search_library', 'list_documents', 'read_library_doc', 'tag_document']
          .every(n => AgentService.UNTRUSTED_BLOCKED_TOOLS.has(n));
        const pill = WriteLedger.RECORD_TOOLS.tag_document && WriteLedger.RECORD_TOOLS.tag_document[0] === 'reader';
        const domain = ['find the receipt for the dishwasher', 'what do I have tagged Finance', 'summarize my lease document']
          .every(m => AgentTools._domainsForMessage(m).has('library'));

        // Untrusted-blocked means gone from the definitions an untrusted turn ships.
        DocTags.forget(lease.id); DocTags.forget(receipt.id);
        return { tagOk, listOk, untaggedOk, scopedOk, scopedOutOk, missingTagOk, removeOk, blocked, pill: !!pill, domain,
                 searchAllOk, listingFresh, kK, readIsCore, seeded, sourcesOk, linkType, parsed: parsed ? parsed.type : null, linkOpened, linkExists, s1: s1.count, s2: s2.count };
      });
      if (out.error) return { pass: false, detail: JSON.stringify(out) };
      const pass = out.tagOk && out.listOk && out.untaggedOk && out.scopedOk && out.scopedOutOk && out.missingTagOk
        && out.removeOk && out.blocked && out.pill && out.domain && out.searchAllOk && out.listingFresh && out.kK && out.readIsCore && out.seeded && out.sourcesOk && out.linkType && out.linkOpened && out.linkExists;
      return { pass, detail: JSON.stringify(out) };
    }
  },
  {
    id: 'docs-import-reports-ids-and-wider-types',
    name: 'import returns the landed docs (so a drop on a tag can tag them); csv and pptx-less wider types index',
    kind: 'det',
    async run({ page, docs }) {
      const src = path.join(docs, 'import-src');
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, 'expenses.csv'), 'date,vendor,amount\n2026-08-01,Acme,120.00\n2026-08-03,Bolt,80.50\n');
      fs.writeFileSync(path.join(src, 'notes.rtf'), '{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Helvetica;}} \\f0\\fs24 Boiler serviced in April, next service due October.\\par }');
      fs.writeFileSync(path.join(src, 'photo.xyz'), 'not a document');
      const out = await page.evaluate(async (dir) => {
        const res = await window.electronLibrary.importPaths([dir + '/expenses.csv', dir + '/notes.rtf', dir + '/photo.xyz']);
        for (let i = 0; i < 80; i++) {
          const s = await window.electronLibrary.status();
          if (!s.queued && !s.indexing) break;
          await new Promise(r => setTimeout(r, 250));
        }
        const listing = await window.electronLibrary.list();
        const byId = new Map(listing.docs.map(d => [d.id, d]));
        const landed = (res.docs || []).map(d => byId.get(d.id)).filter(Boolean);
        // Tag what landed the way the drop-on-a-tag path does.
        for (const d of (res.docs || [])) DocTags.add(d.id, 'Imports/Test', d.relpath);
        const taggedAll = (res.docs || []).every(d => DocTags.get(d.id).includes('Imports/Test'));
        const csv = landed.find(d => /expenses/.test(d.relpath));
        const rtf = landed.find(d => /notes/.test(d.relpath));
        const rtfRead = rtf ? await window.electronLibrary.readDoc(rtf.id, 0, 2000) : null;
        for (const d of (res.docs || [])) DocTags.forget(d.id);
        return {
          imported: res.imported, skipped: res.skipped, ids: (res.docs || []).length,
          csvIndexed: !!csv && csv.status === 'indexed',
          rtfIndexed: !!rtf && rtf.status === 'indexed',
          rtfText: rtfRead && rtfRead.text ? rtfRead.text.slice(0, 80) : (rtfRead && rtfRead.error),
          taggedAll
        };
      }, src);
      const pass = out.imported === 2 && out.skipped === 1 && out.ids === 2 && out.csvIndexed && out.rtfIndexed
        && /Boiler serviced/.test(out.rtfText || '') && out.taggedAll;
      return { pass, detail: JSON.stringify(out) };
    }
  }
,
  {
    id: 'docs-tidy-reflow-segments-cache',
    name: 'DocTidy: reflow rejoins PDF lines (pure), segments cut at paragraphs, dedupe, tidy cache keyed by file mtime',
    kind: 'det',
    async run({ page, docs }) {
      const lib = path.join(docs, '.library');
      fs.mkdirSync(lib, { recursive: true });
      fs.writeFileSync(path.join(lib, 'tidy-target.txt'), 'A short note.\n');
      const out = await page.evaluate(async () => {
        const raw = '[Page 1]\nACME LEASE AGREEMENT\nThis lease is made between the land-\nlord and the tenant for the premises at\n12 Elm Street.\nRent is due monthly.\n1. TERM. The term of this lease is twelve months, beginning March 1,\n2026 and ending February 28, 2027.\nItem        Qty   Price\nChairs      4     120.00\n\n- Pets allowed with deposit\n[Page 2]\nThe term runs twelve months from\nMarch.';
        const blocks = DocTidy.blocks(raw);
        const kinds = blocks.map(b => b.kind).join(',');
        const para = blocks.find(b => b.kind === 'para' && /landlord and the tenant/.test(b.text));
        const joined = !!para && /premises at 12 Elm Street\./.test(para.text);
        const table = blocks.find(b => b.kind === 'table');
        const tableOk = !!table && /Chairs\s+4\s+120\.00/.test(table.text);
        const pages = blocks.filter(b => b.kind === 'page').length === 2;
        const list = blocks.some(b => /^- Pets allowed with deposit$/.test(b.text));
        // A numbered clause keeps its wrapped continuation; a short ALL-CAPS
        // title stands alone.
        const clause = blocks.some(b => b.kind === 'para' && /^1\. TERM\. .*ending February 28, 2027\.$/.test(b.text));
        const title = blocks.some(b => b.kind === 'line' && b.text === 'ACME LEASE AGREEMENT');
        const html = DocTidy.reflowHtml(raw, (e) => e);
        const htmlOk = /library-page-mark/.test(html) && /<pre class="library-reader-table">/.test(html);

        const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ` + 'x'.repeat(300)).join('\n\n');
        const segs = DocTidy.segments(long, 4000);
        const segOk = segs.length >= 3 && segs.every(sg => sg.length <= 4000) && segs.join('\n\n').replace(/\s+/g, '') === long.replace(/\s+/g, '');
        const deduped = DocTidy.dedupe('A line.\n\nA line.\n\nB line.\n\nA line.');
        const dedupeOk = deduped === 'A line.\n\nB line.\n\nA line.';

        await window.electronLibrary.scan();
        for (let i = 0; i < 40; i++) { const s = await window.electronLibrary.status(); if (!s.queued && !s.indexing) break; await new Promise(r => setTimeout(r, 200)); }
        const doc = (await window.electronLibrary.list()).docs.find(d => /tidy-target/.test(d.relpath));
        const none = await window.electronLibrary.tidyGet(doc.id);
        const set = await window.electronLibrary.tidySet(doc.id, { text: '# Tidy\n\nA short note.', coveredChars: 14, model: 'eval' });
        const got = await window.electronLibrary.tidyGet(doc.id);
        const cacheOk = none.none === true && set.success === true && got.text.startsWith('# Tidy') && got.coveredChars === 14 && got.model === 'eval';
        return { kinds, joined, tableOk, pages, list, clause, title, htmlOk, segs: segs.length, segOk, dedupeOk, cacheOk, docId: doc.id };
      });
      // Saved once, as a file the user owns: the sidecar exists and carries
      // the text; a TOUCHED file (same content) still hits — keyed by
      // content hash, not mtime; an EDITED file misses.
      const target = path.join(lib, 'tidy-target.txt');
      const side = path.join(lib, '.anjadhe', 'tidy', 'tidy-target.txt.md');
      const sidecar = fs.existsSync(side) && /^---\n[\s\S]*hash: [0-9a-f]{40}[\s\S]*---\n# Tidy/.test(fs.readFileSync(side, 'utf8'));
      const future = new Date(Date.now() + 5000);
      fs.utimesSync(target, future, future);
      const touched = await page.evaluate(async (id) => { await window.electronLibrary.scan(); return await window.electronLibrary.tidyGet(id); }, out.docId);
      const touchedHit = !!touched && typeof touched.text === 'string' && touched.text.startsWith('# Tidy');
      fs.writeFileSync(target, 'A short note, edited.\n');
      const edited = await page.evaluate(async (id) => {
        await window.electronLibrary.scan();
        for (let i = 0; i < 40; i++) { const s = await window.electronLibrary.status(); if (!s.queued && !s.indexing) break; await new Promise(r => setTimeout(r, 200)); }
        return await window.electronLibrary.tidyGet(id);
      }, out.docId);
      const invalidated = !!edited && edited.none === true;
      const sidecarIndexed = await page.evaluate(async () => (await window.electronLibrary.list()).docs.some(d => /\.anjadhe/.test(d.relpath)));
      const pass = out.joined && out.tableOk && out.pages && out.list && out.clause && out.title && out.htmlOk && out.segOk && out.dedupeOk && out.cacheOk
        && sidecar && touchedHit && invalidated && !sidecarIndexed;
      return { pass, detail: JSON.stringify({ ...out, sidecar, touchedHit, invalidated, sidecarIndexed }) };
    }
  }
,
  {
    id: 'docs-vision-pages-and-transcription',
    name: 'vision plumbing: a page renders as JPEG; a vision transcription becomes the document text (read, index) and read_library_doc page attaches the image',
    kind: 'det',
    async run({ page, docs }) {
      const lib = path.join(docs, '.library');
      fs.mkdirSync(lib, { recursive: true });
      fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'statement.pdf'), path.join(lib, 'acme-statement.pdf'));
      const out = await page.evaluate(async () => {
        await window.electronLibrary.scan();
        for (let i = 0; i < 80; i++) { const s = await window.electronLibrary.status(); if (!s.queued && !s.indexing) break; await new Promise(r => setTimeout(r, 250)); }
        const doc = (await window.electronLibrary.list()).docs.find(d => /acme-statement/.test(d.relpath));
        if (!doc) return { error: 'fixture not indexed' };
        const img = await window.electronLibrary.renderPage(doc.id, 0, 1400);
        const renderOk = !img.error && /^data:image\/jpeg;base64,/.test(img.dataUrl) && img.pages === 1 && img.height === 1400;
        const before = await window.electronLibrary.readDoc(doc.id, 0, 4000);
        // pdf.js's text layer, whatever shape it takes — only that it is
        // not the transcription yet.
        const parsedText = !before.error && !/zebrafinch/.test(before.text || '');
        const parsedHead = String(before.text || before.error || '').slice(0, 60);

        // A vision transcription (what the brain would have returned).
        const md = '## ACME BANK STATEMENT\n\n| Item | Amount |\n| --- | --- |\n| Opening balance | $1,000.00 |\n| Coffee Shop | -$4.50 |\n| Grocery Mart | -$82.13 |\n| Closing balance | $913.37 |\n\n[Stamp: zebrafinch verified]';
        const set = await window.electronLibrary.tidySet(doc.id, { text: md, coveredChars: md.length, model: 'eval-vision', method: 'vision', pages: 1, pagesDone: 1 });
        for (let i = 0; i < 80; i++) { const s = await window.electronLibrary.status(); if (!s.queued && !s.indexing) break; await new Promise(r => setTimeout(r, 250)); }
        const after = await window.electronLibrary.readDoc(doc.id, 0, 4000);
        const becameText = /zebrafinch verified/.test(after.text || '') && !/\[Page 1\]/.test(after.text || '');
        const hit = await window.electronLibrary.search('zebrafinch', { k: 3 });
        const indexed = (hit.results || []).some(r => r.docId === doc.id);
        const cached = await window.electronLibrary.tidyGet(doc.id);
        const cacheOk = cached.method === 'vision' && cached.pages === 1 && cached.pagesDone === 1 && cached.text === md;

        // read_library_doc page: text of the page + the image when the brain can see.
        const origSupports = AgentService.supportsVision;
        AgentService.supportsVision = () => true;
        const seen = await AgentTools.handlers.read_library_doc({ docId: doc.id, page: 1 });
        AgentService.supportsVision = () => false;
        const blind = await AgentTools.handlers.read_library_doc({ docId: doc.id, page: 1 });
        AgentService.supportsVision = origSupports;
        const pageOk = seen.page === 1 && /zebrafinch/.test(seen.text) && Array.isArray(seen.images) && /^data:image\/jpeg/.test(seen.images[0].dataUrl)
          && /zebrafinch/.test(blind.text) && !blind.images;
        const paged = DocTidy.isPaged('x.pdf') && DocTidy.isPaged('scan.HEIC') && !DocTidy.isPaged('notes.md');
        // The banner offers a re-read on a text-tidied/OCR'd document when the brain can see.
        const inst = DocReader.create({ render() {}, body() { return null; }, onExit() {}, onDeleted() {} });
        inst.docId = doc.id; inst.doc = { docId: doc.id, relpath: doc.relpath, text: 'x' };
        inst._resetTidy(); inst.tidy.status = 'done'; inst.tidy.method = 'text'; inst.tidy.canSee = true; inst.tidy.view = 'tidy';
        const offers = /Re-read with vision/.test(inst._bannerHtml());
        inst.tidy.method = 'vision';
        const noOfferWhenVision = !/Re-read with vision/.test(inst._bannerHtml());
        inst.tidy.canSee = false; inst.tidy.method = 'text';
        const noOfferWhenBlind = !/Re-read with vision/.test(inst._bannerHtml());
        return { renderOk, parsedText, parsedHead, set: set.success, becameText, indexed, cacheOk, pageOk, paged, offers, noOfferWhenVision, noOfferWhenBlind, pages: img.pages, h: img.height };
      });
      if (out.error) return { pass: false, detail: JSON.stringify(out) };
      const side = path.join(lib, '.anjadhe', 'tidy', 'acme-statement.pdf.md');
      const sidecar = fs.existsSync(side) && /method: vision/.test(fs.readFileSync(side, 'utf8'));
      const pass = out.renderOk && out.parsedText && out.set && out.becameText && out.indexed && out.cacheOk && out.pageOk && out.paged && sidecar
        && out.offers && out.noOfferWhenVision && out.noOfferWhenBlind;
      return { pass, detail: JSON.stringify({ ...out, sidecar }) };
    }
  }
];
