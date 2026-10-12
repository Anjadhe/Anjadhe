/**
 * PortfolioApp — Finance's investments half, as DATA (2026-10-12,
 * docs/THREAD_PANELS.md step 3). The Finance pages are gone: what the
 * person tracks is seen in a thread's drawer (js/apps/portfolio/
 * finance-panels.js) and changed through the tools (portfolio-tools.js,
 * portfolio-upkeep-tools.js, finance-link-tools.js). What stays here:
 * the record-merged `portfolio` blob (accounts, transactions, properties,
 * debts, strategies), the machine-local quote cache, the value history,
 * the arithmetic over them (holdings, cash, totals), prices, and the
 * context blocks a chat about an account, a strategy or a ticker carries.
 */

const PortfolioApp = {
    isRefreshing: false,

    /** Load the data and learn this Mac's id for brokerage pulls. Called once when the package loads. */
    init() {
        if (this._inited) return;
        this._inited = true;
        this.loadData();
        if (typeof PortfolioBrokerage !== 'undefined') PortfolioBrokerage.init();
    },

    /**
     * Something changed (a sync, a tool's write, new prices): the drawers
     * that draw Finance repaint. The one door; nothing else here knows a
     * view.
     */
    changed() {
        if (typeof ThreadsPage !== 'undefined' && ThreadsPage._panel) { try { ThreadsPage._repaint(); } catch { /* not on screen */ } }
    },

    /**
     * Load data from storage
     */
    loadData() {
        const data = StorageManager.get('portfolio');
        this.accounts = data?.accounts || [];
        this.transactions = data?.transactions || [];
        this.properties = data?.properties || [];
        // Debts — mortgages, loans, credit lines: {id, name, type, balance,
        // originalAmount, interestRate, monthlyPayment, lender, propertyId,
        // startDate, notes, createdAt, updatedAt}. Synced and record-merged
        // like the other arrays (main.js RECORD_MERGE_ARRAYS); deletes
        // tombstone. They subtract from net worth; nothing else reads them.
        this.liabilities = Array.isArray(data?.liabilities) ? data.liabilities : [];
        this.strategies = data?.strategies || [];
        // Tickers once followed without a position (the Watchlist, removed
        // 2026-10-09, docs/COACH.md §7): kept and written back unread, as
        // the person's data.
        this.watchlist = Array.isArray(data?.watchlist) ? data.watchlist : [];
        // Shares once given to contacts (sharing removed 2026-10-09,
        // docs/COACH.md §7; kept and written back unread, as data) — {id,
        // accountId, contactId, contactLabel, scope, generation, lastPushedAt,
        // lastPushedHash, delivered, lastAckAt, revokedAt, pushMachineId},
        // record-merged + tombstoned like the other arrays. Accounts
        // RECEIVED from a contact live in `accounts` with a `shared` block.
        this.shares = Array.isArray(data?.shares) ? data.shares : [];
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
    },

    /** The user's OWN accounts — what totals, tools and
     *  the nav's Accounts section read. Accounts a contact shares in
     *  (`shared` block) are deliberately not here: they never count in
     *  net worth and are reached through getSharedAccounts(). */
    getAccounts() {
        return this.accounts.filter(a => !a.shared);
    },
    /** Accounts another nenva user once shared with this one. Sharing was
     *  removed 2026-10-09 (docs/COACH.md §7): such copies stay in the blob
     *  as data, but nothing shows, quotes or counts them. */
    getSharedAccounts() {
        return [];
    },
    getTransactions() {
        const accountIds = new Set(this.getAccounts().map(a => a.id));
        return this.transactions.filter(t => accountIds.has(t.accountId));
    },
    getProperties() {
        return this.properties;
    },
    getLiabilities() {
        return this.liabilities;
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
            liabilities: this.liabilities,
            strategies: this.strategies,
            watchlist: this.watchlist,
            shares: this.shares,
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

    /** Refresh quotes when any is stale, at most once a minute (a drawer draws on every repaint). */
    async autoRefreshPrices() {
        const tickers = this.getUniqueTickers();
        if (tickers.length === 0) return;
        const hasStale = tickers.some(t => PriceFetcher.isStale(this.priceCache[t]));
        const now = Date.now();
        if (hasStale && !this.isRefreshing && now - (this._lastAutoRefreshAt || 0) > 60000) {
            this._lastAutoRefreshAt = now;
            await this.refreshPrices();
        }
    },

    /** Fetch every held symbol's quote (Yahoo, PriceFetcher), keep today's snapshot, repaint. */
    async refreshPrices() {
        const tickers = this.getUniqueTickers();
        if (tickers.length === 0) return;
        this.isRefreshing = true;
        try {
            this.priceCache = await PriceFetcher.fetchPrices(tickers, this.priceCache);
            this._savePriceCache();
        } catch (error) {
            console.error('Failed to refresh prices:', error);
        } finally {
            this.isRefreshing = false;
            this.recordSnapshot();
            this.changed();
        }
    },

    /**
     * Get unique tickers from all transactions with positive holdings.
     * Expired option contracts are skipped — Yahoo stops quoting them, so a
     * refresh would just fail; their last cached price stands until closed.
     */
    getUniqueTickers() {
        const holdings = this.computeHoldings();
        const tickers = holdings
            .filter(h => h.totalShares > 0)
            .filter(h => !h.option || this.optionDaysToExpiry(h.option) >= 0)
            .map(h => h.ticker);
        // Positions in accounts shared with the user are quoted here too —
        // the tickers are theirs to see; the prices are this Mac's own.
        for (const a of this.getSharedAccounts()) {
            for (const h of this.computeHoldings(a.id)) {
                if (h.totalShares > 0 && !tickers.includes(h.ticker)) tickers.push(h.ticker);
            }
        }
        return tickers;
    },

    // ---- Options (OCC contract symbols) ----
    // A long call/put is tracked as a position whose ticker is the OCC
    // symbol (AAPL261218C00250000) — Yahoo's chart endpoint quotes these
    // directly, so prices, snapshots, and P&L ride the stock pipeline.
    // The only differences: value and cash math use a 100× contract
    // multiplier, and displayTicker gives a friendly label.

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
        // One account: its own rows (a shared account's rows are not in
        // getTransactions, which is scoped to the user's own accounts).
        let txns = accountId
            ? this.transactions.filter(t => t.accountId === accountId)
            : this.getTransactions();

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
            liabilities: summary.liabilitiesTotal,
            netWorth: summary.netWorth,
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

    /** A new account by hand ("my Vanguard IRA"): create_account. Returns the account. */
    createAccount(name, type, cashBalance = null) {
        const now = new Date().toISOString();
        const account = { id: crypto.randomUUID(), name, type, cashBalance: cashBalance == null ? null : cashBalance, createdAt: now, updatedAt: now };
        this.accounts.push(account);
        this.saveData();
        this.changed();
        return account;
    },

    /**
     * Every transaction recorded for one symbol, newest first. Matched on the
     * stored ticker, so an option contract's OCC symbol only ever matches its
     * own detail page — never the underlying's.
     */
    getTickerTransactions(ticker) {
        return this.getTransactions()
            .filter(t => t.ticker === ticker)
            .sort((a, b) => new Date(b.date) - new Date(a.date));
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
     * @param {Array} holdings
     * @param {string|null} accountId - if provided, includes cash for that account; if null, all accounts
     */
    getSummary(holdings, accountId = null) {
        const stockValue = holdings.reduce((sum, h) => sum + h.currentValue, 0);
        const totalCost = holdings.reduce((sum, h) => sum + h.costBasis, 0);
        const cash = this.computeTotalCash(accountId);
        const realEstateValue = accountId ? 0 : this.properties.reduce((sum, p) => sum + (p.currentValue || 0), 0);
        // totalValue is what the user OWNS (assets). Debts are tracked
        // separately and subtracted into netWorth; an account scope has no
        // debts of its own, so there the two are equal.
        const totalValue = stockValue + cash + realEstateValue;
        const liabilitiesTotal = accountId ? 0 : this.liabilities.reduce((sum, l) => sum + (l.balance || 0), 0);
        const netWorth = totalValue - liabilitiesTotal;
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
        return { totalValue, totalCost, totalPL, totalPLPercent, totalDayChange, totalDayChangePercent, totalDayBase, cash, realEstateValue, liabilitiesTotal, netWorth, afterChange, afterBase, afterSession };
    },

    // ---- Liabilities (mortgages, loans, credit lines) ----

    LIABILITY_TYPES: {
        mortgage: 'Mortgage',
        heloc: 'Home equity line',
        auto: 'Auto loan',
        student: 'Student loan',
        personal: 'Personal loan',
        credit: 'Credit card',
        other: 'Other'
    },

    liabilityTypeLabel(type) {
        return this.LIABILITY_TYPES[type] || this.LIABILITY_TYPES.other;
    },

    /** Debts secured by a property (its mortgage / HELOC), for the property detail. */
    liabilitiesForProperty(propertyId) {
        return this.liabilities.filter(l => l.propertyId === propertyId);
    },
};

// One builder each for the CURRENT STRATEGY / ACCOUNT / TICKER blocks, read
// by the 'portfolio' record resolver below: a chat about one of them (its
// thread) carries it.
PortfolioApp.strategyContextBlock = function (strategyId, opts = {}) {
    if (!strategyId || typeof PortfolioStrategy === 'undefined') return null;
    const one = PortfolioStrategy.getById(strategyId);
    if (!one) return null;
    const lead = `This conversation is about the user's investment strategy "${one.name}"`;
    return {
        recordKey: 'portfolio:strategy:' + one.id,
        recordLabel: one.name || '(strategy)',
        title: 'CURRENT STRATEGY',
        body: `${lead}. When they say "this strategy", "this plan" or "it", they mean "${one.name}". Read it with get_strategy and score it against real holdings with check_strategy — never judge adherence yourself, the app computes it. Use save_strategy to change it once the user agrees to the change. A standing instruction about the plan that is not one of its fields (a deployment schedule, a rebalance habit) is kept with save_decision (type strategy) and rides every later read.

Strategy name: ${one.name}
Status: ${one.status || 'active'}${one.isDefault ? ' (the overall plan accounts fall back to)' : ''}`,
        suggestedPrompts: [
            'Am I still on plan?',
            'What would you change about this strategy?',
            'Explain my guardrails in plain language'
        ]
    };
};

PortfolioApp.accountContextBlock = function (accountId, opts = {}) {
    if (!accountId) return null;
    if (!Array.isArray(PortfolioApp.accounts) || PortfolioApp.accounts.length === 0) {
        PortfolioApp.loadData();
    }
    const a = (PortfolioApp.accounts || []).find(x => x && x.id === accountId);
    if (!a) return null;
    const lead = 'This conversation is about the account below';
    return {
        recordKey: 'portfolio:account:' + a.id,
        recordLabel: a.name || '(account)',
        title: 'CURRENT ACCOUNT',
        body: `${lead}. When they say "this account", they mean ${a.name}. Use list_portfolio for current holdings and balances. When the person tells you something standing about the account (what the money is for, how to treat it, what not to do), offer to keep it with save_decision so it rides every later read; that is where notes about the account live. (type account, id ${a.id}).

Account name: ${a.name}
Type: ${a.type || 'unspecified'}
Account id: ${a.id}`,
        suggestedPrompts: [
            'Summarize this account',
            'What are my biggest positions here?',
            'How is this account performing?'
        ]
    };
};

/** A ticker's block, for the record resolver (a ticker's chat). */
PortfolioApp.tickerContextBlock = function (t, opts = {}) {
    if (!t || t === '__CASH__') return null;
    // Options: label reads naturally; tools still take the raw symbol.
    const label = PortfolioApp.displayTicker(t);
    const symbolNote = label === t ? '' : ` The exact symbol for tools is ${t}.`;
    const lead = `This conversation is about the person's ${label} position`;
    return {
        recordKey: 'portfolio:ticker:' + t,
        recordLabel: label,
        title: 'CURRENT TICKER',
        body: `${lead}. When they say "this stock" / "this ticker" / "this position", they mean ${label}.${symbolNote} Use get_ticker_detail for their position in it (across accounts, lots, transactions and its history) and list_portfolio for the whole book. Ground observations in tool numbers. When the person tells you something standing about this holding (what the money is for, how to treat it, what not to do), offer to keep it with save_decision so it rides every later read; that is where notes about this holding live. (type ticker, id ${PortfolioApp.optionMeta?.(t)?.underlying || t}).`,
        suggestedPrompts: [
            `How is my ${label} position doing?`,
            `How much of my portfolio is ${label}?`,
            `When did I buy ${label}, and at what prices?`
        ]
    };
};

// A chat about an account, a strategy or a ticker (its thread) carries its block.
if (typeof AgentContext !== 'undefined') {
    // Record resolver — rebuilds CURRENT STRATEGY / CURRENT ACCOUNT from a
    // conversation's 'portfolio:strategy:<id>' / 'portfolio:account:<id>'
    // attachment (its thread).
    // Page-state keys (overview, history, ticker, strategies) deliberately
    // resolve to nothing: they name a view, not a record.
    AgentContext.registerRecord('portfolio', (rest) => {
        if (rest.startsWith('strategy:')) {
            return PortfolioApp.strategyContextBlock(rest.slice('strategy:'.length), { attached: true });
        }
        if (rest.startsWith('account:')) {
            return PortfolioApp.accountContextBlock(rest.slice('account:'.length), { attached: true });
        }
        // A ticker's own chat (its page's box, 2026-10-09).
        if (rest.startsWith('ticker:')) {
            return PortfolioApp.tickerContextBlock(rest.slice('ticker:'.length), { attached: true });
        }
        return null;
    // A chat attached to a strategy/account carries the portfolio tools.
    }, { domains: ['portfolio'] });
}

if (typeof StorageManager !== 'undefined') PortfolioApp.init();
