/**
 * Documents — one list of everything the person has in writing
 * (2026-10-07, Ram: "we need to figure out an experience for text documents
 * and documents library… it could be confusing for the users"; "i agree with
 * the merge").
 *
 * Two things were both called Documents: Text Documents (the `notes` app —
 * what nenva writes for the person, and anything they wrote) and the
 * Documents library (the `reader` app — files they gave it: PDFs, scans,
 * spreadsheets, Word). Two folders, two tag systems, two search boxes, two
 * readers, and to a person none of that distinction exists: in Finder or
 * Drive everything is just "my documents". The only difference they feel is
 * whether a thing can be edited here (something written) or is a file they
 * keep (a PDF) — and that needs one list, not two apps.
 *
 * So this page is ONE LIST OVER TWO STORES, in the calm language of
 * Insights and Chats (docs/SIMPLE_EXPERIENCE.md): the shell's serif title, a
 * lede joined from counts, one search box over both, the kinds as a row of
 * words (All · Written · Files), tags as a quiet row of words behind them,
 * groups as uppercase eyebrows over white panels (Today · This week ·
 * Earlier), rows with the title at 500 and one quiet line. A row opens the
 * document ON THIS PAGE (Ram, same day: navigation "still treating them as
 * separate features"): the list gives way to the document and "‹ Documents"
 * is the way back, whether it is something written or a file. The surfaces
 * are the ones that exist — the `notes` editor element is adopted into this
 * page's detail host (as NotesApp adopts it into its own pane) and loaded by
 * `NotesApp._loadNoteIntoPane`; a file is drawn by this page's own
 * `DocReader` instance — never a copy of either. The old `notes` and
 * `reader` views are reached by nothing a person taps.
 *
 * Laws:
 *   D1  Nothing about either store changes: the `notes` blob and its
 *       Markdown projection, the library folder, its index and its tags
 *       are exactly what they were. The page reads them, and adds to the
 *       library only through the doors that already existed (2026-10-08,
 *       Ram: "We should be able import files"; the merge had left no way
 *       in but Finder): "Add files" is main's picker and a drop is
 *       `importPaths`, both COPYING into the folder (library V1), and while
 *       a tag is chosen what lands wears it (`DocTags.add`), as the
 *       Reader's drop on a tag did.
 *   D2  Every value is a stored field (title, dates, kind from the file's
 *       extension, tags); nothing is model-written here.
 *   D3  The Files SOURCE stays under Settings › Connectors (the folder, the
 *       index, the semantic model): a thing the person has is a source
 *       there, and one Documents here.
 *
 * Pure parts (rows, groups, lede, search) are Node-testable
 * (tests/documents-page-test.js).
 */
const DocumentsPage = {
    APP: 'documents',
    LABEL: 'Documents',
    _kind: 'all',        // all | written | files
    _tag: null,          // one tag, or null
    _query: '',
    _mounted: false,
    _listing: null,      // the library listing, cached by ReaderApp.cacheListing
    _doc: null,          // the open document: { kind: 'note' | 'file', id } or null
    _reader: null,       // this page's DocReader instance (files)

    esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },

    // ── Pure ────────────────────────────────────────────────────────────

    /**
     * The rows: written documents from the notes blob and files from the
     * library listing. Every note is a document (a routine and its results
     * left the notes blob for the routine's Standing chat on 2026-10-07);
     * a tombstone is not. `written: true` marks a note; `byNenva` a note
     * nenva wrote.
     */
    rows({ notes = [], docs = [], docTags = new Map(), kindOf = null, byNenva = null } = {}) {
        const out = [];
        for (const n of notes) {
            if (!n || n.deletedAt) continue;
            out.push({ id: `note:${n.id}`, key: 'note', ref: n.id, written: true, byNenva: !!(byNenva && byNenva(n)),
                title: String(n.title || '').trim() || 'Untitled', at: Date.parse(n.modifiedAt || n.updatedAt || n.createdAt || 0) || 0,
                tags: Array.isArray(n.tags) ? n.tags.map(t => String(t || '').trim()).filter(Boolean) : [], kind: 'written' });
        }
        for (const d of docs) {
            if (!d || !d.id) continue;
            const k = kindOf ? kindOf(d.relpath) : { key: 'other', label: 'File' };
            out.push({ id: `doc:${d.id}`, key: 'document', ref: d.id, written: false,
                title: String(d.title || d.relpath || '').trim() || 'Untitled', at: Date.parse(d.updatedAt || 0) || 0,
                tags: (docTags.get(d.id) || []).slice(), kind: 'files', fileKind: k.label || 'File', status: d.status || '', pages: d.pages || null });
        }
        return out.sort((a, b) => b.at - a.at);
    },
    /** The lede, joined from counts. */
    ledeText(rows) {
        if (!rows.length) return '';
        const w = rows.filter(r => r.written).length, f = rows.length - w;
        const bits = [];
        if (w) bits.push(`${w} written`);
        if (f) bits.push(`${f} file${f === 1 ? '' : 's'}`);
        return bits.join(' · ');
    },
    /**
     * The tags as one row of words: the first segment of a path tag, each
     * with its count, most used first. The two stores spell tags differently
     * (the notes lowercase, the library capitalised): one word per tag,
     * case-insensitively, shown the way it was written most often.
     */
    tagRow(rows) {
        const counts = new Map();   // lowercase -> { n, spellings: Map }
        for (const r of rows) for (const t of r.tags) {
            const root = String(t).split('/')[0].trim(); if (!root) continue;
            const k = root.toLowerCase();
            const e = counts.get(k) || { n: 0, spellings: new Map() };
            e.n++; e.spellings.set(root, (e.spellings.get(root) || 0) + 1); counts.set(k, e);
        }
        return [...counts.values()].map(e => ({ tag: [...e.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0], n: e.n }))
            .sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag));
    },
    hasTag(r, tag) { return r.tags.some(t => String(t).split('/')[0].trim().toLowerCase() === String(tag).toLowerCase()); },
    /** Search: every word of the query somewhere in the title or the tags. */
    matches(r, query) {
        const q = String(query || '').trim().toLowerCase();
        if (!q) return true;
        const hay = `${r.title} ${r.tags.join(' ')} ${r.fileKind || ''}`.toLowerCase();
        return q.split(/\s+/).every(w => hay.includes(w));
    },
    /** Groups by recency: Today · This week · Earlier, in that order, empty ones dropped. */
    groups(rows, now = new Date()) {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const week = start - 6 * 86400000;
        const g = { today: [], week: [], earlier: [] };
        for (const r of rows) (r.at >= start ? g.today : r.at >= week ? g.week : g.earlier).push(r);
        return [['Today', g.today], ['This week', g.week], ['Earlier', g.earlier]].filter(([, list]) => list.length);
    },
    /** "Oct 6", or the time today; the year only when it is not this one. */
    when(at, now = new Date()) {
        if (!at) return '';
        const d = new Date(at);
        if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
    },
    /** The row's quiet line: who wrote it or what kind of file, its tags, when. */
    subline(r, now = new Date()) {
        const bits = [];
        if (r.written) bits.push(r.byNenva ? 'Written by nenva' : 'Written by you');
        else bits.push(r.fileKind + (r.status === 'error' ? ' · could not be read' : r.status && r.status !== 'indexed' ? ' · being read' : ''));
        if (r.tags.length) bits.push(r.tags.slice(0, 3).map(t => String(t).split('/').join(' › ')).join(', '));
        const w = this.when(r.at, now); if (w) bits.push(w);
        return bits.join(' · ');
    },

    // ── The page ────────────────────────────────────────────────────────

    mount() {
        if (this._mounted || typeof document === 'undefined') return;
        this._mounted = true;
        const page = document.createElement('main');
        page.id = `${this.APP}-view`;
        page.className = 'view app-view dp-page';
        page.setAttribute('aria-labelledby', 'dp-title');
        page.innerHTML = `<div class="dp-column">
            <button type="button" class="back-link dp-back" data-dp-back hidden>‹ ${this.LABEL}</button>
            <header class="dp-head"><div class="dp-head-row"><h1 class="dp-h1" id="dp-title">${this.LABEL}</h1><span class="dp-doors"><button type="button" class="cm-link dp-new" data-dp-new>New document</button>${typeof window !== 'undefined' && window.electronLibrary ? '<button type="button" class="cm-link dp-add" data-dp-add>Add files</button>' : ''}</span></div><p class="dp-lede" id="dp-lede" hidden></p></header>
            <input type="search" class="dp-search" placeholder="Search…" autocomplete="off" aria-label="Search documents">
            <div class="dp-body"></div>
            <div class="dp-detail" hidden></div></div>`;
        (document.getElementById('app-views') || document.body).append(page);
        page.addEventListener('click', e => this.onClick(e));
        // The canvas's way back (the notes view's empty state and crumb) lands here.
        document.addEventListener('click', e => { if (e.target.closest('[data-notes-back]')) this.open(); });
        page.querySelector('.dp-search').addEventListener('input', e => { this._query = e.target.value; this.renderBody(); });
        this._wireDrop(page);
        // A file being read turns "being read" into its kind while the page is open.
        try { window.electronLibrary?.onProgress?.(() => { if (AppManager.currentApp === this.APP && !this._doc) this.render(); }); } catch { /* the list still renders */ }
        if (typeof AppManager !== 'undefined') AppManager.register(this.APP, { init: () => this.init(), render: () => this.render() });
    },
    // ── Adding files (D1: copies into the library, through main) ────────

    /** The toast after an import: what landed, where, what was skipped. Pure. */
    importMessage(res, tag = '', tagged = 0) {
        if (!res || res.canceled) return null;
        if (res.error) return { text: String(res.error), type: 'error' };
        const bits = [];
        if (res.imported) bits.push(`Added ${res.imported} file${res.imported === 1 ? '' : 's'}${tagged ? ` to ${tag}` : ''}`);
        if (res.skipped) bits.push(`${res.skipped} skipped (a kind of file nenva can't read)`);
        return bits.length ? { text: bits.join(' · '), type: res.imported ? 'success' : 'info' } : null;
    },
    async addFiles() {
        let res;
        try { res = await window.electronLibrary.importFiles(); } catch { return; }
        this._landed(res);
    },
    _wireDrop(page) {
        const files = e => !this._doc && Array.from(e.dataTransfer?.types || []).includes('Files');
        page.addEventListener('dragover', e => { if (!files(e)) return; e.preventDefault(); page.classList.add('is-dragover'); });
        page.addEventListener('dragleave', e => { if (!page.contains(e.relatedTarget)) page.classList.remove('is-dragover'); });
        page.addEventListener('drop', async e => {
            page.classList.remove('is-dragover');
            if (!files(e)) return;
            e.preventDefault();
            const paths = Array.from(e.dataTransfer.files || [])
                .map(f => { try { return window.electronLibrary.pathForFile(f); } catch { return null; } })
                .filter(Boolean);
            if (!paths.length) return;
            let res;
            try { res = await window.electronLibrary.importPaths(paths); } catch { return; }
            this._landed(res);
        });
    },
    /** Tag what landed with the chosen tag, say so, and show it in the list. */
    _landed(res) {
        const tag = this._tag || '';
        let tagged = 0;
        if (tag && res && !res.error && typeof DocTags !== 'undefined') {
            for (const d of (res.docs || [])) { if (DocTags.add(d.id, tag, d.relpath)) tagged++; }
        }
        const msg = this.importMessage(res, tag, tagged);
        if (msg && typeof UIUtils !== 'undefined') UIUtils.showToast(msg.text, msg.type);
        if (res && res.imported) this.render();
    },

    /** The reader for a file, drawn into this page's detail host (DocReader.create's host contract, as ReaderApp does). */
    _fileReader() {
        if (this._reader || typeof DocReader === 'undefined') return this._reader;
        this._reader = DocReader.create({
            render: () => this.renderDetail(),
            body: () => document.querySelector(`#${this.APP}-view .dp-detail .dp-file`),
            onExit: () => this.closeDocument(),
            onDeleted: () => { this.closeDocument(); this.render(); },
            onTagsChanged: () => {},
            onTagClick: (tag) => { this.closeDocument(); this._tag = String(tag).split('/')[0]; this.renderBody(); },
            tagPrefix: () => '',
            docMeta: (id) => ((this._listing && this._listing.docs) || []).find(d => d.id === id) || null
        });
        return this._reader;
    },
    /**
     * Open one document on this page. `kind` is 'note' (something written;
     * `id` null with `opts.template` starts a new one) or 'file'.
     */
    showDocument(kind, id, opts = {}) {
        this.mount();
        if (!this._mounted) return false;
        if (this._doc && this._doc.kind === 'note' && typeof NotesApp !== 'undefined') { try { NotesApp.flushSave?.(); } catch { /* nothing to flush */ } }
        this._doc = { kind, id: id || null, opts };
        if (AppManager.currentApp !== this.APP) AppManager.openAppFromLauncher(this.APP);
        else this.render();
        return true;
    },
    /** Back to the list: the written document is flushed and its session ended; a file's reader is closed. */
    closeDocument() {
        if (!this._doc) return;
        const was = this._doc; this._doc = null;
        if (was.kind === 'note' && typeof NotesApp !== 'undefined') {
            try { NotesApp.flushSave?.(); NotesApp._teardownEditorSession?.(); } catch { /* the session may be gone */ }
            const host = document.getElementById('note-editor-view'); if (host) host.hidden = true;
        }
        if (was.kind === 'file' && this._reader) { this._reader.docId = null; this._reader.doc = null; }
        this.renderDetail();
        this.renderBody();
    },
    /** Draw the open document into the detail host. */
    renderDetail() {
        const view = document.getElementById(`${this.APP}-view`);
        const detail = view && view.querySelector('.dp-detail');
        if (!detail) return;
        const open = !!this._doc;
        view.classList.toggle('is-doc', open);
        view.querySelector('.dp-back').hidden = !open;
        detail.hidden = !open;
        if (!open) return;
        if (this._doc.kind === 'note' && typeof NotesApp !== 'undefined') {
            // The canvas: NotesApp's editor element, adopted here (one element, moved, never copied).
            if (!NotesApp.notes || !NotesApp.notes.length) { try { NotesApp.init(); } catch { /* best effort */ } }
            const host = document.getElementById('note-editor-view');
            if (!host) return;
            const wrap = detail.querySelector('.dp-file'); if (wrap) wrap.hidden = true;
            if (host.parentElement !== detail) detail.append(host);
            host.hidden = false;
            if (!this._doc.loaded) {
                this._doc.loaded = true;
                NotesApp._loadNoteIntoPane(this._doc.id, { ...(this._doc.opts || {}) });
            }
            return;
        }
        if (this._doc.kind === 'file') {
            const r = this._fileReader(); if (!r) return;
            const host = document.getElementById('note-editor-view'); if (host && host.parentElement === detail) host.hidden = true;
            let wrap = detail.querySelector('.dp-file');
            if (!wrap) { wrap = document.createElement('div'); wrap.className = 'dp-file'; detail.append(wrap); }
            wrap.hidden = false;
            if (r.docId !== this._doc.id) { r.open(this._doc.id, { backLabel: this.LABEL }); return; }   // open() draws through host.render
            wrap.innerHTML = r.html();
            r.bind(wrap);
        }
    },
    open() {
        this.mount();
        if (!this._mounted) return;
        if (AppManager.currentApp !== this.APP) AppManager.openAppFromLauncher(this.APP);
        else this.render();
    },
    init() {
        // Every open starts unsearched; the kind and tag are kept (a moment's filter).
        this._query = '';
        const s = document.querySelector(`#${this.APP}-view .dp-search`);
        if (s) s.value = '';
    },
    async render() {
        if (!this._mounted) return;
        this.renderDetail();
        // The library listing is one cheap IPC; ReaderApp keeps it cached for ⌘K.
        try {
            if (typeof ReaderApp !== 'undefined' && ReaderApp.cacheListing) this._listing = await ReaderApp.cacheListing();
            else if (window.electronLibrary && window.electronLibrary.list) this._listing = await window.electronLibrary.list();
        } catch { /* the notes alone */ }
        if (AppManager.currentApp !== this.APP) return;
        this.renderBody();
        this.renderDetail();
    },
    _allRows() {
        let notes = [];
        try { notes = (StorageManager.get('notes') || {}).notes || []; } catch { notes = []; }
        const docs = (this._listing && this._listing.docs) || [];
        const docTags = typeof DocTags !== 'undefined' && DocTags.all ? DocTags.all() : new Map();
        const kindOf = typeof DocReader !== 'undefined' && DocReader.kindOf ? (p => DocReader.kindOf(p)) : null;
        const byNenva = typeof NoteTemplates !== 'undefined' && NoteTemplates.resolve ? (n => NoteTemplates.resolve(n) === 'assistant') : null;
        return this.rows({ notes, docs, docTags, kindOf, byNenva });
    },
    renderBody() {
        const host = document.querySelector(`#${this.APP}-view .dp-body`);
        if (!host) return;
        const esc = this.esc.bind(this);
        const all = this._allRows();
        const lede = document.getElementById('dp-lede');
        if (lede) { lede.textContent = this.ledeText(all); lede.hidden = !lede.textContent; }
        const kinds = [['all', 'All', all.length], ['written', 'Written', all.filter(r => r.written).length], ['files', 'Files', all.filter(r => !r.written).length]]
            .filter(([k, , n]) => k === 'all' || n);
        if (!kinds.some(([k]) => k === this._kind)) this._kind = 'all';
        const tags = this.tagRow(all);
        if (this._tag && !tags.some(t => t.tag.toLowerCase() === this._tag.toLowerCase())) this._tag = null;
        let rows = all;
        if (this._kind !== 'all') rows = rows.filter(r => r.kind === this._kind);
        if (this._tag) rows = rows.filter(r => this.hasTag(r, this._tag));
        if (this._query.trim()) rows = rows.filter(r => this.matches(r, this._query));
        const chip = (id, label, n, on, attr) => `<button type="button" class="dp-chip${on ? ' is-on' : ''}" ${attr}="${esc(id)}" aria-pressed="${on}">${esc(label)}${n ? `<span class="dp-chip-n">${n}</span>` : ''}</button>`;
        let html = '';
        if (!all.length) {
            html = `<p class="dp-empty">Nothing here yet. What nenva writes for you lands here, and so do files you give it: Add files above, or drop them on this page.</p>`;
        } else {
            if (kinds.length > 1) html += `<div class="dp-chips" role="toolbar" aria-label="Kind">${kinds.map(([k, label, n]) => chip(k, label, n, this._kind === k, 'data-dp-kind')).join('')}</div>`;
            if (tags.length) html += `<div class="dp-chips dp-tags" role="toolbar" aria-label="Tags">${tags.slice(0, 12).map(t => chip(t.tag, t.tag, t.n, this._tag && this._tag.toLowerCase() === t.tag.toLowerCase(), 'data-dp-tag')).join('')}</div>`;
            const groups = this.groups(rows);
            if (!groups.length) html += `<p class="dp-empty">${this._query.trim() ? 'Nothing matches.' : 'Nothing here.'}</p>`;
            for (const [label, list] of groups) {
                html += `<section class="dp-section"><h2 class="dp-eyebrow">${esc(label)} <span class="dp-n">${list.length}</span></h2><div class="dp-panel">${list.map(r => this.rowHtml(r)).join('')}</div></section>`;
            }
        }
        host.innerHTML = html;
    },
    rowHtml(r) {
        const esc = this.esc.bind(this);
        const icon = r.written
            ? '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'
            : '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>';
        return `<button type="button" class="dp-row" data-dp-open="${esc(r.id)}">
            <span class="dp-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></span>
            <span class="dp-copy"><span class="dp-title">${esc(r.title)}</span><span class="dp-sub">${esc(this.subline(r))}</span></span>
        </button>`;
    },
    onClick(e) {
        const t = e.target;
        let el;
        if (t.closest('[data-dp-back]')) { this.closeDocument(); return; }
        if (t.closest('[data-dp-new]')) { this.showDocument('note', null, { template: 'blank' }); return; }
        if (t.closest('[data-dp-add]')) { this.addFiles(); return; }
        if ((el = t.closest('[data-dp-kind]'))) { this._kind = el.dataset.dpKind; this.renderBody(); return; }
        if ((el = t.closest('[data-dp-tag]'))) { this._tag = this._tag && this._tag.toLowerCase() === el.dataset.dpTag.toLowerCase() ? null : el.dataset.dpTag; this.renderBody(); return; }
        if ((el = t.closest('[data-dp-open]'))) {
            const [key, ...rest] = el.dataset.dpOpen.split(':');
            this.showDocument(key === 'note' ? 'note' : 'file', rest.join(':'));
        }
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = DocumentsPage;
