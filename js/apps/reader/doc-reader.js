/**
 * DocReader — the ONE renderer for document rows and the in-place document
 * reader in the Documents app (it was shared with the Writing Voices app
 * until that became a setting, 2026-09-02; kept as its own module so any
 * second surface reuses it rather than drifting — the insightActionRows
 * rule).
 *
 * Tags ride both surfaces (DocTags, 2026-09-02): every row wears its tag
 * chips (click one to filter by it, × to drop it, "+ tag" on hover to add),
 * and the reader carries a tag strip under its meta line. Tagging is
 * cheap and reversible, so no confirmations.
 *
 * READABILITY (DocTidy, same day): the extracted view is always reflowed
 * (free), and the reader shows an AI-tidied Markdown rendering — once per
 * document, cached by file mtime — automatically when the brain is on
 * this Mac (or the Files privacy class allows it), otherwise behind a
 * "Tidy with AI" button. The banner says which view is up and the
 * extracted text is one click away; the original file another.
 *
 * Deleting a document deletes the FILE — the folder is the corpus (V1),
 * so there is no "remove from index but keep the file" state to offer. It
 * goes to the Trash, never a hard delete; its tags are forgotten.
 */
const DocReader = {
    PAGE: 24000,
    DRAG_MIME: 'application/x-anjadhe-doc',

    // ── Colour as data (2026-09-09 redesign pass, by request — the same
    // exception Portfolio / News / Routines took): one FIXED hue per
    // document KIND (what the file is) on the list head's COMPOSITION BAR
    // only — the kind tiles themselves are monochrome (icons are always
    // monochrome; Ram: "too much colours, no colours on the icons"); one
    // STABLE hue per TAG FAMILY (the root segment, hashed —
    // "Finance/Taxes/2025" wears Finance's hue) on chips and the nav's tag
    // dots; the app's own violet (--hue-reader) on the AI surfaces only
    // (the tidy/vision banner, search marks, the focus ring). Chrome stays
    // ink. Icons are stroked paths on the 24 viewBox.
    KINDS: {
        pdf:      { label: 'PDF',         hue: '#EF4444', icon: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h6"/>' },
        image:    { label: 'Image',       hue: '#EC4899', icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m21 16-5-5-8 8"/>' },
        sheet:    { label: 'Spreadsheet', hue: '#16A34A', icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M3 15h18"/><path d="M10 4v16"/>' },
        word:     { label: 'Word',        hue: '#3B82F6', icon: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="m8 12 1.5 6 2.5-4.5 2.5 4.5L16 12"/>' },
        slides:   { label: 'Slides',      hue: '#F97316', icon: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4"/><path d="M8 20h8"/><path d="m9 12 2.5-3 2 2L16 8"/>' },
        text:     { label: 'Text',        hue: '#64748B', icon: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/>' },
        markdown: { label: 'Markdown',    hue: '#14B8A6', icon: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15V9l2.5 3L12 9v6"/><path d="M16 9v6"/><path d="m14 13 2 2 2-2"/>' },
        web:      { label: 'Web page',    hue: '#0EA5E9', icon: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>' },
        other:    { label: 'File',        hue: '#9CA3AF', icon: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>' }
    },
    _KIND_BY_EXT: {
        pdf: 'pdf',
        png: 'image', jpg: 'image', jpeg: 'image', heic: 'image', heif: 'image', tif: 'image', tiff: 'image', gif: 'image', webp: 'image', bmp: 'image',
        xlsx: 'sheet', xls: 'sheet', csv: 'sheet', tsv: 'sheet', numbers: 'sheet',
        docx: 'word', doc: 'word', rtf: 'word', rtfd: 'word', odt: 'word', pages: 'word',
        pptx: 'slides', ppt: 'slides', key: 'slides',
        txt: 'text', json: 'text', log: 'text',
        md: 'markdown', markdown: 'markdown',
        html: 'web', htm: 'web', webarchive: 'web'
    },
    /** The document's kind {key,label,hue,icon} from its path. */
    kindOf(relpath) {
        const ext = (String(relpath || '').match(/\.(\w+)$/) || [])[1] || '';
        const key = this._KIND_BY_EXT[ext.toLowerCase()] || 'other';
        return { key, ...this.KINDS[key] };
    },
    /** The kind tile: a stroked glyph on the kind's hue (size via CSS). */
    tileHtml(relpath, extraClass = '') {
        const k = this.kindOf(relpath);
        return `<span class="library-kind-tile${extraClass ? ' ' + extraClass : ''}" data-kind="${k.key}" style="--doc-hue:${k.hue}" title="${UIUtils.escapeHtml(k.label)}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${k.icon}</svg></span>`;
    },
    TAG_HUES: ['#4F6BED', '#F97316', '#14B8A6', '#EC4899', '#65A30D', '#8B5CF6', '#F59E0B', '#0EA5E9', '#EF4444', '#0891B2', '#B45309', '#6366F1'],
    /** A tag family's hue: the ROOT segment hashed, so every child wears its parent's colour. */
    tagHue(tag) {
        const root = String(tag || '').split('/')[0].trim().toLowerCase();
        if (!root) return '#9CA3AF';
        let h = 0;
        for (let i = 0; i < root.length; i++) h = (h * 31 + root.charCodeAt(i)) >>> 0;
        return this.TAG_HUES[h % this.TAG_HUES.length];
    },
    /** "1.2 MB" — the row's sub-line. */
    _size(bytes) {
        const n = Number(bytes) || 0;
        if (!n) return '';
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
        if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
        return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
    },
    /** "Sep 2" this year, "Sep 2, 2025" otherwise; '' when unknown. */
    _when(value) {
        if (!value) return '';
        const d = new Date(value);
        if (isNaN(d.getTime())) return '';
        const opts = { month: 'short', day: 'numeric' };
        if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
        return d.toLocaleDateString('en-US', opts);
    },

    /** Wrap query terms (≥3 chars) in <mark> inside already-escaped HTML. */
    markTerms(escapedHtml, query) {
        const terms = String(query || '').split(/\s+/)
            .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .filter(t => t.length >= 3);
        if (!terms.length) return escapedHtml;
        try {
            return escapedHtml.replace(new RegExp(`(${terms.join('|')})`, 'gi'), '<mark>$1</mark>');
        } catch { return escapedHtml; }
    },

    /** The file's type, worn as a tiny tag in the row's left gutter (the
     *  home-widget when-gutter pattern) — more honest than a set of
     *  near-identical file icons. */
    _extTag(relpath) {
        const ext = (String(relpath || '').match(/\.(\w+)$/) || [])[1] || '';
        return ext.toUpperCase().slice(0, 4);
    },

    _chipsHtml(docId, tags, { removable = true } = {}) {
        const esc = (s) => UIUtils.escapeHtml(String(s || ''));
        return (tags || []).map(t => `
            <span class="task-tag library-tag-chip" data-lib-tag="${esc(t)}" style="--tag-hue:${this.tagHue(t)}" title="Show everything tagged ${esc(t)}"><span class="library-tag-dot" aria-hidden="true"></span>${esc(t)}${removable
                ? `<button type="button" class="library-tag-x" data-lib-tag-remove="${esc(t)}" data-lib-tag-doc="${esc(docId)}" title="Remove this tag" aria-label="Remove tag ${esc(t)}">&times;</button>` : ''}</span>`).join('');
    },

    /** The sub-line under a title: kind · size · when · passages / state. */
    _subHtml(d) {
        const esc = (s) => UIUtils.escapeHtml(String(s || ''));
        const bits = [`<span class="library-doc-ext">${esc(this._extTag(d.relpath))}</span>`];
        const size = this._size(d.size); if (size) bits.push(esc(size));
        const when = this._when(d.updatedAt); if (when) bits.push(esc(when));
        if (d.status === 'indexed') bits.push(`${d.chunkCount} passage${d.chunkCount === 1 ? '' : 's'}`);
        else if (d.status === 'error') bits.push(`<span class="library-doc-err">couldn't read — ${esc(d.error || 'unknown error')}</span>`);
        else bits.push('<span class="library-doc-busy">reading…</span>');
        return bits.join('<span class="library-doc-sep" aria-hidden="true">·</span>');
    },

    rowHtml(d, { tags = [] } = {}) {
        const esc = (s) => UIUtils.escapeHtml(String(s || ''));
        return `
            <div class="library-doc-row" data-status="${esc(d.status)}" data-kind="${this.kindOf(d.relpath).key}" data-lib-doc="${esc(d.id)}" data-lib-relpath="${esc(d.relpath)}" role="button" tabindex="0" draggable="true">
                ${this.tileHtml(d.relpath)}
                <span class="library-doc-main">
                    <span class="library-doc-title" title="${esc(d.relpath)}">${esc(d.title)}</span>
                    <span class="library-doc-sub">${this._subHtml(d)}</span>
                </span>
                <span class="library-doc-tags">${this._chipsHtml(d.id, tags)}<button type="button" class="library-tag-add" data-lib-tag-add="${esc(d.id)}" title="Add a tag">+ tag</button></span>
                <span class="library-doc-remove" data-lib-doc-remove="${esc(d.id)}" title="Move the file to the Trash" role="button" tabindex="0"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/></svg><span>Remove</span></span>
            </div>`;
    },

    /**
     * Bind rows rendered with rowHtml. onOpen(docId); onRefresh() after a
     * delete; onTagsChanged() after a tag add/remove; onTagClick(tag) when
     * a chip is clicked.
     */
    bindRows(root, { onOpen, onRefresh, onTagsChanged, onTagClick, tagPrefix }) {
        root.querySelectorAll('[data-lib-doc]').forEach(row => {
            const open = () => onOpen(row.dataset.libDoc);
            row.addEventListener('click', (e) => {
                if (e.target.closest('.library-doc-tags, [data-lib-doc-remove]')) return;
                open();
            });
            row.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === row) open(); });
            // Drag a row onto a tag in the tree to tag it (the same drop
            // target Finder files use). The payload is the doc id + relpath.
            row.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData(DocReader.DRAG_MIME, JSON.stringify({ id: row.dataset.libDoc, relpath: row.dataset.libRelpath || '' }));
                e.dataTransfer.effectAllowed = 'link';
                row.classList.add('is-dragging');
            });
            row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
        });
        root.querySelectorAll('[data-lib-doc-remove]').forEach(el => {
            const remove = async (e) => {
                e.stopPropagation();
                const row = el.closest('[data-lib-doc]');
                const title = row?.querySelector('.library-doc-title')?.textContent || '';
                if (await this.deleteDoc(el.dataset.libDocRemove, title) && onRefresh) onRefresh();
            };
            el.addEventListener('click', remove);
            el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); remove(e); } });
        });
        this.bindTags(root, { onTagsChanged, onTagClick, tagPrefix });
    },

    /** Chip clicks, chip ×, and the "+ tag" picker — shared by rows and the
     *  reader. `tagPrefix()` seeds the picker (the selected tag's path +
     *  "/", so a child tag is one word away). */
    bindTags(root, { onTagsChanged, onTagClick, tagPrefix }) {
        if (typeof DocTags === 'undefined') return;
        root.querySelectorAll('[data-lib-tag]').forEach(chip => {
            chip.addEventListener('click', (e) => {
                if (e.target.closest('[data-lib-tag-remove]')) return;
                e.stopPropagation();
                if (onTagClick) onTagClick(chip.dataset.libTag);
            });
        });
        root.querySelectorAll('[data-lib-tag-remove]').forEach(x => {
            x.addEventListener('click', (e) => {
                e.stopPropagation();
                DocTags.remove(x.dataset.libTagDoc, x.dataset.libTagRemove);
                if (onTagsChanged) onTagsChanged();
            });
        });
        root.querySelectorAll('[data-lib-tag-add]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (typeof TagPicker === 'undefined') return;
                const docId = btn.dataset.libTagAdd;
                const relpath = btn.closest('[data-lib-relpath]')?.dataset.libRelpath || '';
                TagPicker.open({
                    anchor: btn,
                    suggestions: DocTags.allTagNames(),
                    selected: DocTags.get(docId),
                    initial: (typeof tagPrefix === 'function' && tagPrefix()) || '',
                    placeholder: 'Search or create… (Finance/Taxes for a level)',
                    onAdd: (name) => { DocTags.add(docId, name, relpath); },
                    onClose: () => { if (onTagsChanged) onTagsChanged(); }
                });
            });
        });
    },

    async deleteDoc(docId, title) {
        const ok = await UIUtils.confirm(
            'Move to Trash',
            `Move "${UIUtils.escapeHtml(title || 'this document')}" to the Trash? It leaves the index; the file can be restored from the Trash.`,
            '', { confirmText: 'Move to Trash' }
        );
        if (!ok) return false;
        let res;
        try { res = await window.electronLibrary.deleteDoc(docId); } catch (e) { res = { error: e.message }; }
        if (res && res.error) { UIUtils.showToast(res.error, 'error'); return false; }
        if (typeof DocTags !== 'undefined') DocTags.forget(docId);
        UIUtils.showToast('Moved to Trash', 'success');
        return true;
    },

    /**
     * A per-view reader instance. The HOST owns rendering: when
     * `instance.active`, its render() calls `instance.html()` then
     * `instance.bind(body)`.
     *
     * host: {
     *   render(),         — repaint the view (the instance calls it on state changes)
     *   body(),           — the element the reader renders into (for scroll-to-match)
     *   onExit(),         — reader closed (back/delete)
     *   onDeleted(),      — a delete happened (refresh listings)
     *   onTagsChanged(),  — optional; the tag strip changed (repaint the nav)
     *   onTagClick(tag),  — optional; a chip was clicked
     *   tagPrefix(),      — optional; starting text for the "+ Add tag" picker
     *   docMeta(docId)    — optional; {size, updatedAt} from the listing for the facts line
     * }
     */
    create(host) {
        return {
            docId: null,
            doc: null,
            highlight: '',
            backLabel: 'Back',
            // The AI-tidied rendering: status idle|running|done|error, the
            // Markdown so far, how many raw chars it covers, which view is
            // up ('tidy' | 'raw'), progress, and a cancel token per open.
            tidy: null,

            get active() { return !!this.docId; },

            _resetTidy() {
                if (this.tidy && this.tidy.token) this.tidy.token.cancelled = true;
                this.tidy = { status: 'idle', text: '', covered: 0, view: 'raw', part: 0, parts: 0, error: '', token: { cancelled: false },
                              method: 'text', pages: 0, pagesDone: 0, page: 0, canSee: false };
            },

            async open(docId, { highlight = '', backLabel = 'Back' } = {}) {
                if (!docId) return;
                this.docId = docId;
                this.doc = null;
                this.highlight = highlight;
                this.backLabel = backLabel;
                this._resetTidy();
                host.render();
                let r;
                try { r = await window.electronLibrary.readDoc(docId, 0, DocReader.PAGE); } catch (e) { r = { error: e.message }; }
                if (this.docId !== docId) return;   // user moved on mid-read
                this.doc = r;
                if (!r.error) await this._loadTidy();
                if (this.docId !== docId) return;
                host.render();
                // Land ON the content that matched, not at the top.
                if (!r.error && highlight) {
                    setTimeout(() => {
                        host.body()?.querySelector('mark')?.scrollIntoView({ block: 'center' });
                    }, 30);
                }
            },

            close() {
                this._resetTidy();
                this.docId = null;
                this.doc = null;
                this.highlight = '';
                host.onExit();
            },

            /**
             * Cached tidy → show it (unless the reader opened on a search
             * hit, where the marks and scroll-to-match need the raw text —
             * the tidied view stays one click away). No cache → start one
             * when policy allows; else leave the button.
             */
            async _loadTidy() {
                if (typeof DocTidy === 'undefined' || !window.electronLibrary.tidyGet) return;
                // Whether a vision read is possible for THIS document — the
                // banner offers "Re-read with vision" on anything that was
                // parsed or OCR'd before a vision brain was available.
                this.tidy.canSee = DocTidy.isPaged(this.doc.relpath) && await DocTidy.visionAvailable();
                let cached = null;
                try { cached = await window.electronLibrary.tidyGet(this.docId); } catch { cached = null; }
                if (cached && !cached.none && !cached.error && cached.text) {
                    this.tidy.status = 'done';
                    this.tidy.text = cached.text;
                    this.tidy.covered = cached.coveredChars || this.doc.text.length;
                    this.tidy.method = cached.method || 'text';
                    this.tidy.pages = cached.pages || 0;
                    this.tidy.pagesDone = cached.pagesDone || 0;
                    this.tidy.view = this.highlight ? 'raw' : 'tidy';
                    return;
                }
                if (!DocTidy.autoAllowed()) return;
                // A brain that can see reads a PDF/image from its pages —
                // better than the text layer or OCR at every use.
                if (this.tidy.canSee) this.runVision({ manual: false });
                else this.runTidy({ manual: false });
            },

            /** Read (more of) the document from its rendered pages with a vision brain. */
            async runVision({ manual = false } = {}) {
                if (typeof DocTidy === 'undefined' || !this.doc || this.doc.error) return;
                const t = this.tidy;
                if (t.status === 'running') return;
                const docId = this.docId;
                const token = t.token;
                const fromPage = t.method === 'vision' && t.status === 'done' ? t.pagesDone : 0;
                const base = fromPage ? t.text : '';
                if (!fromPage) { t.text = ''; t.pages = 0; t.pagesDone = 0; }
                t.status = 'running'; t.error = ''; t.method = 'vision'; t.part = 0; t.parts = 0;
                if (!this.highlight) t.view = 'tidy';
                host.render();
                const res = await DocTidy.runVision(docId, {
                    fromPage, manual, token,
                    onPartial: (partial, prog) => {
                        if (this.docId !== docId || token.cancelled) return;
                        t.text = base + (base ? '\n\n---\n\n' : '') + partial;
                        t.page = prog.page; t.pages = prog.pages;
                        this._paintTidy();
                    }
                });
                if (this.docId !== docId || token.cancelled) return;
                if (res.error) {
                    // A main process older than this renderer (Cmd+R reloads
                    // the renderer only) has no page-render handler: say so,
                    // and fall back to the text tidy rather than stall.
                    const stale = /No handler registered/i.test(res.error);
                    t.status = fromPage ? 'done' : 'error';
                    t.error = stale ? 'page rendering needs an app restart (quit and reopen Anjadhe)' : res.error;
                    if (!fromPage) { t.view = 'raw'; t.method = 'text'; t.canSee = !stale && t.canSee; }
                    host.render();
                    if (stale && !fromPage) this.runTidy({ manual });
                    return;
                }
                t.text = base + (base ? '\n\n---\n\n' : '') + res.text;
                t.pages = res.pages; t.pagesDone = res.pagesDone;
                t.status = 'done';
                // The transcription is now the document's text (main re-indexes
                // from it): reload so the extracted view shows it too.
                try {
                    await window.electronLibrary.tidySet(docId, { text: t.text, coveredChars: t.text.length, model: AgentService.model,
                                                                  method: 'vision', pages: t.pages, pagesDone: t.pagesDone });
                    const r = await window.electronLibrary.readDoc(docId, 0, DocReader.PAGE);
                    if (this.docId === docId && r && !r.error) { this.doc = r; t.covered = r.text.length; }
                } catch { /* the view still works this session */ }
                if (this.docId !== docId) return;
                host.render();
            },

            /** Tidy the raw text not yet covered (first open, or after Show more). */
            async runTidy({ manual = false } = {}) {
                if (typeof DocTidy === 'undefined' || !this.doc || this.doc.error) return;
                const t = this.tidy;
                if (t.status === 'running') return;
                const from = t.status === 'done' ? t.covered : 0;
                const raw = String(this.doc.text || '').slice(from);
                if (!raw.trim()) return;
                const docId = this.docId;
                const token = t.token;
                const base = from ? t.text : '';
                t.status = 'running'; t.error = ''; t.part = 0; t.parts = 0;
                if (!this.highlight) t.view = 'tidy';
                host.render();
                const res = await DocTidy.run(raw, {
                    manual, token,
                    onPartial: (partial, prog) => {
                        if (this.docId !== docId || token.cancelled) return;
                        t.text = base + (base ? '\n\n' : '') + partial;
                        t.part = prog.part; t.parts = prog.parts;
                        this._paintTidy();
                    }
                });
                if (this.docId !== docId || token.cancelled) return;
                if (res.error) {
                    t.status = from ? 'done' : 'error';
                    t.error = res.error;
                    if (!from) t.view = 'raw';
                    host.render();
                    return;
                }
                t.text = base + (base ? '\n\n' : '') + res.text;
                t.covered = from + raw.length;
                t.status = 'done';
                try { await window.electronLibrary.tidySet(docId, { text: t.text, coveredChars: t.covered, model: AgentService.model }); }
                catch { /* the view still works this session */ }
                if (this.docId !== docId) return;
                host.render();
            },

            /** Live update of the tidy body and banner without a full repaint. */
            _paintTidy() {
                const body = host.body();
                if (!body) return;
                const t = this.tidy;
                const el = body.querySelector('.library-reader-body');
                if (el && t.view === 'tidy') el.innerHTML = this._tidyHtml();
                const prog = body.querySelector('[data-lib-tidy-progress]');
                if (prog) prog.textContent = this._tidyProgress();
            },

            _tidyProgress() {
                const t = this.tidy;
                if (t.method === 'vision') return t.pages > 1 ? `Reading page ${t.page || 1} of ${t.pages} with vision…` : 'Reading the page with vision…';
                return t.parts > 1 ? `Tidying with AI… part ${t.part} of ${t.parts}` : 'Tidying with AI…';
            },

            _tidyHtml() {
                const t = this.tidy;
                const md = t.text || '';
                if (typeof AgentUI !== 'undefined' && AgentUI.formatContent) return AgentUI.formatContent(md);
                return DocTidy.reflowHtml(md);
            },

            _rawHtml() {
                const mark = (escaped) => DocReader.markTerms(escaped, this.highlight);
                if (typeof DocTidy !== 'undefined') return DocTidy.reflowHtml(this.doc.text, mark);
                const esc = (s) => UIUtils.escapeHtml(String(s || ''));
                return String(this.doc.text || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
                    .map(p => `<p>${mark(esc(p)).replace(/\n/g, '<br>')}</p>`).join('');
            },

            /** The banner: which view is up, and the door to the other one. */
            _bannerHtml() {
                if (typeof DocTidy === 'undefined') return '';
                const esc = (s) => UIUtils.escapeHtml(String(s || ''));
                const t = this.tidy;
                const dest = DocTidy.destination();
                const toRaw = `<button type="button" class="library-linklike" data-lib-tidy-view="raw">Show extracted text</button>`;
                const toTidy = `<button type="button" class="library-linklike" data-lib-tidy-view="tidy">Show tidied</button>`;
                const tidyBtn = (label) => `<button type="button" class="library-linklike" data-lib-tidy-run>${label}</button>`;
                const visionBtn = (label) => `<button type="button" class="library-linklike" data-lib-vision-run>${label}</button>`;
                const partial = t.method === 'vision' && t.pages > t.pagesDone
                    ? ` · first ${t.pagesDone} of ${t.pages} pages read — ${visionBtn(`read the next ${Math.min(DocTidy.PAGE_CAP, t.pages - t.pagesDone)}`)}` : '';
                // A document parsed or OCR'd before a vision brain was
                // available: offer to reprocess it from the page images.
                const reread = t.canSee && t.method !== 'vision' && t.status !== 'running'
                    ? ` · ${visionBtn('Re-read with vision')}${dest ? ` <span class="library-reader-ai-note">(sends the page images to ${esc(dest)})</span>` : ''}` : '';
                let inner;
                if (t.status === 'running') {
                    inner = `<span data-lib-tidy-progress>${esc(this._tidyProgress())}</span> · ${t.view === 'tidy' ? toRaw : toTidy}`;
                } else if (t.status === 'done') {
                    const what = t.method === 'vision'
                        ? `Read from the page images by a vision model${t.pages ? ` (${t.pagesDone} page${t.pagesDone === 1 ? '' : 's'})` : ''} — the original file is unchanged`
                        : 'Tidied by AI for reading — the original file is unchanged';
                    inner = t.view === 'tidy'
                        ? `${what} · ${toRaw}${partial}${reread}${t.error ? ` · <span class="library-reader-ai-err">${esc(t.error)}</span>` : ''}`
                        : `${t.method === 'vision' ? 'Transcribed text' : 'Extracted text'} · ${toTidy}${partial}${reread}`;
                } else if (t.status === 'error') {
                    inner = `Couldn't ${t.method === 'vision' ? 'read the pages' : 'tidy'}: ${esc(t.error)} · ${tidyBtn('Try again')}`;
                } else if (!DocTidy.available()) {
                    inner = 'Extracted text · set up an AI model to tidy documents for reading';
                } else if (t.canSee) {
                    inner = `Extracted text · ${visionBtn('Read with vision')}${dest ? ` <span class="library-reader-ai-note">(sends the page images to ${esc(dest)})</span>` : ''}`;
                } else {
                    inner = `Extracted text · ${tidyBtn('Tidy with AI')}${dest ? ` <span class="library-reader-ai-note">(sends this document's text to ${esc(dest)})</span>` : ''}`;
                }
                const running = t.status === 'running';
                return `<div class="library-reader-ai${t.view === 'tidy' ? ' is-tidy' : ''}${running ? ' is-running' : ''}">
                    <span class="library-reader-ai-tile" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"/></svg></span>
                    <span class="library-reader-ai-text">${inner}</span>
                </div>`;
            },

            html() {
                const esc = (s) => UIUtils.escapeHtml(String(s || ''));
                const back = `<button type="button" class="back-btn library-back" data-lib-back>&#8592; ${esc(this.backLabel)}</button>`;
                if (!this.doc) return `${back}<p class="library-empty">Opening&hellip;</p>`;
                const d = this.doc;
                if (d.error) return `${back}<p class="library-empty">${esc(d.error)}</p>`;
                const kind = DocReader.kindOf(d.relpath);
                const minutes = Math.max(1, Math.round(d.totalChars / 1500));
                const meta = (typeof host.docMeta === 'function' && host.docMeta(d.docId)) || {};
                const facts = [`${minutes} min read`, DocReader._size(meta.size), DocReader._when(meta.updatedAt)].filter(Boolean);
                const tidyUp = this.tidy && this.tidy.view === 'tidy' && (this.tidy.status === 'done' || this.tidy.status === 'running');
                const bodyHtml = tidyUp ? this._tidyHtml() : this._rawHtml();
                const askPill = (typeof AgentUI !== 'undefined' && AgentUI.openComposer)
                    ? `<button type="button" class="ask-prompt-btn ask-prompt-open library-reader-ask" data-lib-ask>Ask about this document&hellip;</button>`
                    : '';
                const tags = (typeof DocTags !== 'undefined') ? DocTags.get(d.docId) : [];
                const tagStrip = (typeof DocTags !== 'undefined') ? `
                        <div class="library-reader-tags" data-lib-relpath="${esc(d.relpath)}">
                            <span class="library-reader-tags-label">Tags</span>
                            ${DocReader._chipsHtml(d.docId, tags)}
                            <button type="button" class="library-tag-add is-visible" data-lib-tag-add="${esc(d.docId)}">+ Add tag</button>
                        </div>` : '';
                const icon = (paths) => `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
                return `
                    ${back}
                    <article class="library-reader" data-kind="${kind.key}" style="--doc-hue:${kind.hue}">
                        <div class="library-reader-eyebrow">
                            ${DocReader.tileHtml(d.relpath, 'library-reader-tile')}
                            <span class="library-kind-chip">${esc(kind.label)}</span>
                            <span class="library-reader-path" title="${esc(d.relpath)}">${esc(d.relpath)}</span>
                        </div>
                        <h2 class="library-reader-title">${esc(d.title)}</h2>
                        <div class="library-reader-meta">
                            <span class="library-reader-facts">${facts.map(f => `<span>${esc(f)}</span>`).join('<span class="library-doc-sep" aria-hidden="true">·</span>')}</span>
                            <span class="library-reader-actions">
                                <button type="button" class="library-pill" data-lib-open-orig>${icon('<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/>')}Open original</button>
                                <button type="button" class="library-pill" data-lib-reveal>${icon('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>')}Show in Finder</button>
                                <button type="button" class="library-pill library-reader-delete" data-lib-delete>${icon('<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>')}Delete</button>
                            </span>
                        </div>
                        ${tagStrip}
                        ${this._bannerHtml()}
                        <div class="library-reader-body${tidyUp ? ' ai-prose library-reader-body--tidy' : ''}">${bodyHtml}</div>
                        ${d.truncated ? `<button type="button" class="secondary-btn library-reader-more" data-lib-more>Show more (${Math.round((d.totalChars - (d.offset + d.text.length)) / 1000)}k more characters)</button>` : ''}
                        ${askPill}
                    </article>`;
            },

            bind(body) {
                const instance = this;
                body.querySelector('[data-lib-back]')?.addEventListener('click', () => instance.close());
                body.querySelector('[data-lib-open-orig]')?.addEventListener('click', async () => {
                    const res = await window.electronLibrary.openDoc(instance.docId);
                    if (res && res.error) UIUtils.showToast(res.error, 'error');
                });
                body.querySelector('[data-lib-reveal]')?.addEventListener('click', async () => {
                    const res = await window.electronLibrary.revealDoc(instance.docId);
                    if (res && res.error) UIUtils.showToast(res.error, 'error');
                });
                body.querySelector('[data-lib-delete]')?.addEventListener('click', async () => {
                    if (await DocReader.deleteDoc(instance.docId, instance.doc?.title)) {
                        instance.close();
                        if (host.onDeleted) host.onDeleted();
                    }
                });
                // Tag strip: a change repaints the reader in place (the
                // strip is the only thing that moved) and lets the host
                // refresh its nav counts.
                const strip = body.querySelector('.library-reader-tags');
                if (strip) {
                    DocReader.bindTags(strip, {
                        tagPrefix: host.tagPrefix,
                        onTagsChanged: () => { host.render(); if (host.onTagsChanged) host.onTagsChanged(); },
                        onTagClick: (tag) => { if (host.onTagClick) { instance.docId = null; instance.doc = null; host.onTagClick(tag); } }
                    });
                }
                // The ambient provider names the open document, so an empty
                // composer is enough — the model knows what "this" is.
                body.querySelector('[data-lib-ask]')?.addEventListener('click', async () => {
                    if (typeof AgentUI !== 'undefined' && AgentUI.openComposer) await AgentUI.openComposer();
                });
                body.querySelectorAll('[data-lib-tidy-view]').forEach(b => b.addEventListener('click', () => {
                    instance.tidy.view = b.dataset.libTidyView;
                    host.render();
                }));
                body.querySelector('[data-lib-tidy-run]')?.addEventListener('click', async () => {
                    if (typeof DocTidy !== 'undefined' && DocTidy.isPaged(instance.doc?.relpath) && await DocTidy.visionAvailable()) instance.runVision({ manual: true });
                    else instance.runTidy({ manual: true });
                });
                body.querySelectorAll('[data-lib-vision-run]').forEach(b => b.addEventListener('click', () => instance.runVision({ manual: true })));
                body.querySelector('[data-lib-more]')?.addEventListener('click', async () => {
                    const d = instance.doc;
                    const next = d.offset + d.text.length;
                    let r;
                    try { r = await window.electronLibrary.readDoc(instance.docId, next, DocReader.PAGE); } catch { return; }
                    if (r.error || instance.docId !== d.docId) return;
                    instance.doc = { ...r, offset: d.offset, text: d.text + r.text };
                    host.render();
                    // The tidied view covers what was loaded; extend it.
                    if (instance.tidy.status === 'done' && instance.tidy.method !== 'vision' && typeof DocTidy !== 'undefined' && DocTidy.autoAllowed()) instance.runTidy({ manual: false });
                });
            }
        };
    }
};
