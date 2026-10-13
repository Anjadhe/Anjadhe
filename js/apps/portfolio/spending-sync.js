/**
 * SpendingSync — linking banks and cards, and pulling their transactions,
 * through nenva Connect's Plaid service (docs/SPENDING.md).
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
    AUTO_CHECK_MS: 5 * 60 * 1000,       // how often a drawing of Finance may even consider a pull
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
            const id = await window.electronSync?.machineId?.();
            if (id) this._machineId = id;
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

    /** Link a bank or card, then add its accounts. Resolves to the accounts added. */
    async link() {
        if (!this.available() || this._linking) return [];
        this._linking = true;
        try {
            const done = await InstitutionLink.start({ products: InstitutionLink.PRODUCTS.bank, what: 'your bank' });
            if (!done) return [];
            const r = await this.addAccounts(done.item);
            if (r.error) this._toast(r.error, r.accounts.length ? 'info' : 'error');
            return r.accounts;
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
     * After a link (or "add the rest" later): every checking, savings and
     * credit account the institution reports that is not tracked yet is
     * added, named from the institution (2026-10-12, docs/THREAD_PANELS.md
     * step 3: no picker; the assistant says what was added and removes any
     * the person would rather not track). Adding runs the first sync.
     * Resolves to { accounts, error? }.
     */
    async addAccounts(item) {
        if (!item || !item.itemId) return { accounts: [], error: 'Nothing was linked.' };
        let data = null;
        for (let i = 0; i < 6; i++) {
            data = await window.electronBrokerage.accounts(item.itemId);
            if (!data.error || data.code !== 'PRODUCT_NOT_READY') break;
            await new Promise(r => setTimeout(r, 10000));
        }
        if (data.error) return { accounts: [], error: this._fail(data, 'Could not read the accounts') };
        SpendingApp.loadData();
        const tracked = new Set(SpendingApp.data.accounts.map(a => a.plaidAccountId));
        const banks = (data.accounts || []).filter(a => a && a.id && SpendingApp.isBankAccount(a));
        if (!banks.length) return { accounts: [], error: 'That institution reported no bank or card accounts.' };
        const created = banks.filter(a => !tracked.has(a.id)).map(a => this._createAccount(item, a, SpendingApp.accountNameFor(a, item.institution)));
        if (created.length) {
            SpendingApp.saveData();
            this.sync([item.itemId], { manual: false }).catch(() => {});
        }
        return { accounts: created };
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

    /** Called when Finance is drawn (a drawer): pull what is older than the TTL, quietly. */
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
        PortfolioApp.changed();
        // New rows are new facts (docs/MONEY_COACH.md): a row may settle the
        // bill it paid, and the coach may take a look.
        if (summary.added || summary.modified) {
            try {
                const settle = typeof MoneySettle !== 'undefined' ? MoneySettle.run() : Promise.resolve(0);
                settle.finally(() => { if (typeof MoneyCoach !== 'undefined') MoneyCoach.wake('bank'); });
            } catch { /* the sync itself is done */ }
        }
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
        PortfolioApp.changed();
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
// What Settings' "Linked institutions" card, Portfolio's delete hook and the
// linking tools may do without holding SpendingApp: see what rides on an
// item, sync, relink, add accounts, and drop an item's accounts locally.
if (typeof Anjadhe !== 'undefined') {
    Anjadhe.expose('spending', {
        available: () => SpendingSync.available(),
        usesItem: (itemId) => { SpendingApp.loadData(); return SpendingSync.usesItem(itemId); },
        links: () => { SpendingApp.loadData(); return SpendingApp.data.links.map(l => ({ ...l, here: SpendingSync.isHere(l) })); },
        accountsFor: (itemId) => { SpendingApp.loadData(); return SpendingApp.data.accounts.filter(a => a.itemId === itemId).map(a => ({ id: a.id, name: a.name, type: a.type, balance: a.balance })); },
        sync: (itemId) => SpendingSync.sync(itemId ? [itemId] : null, { manual: true }),
        relink: (itemId) => SpendingSync.relink(itemId),
        addAccounts: (item) => SpendingSync.addAccounts(item),
        unlink: (itemId, opts) => SpendingSync.unlink(itemId, opts),
        forgetItem: (itemId) => SpendingSync.forgetItem(itemId),
        /** Posted and pending rows of the last `days`, plain, for MoneySettle
         *  (a bank row settles the bill it paid). */
        rows(days = 90) {
            SpendingApp.loadData();
            const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
            return SpendingApp.transactions().filter(t => t && String(t.date) >= since).map(t => ({
                id: t.id, date: String(t.date).slice(0, 10), amount: t.amount, pending: !!t.pending,
                merchant: SpendingApp.merchantOf(t), account: SpendingApp.accountById(t.accountId)?.name || null }));
        },
        /** Plain numbers for the money fact sheet (js/core/money-facts.js):
         *  balances, this month and the three before it, the same point last
         *  month, and what comes back. null when nothing is linked. */
        facts() {
            SpendingApp.loadData();
            const accounts = SpendingApp.accounts();
            if (!accounts.length) return null;
            const today = SpendingApp.today();
            const month = SpendingApp.monthKey(today);
            const prev = SpendingApp.addMonths(month, -1);
            return {
                accounts: accounts.map(a => ({ name: a.name, type: a.type, balance: a.balance?.current ?? null, limit: a.balance?.limit ?? null })),
                months: [0, 1, 2, 3].map(i => {
                    const s = SpendingApp.summary(SpendingApp.addMonths(month, -i));
                    return { month: s.month, spend: s.spend, refunds: s.refunds, income: s.income, transfersOut: s.transfersOut,
                        byCategory: s.byCategory.slice(0, 6).map(c => ({ label: c.label, total: c.total })) };
                }),
                // The first day the bank's history covers: an earlier month is not a whole month.
                since: SpendingApp.transactions().reduce((d, t) => (t && t.date && (!d || String(t.date) < d) ? String(t.date).slice(0, 10) : d), null),
                samePointLastMonth: SpendingApp.summary(prev, { upTo: `${prev}-${today.slice(8, 10)}` }).spend,
                recurring: SpendingApp.recurring(SpendingApp.transactions(), SpendingApp.rules(), { today })
            };
        }
    });
}
