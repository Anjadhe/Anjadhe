/**
 * Portfolio App
 * Stock portfolio tracker with accounts, transactions, and live prices
 */

const PortfolioApp = {
    currentAccountFilter: 'all',    // 'all' or an account id — the nav scope
    currentView: 'holdings',        // 'holdings' or 'transactions' tab
    editingTransaction: null,
    viewingAccountId: null,
    isRefreshing: false,
    // One sort state for every sortable table, keyed by scope (see setSort)
    sort: {
        holdings: { col: 'currentValue', dir: 'desc' },
        properties: { col: 'currentValue', dir: 'desc' },
        cash: { col: 'cash', dir: 'desc' }
    },
    viewingTicker: null,
    viewingPropertyId: null,
    companyInfoCache: {},
    hideValues: false,
    showAfterHours: true,
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
        this.strategies = data?.strategies || [];
        // Per-record deletion markers ({id: deletedAtISO}) — sync merges
        // records by id across Macs, so a delete must leave a tombstone or
        // the record resurrects from the other Mac's copy on next merge.
        this.tombstones = (data?.tombstones && typeof data.tombstones === 'object') ? data.tombstones : {};

        // Price cache is machine-local (localStorage) since 2026-07-30 and
        // value history has its own synced key — neither lives in the
        // portfolio blob any more (see saveData for why). The blob copies
        // are the pre-split fallback so nothing is lost on first run.
        let localPrices = null;
        try { localPrices = JSON.parse(localStorage.getItem('portfolio-price-cache') || 'null'); } catch (e) { /* defaults stand */ }
        this.priceCache = localPrices || data?.priceCache || {};
        const hist = StorageManager.get('portfolio-history');
        this.valueHistory = Array.isArray(hist?.snapshots) ? hist.snapshots : (data?.valueHistory || []);

        // Display preferences are per-machine (you mask values on the
        // shared Mac, not everywhere) — localStorage, not the synced blob.
        // data.hideValues is the legacy synced location; honored once as
        // a migration fallback until this machine toggles.
        let hidden = null;
        try {
            hidden = localStorage.getItem('portfolio-hide-values');
            this.chartRange = localStorage.getItem('portfolio-chart-range') || 'all';
            // Extended-session quotes on/off. Machine-local like the other
            // two view preferences above. Default ON — it is existing
            // behaviour, and a preference should never silently remove data
            // someone was already looking at.
            this.showAfterHours = localStorage.getItem('portfolio-after-hours') !== '0';
            // Table sort choices, per scope. Merged over the defaults so a
            // scope added later still gets one when the stored blob predates it.
            const sort = JSON.parse(localStorage.getItem('portfolio-sort') || 'null');
            if (sort && typeof sort === 'object') {
                for (const scope of Object.keys(this.sort)) {
                    if (sort[scope] && sort[scope].col) this.sort[scope] = sort[scope];
                }
            }
        } catch (e) { /* localStorage unavailable — defaults stand */ }
        this.hideValues = hidden !== null ? hidden === '1' : (data?.hideValues || false);
    },

    /** Profile-filtered accessors */
    getAccounts() {
        return this.accounts;
    },
    getTransactions() {
        const accountIds = new Set(this.getAccounts().map(a => a.id));
        return this.transactions.filter(t => accountIds.has(t.accountId));
    },
    getProperties() {
        return this.properties;
    },

    /**
     * Save user-edited data to storage.
     *
     * INVARIANT: only real user edits may write this blob. Sync merges
     * whole keys last-writer-wins by modifiedAt, so an automatic write
     * (price refresh, daily snapshot) stamping this key lets a Mac that
     * merely LOOKED at the portfolio outrank another Mac's actual edits —
     * exactly that clobbered a morning of Studio transactions on
     * 2026-07-30. Prices live in localStorage (_savePriceCache) and value
     * history in its own synced key (_saveHistory), so neither re-stamps
     * the transactions/accounts data.
     */
    saveData() {
        StorageManager.set('portfolio', {
            accounts: this.accounts,
            transactions: this.transactions,
            properties: this.properties,
            strategies: this.strategies,
            tombstones: this.tombstones
        });
        // The write above record-merges with what is stored (main.js
        // mergedForWrite), so records another Mac synced in that this
        // session never loaded survive. Re-read so in-memory state picks
        // those up instead of drifting further from the store.
        this.loadData();
    },

    /** Mark a record deleted so sync merges don't resurrect it. Call
     *  BEFORE saveData in every delete path. */
    _tombstone(id) {
        if (id) this.tombstones[id] = new Date().toISOString();
    },

    /** Machine-local quote cache — never synced, each Mac refetches. */
    _savePriceCache() {
        try { localStorage.setItem('portfolio-price-cache', JSON.stringify(this.priceCache)); } catch (e) { /* cache only */ }
    },

    /** Value history in its own synced key, so daily snapshots can't
     *  re-stamp (and shadow) the user-edit blob in sync merges. */
    _saveHistory() {
        StorageManager.set('portfolio-history', { snapshots: this.valueHistory });
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
        bind('portfolio-openin-btn', 'click', (e) => {
            e.stopPropagation();
            this.openTickerLinksMenu(e.currentTarget);
        });
        bind('portfolio-snapshots-take-btn', 'click', () => this.takeSnapshotFromView());
        bind('portfolio-add-transaction-btn', 'click', () => this.openTransactionEditor());
        bind('portfolio-toggle-values', 'click', () => this.toggleHideValues());

        // Holdings / Transactions tabs (both scopes)
        bind('portfolio-holdings-tab', 'click', () => this.switchTab('holdings'));
        bind('portfolio-txns-tab', 'click', () => this.switchTab('transactions'));

        // Account actions — header buttons shown only when scoped to one
        bind('portfolio-account-cash-btn', 'click', () => this.showCashModal(this.viewingAccountId));
        bind('portfolio-account-edit-btn', 'click', () => this.showEditAccountModal());
        bind('portfolio-account-delete-btn', 'click', () => this.deleteCurrentAccount());

        // Transaction editor view
        bind('portfolio-transaction-save-btn', 'click', () => this.saveTransaction());
        bind('portfolio-transaction-delete-btn', 'click', () => this.deleteTransaction());
    },

    /**
     * Header overflow ("⋯") menu — occasional actions that don't earn a
     * permanent header button: New account, Snapshots (history
     * view), Add property. Anchored popover; same open/close contract as the
     * Notes template menu (outside click, Escape, or re-click to toggle off).
     *
     * "Import from file" was removed 2026-07-29: it only ever drafted a
     * prompt and opened the file picker, which the assistant's own attach
     * button already does — drop any brokerage export into a chat and ask.
     */
    openMoreMenu(anchor) {
        const items = [
            { action: 'account', label: 'New account&hellip;', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>' },
            { action: 'snapshots', label: 'Snapshots', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' },
            { action: 'afterhours',
              // A state row, not a command: the label says what the click
              // will DO, so it flips with the setting.
              label: (this.showAfterHours ? 'Hide' : 'Show') + ' after-hours prices',
              icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>' },
            { action: 'property', label: 'Add property&hellip;', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5 12 3l9 6.5"/><path d="M5 8v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 21v-6h4v6"/></svg>' },
        ];

        this.openAnchoredMenu(anchor, 'portfolio-more-menu', items, (action) => {
            if (action === 'account') this.showCreateAccountModal();
            else if (action === 'snapshots') this.openSnapshots();
            else if (action === 'property') this.showAddPropertyModal();
            else if (action === 'afterhours') this.toggleAfterHours();
        });
    },

    /**
     * Anchored popover menu shell shared by the header "⋯" menu and the
     * ticker detail's "Open in" menu. Same open/close contract as the Notes
     * template menu: outside click, Escape, or re-click to toggle off.
     */
    openAnchoredMenu(anchor, id, items, onAction) {
        const existing = document.getElementById(id);
        if (existing) {
            existing.remove();
            existing._anchor.setAttribute('aria-expanded', 'false');
            if (existing._anchor === anchor) return; // toggle-off
        }

        const menu = document.createElement('div');
        menu.id = id;
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
                close();
                onAction(item.dataset.action);
            });
        });
    },

    /**
     * External research sites the ticker detail's "Open in" menu offers.
     * URL builders take the plain symbol; Yahoo and Finviz write class
     * shares with a dash (BRK-B), the rest take the dot form as-is.
     */
    TICKER_SITES: [
        { action: 'perplexity',  label: 'Perplexity Finance', url: (s) => `https://www.perplexity.ai/finance/${encodeURIComponent(s)}` },
        { action: 'robinhood',   label: 'Robinhood',          url: (s) => `https://robinhood.com/stocks/${encodeURIComponent(s)}` },
        { action: 'tradingview', label: 'TradingView',        url: (s) => `https://www.tradingview.com/symbols/${encodeURIComponent(s)}/` },
        { action: 'yahoo',       label: 'Yahoo Finance',      url: (s) => `https://finance.yahoo.com/quote/${encodeURIComponent(s.replace(/\./g, '-'))}` },
        { action: 'finviz',      label: 'Finviz',             url: (s) => `https://finviz.com/quote.ashx?t=${encodeURIComponent(s.replace(/\./g, '-'))}` },
    ],

    /**
     * "Open in" menu on the ticker detail — opens the ticker on an external
     * research site in the default browser. Options link out via their
     * underlying symbol (no external site takes an OCC contract symbol).
     */
    openTickerLinksMenu(anchor) {
        if (!this.viewingTicker) return;
        const symbol = this.optionMeta(this.viewingTicker)?.underlying || this.viewingTicker;

        const icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
        const items = this.TICKER_SITES.map(site => ({ action: site.action, label: site.label, icon }));

        this.openAnchoredMenu(anchor, 'portfolio-openin-menu', items, (action) => {
            const site = this.TICKER_SITES.find(s => s.action === action);
            if (site) window.electronAuth.openExternal(site.url(symbol));
        });
    },

    /**
     * Render the app. One page: the accounts nav on the left scopes the
     * right pane to All Accounts or a single account.
     */
    render() {
        Breadcrumb.render('portfolio-breadcrumb', [
            { label: 'Portfolio' }
        ]);
        this.loadData();
        const scope = this.currentAccountFilter;
        // The Strategy page replaces the whole right pane (see
        // PortfolioStrategyPage — prompt-buttons + per-strategy AI reviews).
        if (scope === 'strategy') {
            // Breadcrumb stays plain "Portfolio", as it does at account
            // scope: the page states its own name in its heading, and the
            // left nav is the way back. Saying "Strategy" twice, one line
            // apart, is the duplication we keep removing.
            PortfolioUI.updateHideValuesBtn(this.hideValues);
            PortfolioUI.renderNav(scope);
            PortfolioUI.renderScopeHeader(null);
            if (typeof PortfolioStrategyPage !== 'undefined') PortfolioStrategyPage.render();
            return;
        }
        if (typeof PortfolioStrategyPage !== 'undefined') PortfolioStrategyPage.hide();
        const scoped = scope !== 'all';
        const account = scoped ? this.getAccounts().find(a => a.id === scope) : null;
        // A synced-away or deleted account falls back to All rather than a
        // blank pane.
        if (scoped && !account) { this.currentAccountFilter = 'all'; this.viewingAccountId = null; return this.render(); }

        PortfolioUI.updateHideValuesBtn(this.hideValues);
        PortfolioUI.renderNav(scope);
        PortfolioUI.renderScopeHeader(account);

        const holdings = this.computeHoldings(scoped ? scope : null);
        PortfolioUI.renderSummaryBar(holdings, scope);
        this.renderPricesAsOfFor(holdings);
        // Shown at both scopes: at All the overall plan, when scoped the plan
        // that account is judged against (its own, or the overall one it
        // inherits).
        PortfolioUI.renderStrategyLine('portfolio-strategy-card', true, scoped ? scope : null);

        // Chart: overall value history at All, the account's own when scoped.
        if (scoped) {
            const hist = this.getAccountHistory(scope);
            if (hist && hist.length >= 2) {
                PortfolioUI.renderDetailChart('portfolio-value-chart', hist, 'value', this.hideValues);
            } else {
                const el = document.getElementById('portfolio-value-chart');
                if (el) el.innerHTML = '';
            }
        } else {
            const hasData = this.getAccounts().length > 0 || this.getProperties().length > 0;
            PortfolioUI.renderValueChart(hasData ? this.valueHistory : [], this.hideValues);
        }

        PortfolioUI.renderTabs(this.currentView);
        if (this.currentView === 'transactions') {
            const txns = this.getTransactions()
                .filter(t => !scoped || t.accountId === scope)
                .sort((a, b) => new Date(b.date) - new Date(a.date));
            PortfolioUI.renderTransactionList(txns, document.getElementById('portfolio-holdings'));
        } else if (!scoped && this.getAccounts().length === 0 && holdings.length === 0) {
            PortfolioUI.renderNoAccountsState();
        } else {
            PortfolioUI.renderHoldingsTable(holdings, 'portfolio-holdings',
                scoped ? this.computeCash(scope) : this.computeTotalCash());
            if (!scoped) PortfolioUI.renderPropertiesSection(this.getProperties());
        }

        // Decisions saved about the scoped account. Cleared at All Accounts:
        // decisions key on ONE account id, and the 'overview' pseudo-item is
        // out of v1 (no real id to key on).
        const decisionsEl = document.getElementById('portfolio-decisions');
        if (decisionsEl && typeof DecisionsUI !== 'undefined') {
            if (scoped) DecisionsUI.mount(decisionsEl, `account:${scope}`);
            else decisionsEl.innerHTML = '';
        }

        // Linked notes: the portfolio 'overview' pseudo-item at All, the
        // account itself when scoped.
        PortfolioUI.renderNotesSection('portfolio-notes', scoped ? scope : 'overview', () => this.render());
        this.autoRefreshPrices();
    },

    /** Change the nav scope ('all' or an account id). */
    setScope(scope) {
        this.currentAccountFilter = scope;
        this.viewingAccountId = (scope === 'all' || scope === 'strategy') ? null : scope;
        this.render();
    },

    switchTab(tab) {
        if (tab === this.currentView) return;
        this.currentView = tab;
        this.render();
    },

    /** Prices-as-of caption for the currently scoped holdings. */
    renderPricesAsOfFor(holdings) {
        PortfolioUI.renderPricesAsOf(this.priceCache, holdings);
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
            this._savePriceCache();
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
                    // What the day's move is measured against. Carried up to
                    // getSummary so the masthead's "today" percent uses the
                    // same base as every row's, rather than total value
                    // (which includes cash and real estate that never moved).
                    dayBase,
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
        // Record-level sync resolves each account by updatedAt — an
        // unstamped cash change would lose to any stamped copy in a merge.
        account.updatedAt = new Date().toISOString();
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
                        account.updatedAt = new Date().toISOString();

                        this.saveData();
                        modal.close();
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

        this._saveHistory();
    },

    /**
     * Advisory toast when a just-saved trade puts the portfolio off plan.
     * Clicking it hands the conflict to the assistant, which is where the
     * "so should I do something about it?" conversation belongs.
     */
    flagStrategyConflict({ accountId, ticker, type }) {
        if (typeof PortfolioStrategy === 'undefined') return;
        let conflict = null;
        try {
            conflict = PortfolioStrategy.checkTransaction({ accountId, ticker, type });
        } catch (e) {
            return; // an advisory is never worth breaking the save path over
        }
        if (!conflict) return;
        // showToast writes innerHTML and the strategy name is user/model
        // text, so it gets escaped like anything else on the way to the DOM.
        const esc = AppManager.escapeHtml;
        UIUtils.showToast(
            `Off ${esc(conflict.strategyName)}: ${esc(conflict.notes[0])}`,
            'warning', 8000,
            {
                actionLabel: 'Discuss',
                onAction: () => {
                    if (typeof AgentUI === 'undefined') return;
                    AgentUI.askWithPrompt(
                        `I just added ${PortfolioApp.displayTicker(ticker)} and it puts me off my strategy "${conflict.strategyName}": ${conflict.notes.join(' ')} ` +
                        `Check my actual holdings against the strategy and tell me what my options are, including doing nothing.`,
                        { newChat: true }
                    );
                }
            }
        );
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
            this._saveHistory();
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
                        account.updatedAt = new Date().toISOString();
                        editModal.close();
                        this.saveData();
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
            this._tombstone(account.id);
            this.transactions.filter(t => t.accountId === account.id)
                .forEach(t => this._tombstone(t.id));
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

    // ---- Account scope (kept names: link-picker and agent deep links
    //      call openAccountDetail; there is no separate view any more) ----

    openAccountDetail(accountId) {
        // Deep links can land here from another view (ticker, snapshots…)
        document.getElementById('portfolio-ticker-view')?.classList.remove('active');
        document.getElementById('portfolio-property-view')?.classList.remove('active');
        document.getElementById('portfolio-snapshots-view')?.classList.remove('active');
        document.getElementById('portfolio-transaction-view')?.classList.remove('active');
        document.getElementById('portfolio-view').classList.add('active');
        this.setScope(accountId);
    },

    closeAccountDetail() {
        this.setScope('all');
    },

    // ---- Transaction CRUD ----

    openTransactionEditor(transactionId = null) {
        if (transactionId) {
            this.editingTransaction = this.transactions.find(t => t.id === transactionId);
        } else {
            this.editingTransaction = null;
        }

        document.getElementById('portfolio-view').classList.remove('active');
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
        document.getElementById('portfolio-view').classList.add('active');
        this.render();
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

            Object.assign(this.editingTransaction, { type, accountId, ticker, quantity, pricePerShare, date, notes, updatedAt: new Date().toISOString() });
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

        // Strategy check runs AFTER the save, and never blocks it: the point
        // is that the conflict is named at the moment of the decision, not
        // that the app second-guesses the trade.
        this.flagStrategyConflict({ accountId, ticker, type });

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

            this._tombstone(this.editingTransaction.id);
            this.transactions = this.transactions.filter(t => t.id !== this.editingTransaction.id);
            this.editingTransaction = null;
            this.saveData();
            this.closeTransactionEditor();
            UIUtils.showToast('Transaction deleted', 'success');
        }
    },

    // ---- Hide Values Toggle ----

    toggleHideValues() {
        this.hideValues = !this.hideValues;
        try { localStorage.setItem('portfolio-hide-values', this.hideValues ? '1' : '0'); } catch (e) { /* ignore */ }
        PortfolioUI.updateHideValuesBtn(this.hideValues);
        this._rerenderCurrentView();
    },

    /**
     * Show or hide extended-session (pre-market / after-hours) quotes
     * everywhere they appear: the summary's Day Change sub-line, each
     * cluster header's day column, and the per-holding price cell. Gated at
     * the two render helpers (PortfolioUI.afterLineHtml and priceCellHtml)
     * rather than at each call site, so a new surface that uses them
     * inherits the setting instead of forgetting it.
     *
     * Machine-local (localStorage), matching hideValues and chartRange.
     * Move it into the synced `portfolio` blob if it should follow the user
     * between Macs — but note saveData writes an explicit object, so the
     * key has to be added there too or it gets wiped on the next write.
     */
    toggleAfterHours() {
        this.showAfterHours = !this.showAfterHours;
        try {
            localStorage.setItem('portfolio-after-hours', this.showAfterHours ? '1' : '0');
        } catch (e) { /* ignore */ }
        this._rerenderCurrentView();
    },

    /** Repaint whichever portfolio page is on screen. */
    _rerenderCurrentView() {
        if (this.viewingTicker) {
            this.renderTickerDetail();
        } else if (this.viewingPropertyId) {
            this.renderPropertyDetail();
        } else {
            this.render();
        }
    },

    // ---- Sorting ----
    // One toggle for all three sortable tables (holdings, properties, cash).
    // Text columns open ascending, numeric ones descending; a repeat click
    // flips direction.

    TEXT_SORT_COLS: ['ticker', 'name', 'address', 'type'],

    setSort(scope, col) {
        const s = this.sort[scope];
        if (!s) return;
        if (s.col === col) {
            s.dir = s.dir === 'asc' ? 'desc' : 'asc';
        } else {
            s.col = col;
            s.dir = this.TEXT_SORT_COLS.includes(col) ? 'asc' : 'desc';
        }
        // Machine-local like the other view preferences (see loadData).
        try { localStorage.setItem('portfolio-sort', JSON.stringify(this.sort)); } catch (e) { /* ignore */ }
        if (scope === 'cash') PortfolioUI.renderCashDetail(this.getAccounts());
        else this.render();
    },

    sortHoldings(holdings) {
        const { col, dir: d } = this.sort.holdings;
        const dir = d === 'asc' ? 1 : -1;
        return [...holdings].sort((a, b) => {
            if (col === 'ticker') return dir * a.ticker.localeCompare(b.ticker);
            return dir * ((a[col] || 0) - (b[col] || 0));
        });
    },

    sortProperties(properties) {
        const { col, dir: d } = this.sort.properties;
        const dir = d === 'asc' ? 1 : -1;
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

    // ---- Ticker Detail View ----

    openCashDetail() {
        this.viewingTicker = '__CASH__';
        document.getElementById('portfolio-view').classList.remove('active');
        document.getElementById('portfolio-ticker-view').classList.add('active');

        const titleEl = document.getElementById('portfolio-ticker-title');
        if (titleEl) titleEl.textContent = 'Cash';

        PortfolioUI.renderCashDetail(this.getAccounts());
    },

    openTickerDetail(ticker) {
        this.viewingTicker = ticker;
        document.getElementById('portfolio-view').classList.remove('active');
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
        document.getElementById('portfolio-view').classList.add('active');
        this.render();
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
        // Percent is against the holdings' own opening base, not totalValue:
        // cash and real estate have no day move, and dividing by them would
        // quietly shrink the number the user is checking.
        const totalDayBase = holdings.reduce((sum, h) => sum + (h.dayBase || 0), 0);
        const totalDayChangePercent = totalDayBase > 0 ? (totalDayChange / totalDayBase) * 100 : 0;
        // Extended-session aggregate across holdings that have a pre/post
        // quote (options never do — their contribution is simply absent).
        const afterChange = holdings.reduce((sum, h) => sum + (h.after ? h.totalShares * h.after.change * h.multiplier : 0), 0);
        const afterBase = holdings.reduce((sum, h) => sum + (h.after ? h.currentValue : 0), 0);
        const afterSession = holdings.find(h => h.after)?.after.session || null;
        return { totalValue, totalCost, totalPL, totalPLPercent, totalDayChange, totalDayChangePercent, totalDayBase, cash, realEstateValue, afterChange, afterBase, afterSession };
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
                        property.updatedAt = new Date().toISOString();

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
            this._tombstone(id);
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

        // The Strategy page. "This strategy" means the one the user pointed
        // the assistant at (the card's own Ask button), or the only plan there
        // is — with more than one and no pick, the subject is the page.
        if (PortfolioApp.currentAccountFilter === 'strategy' && typeof PortfolioStrategy !== 'undefined') {
            const list = PortfolioStrategy.all() || [];
            const focused = (typeof PortfolioStrategyPage !== 'undefined' && PortfolioStrategyPage.focusedStrategyId)
                ? list.find(s => s.id === PortfolioStrategyPage.focusedStrategyId) : null;
            const one = focused || (list.length === 1 ? list[0] : null);
            if (one) {
                return {
                    recordKey: 'portfolio:strategy:' + one.id,
                    recordLabel: one.name || '(strategy)',
                    title: 'CURRENT STRATEGY',
                    body: `The user is viewing their investment strategy "${one.name}" on the Portfolio Strategy page. When they say "this strategy", "this plan" or "it", they mean "${one.name}". Read it with get_strategy and score it against real holdings with check_strategy — never judge adherence yourself, the app computes it. Use save_strategy to change it once the user agrees to the change.

Strategy name: ${one.name}
Status: ${one.status || 'active'}${one.isDefault ? ' (the overall plan accounts fall back to)' : ''}`,
                    suggestedPrompts: [
                        'Am I still on plan?',
                        'What would you change about this strategy?',
                        'Explain my guardrails in plain language'
                    ]
                };
            }
            if (list.length) {
                return {
                    recordKey: 'portfolio:strategies',
                    recordLabel: 'Strategy',
                    title: 'CURRENT STRATEGY PAGE',
                    body: `The user is viewing their investment strategies: ${list.map(s => `"${s.name}"`).join(', ')}. Use get_strategy to read one and check_strategy to score it against real holdings; the app computes adherence, so never judge it yourself.`,
                    suggestedPrompts: [
                        'Am I on plan overall?',
                        'Do these plans conflict with each other?',
                        'Which accounts follow which plan?'
                    ]
                };
            }
            return null;
        }

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
