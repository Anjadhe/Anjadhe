/**
 * Portfolio App
 * Stock portfolio tracker with accounts, transactions, and live prices
 */

const PortfolioApp = {
    currentAccountFilter: 'all',
    currentView: 'holdings', // 'holdings' or 'transactions' (for account detail)
    groupByAccount: false,
    editingTransaction: null,
    viewingAccountId: null,
    isRefreshing: false,
    sortColumn: 'currentValue',
    sortDirection: 'desc',
    propertySortColumn: 'currentValue',
    propertySortDirection: 'desc',
    cashSortColumn: 'cash',
    cashSortDirection: 'desc',
    viewingTicker: null,
    viewingPropertyId: null,
    companyInfoCache: {},
    hideValues: false,
    chartRange: 'all',

    /**
     * Initialize the app
     */
    init() {
        this.loadData();
        this.setupEventListeners();
    },

    /**
     * Load data from storage
     */
    loadData() {
        const data = StorageManager.get('portfolio');
        this.accounts = data?.accounts || [];
        this.transactions = data?.transactions || [];
        this.properties = data?.properties || [];
        this.priceCache = data?.priceCache || {};
        this.valueHistory = data?.valueHistory || [];

        // Display preferences are per-machine (you mask values on the
        // shared Mac, not everywhere) — localStorage, not the synced blob.
        // data.hideValues is the legacy synced location; honored once as
        // a migration fallback until this machine toggles.
        let hidden = null;
        try {
            hidden = localStorage.getItem('portfolio-hide-values');
            this.chartRange = localStorage.getItem('portfolio-chart-range') || 'all';
        } catch (e) { /* localStorage unavailable — defaults stand */ }
        this.hideValues = hidden !== null ? hidden === '1' : (data?.hideValues || false);
    },

    /** Profile-filtered accessors */
    getAccounts() {
        return ProfileManager.filterByActiveProfile(this.accounts);
    },
    getTransactions() {
        const accountIds = new Set(this.getAccounts().map(a => a.id));
        return this.transactions.filter(t => accountIds.has(t.accountId));
    },
    getProperties() {
        return ProfileManager.filterByActiveProfile(this.properties);
    },

    /**
     * Save data to storage
     */
    saveData() {
        StorageManager.set('portfolio', {
            accounts: this.accounts,
            transactions: this.transactions,
            properties: this.properties,
            priceCache: this.priceCache,
            valueHistory: this.valueHistory
        });
    },

    /**
     * Setup event listeners (clone pattern to avoid duplicates)
     */
    setupEventListeners() {
        const bind = (id, event, handler) => {
            const el = document.getElementById(id);
            if (!el) return;
            const clone = el.cloneNode(true);
            el.parentNode.replaceChild(clone, el);
            clone.addEventListener(event, handler);
        };

        bind('portfolio-refresh-btn', 'click', () => this.refreshPrices());
        bind('portfolio-more-btn', 'click', (e) => {
            e.stopPropagation();
            this.openMoreMenu(e.currentTarget);
        });
        bind('portfolio-snapshots-take-btn', 'click', () => this.takeSnapshotFromView());
        bind('portfolio-add-transaction-btn', 'click', () => this.openTransactionEditor());
        bind('portfolio-group-seg', 'click', (e) => {
            const btn = e.target.closest('[data-group]');
            if (!btn) return;
            const byAccount = btn.dataset.group === 'account';
            if (byAccount === this.groupByAccount) return;
            this.groupByAccount = byAccount;
            this.render();
        });
        bind('portfolio-toggle-values', 'click', () => this.toggleHideValues());

        // Account detail view
        bind('portfolio-account-cash-btn', 'click', () => this.showCashModal(this.viewingAccountId));
        bind('portfolio-account-edit-btn', 'click', () => this.showEditAccountModal());
        bind('portfolio-account-delete-btn', 'click', () => this.deleteCurrentAccount());

        // Transaction editor view
        bind('portfolio-transaction-save-btn', 'click', () => this.saveTransaction());
        bind('portfolio-transaction-delete-btn', 'click', () => this.deleteTransaction());
    },

    /**
     * Header overflow ("⋯") menu — occasional actions that don't earn a
     * permanent header button: Snapshots (history view), Import, Add
     * property. Anchored popover; same open/close contract as the Notes
     * template menu (outside click, Escape, or re-click to toggle off).
     */
    openMoreMenu(anchor) {
        const existing = document.getElementById('portfolio-more-menu');
        if (existing) {
            existing.remove();
            anchor.setAttribute('aria-expanded', 'false');
            if (existing._anchor === anchor) return; // toggle-off
        }

        const items = [
            { action: 'account', label: 'New account&hellip;', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>' },
            { action: 'snapshots', label: 'Snapshots', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' },
            { action: 'import', label: 'Import from file&hellip;', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' },
            { action: 'property', label: 'Add property&hellip;', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5 12 3l9 6.5"/><path d="M5 8v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 21v-6h4v6"/></svg>' },
        ];

        const menu = document.createElement('div');
        menu.id = 'portfolio-more-menu';
        menu.className = 'portfolio-more-menu';
        menu.setAttribute('role', 'menu');
        menu._anchor = anchor;
        menu.innerHTML = items.map(item => `
            <button type="button" class="portfolio-more-menu-item" role="menuitem" data-action="${item.action}">
                ${item.icon}<span>${item.label}</span>
            </button>
        `).join('');

        document.body.appendChild(menu);
        anchor.setAttribute('aria-expanded', 'true');

        // Below the anchor, right-aligned so it never clips off-window.
        const rect = anchor.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        menu.style.top = `${rect.bottom + window.scrollY + 6}px`;
        menu.style.left = `${Math.max(8, rect.right + window.scrollX - menuRect.width)}px`;

        const close = () => {
            menu.remove();
            anchor.setAttribute('aria-expanded', 'false');
            document.removeEventListener('click', onDocClick, true);
            document.removeEventListener('keydown', onKey, true);
        };
        // anchor.contains, not ===: the click target inside the button can
        // be its SVG; the anchor's own handler owns the toggle in that case.
        const onDocClick = (e) => {
            if (!menu.contains(e.target) && !anchor.contains(e.target)) close();
        };
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        setTimeout(() => {
            document.addEventListener('click', onDocClick, true);
            document.addEventListener('keydown', onKey, true);
        }, 0);

        menu.querySelectorAll('.portfolio-more-menu-item').forEach(item => {
            item.addEventListener('click', () => {
                const action = item.dataset.action;
                close();
                if (action === 'account') this.showCreateAccountModal();
                else if (action === 'snapshots') this.openSnapshots();
                else if (action === 'import') this.openImportAssistant();
                else if (action === 'property') this.showAddPropertyModal();
            });
        });
    },

    /**
     * Render the app
     */
    render() {
        Breadcrumb.render('portfolio-breadcrumb', [
            { label: 'Portfolio' }
        ]);
        this.loadData();
        PortfolioUI.renderTopTabs('portfolio-top-tabs');
        PortfolioUI.render(this.computeHoldings(), this.getAccounts(), this.getTransactions(), this.priceCache, {
            currentAccountFilter: this.currentAccountFilter,
            groupByAccount: this.groupByAccount,
            isRefreshing: this.isRefreshing
        });
        PortfolioUI.renderInsights(this.computeInsights());
        PortfolioUI.renderPropertiesSection(this.getProperties());
        const hasData = this.getAccounts().length > 0 || this.getProperties().length > 0;
        PortfolioUI.renderValueChart(hasData ? this.valueHistory : [], this.hideValues);
        // Portfolio-wide strategy notes ('overview' pseudo-item).
        PortfolioUI.renderNotesSection('portfolio-notes', 'overview', () => this.render());
        this.autoRefreshPrices();
    },

    /**
     * Deterministic, grounded observations about the portfolio — the
     * assistant-facing layer of the main view. Facts are computed here (no
     * LLM, so nothing to hallucinate and nothing to wait for); each card
     * carries a prompt that hands the "so what?" conversation to the
     * assistant. Percentages only — no dollar figures — so the strip stays
     * useful with Hide Values on and never leaks amounts on screen.
     */
    computeInsights() {
        const holdings = this.computeHoldings();
        const summary = this.getSummary(holdings);
        if (!(summary.totalValue > 0)) return [];

        const insights = [];
        const priced = holdings.filter(h => h.currentPrice > 0);

        // Concentration: the single position that dominates everything owned.
        if (priced.length >= 2) {
            const top = priced.reduce((a, b) => (b.currentValue > a.currentValue ? b : a));
            const weight = (top.currentValue / summary.totalValue) * 100;
            if (weight >= 20) {
                insights.push({
                    label: 'Concentration',
                    text: `${this.displayTicker(top.ticker)} alone is ${Math.round(weight)}% of everything tracked here.`,
                    prompt: `${this.displayTicker(top.ticker)} is about ${Math.round(weight)}% of my portfolio. Look at my actual holdings and tell me what I should consider about this concentration.`
                });
            }
        }

        // Cash share: a large idle-cash slice is worth a conversation.
        if (summary.cash > 0) {
            const cashPct = (summary.cash / summary.totalValue) * 100;
            if (cashPct >= 15) {
                insights.push({
                    label: 'Cash',
                    text: `${Math.round(cashPct)}% of your portfolio is sitting in cash.`,
                    prompt: `About ${Math.round(cashPct)}% of my portfolio is in cash. Look at my accounts and tell me what I might consider about that.`
                });
            }
        }

        // Today's biggest mover (only when prices are in and something moved).
        const movers = priced.filter(h => Math.abs(h.dayChangePercent) >= 2);
        if (movers.length) {
            const big = movers.reduce((a, b) =>
                Math.abs(b.dayChangePercent) > Math.abs(a.dayChangePercent) ? b : a);
            const dir = big.dayChangePercent >= 0 ? 'up' : 'down';
            insights.push({
                label: 'Today',
                text: `${this.displayTicker(big.ticker)} is ${dir} ${Math.abs(big.dayChangePercent).toFixed(1)}%, your biggest mover today.`,
                prompt: `${this.displayTicker(big.ticker)} moved ${big.dayChangePercent.toFixed(1)}% today. How does that land on my portfolio, and can you find what's behind the move?`
            });
        }

        // Standout position vs cost basis (winner or laggard).
        if (insights.length < 3 && priced.length) {
            const standout = priced.reduce((a, b) =>
                Math.abs(b.profitLossPercent) > Math.abs(a.profitLossPercent) ? b : a);
            if (Math.abs(standout.profitLossPercent) >= 25) {
                const up = standout.profitLossPercent >= 0;
                insights.push({
                    label: up ? 'Winner' : 'Laggard',
                    text: `${this.displayTicker(standout.ticker)} is ${up ? 'up' : 'down'} ${Math.round(Math.abs(standout.profitLossPercent))}% on your cost basis.`,
                    prompt: `${this.displayTicker(standout.ticker)} is ${up ? 'up' : 'down'} about ${Math.round(Math.abs(standout.profitLossPercent))}% on my cost basis. Review this position against the rest of my portfolio.`
                });
            }
        }

        return insights.slice(0, 3);
    },

    /**
     * Hand the CSV/PDF import flow to the assistant: opens the Agent app with
     * a drafted instruction and the file picker, so "get my brokerage export
     * in here" is one click instead of typing transactions by hand.
     */
    openImportAssistant() {
        if (typeof AgentUI === 'undefined') return;
        AgentUI.openAppWithDraft(
            'Import the stock transactions from the attached file into my portfolio. ' +
            'First list what you find (date, ticker, buy/sell, quantity, price per share), ' +
            'ask me which account to use if it’s unclear, and only add them with add_transaction after I confirm.',
            { pickFile: true }
        );
    },

    /**
     * Auto-refresh prices if any are stale
     */
    async autoRefreshPrices() {
        const tickers = this.getUniqueTickers();
        if (tickers.length === 0) return;

        const hasStale = tickers.some(t => PriceFetcher.isStale(this.priceCache[t]));
        if (hasStale && !this.isRefreshing) {
            await this.refreshPrices();
        }
    },

    /**
     * Manually refresh all stock prices
     */
    async refreshPrices() {
        const tickers = this.getUniqueTickers();
        if (tickers.length === 0) return;

        this.isRefreshing = true;
        PortfolioUI.setRefreshing(true);

        try {
            this.priceCache = await PriceFetcher.fetchPrices(tickers, this.priceCache);
            this.saveData();
        } catch (error) {
            console.error('Failed to refresh prices:', error);
            UIUtils.showToast('Failed to refresh prices', 'error');
        } finally {
            this.isRefreshing = false;
            PortfolioUI.setRefreshing(false);
            this.recordSnapshot();
            this.render();
        }
    },

    /**
     * Get unique tickers from all transactions with positive holdings.
     * Expired option contracts are skipped — Yahoo stops quoting them, so a
     * refresh would just fail; their last cached price stands until closed.
     */
    getUniqueTickers() {
        const holdings = this.computeHoldings();
        return holdings
            .filter(h => h.totalShares > 0)
            .filter(h => !h.option || this.optionDaysToExpiry(h.option) >= 0)
            .map(h => h.ticker);
    },

    // ---- Options (OCC contract symbols) ----
    // A long call/put is tracked as a position whose ticker is the OCC
    // symbol (AAPL261218C00250000) — Yahoo's chart endpoint quotes these
    // directly, so prices, snapshots, and P&L ride the stock pipeline.
    // The only differences: value and cash math use a 100× contract
    // multiplier, and the UI renders a friendly label.

    /** Build an OCC symbol: root + YYMMDD + C/P + strike×1000 in 8 digits. */
    buildOccSymbol(underlying, expiration, optionType, strike) {
        const yymmdd = expiration.slice(2).replace(/-/g, '');
        const cp = optionType === 'put' ? 'P' : 'C';
        const strikeStr = String(Math.round(strike * 1000)).padStart(8, '0');
        return `${underlying.toUpperCase()}${yymmdd}${cp}${strikeStr}`;
    },

    /**
     * Parse an OCC option symbol into { underlying, expiration (YYYY-MM-DD),
     * optionType, strike }, or null for a regular stock ticker. Stock
     * tickers can't collide — the pattern needs 16+ characters.
     */
    optionMeta(ticker) {
        const m = /^([A-Z.]{1,6})(\d{6})([CP])(\d{8})$/.exec(ticker || '');
        if (!m) return null;
        return {
            underlying: m[1],
            expiration: `20${m[2].slice(0, 2)}-${m[2].slice(2, 4)}-${m[2].slice(4, 6)}`,
            optionType: m[3] === 'P' ? 'put' : 'call',
            strike: parseInt(m[4], 10) / 1000
        };
    },

    /** Value/cash multiplier: one option contract covers 100 shares. */
    tickerMultiplier(ticker) {
        return this.optionMeta(ticker) ? 100 : 1;
    },

    /** Cash a transaction moves (options: per-share premium × 100/contract). */
    txnAmount(txn) {
        return txn.quantity * txn.pricePerShare * this.tickerMultiplier(txn.ticker);
    },

    /** Friendly display name: "AAPL $250 Call 12/18/26"; stocks pass through. */
    displayTicker(ticker) {
        const meta = this.optionMeta(ticker);
        if (!meta) return ticker;
        const d = new Date(meta.expiration + 'T00:00:00');
        const dateStr = d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' });
        const strike = Number.isInteger(meta.strike) ? meta.strike : meta.strike.toFixed(2);
        return `${meta.underlying} $${strike} ${meta.optionType === 'put' ? 'Put' : 'Call'} ${dateStr}`;
    },

    /** Whole days until expiration (negative = expired). */
    optionDaysToExpiry(meta) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const exp = new Date(meta.expiration + 'T00:00:00');
        return Math.round((exp - today) / 86400000);
    },

    /**
     * Compute holdings using average cost method
     * @param {string|null} accountId - Filter by account, or null for all
     * @returns {Array} Holdings array
     */
    computeHoldings(accountId = null) {
        let txns = this.getTransactions();
        if (accountId) {
            txns = txns.filter(t => t.accountId === accountId);
        }

        // Group by ticker
        const byTicker = {};
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        txns.sort((a, b) => new Date(a.date) - new Date(b.date)).forEach(txn => {
            if (!byTicker[txn.ticker]) {
                byTicker[txn.ticker] = { shares: 0, costBasis: 0, todayShares: 0, todayCost: 0, accounts: new Set() };
            }
            const holding = byTicker[txn.ticker];
            holding.accounts.add(txn.accountId);

            // 'holding' = a directly-entered existing position: builds shares
            // and cost basis exactly like a buy, but never touches cash (the
            // money was spent before tracking started).
            if (txn.type === 'buy' || txn.type === 'holding') {
                holding.costBasis += this.txnAmount(txn);
                holding.shares += txn.quantity;
                // Bought today: its day move starts at the purchase price,
                // not yesterday's close ('holding' entries carry historic
                // cost, so they count as carried positions).
                if (txn.type === 'buy' && txn.date === today) {
                    holding.todayShares += txn.quantity;
                    holding.todayCost += this.txnAmount(txn);
                }
            } else if (txn.type === 'sell') {
                if (holding.shares > 0) {
                    const avgCost = holding.costBasis / holding.shares;
                    holding.shares -= txn.quantity;
                    holding.costBasis = holding.shares * avgCost;
                }
            }
        });

        return Object.entries(byTicker)
            .filter(([, h]) => h.shares > 0.0001)
            .map(([ticker, h]) => {
                const option = this.optionMeta(ticker);
                const multiplier = option ? 100 : 1;
                const cached = this.priceCache[ticker];
                const currentPrice = cached?.price || 0;
                const currentValue = h.shares * currentPrice * multiplier;
                // Per-share cost (the per-share premium for options), so the
                // Avg Cost column compares 1:1 with the quoted Price column.
                const avgCostBasis = h.shares > 0 ? h.costBasis / (h.shares * multiplier) : 0;
                const profitLoss = currentValue - h.costBasis;
                const profitLossPercent = h.costBasis > 0 ? (profitLoss / h.costBasis) * 100 : 0;
                // Day change: shares carried from yesterday move off the
                // previous close; shares bought today move off what was paid
                // for them (a stock bought after a morning drop hasn't lost
                // that drop for you).
                const chg = cached?.change || 0;
                const todayShares = Math.min(h.shares, h.todayShares);
                const carriedShares = h.shares - todayShares;
                const todayCost = h.todayShares > 0 ? h.todayCost * (todayShares / h.todayShares) : 0;
                const dayChange = currentPrice
                    ? carriedShares * chg * multiplier + (todayShares * currentPrice * multiplier - todayCost)
                    : 0;
                const dayBase = carriedShares * (currentPrice - chg) * multiplier + todayCost;
                const dayChangePercent = dayBase > 0 ? (dayChange / dayBase) * 100 : 0;

                return {
                    ticker,
                    option,
                    multiplier,
                    priceEstimated: !!cached?.estimated,
                    after: cached?.after || null,
                    totalShares: h.shares,
                    avgCostBasis,
                    costBasis: h.costBasis,
                    currentPrice,
                    currentValue,
                    profitLoss,
                    profitLossPercent,
                    dayChange,
                    dayChangePercent,
                    accounts: [...h.accounts]
                };
            })
            .sort((a, b) => b.currentValue - a.currentValue);
    },

    /**
     * Compute holdings grouped by account
     * @returns {Array} Array of { account, holdings }
     */
    computeHoldingsByAccount() {
        return this.getAccounts().map(account => ({
            account,
            holdings: this.computeHoldings(account.id),
            cash: this.computeCash(account.id)
        })).filter(g => g.holdings.length > 0 || g.cash > 0);
    },

    /**
     * Get cash balance for an account (direct stored value)
     * @param {string} accountId
     * @returns {number}
     */
    computeCash(accountId) {
        const account = (this.accounts || []).find(a => a.id === accountId);
        if (!account || account.cashBalance == null) return 0;
        return account.cashBalance;
    },

    /**
     * Get total cash across all accounts (or a single account)
     * @param {string|null} accountId
     * @returns {number}
     */
    computeTotalCash(accountId = null) {
        if (accountId) return this.computeCash(accountId);
        return this.getAccounts().reduce((sum, a) => sum + this.computeCash(a.id), 0);
    },

    /**
     * Adjust cash for a transaction (buy subtracts, sell adds)
     * @param {string} accountId
     * @param {string} type - 'buy' or 'sell'
     * @param {number} amount - quantity * pricePerShare
     */
    adjustCash(accountId, type, amount) {
        const account = this.accounts.find(a => a.id === accountId);
        if (!account || account.cashBalance == null) return;

        if (type === 'buy') {
            account.cashBalance -= amount;
        } else if (type === 'sell') {
            account.cashBalance += amount;
        }
    },

    /**
     * Show modal to deposit or withdraw cash from an account
     */
    showCashModal(accountId) {
        const account = this.accounts.find(a => a.id === accountId);
        if (!account) return;

        const currentCash = this.computeCash(accountId);

        const modal = Modal.create({
            title: 'Update Cash',
            content: `
                <div class="form-group">
                    <label class="form-label">Current Cash</label>
                    <p style="font-size: var(--text-lg); font-weight: 600; margin: 0;">${PortfolioUI.formatMoney(currentCash)}</p>
                </div>
                <div class="form-group">
                    <label class="form-label">Amount</label>
                    <input type="number" id="modal-cash-amount" placeholder="0.00" step="0.01">
                </div>
                <div class="portfolio-type-toggle">
                    <input type="radio" name="cash-action" id="cash-action-deposit" value="deposit" checked>
                    <label for="cash-action-deposit">Deposit</label>
                    <input type="radio" name="cash-action" id="cash-action-withdraw" value="withdraw">
                    <label for="cash-action-withdraw">Withdraw</label>
                    <input type="radio" name="cash-action" id="cash-action-set" value="set">
                    <label for="cash-action-set">Set Balance</label>
                </div>
            `,
            buttons: [
                { text: 'Cancel', className: 'secondary-btn', onClick: () => modal.close() },
                {
                    text: 'Save',
                    className: 'primary-btn',
                    onClick: () => {
                        const amount = parseFloat(document.getElementById('modal-cash-amount').value);
                        const action = document.querySelector('input[name="cash-action"]:checked')?.value;

                        if (isNaN(amount) || amount < 0) {
                            UIUtils.showToast('Please enter a valid amount', 'error');
                            return;
                        }

                        if (action === 'deposit') {
                            account.cashBalance = (account.cashBalance || 0) + amount;
                        } else if (action === 'withdraw') {
                            account.cashBalance = (account.cashBalance || 0) - amount;
                        } else if (action === 'set') {
                            account.cashBalance = amount;
                        }

                        this.saveData();
                        modal.close();
                        if (this.viewingAccountId) this.renderAccountDetail();
                        this.render();
                        UIUtils.showToast('Cash updated', 'success');
                    }
                }
            ]
        });
        setTimeout(() => document.getElementById('modal-cash-amount')?.focus(), 100);
    },

    /**
     * Record a snapshot of the portfolio value for today.
     * Only one snapshot per date is stored; updates if called again same day.
     */
    recordSnapshot() {
        const holdings = this.computeHoldings();
        // Only snapshot if we have at least one priced holding
        if (holdings.length === 0 || holdings.every(h => !h.currentPrice)) return;

        const summary = this.getSummary(holdings);
        const today = new Date().toISOString().slice(0, 10);

        // Per-ticker data: price and total value
        const tickers = {};
        holdings.forEach(h => {
            if (h.currentPrice) {
                tickers[h.ticker] = { price: h.currentPrice, value: h.currentValue, shares: h.totalShares };
            }
        });

        // Per-account data: total value and cash
        const accountValues = {};
        (this.accounts || []).forEach(acct => {
            const acctHoldings = this.computeHoldings(acct.id);
            const acctSummary = this.getSummary(acctHoldings, acct.id);
            if (acctSummary.totalValue > 0 || acctSummary.cash > 0) {
                accountValues[acct.id] = { value: acctSummary.totalValue, cash: acctSummary.cash };
            }
        });

        const existing = this.valueHistory.findIndex(s => s.date === today);
        const snapshot = {
            date: today,
            totalValue: summary.totalValue,
            stockValue: summary.totalValue - summary.cash - summary.realEstateValue,
            cash: summary.cash,
            realEstateValue: summary.realEstateValue,
            tickers,
            accounts: accountValues
        };

        if (existing >= 0) {
            this.valueHistory[existing] = snapshot;
        } else {
            this.valueHistory.push(snapshot);
            this.valueHistory.sort((a, b) => a.date.localeCompare(b.date));
        }

        this.saveData();
    },

    /**
     * Open the snapshots history view.
     */
    openSnapshots() {
        document.getElementById('portfolio-view').classList.remove('active');
        document.getElementById('portfolio-snapshots-view').classList.add('active');
        Breadcrumb.render('portfolio-snapshots-breadcrumb', [
            { label: 'Portfolio', action: () => this.closeSnapshots() },
            { label: 'Value History' }
        ]);
        this.renderSnapshotsView();
    },

    /**
     * Close the snapshots history view.
     */
    closeSnapshots() {
        document.getElementById('portfolio-snapshots-view').classList.remove('active');
        document.getElementById('portfolio-view').classList.add('active');
        this.render();
    },

    /**
     * Render the snapshots view (chart + table).
     */
    renderSnapshotsView() {
        PortfolioUI.renderSnapshotsChart(this.valueHistory, this.hideValues);
        PortfolioUI.renderSnapshotsTable(this.valueHistory, this.hideValues);
    },

    /**
     * Take a snapshot from the snapshots view.
     */
    takeSnapshotFromView() {
        this.recordSnapshot();
        this.renderSnapshotsView();
        UIUtils.showToast('Snapshot saved', 'success');
    },

    /**
     * Delete a snapshot by date.
     */
    async deleteSnapshot(date) {
        const confirmed = await UIUtils.confirm(
            'Delete Snapshot',
            `Remove the portfolio snapshot for ${date}?`
        );
        if (confirmed) {
            this.valueHistory = this.valueHistory.filter(s => s.date !== date);
            this.saveData();
            this.renderSnapshotsView();
            UIUtils.showToast('Snapshot deleted', 'success');
        }
    },

    // ---- Account CRUD ----

    showCreateAccountModal() {
        const createModal = Modal.create({
            title: 'New Account',
            content: `
                <div class="form-group">
                    <label class="form-label">Account Name</label>
                    <input type="text" id="modal-account-name" placeholder="e.g., Brokerage, 401k, IRA...">
                </div>
                <div class="form-group">
                    <label class="form-label">Account Type</label>
                    <select id="modal-account-type">
                        <option value="brokerage">Brokerage</option>
                        <option value="401k">401(k)</option>
                        <option value="ira">IRA</option>
                        <option value="roth-ira">Roth IRA</option>
                        <option value="hsa">HSA</option>
                        <option value="savings">Savings</option>
                        <option value="checking">Checking</option>
                        <option value="other">Other</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Initial Cash Balance</label>
                    <input type="number" id="modal-account-cash" placeholder="0.00" min="0" step="0.01">
                </div>
            `,
            buttons: [
                { text: 'Cancel', className: 'secondary-btn', onClick: () => createModal.close() },
                {
                    text: 'Create',
                    className: 'primary-btn',
                    onClick: () => {
                        const name = document.getElementById('modal-account-name').value.trim();
                        const type = document.getElementById('modal-account-type').value;
                        const cash = parseFloat(document.getElementById('modal-account-cash').value) || 0;
                        if (!name) {
                            UIUtils.showToast('Please enter an account name', 'error');
                            return;
                        }
                        createModal.close();
                        this.createAccount(name, type, cash);
                    }
                }
            ]
        });
        setTimeout(() => document.getElementById('modal-account-name')?.focus(), 100);
    },

    createAccount(name, type, cashBalance = null) {
        const account = {
            id: crypto.randomUUID(),
            name,
            type,
            profile: ProfileManager.getProfileForNewItem(),
            cashBalance: cashBalance || null,
            createdAt: new Date().toISOString()
        };
        this.accounts.push(account);
        this.saveData();
        this.render();
        UIUtils.showToast('Account created', 'success');
    },

    showEditAccountModal() {
        const account = this.accounts.find(a => a.id === this.viewingAccountId);
        if (!account) return;

        const editModal = Modal.create({
            title: 'Edit Account',
            content: `
                <div class="form-group">
                    <label class="form-label">Account Name</label>
                    <input type="text" id="modal-account-name" value="${AppManager.escapeHtml(account.name)}">
                </div>
                <div class="form-group">
                    <label class="form-label">Account Type</label>
                    <select id="modal-account-type">
                        <option value="brokerage" ${account.type === 'brokerage' ? 'selected' : ''}>Brokerage</option>
                        <option value="401k" ${account.type === '401k' ? 'selected' : ''}>401(k)</option>
                        <option value="ira" ${account.type === 'ira' ? 'selected' : ''}>IRA</option>
                        <option value="roth-ira" ${account.type === 'roth-ira' ? 'selected' : ''}>Roth IRA</option>
                        <option value="hsa" ${account.type === 'hsa' ? 'selected' : ''}>HSA</option>
                        <option value="savings" ${account.type === 'savings' ? 'selected' : ''}>Savings</option>
                        <option value="checking" ${account.type === 'checking' ? 'selected' : ''}>Checking</option>
                        <option value="other" ${account.type === 'other' ? 'selected' : ''}>Other</option>
                    </select>
                </div>
            `,
            buttons: [
                { text: 'Cancel', className: 'secondary-btn', onClick: () => editModal.close() },
                {
                    text: 'Save',
                    className: 'primary-btn',
                    onClick: () => {
                        const name = document.getElementById('modal-account-name').value.trim();
                        const type = document.getElementById('modal-account-type').value;
                        if (!name) {
                            UIUtils.showToast('Please enter an account name', 'error');
                            return;
                        }
                        account.name = name;
                        account.type = type;
                        editModal.close();
                        this.saveData();
                        this.renderAccountDetail();
                        this.render();
                        UIUtils.showToast('Account updated', 'success');
                    }
                }
            ]
        });
    },

    async deleteCurrentAccount() {
        const account = this.accounts.find(a => a.id === this.viewingAccountId);
        if (!account) return;

        const txnCount = this.transactions.filter(t => t.accountId === account.id).length;
        const confirmed = await UIUtils.confirm(
            'Delete Account',
            `Delete "${account.name}" and its ${txnCount} transaction(s)? This cannot be undone.`
        );

        if (confirmed) {
            this.accounts = this.accounts.filter(a => a.id !== account.id);
            this.transactions = this.transactions.filter(t => t.accountId !== account.id);
            // Drop the account's note links — the notes themselves stay.
            if (typeof LinkManager !== 'undefined') {
                LinkManager.removeAllLinksForItem('portfolio', account.id);
            }
            this.saveData();
            this.closeAccountDetail();
            UIUtils.showToast('Account deleted', 'success');
        }
    },

    // ---- Account Detail View ----

    openAccountDetail(accountId) {
        this.viewingAccountId = accountId;
        this.currentView = 'holdings';
        document.getElementById('portfolio-view').classList.remove('active');
        document.getElementById('portfolio-account-view').classList.add('active');
        const acct = this.accounts.find(a => a.id === accountId);
        Breadcrumb.render('portfolio-account-breadcrumb', [
            { label: 'Portfolio', action: () => this.closeAccountDetail() },
            { label: acct?.name || 'Account' }
        ]);
        this.renderAccountDetail();
    },

    closeAccountDetail() {
        this.viewingAccountId = null;
        document.getElementById('portfolio-account-view').classList.remove('active');
        document.getElementById('portfolio-view').classList.add('active');
        this.render();
    },

    renderAccountDetail() {
        const account = this.accounts.find(a => a.id === this.viewingAccountId);
        if (!account) return;

        PortfolioUI.renderTopTabs('portfolio-top-tabs-account', account.id);

        const holdings = this.computeHoldings(account.id);
        const txns = this.transactions
            .filter(t => t.accountId === account.id)
            .sort((a, b) => new Date(b.date) - new Date(a.date));

        const accountHistory = this.getAccountHistory(account.id);
        PortfolioUI.renderAccountDetail(account, holdings, txns, this.currentView, accountHistory, this.hideValues);
    },

    switchAccountTab(tab) {
        this.currentView = tab;
        this.renderAccountDetail();
    },

    // ---- Transaction CRUD ----

    openTransactionEditor(transactionId = null) {
        if (transactionId) {
            this.editingTransaction = this.transactions.find(t => t.id === transactionId);
        } else {
            this.editingTransaction = null;
        }

        document.getElementById('portfolio-view').classList.remove('active');
        document.getElementById('portfolio-account-view').classList.remove('active');
        document.getElementById('portfolio-ticker-view').classList.remove('active');
        document.getElementById('portfolio-property-view').classList.remove('active');

        document.getElementById('portfolio-snapshots-view').classList.remove('active');
        document.getElementById('portfolio-transaction-view').classList.add('active');

        Breadcrumb.render('portfolio-transaction-breadcrumb', [
            { label: 'Portfolio', action: () => this.closeTransactionEditor() },
            { label: this.editingTransaction ? 'Edit Transaction' : 'New Transaction' }
        ]);

        PortfolioUI.renderTransactionEditor(this.editingTransaction, this.getAccounts(), this.viewingAccountId);

        const deleteBtn = document.getElementById('portfolio-transaction-delete-btn');
        if (deleteBtn) {
            deleteBtn.style.display = this.editingTransaction ? '' : 'none';
        }
    },

    closeTransactionEditor() {
        document.getElementById('portfolio-transaction-view').classList.remove('active');

        if (this.viewingAccountId) {
            document.getElementById('portfolio-account-view').classList.add('active');
            this.renderAccountDetail();
        } else {
            document.getElementById('portfolio-view').classList.add('active');
            this.render();
        }
        this.editingTransaction = null;
    },

    saveTransaction() {
        const type = document.querySelector('input[name="txn-type"]:checked')?.value;
        const isOption = document.querySelector('input[name="txn-asset"]:checked')?.value === 'option';
        const accountId = document.getElementById('txn-account-select').value;
        const quantity = parseFloat(document.getElementById('txn-quantity-input').value);
        const pricePerShare = parseFloat(document.getElementById('txn-price-input').value);
        const date = document.getElementById('txn-date-input').value;
        const notes = document.getElementById('txn-notes-input').value.trim();

        let ticker;
        if (isOption) {
            const underlying = document.getElementById('txn-opt-underlying').value.trim().toUpperCase();
            const optionType = document.querySelector('input[name="txn-opt-type"]:checked')?.value || 'call';
            const strike = parseFloat(document.getElementById('txn-opt-strike').value);
            const expiration = document.getElementById('txn-opt-expiration').value;
            if (!underlying) { UIUtils.showToast('Please enter the underlying ticker', 'error'); return; }
            if (!strike || strike <= 0) { UIUtils.showToast('Please enter a valid strike price', 'error'); return; }
            if (!expiration) { UIUtils.showToast('Please enter the expiration date', 'error'); return; }
            ticker = this.buildOccSymbol(underlying, expiration, optionType, strike);
        } else {
            ticker = document.getElementById('txn-ticker-input').value.trim().toUpperCase();
            if (!ticker) { UIUtils.showToast('Please enter a ticker symbol', 'error'); return; }
        }

        // Validation
        if (!accountId) { UIUtils.showToast('Please select an account', 'error'); return; }
        if (!quantity || quantity <= 0) { UIUtils.showToast('Please enter a valid quantity', 'error'); return; }
        if (!pricePerShare || pricePerShare <= 0) { UIUtils.showToast('Please enter a valid price', 'error'); return; }
        if (!date) { UIUtils.showToast('Please enter a date', 'error'); return; }

        // Sell validation: check available shares/contracts
        if (type === 'sell') {
            const holdings = this.computeHoldings(accountId);
            const holding = holdings.find(h => h.ticker === ticker);
            const available = holding?.totalShares || 0;
            const existingQty = this.editingTransaction?.type === 'sell' ? this.editingTransaction.quantity : 0;
            if (quantity > available + existingQty) {
                const unit = isOption ? 'contract' : 'share';
                UIUtils.showToast(`Only ${available + existingQty} ${unit}(s) of ${this.displayTicker(ticker)} available to sell`, 'error');
                return;
            }
        }

        const newAmount = quantity * pricePerShare * this.tickerMultiplier(ticker);
        const wasEditing = !!this.editingTransaction;

        if (this.editingTransaction) {
            // Reverse the old transaction's cash effect ('holding' never
            // affected cash, so there's nothing to reverse)
            if (this.editingTransaction.type !== 'holding') {
                const oldAmount = this.txnAmount(this.editingTransaction);
                const oldType = this.editingTransaction.type === 'buy' ? 'sell' : 'buy'; // reverse
                this.adjustCash(this.editingTransaction.accountId, oldType, oldAmount);
            }

            Object.assign(this.editingTransaction, { type, accountId, ticker, quantity, pricePerShare, date, notes });
        } else {
            this.transactions.push({
                id: crypto.randomUUID(),
                accountId,
                type,
                ticker,
                quantity,
                pricePerShare,
                date,
                notes,
                createdAt: new Date().toISOString()
            });
        }

        // Apply the new transaction's cash effect
        this.adjustCash(accountId, type, newAmount);

        this.saveData();
        // closeTransactionEditor nulls editingTransaction — use the flag
        // captured above or edits would always toast "added".
        this.closeTransactionEditor();
        UIUtils.showToast(wasEditing ? 'Transaction updated'
            : (type === 'holding' ? 'Holding recorded' : 'Transaction added'), 'success');

        // Fetch price for the new ticker if needed
        if (!this.priceCache[ticker] || PriceFetcher.isStale(this.priceCache[ticker])) {
            this.refreshPrices();
        }
    },

    async deleteTransaction() {
        if (!this.editingTransaction) return;

        const confirmed = await UIUtils.confirm(
            'Delete Transaction',
            'Delete this transaction? This cannot be undone.'
        );

        if (confirmed) {
            // Reverse the cash effect ('holding' never affected cash)
            if (this.editingTransaction.type !== 'holding') {
                const amount = this.txnAmount(this.editingTransaction);
                const reverseType = this.editingTransaction.type === 'buy' ? 'sell' : 'buy';
                this.adjustCash(this.editingTransaction.accountId, reverseType, amount);
            }

            this.transactions = this.transactions.filter(t => t.id !== this.editingTransaction.id);
            this.editingTransaction = null;
            this.saveData();
            this.closeTransactionEditor();
            UIUtils.showToast('Transaction deleted', 'success');
        }
    },

    // ---- Symbol clusters (collapse state) ----
    // Clusters start COLLAPSED — the table opens as one summary row per
    // symbol. The set stored is the ones the user has EXPANDED, a
    // per-machine display preference (like hide-values), not synced data.

    _expandedClusters: null,

    _clusterSet() {
        if (!this._expandedClusters) {
            try {
                this._expandedClusters = new Set(JSON.parse(localStorage.getItem('portfolio-expanded-clusters') || '[]'));
            } catch {
                this._expandedClusters = new Set();
            }
            // Pre-2026-07-28 key stored the inverse (collapsed set); drop it.
            try { localStorage.removeItem('portfolio-collapsed-clusters'); } catch { /* ignore */ }
        }
        return this._expandedClusters;
    },

    isClusterCollapsed(key) {
        return !this._clusterSet().has(key);
    },

    toggleCluster(key) {
        const set = this._clusterSet();
        if (set.has(key)) set.delete(key);
        else set.add(key);
        try { localStorage.setItem('portfolio-expanded-clusters', JSON.stringify([...set])); } catch { /* ignore */ }
        if (this.viewingAccountId) this.renderAccountDetail();
        else this.render();
    },

    // ---- Account sections (By account view, collapse state) ----
    // Unlike symbol clusters, accounts default EXPANDED — the user chose
    // the By account view to look at them. Collapses persist per machine.

    _collapsedAccounts: null,

    _accountSet() {
        if (!this._collapsedAccounts) {
            try {
                this._collapsedAccounts = new Set(JSON.parse(localStorage.getItem('portfolio-collapsed-accounts') || '[]'));
            } catch {
                this._collapsedAccounts = new Set();
            }
        }
        return this._collapsedAccounts;
    },

    isAccountCollapsed(accountId) {
        return this._accountSet().has(accountId);
    },

    toggleAccountSection(accountId) {
        const set = this._accountSet();
        if (set.has(accountId)) set.delete(accountId);
        else set.add(accountId);
        try { localStorage.setItem('portfolio-collapsed-accounts', JSON.stringify([...set])); } catch { /* ignore */ }
        this.render();
    },

    // ---- Hide Values Toggle ----

    toggleHideValues() {
        this.hideValues = !this.hideValues;
        try { localStorage.setItem('portfolio-hide-values', this.hideValues ? '1' : '0'); } catch (e) { /* ignore */ }
        PortfolioUI.updateHideValuesBtn(this.hideValues);

        if (this.viewingTicker) {
            this.renderTickerDetail();
        } else if (this.viewingPropertyId) {
            this.renderPropertyDetail();
        } else if (this.viewingAccountId) {
            this.renderAccountDetail();
        } else {
            this.render();
        }
    },

    // ---- Sorting ----

    sortHoldings(holdings) {
        const col = this.sortColumn;
        const dir = this.sortDirection === 'asc' ? 1 : -1;

        return [...holdings].sort((a, b) => {
            let aVal = a[col];
            let bVal = b[col];

            // String columns sort alphabetically
            if (col === 'ticker') {
                return dir * aVal.localeCompare(bVal);
            }

            // Numeric sort
            return dir * ((aVal || 0) - (bVal || 0));
        });
    },

    setSortColumn(col) {
        if (this.sortColumn === col) {
            this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortColumn = col;
            this.sortDirection = col === 'ticker' ? 'asc' : 'desc';
        }

        // Re-render the appropriate view
        if (this.viewingAccountId) {
            this.renderAccountDetail();
        } else {
            this.render();
        }
    },

    sortProperties(properties) {
        const col = this.propertySortColumn;
        const dir = this.propertySortDirection === 'asc' ? 1 : -1;

        return [...properties].sort((a, b) => {
            if (col === 'name' || col === 'address') {
                return dir * (a[col] || '').localeCompare(b[col] || '');
            }
            if (col === 'profitLoss') {
                const aVal = (a.currentValue || 0) - (a.purchasePrice || 0);
                const bVal = (b.currentValue || 0) - (b.purchasePrice || 0);
                return dir * (aVal - bVal);
            }
            return dir * ((a[col] || 0) - (b[col] || 0));
        });
    },

    setPropertySortColumn(col) {
        if (this.propertySortColumn === col) {
            this.propertySortDirection = this.propertySortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            this.propertySortColumn = col;
            this.propertySortDirection = (col === 'name' || col === 'address') ? 'asc' : 'desc';
        }
        this.render();
    },

    setCashSortColumn(col) {
        if (this.cashSortColumn === col) {
            this.cashSortDirection = this.cashSortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            this.cashSortColumn = col;
            this.cashSortDirection = (col === 'name' || col === 'type') ? 'asc' : 'desc';
        }
        PortfolioUI.renderCashDetail(this.getAccounts());
    },

    // ---- Ticker Detail View ----

    openCashDetail() {
        this.viewingTicker = '__CASH__';
        document.getElementById('portfolio-view').classList.remove('active');
        document.getElementById('portfolio-account-view').classList.remove('active');
        document.getElementById('portfolio-ticker-view').classList.add('active');

        const titleEl = document.getElementById('portfolio-ticker-title');
        if (titleEl) titleEl.textContent = 'Cash';

        PortfolioUI.renderCashDetail(this.getAccounts());
    },

    openTickerDetail(ticker) {
        this.viewingTicker = ticker;
        document.getElementById('portfolio-view').classList.remove('active');
        document.getElementById('portfolio-account-view').classList.remove('active');
        document.getElementById('portfolio-ticker-view').classList.add('active');
        Breadcrumb.render('portfolio-ticker-breadcrumb', [
            { label: 'Portfolio', action: () => this.closeTickerDetail() },
            { label: this.displayTicker(ticker) }
        ]);
        this.renderTickerDetail();
        // Option contracts have no company profile — the detail view shows
        // the contract card instead, so don't fetch (and cache a miss) here.
        if (!this.optionMeta(ticker)) this.fetchCompanyInfo(ticker);
    },

    closeTickerDetail() {
        this.viewingTicker = null;
        document.getElementById('portfolio-ticker-view').classList.remove('active');

        if (this.viewingAccountId) {
            document.getElementById('portfolio-account-view').classList.add('active');
            this.renderAccountDetail();
        } else {
            document.getElementById('portfolio-view').classList.add('active');
            this.render();
        }
    },

    renderTickerDetail() {
        if (!this.viewingTicker) return;

        const titleEl = document.getElementById('portfolio-ticker-title');
        if (titleEl) titleEl.textContent = this.displayTicker(this.viewingTicker);

        const holdings = this.computeHoldings();
        const holding = holdings.find(h => h.ticker === this.viewingTicker);
        const byAccount = this.computeHoldingsForTickerByAccount(this.viewingTicker);
        const companyInfo = this.companyInfoCache[this.viewingTicker] || null;

        const tickerHistory = this.getTickerHistory(this.viewingTicker);
        PortfolioUI.renderTickerDetail(this.viewingTicker, holding, byAccount, companyInfo, this.priceCache[this.viewingTicker], tickerHistory, this.hideValues);
    },

    async fetchCompanyInfo(ticker) {
        if (this.companyInfoCache[ticker]) {
            return; // Already cached
        }

        const info = await PriceFetcher.fetchCompanyInfo(ticker);
        if (info) {
            this.companyInfoCache[ticker] = info;
        } else {
            this.companyInfoCache[ticker] = { name: ticker, error: true };
        }

        // Re-render if still viewing this ticker
        if (this.viewingTicker === ticker) {
            this.renderTickerDetail();
        }
    },

    getTickerHistory(ticker) {
        return this.valueHistory
            .filter(s => s.tickers && s.tickers[ticker])
            .map(s => ({ date: s.date, price: s.tickers[ticker].price, value: s.tickers[ticker].value }));
    },

    getAccountHistory(accountId) {
        return this.valueHistory
            .filter(s => s.accounts && s.accounts[accountId])
            .map(s => ({ date: s.date, value: s.accounts[accountId].value, cash: s.accounts[accountId].cash }));
    },

    computeHoldingsForTickerByAccount(ticker) {
        const results = [];
        this.accounts.forEach(account => {
            const holdings = this.computeHoldings(account.id);
            const holding = holdings.find(h => h.ticker === ticker);
            if (holding) {
                results.push({
                    account,
                    ...holding
                });
            }
        });
        return results;
    },

    /**
     * Get summary totals
     */
    /**
     * Get summary totals
     * @param {Array} holdings
     * @param {string|null} accountId - if provided, includes cash for that account; if null, all accounts
     */
    getSummary(holdings, accountId = null) {
        const stockValue = holdings.reduce((sum, h) => sum + h.currentValue, 0);
        const totalCost = holdings.reduce((sum, h) => sum + h.costBasis, 0);
        const cash = this.computeTotalCash(accountId);
        const realEstateValue = accountId ? 0 : this.properties.reduce((sum, p) => sum + (p.currentValue || 0), 0);
        const totalValue = stockValue + cash + realEstateValue;
        const totalPL = stockValue - totalCost;
        const totalPLPercent = totalCost > 0 ? (totalPL / totalCost) * 100 : 0;
        const totalDayChange = holdings.reduce((sum, h) => sum + h.dayChange, 0);
        // Extended-session aggregate across holdings that have a pre/post
        // quote (options never do — their contribution is simply absent).
        const afterChange = holdings.reduce((sum, h) => sum + (h.after ? h.totalShares * h.after.change * h.multiplier : 0), 0);
        const afterBase = holdings.reduce((sum, h) => sum + (h.after ? h.currentValue : 0), 0);
        const afterSession = holdings.find(h => h.after)?.after.session || null;
        return { totalValue, totalCost, totalPL, totalPLPercent, totalDayChange, cash, realEstateValue, afterChange, afterBase, afterSession };
    },

    // ---- Property CRUD ----

    showAddPropertyModal() {
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

        const modal = Modal.create({
            title: 'Add Property',
            content: `
                <div class="form-group">
                    <label class="form-label">Name</label>
                    <input type="text" id="modal-property-name" placeholder="e.g., My Home">
                </div>
                <div class="form-group">
                    <label class="form-label">Address</label>
                    <input type="text" id="modal-property-address" placeholder="123 Main St, City, ST 12345">
                </div>
                <div class="form-group">
                    <label class="form-label">Current Value</label>
                    <input type="number" id="modal-property-value" placeholder="500000" min="0" step="0.01">
                </div>
                <div class="form-group">
                    <label class="form-label">Purchase Price</label>
                    <input type="number" id="modal-property-purchase" placeholder="400000" min="0" step="0.01">
                </div>
                <div class="form-group">
                    <label class="form-label">Purchase Date</label>
                    <input type="date" id="modal-property-date" value="${today}">
                </div>
                <div class="form-group">
                    <label class="form-label">Notes</label>
                    <textarea id="modal-property-notes" placeholder="Optional notes..."></textarea>
                </div>
            `,
            buttons: [
                { text: 'Cancel', className: 'secondary-btn', onClick: () => modal.close() },
                {
                    text: 'Add',
                    className: 'primary-btn',
                    onClick: () => {
                        const name = document.getElementById('modal-property-name').value.trim();
                        const currentValue = parseFloat(document.getElementById('modal-property-value').value);
                        if (!name) { UIUtils.showToast('Please enter a name', 'error'); return; }
                        if (isNaN(currentValue) || currentValue < 0) { UIUtils.showToast('Please enter a valid current value', 'error'); return; }

                        this.properties.push({
                            id: crypto.randomUUID(),
                            name,
                            address: document.getElementById('modal-property-address').value.trim(),
                            currentValue,
                            purchasePrice: parseFloat(document.getElementById('modal-property-purchase').value) || 0,
                            purchaseDate: document.getElementById('modal-property-date').value,
                            notes: document.getElementById('modal-property-notes').value.trim(),
                            profile: ProfileManager.getProfileForNewItem(),
                            createdAt: new Date().toISOString()
                        });
                        this.saveData();
                        modal.close();
                        this.render();
                        UIUtils.showToast('Property added', 'success');
                    }
                }
            ]
        });
        setTimeout(() => document.getElementById('modal-property-name')?.focus(), 100);
    },

    showEditPropertyModal(id) {
        const property = this.properties.find(p => p.id === id);
        if (!property) return;

        const modal = Modal.create({
            title: 'Edit Property',
            content: `
                <div class="form-group">
                    <label class="form-label">Name</label>
                    <input type="text" id="modal-property-name" value="${AppManager.escapeHtml(property.name)}">
                </div>
                <div class="form-group">
                    <label class="form-label">Address</label>
                    <input type="text" id="modal-property-address" value="${AppManager.escapeHtml(property.address || '')}">
                </div>
                <div class="form-group">
                    <label class="form-label">Current Value</label>
                    <input type="number" id="modal-property-value" value="${property.currentValue}" min="0" step="0.01">
                </div>
                <div class="form-group">
                    <label class="form-label">Purchase Price</label>
                    <input type="number" id="modal-property-purchase" value="${property.purchasePrice || ''}" min="0" step="0.01">
                </div>
                <div class="form-group">
                    <label class="form-label">Purchase Date</label>
                    <input type="date" id="modal-property-date" value="${property.purchaseDate || ''}">
                </div>
                <div class="form-group">
                    <label class="form-label">Notes</label>
                    <textarea id="modal-property-notes">${AppManager.escapeHtml(property.notes || '')}</textarea>
                </div>
            `,
            buttons: [
                { text: 'Cancel', className: 'secondary-btn', onClick: () => modal.close() },
                {
                    text: 'Save',
                    className: 'primary-btn',
                    onClick: () => {
                        const name = document.getElementById('modal-property-name').value.trim();
                        const currentValue = parseFloat(document.getElementById('modal-property-value').value);
                        if (!name) { UIUtils.showToast('Please enter a name', 'error'); return; }
                        if (isNaN(currentValue) || currentValue < 0) { UIUtils.showToast('Please enter a valid current value', 'error'); return; }

                        property.name = name;
                        property.address = document.getElementById('modal-property-address').value.trim();
                        property.currentValue = currentValue;
                        property.purchasePrice = parseFloat(document.getElementById('modal-property-purchase').value) || 0;
                        property.purchaseDate = document.getElementById('modal-property-date').value;
                        property.notes = document.getElementById('modal-property-notes').value.trim();

                        this.saveData();
                        modal.close();
                        if (this.viewingPropertyId === id) this.renderPropertyDetail();
                        this.render();
                        UIUtils.showToast('Property updated', 'success');
                    }
                }
            ]
        });
    },

    async deleteProperty(id) {
        const property = this.properties.find(p => p.id === id);
        if (!property) return;

        const confirmed = await UIUtils.confirm(
            'Delete Property',
            `Delete "${property.name}"? This cannot be undone.`
        );

        if (confirmed) {
            this.properties = this.properties.filter(p => p.id !== id);
            this.saveData();
            if (this.viewingPropertyId === id) {
                this.closePropertyDetail();
            }
            this.render();
            UIUtils.showToast('Property deleted', 'success');
        }
    },

    // ---- Property Detail View ----

    openPropertyDetail(id) {
        this.viewingPropertyId = id;
        document.getElementById('portfolio-view').classList.remove('active');
        document.getElementById('portfolio-property-view').classList.add('active');
        const prop = this.properties.find(p => p.id === id);
        Breadcrumb.render('portfolio-property-breadcrumb', [
            { label: 'Portfolio', action: () => this.closePropertyDetail() },
            { label: prop?.name || 'Property' }
        ]);
        this.renderPropertyDetail();
    },

    closePropertyDetail() {
        this.viewingPropertyId = null;
        document.getElementById('portfolio-property-view').classList.remove('active');
        document.getElementById('portfolio-view').classList.add('active');
        this.render();
    },

    renderPropertyDetail() {
        const property = this.properties.find(p => p.id === this.viewingPropertyId);
        if (!property) return;

        const titleEl = document.getElementById('portfolio-property-title');
        if (titleEl) titleEl.textContent = property.name;

        PortfolioUI.renderPropertyDetail(property);
    }
};

// Register with AppManager
AppManager.register('portfolio', PortfolioApp);

// AgentContext provider — exposes the account or ticker detail view
// the user is currently looking at. We don't dump full transactions
// into the system prompt (that's what the get_ticker / list_holdings
// tools are for); the block below is a pointer so the agent knows
// which account/ticker "this" refers to. The main summary view gets a
// lightweight overview block (pointer + suggested prompts, no numbers —
// totals are already in the briefing) so opening the assistant over the
// portfolio has quick-start questions and a stable record thread.
if (typeof AgentContext !== 'undefined') {
    AgentContext.register('portfolio', () => {
        const viewActive = (id) => document.getElementById(id)?.classList.contains('active');

        // Sub-views come first: stale viewingAccountId/viewingTicker state
        // otherwise mislabels the pill ("Ask about this account" over the
        // value-history table).
        if (viewActive('portfolio-snapshots-view')) {
            return {
                recordKey: 'portfolio:history',
                recordLabel: 'Value history',
                // Pill copy derives from this: "Ask about this value history".
                title: 'VALUE HISTORY',
                body: 'The user is viewing their portfolio value history (daily snapshots of total value, stocks, cash, real estate). When they say "this chart" or "this history", they mean these snapshots. Use list_portfolio for current numbers.',
                suggestedPrompts: [
                    'How has my portfolio changed over time?',
                    'What was my biggest single-day move?',
                    'Summarize this year so far'
                ]
            };
        }
        // Data-entry form — a floating "Ask about…" pill is noise here.
        if (viewActive('portfolio-transaction-view')) return null;

        if (PortfolioApp.viewingTicker) {
            const t = PortfolioApp.viewingTicker;
            // Options: label reads naturally; tools still take the raw symbol.
            const label = PortfolioApp.displayTicker(t);
            const symbolNote = label === t ? '' : ` The exact symbol for tools is ${t}.`;
            return {
                recordKey: 'portfolio:ticker:' + t,
                recordLabel: label,
                title: 'CURRENT TICKER',
                body: `The user is viewing the detail page for ${label}. When they say "this stock" / "this ticker" / "this position", they mean ${label}.${symbolNote} Use get_ticker_detail or list_portfolio if you need current numbers.`,
                suggestedPrompts: [
                    `How is ${label} performing?`,
                    `What is my cost basis on ${label}?`,
                    `Compare ${label} to my other holdings`
                ]
            };
        }
        if (PortfolioApp.viewingAccountId) {
            const a = (PortfolioApp.accounts || []).find(x => x && x.id === PortfolioApp.viewingAccountId);
            if (a) {
                return {
                    recordKey: 'portfolio:account:' + a.id,
                    recordLabel: a.name || '(account)',
                    title: 'CURRENT ACCOUNT',
                    body: `The user is viewing the account detail page below. When they say "this account", they mean ${a.name}. Use list_portfolio for current holdings and balances.

Account name: ${a.name}
Type: ${a.type || 'unspecified'}
Account id: ${a.id}`,
                    suggestedPrompts: [
                        'Summarize this account',
                        'What are my biggest positions here?',
                        'How is this account performing?'
                    ]
                };
            }
        }
        // Main portfolio overview. Only when there's something to talk about.
        const hasData = (PortfolioApp.getAccounts?.() || []).length > 0
            || (PortfolioApp.getProperties?.() || []).length > 0;
        if (hasData) {
            return {
                recordKey: 'portfolio:overview',
                recordLabel: 'Portfolio',
                title: 'PORTFOLIO OVERVIEW',
                body: 'The user is viewing their portfolio overview (all accounts, holdings, cash, real estate). Use list_portfolio for current holdings, totals, and cash; get_ticker_detail for a single stock. Ground observations in tool numbers.',
                suggestedPrompts: [
                    'How is my portfolio doing?',
                    'Which of my holdings moved the most today?',
                    'How concentrated is my portfolio?'
                ]
            };
        }
        return null;
    });
}
