/**
 * PortfolioBrokerage — linked brokerage accounts (Fidelity, Robinhood, …)
 * through Anjadhe Connect's Plaid service (docs/PORTFOLIO.md "Brokerage
 * linking"). The laws, in brief:
 *
 *  - The Mac holds NO Plaid credential. Connect keeps the sealed access
 *    token; a Portfolio account carries only `brokerage: {itemId,
 *    plaidAccountId, institution, mask, linkedMachineId, seededAt,
 *    lastTxnDate, lastSyncAt, needsLogin, drift}` on the synced record.
 *  - The user signs in on the brokerage's OWN page (Plaid Hosted Link in the
 *    default browser); the renderer polls Connect until it finishes.
 *  - Holdings and transactions are proxied by Connect and land HERE, written
 *    into the record-merged portfolio blob like any user edit: every write
 *    stamps `updatedAt`, every transaction carries `sourceRef`
 *    ('plaid:<investment_transaction_id>', the sourceEmailId law) so both
 *    Macs converge and nothing lands twice.
 *  - The Mac that linked is the Mac that pulls (Connect keys are per Mac);
 *    the other Mac reads what sync brings, exactly like Gmail.
 *  - Refresh is on open, TTL-gated (Plaid updates investments about once a
 *    day), plus "Sync now". No background poll.
 *  - First sync SEEDS positions as `holding` rows (the money was spent before
 *    tracking started) and pulls transactions from the day AFTER; later syncs
 *    pull from lastTxnDate minus an overlap window and dedupe by id. Cash is
 *    the broker's cash balance, never derived. Differences between computed
 *    and broker positions are reported as DRIFT and fixed only through the
 *    review modal — nothing rewrites a position by itself.
 *
 * The mapping functions at the top are pure over plain data and Node-
 * exported; tests/portfolio-brokerage-test.js pins them.
 */
const PortfolioBrokerage = {
    SYNC_TTL_MS: 20 * 60 * 60 * 1000,   // one pull a day is Plaid's own cadence
    OVERLAP_DAYS: 7,                    // re-pull window; ids dedupe
    AUTO_CHECK_MS: 5 * 60 * 1000,       // how often render() may even consider a pull
    TXN_LOOKBACK_DAYS: 0,               // seed covers history; see seedFromHoldings

    _syncing: null,     // {done, total} while a run is in flight (BackgroundWork reads it)
    _lastAuto: 0,
    _machineId: null,
    _linking: false,

    // ── Pure mapping (Node-exported) ─────────────────────────────────────

    /** OCC symbol, the same shape PortfolioApp.buildOccSymbol writes. */
    occSymbol(underlying, expiration, optionType, strike) {
        if (!underlying || !expiration || !(strike > 0)) return null;
        const yymmdd = String(expiration).slice(2).replace(/-/g, '');
        if (!/^\d{6}$/.test(yymmdd)) return null;
        const cp = optionType === 'put' ? 'P' : 'C';
        return `${String(underlying).toUpperCase()}${yymmdd}${cp}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
    },

    /**
     * The ticker a Plaid security maps to in the portfolio, or null when it
     * has no place there (cash, a security Plaid could not identify, a
     * fund with no symbol). Options become OCC symbols from the contract
     * fields even when the broker's own symbol is missing or odd.
     */
    tickerFor(security) {
        if (!security || security.cash) return null;
        const o = security.option;
        if (o) {
            const occ = this.occSymbol(o.underlying, o.expiration, o.type, o.strike);
            if (occ) return occ;
        }
        const t = String(security.ticker || '').trim().toUpperCase();
        if (!t || t.startsWith('CUR:') || /\s/.test(t)) return null;
        if (t.length > 20) return null;
        return t;
    },

    multiplierFor(security) {
        return security && security.option ? 100 : 1;
    },

    /** Plaid account subtype → the portfolio's account type vocabulary. */
    accountTypeFor(plaidAccount) {
        const s = String(plaidAccount?.subtype || '').toLowerCase();
        if (!s) return 'brokerage';
        if (s === 'brokerage' || s === 'non-taxable brokerage account' || s === 'stock plan' || s === 'trust' || s === 'ugma' || s === 'utma') return 'brokerage';
        if (/^(401k|401a|403b|457b|thrift savings plan|profit sharing plan|pension)$/.test(s)) return '401k';
        if (/^roth/.test(s)) return 'roth-ira';
        if (/ira$/.test(s)) return 'ira';
        if (s === 'hsa') return 'hsa';
        if (s === 'cash management') return 'checking';
        return 'other';
    },

    /** Suggested Portfolio name: "Fidelity Individual ····1234". */
    accountNameFor(plaidAccount, institution) {
        const inst = String(institution || '').trim();
        const nm = String(plaidAccount?.name || plaidAccount?.officialName || 'Account').trim();
        const base = inst && !nm.toLowerCase().includes(inst.toLowerCase()) ? `${inst} ${nm}` : nm;
        return plaidAccount?.mask ? `${base} ····${plaidAccount.mask}` : base;
    },

    /** The broker's cash in one account (cash-equivalent holdings summed). */
    cashOf(holdings, plaidAccountId) {
        let sum = 0, any = false;
        for (const h of holdings || []) {
            if (h.accountId !== plaidAccountId || !h.security?.cash) continue;
            const v = h.value != null ? h.value : (h.quantity || 0) * (h.price != null ? h.price : 1);
            if (Number.isFinite(v)) { sum += v; any = true; }
        }
        return any ? Math.round(sum * 100) / 100 : null;
    },

    /**
     * Broker positions in one account as {ticker, quantity, costBasis,
     * price, mult} — the shape both seeding and drift compare against.
     */
    positionsOf(holdings, plaidAccountId) {
        const out = new Map();
        for (const h of holdings || []) {
            if (h.accountId !== plaidAccountId) continue;
            const ticker = this.tickerFor(h.security);
            if (!ticker || !(h.quantity > 0)) continue;
            const cur = out.get(ticker) || { ticker, quantity: 0, costBasis: 0, price: null, mult: this.multiplierFor(h.security), hasCost: false };
            cur.quantity += h.quantity;
            if (h.costBasis != null && Number.isFinite(h.costBasis)) { cur.costBasis += h.costBasis; cur.hasCost = true; }
            if (h.price != null) cur.price = h.price;
            out.set(ticker, cur);
        }
        return [...out.values()];
    },

    /**
     * First-sync seed: one `holding` row per broker position, priced at the
     * broker's average cost (per share; per-share premium for options).
     * With no cost basis from the broker the current price stands in and
     * the note says so — a gain figure built on it would be fiction.
     */
    seedFromHoldings(holdings, { accountId, plaidAccountId, institution, today }) {
        const rows = [];
        for (const p of this.positionsOf(holdings, plaidAccountId)) {
            const perShare = p.hasCost && p.quantity > 0
                ? p.costBasis / (p.quantity * p.mult)
                : (p.price != null ? p.price : 0);
            rows.push({
                accountId,
                type: 'holding',
                ticker: p.ticker,
                quantity: p.quantity,
                pricePerShare: Math.round(perShare * 10000) / 10000,
                date: today,
                notes: p.hasCost
                    ? `Position at link from ${institution || 'brokerage'}`
                    : `Position at link from ${institution || 'brokerage'} (no cost basis reported; priced at market)`,
                source: 'plaid',
                sourceRef: `plaid:seed:${plaidAccountId}:${p.ticker}`
            });
        }
        return rows;
    },

    /**
     * Per-share price for a trade. Plaid's `price` is usually per share, but
     * some brokers quote options per contract; the total `amount` settles
     * it — whichever reading reproduces the amount wins.
     */
    perSharePrice(t, mult) {
        const qty = Math.abs(t.quantity || 0);
        const amt = Math.abs(t.amount || 0);
        const p = Math.abs(t.price || 0);
        if (!(qty > 0)) return p;
        if (!(amt > 0)) return p;
        if (mult === 1 || !(p > 0)) return amt / qty / mult;
        const asPerShare = Math.abs(p * qty * mult - amt);
        const asPerContract = Math.abs(p * qty - amt);
        return asPerContract < asPerShare ? p / mult : p;
    },

    /**
     * Plaid investment transactions → portfolio transaction rows. Trades
     * become buy/sell; dividends, deposits, withdrawals, interest and fees
     * become `cash` rows (a ledger the holdings math ignores; cash itself
     * comes from the broker's balance). Cancels and anything without a
     * place in the book are dropped. `sourceRef` is the dedup key.
     */
    mapTransactions(txns, { accountId, plaidAccountId }) {
        const out = [];
        for (const t of txns || []) {
            if (!t || t.accountId !== plaidAccountId || !t.id || !t.date) continue;
            const type = String(t.type || '').toLowerCase();
            const subtype = String(t.subtype || '').toLowerCase();
            if (type === 'cancel') continue;
            const ticker = this.tickerFor(t.security);
            const mult = this.multiplierFor(t.security);
            const base = { accountId, date: String(t.date).slice(0, 10), source: 'plaid', sourceRef: `plaid:${t.id}`, notes: String(t.name || '').slice(0, 140) };
            if ((type === 'buy' || type === 'sell') && ticker && Math.abs(t.quantity || 0) > 0) {
                out.push({
                    ...base,
                    type,
                    ticker,
                    quantity: Math.abs(t.quantity),
                    pricePerShare: Math.round(this.perSharePrice(t, mult) * 10000) / 10000,
                    fees: t.fees || 0
                });
                continue;
            }
            if (type === 'cash' || type === 'fee' || type === 'transfer' || ((type === 'buy' || type === 'sell') && !ticker)) {
                // Plaid: positive amount = cash LEAVES the account. Store the
                // account's point of view: +in, −out.
                const amount = Math.round(-(t.amount || 0) * 100) / 100;
                if (!amount) continue;
                out.push({
                    ...base,
                    type: 'cash',
                    subtype: subtype || type,
                    ticker: ticker || null,
                    quantity: 0,
                    pricePerShare: 0,
                    amount
                });
            }
        }
        return out;
    },

    /**
     * Drift between computed positions and the broker's: what a Sync found
     * but did not touch. `local` is [{ticker, shares}] (computeHoldings),
     * broker is positionsOf(). Each row carries the one transaction that
     * would close the gap; applying it is the user's click.
     */
    reconcile(local, broker, { today } = {}) {
        const eps = 0.0001;
        const rows = [];
        const seen = new Set();
        const mine = new Map((local || []).map(h => [h.ticker, h.shares || h.totalShares || 0]));
        for (const b of broker || []) {
            seen.add(b.ticker);
            const have = mine.get(b.ticker) || 0;
            const diff = b.quantity - have;
            if (Math.abs(diff) <= eps) continue;
            const perShare = b.hasCost && b.quantity > 0 ? b.costBasis / (b.quantity * b.mult) : (b.price != null ? b.price : 0);
            rows.push({
                ticker: b.ticker, local: have, broker: b.quantity, diff,
                fix: diff > 0
                    ? { type: 'holding', quantity: diff, pricePerShare: Math.round(perShare * 10000) / 10000, date: today }
                    : { type: 'sell', quantity: -diff, pricePerShare: Math.round((b.price != null ? b.price : perShare) * 10000) / 10000, date: today }
            });
        }
        for (const [ticker, shares] of mine) {
            if (seen.has(ticker) || !(shares > eps)) continue;
            rows.push({ ticker, local: shares, broker: 0, diff: -shares, fix: { type: 'sell', quantity: shares, pricePerShare: 0, date: today } });
        }
        return rows;
    },

    /** Pull window start: the day after the seed on a first pull, else lastTxnDate minus the overlap. */
    since(brokerage, today, overlapDays = this.OVERLAP_DAYS) {
        const addDays = (iso, n) => {
            const d = new Date(iso + 'T00:00:00Z');
            d.setUTCDate(d.getUTCDate() + n);
            return d.toISOString().slice(0, 10);
        };
        if (!brokerage?.lastTxnDate) return addDays(brokerage?.seededAt || today, 1);
        const s = addDays(brokerage.lastTxnDate, -overlapDays);
        const floor = addDays(brokerage.seededAt || s, 1);
        return s < floor ? floor : s;
    },

    // ── Renderer state ───────────────────────────────────────────────────

    /** Behind the `brokerage` feature flag (js/core/features.js) — every door reads this. */
    available() {
        return typeof InstitutionLink !== 'undefined' && InstitutionLink.available();
    },

    async init() {
        if (!this.available()) return;
        try {
            const st = await window.electronSync?.getStatus?.();
            if (st && st.machineId) this._machineId = st.machineId;
        } catch { /* unknown machine: every linked account counts as here */ }
    },

    today() {
        return (typeof UIUtils !== 'undefined') ? UIUtils.todayISO() : new Date().toISOString().slice(0, 10);
    },

    linkedAccounts() {
        return (PortfolioApp.getAccounts() || []).filter(a => a && a.brokerage && a.brokerage.itemId);
    },

    /** Linked on THIS Mac (its Connect key owns the item) — the one that may pull. */
    isHere(account) {
        const m = account?.brokerage?.linkedMachineId;
        return !m || !this._machineId || m === this._machineId;
    },

    syncing() {
        return this._syncing;
    },

    _toast(msg, kind = 'info') {
        if (typeof UIUtils !== 'undefined') UIUtils.showToast(msg, kind);
    },

    _fail(r, fallback) {
        return InstitutionLink.failMessage(r, fallback);
    },

    // ── Linking ──────────────────────────────────────────────────────────
    // The Hosted Link flow itself (open the browser, poll Connect, the
    // error sentences) is js/core/institution-link.js, shared with
    // Spending. Portfolio asks for the Investments product only, so a
    // brokerage link never bills Plaid Transactions.

    /**
     * Link a new institution: open Hosted Link in the browser, poll until
     * the user finishes there, then offer the institution's accounts.
     * Resolves to the created Portfolio accounts (possibly none).
     */
    async link() {
        if (!this.available() || this._linking) return [];
        this._linking = true;
        try {
            const done = await InstitutionLink.start({ products: InstitutionLink.PRODUCTS.brokerage, what: 'your brokerage' });
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
            for (const a of this.linkedAccounts()) {
                if (a.brokerage.itemId === itemId) { a.brokerage.needsLogin = false; a.updatedAt = new Date().toISOString(); }
            }
            PortfolioApp.saveData();
            this._toast('Signed in again', 'success');
            return true;
        } finally {
            this._linking = false;
        }
    },

    /**
     * Account picker after a link: every account the institution reports,
     * pre-named, checked unless already in Portfolio. Creating one seeds
     * its positions as holdings and sets the broker's cash.
     */
    async pickAccounts(item) {
        if (!item || !item.itemId) return [];
        // Freshly linked Items can answer PRODUCT_NOT_READY for a little
        // while (Connect already waits ~14s per call); keep asking for up
        // to a minute more before giving up.
        let data = null;
        for (let i = 0; i < 6; i++) {
            data = await window.electronBrokerage.holdings(item.itemId);
            if (!data.error || data.code !== 'PRODUCT_NOT_READY') break;
            if (i === 0) this._toast(`Waiting for ${item.institution || 'the brokerage'} to prepare your data…`, 'info');
            await new Promise(r => setTimeout(r, 10000));
        }
        if (data.error) { this._toast(this._fail(data, 'Could not read the accounts'), 'error'); return []; }
        const existing = new Set(this.linkedAccounts().map(a => a.brokerage.plaidAccountId));
        const accounts = (data.accounts || []).filter(a => a && a.id);
        if (!accounts.length) { this._toast('That brokerage reported no investment accounts', 'info'); return []; }
        const esc = (s) => (typeof UIUtils !== 'undefined' ? UIUtils.escapeHtml(String(s ?? '')) : String(s ?? ''));
        const fmt = (n) => (typeof PortfolioUI !== 'undefined' ? PortfolioUI.formatMoney(n) : String(n));
        const rowsHtml = accounts.map((a, i) => {
            const linked = existing.has(a.id);
            const positions = this.positionsOf(data.holdings, a.id).length;
            const cash = this.cashOf(data.holdings, a.id);
            const value = a.balance?.current;
            return `<label class="portfolio-link-row${linked ? ' is-linked' : ''}">
                <input type="checkbox" data-idx="${i}" ${linked ? 'disabled' : 'checked'}>
                <span class="portfolio-link-main">
                    <input type="text" class="portfolio-link-name" data-idx="${i}" value="${esc(this.accountNameFor(a, item.institution))}" ${linked ? 'disabled' : ''}>
                    <span class="portfolio-link-meta">${esc(a.subtype || a.type || '')}${value != null ? ` · ${esc(fmt(value))}` : ''} · ${positions} position${positions === 1 ? '' : 's'}${cash != null ? ` · ${esc(fmt(cash))} cash` : ''}${linked ? ' · already in Portfolio' : ''}</span>
                </span>
            </label>`;
        }).join('');
        return new Promise((resolve) => {
            let settled = false;
            const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
            const modal = Modal.create({
                title: `Add accounts from ${item.institution || 'your brokerage'}`,
                className: 'portfolio-link-modal',
                content: `
                    <p class="portfolio-link-lede">Each account becomes a Portfolio account with today’s positions and cash from ${esc(item.institution || 'the brokerage')}. Trades from tomorrow on are picked up when you open Portfolio, about once a day, and you can Sync now any time.</p>
                    <div class="portfolio-link-list">${rowsHtml}</div>`,
                buttons: [
                    { text: 'Cancel', className: 'secondary-btn', onClick: () => { modal.close(); finish([]); } },
                    {
                        text: 'Add accounts', className: 'primary-btn', onClick: () => {
                            const chosen = [];
                            modal.element.querySelectorAll('input[type="checkbox"][data-idx]').forEach(cb => {
                                if (!cb.checked || cb.disabled) return;
                                const i = Number(cb.dataset.idx);
                                const nameEl = modal.element.querySelector(`input.portfolio-link-name[data-idx="${i}"]`);
                                chosen.push({ plaid: accounts[i], name: (nameEl?.value || '').trim() || this.accountNameFor(accounts[i], item.institution) });
                            });
                            const created = chosen.map(c => this._createLinkedAccount(item, c.plaid, c.name, data.holdings));
                            // Settle BEFORE close: closing fires onClose, which
                            // would otherwise resolve the picker with [].
                            finish(created);
                            modal.close();
                            if (created.length) {
                                PortfolioApp.saveData();
                                if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'portfolio') PortfolioApp.render();
                                this._toast(`Added ${created.length} account${created.length === 1 ? '' : 's'} from ${item.institution || 'your brokerage'}`, 'success');
                            }
                            finish(created);
                        }
                    }
                ],
                onClose: () => finish([])
            });
        });
    },

    _createLinkedAccount(item, plaidAccount, name, holdings) {
        const now = new Date().toISOString();
        const today = this.today();
        const account = {
            id: crypto.randomUUID(),
            name,
            type: this.accountTypeFor(plaidAccount),
            cashBalance: this.cashOf(holdings, plaidAccount.id),
            source: 'plaid',        // link-born; survives unlink stripping `brokerage`
            createdAt: now,
            updatedAt: now,
            brokerage: {
                itemId: item.itemId,
                plaidAccountId: plaidAccount.id,
                institution: item.institution || null,
                mask: plaidAccount.mask || null,
                linkedMachineId: this._machineId || null,
                seededAt: today,
                lastTxnDate: today,
                lastSyncAt: now,
                needsLogin: false,
                drift: []
            }
        };
        PortfolioApp.accounts.push(account);
        const seed = this.seedFromHoldings(holdings, { accountId: account.id, plaidAccountId: plaidAccount.id, institution: item.institution, today });
        for (const row of seed) PortfolioApp.transactions.push({ id: crypto.randomUUID(), createdAt: now, updatedAt: now, ...row });
        return account;
    },

    // ── Syncing ──────────────────────────────────────────────────────────

    /** Called from PortfolioApp.render: pull what is older than the TTL, quietly. */
    ensureFresh() {
        if (!this.available() || this._syncing) return;
        const now = Date.now();
        if (now - this._lastAuto < this.AUTO_CHECK_MS) return;
        this._lastAuto = now;
        const due = this.linkedAccounts().filter(a => this.isHere(a) && !a.brokerage.needsLogin
            && (!a.brokerage.lastSyncAt || now - Date.parse(a.brokerage.lastSyncAt) > this.SYNC_TTL_MS));
        if (due.length) this.sync(due.map(a => a.id), { manual: false }).catch(() => {});
    },

    /**
     * Pull holdings + transactions for the given linked accounts (default:
     * every one linked on this Mac). Manual runs report; quiet runs only
     * record drift on the account for the header to mention.
     */
    async sync(accountIds = null, { manual = false } = {}) {
        if (!this.available()) return { synced: 0 };
        if (this._syncing) return { synced: 0, busy: true };
        PortfolioApp.loadData();
        let targets = this.linkedAccounts().filter(a => this.isHere(a));
        if (Array.isArray(accountIds)) targets = targets.filter(a => accountIds.includes(a.id));
        if (!targets.length) return { synced: 0 };
        this._syncing = { done: 0, total: targets.length };
        const today = this.today();
        const summary = { synced: 0, added: 0, drift: 0, errors: [] };
        // One holdings call per ITEM, shared by its accounts.
        const byItem = new Map();
        try {
            for (const account of targets) {
                const b = account.brokerage;
                try {
                    let hold = byItem.get(b.itemId);
                    if (!hold) { hold = await window.electronBrokerage.holdings(b.itemId); byItem.set(b.itemId, hold); }
                    if (hold.error) throw Object.assign(new Error(hold.error), { code: hold.code });
                    const start = this.since(b, today);
                    let added = 0;
                    if (start <= today) {
                        const tx = await window.electronBrokerage.transactions(b.itemId, start, today);
                        if (tx.error) throw Object.assign(new Error(tx.error), { code: tx.code });
                        added = this._mergeTransactions(account, tx.transactions || []);
                        if (tx.truncated) summary.errors.push(`${account.name}: more transactions than one sync can carry — sync again`);
                    }
                    // Cash is the broker's number.
                    const cash = this.cashOf(hold.holdings, b.plaidAccountId);
                    if (cash != null) account.cashBalance = cash;
                    // Drift: computed positions vs the broker's, reported, never applied.
                    const local = PortfolioApp.computeHoldings(account.id).map(h => ({ ticker: h.ticker, shares: h.totalShares }));
                    const drift = this.reconcile(local, this.positionsOf(hold.holdings, b.plaidAccountId), { today });
                    b.drift = drift;
                    b.lastSyncAt = new Date().toISOString();
                    b.lastTxnDate = today;
                    b.needsLogin = false;
                    account.updatedAt = b.lastSyncAt;
                    summary.synced++;
                    summary.added += added;
                    summary.drift += drift.length;
                } catch (e) {
                    if (e.code === 'login_required') {
                        b.needsLogin = true;
                        account.updatedAt = new Date().toISOString();
                        summary.errors.push(`${account.name}: ${b.institution || 'the brokerage'} needs you to sign in again`);
                    } else {
                        summary.errors.push(`${account.name}: ${this._fail(e, e.message)}`);
                    }
                } finally {
                    this._syncing.done++;
                }
            }
            PortfolioApp.saveData();
        } finally {
            this._syncing = null;
        }
        if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'portfolio') PortfolioApp.render();
        if (manual) {
            if (summary.errors.length) this._toast(summary.errors[0], 'error');
            else this._toast(summary.added
                ? `Synced — ${summary.added} new transaction${summary.added === 1 ? '' : 's'}${summary.drift ? `, ${summary.drift} position${summary.drift === 1 ? '' : 's'} to review` : ''}`
                : `Synced — up to date${summary.drift ? `, ${summary.drift} position${summary.drift === 1 ? '' : 's'} to review` : ''}`, 'success');
        }
        return summary;
    },

    /** Append what is new (by sourceRef). A row the user edited keeps their edit. */
    _mergeTransactions(account, plaidTxns) {
        const have = new Set(PortfolioApp.transactions.filter(t => t.sourceRef).map(t => t.sourceRef));
        const rows = this.mapTransactions(plaidTxns, { accountId: account.id, plaidAccountId: account.brokerage.plaidAccountId });
        const now = new Date().toISOString();
        let added = 0;
        for (const row of rows) {
            if (have.has(row.sourceRef)) continue;
            PortfolioApp.transactions.push({ id: crypto.randomUUID(), createdAt: now, updatedAt: now, ...row });
            have.add(row.sourceRef);
            added++;
        }
        return added;
    },

    // ── Drift review ─────────────────────────────────────────────────────

    /** The review modal: each difference with the transaction that closes it; apply is per row. */
    showDrift(accountId) {
        const account = PortfolioApp.accounts.find(a => a.id === accountId);
        const drift = account?.brokerage?.drift || [];
        if (!account || !drift.length) { this._toast('Positions match your brokerage', 'success'); return; }
        const esc = (s) => (typeof UIUtils !== 'undefined' ? UIUtils.escapeHtml(String(s ?? '')) : String(s ?? ''));
        const shares = (n) => (typeof PortfolioUI !== 'undefined' ? PortfolioUI.formatShares(n) : String(n));
        const money = (n) => (typeof PortfolioUI !== 'undefined' ? PortfolioUI.formatMoney(n) : String(n));
        const rows = drift.map((d, i) => `
            <label class="portfolio-link-row">
                <input type="checkbox" data-idx="${i}" checked>
                <span class="portfolio-link-main">
                    <span class="portfolio-link-name-static">${esc(PortfolioApp.displayTicker(d.ticker))}</span>
                    <span class="portfolio-link-meta">Portfolio has ${shares(d.local)}, ${esc(account.brokerage.institution || 'the brokerage')} reports ${shares(d.broker)} — ${d.fix.type === 'holding' ? `add ${shares(d.fix.quantity)} at ${money(d.fix.pricePerShare)}` : `remove ${shares(d.fix.quantity)}${d.fix.pricePerShare ? ` at ${money(d.fix.pricePerShare)}` : ''}`}</span>
                </span>
            </label>`).join('');
        const modal = Modal.create({
            title: 'Positions that differ from your brokerage',
            className: 'portfolio-link-modal',
            content: `<p class="portfolio-link-lede">A sync found these differences and changed nothing. Ticked rows are adjusted with a dated holding or sale so Portfolio matches the broker; untick anything you want to leave.</p><div class="portfolio-link-list">${rows}</div>`,
            buttons: [
                { text: 'Not now', className: 'secondary-btn', onClick: () => modal.close() },
                {
                    text: 'Adjust ticked', className: 'primary-btn', onClick: () => {
                        const now = new Date().toISOString();
                        const keep = [];
                        modal.element.querySelectorAll('input[type="checkbox"][data-idx]').forEach(cb => {
                            const d = drift[Number(cb.dataset.idx)];
                            if (!cb.checked) { keep.push(d); return; }
                            PortfolioApp.transactions.push({
                                id: crypto.randomUUID(), createdAt: now, updatedAt: now,
                                accountId: account.id, type: d.fix.type, ticker: d.ticker,
                                quantity: d.fix.quantity, pricePerShare: d.fix.pricePerShare, date: d.fix.date || this.today(),
                                notes: `Reconciled to ${account.brokerage.institution || 'brokerage'}`,
                                source: 'plaid', sourceRef: `plaid:reconcile:${account.brokerage.plaidAccountId}:${d.ticker}:${now}`
                            });
                        });
                        account.brokerage.drift = keep;
                        account.updatedAt = now;
                        PortfolioApp.saveData();
                        modal.close();
                        PortfolioApp.render();
                        this._toast('Positions adjusted', 'success');
                    }
                }
            ]
        });
    },

    // ── Unlinking ────────────────────────────────────────────────────────

    /**
     * Sever an institution: Connect removes the Plaid Item and its Portfolio
     * accounts go with it — they were created BY the link (every linked
     * account is link-born, `_createLinkedAccount`) and their rows are the
     * broker's, so keeping them read as "unlink did nothing" (2026-09-09).
     * `deleteAccounts:false` keeps them as manual accounts instead.
     */
    async unlink(itemId, { deleteAccounts = true } = {}) {
        if (!this.available()) return false;
        const r = await window.electronBrokerage.unlink(itemId);
        if (r.error && r.code !== 'not_found') { this._toast(this._fail(r, 'Could not unlink'), 'error'); return false; }
        PortfolioApp.loadData();
        const now = new Date().toISOString();
        for (const a of this.linkedAccounts()) {
            if (a.brokerage.itemId !== itemId) continue;
            if (deleteAccounts) {
                PortfolioApp._tombstone(a.id);
                PortfolioApp.transactions.filter(t => t.accountId === a.id).forEach(t => PortfolioApp._tombstone(t.id));
                PortfolioApp.accounts = PortfolioApp.accounts.filter(x => x.id !== a.id);
                PortfolioApp.transactions = PortfolioApp.transactions.filter(t => t.accountId !== a.id);
            } else {
                delete a.brokerage;
                a.updatedAt = now;
            }
        }
        PortfolioApp.saveData();
        if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'portfolio') PortfolioApp.render();
        return true;
    },

    /**
     * Accounts a link created that no link holds any more — unlinked before
     * unlink removed accounts (2026-09-09), or a sandbox item that went
     * away. Pure: an account with no `brokerage` whose rows include a
     * Plaid-sourced one (`source:'plaid'`; seeds carry `plaid:seed:`).
     */
    orphanedAccounts(accounts, transactions) {
        const plaidAccts = new Set();
        const anyRows = new Set();
        for (const t of transactions || []) {
            if (!t || !t.accountId) continue;
            anyRows.add(t.accountId);
            if (t.source === 'plaid' || String(t.sourceRef || '').startsWith('plaid:')) plaidAccts.add(t.accountId);
        }
        return (accounts || []).filter(a => {
            if (!a || !a.id || a.brokerage) return false;
            // Stamped at creation since 2026-09-09 — the reliable mark.
            if (a.source === 'plaid') return true;
            // Older link-born accounts: seeded rows carry the Plaid source…
            if (plaidAccts.has(a.id)) return true;
            // …and an account the link created EMPTY (a savings, loan or CD
            // with no positions) has only its name to show for it: the
            // "····1234" mask suffix accountNameFor writes, which the manual
            // account form never produces. Only when nothing was ever
            // logged in it, so a hand-kept account is never swept up.
            return !anyRows.has(a.id) && /····\d{2,6}$/.test(String(a.name || ''));
        });
    },

    /** Remove every orphaned account with its rows (tombstoned). Returns the count. */
    removeOrphans() {
        PortfolioApp.loadData();
        const orphans = this.orphanedAccounts(PortfolioApp.accounts, PortfolioApp.transactions);
        if (!orphans.length) return 0;
        const ids = new Set(orphans.map(a => a.id));
        for (const t of PortfolioApp.transactions) if (ids.has(t.accountId)) PortfolioApp._tombstone(t.id);
        for (const id of ids) PortfolioApp._tombstone(id);
        PortfolioApp.transactions = PortfolioApp.transactions.filter(t => !ids.has(t.accountId));
        PortfolioApp.accounts = PortfolioApp.accounts.filter(a => !ids.has(a.id));
        PortfolioApp.saveData();
        if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'portfolio') PortfolioApp.render();
        return orphans.length;
    },

    /** Delete-account hook: the last account of an item takes the link with it. */
    async onAccountDeleted(account) {
        const itemId = account?.brokerage?.itemId;
        if (!itemId || !this.available()) return;
        const others = this.linkedAccounts().some(a => a.id !== account.id && a.brokerage.itemId === itemId);
        if (others) return;
        // A bank link feeds Spending too; its accounts keep the item alive.
        try { if (typeof Anjadhe !== 'undefined' && Anjadhe.use('spending')?.usesItem(itemId)) return; } catch { /* absent */ }
        try { await window.electronBrokerage.unlink(itemId); } catch { /* the Settings card can retry */ }
    },

    // ── Header line ──────────────────────────────────────────────────────

    /** "Linked to Fidelity ····1234 via Anjadhe Cloud · synced 2h ago" (null when not linked). */
    statusLine(account) {
        const b = account?.brokerage;
        if (!b) return null;
        const inst = b.institution || 'brokerage';
        const where = b.mask ? `${inst} ····${b.mask}` : inst;
        let when = 'not synced yet';
        if (b.lastSyncAt) {
            const mins = Math.max(0, Math.round((Date.now() - Date.parse(b.lastSyncAt)) / 60000));
            when = mins < 2 ? 'synced just now' : mins < 60 ? `synced ${mins} min ago` : mins < 36 * 60 ? `synced ${Math.round(mins / 60)}h ago` : `synced ${Math.round(mins / 1440)}d ago`;
        }
        const parts = [`Linked to ${where} via Anjadhe Cloud`, when];
        if (!this.isHere(account)) parts.push('syncs from the Mac that linked it');
        if (b.needsLogin) parts.push('needs sign-in');
        else if (b.drift && b.drift.length) parts.push(`${b.drift.length} position${b.drift.length === 1 ? '' : 's'} differ`);
        return { text: parts.join(' · '), needsLogin: !!b.needsLogin, drift: (b.drift || []).length, here: this.isHere(account) };
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = PortfolioBrokerage;
