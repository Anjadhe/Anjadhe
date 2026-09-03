const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/**
 * LibraryStore — the user's original content + the local semantic index
 * (docs/LIBRARY.md, phase L1).
 *
 * Laws that shape this file:
 *  V1  Originals are FILES at ~/Anjadhe/library/ (ANJADHE_LIBRARY_DIR
 *      overrides for testing). First-level folders are collections. The
 *      store never holds the only copy of anything.
 *  V2  Everything here is DERIVED and machine-local: chunks, vectors and
 *      the FTS shadow live in the existing better-sqlite3 DB (outside the
 *      sync journal), stamped with the embedding model identity — a model
 *      change wipes and rebuilds rather than mixing vector spaces.
 *  V5  The read path is arithmetic: FTS5 BM25 + KNN over unit vectors
 *      (sqlite-vec vec0 index; linear-scan fallback when the extension is
 *      unavailable), fused with reciprocal-rank fusion. No model judgment
 *      anywhere in retrieval (the query embedding is an encoding, not a
 *      judgment).
 *
 * Vector storage vs vector index: library_chunks.vector (float32 BLOB) is
 * CANONICAL — it is what V2's "derived, rebuildable" promise covers, and
 * what the fallback scan reads. library_vec (vec0 virtual table) is an
 * INDEX over those BLOBs: rebuilt from them in seconds (_syncVecIndex),
 * never by re-embedding, and safe to lose entirely. vec0 traps learned
 * here: primary keys must be bound as BigInt (a JS number binds as REAL
 * and vec0 rejects it), and every statement touching the table errors on
 * a connection without the extension — hence the _vecOk() guards.
 *  V7  Ingest is a persisted queue drained in the MAIN process — it
 *      survives renderer reloads (Cmd+R) by construction, and a queue left
 *      over from a crash resumes on the next launch.
 *
 * FTS note: this deliberately uses a REGULAR fts5 table (its own text
 * copy), not an external-content one — the email index's
 * SQLITE_CORRUPT_VTAB trap came from external-content bookkeeping, and at
 * chunk sizes (~1.5 KB) the duplication is cheaper than the trap.
 */
const LibraryStore = {
    _getDb: null,         // () => Database — a getter because main.js can REOPEN
                          // the DB on a storage-path change; a held handle goes stale
    get db() { return this._getDb ? this._getDb() : null; },
    embed: null,          // EmbedManager (injected)
    extractPdf: null,     // async (absPath, buf) => {text} | {error} (injected from main)
    broadcast: null,      // (channel, payload) => void (injected)
    _watcher: null,
    _scanTimer: null,
    _draining: false,
    _matrixCache: null,   // { ids: number[], dims, data: Float32Array } — fallback scan only
    _vecCache: null,      // { db, ok } — sqlite-vec availability, per connection

    // Chunking targets, in characters (≈4 chars/token English). MAX keeps
    // chunk + section prefix + task prefix safely inside the embedder's
    // 2,048-token window even under unfriendly tokenization.
    CHUNK_TARGET: 1400,
    CHUNK_MAX: 1800,
    CHUNK_OVERLAP: 200,
    // Per-source caps mirror agent-fs-read.
    MAX_PDF_BYTES: 20 * 1024 * 1024,
    MAX_FILE_BYTES: 10 * 1024 * 1024,
    MAX_DOC_CHARS: 400 * 1024,
    // What the Documents app takes (2026-09-02: "any document — pdfs,
    // images, spreadsheets, docs"). Text and markup read directly; Office
    // files through doc-extract; images and scanned PDFs through the Mac's
    // own Vision OCR; legacy Word / RTF / OpenDocument through macOS
    // textutil. Everything is parsed locally.
    EXTS: new Set([
        '.md', '.markdown', '.txt', '.text', '.csv', '.tsv', '.json',
        '.html', '.htm',
        '.pdf',
        '.docx', '.xlsx', '.pptx',
        '.doc', '.rtf', '.rtfd', '.odt', '.webarchive',
        '.png', '.jpg', '.jpeg', '.heic', '.heif', '.tif', '.tiff', '.gif', '.webp', '.bmp'
    ]),
    IMAGE_EXTS: new Set(['.png', '.jpg', '.jpeg', '.heic', '.heif', '.tif', '.tiff', '.gif', '.webp', '.bmp']),
    TEXTUTIL_EXTS: new Set(['.doc', '.rtf', '.rtfd', '.odt', '.webarchive']),
    // Extraction cache: images and scanned PDFs cost seconds of OCR, and the
    // reader re-reads a document on every open and every page. Keyed by
    // path + mtime, a handful of entries — derived data, never persisted.
    _textCache: new Map(),
    TEXT_CACHE_MAX: 24,
    RRF_K: 60,
    CANDIDATES: 50,

    dir() {
        if (process.env.ANJADHE_LIBRARY_DIR) return process.env.ANJADHE_LIBRARY_DIR;
        // Blank-slate isolation (the DATA_ROOT law): a test instance must
        // never open the real ~/Anjadhe/library — Reader / the writing voice
        // were showing real documents under start:clean.
        if (process.env.ANJADHE_DATA_ROOT) {
            return path.join(path.resolve(process.env.ANJADHE_DATA_ROOT), 'Anjadhe', 'library');
        }
        return path.join(os.homedir(), 'Anjadhe', 'library');
    },

    // Executed by main.js's createDatabase so EVERY database (including one
    // freshly created at a custom storage path) carries the tables.
    DDL: `
        CREATE TABLE IF NOT EXISTS library_docs (
            id TEXT PRIMARY KEY,
            collection TEXT NOT NULL DEFAULT '',
            relpath TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            mtimeMs REAL NOT NULL,
            size INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            error TEXT,
            chunkCount INTEGER NOT NULL DEFAULT 0,
            updatedAt TEXT
        );
        CREATE TABLE IF NOT EXISTS library_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            docId TEXT NOT NULL,
            seq INTEGER NOT NULL,
            section TEXT NOT NULL DEFAULT '',
            text TEXT NOT NULL,
            -- NULL when the embedder wasn't available at index time: the doc
            -- is still searchable by keyword (honest degrade), and the next
            -- reindex fills the vectors in.
            vector BLOB
        );
        CREATE INDEX IF NOT EXISTS idx_library_chunks_doc ON library_chunks(docId);
        CREATE VIRTUAL TABLE IF NOT EXISTS library_fts USING fts5(text);
    `,

    init({ getDb, embed, extractPdf, broadcast }) {
        this._getDb = getDb;
        this.embed = embed;
        this.extractPdf = extractPdf;
        this.broadcast = broadcast || (() => {});
    },

    /**
     * Arm the store on launch: reconcile the index-identity stamp, resume a
     * leftover queue, and watch the folder — but ONLY when the library dir
     * already exists. A fresh install pays nothing and grows no folders
     * until the user actually opens the Library or imports something.
     */
    start() {
        if (!fs.existsSync(this.dir())) return;
        this._checkModelStamp();
        this._watch();
        this.scan();
    },

    // ─────────────────────── index identity (V2) ───────────────────────

    _modelStamp() {
        const s = this.embed && this.embed.spec;
        return s ? `${s.name}@${s.storeDims || s.dims}` : null;
    },

    _kvGet(key) {
        try {
            const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
            return row ? JSON.parse(row.value) : null;
        } catch { return null; }
    },

    _kvSet(key, value) {
        this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run(key, JSON.stringify(value));
    },

    // ─────────────────────── vector index (sqlite-vec) ───────────────────────

    /** Is sqlite-vec loaded on the CURRENT connection? (main.js reopens the
     *  DB on a storage-path change, so this is cached per handle.) */
    _vecOk() {
        const db = this.db;
        if (!db) return false;
        if (this._vecCache && this._vecCache.db === db) return this._vecCache.ok;
        let ok = false;
        try { db.prepare('SELECT vec_version()').get(); ok = true; } catch { /* extension absent */ }
        this._vecCache = { db, ok };
        return ok;
    },

    _hasVecTable() {
        try {
            return !!this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'library_vec'").get();
        } catch { return false; }
    },

    /**
     * Ensure library_vec exists at the current embedding width. A width
     * change (model swap, Matryoshka retune) drops and recreates — vec0
     * columns are fixed-width, and _syncVecIndex refills from the BLOBs.
     * Returns the width, 0 when the index can't exist here (no extension,
     * or no embed spec yet).
     */
    _ensureVecTable() {
        if (!this._vecOk()) return 0;
        const dims = (this.embed && this.embed.spec && (this.embed.spec.storeDims || this.embed.spec.dims)) || 0;
        if (!dims) return 0;
        const meta = this._kvGet('libraryVecMeta');
        if (meta && meta.dims !== dims && this._hasVecTable()) {
            this.db.exec('DROP TABLE library_vec');
        }
        if (!meta || meta.dims !== dims) {
            this._kvSet('libraryVecMeta', { dims, stampedAt: new Date().toISOString() });
        }
        // Unit vectors (the embedder re-normalizes after MRL truncation), so
        // default-L2 KNN ranks identically to cosine — no metric option needed.
        this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS library_vec USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${dims}])`);
        return dims;
    },

    /**
     * Reconcile the vec index with the canonical BLOBs: backfill vectors the
     * index is missing (first run after this upgrade, or a crash between the
     * chunk write and the index write) and drop orphans. Cheap when there is
     * nothing to do; runs from start() and scan(), never per-query.
     */
    _syncVecIndex() {
        try {
            const dims = this._ensureVecTable();
            if (!dims) return;
            const missing = this.db.prepare(
                'SELECT id, vector FROM library_chunks WHERE vector IS NOT NULL AND id NOT IN (SELECT chunk_id FROM library_vec)').all();
            const orphans = this.db.prepare(
                'SELECT chunk_id FROM library_vec WHERE chunk_id NOT IN (SELECT id FROM library_chunks WHERE vector IS NOT NULL)').all();
            if (!missing.length && !orphans.length) return;
            const ins = this.db.prepare('INSERT INTO library_vec (chunk_id, embedding) VALUES (?, ?)');
            const del = this.db.prepare('DELETE FROM library_vec WHERE chunk_id = ?');
            const tx = this.db.transaction(() => {
                for (const o of orphans) del.run(BigInt(o.chunk_id));
                for (const m of missing) {
                    // A BLOB at another width is a stale artifact; the model
                    // stamp owns that wipe — never index it into this space.
                    if (m.vector.byteLength !== dims * 4) continue;
                    ins.run(BigInt(m.id), m.vector);
                }
            });
            tx();
            if (missing.length) console.log(`[library] vector index backfilled ${missing.length} chunks`);
        } catch (e) {
            console.warn('[library] vector index sync failed (search falls back to scan):', e.message);
        }
    },

    /**
     * Vectors from different embedding models (or different Matryoshka
     * widths) live in different spaces — comparing them is silent garbage.
     * On a stamp mismatch the derived index is wiped and every doc goes
     * back to pending; originals are untouched (they're files, V1).
     */
    _checkModelStamp() {
        const want = this._modelStamp();
        if (!want) return false;
        const meta = this._kvGet('libraryIndexMeta');
        if (meta && meta.model === want) return false;
        const wipeVec = this._vecOk() && this._hasVecTable();
        const wipe = this.db.transaction(() => {
            this.db.prepare('DELETE FROM library_fts').run();
            this.db.prepare('DELETE FROM library_chunks').run();
            if (wipeVec) this.db.prepare('DELETE FROM library_vec').run();
            this.db.prepare("UPDATE library_docs SET status = 'pending', chunkCount = 0, error = NULL").run();
            this._kvSet('libraryIndexMeta', { model: want, stampedAt: new Date().toISOString() });
        });
        wipe();
        this._matrixCache = null;
        if (meta) console.log(`[library] Embedding model changed (${meta.model} -> ${want}) — index reset for rebuild`);
        return !!meta;
    },

    // ─────────────────────── scan + watch (V1) ───────────────────────

    _watch() {
        if (this._watcher) return;
        try {
            this._watcher = fs.watch(this.dir(), { recursive: true }, () => {
                if (this._scanTimer) clearTimeout(this._scanTimer);
                this._scanTimer = setTimeout(() => { this._scanTimer = null; this.scan(); }, 2000);
            });
        } catch (e) {
            console.warn('[library] watcher failed (scan-on-open still works):', e.message);
        }
    },

    _walk() {
        const root = this.dir();
        const files = [];
        const walk = (dir, depth) => {
            if (depth > 6) return;
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const d of entries) {
                if (d.name.startsWith('.')) continue;
                const abs = path.join(dir, d.name);
                if (d.isDirectory()) { walk(abs, depth + 1); continue; }
                const ext = path.extname(d.name).toLowerCase();
                if (!this.EXTS.has(ext)) continue;
                let st;
                try { st = fs.statSync(abs); } catch { continue; }
                const cap = this._byteCap(ext);
                if (st.size > cap) continue;
                const rel = path.relative(root, abs);
                files.push({ relpath: rel, mtimeMs: st.mtimeMs, size: st.size });
            }
        };
        walk(root, 0);
        return files;
    },

    /**
     * Diff the folder against library_docs: new/changed files queue for
     * indexing, vanished files drop out of the index (their originals are
     * gone by the user's own hand — V1 means the folder is the truth).
     */
    scan() {
        if (!this.db) return { queued: 0, removed: 0 };
        if (!fs.existsSync(this.dir())) return { queued: 0, removed: 0 };
        this._checkModelStamp();
        this._syncVecIndex();
        this._watch();
        const onDisk = this._walk();
        const byRel = new Map(onDisk.map(f => [f.relpath, f]));
        const known = this.db.prepare('SELECT id, relpath, mtimeMs, size, status FROM library_docs').all();
        const knownByRel = new Map(known.map(d => [d.relpath, d]));

        const toQueue = [];
        const now = new Date().toISOString();
        const upsert = this.db.prepare(`
            INSERT INTO library_docs (id, collection, relpath, title, mtimeMs, size, status, error, chunkCount, updatedAt)
            VALUES (@id, @collection, @relpath, @title, @mtimeMs, @size, 'pending', NULL, 0, @now)
            ON CONFLICT(relpath) DO UPDATE SET mtimeMs = @mtimeMs, size = @size, status = 'pending', error = NULL, updatedAt = @now`);
        let removed = 0;
        const tx = this.db.transaction(() => {
            for (const f of onDisk) {
                const prior = knownByRel.get(f.relpath);
                if (prior && prior.mtimeMs === f.mtimeMs && prior.size === f.size && prior.status !== 'pending') continue;
                const id = prior ? prior.id : 'doc_' + crypto.createHash('sha1').update(f.relpath).digest('hex').slice(0, 16);
                const parts = f.relpath.split(path.sep);
                upsert.run({
                    id,
                    collection: parts.length > 1 ? parts[0] : '',
                    relpath: f.relpath,
                    title: path.basename(f.relpath, path.extname(f.relpath)),
                    mtimeMs: f.mtimeMs,
                    size: f.size,
                    now
                });
                toQueue.push(id);
            }
            for (const d of known) {
                if (byRel.has(d.relpath)) continue;
                this._deleteDocTx(d.id);
                removed++;
            }
        });
        tx();
        if (toQueue.length || removed) this._matrixCache = null;
        if (toQueue.length) {
            const queue = this._kvGet('libraryQueue') || [];
            const merged = [...new Set([...queue, ...toQueue])];
            this._kvSet('libraryQueue', merged);
            this._drainSoon();
        }
        return { queued: toQueue.length, removed };
    },

    /**
     * In-app import = COPY into the folder, then the normal scan picks the
     * copies up. Never an index-in-place: V1 says the folder IS the corpus,
     * and a file indexed where it lies would be a second, invisible way in
     * that a Finder cleanup silently breaks. A dropped folder is copied
     * whole and becomes a collection (first-level folders already are).
     */
    /**
     * A safe collection folder name: no path separators or dot-prefixes
     * (a hidden folder would be skipped by the walker and the "collection"
     * would silently hold nothing). Collision gets the " 2" suffix via
     * _unusedName at creation.
     */
    sanitizeCollectionName(name) {
        return String(name || '').replace(/[/\\:]/g, '-').replace(/^\.+/, '').trim().slice(0, 80);
    },

    /** Create (or reuse) a collection folder; returns its final name. */
    createCollection(name) {
        const clean = this.sanitizeCollectionName(name);
        if (!clean) return { error: 'A collection needs a name.' };
        const root = this.dir();
        const dest = path.join(root, clean);
        if (fs.existsSync(dest)) return { collection: clean, existed: true };
        fs.mkdirSync(dest, { recursive: true });
        return { collection: clean };
    },

    importFiles(absPaths, { collection = '' } = {}) {
        // A named collection targets the copy into that folder — a voice's
        // "Add documents" lands in the voice's own corpus, not the root.
        const root = collection
            ? path.join(this.dir(), this.sanitizeCollectionName(collection))
            : this.dir();
        fs.mkdirSync(root, { recursive: true });
        let imported = 0, skipped = 0;
        const errors = [];
        const copied = [];   // absolute destinations, so the caller can tag what landed
        const okFile = (p, st) => {
            if (path.basename(p).startsWith('.')) return false;
            const ext = path.extname(p).toLowerCase();
            if (!this.EXTS.has(ext)) return false;
            return st.size <= this._byteCap(ext);
        };
        const libRoot = this.dir();
        for (const src of (absPaths || [])) {
            const abs = path.resolve(String(src || ''));
            // Already inside the library — there is nothing to import, and
            // copying the root into itself would recurse forever. Guarded
            // against the LIBRARY root, not the target collection: a file
            // already in the library must not be duplicated into a folder.
            if (abs === libRoot || abs.startsWith(libRoot + path.sep)) continue;
            let st;
            try { st = fs.statSync(abs); } catch { skipped++; continue; }
            try {
                if (st.isDirectory()) {
                    const dest = this._unusedName(path.join(root, path.basename(abs)));
                    fs.cpSync(abs, dest, {
                        recursive: true,
                        filter: (s) => {
                            let sst;
                            try { sst = fs.statSync(s); } catch { return false; }
                            if (sst.isDirectory()) return !path.basename(s).startsWith('.');
                            if (!okFile(s, sst)) { skipped++; return false; }
                            imported++;
                            copied.push(path.join(dest, path.relative(abs, s)));
                            return true;
                        }
                    });
                } else if (okFile(abs, st)) {
                    const dest = this._unusedName(path.join(root, path.basename(abs)));
                    fs.copyFileSync(abs, dest);
                    copied.push(dest);
                    imported++;
                } else {
                    skipped++;
                }
            } catch (e) { errors.push(e.message); }
        }
        const scanned = this.scan();
        // The scan registered the copies; hand back their index ids so the
        // Documents app can tag what just landed (drop onto a tag).
        const byRel = this.db ? this.db.prepare('SELECT id FROM library_docs WHERE relpath = ?') : null;
        const docs = [];
        for (const abs of copied) {
            const rel = path.relative(libRoot, abs);
            const row = byRel ? byRel.get(rel) : null;
            if (row) docs.push({ id: row.id, relpath: rel });
        }
        const out = { imported, skipped, queued: scanned.queued, docs };
        if (errors.length) out.error = errors[0];
        return out;
    },

    _byteCap(ext) {
        return (ext === '.pdf' || this.IMAGE_EXTS.has(ext)) ? this.MAX_PDF_BYTES : this.MAX_FILE_BYTES;
    },

    /** "essay.md" exists → "essay 2.md", "essay 3.md", … */
    _unusedName(dest) {
        if (!fs.existsSync(dest)) return dest;
        const dir = path.dirname(dest);
        const ext = path.extname(dest);
        const base = path.basename(dest, ext);
        for (let n = 2; ; n++) {
            const candidate = path.join(dir, `${base} ${n}${ext}`);
            if (!fs.existsSync(candidate)) return candidate;
        }
    },

    _deleteDocTx(docId) {
        this.tidyClear(docId);
        const rows = this.db.prepare('SELECT id FROM library_chunks WHERE docId = ?').all(docId);
        const delVec = this._vecOk() && this._hasVecTable();
        for (const r of rows) {
            this.db.prepare('DELETE FROM library_fts WHERE rowid = ?').run(r.id);
            if (delVec) this.db.prepare('DELETE FROM library_vec WHERE chunk_id = ?').run(BigInt(r.id));
        }
        this.db.prepare('DELETE FROM library_chunks WHERE docId = ?').run(docId);
        this.db.prepare('DELETE FROM library_docs WHERE id = ?').run(docId);
    },

    // ─────────────────────── chunker (pure, deterministic) ───────────────────────

    /**
     * Structure-aware chunking: markdown headings carve sections, blank
     * lines carve paragraphs, paragraphs pack greedily to CHUNK_TARGET;
     * an over-long paragraph splits on sentence boundaries; consecutive
     * chunks inside one section overlap by the tail of the previous chunk
     * (recall insurance at a boundary). Pure function of (text) — the det
     * journeys pin its determinism and its bounds.
     */
    chunkText(text) {
        const clean = String(text || '').replace(/\r\n/g, '\n').slice(0, this.MAX_DOC_CHARS);
        if (!clean.trim()) return [];
        const chunks = [];
        let section = '';
        let buf = '';
        let tail = '';

        const flush = () => {
            const t = buf.trim();
            if (t) chunks.push({ seq: chunks.length, section, text: t });
            tail = t ? t.slice(-this.CHUNK_OVERLAP) : '';
            buf = '';
        };
        const pushPara = (para) => {
            if (!para.trim()) return;
            if (buf && (buf.length + para.length + 2) > this.CHUNK_TARGET) {
                flush();
                if (tail) buf = tail + '\n';
            }
            if (para.length > this.CHUNK_MAX) {
                // Sentence-split an over-long paragraph; hard-cut a single
                // sentence that alone exceeds the max (rare; e.g. minified text).
                const sentences = para.match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g) || [para];
                let cur = buf;
                for (let s of sentences) {
                    while (s.length > this.CHUNK_MAX) {
                        buf = (cur + ' ' + s.slice(0, this.CHUNK_MAX)).trim();
                        flush(); cur = tail ? tail + '\n' : '';
                        s = s.slice(this.CHUNK_MAX);
                    }
                    if ((cur.length + s.length) > this.CHUNK_TARGET && cur.trim()) {
                        buf = cur; flush(); cur = tail ? tail + '\n' : '';
                    }
                    cur += s;
                }
                buf = cur;
                return;
            }
            buf += (buf ? '\n\n' : '') + para;
        };

        for (const rawLine of clean.split('\n')) {
            const heading = /^#{1,6}\s+(.+)$/.exec(rawLine.trim());
            if (heading) {
                flush();
                tail = ''; // no overlap across a section boundary
                section = heading[1].trim().slice(0, 120);
                continue;
            }
            buf += rawLine + '\n';
            // Paragraph boundary: repack via pushPara for size control.
            if (/\n\n$/.test(buf)) {
                const paras = buf.split(/\n{2,}/);
                buf = '';
                for (const p of paras) pushPara(p);
            }
        }
        const paras = buf.split(/\n{2,}/);
        buf = '';
        for (const p of paras) pushPara(p);
        flush();
        return chunks;
    },

    // ─────────────────────── extraction ───────────────────────

    async _extractText(absPath) {
        let st = null;
        try { st = fs.statSync(absPath); } catch { /* read below throws the real error */ }
        const key = st ? `${absPath}@${st.mtimeMs}:${st.size}` : null;
        if (key && this._textCache.has(key)) {
            const hit = this._textCache.get(key);
            this._textCache.delete(key); this._textCache.set(key, hit);   // LRU touch
            return hit;
        }
        const text = await this._extractTextUncached(absPath);
        if (key) {
            this._textCache.set(key, text);
            while (this._textCache.size > this.TEXT_CACHE_MAX) {
                this._textCache.delete(this._textCache.keys().next().value);
            }
        }
        return text;
    },

    async _extractTextUncached(absPath) {
        const ext = path.extname(absPath).toLowerCase();
        // A vision model's transcription of the pages outranks any parser.
        if (ext === '.pdf' || this.IMAGE_EXTS.has(ext)) {
            const vision = this._visionText(absPath);
            if (vision) return vision;
        }
        if (this.IMAGE_EXTS.has(ext)) {
            // A photo of a receipt, a scanned letter, a screenshot: the Mac's
            // own Vision OCR (local, no download). No text = not indexable.
            const { ocrFile } = require('./vision-ocr.js');
            const r = await ocrFile(absPath, 1);
            if (r.error) throw new Error(r.error);
            const text = (r.pages || []).join('\n').trim();
            if (!text) throw new Error('no readable text in the image');
            return text;
        }
        if (this.TEXTUTIL_EXTS.has(ext)) {
            // Legacy Word, RTF, OpenDocument, Safari web archives: macOS
            // textutil converts them to plain text without any dependency.
            return this._textutil(absPath);
        }
        const buf = fs.readFileSync(absPath);
        if (ext === '.pdf') {
            const r = await this.extractPdf(absPath, buf);
            if (r.error) throw new Error(r.error);
            return r.text;
        }
        if (ext === '.docx' || ext === '.xlsx' || ext === '.pptx') {
            const { extractXlsx, extractDocx, extractPptx } = require('./doc-extract.js');
            const r = ext === '.xlsx' ? extractXlsx(buf) : ext === '.pptx' ? extractPptx(buf) : extractDocx(buf);
            return r.text;
        }
        if (ext === '.html' || ext === '.htm') {
            return String(buf.toString('utf8'))
                .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                .replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li)[^>]*>/gi, '\n')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
                .replace(/[ \t]+/g, ' ');
        }
        if (buf.subarray(0, 8192).includes(0)) throw new Error('binary file');
        return buf.toString('utf8');
    },

    _textutil(absPath) {
        const { execFile } = require('child_process');
        return new Promise((resolve, reject) => {
            execFile('/usr/bin/textutil', ['-convert', 'txt', '-stdout', absPath],
                { timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
                    if (err) return reject(new Error(`textutil could not read this file: ${String(err.message || err).slice(0, 200)}`));
                    const text = String(stdout || '').trim();
                    if (!text) return reject(new Error('no readable text'));
                    resolve(text);
                });
        });
    },

    // ─────────────────────── ingest queue (V7) ───────────────────────

    _drainSoon() {
        if (this._draining) return;
        setTimeout(() => this.drain().catch(e => console.warn('[library] drain failed:', e.message)), 50);
    },

    async drain() {
        if (this._draining || !this.db) return;
        this._draining = true;
        try {
            for (;;) {
                const queue = this._kvGet('libraryQueue') || [];
                if (!queue.length) break;
                const docId = queue[0];
                const doc = this.db.prepare('SELECT * FROM library_docs WHERE id = ?').get(docId);
                if (doc) {
                    // eslint-disable-next-line no-await-in-loop
                    await this._indexDoc(doc);
                }
                // Re-read: scan may have appended while we worked. The item
                // leaves the queue only after its work settled (indexed or
                // errored) — a crash mid-doc re-runs that doc, never skips it.
                const after = (this._kvGet('libraryQueue') || []).filter(id => id !== docId);
                this._kvSet('libraryQueue', after);
                this.broadcast('library-progress', this.status());
            }
        } finally {
            this._draining = false;
            this.broadcast('library-progress', this.status());
        }
    },

    async _indexDoc(doc) {
        const abs = path.join(this.dir(), doc.relpath);
        const now = new Date().toISOString();
        try {
            if (!fs.existsSync(abs)) {
                const tx = this.db.transaction(() => this._deleteDocTx(doc.id));
                tx();
                this._matrixCache = null;
                return;
            }
            const text = await this._extractText(abs);
            const chunks = this.chunkText(text);
            if (!chunks.length) throw new Error('no readable text');
            // The mechanical contextual prefix (title › section) rides the
            // EMBEDDED text only; the stored chunk stays raw for display.
            const embedTexts = chunks.map(c =>
                `${doc.title}${c.section ? ' › ' + c.section : ''}\n${c.text}`);
            // No embedder (model not downloaded, engine missing) is a
            // DEGRADE, not a failure: the doc still indexes for keyword
            // search with NULL vectors; the embed-model download's reindex
            // fills them in later.
            let vectors = null;
            try {
                vectors = await this.embed.embed(embedTexts, 'document');
                if (vectors.length !== chunks.length) throw new Error('embedding count mismatch');
            } catch (e) {
                vectors = null;
                console.warn(`[library] indexing "${doc.relpath}" keyword-only (embedder unavailable): ${e.message}`);
            }
            // Table DDL stays outside the transaction; a vec width of 0
            // (no extension / no spec) simply skips the index writes.
            const vecDims = vectors ? this._ensureVecTable() : 0;
            const tx = this.db.transaction(() => {
                const old = this.db.prepare('SELECT id FROM library_chunks WHERE docId = ?').all(doc.id);
                const delVec = this._vecOk() && this._hasVecTable();
                for (const r of old) {
                    this.db.prepare('DELETE FROM library_fts WHERE rowid = ?').run(r.id);
                    if (delVec) this.db.prepare('DELETE FROM library_vec WHERE chunk_id = ?').run(BigInt(r.id));
                }
                this.db.prepare('DELETE FROM library_chunks WHERE docId = ?').run(doc.id);
                const ins = this.db.prepare('INSERT INTO library_chunks (docId, seq, section, text, vector) VALUES (?, ?, ?, ?, ?)');
                const insFts = this.db.prepare('INSERT INTO library_fts (rowid, text) VALUES (?, ?)');
                const insVec = vecDims ? this.db.prepare('INSERT INTO library_vec (chunk_id, embedding) VALUES (?, ?)') : null;
                chunks.forEach((c, i) => {
                    const vec = vectors ? Buffer.from(vectors[i].buffer, vectors[i].byteOffset, vectors[i].byteLength) : null;
                    const info = ins.run(doc.id, c.seq, c.section, c.text, vec);
                    insFts.run(info.lastInsertRowid, c.text);
                    if (insVec && vec && vec.byteLength === vecDims * 4) {
                        insVec.run(BigInt(info.lastInsertRowid), vec);
                    }
                });
                this.db.prepare("UPDATE library_docs SET status = 'indexed', error = NULL, chunkCount = ?, updatedAt = ? WHERE id = ?")
                    .run(chunks.length, now, doc.id);
            });
            tx();
            this._matrixCache = null;
        } catch (e) {
            this.db.prepare("UPDATE library_docs SET status = 'error', error = ?, updatedAt = ? WHERE id = ?")
                .run(String(e.message || e).slice(0, 300), now, doc.id);
        }
    },

    // ─────────────────────── search (V5: pure arithmetic) ───────────────────────

    _matrix() {
        if (this._matrixCache) return this._matrixCache;
        const dims = (this.embed.spec && (this.embed.spec.storeDims || this.embed.spec.dims)) || 0;
        const rows = this.db.prepare('SELECT id, vector FROM library_chunks WHERE vector IS NOT NULL ORDER BY id').all();
        const data = new Float32Array(rows.length * dims);
        const ids = new Array(rows.length);
        rows.forEach((r, i) => {
            ids[i] = r.id;
            const v = new Float32Array(r.vector.buffer, r.vector.byteOffset, dims);
            data.set(v, i * dims);
        });
        this._matrixCache = { ids, dims, data };
        return this._matrixCache;
    },

    /**
     * KNN through the vec0 index when it's live; the exhaustive scan over
     * the canonical BLOBs otherwise. Both rank by cosine (unit vectors), so
     * the two paths return the same ordering — the index is a speedup,
     * never a behavior change.
     */
    _vectorRank(qvec, limit) {
        if (this._vecOk() && this._hasVecTable()) {
            try {
                const rows = this.db.prepare(
                    'SELECT chunk_id FROM library_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance')
                    .all(Buffer.from(qvec.buffer, qvec.byteOffset, qvec.byteLength), limit);
                return rows.map(r => Number(r.chunk_id));
            } catch (e) {
                console.warn('[library] vec KNN failed — falling back to the linear scan:', e.message);
            }
        }
        return this._vectorScanRank(qvec, limit);
    },

    _vectorScanRank(qvec, limit) {
        const { ids, dims, data } = this._matrix();
        const scored = [];
        for (let i = 0; i < ids.length; i++) {
            let dot = 0;
            const off = i * dims;
            for (let j = 0; j < dims; j++) dot += qvec[j] * data[off + j];
            scored.push([ids[i], dot]);
        }
        scored.sort((a, b) => b[1] - a[1]);
        return scored.slice(0, limit).map(s => s[0]);
    },

    _ftsRank(query, limit) {
        const tokens = String(query || '').split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 1).slice(0, 12);
        if (!tokens.length) return [];
        const match = tokens.map(t => `"${t}"`).join(' OR ');
        try {
            return this.db.prepare('SELECT rowid FROM library_fts WHERE library_fts MATCH ? ORDER BY bm25(library_fts) LIMIT ?')
                .all(match, limit).map(r => r.rowid);
        } catch { return []; }
    },

    /**
     * Reciprocal-rank fusion of the two ranked lists (rank-only — BM25 and
     * cosine scores are not calibratable against each other; ranks are).
     */
    _rrf(lists) {
        const score = new Map();
        for (const list of lists) {
            list.forEach((id, rank) => {
                score.set(id, (score.get(id) || 0) + 1 / (this.RRF_K + rank + 1));
            });
        }
        return [...score.entries()].sort((a, b) => b[1] - a[1]);
    },

    async search(query, { k = 8, collection } = {}) {
        if (!this.db) return { results: [] };
        const q = String(query || '').trim();
        if (!q) return { results: [] };
        const count = this.db.prepare('SELECT COUNT(*) c FROM library_chunks').get().c;
        if (!count) return { results: [], empty: true };

        // A collection-scoped search (a voice's grounding) filters AFTER
        // fusion, so a small collection inside a large corpus needs a deeper
        // candidate pool — 50 global candidates can all belong to other
        // collections and starve the scope to zero results.
        const cand = collection ? this.CANDIDATES * 4 : this.CANDIDATES;
        let vecRank = [];
        // Skip the vector leg entirely when the embedder isn't installed —
        // an attempt would pay a doomed spawn on every keystroke. Honest
        // degrade to keyword-only either way.
        if (this.embed && this.embed.isInstalled && this.embed.isInstalled()) {
            try {
                const [qvec] = await this.embed.embed([q], 'query');
                vecRank = this._vectorRank(qvec, cand);
            } catch (e) {
                console.warn('[library] vector search unavailable:', e.message);
            }
        }
        const ftsRank = this._ftsRank(q, cand);
        const fused = this._rrf([vecRank, ftsRank].filter(l => l.length));

        const getChunk = this.db.prepare(`
            SELECT c.id, c.docId, c.section, c.text, d.title, d.collection, d.relpath
            FROM library_chunks c JOIN library_docs d ON d.id = c.docId WHERE c.id = ?`);
        const results = [];
        for (const [id, score] of fused) {
            const row = getChunk.get(id);
            if (!row) continue;
            if (collection && row.collection !== collection) continue;
            results.push({
                docId: row.docId,
                title: row.title,
                collection: row.collection,
                relpath: row.relpath,
                section: row.section,
                text: row.text,
                score: Math.round(score * 10000) / 10000
            });
            if (results.length >= k) break;
        }
        return { results, keywordOnly: !vecRank.length };
    },

    // ─────────────────────── surface helpers ───────────────────────

    /** Full text of one doc (re-extracted from the original, cheap for text;
     *  cached-by-mtime upstream for pdf via the doc cache in main). */
    /** Absolute path of a doc's original file, or null. */
    docAbsPath(docId) {
        if (!this.db || !docId) return null;
        const doc = this.db.prepare('SELECT relpath FROM library_docs WHERE id = ?').get(String(docId));
        if (!doc) return null;
        const abs = path.join(this.dir(), doc.relpath);
        return fs.existsSync(abs) ? abs : null;
    },

    async readDoc(docId, { offset = 0, cap = 6000 } = {}) {
        const doc = this.db.prepare('SELECT * FROM library_docs WHERE id = ?').get(docId);
        if (!doc) return { error: 'no such document' };
        const abs = path.join(this.dir(), doc.relpath);
        if (!fs.existsSync(abs)) return { error: 'original file is gone' };
        try {
            const text = await this._extractText(abs);
            const start = Math.max(0, offset);
            const slice = text.slice(start, start + cap);
            return {
                docId, title: doc.title, collection: doc.collection, relpath: doc.relpath,
                text: slice, offset: start, totalChars: text.length,
                truncated: start + slice.length < text.length
            };
        } catch (e) {
            return { error: e.message };
        }
    },

    // ─────────────────────── tidy cache (display only) ───────────────────────
    //
    // The reader's AI-tidied rendering of a document (docs/LIBRARY.md "Tidy
    // with AI"). Generated ONCE and saved: a document that has not changed
    // is never tidied again. Two copies, both keyed by the file's CONTENT
    // HASH (a touched mtime or a copy to another Mac does not invalidate;
    // an edited file does):
    //   - kv `libraryTidy:<docId>` in the index DB — the fast path;
    //   - a Markdown SIDECAR at <library>/.anjadhe/tidy/<relpath>.md with a
    //     small frontmatter — the durable copy. It is a file the user owns
    //     (V1), survives a rebuilt or relocated index, and travels with the
    //     folder (iCloud/Dropbox) so a second Mac reads it instead of paying
    //     the model again. The dot-folder is skipped by the walker, so it is
    //     never indexed as a document.
    // A TEXT tidy is display only — the index and the assistant's
    // read_library_doc keep the raw extraction (facts, not a rewrite). A
    // VISION transcription (method 'vision': a vision-capable brain read
    // the rendered pages) is better than pdf.js's text layer or OCR at
    // every use, so it BECOMES the document's text: _extractText prefers a
    // hash-matched vision sidecar, and tidySet re-queues the document so
    // the index is rebuilt from it (V2: derived, rebuildable).

    TIDY_DIR: '.anjadhe/tidy',

    _tidySidecar(relpath) {
        return path.join(this.dir(), ...this.TIDY_DIR.split('/'), relpath + '.md');
    },

    _fileHash(abs) {
        try { return crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex'); }
        catch { return null; }
    },

    _tidyDoc(docId) {
        if (!this.db || !docId) return null;
        const doc = this.db.prepare('SELECT relpath FROM library_docs WHERE id = ?').get(String(docId));
        if (!doc) return null;
        const abs = path.join(this.dir(), doc.relpath);
        if (!fs.existsSync(abs)) return null;
        return { relpath: doc.relpath, abs, hash: this._fileHash(abs) };
    },

    _parseSidecar(raw) {
        const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
        if (!m) return null;
        const meta = {};
        for (const line of m[1].split('\n')) {
            const i = line.indexOf(':');
            if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        }
        return { meta, text: raw.slice(m[0].length) };
    },

    tidyGet(docId) {
        const d = this._tidyDoc(docId);
        if (!d || !d.hash) return null;
        const rec = this._kvGet(`libraryTidy:${docId}`);
        if (rec && rec.hash === d.hash && typeof rec.text === 'string') {
            return { text: rec.text, coveredChars: rec.coveredChars || 0, model: rec.model || null, tidiedAt: rec.tidiedAt || null,
                     method: rec.method || 'text', pages: rec.pages || 0, pagesDone: rec.pagesDone || 0 };
        }
        // The durable copy: another Mac's tidy, or this one's after a rebuilt DB.
        const side = this._tidySidecar(d.relpath);
        if (fs.existsSync(side)) {
            let parsed = null;
            try { parsed = this._parseSidecar(fs.readFileSync(side, 'utf8')); } catch { parsed = null; }
            if (parsed && parsed.meta.hash === d.hash && parsed.text.trim()) {
                const out = {
                    text: parsed.text,
                    coveredChars: parseInt(parsed.meta.coveredChars, 10) || 0,
                    model: parsed.meta.model || null,
                    tidiedAt: parsed.meta.tidiedAt || null,
                    method: parsed.meta.method === 'vision' ? 'vision' : 'text',
                    pages: parseInt(parsed.meta.pages, 10) || 0,
                    pagesDone: parseInt(parsed.meta.pagesDone, 10) || 0
                };
                this._kvSet(`libraryTidy:${docId}`, { hash: d.hash, ...out });   // re-seed the fast path
                return out;
            }
        }
        return null;
    },

    tidySet(docId, { text, coveredChars, model, method, pages, pagesDone } = {}) {
        const d = this._tidyDoc(docId);
        if (!d || !d.hash) return { error: 'no such document' };
        const rec = {
            hash: d.hash,
            text: String(text || '').slice(0, this.MAX_DOC_CHARS),
            coveredChars: Math.max(0, parseInt(coveredChars, 10) || 0),
            model: model ? String(model).slice(0, 120) : null,
            method: method === 'vision' ? 'vision' : 'text',
            pages: Math.max(0, parseInt(pages, 10) || 0),
            pagesDone: Math.max(0, parseInt(pagesDone, 10) || 0),
            tidiedAt: new Date().toISOString()
        };
        this._kvSet(`libraryTidy:${docId}`, rec);
        try {
            const side = this._tidySidecar(d.relpath);
            fs.mkdirSync(path.dirname(side), { recursive: true });
            const front = [
                '---',
                `source: ${d.relpath}`,
                `hash: ${rec.hash}`,
                `coveredChars: ${rec.coveredChars}`,
                `model: ${rec.model || ''}`,
                `method: ${rec.method}`,
                `pages: ${rec.pages}`,
                `pagesDone: ${rec.pagesDone}`,
                `tidiedAt: ${rec.tidiedAt}`,
                rec.method === 'vision'
                    ? 'generated: Anjadhe transcribed the page images of the source file above with a vision model; the source is the document.'
                    : 'generated: Anjadhe tidied this from the source file above for reading; the source is the document.',
                '---',
                ''
            ].join('\n');
            fs.writeFileSync(side, front + rec.text);
        } catch (e) {
            console.warn('[library] tidy sidecar not written (kv copy kept):', e.message);
        }
        // A vision transcription is the document's text from now on: drop
        // the extraction cache and rebuild this document's index from it.
        if (rec.method === 'vision') {
            this._textCache.clear();
            try {
                const queue = this._kvGet('libraryQueue') || [];
                this.db.prepare("UPDATE library_docs SET status = 'pending' WHERE id = ?").run(String(docId));
                this._kvSet('libraryQueue', [...new Set([...queue, String(docId)])]);
                this._drainSoon();
            } catch (e) { console.warn('[library] vision re-queue failed:', e.message); }
        }
        return { success: true };
    },

    /** A hash-matched VISION transcription for this file, or null. */
    _visionText(absPath) {
        const rel = path.relative(this.dir(), absPath);
        if (!rel || rel.startsWith('..')) return null;
        const side = this._tidySidecar(rel);
        if (!fs.existsSync(side)) return null;
        let parsed = null;
        try { parsed = this._parseSidecar(fs.readFileSync(side, 'utf8')); } catch { return null; }
        if (!parsed || parsed.meta.method !== 'vision' || !parsed.text.trim()) return null;
        if (parsed.meta.hash !== this._fileHash(absPath)) return null;
        return parsed.text;
    },

    tidyClear(docId) {
        if (!this.db || !docId) return;
        let relpath = null;
        try { relpath = this.db.prepare('SELECT relpath FROM library_docs WHERE id = ?').get(String(docId))?.relpath || null; } catch { /* best effort */ }
        try { this.db.prepare('DELETE FROM kv WHERE key = ?').run(`libraryTidy:${docId}`); } catch { /* best effort */ }
        if (relpath) { try { fs.rmSync(this._tidySidecar(relpath), { force: true }); } catch { /* best effort */ } }
    },

    list() {
        if (!this.db) return { collections: [], docs: [] };
        const docs = this.db.prepare('SELECT id, collection, relpath, title, status, error, chunkCount, size, updatedAt FROM library_docs ORDER BY collection, title').all();
        const collections = [...new Set(docs.map(d => d.collection))].sort();
        return { dir: this.dir(), collections, docs };
    },

    status() {
        if (!this.db) return { docs: 0, indexed: 0, errors: 0, queued: 0, indexing: false };
        // "indexed" bare is a syntax error as a column alias — INDEXED is a
        // reserved word in SQLite (INDEXED BY); quote it.
        const agg = this.db.prepare(`
            SELECT COUNT(*) docs,
                   SUM(CASE WHEN status = 'indexed' THEN 1 ELSE 0 END) "indexed",
                   SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) errors
            FROM library_docs`).get();
        const queue = this._kvGet('libraryQueue') || [];
        return {
            dir: this.dir(),
            docs: agg.docs || 0,
            indexed: agg.indexed || 0,
            errors: agg.errors || 0,
            queued: queue.length,
            indexing: this._draining,
            chunks: this.db.prepare('SELECT COUNT(*) c FROM library_chunks').get().c,
            indexModel: (this._kvGet('libraryIndexMeta') || {}).model || null,
            // 'vec' = sqlite-vec KNN index live; 'scan' = extension present
            // but index not built yet; 'linear' = no extension, brute force.
            vectorIndex: this._vecOk() ? (this._hasVecTable() ? 'vec' : 'scan') : 'linear'
        };
    },

    /** Manual full rebuild: wipe derived data, keep originals, re-queue all. */
    reindex() {
        this._textCache.clear();
        const wipeVec = this._vecOk() && this._hasVecTable();
        const tx = this.db.transaction(() => {
            this.db.prepare('DELETE FROM library_fts').run();
            this.db.prepare('DELETE FROM library_chunks').run();
            if (wipeVec) this.db.prepare('DELETE FROM library_vec').run();
            this.db.prepare("UPDATE library_docs SET status = 'pending', chunkCount = 0, error = NULL").run();
            const stamp = this._modelStamp();
            if (stamp) this._kvSet('libraryIndexMeta', { model: stamp, stampedAt: new Date().toISOString() });
        });
        tx();
        this._matrixCache = null;
        const all = this.db.prepare('SELECT id FROM library_docs').all().map(d => d.id);
        this._kvSet('libraryQueue', all);
        this._drainSoon();
        return { queued: all.length };
    }
};

module.exports = LibraryStore;
