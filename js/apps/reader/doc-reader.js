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
            <span class="task-tag library-tag-chip" data-lib-tag="${esc(t)}" title="Show everything tagged ${esc(t)}">${esc(t)}${removable
                ? `<button type="button" class="library-tag-x" data-lib-tag-remove="${esc(t)}" data-lib-tag-doc="${esc(docId)}" title="Remove this tag" aria-label="Remove tag ${esc(t)}">&times;</button>` : ''}</span>`).join('');
    },

    rowHtml(d, { tags = [] } = {}) {
        const esc = (s) => UIUtils.escapeHtml(String(s || ''));
        return `
            <div class="library-doc-row" data-status="${esc(d.status)}" data-lib-doc="${esc(d.id)}" data-lib-relpath="${esc(d.relpath)}" role="button" tabindex="0" draggable="true">
                <span class="library-doc-ext">${esc(this._extTag(d.relpath))}</span>
                <span class="library-doc-title" title="${esc(d.relpath)}">${esc(d.title)}</span>
                <span class="library-doc-tags">${this._chipsHtml(d.id, tags)}<button type="button" class="library-tag-add" data-lib-tag-add="${esc(d.id)}" title="Add a tag">+ tag</button></span>
                <span class="library-doc-meta">${d.status === 'indexed'
                    ? `${d.chunkCount} passage${d.chunkCount === 1 ? '' : 's'}`
                    : (d.status === 'error' ? `couldn't read — ${esc(d.error || 'unknown error')}` : 'reading…')}</span>
                <span class="library-doc-remove" data-lib-doc-remove="${esc(d.id)}" title="Move the file to the Trash">Remove</span>
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
            el.addEventListener('click', async (e) => {
                e.stopPropagation();
                const row = el.closest('[data-lib-doc]');
                const title = row?.querySelector('.library-doc-title')?.textContent || '';
                if (await this.deleteDoc(el.dataset.libDocRemove, title) && onRefresh) onRefresh();
            });
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
     *   tagPrefix()       — optional; starting text for the "+ Add tag" picker
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
                return `<div class="library-reader-ai${t.view === 'tidy' ? ' is-tidy' : ''}">${inner}</div>`;
            },

            html() {
                const esc = (s) => UIUtils.escapeHtml(String(s || ''));
                const back = `<button type="button" class="back-btn library-back" data-lib-back>&#8592; ${esc(this.backLabel)}</button>`;
                if (!this.doc) return `${back}<p class="library-empty">Opening&hellip;</p>`;
                const d = this.doc;
                if (d.error) return `${back}<p class="library-empty">${esc(d.error)}</p>`;
                const meta = [DocReader._extTag(d.relpath), d.relpath, `${Math.max(1, Math.round(d.totalChars / 1500))} min read`]
                    .filter(Boolean).join(' · ');
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
                return `
                    ${back}
                    <article class="library-reader">
                        <h2 class="library-reader-title">${esc(d.title)}</h2>
                        <div class="library-reader-meta">
                            <span class="library-reader-path" title="${esc(d.relpath)}">${esc(meta)}</span>
                            <span class="library-reader-actions">
                                <button type="button" class="library-linklike" data-lib-open-orig>Open original</button>
                                <button type="button" class="library-linklike" data-lib-reveal>Show in Finder</button>
                                <button type="button" class="library-linklike library-reader-delete" data-lib-delete>Delete</button>
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
