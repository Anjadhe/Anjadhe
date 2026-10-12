/**
 * Finance in threads (2026-10-12, docs/THREAD_PANELS.md step 3).
 *
 * Ram: "finance app is kind of a strange thing compared to all the other
 * aspects of this app … we are free to change this to be ai native and not
 * have a fancy ui", and: keep linking banks and brokerages, keep tracking
 * holdings by hand, keep the strategy. So the Finance pages are gone and
 * what they showed is drawn in a thread's drawer, by providers registered
 * here from the package's own folder (V6):
 *
 *   Your money (`page:portfolio`)     the whole picture: net worth and its
 *                                     history, every account, the plan's
 *                                     check, the largest holdings, spending
 *   an account (`portfolio:account:`) its value over time and its holdings
 *   a strategy (`portfolio:strategy:`) its check against the accounts it judges
 *   a ticker (`portfolio:ticker:`)    the person's position in it
 *   any sender with accounts attached (Senders.link kind `account`):
 *                                     those accounts' figures (Retirement's
 *                                     401k, the Amex card's spending)
 *
 * Every number is the package's own arithmetic (computeHoldings, getSummary,
 * PortfolioStrategy.evaluate, SpendingApp.summary): V1. Your money is listed
 * in Threads while there is anything to show (ThreadsPage.registerListed),
 * and the old Finance chats keep their keys, now titled from the record
 * (PageChat.registerHosts).
 */
const FinancePanels = {
    KEY: 'page:portfolio',
    MAX_HOLDINGS: 25,

    hasData() {
        try {
            const pf = StorageManager.get('portfolio') || {};
            const sp = StorageManager.get('spending') || {};
            const own = (pf.accounts || []).filter(a => a && !a.shared).length;
            return !!(own || (pf.properties || []).length || (pf.liabilities || []).length || (sp.accounts || []).length);
        } catch { return false; }
    },

    /** Open a thread with its drawer: Your money, an account, a strategy, a ticker. */
    open(key = this.KEY) {
        if (typeof ThreadsPage !== 'undefined') ThreadsPage.openPanel(key);
    },

    /**
     * What a thread's money is (pure over the row): which investment accounts
     * (`'all'` or ids), which bank and card accounts, a strategy, a ticker.
     * null when the thread holds no money.
     */
    scopeOf(row) {
        if (!row || !row.key) return null;
        const key = row.key;
        if (key === this.KEY) return { whole: true, portfolio: 'all', spending: 'all' };
        let m = /^portfolio:account:(.+)$/.exec(key);
        if (m) return { portfolio: [m[1]], spending: [] };
        m = /^portfolio:strategy:(.+)$/.exec(key);
        if (m) return { strategy: m[1], portfolio: [], spending: [] };
        m = /^portfolio:ticker:(.+)$/.exec(key);
        if (m) return { ticker: m[1], portfolio: [], spending: [] };
        const links = row.rec && Array.isArray(row.rec.links) ? row.rec.links.filter(l => l && l.kind === 'account') : [];
        if (!links.length) return null;
        const ids = kind => links.map(l => /^(portfolio|spending):(.+)$/.exec(String(l.ref || ''))).filter(x => x && x[1] === kind).map(x => x[2]);
        return { portfolio: ids('portfolio'), spending: ids('spending') };
    },

    // ── Reads (the package's own arithmetic) ────────────────────────────

    _accounts(scope) {
        PortfolioApp.loadData();
        const all = PortfolioApp.getAccounts();
        return scope.portfolio === 'all' ? all : all.filter(a => (scope.portfolio || []).includes(a.id));
    },
    /** Holdings across the scope's accounts, one row per ticker. */
    _holdings(accounts, whole) {
        if (whole) return PortfolioApp.computeHoldings();
        const by = new Map();
        for (const a of accounts) {
            for (const h of PortfolioApp.computeHoldings(a.id)) {
                const had = by.get(h.ticker);
                if (!had) { by.set(h.ticker, { ...h }); continue; }
                had.totalShares += h.totalShares; had.currentValue += h.currentValue; had.costBasis += h.costBasis; had.profitLoss += h.profitLoss;
                had.profitLossPercent = had.costBasis > 0 ? (had.profitLoss / had.costBasis) * 100 : 0;
            }
        }
        return [...by.values()].sort((x, y) => y.currentValue - x.currentValue);
    },
    _accountValue(a) {
        return PortfolioApp.computeHoldings(a.id).reduce((t, h) => t + (h.currentValue || 0), 0) + PortfolioApp.computeCash(a.id);
    },
    TYPE_WORDS: { brokerage: 'Brokerage', '401k': '401(k)', ira: 'IRA', 'roth-ira': 'Roth IRA', hsa: 'HSA', savings: 'Savings', checking: 'Checking', other: 'Investments' },
    _status(a) {
        const b = a.brokerage;
        if (!b) return 'Kept by hand';
        if (b.needsLogin) return 'Needs sign-in';
        if (b.drift && b.drift.length) return `${b.drift.length} position${b.drift.length === 1 ? '' : 's'} differ`;
        return `Linked to ${b.institution || 'brokerage'}`;
    },
    _spendingAccounts(scope) {
        if (typeof SpendingApp === 'undefined') return [];
        SpendingApp.loadData();
        const all = SpendingApp.accounts();
        return scope.spending === 'all' ? all : all.filter(a => (scope.spending || []).includes(a.id));
    },

    // ── Thread titles and the chat each carries ─────────────────────────

    hostFor(key) {
        if (key === this.KEY) return { title: 'Your money', avatar: 'money' };
        let m = /^portfolio:account:(.+)$/.exec(key);
        if (m) {
            PortfolioApp.loadData();
            const a = PortfolioApp.getAccounts().find(x => x.id === m[1]);
            return a ? { title: a.name || 'Account', recordKey: key, recordLabel: a.name || 'Account', body: `It is your ${a.type || 'investment'} account` } : null;
        }
        m = /^portfolio:strategy:(.+)$/.exec(key);
        if (m && typeof PortfolioStrategy !== 'undefined') {
            const s = PortfolioStrategy.getById(m[1]);
            return s ? { title: s.name || 'Strategy', recordKey: key, recordLabel: s.name || 'Strategy', body: 'It is your investment strategy' } : null;
        }
        m = /^portfolio:ticker:(.+)$/.exec(key);
        if (m) {
            const label = PortfolioApp.displayTicker(m[1]);
            return { title: label, recordKey: key, recordLabel: label, body: `It is your ${label} position` };
        }
        return null;
    }
};

if (typeof PageChat !== 'undefined' && PageChat.registerHosts) {
    PageChat.registerHosts(/^(page:portfolio|portfolio:(account|strategy|ticker):.+)$/, key => FinancePanels.hostFor(key));
}
if (typeof ThreadsPage !== 'undefined' && ThreadsPage.registerListed) {
    ThreadsPage.registerListed(() => (FinancePanels.hasData() ? [FinancePanels.KEY] : []));
    // The money coach's raises about money as a whole (no one bill or goal) are Your money's.
    if (ThreadsPage.registerCardHome) ThreadsPage.registerCardHome(FinancePanels.KEY, c => /^money:/.test(String(c.key || '')) && !c.moneyItem && FinancePanels.hasData());
}

// A link in an answer or in a drawer's table opens the thing's thread with its drawer.
if (typeof RecordLinks !== 'undefined' && RecordLinks.register) {
    const pf = () => StorageManager.get('portfolio') || {};
    RecordLinks.register('account', { label: 'money account', hint: 'an investment account; use its id from list_portfolio',
        exists: id => (pf().accounts || []).some(a => a && a.id === id),
        open: id => FinancePanels.open(`portfolio:account:${id}`) });
    RecordLinks.register('strategy', { label: 'investment strategy', hint: 'use its id from get_strategy',
        exists: id => (pf().strategies || []).some(s => s && s.id === id),
        open: id => FinancePanels.open(`portfolio:strategy:${id}`) });
    RecordLinks.register('ticker', { label: 'holding', hint: 'a stock or fund symbol the person holds',
        exists: () => null,
        open: id => FinancePanels.open(`portfolio:ticker:${String(id).toUpperCase()}`) });
}

// ── The providers (V6: registered here, never a branch in the drawer) ───

if (typeof ThreadPanels !== 'undefined') {
    const F = FinancePanels;
    const fresh = row => {
        const scope = F.scopeOf(row);
        if (!scope) return;
        PortfolioApp.autoRefreshPrices();
        if (typeof PortfolioBrokerage !== 'undefined') PortfolioBrokerage.ensureFresh();
        if (typeof SpendingSync !== 'undefined' && (scope.spending === 'all' || (scope.spending || []).length)) SpendingSync.ensureFresh();
    };

    // Your money: net worth now and over time.
    ThreadPanels.register({
        id: 'networth', label: 'Net worth', order: 1, touch: fresh,
        build(rows, ctx, row) {
            const scope = F.scopeOf(row);
            if (!scope || !scope.whole) return null;
            PortfolioApp.loadData();
            const s = PortfolioApp.getSummary(PortfolioApp.computeHoldings());
            if (!(s.totalValue || s.liabilitiesTotal)) return null;
            const items = [{ label: 'Net worth', value: s.netWorth, format: 'money' }];
            const invested = s.totalValue - s.cash - s.realEstateValue;
            if (invested) items.push({ label: 'Investments', value: invested, format: 'money' });
            if (s.cash) items.push({ label: 'Cash', value: s.cash, format: 'money' });
            if (s.realEstateValue) items.push({ label: 'Property', value: s.realEstateValue, format: 'money' });
            if (s.liabilitiesTotal) items.push({ label: 'Debts', value: -s.liabilitiesTotal, format: 'money', signed: true });
            if (s.totalDayChange) items.push({ label: 'Today', value: s.totalDayChange, format: 'money', signed: true, sub: `${s.totalDayChangePercent >= 0 ? '+' : '−'}${Math.abs(Math.round(s.totalDayChangePercent * 10) / 10)}%` });
            const hist = (PortfolioApp.valueHistory || []).filter(h => Number.isFinite(Number(h.netWorth != null ? h.netWorth : h.totalValue)));
            const out = [{ key: 'now', kind: 'stats', items }];
            if (hist.length >= 2) out.push({ key: 'history', kind: 'line', label: 'Net worth', format: 'money', signed: true, points: hist.map(h => ({ x: h.date, y: h.netWorth != null ? h.netWorth : h.totalValue })) });
            return out;
        }
    });

    // The accounts in scope: what each is worth and how it is kept.
    ThreadPanels.register({
        id: 'accounts', label: 'Accounts', order: 2, touch: fresh,
        build(rows, ctx, row) {
            const scope = F.scopeOf(row);
            if (!scope || scope.ticker || scope.strategy) return null;
            const inv = F._accounts(scope).map(a => ({ name: a.name, kind: F.TYPE_WORDS[a.type] || 'Investments', value: Math.round(F._accountValue(a) * 100) / 100, status: F._status(a), _link: `anjadhe://account/${a.id}` }));
            const bank = F._spendingAccounts(scope).map(a => ({ name: a.name, kind: a.type === 'credit' ? 'Card' : a.type === 'savings' ? 'Savings' : 'Bank', value: a.balance && a.balance.current != null ? (a.type === 'credit' ? -a.balance.current : a.balance.current) : null,
                status: (() => { const l = (SpendingApp.links() || []).find(x => x.id === a.itemId); return l && l.needsLogin ? 'Needs sign-in' : `Linked to ${a.institution || 'bank'}`; })() }));
            const list = [...inv, ...bank];
            // One account's own thread: its value over time instead of a one-row table.
            if (!scope.whole && inv.length === 1 && !bank.length) {
                const a = F._accounts(scope)[0];
                const hist = PortfolioApp.getAccountHistory(a.id);
                return hist.length >= 2 ? { key: 'history', kind: 'line', title: a.name, label: 'Value', format: 'money', signed: true, points: hist.map(h => ({ x: h.date, y: h.value })) } : null;
            }
            if (!list.length) return null;
            return { key: 'list', kind: 'table', title: 'Accounts', sort: '-value', columns: [{ key: 'name', label: 'Account', format: 'text' }, { key: 'kind', label: 'Kind', format: 'text' }, { key: 'value', label: 'Value', format: 'money' }, { key: 'status', label: 'Kept', format: 'text' }], rows: list };
        }
    });

    // The plan's check (PortfolioStrategy.evaluate): every sleeve against its band, and the rules.
    ThreadPanels.register({
        id: 'plan', label: 'Strategy', order: 3,
        build(rows, ctx, row) {
            const scope = F.scopeOf(row);
            if (!scope || scope.ticker || typeof PortfolioStrategy === 'undefined') return null;
            let strategy = null, accountId = null;
            if (scope.strategy) strategy = PortfolioStrategy.getById(scope.strategy);
            else if (scope.whole) strategy = PortfolioStrategy.getDefault();
            // One account is checked only against a plan of its OWN: an account that follows the
            // household plan is one piece of it, and graded alone it would read as off plan.
            else if ((scope.portfolio || []).length === 1) { accountId = scope.portfolio[0]; const f = PortfolioStrategy.forAccount(accountId); strategy = f.inherited ? null : f.strategy; }
            if (!strategy || PortfolioStrategy.missingTopics(strategy).length) return null;
            const r = PortfolioStrategy.evaluate(strategy, accountId ? { accountId } : {});
            if (!r || r.empty) return null;
            const out = [];
            if (r.targets.length) {
                out.push({ key: `targets:${strategy.id}`, kind: 'table', title: `${strategy.name}: ${r.headline}`, columns: [
                    { key: 'sleeve', label: 'Sleeve', format: 'text' }, { key: 'actual', label: 'Now', format: 'pct' }, { key: 'target', label: 'Target', format: 'pct' },
                    { key: 'band', label: 'Band', format: 'text' }, { key: 'state', label: 'Status', format: 'text' }],
                    rows: r.targets.map(t => ({ sleeve: t.label, actual: Math.round(t.actualPct * 10) / 10, target: t.targetPct, band: `${Math.round(t.minPct)}–${Math.round(t.maxPct)}%`,
                        state: t.status === 'ok' ? 'On plan' : t.status === 'over' ? 'Over' : 'Under' })) });
            }
            const broken = r.rules.filter(x => x.status === 'breach');
            if (broken.length) out.push({ key: `rules:${strategy.id}`, kind: 'table', title: 'Rules not kept', columns: [{ key: 'rule', label: 'Rule', format: 'text' }], rows: broken.map(x => ({ rule: x.detail })) });
            return out;
        }
    });

    // The largest holdings in scope, or one ticker's position.
    ThreadPanels.register({
        id: 'holdings', label: 'Holdings', order: 4,
        build(rows, ctx, row) {
            const scope = F.scopeOf(row);
            if (!scope) return null;
            PortfolioApp.loadData();
            if (scope.ticker) {
                const sym = scope.ticker;
                const by = PortfolioApp.computeHoldingsForTickerByAccount(sym).concat(
                    PortfolioApp.optionMeta(sym) ? [] : PortfolioApp.getUniqueTickers().filter(t => (PortfolioApp.optionMeta(t) || {}).underlying === sym).flatMap(t => PortfolioApp.computeHoldingsForTickerByAccount(t)));
                if (!by.length) return null;
                const total = by.reduce((t, h) => t + h.currentValue, 0), cost = by.reduce((t, h) => t + h.costBasis, 0);
                const out = [{ key: 'position', kind: 'stats', items: [
                    { label: 'Value', value: total, format: 'money' }, { label: 'Gain', value: total - cost, format: 'money', signed: true, sub: cost > 0 ? `${((total - cost) / cost * 100).toFixed(1)}%` : undefined },
                    { label: 'Price', value: (by[0] || {}).currentPrice || null, format: 'money2' }] }];
                if (by.length > 1) out.push({ key: 'accounts', kind: 'table', title: 'By account', sort: '-value', columns: [{ key: 'account', label: 'Account', format: 'text' }, { key: 'shares', label: 'Shares', format: 'shares' }, { key: 'value', label: 'Value', format: 'money' }],
                    rows: by.map(h => ({ account: h.account.name, shares: h.totalShares, value: h.currentValue })) });
                const hist = PortfolioApp.getTickerHistory(sym);
                if (hist.length >= 2) out.push({ key: 'history', kind: 'line', label: 'Your position', format: 'money', signed: true, points: hist.map(h => ({ x: h.date, y: h.value })) });
                return out;
            }
            if (scope.strategy) return null;
            const accounts = F._accounts(scope);
            if (!scope.whole && !accounts.length) return null;
            const hs = F._holdings(accounts, scope.whole).filter(h => h.totalShares > 0);
            if (!hs.length) return null;
            const total = hs.reduce((t, h) => t + h.currentValue, 0);
            return { key: 'top', kind: 'table', title: hs.length > F.MAX_HOLDINGS ? `Largest ${F.MAX_HOLDINGS} holdings` : 'Holdings', sort: '-value', columns: [
                { key: 'ticker', label: 'Holding', format: 'text' }, { key: 'value', label: 'Value', format: 'money' }, { key: 'share', label: 'Of total', format: 'pct' },
                { key: 'gain', label: 'Gain', format: 'money', signed: true }, { key: 'gainPct', label: 'Gain %', format: 'pct', signed: true }],
                rows: hs.slice(0, F.MAX_HOLDINGS).map(h => ({ ticker: PortfolioApp.displayTicker(h.ticker), value: h.currentValue, share: total > 0 ? Math.round(h.currentValue / total * 1000) / 10 : null,
                    gain: h.currentPrice ? h.profitLoss : null, gainPct: h.currentPrice ? Math.round(h.profitLossPercent * 10) / 10 : null, _link: `anjadhe://ticker/${PortfolioApp.optionMeta(h.ticker)?.underlying || h.ticker}` })) };
        }
    });

    // Bank and card spending in scope: this month by category, and the months before.
    ThreadPanels.register({
        id: 'spending', label: 'Spending', order: 5,
        build(rows, ctx, row) {
            const scope = F.scopeOf(row);
            if (!scope || typeof SpendingApp === 'undefined') return null;
            const accts = F._spendingAccounts(scope);
            if (!accts.length) return null;
            const ids = scope.spending === 'all' ? null : accts.map(a => a.id);
            const month = SpendingApp.currentMonth();
            const cur = SpendingApp.summary(month, { accountId: ids });
            const out = [];
            if (cur.byCategory.length) out.push({ key: 'categories', kind: 'bar', title: `Spending, ${SpendingApp.monthLabel(month)}`, items: cur.byCategory.slice(0, 8).map(c => ({ label: c.label, value: c.total, format: 'money' })) });
            const trend = SpendingApp.monthTrend(SpendingApp.scopedTransactions(ids), SpendingApp.rules(), month, 6).filter(x => x.spend);
            if (trend.length >= 2) out.push({ key: 'months', kind: 'bar', title: 'By month', items: trend.map(x => ({ label: SpendingApp.monthLabel(x.month), value: x.spend, format: 'money' })) });
            return out;
        }
    });
}

if (typeof module !== 'undefined') module.exports = FinancePanels;
