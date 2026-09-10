/**
 * SpendingSync — linking banks and cards, and pulling their transactions,
 * through Anjadhe Connect's Plaid service (docs/SPENDING.md).
 *
 * The Hosted Link flow itself is js/core/institution-link.js (shared with
 * Portfolio's brokerage linking). This module owns what Spending does with
 * a linked institution: which of its accounts to track, the cursor-paged
 * transaction sync, balances, sign-in-again, and unlinking. Spending asks
 * Plaid for Transactions first and Investments as an optional extra, so a
 * bank that also holds a brokerage can feed Portfolio from the same link
 * (Settings › Linked institutions offers "Add accounts" on both sides).
 */
const SpendingSync = {
    SYNC_TTL_MS: 4 * 60 * 60 * 1000,    // banks post through the day; four hours is plenty
    AUTO_CHECK_MS: 5 * 60 * 1000,       // how often render() may even consider a pull
    MAX_PAGES: 60,                      // × Connect's 500 rows = far past 24 months of anyone's spending

    _syncing: null,     // {done, total} while a run is in flight (BackgroundWork reads it)
    _lastAuto: 0,
    _machineId: null,
    _linking: false,

    available() {
        return typeof InstitutionLink !== 'undefined' && InstitutionLink.available();
    },

    async init() {
        if (!this.available()) return;
        try {
            const st = await window.electronSync?.getStatus?.();
            if (st && st.machineId) this._machineId = st.machineId;
        } catch { /* unknown machine: every link counts as here */ }
    },

    syncing() { return this._syncing; },

    _toast(msg, kind = 'info') {
        if (typeof UIUtils !== 'undefined') UIUtils.showToast(msg, kind);
    },

    _fail(r, fallback) {
        return InstitutionLink.failMessage(r, fallback);
    },

    linkById(itemId) {
        return SpendingApp.data.links.find(l => l && l.id === itemId) || null;
    },

    /** Linked on THIS Mac (its Connect key owns the item) — the one that may pull. */
    isHere(link) {
        const m = link?.linkedMachineId;
        return !m || !this._machineId || m === this._machineId;
    },

    usesItem(itemId) {
        return !!this.linkById(itemId) || SpendingApp.data.accounts.some(a => a.itemId === itemId);
    },

    // ── Linking ──────────────────────────────────────────────────────────

    /** Link a bank or card, then offer its accounts. Resolves to the accounts added. */
    async link() {
        if (!this.available() || this._linking) return [];
        this._linking = true;
        try {
            const done = await InstitutionLink.start({ products: InstitutionLink.PRODUCTS.bank, what: 'your bank' });
            if (!done) return [];
            return await this.pickAccounts(done.item);
        } finally {
            this._linking = false;
        }
    },

    /** Re-authorise an expired link in place (Plaid update mode). */
    async relink(itemId) {
        if (!this.available() || this._linking) return false;
        this._linking = true;
        try {
            const done = await InstitutionLink.start({ itemId });
            if (!done) return false;
            const link = this.linkById(itemId);
            if (link) { link.needsLogin = false; link.updatedAt = new Date().toISOString(); SpendingApp.saveData(); }
            this._toast('Signed in again', 'success');
            return true;
        } finally {
            this._linking = false;
        }
    },

    /**
     * Account picker after a link (or "Add accounts" later): the
     * institution's checking, savings and credit accounts, pre-named,
     * checked unless already tracked. Adding runs the first sync.
     */
    async pickAccounts(item) {
        if (!item || !item.itemId) return [];
        let data = null;
        for (let i = 0; i < 6; i++) {
            data = await window.electronBrokerage.accounts(item.itemId);
            if (!data.error || data.code !== 'PRODUCT_NOT_READY') break;
            if (i === 0) this._toast(`Waiting for ${item.institution || 'the bank'} to prepare your data…`, 'info');
            await new Promise(r => setTimeout(r, 10000));
        }
        if (data.error) { this._toast(this._fail(data, 'Could not read the accounts'), 'error'); return []; }
        const tracked = new Set(SpendingApp.data.accounts.map(a => a.plaidAccountId));
        const accounts = (data.accounts || []).filter(a => a && a.id && SpendingApp.isBankAccount(a));
        if (!accounts.length) { this._toast('That institution reported no bank or card accounts', 'info'); return []; }
        const esc = (s) => (typeof UIUtils !== 'undefined' ? UIUtils.escapeHtml(String(s ?? '')) : String(s ?? ''));
        const fmt = (n) => SpendingUI.money(n);
        const rowsHtml = accounts.map((a, i) => {
            const have = tracked.has(a.id);
            const bal = a.balance?.current;
            return `<label class="spending-link-row${have ? ' is-linked' : ''}">
                <input type="checkbox" data-idx="${i}" ${have ? 'disabled' : 'checked'}>
                <span class="spending-link-main">
                    <input type="text" class="spending-link-name" data-idx="${i}" value="${esc(SpendingApp.accountNameFor(a, item.institution))}" ${have ? 'disabled' : ''}>
                    <span class="spending-link-meta">${esc(a.subtype || a.type || '')}${bal != null ? ` · ${esc(fmt(bal))}${a.type === 'credit' ? ' owed' : ''}` : ''}${have ? ' · already in Spending' : ''}</span>
                </span>
            </label>`;
        }).join('');
        return new Promise((resolve) => {
            let settled = false;
            const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
            const modal = Modal.create({
                title: `Add accounts from ${item.institution || 'your bank'}`,
                className: 'spending-link-modal',
                content: `
                    <p class="spending-link-lede">Each account’s transactions from the last two years come in now; new ones arrive when you open Spending, a few times a day, and you can Sync now any time. Everything passes through Anjadhe Cloud on its way here and is not kept there.</p>
                    <div class="spending-link-list">${rowsHtml}</div>`,
                buttons: [
                    { text: 'Cancel', className: 'secondary-btn', onClick: () => { modal.close(); finish([]); } },
                    {
                        text: 'Add accounts', className: 'primary-btn', onClick: () => {
                            const chosen = [];
                            modal.element.querySelectorAll('input[type="checkbox"][data-idx]').forEach(cb => {
                                if (!cb.checked || cb.disabled) return;
                                const i = Number(cb.dataset.idx);
                                const nameEl = modal.element.querySelector(`input.spending-link-name[data-idx="${i}"]`);
                                chosen.push({ plaid: accounts[i], name: (nameEl?.value || '').trim() || SpendingApp.accountNameFor(accounts[i], item.institution) });
                            });
                            const created = chosen.map(c => this._createAccount(item, c.plaid, c.name));
                            // Settle BEFORE close: closing fires onClose, which
                            // would otherwise resolve the picker with [].
                            finish(created);
                            modal.close();
                            if (created.length) {
                                SpendingApp.saveData();
                                this._toast(`Added ${created.length} account${created.length === 1 ? '' : 's'} from ${item.institution || 'your bank'} — pulling transactions…`, 'success');
                                this.sync([item.itemId], { manual: true }).catch(() => {});
                            }
                        }
                    }
                ],
                onClose: () => finish([])
            });
        });
    },

    _ensureLink(item) {
        let link = this.linkById(item.itemId);
        const now = new Date().toISOString();
        if (!link) {
            link = {
                id: item.itemId,
                institution: item.institution || null,
                products: Array.isArray(item.products) ? item.products : ['transactions'],
                linkedMachineId: this._machineId || null,
                cursor: null,
                lastSyncAt: null,
                needsLogin: false,
                createdAt: now,
                updatedAt: now
            };
            SpendingApp.data.links.push(link);
        }
        return link;
    },

    _createAccount(item, plaidAccount, name) {
        const link = this._ensureLink(item);
        const now = new Date().toISOString();
        const account = {
            id: crypto.randomUUID(),
            name,
            type: SpendingApp.accountTypeFor(plaidAccount),
            institution: item.institution || null,
            mask: plaidAccount.mask || null,
            itemId: link.id,
            plaidAccountId: plaidAccount.id,
            balance: this._balanceOf(plaidAccount),
            createdAt: now,
            updatedAt: now
        };
        SpendingApp.data.accounts.push(account);
        return account;
    },

    _balanceOf(plaidAccount) {
        const b = plaidAccount?.balance || {};
        return {
            current: b.current != null ? b.current : null,
            available: b.available != null ? b.available : null,
            limit: b.limit != null ? b.limit : null,
            currency: b.currency || 'USD',
            asOf: new Date().toISOString()
        };
    },

    // ── Syncing ──────────────────────────────────────────────────────────

    /** Called from SpendingApp.render: pull what is older than the TTL, quietly. */
    ensureFresh() {
        if (!this.available() || this._syncing) return;
        const now = Date.now();
        if (now - this._lastAuto < this.AUTO_CHECK_MS) return;
        this._lastAuto = now;
        const due = SpendingApp.data.links.filter(l => this.isHere(l) && !l.needsLogin
            && (!l.lastSyncAt || now - Date.parse(l.lastSyncAt) > this.SYNC_TTL_MS));
        if (due.length) this.sync(due.map(l => l.id), { manual: false }).catch(() => {});
    },

    /**
     * Pull balances + the transaction diff for the given links (default:
     * every one linked on this Mac). Pages until has_more is false, then
     * saves the cursor; a run that dies mid-way keeps the old cursor and
     * asks for the same pages again (rows are keyed by id, so nothing
     * lands twice).
     */
    async sync(itemIds = null, { manual = false } = {}) {
        if (!this.available()) return { synced: 0 };
        if (this._syncing) return { synced: 0, busy: true };
        SpendingApp.loadData();
        let targets = SpendingApp.data.links.filter(l => this.isHere(l));
        if (Array.isArray(itemIds)) targets = targets.filter(l => itemIds.includes(l.id));
        if (!targets.length) return { synced: 0 };
        this._syncing = { done: 0, total: targets.length };
        const summary = { synced: 0, added: 0, modified: 0, removed: 0, errors: [] };
        const blob = SpendingApp.data;
        try {
            for (const link of targets) {
                try {
                    // Balances first — cheap, and the page shows them even
                    // when the transaction pull below is slow.
                    const acc = await window.electronBrokerage.accounts(link.id);
                    if (acc.error) throw Object.assign(new Error(acc.error), { code: acc.code });
                    const byPlaid = new Map((acc.accounts || []).map(a => [a.id, a]));
                    const now = new Date().toISOString();
                    for (const a of blob.accounts) {
                        if (a.itemId !== link.id) continue;
                        const p = byPlaid.get(a.plaidAccountId);
                        if (p) { a.balance = this._balanceOf(p); a.updatedAt = now; }
                    }
                    const accountIdFor = (plaidId) => blob.accounts.find(a => a.itemId === link.id && a.plaidAccountId === plaidId)?.id || null;

                    let cursor = link.cursor || null;
                    let pages = 0;
                    const counts = { added: 0, modified: 0, removed: 0 };
                    for (;;) {
                        const page = await window.electronBrokerage.transactionsSync(link.id, cursor || undefined);
                        if (page.error) throw Object.assign(new Error(page.error), { code: page.code });
                        const c = SpendingApp.applySyncPage(blob, page, accountIdFor, { now });
                        counts.added += c.added; counts.modified += c.modified; counts.removed += c.removed;
                        cursor = page.cursor || cursor;
                        if (!page.hasMore || ++pages >= this.MAX_PAGES) break;
                    }
                    link.cursor = cursor;
                    link.lastSyncAt = new Date().toISOString();
                    link.needsLogin = false;
                    link.updatedAt = link.lastSyncAt;
                    summary.synced++;
                    summary.added += counts.added; summary.modified += counts.modified; summary.removed += counts.removed;
                } catch (e) {
                    if (e.code === 'login_required') {
                        link.needsLogin = true;
                        link.updatedAt = new Date().toISOString();
                        summary.errors.push(`${link.institution || 'A bank'} needs you to sign in again`);
                    } else {
                        summary.errors.push(`${link.institution || 'A bank'}: ${this._fail(e, e.message)}`);
                    }
                } finally {
                    this._syncing.done++;
                }
            }
            summary.pruned = SpendingApp.pruneOld(blob, { today: SpendingApp.today() });
            SpendingApp.saveData(blob);   // THIS blob — a render mid-pull may have reloaded _data
            if (summary.added || summary.pruned) {
                const months = {};
                for (const t of blob.transactions) { const m = SpendingApp.monthKey(t.date); months[m] = (months[m] || 0) + 1; }
                console.log('[spending] sync:', summary.added, 'added,', summary.pruned, 'older than', SpendingApp.HISTORY_MONTHS, 'months dropped; rows by month:', months);
            }
        } finally {
            this._syncing = null;
        }
        if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'spending') SpendingApp.render();
        if (typeof Widgets !== 'undefined' && typeof Widgets.refresh === 'function') { try { Widgets.refresh(); } catch { /* home not open */ } }
        if (manual) {
            if (summary.errors.length) this._toast(summary.errors[0], 'error');
            else this._toast(summary.added
                ? `Synced — ${summary.added} new transaction${summary.added === 1 ? '' : 's'}${summary.pruned ? ` (${summary.pruned} older than ${SpendingApp.HISTORY_MONTHS} months not kept)` : ''}`
                : 'Synced — up to date', 'success');
        }
        return summary;
    },

    // ── Unlinking ────────────────────────────────────────────────────────

    /**
     * Sever an institution: Connect removes the Plaid Item (unless
     * `remote:false` — Settings has already done it through Portfolio for
     * a link both apps share), and its Spending accounts and their
     * transactions leave the app. Tombstoned, so the other Mac drops them
     * too.
     */
    async unlink(itemId, { remote = true } = {}) {
        if (!this.available()) return false;
        if (remote) {
            const r = await window.electronBrokerage.unlink(itemId);
            if (r.error && r.code !== 'not_found') { this._toast(this._fail(r, 'Could not unlink'), 'error'); return false; }
        }
        this.forgetItem(itemId);
        return true;
    },

    /** Local half of unlink: drop the link, its accounts and their rows. */
    forgetItem(itemId) {
        SpendingApp.loadData();
        const blob = SpendingApp.data;
        const accountIds = new Set(blob.accounts.filter(a => a.itemId === itemId).map(a => a.id));
        if (!accountIds.size && !this.linkById(itemId)) return false;
        for (const t of blob.transactions) if (accountIds.has(t.accountId)) SpendingApp._tombstone(t.id);
        blob.transactions = blob.transactions.filter(t => !accountIds.has(t.accountId));
        for (const id of accountIds) SpendingApp._tombstone(id);
        blob.accounts = blob.accounts.filter(a => a.itemId !== itemId);
        if (this.linkById(itemId)) SpendingApp._tombstone(itemId);
        blob.links = blob.links.filter(l => l.id !== itemId);
        SpendingApp.saveData();
        if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'spending') SpendingApp.render();
        return true;
    },

    /** "Chase · synced 2h ago · needs sign-in" for one link. */
    statusLine(link) {
        if (!link) return null;
        let when = 'not synced yet';
        if (link.lastSyncAt) {
            const mins = Math.max(0, Math.round((Date.now() - Date.parse(link.lastSyncAt)) / 60000));
            when = mins < 2 ? 'synced just now' : mins < 60 ? `synced ${mins} min ago` : mins < 36 * 60 ? `synced ${Math.round(mins / 60)}h ago` : `synced ${Math.round(mins / 1440)}d ago`;
        }
        const parts = [when];
        if (!this.isHere(link)) parts.push('syncs from the Mac that linked it');
        if (link.needsLogin) parts.push('needs sign-in');
        return { text: parts.join(' · '), needsLogin: !!link.needsLogin, here: this.isHere(link) };
    }
};

// ── Cross-app API (Anjadhe.use('spending')) ────────────────────────────
// What Settings' "Linked institutions" card and Portfolio's delete hook may
// do without holding SpendingApp: see what rides on an item, sync, relink,
// pick accounts, and drop an item's accounts locally.
if (typeof Anjadhe !== 'undefined') {
    Anjadhe.expose('spending', {
        available: () => SpendingSync.available(),
        usesItem: (itemId) => { SpendingApp.loadData(); return SpendingSync.usesItem(itemId); },
        links: () => { SpendingApp.loadData(); return SpendingApp.data.links.map(l => ({ ...l, here: SpendingSync.isHere(l) })); },
        accountsFor: (itemId) => { SpendingApp.loadData(); return SpendingApp.data.accounts.filter(a => a.itemId === itemId).map(a => ({ id: a.id, name: a.name, type: a.type, balance: a.balance })); },
        sync: (itemId) => SpendingSync.sync(itemId ? [itemId] : null, { manual: true }),
        relink: (itemId) => SpendingSync.relink(itemId),
        pickAccounts: (item) => SpendingSync.pickAccounts(item),
        unlink: (itemId, opts) => SpendingSync.unlink(itemId, opts),
        forgetItem: (itemId) => SpendingSync.forgetItem(itemId)
    });
}
