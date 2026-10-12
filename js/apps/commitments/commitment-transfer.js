/**
 * CommitmentTransfer — one commitment out as a file and back in (2026-10-11,
 * by request: "Add an export import option for individual commitments too",
 * beside Finance's and Memory's). Plain JSON, no model: the record comes back
 * as it was.
 *
 * What travels: the commitment and every step under it (its family), each
 * record whole: dates, repeat, what was done each day, what the person said
 * and its figures, the aim and stages, notes, tags and attachments. What does
 * not: the assistant's read of it (`read`, written again here), its chat, and
 * the files an attachment points at (an attachment names a document on the
 * Mac that exported it).
 *
 * Laws:
 *   CT1  An import MERGES by id: a record this Mac does not have is added;
 *        one it has is replaced only by a newer copy (updatedAt). Nothing on
 *        this Mac is removed.
 *   CT2  The person asked for the import, so it outranks an old delete: a
 *        record this Mac deleted is restored (stamped now).
 *   CT3  Every record in a file is checked (`clean`): a real id and title,
 *        a known state, repeat rule, kind and domain, a real date. A parent
 *        that is neither in the file nor on this Mac is dropped (it becomes
 *        a top-level commitment); a parent chain that loops is cut. A step
 *        this Mac kept goes back under its parent when the import restores
 *        that parent (a delete here had moved it up a level).
 *   CT4  The write is Commitments.importRecords: one ledger entry per
 *        record, so Undo puts this Mac back exactly.
 *   CT5  A file that is not a nenva commitment export is refused whole.
 *
 * All of them (2026-10-12, by request: "export all the existing commitments
 * and allow to import", like Memory's): the Commitments page's foot exports
 * every commitment, open and finished, as the same format with `all: true`
 * and no root; the one Import reads either kind under the same laws.
 */
const CommitmentTransfer = {
    FORMAT: 'nenva-commitment',
    VERSION: 1,
    ID_RX: /^[\w.:-]{1,100}$/,
    LEFT_OUT: ['read'],

    _clone(x) { return JSON.parse(JSON.stringify(x)); },

    fileName(c, now = new Date()) {
        const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const slug = String((c && c.title) || 'commitment').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'commitment';
        return `nenva-${slug}-${d}.json`;
    },

    // ── Export (pure over the list) ────────────────────────────────────

    /** The file for `id` and everything under it, or { error }. */
    build(id, all, now = new Date()) {
        const root = (all || []).find(c => c && c.id === id);
        if (!root) return { error: `No commitment with id "${id}".` };
        const family = Commitments.family(root, all).map(c => {
            const r = this._clone(c);
            for (const k of this.LEFT_OUT) delete r[k];
            return r;
        });
        return { format: this.FORMAT, version: this.VERSION, exportedAt: now.toISOString(), root: root.id, title: root.title, commitments: family };
    },

    ALL_TITLE: 'All your commitments',

    /** The file for every commitment, or { error } when there is none. */
    buildAll(all, now = new Date()) {
        const list = (all || []).filter(c => c && c.id).map(c => {
            const r = this._clone(c);
            for (const k of this.LEFT_OUT) delete r[k];
            return r;
        });
        if (!list.length) return { error: 'There are no commitments to export.' };
        return { format: this.FORMAT, version: this.VERSION, exportedAt: now.toISOString(), all: true, root: null, title: this.ALL_TITLE, commitments: list };
    },

    allFileName(now = new Date()) {
        const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        return `nenva-commitments-${d}.json`;
    },

    // ── Import (pure) ──────────────────────────────────────────────────

    /** CT5: the parsed file, or { error }. */
    parse(text) {
        let f;
        try { f = JSON.parse(String(text || '')); } catch { return { error: 'That file is not a nenva commitment export (it is not JSON).' }; }
        if (!f || f.format !== this.FORMAT) return { error: 'That file is not a nenva commitment export.' };
        if (Number(f.version) > this.VERSION) return { error: 'That export is from a newer nenva. Update nenva, then import it.' };
        const commitments = (Array.isArray(f.commitments) ? f.commitments : []).map(r => this.clean(r)).filter(Boolean);
        if (!commitments.length) return { error: 'That file holds no commitment nenva can read.' };
        if (f.all === true) return { all: true, root: null, title: this.ALL_TITLE, commitments, exportedAt: f.exportedAt || null };
        const root = commitments.find(c => c.id === f.root) || commitments[0];
        return { root: root.id, title: root.title, commitments, exportedAt: f.exportedAt || null };
    },

    /** CT3: one record from a file, checked, or null. */
    clean(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const id = typeof raw.id === 'string' ? raw.id : '';
        const title = typeof raw.title === 'string' ? raw.title.trim() : '';
        if (!this.ID_RX.test(id) || !title) return null;
        const nowIso = new Date().toISOString();
        const r = { ...Commitments.blank(id, nowIso), ...this._clone(raw), id, title: title.slice(0, 500) };
        for (const k of this.LEFT_OUT) delete r[k];
        if (!Commitments.STATES.includes(r.state)) r.state = 'open';
        if (!r.repeat || typeof r.repeat !== 'object' || !Commitments.RULES.includes(r.repeat.rule)) r.repeat = { rule: 'none', days: [] };
        r.repeat.days = Array.isArray(r.repeat.days) ? r.repeat.days.filter(n => Number.isInteger(n) && n >= 0 && n <= 6) : [];
        if (r.when && typeof r.when === 'object') {
            const date = r.when.date ? Commitments.day(r.when.date) : null;
            const time = r.when.time ? Commitments.time(r.when.time) : null;
            r.when = date || time ? { ...r.when, date, time, end: time && r.when.end ? Commitments.time(r.when.end) : null } : null;
        } else r.when = null;
        if (r.kind != null && !Commitments.KINDS.includes(r.kind)) delete r.kind;
        if (r.domain != null && !Commitments.DOMAINS.includes(r.domain)) delete r.domain;
        if (r.parent != null && (typeof r.parent !== 'string' || !this.ID_RX.test(r.parent) || r.parent === id)) r.parent = null;
        for (const k of ['history', 'log', 'moved']) if (r[k] != null && (typeof r[k] !== 'object' || Array.isArray(r[k]))) delete r[k];
        if (!Array.isArray(r.tags)) r.tags = [];
        if (r.attached != null && !Array.isArray(r.attached)) delete r.attached;
        if (!Number.isFinite(Date.parse(r.createdAt || ''))) r.createdAt = nowIso;
        if (!Number.isFinite(Date.parse(r.updatedAt || ''))) r.updatedAt = r.createdAt;
        return r;
    },

    _stamp(r) { const t = Date.parse((r && r.updatedAt) || ''); return Number.isFinite(t) ? t : 0; },

    /**
     * CT1–CT3: what the import writes, pure.
     * `current` = { items: {id: record}, tombstones: {id: iso} }.
     * → { write: [records], added, updated, restored, same }
     */
    plan(file, current, nowIso = new Date().toISOString()) {
        const items = (current && current.items) || {};
        const tombs = (current && current.tombstones) || {};
        const inFile = new Set(file.commitments.map(c => c.id));
        const write = [];
        let added = 0, updated = 0, restored = 0, same = 0;
        for (const raw of file.commitments) {
            let r = this._clone(raw);
            if (r.parent && !inFile.has(r.parent) && !items[r.parent]) r.parent = null;
            const tomb = Date.parse(tombs[r.id] || '') || 0;
            const here = items[r.id];
            if (!here) {
                if (tomb) { restored++; if (this._stamp(r) <= tomb) r.updatedAt = nowIso; } else added++;
                write.push(r);
            } else if (this._stamp(r) > this._stamp(here)) { updated++; write.push(r); }
            else same++;
        }
        // A step this Mac kept, cut loose when its parent was deleted here
        // (Commitments.remove moves steps up), goes back under that parent
        // when the import restores it. Only its parent changes.
        const restoring = new Set(write.filter(r => !items[r.id] && tombs[r.id]).map(r => r.id));
        for (const raw of file.commitments) {
            const here = items[raw.id];
            if (!here || write.some(r => r.id === raw.id)) continue;
            if (raw.parent && restoring.has(raw.parent) && (here.parent || null) !== raw.parent && !(here.parent && items[here.parent])) {
                write.push({ ...this._clone(here), parent: raw.parent, updatedAt: nowIso });
                same--; updated++;
            }
        }
        // A loop through parents (a file's records with this Mac's) is cut
        // at the record being written.
        const by = { ...items };
        for (const r of write) by[r.id] = r;
        for (const r of write) {
            const seen = new Set([r.id]);
            let p = r.parent, hops = 0;
            while (p && by[p] && hops++ < 100) {
                if (seen.has(p)) { r.parent = null; break; }
                seen.add(p);
                p = by[p].parent;
            }
        }
        return { write, added, updated, restored, same };
    },

    sentence(r) {
        const bits = [r.added ? `${r.added} added` : '', r.updated ? `${r.updated} updated` : '', r.restored ? `${r.restored} restored` : ''].filter(Boolean);
        if (r.all) return bits.length ? `Imported your commitments: ${bits.join(', ')}` : 'You already had every commitment in that file';
        return bits.length ? `Imported “${r.title}”: ${bits.join(', ')}` : `You already had everything in “${r.title}”`;
    },

    // ── The app side ───────────────────────────────────────────────────

    async exportToFile(id) {
        if (!window.electronCommitmentFile?.save) return { error: 'Export is not available here.' };
        const all = Commitments.all();
        const file = this.build(id, all);
        if (file.error) return file;
        const root = Commitments.get(id);
        const res = await window.electronCommitmentFile.save(JSON.stringify(file, null, 1), this.fileName(root));
        if (res && res.ok) return { ok: true, path: res.path, title: root.title, count: file.commitments.length };
        return res && res.canceled ? { canceled: true } : { error: (res && res.error) || 'Could not save the file.' };
    },

    /** Every commitment to one file. */
    async exportAllToFile() {
        if (!window.electronCommitmentFile?.save) return { error: 'Export is not available here.' };
        const file = this.buildAll(Commitments.all());
        if (file.error) return file;
        const res = await window.electronCommitmentFile.save(JSON.stringify(file, null, 1), this.allFileName());
        if (res && res.ok) return { ok: true, path: res.path, count: file.commitments.length };
        return res && res.canceled ? { canceled: true } : { error: (res && res.error) || 'Could not save the file.' };
    },

    /** Pick a file, say what is in it, write on Import (CT4). */
    async importFromFile() {
        if (!window.electronCommitmentFile?.open) return { error: 'Import is not available here.' };
        const f = await window.electronCommitmentFile.open();
        if (!f || f.canceled) return { canceled: true };
        if (f.error) return { error: f.error };
        const file = this.parse(f.text);
        if (file.error) return file;
        const esc = s => UIUtils.escapeHtml(String(s));
        const steps = file.commitments.length - 1;
        const when = file.exportedAt ? new Date(file.exportedAt).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
        const ok = file.all
            ? await UIUtils.confirm('Import commitments?',
                `<p>${esc(f.name)} holds ${file.commitments.length} commitment${file.commitments.length === 1 ? '' : 's'}${when ? `, exported ${esc(when)}` : ''}, with their steps, history and what you said about them.</p>
                 <p>A commitment you have here is replaced only by a newer copy. Nothing else is changed, and Undo puts it back.</p>`,
                '', { confirmText: 'Import' })
            : await UIUtils.confirm(`Import “${esc(file.title)}”?`,
            `<p>${esc(f.name)} holds “${esc(file.title)}”${steps ? ` and ${steps} step${steps === 1 ? '' : 's'} under it` : ''}${when ? `, exported ${esc(when)}` : ''}, with its history and what you said about it.</p>
             <p>A commitment you have here is replaced only by a newer copy. Nothing else is changed, and Undo puts it back.</p>`,
            '', { confirmText: 'Import' });
        if (!ok) return { canceled: true };
        return this.apply(file);
    },

    apply(file) {
        const d = Commitments._load();
        const p = this.plan(file, { items: d.items, tombstones: d.tombstones });
        const w = p.write.length ? Commitments.importRecords(p.write) : { ledgerIds: [] };
        return { ok: true, all: !!file.all, id: file.root, title: file.title, added: p.added, updated: p.updated, restored: p.restored, unchanged: p.same, ledgerIds: w.ledgerIds };
    },

    /** Undo an import: its entries, newest first. */
    undo(ledgerIds) {
        for (const id of (ledgerIds || []).slice().reverse()) Commitments.undo(id);
    }
};

// The assistant does what the sheet's Export and the page's Import do (agent parity).
(function registerCommitmentTransferTools() {
    if (typeof AgentTools === 'undefined' || typeof AgentTools.register !== 'function' || typeof Commitments === 'undefined') return;
    const common = { group: 'commitments', blockUntrusted: true };
    AgentTools.register({ type: 'function', function: {
        name: 'export_commitment',
        description: 'Save one commitment, with every step under it, its history and what the person said about it, to a JSON file they choose. Opens a save dialog. Use the id from list_commitments.',
        parameters: { type: 'object', properties: { id: { type: 'string', description: 'The commitment id' } }, required: ['id'], additionalProperties: false }
    } }, async function export_commitment(args, ctx) {
        if (ctx && ctx.ambient) return { error: 'Exporting needs the user present to choose where the file goes.' };
        const r = await CommitmentTransfer.exportToFile(String((args && args.id) || ''));
        return r.canceled ? { canceled: true, note: 'The user closed the save dialog; nothing was saved.' } : r;
    }, common);
    AgentTools.register({ type: 'function', function: {
        name: 'export_all_commitments',
        description: 'Save every commitment (open and finished, with steps, history and what the person said) to one JSON file they choose. Opens a save dialog.',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
    } }, async function export_all_commitments(args, ctx) {
        if (ctx && ctx.ambient) return { error: 'Exporting needs the user present to choose where the file goes.' };
        const r = await CommitmentTransfer.exportAllToFile();
        return r.canceled ? { canceled: true, note: 'The user closed the save dialog; nothing was saved.' } : r;
    }, common);
    AgentTools.register({ type: 'function', function: {
        name: 'import_commitment',
        description: 'Bring commitments back from a nenva commitment export (JSON): one commitment\'s file or the export of all of them. Opens a file picker; the user sees what the file holds and confirms. Merged by id, nothing removed, undoable. Report the counts the result gives.',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
    } }, async function import_commitment(args, ctx) {
        if (ctx && ctx.ambient) return { error: 'Importing needs the user present to pick and confirm the file.' };
        const r = await CommitmentTransfer.importFromFile();
        if (r.ok && typeof CommitmentsPage !== 'undefined') { try { CommitmentsPage.render(); } catch { /* not on screen */ } }
        if (r.ok) delete r.ledgerIds;
        return r.canceled ? { canceled: true, note: 'The user closed the picker or chose not to import.' } : r;
    }, common);
})();
