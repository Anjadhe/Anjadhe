/**
 * FinanceTransfer — Finance's data out as one file and back in (2026-10-11,
 * by request: "a simple one.. transactions, holdings, tickers, accounts,
 * snapshots"). Plain JSON, no model: every record comes back as it was.
 *
 * What travels:
 *   portfolio   accounts (your own), their transactions (holdings and tickers
 *               are computed from these), properties, debts, strategies and
 *               the tickers once watched
 *   history     value snapshots, one per day
 *   spending    bank and card accounts, their transactions, your category rules
 * What does not: links to a brokerage or bank (Plaid sign-ins belong to the
 * Mac that made them; link again after an import), accounts another person
 * once shared, prices (refetched) and per-Mac view choices.
 *
 * Laws:
 *   FT1  An import MERGES by id: a record this Mac does not have is added;
 *        one it has is replaced only by a newer copy (updatedAt). Nothing on
 *        this Mac is removed. Snapshots merge by day; this Mac's day wins.
 *   FT2  The person asked for the import, so it outranks an old delete: a
 *        record this Mac tombstoned is restored (stamped now, since the
 *        record merge lets an edit newer than the tombstone win).
 *   FT3  Writes go through each half's own saveData, so the record merge
 *        in main sees an ordinary edit.
 *   FT4  A file that is not a nenva Finance export is refused whole.
 */
const FinanceTransfer = {
    FORMAT: 'nenva-finance',
    VERSION: 1,
    PORTFOLIO_ARRAYS: ['accounts', 'transactions', 'properties', 'liabilities', 'strategies', 'watchlist'],
    SPENDING_ARRAYS: ['accounts', 'transactions', 'rules'],

    fileName(now = new Date()) {
        const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        return `nenva-finance-${d}.json`;
    },

    _clone(x) { return JSON.parse(JSON.stringify(x)); },
    /** Drop the link to a brokerage or bank; the record itself stays. */
    _unlinked(r) { const c = this._clone(r); delete c.brokerage; return c; },

    // ── Export (pure over the two blobs) ───────────────────────────────

    build({ portfolio = {}, history = {}, spending = {} } = {}, now = new Date()) {
        const own = (portfolio.accounts || []).filter(a => a && a.id && !a.shared);
        const ownIds = new Set(own.map(a => a.id));
        const arr = (blob, name) => Array.isArray(blob[name]) ? blob[name].filter(r => r && (r.id || name === 'watchlist')) : [];
        return {
            format: this.FORMAT, version: this.VERSION, exportedAt: now.toISOString(),
            portfolio: {
                accounts: own.map(a => this._unlinked(a)),
                transactions: arr(portfolio, 'transactions').filter(t => ownIds.has(t.accountId)).map(t => this._clone(t)),
                properties: this._clone(arr(portfolio, 'properties')),
                liabilities: this._clone(arr(portfolio, 'liabilities')),
                strategies: this._clone(arr(portfolio, 'strategies')),
                watchlist: this._clone(arr(portfolio, 'watchlist'))
            },
            history: { snapshots: this._clone((Array.isArray(history.snapshots) ? history.snapshots : []).filter(s => s && s.date)) },
            spending: {
                accounts: arr(spending, 'accounts').map(a => this._unlinked(a)),
                transactions: this._clone(arr(spending, 'transactions')),
                rules: this._clone(arr(spending, 'rules'))
            }
        };
    },

    counts(file) {
        const p = file.portfolio || {}, s = file.spending || {};
        const n = a => (Array.isArray(a) ? a.length : 0);
        return {
            accounts: n(p.accounts), transactions: n(p.transactions), properties: n(p.properties), debts: n(p.liabilities),
            strategies: n(p.strategies), watchlist: n(p.watchlist), snapshots: n(file.history && file.history.snapshots),
            bankAccounts: n(s.accounts), bankTransactions: n(s.transactions), rules: n(s.rules)
        };
    },

    /** One line a person reads: "4 accounts, 212 transactions, 380 snapshots…". */
    summary(c) {
        const parts = [
            [c.accounts, 'account'], [c.transactions, 'transaction'], [c.properties, 'property', 'properties'], [c.debts, 'debt'],
            [c.strategies, 'strategy', 'strategies'], [c.watchlist, 'watched ticker'], [c.snapshots, 'snapshot'],
            [c.bankAccounts, 'bank or card account'], [c.bankTransactions, 'bank transaction'], [c.rules, 'category rule']
        ].filter(([n]) => n).map(([n, one, many]) => `${n} ${n === 1 ? one : (many || one + 's')}`);
        return parts.length ? parts.join(', ') : 'nothing';
    },

    // ── Import (pure) ──────────────────────────────────────────────────

    /** FT4: the parsed file, or { error }. */
    parse(text) {
        let f;
        try { f = JSON.parse(String(text || '')); } catch { return { error: 'That file is not a nenva Finance export (it is not JSON).' }; }
        if (!f || f.format !== this.FORMAT) return { error: 'That file is not a nenva Finance export.' };
        if (Number(f.version) > this.VERSION) return { error: 'That export is from a newer nenva. Update nenva, then import it.' };
        const p = f.portfolio && typeof f.portfolio === 'object' ? f.portfolio : {};
        const s = f.spending && typeof f.spending === 'object' ? f.spending : {};
        const list = (o, k) => Array.isArray(o[k]) ? o[k].filter(r => r && typeof r === 'object') : [];
        return {
            portfolio: Object.fromEntries(this.PORTFOLIO_ARRAYS.map(k => [k, list(p, k)])),
            history: { snapshots: list(f.history || {}, 'snapshots').filter(x => typeof x.date === 'string') },
            spending: Object.fromEntries(this.SPENDING_ARRAYS.map(k => [k, list(s, k)])),
            exportedAt: f.exportedAt || null
        };
    },

    _stamp(r) { const t = Date.parse((r && (r.updatedAt || r.modifiedAt || r.createdAt)) || ''); return Number.isFinite(t) ? t : 0; },
    _key(r) { return r.id != null ? String(r.id) : (r.symbol ? 'sym:' + String(r.symbol).toUpperCase() : (typeof r === 'string' ? 'sym:' + r.toUpperCase() : null)); },

    /**
     * FT1/FT2: merge `incoming` records into `local` by id.
     * → { rows, added, updated, restored: [ids] }
     */
    mergeRecords(local = [], incoming = [], tombstones = {}, nowIso = new Date().toISOString()) {
        const rows = local.slice();
        const at = new Map(rows.map((r, i) => [this._key(r), i]));
        let added = 0, updated = 0;
        const restored = [];
        for (const raw of incoming) {
            const key = this._key(raw);
            if (!key) continue;
            let r = typeof raw === 'object' ? this._clone(raw) : raw;
            const id = r && r.id != null ? String(r.id) : null;
            const tomb = id ? Date.parse(tombstones[id] || '') || 0 : 0;
            if (tomb && this._stamp(r) <= tomb) { r = { ...r, updatedAt: nowIso }; restored.push(id); }
            else if (tomb) restored.push(id);
            if (!at.has(key)) { at.set(key, rows.length); rows.push(r); added++; continue; }
            const i = at.get(key);
            if (typeof r === 'object' && this._stamp(r) > this._stamp(rows[i])) { rows[i] = r; updated++; }
        }
        return { rows, added, updated, restored };
    },

    /** Snapshots by day; a day this Mac already has keeps this Mac's (FT1). */
    mergeSnapshots(local = [], incoming = []) {
        const have = new Set(local.map(s => s.date));
        const add = incoming.filter(s => s && s.date && !have.has(s.date)).map(s => this._clone(s));
        return { rows: [...local, ...add].sort((a, b) => String(a.date).localeCompare(String(b.date))), added: add.length };
    },

    /** The whole merge, pure. → { portfolio, history, spending, report } */
    plan(file, current, nowIso = new Date().toISOString()) {
        const report = { added: 0, updated: 0, restored: 0, snapshots: 0 };
        const pTomb = { ...((current.portfolio && current.portfolio.tombstones) || {}) };
        const sTomb = { ...((current.spending && current.spending.tombstones) || {}) };
        const portfolio = {}, spending = {};
        for (const k of this.PORTFOLIO_ARRAYS) {
            const m = this.mergeRecords((current.portfolio && current.portfolio[k]) || [], file.portfolio[k], pTomb, nowIso);
            portfolio[k] = m.rows; report.added += m.added; report.updated += m.updated; report.restored += m.restored.length;
            for (const id of m.restored) delete pTomb[id];
        }
        for (const k of this.SPENDING_ARRAYS) {
            const m = this.mergeRecords((current.spending && current.spending[k]) || [], file.spending[k], sTomb, nowIso);
            spending[k] = m.rows; report.added += m.added; report.updated += m.updated; report.restored += m.restored.length;
            for (const id of m.restored) delete sTomb[id];
        }
        const h = this.mergeSnapshots((current.history && current.history.snapshots) || [], file.history.snapshots);
        report.snapshots = h.added;
        return { portfolio: { ...portfolio, tombstones: pTomb }, history: { snapshots: h.rows }, spending: { ...spending, tombstones: sTomb }, report };
    },

    // ── The app side ───────────────────────────────────────────────────

    _current() {
        const has = typeof SpendingApp !== 'undefined';
        if (typeof PortfolioApp !== 'undefined') PortfolioApp.loadData();
        return {
            portfolio: StorageManager.get('portfolio') || {},
            history: StorageManager.get('portfolio-history') || { snapshots: (typeof PortfolioApp !== 'undefined' && PortfolioApp.valueHistory) || [] },
            spending: has ? SpendingApp.loadData() : (StorageManager.get('spending') || {})
        };
    },

    async exportToFile() {
        if (!window.electronFinanceFile?.save) return { error: 'Export is not available here.' };
        const file = this.build(this._current());
        const c = this.counts(file);
        if (!Object.values(c).some(Boolean)) return { error: 'Finance is empty: there is nothing to export yet.' };
        const res = await window.electronFinanceFile.save(JSON.stringify(file, null, 1), this.fileName());
        if (res && res.ok) return { ok: true, path: res.path, counts: c, summary: this.summary(c) };
        return res && res.canceled ? { canceled: true } : { error: (res && res.error) || 'Could not save the file.' };
    },

    /** Pick a file, say what is in it, merge on Import (FT3). */
    async importFromFile() {
        if (!window.electronFinanceFile?.open) return { error: 'Import is not available here.' };
        const f = await window.electronFinanceFile.open();
        if (!f || f.canceled) return { canceled: true };
        if (f.error) return { error: f.error };
        const file = this.parse(f.text);
        if (file.error) return file;
        const c = this.counts(file);
        const esc = s => UIUtils.escapeHtml(String(s));
        const when = file.exportedAt ? new Date(file.exportedAt).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
        const ok = await UIUtils.confirm(`Import Finance data${when ? ` from ${esc(when)}` : ''}?`,
            `<p>${esc(f.name)} holds ${esc(this.summary(c))}.</p>
             <p>Records are added beside what Finance already has; a record you have here is replaced only by a newer copy. Nothing here is removed.</p>
             <p>Links to brokerages and banks do not travel: link them again if you want them to keep syncing.</p>`,
            '', { confirmText: 'Import' });
        if (!ok) return { canceled: true };
        return this.apply(file);
    },

    apply(file) {
        const merged = this.plan(file, this._current());
        if (typeof PortfolioApp !== 'undefined') {
            for (const k of this.PORTFOLIO_ARRAYS) PortfolioApp[k] = merged.portfolio[k];
            PortfolioApp.tombstones = merged.portfolio.tombstones;
            PortfolioApp.saveData();
            PortfolioApp.valueHistory = merged.history.snapshots;
            PortfolioApp._saveHistory();
        } else {
            StorageManager.set('portfolio', merged.portfolio);
            StorageManager.set('portfolio-history', merged.history);
        }
        if (typeof SpendingApp !== 'undefined') {
            const d = SpendingApp.loadData();
            for (const k of this.SPENDING_ARRAYS) d[k] = merged.spending[k];
            d.tombstones = merged.spending.tombstones;
            SpendingApp.saveData(d);
        } else {
            const cur = StorageManager.get('spending') || {};
            StorageManager.set('spending', { ...cur, ...merged.spending, modifiedAt: new Date().toISOString() });
        }
        return { ok: true, ...merged.report };
    },

    sentence(r) {
        const bits = [r.added ? `${r.added} added` : '', r.updated ? `${r.updated} updated` : '', r.snapshots ? `${r.snapshots} snapshot${r.snapshots === 1 ? '' : 's'} added` : '']
            .filter(Boolean);
        return bits.length ? `Finance import: ${bits.join(', ')}` : 'Finance already had everything in that file';
    }
};

// Finance's settings page (2026-10-11, by request: "keep it in finance
// settings page and not in general settings"): reached from Finance's ⋯ menu,
// drawn in Settings' row style. Export, Import, and the door to linked
// brokerages and banks.
const FinanceSettings = {
    open() {
        document.getElementById('portfolio-view')?.classList.remove('active');
        document.getElementById('portfolio-settings-view')?.classList.add('active');
        Breadcrumb.render('portfolio-settings-breadcrumb', [
            { label: 'Finance', action: () => this.close() },
            { label: 'Settings' }
        ]);
        this.render();
    },
    close() {
        document.getElementById('portfolio-settings-view')?.classList.remove('active');
        document.getElementById('portfolio-view')?.classList.add('active');
        if (typeof PortfolioApp !== 'undefined') PortfolioApp.render();
    },
    render() {
        const host = document.getElementById('portfolio-settings-content');
        if (!host) return;
        const chev = '<svg class="ss-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
        const linking = typeof PortfolioBrokerage !== 'undefined' && PortfolioBrokerage.available();
        host.innerHTML = `<h1 class="ss-title">Finance settings</h1>
            <p class="ss-lede">Take everything in Finance out as one file, and bring it back later or into another Mac: accounts, transactions, holdings history, property, debts, strategies, watched tickers, and bank and card spending.</p>
            <div class="ss-group">
                <button type="button" class="ss-row" data-fs="export"><span class="ss-label">Export Finance data</span><span class="ss-value">JSON file</span>${chev}</button>
                <button type="button" class="ss-row" data-fs="import"><span class="ss-label">Import Finance data</span><span class="ss-value">From a file</span>${chev}</button>
            </div>
            ${linking ? `<div class="ss-group">
                <button type="button" class="ss-row" data-fs="linked"><span class="ss-label">Linked brokerages and banks</span>${chev}</button>
            </div>` : ''}`;
        if (!host._wired) {
            host._wired = true;
            host.addEventListener('click', e => {
                const b = e.target.closest('[data-fs]');
                if (b) this.act(b.dataset.fs, b);
            });
        }
    },
    async act(what, btn) {
        if (what === 'linked') { AppManager.openAppSettings('spending'); return; }
        btn.disabled = true;
        try {
            if (what === 'export') {
                const r = await FinanceTransfer.exportToFile();
                if (r.ok) UIUtils.showToast(`Exported ${UIUtils.escapeHtml(r.summary)}`, 'success', 6000);
                else if (r.error) UIUtils.showToast(UIUtils.escapeHtml(r.error), 'error', 6000);
            }
            if (what === 'import') {
                const r = await FinanceTransfer.importFromFile();
                if (r.ok) UIUtils.showToast(FinanceTransfer.sentence(r), 'success', 6000);
                else if (r.error) UIUtils.showToast(UIUtils.escapeHtml(r.error), 'error', 6000);
            }
        } finally { btn.disabled = false; }
    }
};

// The assistant does what Finance's settings page does (agent parity).
(function registerFinanceTransferTools() {
    if (typeof AgentTools === 'undefined') return;
    const common = { source: 'portfolio', group: 'portfolio', blockUntrusted: true };
    AgentTools.register({ type: 'function', function: {
        name: 'export_finance_data',
        description: 'Save all of the user\'s Finance data (accounts, transactions, holdings history snapshots, property, debts, strategies, watched tickers, bank and card transactions and category rules) to a JSON file they choose. Opens a save dialog.',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
    } }, async function export_finance_data(args, ctx) {
        if (ctx && ctx.ambient) return { error: 'Exporting needs the user present to choose where the file goes.' };
        const r = await FinanceTransfer.exportToFile();
        return r.canceled ? { canceled: true, note: 'The user closed the save dialog; nothing was saved.' } : r;
    }, common);
    AgentTools.register({ type: 'function', function: {
        name: 'import_finance_data',
        description: 'Bring Finance data back from a nenva Finance export (JSON). Opens a file picker; the user sees what the file holds and confirms. Records are merged by id, nothing is removed. Report the counts the result gives.',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
    } }, async function import_finance_data(args, ctx) {
        if (ctx && ctx.ambient) return { error: 'Importing needs the user present to pick and confirm the file.' };
        const r = await FinanceTransfer.importFromFile();
        if (r.ok) { try { PortfolioApp.render?.(); } catch { /* not on screen */ } }
        return r.canceled ? { canceled: true, note: 'The user closed the picker or chose not to import.' } : r;
    }, common);
})();
