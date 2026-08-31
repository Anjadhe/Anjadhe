/**
 * DocReader — the ONE renderer for document rows and the in-place document
 * reader, shared by the Reader app (the corpus home) and Writing Voices
 * (each voice's own documents). One renderer so the two apps can never
 * disagree about what a document row or the reader looks like (the
 * insightActionRows rule).
 *
 * Deleting a document deletes the FILE — the folder is the corpus (V1),
 * so there is no "remove from index but keep the file" state to offer. It
 * goes to the Trash, never a hard delete.
 */
const DocReader = {
    PAGE: 24000,

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

    rowHtml(d) {
        const esc = (s) => UIUtils.escapeHtml(String(s || ''));
        return `
            <button type="button" class="library-doc-row" data-status="${esc(d.status)}" data-lib-doc="${esc(d.id)}">
                <span class="library-doc-ext">${esc(this._extTag(d.relpath))}</span>
                <span class="library-doc-title" title="${esc(d.relpath)}">${esc(d.title)}</span>
                <span class="library-doc-meta">${d.status === 'indexed'
                    ? `${d.chunkCount} passage${d.chunkCount === 1 ? '' : 's'}`
                    : (d.status === 'error' ? `couldn't index — ${esc(d.error || 'unknown error')}` : 'waiting…')}</span>
                <span class="library-doc-remove" data-lib-doc-remove="${esc(d.id)}" title="Move the file to the Trash">Remove</span>
            </button>`;
    },

    /** Bind rows rendered with rowHtml. onOpen(docId); onRefresh() after a delete. */
    bindRows(root, { onOpen, onRefresh }) {
        root.querySelectorAll('[data-lib-doc]').forEach(row => {
            row.addEventListener('click', () => onOpen(row.dataset.libDoc));
        });
        root.querySelectorAll('[data-lib-doc-remove]').forEach(el => {
            el.addEventListener('click', async (e) => {
                e.stopPropagation();
                const row = el.closest('[data-lib-doc]');
                const title = row?.querySelector('.library-doc-title')?.textContent || '';
                if (await this.deleteDoc(el.dataset.libDocRemove, title) && onRefresh) onRefresh();
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
     * }
     */
    create(host) {
        return {
            docId: null,
            doc: null,
            highlight: '',
            backLabel: 'Back',

            get active() { return !!this.docId; },

            async open(docId, { highlight = '', backLabel = 'Back' } = {}) {
                if (!docId) return;
                this.docId = docId;
                this.doc = null;
                this.highlight = highlight;
                this.backLabel = backLabel;
                host.render();
                let r;
                try { r = await window.electronLibrary.readDoc(docId, 0, DocReader.PAGE); } catch (e) { r = { error: e.message }; }
                if (this.docId !== docId) return;   // user moved on mid-read
                this.doc = r;
                host.render();
                // Land ON the content that matched, not at the top.
                if (!r.error && highlight) {
                    setTimeout(() => {
                        host.body()?.querySelector('mark')?.scrollIntoView({ block: 'center' });
                    }, 30);
                }
            },

            close() {
                this.docId = null;
                this.doc = null;
                this.highlight = '';
                host.onExit();
            },

            html() {
                const esc = (s) => UIUtils.escapeHtml(String(s || ''));
                const back = `<button type="button" class="back-btn library-back" data-lib-back>&#8592; ${esc(this.backLabel)}</button>`;
                if (!this.doc) return `${back}<p class="library-empty">Opening&hellip;</p>`;
                const d = this.doc;
                if (d.error) return `${back}<p class="library-empty">${esc(d.error)}</p>`;
                const meta = [d.collection || null, d.relpath, `${Math.max(1, Math.round(d.totalChars / 1500))} min read`]
                    .filter(Boolean).join(' · ');
                const paras = String(d.text || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
                const bodyHtml = paras.map(p =>
                    `<p>${DocReader.markTerms(esc(p), this.highlight).replace(/\n/g, '<br>')}</p>`).join('');
                const askPill = (typeof AgentUI !== 'undefined' && AgentUI.openComposer)
                    ? `<button type="button" class="ask-prompt-btn ask-prompt-open library-reader-ask" data-lib-ask>Ask about this document&hellip;</button>`
                    : '';
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
                        <div class="library-reader-body">${bodyHtml}</div>
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
                // The ambient provider names the open document, so an empty
                // composer is enough — the model knows what "this" is.
                body.querySelector('[data-lib-ask]')?.addEventListener('click', async () => {
                    if (typeof AgentUI !== 'undefined' && AgentUI.openComposer) await AgentUI.openComposer();
                });
                body.querySelector('[data-lib-more]')?.addEventListener('click', async () => {
                    const d = instance.doc;
                    const next = d.offset + d.text.length;
                    let r;
                    try { r = await window.electronLibrary.readDoc(instance.docId, next, DocReader.PAGE); } catch { return; }
                    if (r.error || instance.docId !== d.docId) return;
                    instance.doc = { ...r, offset: d.offset, text: d.text + r.text };
                    host.render();
                });
            }
        };
    }
};
