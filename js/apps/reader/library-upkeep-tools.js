/**
 * Documents upkeep tools — Move to Trash, Add files and Rename tag, for the
 * assistant (2026-10-08, docs/AI_NATIVE.md parity inventory, batch 6).
 *
 *   trash_document       → electronLibrary.deleteDoc + DocTags.forget, as
 *                          DocReader.deleteDoc does (to the Trash, so it can
 *                          be restored; forget runs only on an in-app delete)
 *   add_file_to_documents → electronLibrary.importPaths, as a drop does: a
 *                          file already on this Mac, by its full path
 *   rename_document_tag  → DocTags.rename (children move with it)
 *
 * All ask and are blocked in untrusted turns. Files the person attached in
 * a chat keep their own tool (save_to_documents).
 */
(function registerLibraryUpkeepTools() {
    if (typeof AgentTools === 'undefined') return;
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const opts = { source: 'reader', group: 'library', blockUntrusted: true, ask: true };
    const hasTags = () => typeof DocTags !== 'undefined';
    const docOf = async (id) => {
        try { const l = await window.electronLibrary.list(); return ((l && l.docs) || []).find(d => String(d.id) === String(id)) || null; } catch { return null; }
    };
    const titleOf = (d) => (d && (d.title || String(d.relpath || '').split('/').pop())) || '';
    const relist = async () => { if (typeof ReaderApp !== 'undefined' && ReaderApp.cacheListing) { try { await ReaderApp.cacheListing(); } catch { /* next open lists it */ } } };

    AgentTools.register({ type: 'function', function: {
        name: 'trash_document',
        description: 'Move one of the person\'s documents to the Trash (it leaves Documents and the index; it can be restored from the Trash), as Move to Trash does. Give its id from list_documents or search_library.',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    }}, async (a = {}) => {
        if (!window.electronLibrary || !window.electronLibrary.deleteDoc) return { error: 'Documents are not available on this Mac.' };
        const d = await docOf(a.id);
        if (!d) return { error: 'No document with that id. Call list_documents.' };
        let res;
        try { res = await window.electronLibrary.deleteDoc(d.id); } catch (e) { res = { error: e.message }; }
        if (res && res.error) return { error: res.error };
        if (hasTags()) DocTags.forget(d.id);
        await relist();
        return { success: true, movedToTrash: titleOf(d) };
    }, { ...opts, describe: (a) => `Move the document <b>${esc(a.id)}</b> to the Trash` });

    AgentTools.register({ type: 'function', function: {
        name: 'add_file_to_documents',
        description: 'Copy a file that is already on this Mac into Documents, by its full path (e.g. "/Users/…/Downloads/lease.pdf"), so it is kept, indexed and searchable; optionally tag it. A folder\'s path copies every document in it. For a file attached in this chat use save_to_documents instead.',
        parameters: { type: 'object', properties: {
            path: { type: 'string', description: 'Full path, starting with /' },
            tag: { type: 'string', description: 'Optional tag; "/" makes a level' }
        }, required: ['path'] }
    }}, async (a = {}) => {
        if (!window.electronLibrary || !window.electronLibrary.importPaths) return { error: 'Documents are not available on this Mac.' };
        const p = String(a.path || '').trim();
        if (!p.startsWith('/')) return { error: 'Give the file\'s full path, starting with / (not ~).' };
        let res;
        try { res = await window.electronLibrary.importPaths([p]); } catch (e) { return { error: e.message }; }
        if (res && res.error) return { error: res.error };
        const doc = (res && res.docs || [])[0];
        if (!doc) return { error: 'Nothing was added: the file is not there, or it is a kind of file Documents cannot keep.' };
        if (a.tag && hasTags()) DocTags.add(doc.id, String(a.tag), doc.relpath);
        await relist();
        return { success: true, docId: doc.id, title: String(doc.relpath).split('/').pop(), tags: hasTags() ? DocTags.get(doc.id) : undefined, note: 'Copied into Documents; it is being read and indexed now.', document: { id: doc.id, title: String(doc.relpath).split('/').pop() } };
    }, { ...opts, record: { app: 'reader', key: 'document', label: 'document' }, describe: (a) => `Copy <b>${esc(a.path)}</b> into Documents${a.tag ? `, tagged ${esc(a.tag)}` : ''}` });

    AgentTools.register({ type: 'function', function: {
        name: 'rename_document_tag',
        description: 'Rename a Documents tag everywhere, as Rename tag does; tags under it move with it ("Finance/Taxes" → "Money/Taxes" also renames "Finance/Taxes/2025").',
        parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] }
    }}, (a = {}) => {
        if (!hasTags()) return { error: 'Tags are not available.' };
        const n = DocTags.rename(String(a.from || ''), String(a.to || ''));
        if (!n) return { error: `No document is tagged "${a.from}".` };
        return { success: true, documentsRetagged: n, now: DocTags.normalize(String(a.to)) };
    }, { ...opts, describe: (a) => `Rename the tag <b>${esc(a.from)}</b> to <b>${esc(a.to)}</b> on every document` });
})();
