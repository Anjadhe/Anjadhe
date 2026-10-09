/**
 * JournalExport — the Journal app left nenva (2026-10-05); the entries do
 * not.
 *
 * Ram moved his journal to Notebook (~/workspace/notebook). For anyone else
 * who wrote entries, nenva makes one thing true on the first launch after
 * the change, once per Mac: every entry and its photos are written as
 * Markdown to ~/nenva/Journal (the folder the app kept all along, filled in
 * even on a Mac where the Markdown switch was off), and a notice says where
 * they are, with a button to show the folder. The `journal` and
 * `journalMedia_*` keys are left as they are. After this nothing in nenva
 * reads, writes or deletes that folder again.
 */
const JournalExport = {
    MARK: 'journal-final-export',

    async runOnce() {
        try {
            if (typeof localStorage === 'undefined' || localStorage.getItem(this.MARK)) return null;
            if (typeof StorageManager === 'undefined' || !window.electronJournalExport) return null;
            const blob = StorageManager.get('journal');
            const entries = (blob && Array.isArray(blob.entries) ? blob.entries : []).filter(e => e && e.id);
            if (!entries.length) { localStorage.setItem(this.MARK, new Date().toISOString()); return { entries: 0 }; }
            const files = [], assets = [];
            const taken = new Set();
            for (const rec of entries) {
                const name = ContentFiles.fileNameFor('journal', rec, taken, undefined, undefined);
                taken.add(name.toLowerCase());
                const { text, assets: a } = await ContentFiles._serialize('journal', rec);
                files.push({ name, text });
                for (const x of a) assets.push(x);
            }
            const r = await window.electronJournalExport.write({ files, assets });
            if (!r || r.error) { console.warn('[journal-export] failed:', r && r.error); return null; }
            localStorage.setItem(this.MARK, new Date().toISOString());
            // After the shell has settled: a dialog raised during init is closed
            // by the first render before anyone sees it.
            setTimeout(() => this._notice(entries.length, r.dir), 3000);
            return { entries: entries.length, dir: r.dir };
        } catch (e) { console.warn('[journal-export] failed:', e); return null; }
    },

    async _notice(n, dir) {
        if (typeof UIUtils === 'undefined' || !UIUtils.confirm) return;
        const show = await UIUtils.confirm('Your journal is in a folder now',
            `The Journal page is no longer part of nenva. Your ${n} ${n === 1 ? 'entry is' : 'entries are'} kept as Markdown files, photos beside them, at ${dir}. Open them in any editor; nenva will not change that folder again.`,
            '', { confirmText: 'Show folder', cancelText: 'OK' });
        if (show) { try { await window.electronJournalExport.reveal(); } catch { /* best effort */ } }
    }
};
