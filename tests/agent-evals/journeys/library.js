/**
 * Library laws (docs/LIBRARY.md, js/main/library-store.js).
 *
 * Pinned deterministically:
 *  - chunker: pure function of its input — deterministic, bounded (every
 *    chunk fits the embedder window with prefix headroom), heading-aware.
 *  - RRF fusion: rank arithmetic, agreement beats a single high rank (V5 —
 *    no model in the read path).
 *  - the tools follow the feature flag and sit in the untrusted blocklist
 *    (V4 — corpus reads are an exfiltration primitive on injected turns).
 *  - end-to-end scan → ingest → keyword search WITHOUT the embedding model:
 *    the honest-degrade path (vector NULLs, keywordOnly flag), which is
 *    also exactly what the eval environment has.
 *  - harness isolation: the eval app's library dir is the throwaway one
 *    (ANJADHE_LIBRARY_DIR), never the user's real folder.
 *
 * The chunker/RRF journeys run runner-side: library-store.js is a plain
 * module and those functions touch no DB — requiring it here tests the
 * exact production code without an Electron detour. (Do NOT require
 * better-sqlite3 runner-side — it is built for Electron's ABI.)
 */
const fs = require('fs');
const path = require('path');

const LibraryStore = require('../../../js/main/library-store.js');

module.exports = [
  {
    id: 'lib-chunker-deterministic-and-bounded',
    name: 'chunking is deterministic, size-bounded, and heading-aware',
    kind: 'det',
    async run() {
      const doc = [
        '# Opening thoughts',
        'First paragraph about writing. '.repeat(20),
        '',
        'Second paragraph, shorter.',
        '',
        '## The middle years',
        ('A long paragraph that will not fit one chunk. '.repeat(90)),
        '',
        '# Closing',
        'One sentence at the end.'
      ].join('\n');

      const a = LibraryStore.chunkText(doc);
      const b = LibraryStore.chunkText(doc);
      const deterministic = JSON.stringify(a) === JSON.stringify(b);
      // The packing bound: a chunk is at most MAX plus the overlap tail it
      // inherited — with the task+section prefixes this stays well inside
      // the embedder's 2,048-token window.
      const bound = LibraryStore.CHUNK_MAX + LibraryStore.CHUNK_OVERLAP + 2;
      const bounded = a.every(c => c.text.length <= bound && c.text.trim().length > 0);
      const sections = new Set(a.map(c => c.section));
      const headingsCarve = sections.has('Opening thoughts') && sections.has('The middle years') && sections.has('Closing');
      const seqs = a.map(c => c.seq);
      const ordered = seqs.every((s, i) => s === i);
      const longSectionSplit = a.filter(c => c.section === 'The middle years').length >= 2;
      const empty = LibraryStore.chunkText('') .length === 0 && LibraryStore.chunkText('   \n\n  ').length === 0;

      const pass = deterministic && bounded && headingsCarve && ordered && longSectionSplit && empty;
      return { pass, detail: JSON.stringify({ chunks: a.length, deterministic, bounded, headingsCarve, ordered, longSectionSplit, empty, maxLen: Math.max(...a.map(c => c.text.length)) }) };
    }
  },
  {
    id: 'lib-rrf-arithmetic',
    name: 'reciprocal-rank fusion: agreement across legs beats one high rank (V5)',
    kind: 'det',
    async run() {
      // c appears mid-rank in BOTH legs; a and b each lead only one leg.
      // 1/61+1/63 (c) > 1/61 + nothing (a or b) — agreement wins.
      const fused = LibraryStore._rrf([
        ['a', 'c', 'd'],
        ['b', 'e', 'c']
      ]);
      const order = fused.map(f => f[0]);
      const agreementWins = order[0] === 'c';
      // A single-leg fusion preserves that leg's order.
      const single = LibraryStore._rrf([['x', 'y', 'z']]).map(f => f[0]);
      const singleOrdered = JSON.stringify(single) === JSON.stringify(['x', 'y', 'z']);
      // Deterministic scores, descending.
      const descending = fused.every((f, i) => i === 0 || fused[i - 1][1] >= f[1]);
      const pass = agreementWins && singleOrdered && descending;
      return { pass, detail: JSON.stringify({ order, single, descending }) };
    }
  },
  {
    id: 'lib-tools-follow-flag-and-untrusted-block',
    name: 'library tools are cut with the flag off and sit in the untrusted blocklist (V4)',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(() => {
        // The eval profile leaves the `library` flag at its default (off):
        // the tools must be cut from the registry entirely — a model must
        // never see a door the user can't walk through.
        const flagOff = !FEATURES.isEnabled('library');
        const defsCut = !AgentTools.definitions.some(d => d.function && ['search_library', 'read_library_doc'].includes(d.function.name));
        const handlersCut = !AgentTools.handlers.search_library && !AgentTools.handlers.read_library_doc;
        // The blocklist entry is unconditional — it must be present so the
        // day the flag flips on, untrusted turns are already covered.
        const blocked = AgentService.UNTRUSTED_BLOCKED_TOOLS.has('search_library')
          && AgentService.UNTRUSTED_BLOCKED_TOOLS.has('read_library_doc');
        const pass = flagOff ? (defsCut && handlersCut && blocked) : blocked;
        return { pass, detail: JSON.stringify({ flagOff, defsCut, handlersCut, blocked }) };
      });
    }
  },
  {
    id: 'lib-scan-ingest-keyword-search-no-embedder',
    name: 'scan → ingest → search works keyword-only without the embedding model (honest degrade)',
    kind: 'det',
    async run({ page, docs }) {
      // The harness points ANJADHE_LIBRARY_DIR here — write fixtures from
      // the runner, then drive the real IPC pipeline in the app.
      const libDir = path.join(docs, '.library', 'essays');
      fs.mkdirSync(libDir, { recursive: true });
      fs.writeFileSync(path.join(libDir, 'zanzibar-trip.md'),
        '# The ferry crossing\n\nThe zanzibar ferry smelled of diesel and cloves. I wrote most of this leaning on the rail.\n\n# Stone town\n\nNarrow streets, carved doors, terrible coffee, wonderful people.\n');

      const out = await page.evaluate(async () => {
        const scan = await window.electronLibrary.scan();
        // Ingest runs in MAIN and drains in the background — poll until the
        // queue settles (no embed model in the eval env, so this is fast).
        let status = null;
        for (let i = 0; i < 60; i++) {
          status = await window.electronLibrary.status();
          if (!status.queued && !status.indexing && status.docs > 0) break;
          await new Promise(r => setTimeout(r, 300));
        }
        const listing = await window.electronLibrary.list();
        const search = await window.electronLibrary.search('zanzibar ferry', { k: 5 });
        return { scan, status, listing, search };
      });

      const doc = (out.listing.docs || []).find(d => d.relpath && d.relpath.includes('zanzibar-trip.md'));
      const hit = (out.search.results || [])[0];
      const pass = !!doc && doc.status === 'indexed' && doc.chunkCount >= 1
        && out.status.indexed >= 1
        && !!hit && hit.title === 'zanzibar-trip' && /zanzibar ferry/i.test(hit.text)
        && hit.section === 'The ferry crossing'
        && out.search.keywordOnly === true;
      return { pass, detail: JSON.stringify({ scan: out.scan, status: out.status, doc: doc && { status: doc.status, chunks: doc.chunkCount }, hit: hit && { title: hit.title, section: hit.section }, keywordOnly: out.search.keywordOnly }) };
    }
  },
  {
    id: 'lib-import-copies-into-the-folder',
    name: 'in-app import copies into the folder (V1): dedupes names, skips unsupported, refuses the root',
    kind: 'det',
    async run({ page, docs }) {
      const srcDir = path.join(docs, 'import-src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'voice-essay.md'), '# On voice\n\nImported through the in-app door.\n');
      fs.writeFileSync(path.join(srcDir, 'binary.zip'), 'not a document');
      // A same-named file already in the library root: the import must land
      // beside it under a fresh name, never overwrite the user's original.
      const libRoot = path.join(docs, '.library');
      fs.mkdirSync(libRoot, { recursive: true });
      fs.writeFileSync(path.join(libRoot, 'voice-essay.md'), 'the original stays');

      const out = await page.evaluate(
        (paths) => window.electronLibrary.importPaths(paths),
        // The root itself rides along to pin the inside-the-library guard —
        // it must be ignored (no self-copy recursion), not counted.
        [path.join(srcDir, 'voice-essay.md'), path.join(srcDir, 'binary.zip'), libRoot]
      );

      const originalKept = fs.readFileSync(path.join(libRoot, 'voice-essay.md'), 'utf8') === 'the original stays';
      const copyRenamed = fs.existsSync(path.join(libRoot, 'voice-essay 2.md'));
      const zipRefused = !fs.existsSync(path.join(libRoot, 'binary.zip'));
      const pass = !!out && out.imported === 1 && out.skipped === 1
        && originalKept && copyRenamed && zipRefused;
      return { pass, detail: JSON.stringify({ out, originalKept, copyRenamed, zipRefused }) };
    }
  },
  {
    id: 'lib-delete-doc-trashes-file-and-index-row',
    name: 'deleting a document moves the FILE to the Trash (never unlink) and drops the index row',
    kind: 'det',
    async run({ page, docs }) {
      const lib = path.join(docs, '.library', 'to-delete');
      fs.mkdirSync(lib, { recursive: true });
      const file = path.join(lib, 'ephemeral-essay.md');
      fs.writeFileSync(file, '# Ephemeral\n\nHere today, trashed in this journey.\n');

      const out = await page.evaluate(async () => {
        await window.electronLibrary.scan();
        for (let i = 0; i < 60; i++) {
          const s = await window.electronLibrary.status();
          if (!s.queued && !s.indexing) break;
          await new Promise(r => setTimeout(r, 300));
        }
        const before = await window.electronLibrary.list();
        const doc = (before.docs || []).find(d => d.relpath && d.relpath.includes('ephemeral-essay.md'));
        if (!doc) return { error: 'fixture never indexed' };
        const del = await window.electronLibrary.deleteDoc(doc.id);
        const after = await window.electronLibrary.list();
        return {
          del,
          stillListed: (after.docs || []).some(d => d.id === doc.id)
        };
      });

      if (out.error) return { pass: false, detail: out.error };
      const fileGone = !fs.existsSync(file);
      const pass = !!out.del && out.del.success === true && fileGone && !out.stillListed;
      return { pass, detail: JSON.stringify({ del: out.del, fileGone, stillListed: out.stillListed }) };
    }
  },
  {
    id: 'lib-eval-env-isolated',
    name: 'the eval app\'s library dir is the throwaway one, never ~/Anjadhe/library',
    kind: 'det',
    async run({ page, docs }) {
      const out = await page.evaluate(async () => (await window.electronLibrary.status()).dir);
      const pass = typeof out === 'string' && out.startsWith(docs) && !/Anjadhe\/library/.test(out.replace(docs, ''));
      return { pass, detail: JSON.stringify({ dir: out, docs }) };
    }
  }
];
