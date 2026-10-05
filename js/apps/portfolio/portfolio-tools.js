/**
 * Portfolio — the package's contribution to the assistant.
 *
 * Everything the assistant knows about the portfolio is registered HERE,
 * from the app's own folder (docs/PLATFORM.md "App packages"): the twelve
 * tools with their policy (ask, untrusted block, read-only, privacy class,
 * consent line), the vocabulary that summons the group — including the
 * user's own account names, which is why the domain matcher is a
 * predicate, not a regex — the ⌘K/search_all source, the record-merged
 * arrays the write ledger must tombstone, and the cross-app API other
 * packages act through (Anjadhe.expose('portfolio') — Email's
 * "Add to portfolio" is the consumer).
 *
 * The ambient context provider and the record resolver stay in
 * portfolio-app.js beside the block builders they share. Loads last in the
 * package (manifest `scripts`), after the agent stack.
 */

(function registerPortfolioTools() {
    if (typeof AgentTools === 'undefined' || typeof PortfolioApp === 'undefined') return;

    const SOURCE = 'portfolio';
    const esc = (v) => (typeof UIUtils !== 'undefined' ? UIUtils.escapeHtml(String(v == null ? '' : v)) : String(v == null ? '' : v));

    function refresh() {
        if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'portfolio') {
            PortfolioApp.loadData();
            PortfolioApp.render();
        }
    }

    // Rounding helpers — aggressive trimming shaves ~10-20% off the token
    // count vs raw floats. Prices keep 2dp only below $100; gains and
    // dollar values round to integer; percentages keep 1dp.
    const d0 = n => Math.round(n || 0);
    const d1 = n => Math.round((n || 0) * 10) / 10;
    const price = p => !p ? null : (p >= 100 ? Math.round(p) : Math.round(p * 100) / 100);

    function findAccount(name) {
        const accounts = PortfolioApp.getAccounts() || [];
        const want = String(name || '').trim().toLowerCase();
        return accounts.find(a => String(a.name || '').toLowerCase() === want)
            || accounts.find(a => String(a.name || '').toLowerCase().includes(want))
            || null;
    }

    /**
     * Notes the user linked to the portfolio (pseudo-item 'overview') or to
     * individual accounts (LinkManager, app 'portfolio'). Rides along in
     * list_portfolio so the user's own written thinking sits next to the
     * numbers without a separate lookup. Bodies are clipped; the id lets the
     * model get_note the rest. NOT the saved strategy — that is
     * PortfolioStrategy, structured and scoreable, surfaced separately.
     */
    function linkedNotes(accounts) {
        if (typeof LinkManager === 'undefined') return null;
        const allNotes = (StorageManager.get('notes')?.notes) || [];
        // Shared text budget across ALL notes: list_portfolio results are
        // hard-trimmed at resultMaxChars (6k), which destroys the JSON shape
        // — so past the budget, notes degrade to title + a get_note pointer.
        let budget = 3500;
        const PER_NOTE = 1200;
        const resolve = (itemId) => LinkManager.getLinksForApp('portfolio', itemId, 'notes')
            .map(l => allNotes.find(n => n.id === l.itemId))
            .filter(Boolean)
            .map(n => {
                const text = AgentTools._noteText(n);
                const cap = Math.min(PER_NOTE, budget);
                if (!text || cap < 200) {
                    return { id: n.id, title: n.title, text: text ? `(read with get_note id=${n.id})` : '' };
                }
                const clipped = text.length > cap
                    ? text.slice(0, cap) + `… (truncated — get_note id=${n.id} for the rest)`
                    : text;
                budget -= clipped.length;
                return { id: n.id, title: n.title, text: clipped };
            });
        const out = {};
        const overview = resolve('overview');
        if (overview.length) out.portfolio = overview;
        for (const a of (accounts || [])) {
            const notes = resolve(a.id);
            if (notes.length) (out.accounts = out.accounts || []).push({ account: a.name, notes });
        }
        return Object.keys(out).length ? out : null;
    }

    // What this group is for, for the use_tools catalog (AI native 2026-10-02:
    // no word list decides when it loads; the model asks for it).
    AgentTools.GROUP_INFO[SOURCE] = 'investments: accounts, holdings, trades, net worth, the investment plan and how well it is followed';

    // ── Cross-app API (Anjadhe.use('portfolio')) ───────────────────────
    // What another package may do to the portfolio without holding
    // PortfolioApp: read accounts/transactions, add transactions (cash
    // effect + save + price refresh in one call), build an OCC symbol.
    if (typeof Anjadhe !== 'undefined') {
        Anjadhe.expose('portfolio', {
            accounts() {
                PortfolioApp.loadData();
                return (PortfolioApp.accounts || []).map(a => ({ id: a.id, name: a.name, type: a.type || null }));
            },
            transactions() {
                PortfolioApp.loadData();
                return (PortfolioApp.transactions || []).map(t => Object.assign({}, t));
            },
            buildOccSymbol(ticker, expiration, optType, strike) {
                return PortfolioApp.buildOccSymbol(ticker, expiration, optType, strike);
            },
            /** Plain numbers for the money fact sheet (js/core/money-facts.js):
             *  totals, accounts, debts, value history, largest holdings and
             *  the plan's computed report. null when nothing is recorded. */
            facts() {
                PortfolioApp.loadData();
                const accounts = PortfolioApp.getAccounts() || [];
                const liabilities = PortfolioApp.getLiabilities() || [];
                if (!accounts.length && !(PortfolioApp.getProperties() || []).length && !liabilities.length) return null;
                const holdings = PortfolioApp.computeHoldings() || [];
                const s = PortfolioApp.getSummary(holdings);
                let plan = null;
                const strategy = typeof PortfolioStrategy !== 'undefined' ? PortfolioStrategy.getDefault() : null;
                if (strategy) {
                    const report = PortfolioStrategy.missingTopics(strategy).length ? null : PortfolioStrategy.evaluate(strategy);
                    plan = (!report || report.empty)
                        ? { name: strategy.name, status: report ? 'nothing held yet' : 'unfinished' }
                        : { name: strategy.name, status: report.status, headline: report.headline,
                            offTarget: report.targets.filter(t => t.status !== 'ok').map(t => ({ sleeve: t.label, actualPct: d1(t.actualPct), targetPct: t.targetPct, band: `${t.minPct}-${t.maxPct}` })),
                            brokenRules: report.rules.filter(r => r.status === 'breach').map(r => r.detail) };
                }
                return {
                    summary: { totalValue: s.totalValue, invested: s.totalValue - s.cash - s.realEstateValue, cash: s.cash,
                        realEstateValue: s.realEstateValue, liabilitiesTotal: s.liabilitiesTotal, netWorth: s.netWorth },
                    accounts: PortfolioApp.computeHoldingsByAccount().map(({ account, holdings: hs, cash }) => ({
                        name: account.name, type: account.type || null, cash: cash || 0,
                        value: hs.reduce((t, h) => t + (h.currentValue || 0), 0) + (cash || 0) })),
                    liabilities: liabilities.map(l => ({ name: l.name, type: l.type, balance: l.balance || 0, interestRate: l.interestRate, monthlyPayment: l.monthlyPayment })),
                    history: (PortfolioApp.valueHistory || []).map(h => ({ date: h.date, totalValue: h.totalValue, liabilities: h.liabilities, netWorth: h.netWorth })),
                    unpriced: holdings.filter(h => !h.currentPrice).map(h => PortfolioApp.displayTicker(h.ticker)),
                    top: s.totalValue > 0 ? holdings.slice(0, 5).map(h => ({ ticker: PortfolioApp.displayTicker(h.ticker), pct: (h.currentValue / s.totalValue) * 100 })) : [],
                    plan
                };
            },
            /** Append transactions (already shaped: accountId, type, ticker,
             *  quantity, pricePerShare, date, …); applies each one's cash
             *  effect, saves once, refreshes prices. Returns the count. */
            addTransactions(txns) {
                PortfolioApp.loadData();
                let n = 0;
                for (const t of (Array.isArray(txns) ? txns : [])) {
                    if (!t || !t.accountId || !t.ticker) continue;
                    const txn = Object.assign({ id: crypto.randomUUID(), createdAt: new Date().toISOString() }, t);
                    PortfolioApp.transactions.push(txn);
                    PortfolioApp.adjustCash(txn.accountId, txn.type, PortfolioApp.txnAmount(txn));
                    n++;
                }
                if (n) { PortfolioApp.saveData(); PortfolioApp.refreshPrices(); refresh(); }
                return n;
            }
        });
    }

    // ── Record types: what a chat can be ABOUT, @-mention, hold decisions ──
    if (typeof RecordTypes !== 'undefined') {
        const pf = () => StorageManager.get('portfolio') || {};
        RecordTypes.register('strategy', {
            label: 'Strategy', plural: 'strategies', words: ['strategy', 'strategies'], app: SOURCE,
            recordKey: (id) => `portfolio:strategy:${id}`, match: /^portfolio:strategy:(.+)$/,
            index: () => (Array.isArray(pf().strategies) ? pf().strategies : []).map(s => ({
                id: s.id, title: s.name || '(untitled)', sub: s.objective || '',
                body: `${s.objective || ''} ${s.thesis || ''}`, recency: s.modifiedAt || s.updatedAt || s.createdAt || '' })),
            // Tools address strategies by name, so a name resolves too (the
            // KEY still carries the id, so renames don't orphan).
            resolve: ({ id, name }) => {
                if (typeof PortfolioStrategy === 'undefined') return null;
                const s = PortfolioStrategy.find(id || name || '');
                return s ? { id: s.id, title: s.name || 'strategy' } : null;
            },
            ids: () => { const l = pf().strategies; return Array.isArray(l) ? new Set(l.map(s => String(s.id))) : null; },
            open: (id) => {
                AppManager.openApp('portfolio', false);
                setTimeout(() => {
                    PortfolioApp.setScope?.('strategy');
                    if (typeof PortfolioStrategyPage !== 'undefined') PortfolioStrategyPage.open?.(id);
                }, 0);
            }
        });
        RecordTypes.register('account', {
            label: 'Account', plural: 'accounts', words: ['account', 'accounts'], app: SOURCE,
            recordKey: (id) => `portfolio:account:${id}`, match: /^portfolio:account:(.+)$/,
            index: () => (Array.isArray(pf().accounts) ? pf().accounts : []).map(a => ({
                id: a.id, title: a.name || '(untitled)', sub: a.type || '',
                body: `${a.type || ''} ${a.institution || ''}`, recency: a.updatedAt || a.createdAt || '' })),
            resolve: ({ id, name }) => {
                PortfolioApp.loadData();
                const accounts = PortfolioApp.getAccounts() || [];
                const want = (name || '').toLowerCase();
                const a = accounts.find(x => x && String(x.id) === String(id || ''))
                    || (want ? accounts.find(x => (x.name || '').toLowerCase() === want) : null)
                    || (want ? accounts.find(x => (x.name || '').toLowerCase().includes(want)) : null);
                return a ? { id: a.id, title: a.name || 'account' } : null;
            },
            ids: () => { const l = pf().accounts; return Array.isArray(l) ? new Set(l.map(a => String(a.id))) : null; },
            open: (id) => { AppManager.openApp('portfolio', false); setTimeout(() => PortfolioApp.openAccountDetail?.(id), 0); }
        });
        // A ticker page is something a chat can be about — and, since
        // 2026-09-03, a DECISION HOST: the owner's corrections and notes on a
        // symbol ("their biggest customer is X", "treat this as a core
        // holding") are what the daily business profile is rewritten
        // around (PortfolioProfile.ownerNotesBlock). The id IS the symbol
        // (an option resolves to its underlying), any well-formed symbol
        // resolves (a profile can be about a stock the user does not
        // hold), and `ids` stays null so nothing is ever pruned.
        RecordTypes.register('ticker', {
            label: 'Ticker', plural: 'tickers', words: [], app: SOURCE,
            recordKey: (id) => `portfolio:ticker:${id}`, match: /^portfolio:ticker:(.+)$/,
            resolve: ({ id, name }) => {
                const raw = String(id || name || '').trim().toUpperCase();
                if (!raw || raw === '__CASH__') return null;
                const sym = PortfolioApp.optionMeta?.(raw)?.underlying || raw;
                if (!/^[A-Z0-9][A-Z0-9.\-=^]{0,14}$/.test(sym)) return null;
                return { id: sym, title: PortfolioApp.displayTicker?.(sym) || sym };
            },
            open: (id) => { AppManager.openApp('portfolio', false); setTimeout(() => PortfolioApp.openTickerDetail?.(id), 0); }
        });
    }

    // ── Links: notes attach to an account or to the portfolio as a whole ──
    if (typeof LinkManager !== 'undefined') {
        LinkManager.registerApp(SOURCE, {
            label: 'Account', plural: 'Accounts',
            // 'overview' is a pseudo-item for the portfolio as a whole, so a
            // strategy note can attach to the overview rather than one
            // account. It always exists — never treat it as stale.
            getItemMeta(itemId) {
                if (itemId === 'overview') return { title: 'Portfolio', overview: true };
                const item = ((StorageManager.get('portfolio') || {}).accounts || []).find(a => a.id === itemId);
                return item ? { title: item.name, type: item.type } : null;
            },
            getAppItems() {
                const accounts = ((StorageManager.get('portfolio') || {}).accounts || []).map(a => ({ id: a.id, title: a.name, type: a.type }));
                return [{ id: 'overview', title: 'Portfolio (all accounts)' }, ...accounts];
            },
            renderMeta: (item) => (item.type && typeof PortfolioUI !== 'undefined') ? PortfolioUI.formatAccountType(item.type) : (item.type || ''),
            open(itemId) {
                AppManager.openApp('portfolio');
                // 'overview' is the app view itself; an account id opens its detail.
                if (itemId && itemId !== 'overview') setTimeout(() => PortfolioApp.openAccountDetail(itemId), 0);
            }
        });
    }

    // ── Quick-start pill ────────────────────────────────────────────────
    if (typeof AgentUI !== 'undefined' && AgentUI.registerSuggestion) {
        AgentUI.registerSuggestion({ text: 'How is my portfolio doing?',
            when: () => ((StorageManager.get('portfolio')?.accounts) || []).length > 0 });
    }

    // ── Undo bookkeeping: the arrays a whole-blob restore cannot shrink ──
    if (typeof WriteLedger !== 'undefined') {
        WriteLedger.registerMergedArrays('portfolio', ['accounts', 'transactions', 'properties', 'strategies', 'watchlist', 'liabilities']);
    }

    // ── Search (⌘K + search_all) ───────────────────────────────────────
    // "padma robinhood" must find the account record itself, not a note
    // that merely mentions it. Holdings are derived, not records, so they
    // are not indexed; the account is what the user names in "update X
    // with this trade".
    if (typeof GlobalSearch !== 'undefined') {
        GlobalSearch.registerSource(SOURCE, {
            label: 'Portfolio',
            index(push) {
                const pf = StorageManager.get('portfolio') || {};
                for (const a of (Array.isArray(pf.accounts) ? pf.accounts : [])) {
                    push(a.id, a.name, `${a.type || ''} ${a.institution || ''} ${a.notes || ''}`,
                        { sub: a.type || '', meta: { kind: 'account', type: a.type || null } });
                }
                for (const p of (Array.isArray(pf.properties) ? pf.properties : [])) {
                    push(p.id, p.name || p.address || 'Property', p.address || '',
                        { sub: 'Property', meta: { kind: 'property' } });
                }
                for (const l of (Array.isArray(pf.liabilities) ? pf.liabilities : [])) {
                    push(l.id, l.name || 'Liability', `${l.type || ''} ${l.lender || ''} ${l.notes || ''}`,
                        { sub: l.lender || 'Liability', meta: { kind: 'liability' } });
                }
            },
            open(hit) {
                // Properties have no per-record page; accounts deep-link via
                // navigateToItem's portfolio case (openAccountDetail).
                if (hit.meta?.kind === 'property') { AppManager.openApp('portfolio'); return; }
                if (hit.meta?.kind === 'liability') {
                    AppManager.openApp('portfolio');
                    PortfolioApp.openLiabilityDetail(hit.id);
                    return;
                }
                if (typeof LinkedItemsUI?.navigateToItem === 'function') LinkedItemsUI.navigateToItem('portfolio', hit.id);
                else AppManager.openApp('portfolio');
            }
        });
    }

    // ── Tools ──────────────────────────────────────────────────────────
    const reg = (def, handler, opts) => AgentTools.register({ type: 'function', function: def }, handler, Object.assign({ source: SOURCE, group: SOURCE }, opts || {}));

    reg({
        name: 'list_portfolio',
        description: 'Portfolio snapshot. include=overview (default): totals (assets, liabilities such as mortgages/loans, net worth) + top 5 holdings. include=full: per-account with price/gain/day%, plus each liability. Returns pricesAsOf for staleness, the user\'s saved strategy if they have one, and any notes they linked to the portfolio or its accounts.',
        parameters: { type: 'object', properties: {
            include: { type: 'string', enum: ['overview', 'full'], description: 'Default: overview' }
        }}
    }, (args = {}, ctx) => {
        PortfolioApp.loadData();

        const full = args.include === 'full';
        const accounts = PortfolioApp.getAccounts();
        const properties = PortfolioApp.getProperties();
        const liabilities = PortfolioApp.getLiabilities();
        const allHoldings = PortfolioApp.computeHoldings();

        const totalCash = accounts.reduce((s, a) => s + (a.cashBalance || 0), 0);
        const totalEquities = allHoldings.reduce((s, h) => s + h.currentValue, 0);
        const totalProperties = properties.reduce((s, p) => s + (p.currentValue || 0), 0);
        const totalLiabilities = liabilities.reduce((s, l) => s + (l.balance || 0), 0);
        // Allocation percentages are of ASSETS; net worth subtracts debt.
        const totalAssets = totalCash + totalEquities + totalProperties;
        const netWorth = totalAssets - totalLiabilities;
        const dayChange = allHoldings.reduce((s, h) => s + h.dayChange, 0);
        const equitiesPrior = totalEquities - dayChange;
        const dayChangePct = equitiesPrior > 0 ? (dayChange / equitiesPrior) * 100 : 0;

        const byClass = totalAssets > 0 ? {
            cash: d1((totalCash / totalAssets) * 100),
            equities: d1((totalEquities / totalAssets) * 100),
            properties: d1((totalProperties / totalAssets) * 100)
        } : { cash: 0, equities: 0, properties: 0 };

        const topHoldings = allHoldings.slice(0, 5).map(h => {
            const t = { ticker: h.ticker, value: d0(h.currentValue), pct: totalAssets > 0 ? d1((h.currentValue / totalAssets) * 100) : 0 };
            // Options: OCC symbols are unreadable — carry the label too.
            if (h.option) t.desc = PortfolioApp.displayTicker(h.ticker);
            return t;
        });

        const timestamps = Object.values(PortfolioApp.priceCache || {})
            .map(c => c?.updatedAt).filter(Boolean);
        const pricesAsOf = timestamps.length
            ? new Date(Math.max(...timestamps)).toISOString()
            : null;

        const result = {
            totals: {
                cash: d0(totalCash),
                equities: d0(totalEquities),
                properties: d0(totalProperties),
                assets: d0(totalAssets),
                liabilities: d0(totalLiabilities),
                netWorth: d0(netWorth),
                dayChange: d0(dayChange),
                dayChangePct: d1(dayChangePct)
            },
            allocation: { byClass, topHoldings },
            pricesAsOf
        };

        if (full) {
            result.accounts = PortfolioApp.computeHoldingsByAccount().map(({ account, holdings, cash }) => ({
                // id is what save_decision/list_decisions key on.
                id: account.id,
                name: account.name,
                type: account.type,
                cash: d0(cash),
                holdings: holdings.map(h => {
                    // Skip zero fields to keep payload lean.
                    const out = { ticker: h.ticker, shares: h.totalShares };
                    // shares = contracts for options; value math already
                    // includes the 100× multiplier.
                    if (h.option) out.desc = PortfolioApp.displayTicker(h.ticker);
                    if (h.currentPrice) {
                        out.price = price(h.currentPrice);
                        out.value = d0(h.currentValue);
                        out.gain = d0(h.profitLoss);
                        out.gainPct = d1(h.profitLossPercent);
                    }
                    if (h.avgCostBasis) out.avgCost = price(h.avgCostBasis);
                    if (h.dayChangePercent) out.dayPct = d1(h.dayChangePercent);
                    return out;
                })
            }));
            result.properties = properties.map(p => ({ name: p.name, value: d0(p.currentValue || 0) }));
            if (liabilities.length) {
                result.liabilities = liabilities.map(l => {
                    const out = { name: l.name, type: l.type, balance: d0(l.balance || 0) };
                    if (l.lender) out.lender = l.lender;
                    if (l.interestRate != null) out.ratePct = l.interestRate;
                    if (l.monthlyPayment != null) out.monthlyPayment = d0(l.monthlyPayment);
                    if (l.originalAmount) out.originalAmount = d0(l.originalAmount);
                    const prop = l.propertyId ? properties.find(p => p.id === l.propertyId) : null;
                    if (prop) out.securedBy = prop.name;
                    return out;
                });
            }
        } else {
            result.accountCount = accounts.length;
            result.propertyCount = properties.length;
            if (liabilities.length) result.liabilityCount = liabilities.length;
        }

        // The saved strategy rides along with the numbers — a plan the
        // model has to make a second call to discover is a plan it will
        // often skip. Status only; check_strategy does the scoring.
        if (typeof PortfolioStrategy !== 'undefined') {
            const active = PortfolioStrategy.getDefault();
            if (active) {
                result.strategy = {
                    name: active.name,
                    status: active.status || 'active',
                    objective: active.objective || undefined,
                    hint: (active.status === 'draft')
                        ? 'Unfinished — start_strategy_interview resumes it.'
                        : 'Call check_strategy to score these holdings against it.'
                };
            }
        }

        // Notes the user linked to the portfolio or its accounts —
        // separate from the saved strategy above, and often the reading
        // and research behind it.
        const notes = linkedNotes(accounts);
        if (notes) result.linkedNotes = notes;

        return AgentTools._withDecisions(result,
            full ? result.accounts.map(a => ({ key: `account:${a.id}`, into: a })) : [], ctx);
    }, { dataClass: 'portfolio' });

    reg({
        name: 'get_ticker_detail',
        description: 'Deep dive on one ticker: shares by account, avg cost, current price, gain, day change. Use for single-stock questions instead of list_portfolio with full.',
        parameters: { type: 'object', properties: {
            ticker: { type: 'string' }
        }, required: ['ticker'] }
    }, (args, ctx) => {
        if (!args?.ticker) return { error: 'ticker required' };
        PortfolioApp.loadData();

        const ticker = String(args.ticker).toUpperCase();
        const rollup = PortfolioApp.computeHoldings().find(h => h.ticker.toUpperCase() === ticker);
        if (!rollup) return { error: `No holding found for ${ticker}.` };

        const byAccount = PortfolioApp.getAccounts()
            .map(a => {
                const h = PortfolioApp.computeHoldings(a.id).find(x => x.ticker.toUpperCase() === ticker);
                return h ? { name: a.name, shares: h.totalShares } : null;
            })
            .filter(Boolean);

        const cached = PortfolioApp.priceCache?.[rollup.ticker];
        const out = {
            ticker: rollup.ticker,
            shares: rollup.totalShares,
            avgCost: price(rollup.avgCostBasis),
            byAccount,
            asOf: cached?.updatedAt ? new Date(cached.updatedAt).toISOString() : null
        };
        if (rollup.option) {
            // shares = contracts; avgCost/price are per-share premium and
            // value/gain already include the 100× contract multiplier.
            out.desc = PortfolioApp.displayTicker(rollup.ticker);
            out.option = { ...rollup.option, contractMultiplier: 100 };
        }
        if (rollup.currentPrice) {
            out.price = price(rollup.currentPrice);
            out.value = d0(rollup.currentValue);
            out.gain = d0(rollup.profitLoss);
            out.gainPct = d1(rollup.profitLossPercent);
        }
        if (rollup.dayChangePercent) out.dayPct = d1(rollup.dayChangePercent);
        return AgentTools._withDecisions(out, [{ key: `ticker:${ticker}`, into: out }], ctx);
    }, { dataClass: 'portfolio' });

    reg({
        name: 'refresh_portfolio_prices',
        description: 'Refresh market prices for all held tickers. No confirmation needed.',
        parameters: { type: 'object', properties: {} }
    }, async () => {
        PortfolioApp.loadData();
        const tickers = PortfolioApp.getUniqueTickers();
        if (tickers.length === 0) return { refreshed: false, tickerCount: 0, message: 'No holdings to refresh.' };
        try {
            await PortfolioApp.refreshPrices();
            const timestamps = Object.values(PortfolioApp.priceCache || {})
                .map(c => c?.updatedAt).filter(Boolean);
            return {
                refreshed: true,
                tickerCount: tickers.length,
                pricesAsOf: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null
            };
        } catch (e) {
            return { error: e.message || 'Failed to refresh prices' };
        }
    }, { readOnly: true });

    reg({
        name: 'get_holdings_news',
        description: 'Recent, dated, sourced headlines about the user\'s OWN holdings — searched by company name per ticker, cached on this Mac (same engine as the News app). Call it for a market or portfolio review, "why is X up/down", "any news on my stocks", or any single-ticker question where recent events matter. Pass tickers for specific symbols (works for any symbol, held or not); omit for the top holdings by weight (funds skipped). Quote only returned headlines, with their age — never stories from memory — and say nothing about news if the list is empty. Prefer this over get_news (the user\'s general topics) and over web_search for anything about their positions.',
        parameters: { type: 'object', properties: {
            tickers: { type: 'array', items: { type: 'string' }, description: 'Symbols to look up, e.g. ["AAPL","NVDA"]. Omit for the portfolio\'s top holdings.' },
            accountName: { type: 'string', description: 'Only that account\'s holdings (when tickers is omitted).' },
            limit: { type: 'number', description: 'Max headlines (default 15, max 40).' }
        }}
    }, async (args = {}) => {
        if (typeof PortfolioNews === 'undefined') return { error: 'Portfolio news is not available' };
        let webOn = false;
        try { webOn = await PortfolioNews._webOn(); } catch { /* off */ }
        if (!webOn) return { error: 'Web access is off (Settings > AI Assistant > Web Search), so no headlines can be fetched.' };
        PortfolioApp.loadData();
        let accountId = null;
        if (args.accountName) {
            const acct = findAccount(args.accountName);
            if (!acct) return { error: `No account named "${args.accountName}". Accounts: ${PortfolioApp.getAccounts().map(a => a.name).join(', ')}` };
            accountId = acct.id;
        }
        const tickers = Array.isArray(args.tickers) ? args.tickers.map(t => String(t || '').trim()).filter(Boolean).slice(0, 12) : null;
        const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 40);
        const res = await PortfolioNews.headlines({ tickers, accountId, limit });
        if (!res.tickers.length) return { count: 0, note: tickers ? 'No usable symbols.' : 'No holdings to look up.' };
        const ago = (ts) => PortfolioNews._ago(ts);
        return {
            tickers: res.tickers,
            count: res.items.length,
            note: res.items.length ? `Every headline below is a real, dated article; quote its age. Newest first across tickers.${res.fetchError ? ' Some could not be refreshed just now (' + res.fetchError + ') so these may be a little old.' : ''}`
                : (res.fetchError ? `Headlines could not be fetched right now: ${res.fetchError} Nothing is cached. Say so; do not fill in from memory.`
                    : 'No recent headlines for these symbols in the last 7 days. Say so; do not fill in from memory.'),
            headlines: res.items.map(it => ({ ticker: it.ticker, title: it.title, source: it.source, published: ago(it.publishedAt), url: it.url }))
        };
    });

    // Linked brokerages (docs/PORTFOLIO.md "Brokerage linking"): one read
    // of what is linked and one pull. The pull WRITES transactions the
    // broker reports, so it asks like every other record write; linking
    // itself has no tool door — it needs the browser and the user's own
    // sign-in, so the assistant points at the Portfolio nav's "+ Link
    // brokerage" instead.
    // Registered only when the flag is on: an absent tool is the honest
    // shape for a feature the user cannot reach.
    if (typeof PortfolioBrokerage !== 'undefined' && PortfolioBrokerage.available()) reg({
        name: 'sync_brokerage',
        description: 'Pull the latest holdings, cash and transactions from the user\'s LINKED brokerage accounts (Fidelity, Robinhood, Schwab… connected through nenva cloud). Reports what is linked, how stale each is, what was added, and any positions that differ from the broker. Use dryRun=true to only report link status without pulling. Linking a new brokerage is not a tool action: tell the user to click "+ Link brokerage" in Portfolio\'s account list.',
        parameters: { type: 'object', properties: {
            accountName: { type: 'string', description: 'One linked account by name; default: every account linked on this Mac' },
            dryRun: { type: 'boolean', description: 'true = report link status only, pull nothing' }
        }}
    }, async (args = {}) => {
        if (typeof PortfolioBrokerage === 'undefined' || !PortfolioBrokerage.available()) {
            return { error: 'Brokerage linking is not available in this build.' };
        }
        PortfolioApp.loadData();
        const linked = PortfolioBrokerage.linkedAccounts();
        const status = linked.map(a => ({
            account: a.name, institution: a.brokerage.institution || null,
            lastSyncAt: a.brokerage.lastSyncAt || null,
            syncsFromThisMac: PortfolioBrokerage.isHere(a),
            needsSignIn: !!a.brokerage.needsLogin,
            positionsDiffering: (a.brokerage.drift || []).length
        }));
        if (!linked.length) return { linked: [], hint: 'No brokerage is linked. In Portfolio, click "+ Link brokerage" in the account list to connect one through nenva cloud.' };
        if (args.dryRun) return { linked: status };
        let ids = null;
        if (args.accountName) {
            const a = findAccount(args.accountName);
            if (!a || !a.brokerage) return { error: `No linked account named "${args.accountName}"`, linked: status };
            if (!PortfolioBrokerage.isHere(a)) return { error: `"${a.name}" syncs from the Mac that linked it, not this one.`, linked: status };
            ids = [a.id];
        }
        const r = await PortfolioBrokerage.sync(ids, { manual: false });
        if (r.busy) return { error: 'A brokerage sync is already running.', linked: status };
        const after = PortfolioBrokerage.linkedAccounts().map(a => ({
            account: a.name, institution: a.brokerage.institution || null, lastSyncAt: a.brokerage.lastSyncAt || null,
            needsSignIn: !!a.brokerage.needsLogin,
            positionsDiffering: (a.brokerage.drift || []).map(d => ({ ticker: d.ticker, portfolio: d.local, broker: d.broker }))
        }));
        return {
            synced: r.synced, transactionsAdded: r.added, positionsDiffering: r.drift,
            errors: r.errors, linked: after,
            hint: r.drift ? 'Differences are only reported; the user applies them from the account page\'s Review button.' : undefined
        };
    }, {
        ask: true, blockUntrusted: true, record: 'account',
        describe: (args) => args.dryRun
            ? 'Check the status of your linked brokerage accounts'
            : `Pull the latest transactions and balances from ${args.accountName ? `<strong>${esc(args.accountName)}</strong>` : 'your linked brokerage accounts'}`
    });

    reg({
        name: 'get_ticker_profile',
        description: 'Today\'s AI-written business profile of one symbol (a stock or a fund, held or not): what the company is, what it sells and how, who its customers are, how sound the business is (growth, margins, cash vs debt), where AI fits, whether the stock looks expensive / fair / cheap on its multiples, near- and long-term risks and value, the recent headlines, and a bottom line. Grounded in a Yahoo Finance fact sheet fetched the same day; written once per day and cached on this Mac, so a second call today is instant. Call it for "tell me about X", "what does X do", "is X expensive", "risks of X", or before judging a holding. Quote the profile\'s facts as of its date; never invent numbers beyond it. Writing a new profile can take a minute on a local model.',
        parameters: { type: 'object', properties: {
            ticker: { type: 'string', description: 'Symbol, e.g. NVDA. An option symbol profiles its underlying.' }
        }, required: ['ticker'] }
    }, async (args = {}, ctx) => {
        if (typeof PortfolioProfile === 'undefined') return { error: 'Stock profiles are not available' };
        const ticker = String(args.ticker || '').trim().toUpperCase();
        if (!ticker) return { error: 'ticker is required' };
        PortfolioApp.loadData();
        // A chat call is the user asking (consent); an ambient run keeps
        // the Portfolio data-class gate.
        const res = await PortfolioProfile.ensure(ticker, { manual: !(ctx && ctx.ambient) });
        const entry = res && res.text ? res : (res && res.entry && res.entry.text ? res.entry : null);
        if (!entry) return { error: (res && res.error) || 'The profile could not be written right now.' };
        const subject = PortfolioProfile._subject(ticker) || ticker;
        const out = {
            ticker: subject,
            name: entry.name || null,
            writtenOn: entry.day,
            writtenBy: entry.model ? (typeof AgentService !== 'undefined' && AgentService.displayForStoredModel ? AgentService.displayForStoredModel(entry.model) : entry.model) : null,
            stale: !PortfolioProfile.isToday(entry),
            correctionsApplied: entry.corrections || 0,
            // The profile's own one-word verdicts (valuation, soundness, AI
            // role, risks, value, news tone) — the tiles on the ticker page.
            verdicts: entry.verdicts || null,
            note: (res && res.error) ? `Today's profile could not be written (${res.error}); this is the one from ${entry.day}.` : `Written ${PortfolioProfile.isToday(entry) ? 'today' : 'on ' + entry.day}; every number in it came from that day's Yahoo Finance fact sheet. If the user corrects something in it, use correct_ticker_profile — the correction is kept and the profile rewritten around it.`,
            profile: entry.text
        };
        return AgentTools._withDecisions(out, [{ key: `ticker:${subject}`, into: out }], ctx);
    }, { readOnly: true });

    reg({
        name: 'get_portfolio_brief',
        description: 'Today\'s AI-written brief on the market and the user\'s whole portfolio, the one shown at the top of Portfolio › All Accounts: what kind of day the market had (S&P 500, Nasdaq, Dow, Russell, VIX, 10-year yield, gold, oil, bitcoin), what the portfolio did against it, the positions that moved, how the book sits against the plan, the dated headlines, what is worth watching, and a bottom line. Grounded in the app\'s own numbers plus same-day Yahoo quotes; written once per day and cached on this Mac, so a second call today is instant. Call it for "how did the market do", "what happened to my portfolio today", "give me the brief". Pass refresh:true only when the user asks for a fresh one (after the close, after a trade) — it rewrites today\'s brief from the latest numbers. Quote its facts as of its time; never invent numbers beyond it.',
        parameters: { type: 'object', properties: {
            refresh: { type: 'boolean', description: 'Rewrite today\'s brief from the latest numbers instead of returning the cached one.' }
        } }
    }, async (args = {}, ctx) => {
        if (typeof PortfolioBrief === 'undefined') return { error: 'The portfolio brief is not available' };
        PortfolioApp.loadData();
        // A chat call is the user asking (consent); an ambient run keeps
        // the Portfolio data-class gate. A refresh is never ambient.
        const manual = !(ctx && ctx.ambient);
        const res = await PortfolioBrief.ensure({ manual, force: !!args.refresh && manual });
        const entry = res && res.text ? res : (res && res.entry && res.entry.text ? res.entry : null);
        if (!entry) return { error: (res && res.error) || 'The brief could not be written right now.' };
        return {
            writtenOn: entry.day,
            writtenAt: entry.at ? new Date(entry.at).toISOString() : null,
            writtenBy: entry.model ? (typeof AgentService !== 'undefined' && AgentService.displayForStoredModel ? AgentService.displayForStoredModel(entry.model) : entry.model) : null,
            stale: !PortfolioBrief.isToday(entry),
            note: (res && res.error) ? `Today's brief could not be written (${res.error}); this is the one from ${entry.day}.` : `Written ${PortfolioBrief.isToday(entry) ? 'today' : 'on ' + entry.day}; every number in it came from the app's own figures and that day's quotes. Its suggestions rest on those facts; it never predicts, and neither should you when relaying it.`,
            brief: entry.text
        };
    }, { readOnly: true });

    reg({
        name: 'correct_ticker_profile',
        description: 'Correct or annotate a symbol\'s business profile from what the user said: a fact the profile got wrong, something it missed, or how the user wants it framed ("their largest customer is X, not Y", "count the cloud unit as the growth engine", "I hold this for income, judge it that way"). The user is asked to approve. The correction is SAVED as a standing note on the ticker (it survives the daily rewrite and is shown on every read), and today\'s profile is rewritten around it in the background — the ticker page updates as it writes; a later get_ticker_profile returns the rewritten one. Use it only for the user\'s own corrections, never to restate the profile. When a correction CHANGES, use the same title so the old one is superseded.',
        parameters: { type: 'object', properties: {
            ticker: { type: 'string', description: 'Symbol, e.g. NVDA' },
            title: { type: 'string', description: 'Short handle for the correction, e.g. "Largest customer" — reuse it to replace an earlier one' },
            correction: { type: 'string', description: 'The correction or note itself, in the user\'s terms, with the concrete details. Stored verbatim.' }
        }, required: ['ticker', 'title', 'correction'] }
    }, async (args = {}, ctx) => {
        if (typeof PortfolioProfile === 'undefined' || typeof DecisionStore === 'undefined') return { error: 'Stock profiles are not available' };
        const title = String(args.title || '').trim();
        const body = String(args.correction || '').trim();
        if (!title) return { error: 'title is required' };
        if (!body) return { error: 'correction is required' };
        const resolved = DecisionStore.resolveKey('ticker', { id: args.ticker });
        if (resolved.error) return { error: resolved.error };
        let saved;
        try {
            saved = DecisionStore.saveSmart({
                key: resolved.key, title, body,
                convId: (typeof AgentService !== 'undefined' && AgentService.activeConversationId) || undefined,
                source: 'chat'
            });
        } catch (e) { return { error: e.message }; }
        const subject = resolved.key.slice('ticker:'.length);
        // Rewrite today's profile around every note on the symbol, in the
        // background: the page streams it, and get_ticker_profile waits
        // on the same in-flight run.
        const rewrite = PortfolioProfile.ensure(subject, { manual: !(ctx && ctx.ambient), force: true });
        rewrite.catch(() => {});
        const out = {
            success: true,
            ticker: subject,
            decisionId: saved.decision.id,
            title: saved.decision.title,
            corrections: DecisionStore.listFor(resolved.key).length,
            rewriting: true,
            note: `Saved. The ${subject} profile is being rewritten around ${DecisionStore.listFor(resolved.key).length === 1 ? 'this note' : 'all its notes'} now (a minute on a local model); the ticker page shows it as it writes. Call get_ticker_profile for the rewritten text if you need it.`
        };
        if (saved.deduped) out.deduped = true;
        if (saved.superseded) out.superseded = saved.superseded.title;
        return out;
    }, {
        ask: true, blockUntrusted: true,
        describe: (args) => `Correct the <strong>${esc(String(args.ticker || '?').toUpperCase())}</strong> profile — ${esc(args.title || '')}: <em>${esc(String(args.correction || '').slice(0, 160))}${String(args.correction || '').length > 160 ? '…' : ''}</em>, then rewrite today’s profile around it`
    });

    reg({
        name: 'add_transaction',
        description: 'Add a stock or option buy/sell to a portfolio account. Type "holding" records shares the user already owns (pricePerShare = their average cost) without affecting cash — use it for initial/existing positions. For a call/put option, ticker is the OCC symbol (underlying + YYMMDD + C/P + strike*1000 in 8 digits, e.g. AAPL261218C00250000), quantity is contracts, and pricePerShare is the per-share premium.',
        parameters: { type: 'object', properties: {
            accountName: { type: 'string' },
            type: { type: 'string', enum: ['buy', 'sell', 'holding'] },
            ticker: { type: 'string', description: 'Stock symbol, or OCC option symbol for calls/puts' },
            quantity: { type: 'number' },
            pricePerShare: { type: 'number' },
            date: { type: 'string', description: 'YYYY-MM-DD. Default: today.' },
            notes: { type: 'string' }
        }, required: ['accountName', 'type', 'ticker', 'quantity', 'pricePerShare'] }
    }, (args) => {
        const data = StorageManager.get('portfolio') || {};
        const accounts = data.accounts || [];
        const transactions = data.transactions || [];
        const now = new Date();

        // Find account by name (case-insensitive); create it if missing.
        let account = accounts.find(a => a.name.toLowerCase() === args.accountName.toLowerCase());
        if (!account) {
            account = {
                id: crypto.randomUUID(),
                name: args.accountName,
                type: 'brokerage',
                // null = not tracking cash, same as UI-created accounts
                // (createAccount) — otherwise the first buy would drive a
                // brand-new account's cash negative.
                cashBalance: null,
                createdAt: now.toISOString()
            };
            accounts.push(account);
        }

        const newTxn = {
            id: crypto.randomUUID(),
            accountId: account.id,
            type: args.type,
            ticker: args.ticker.toUpperCase(),
            quantity: args.quantity,
            pricePerShare: args.pricePerShare,
            date: args.date || UIUtils.todayISO(now),
            notes: args.notes || '',
            createdAt: now.toISOString(),
            updatedAt: now.toISOString()
        };
        transactions.push(newTxn);

        // Mirror the UI's cash effect (PortfolioApp.adjustCash): a buy
        // subtracts, a sell adds, 'holding' never touches cash, and an
        // account that isn't tracking cash (cashBalance == null) is left
        // alone. Options move premium × 100 per contract.
        if (newTxn.type !== 'holding' && account.cashBalance != null) {
            const amount = newTxn.quantity * newTxn.pricePerShare * PortfolioApp.tickerMultiplier(newTxn.ticker);
            account.cashBalance += newTxn.type === 'buy' ? -amount : amount;
            // Stamp for record-level sync: cash rides the account record.
            account.updatedAt = now.toISOString();
        }

        StorageManager.set('portfolio', { ...data, accounts, transactions });
        refresh();

        const out = {
            success: true,
            transaction: { id: newTxn.id, ticker: newTxn.ticker, type: newTxn.type, quantity: newTxn.quantity, pricePerShare: newTxn.pricePerShare },
            account: { id: account.id, name: account.name, cashBalance: account.cashBalance }
        };

        // If the trade puts the portfolio off plan, say so HERE — the
        // conflict belongs in the conversation that made the trade, not
        // in a drift table the user reads next month. Advisory only: the
        // transaction is already saved and stays saved.
        try {
            const conflict = PortfolioStrategy.checkTransaction({
                accountId: account.id, ticker: newTxn.ticker, type: newTxn.type
            });
            if (conflict) {
                out.strategyConflict = {
                    strategy: conflict.strategyName,
                    notes: conflict.notes,
                    hint: 'Tell the user this plainly after confirming the trade. Do not undo it or lecture — state the conflict, and ask whether they want to look at it.'
                };
            }
        } catch (e) { /* an advisory never breaks the write */ }

        return out;
    }, {
        ask: true, blockUntrusted: true,
        describe: (args) => `Record a ${esc(args.type || 'transaction')} of <strong>${esc(args.quantity ?? '?')} × ${esc(args.ticker || '?')}</strong>` +
            (args.pricePerShare != null ? ` at ${esc(args.pricePerShare)}` : '') +
            (args.accountName ? ` in ${esc(args.accountName)}` : '') + '.'
    });

    reg({
        name: 'update_cash',
        description: 'Deposit, withdraw, or set cash for a portfolio account.',
        parameters: { type: 'object', properties: {
            accountName: { type: 'string' },
            amount: { type: 'number' },
            operation: { type: 'string', enum: ['deposit', 'withdraw', 'set'] }
        }, required: ['accountName', 'amount', 'operation'] }
    }, (args) => {
        const data = StorageManager.get('portfolio') || {};
        const accounts = data.accounts || [];

        const account = accounts.find(a => a.name.toLowerCase() === args.accountName.toLowerCase());
        if (!account) return { error: `Account "${args.accountName}" not found` };

        const prev = account.cashBalance || 0;
        if (args.operation === 'deposit') {
            account.cashBalance = prev + args.amount;
        } else if (args.operation === 'withdraw') {
            account.cashBalance = prev - args.amount;
        } else if (args.operation === 'set') {
            account.cashBalance = args.amount;
        }
        account.updatedAt = new Date().toISOString();

        StorageManager.set('portfolio', { ...data, accounts });
        refresh();

        return { success: true, account: { name: account.name, cashBalance: account.cashBalance, previousBalance: prev } };
    }, {
        ask: true, blockUntrusted: true,
        describe: (args) => `${esc(args.operation === 'set' ? 'Set' : args.operation === 'withdraw' ? 'Withdraw' : 'Deposit')} ` +
            `<strong>${esc(args.amount ?? '?')}</strong>${args.operation === 'set' ? ' as the cash balance' : ''}` +
            (args.accountName ? ` in ${esc(args.accountName)}` : '') + '.'
    });

    reg({
        name: 'save_liability',
        description: 'Record or update a debt the user told you about: a mortgage, a car or student loan, a credit card balance, a credit line. Matches an existing debt by name and updates only the fields you pass; otherwise adds it. It subtracts from net worth and shows in money_overview with its rate. Only figures the user gave.',
        parameters: { type: 'object', properties: {
            name: { type: 'string', description: 'e.g. "Home mortgage", "Honda loan"' },
            type: { type: 'string', enum: Object.keys(PortfolioApp.LIABILITY_TYPES) },
            balance: { type: 'number', description: 'What is owed now' },
            interestRate: { type: 'number', description: 'Annual rate in percent, e.g. 6.25' },
            monthlyPayment: { type: 'number' },
            lender: { type: 'string' },
            originalAmount: { type: 'number' }
        }, required: ['name'] }
    }, (args = {}) => {
        PortfolioApp.loadData();
        const name = String(args.name || '').replace(/\s+/g, ' ').trim();
        if (!name) return { error: 'A debt needs a name.' };
        const num = (v) => (v == null || !Number.isFinite(Number(v)) || Number(v) < 0 ? undefined : Number(v));
        const fields = { balance: num(args.balance), interestRate: num(args.interestRate), monthlyPayment: num(args.monthlyPayment), originalAmount: num(args.originalAmount),
            lender: args.lender ? String(args.lender).trim() : undefined, type: PortfolioApp.LIABILITY_TYPES[args.type] ? args.type : undefined };
        for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];
        const now = new Date().toISOString();
        let l = PortfolioApp.liabilities.find(x => String(x.name || '').toLowerCase() === name.toLowerCase());
        const created = !l;
        if (created) {
            if (fields.balance == null) return { error: 'A new debt needs its balance.' };
            l = { id: crypto.randomUUID(), name, type: 'other', lender: '', originalAmount: null, interestRate: null, monthlyPayment: null, startDate: null, propertyId: null, notes: '', createdAt: now };
            PortfolioApp.liabilities.push(l);
        }
        Object.assign(l, fields, { updatedAt: now });
        PortfolioApp.saveData();
        refresh();
        return { success: true, created, liability: { id: l.id, name: l.name, type: l.type, balance: l.balance, ratePct: l.interestRate, monthlyPayment: l.monthlyPayment } };
    }, {
        ask: true, blockUntrusted: true,
        describe: (args) => `Record the debt <strong>${esc(args.name || '?')}</strong>` + (args.balance != null ? `: ${esc(args.balance)} owed` : '') +
            (args.interestRate != null ? ` at ${esc(args.interestRate)}%` : '') + (args.monthlyPayment != null ? `, ${esc(args.monthlyPayment)} a month` : '')
    });

    // ── STRATEGY ──
    // The engine (PortfolioStrategy) owns the arithmetic and the agenda;
    // these handlers only marshal it in and out of the model. Nothing
    // here scores adherence or decides what to ask — that would put a
    // judgment call in the model's hands that the app can make exactly.

    reg({
        name: 'get_strategy',
        description: 'Read the user\'s saved investment strategies. Omit name for all of them in brief; pass name for one in full (purpose, horizon, risk, approach, target mix, guardrails).',
        parameters: { type: 'object', properties: {
            name: { type: 'string', description: 'Strategy name (fuzzy match)' }
        }}
    }, (args = {}, ctx) => {
        const summarize = (s) => ({
            // The id is what save_decision/list_decisions key on — without
            // it here the model had no id to save a decision against.
            id: s.id,
            name: s.name,
            status: s.status || 'active',
            isOverall: !!s.isDefault,
            objective: s.objective || null,
            accounts: PortfolioStrategy.accountsUsing(s.id).map(a => a.name),
            updatedAt: s.updatedAt
        });

        if (!args.name) {
            const all = PortfolioStrategy.all();
            if (!all.length) {
                return {
                    strategies: [],
                    hint: 'No strategy saved yet. If the user wants one, call start_strategy_interview.'
                };
            }
            return { strategies: all.map(summarize) };
        }

        const strategy = PortfolioStrategy.find(args.name);
        if (!strategy) {
            return { error: `No strategy matching "${args.name}".`, available: PortfolioStrategy.all().map(s => s.name) };
        }
        const result = {
            ...summarize(strategy),
            horizon: strategy.horizon || null,
            riskLevel: strategy.riskLevel || null,
            thesis: strategy.thesis || null,
            coverage: strategy.coverage || null,
            reviewCadence: strategy.reviewCadence || null,
            targets: (strategy.targets || []).map(t => ({
                label: t.label, tickers: t.tickers, includeCash: t.includeCash || undefined,
                targetPct: t.targetPct, minPct: t.minPct, maxPct: t.maxPct
            })),
            rules: (strategy.rules || []).map(r => ({
                kind: r.kind, value: r.value, tickers: r.tickers, text: r.text || undefined
            })),
            missing: PortfolioStrategy.missingTopics(strategy),
            recentChanges: (strategy.history || []).slice(0, 5)
        };
        return AgentTools._withDecisions(result,
            [{ key: `strategy:${strategy.id}`, into: result }], ctx);
    }, { dataClass: 'portfolio' });

    reg({
        name: 'check_strategy',
        description: 'Score the user\'s REAL holdings against a strategy: which sleeves drifted out of band, which guardrails are broken, what is not covered by the plan, and what it would take to get back. The app computes this — use these numbers, never your own. Call it for "am I following my plan", before advising on a trade, and right after saving a strategy.',
        parameters: { type: 'object', properties: {
            name: { type: 'string', description: 'Strategy name; default: the overall one' },
            accountName: { type: 'string', description: 'Score just this account against the strategy it follows' }
        }}
    }, (args = {}, ctx) => {
        const strategy = args.name
            ? PortfolioStrategy.find(args.name)
            : PortfolioStrategy.getDefault();
        if (!strategy) {
            return {
                error: args.name ? `No strategy matching "${args.name}".` : 'No strategy saved yet.',
                hint: 'If the user wants one, call start_strategy_interview.'
            };
        }

        let accountId = null;
        if (args.accountName) {
            const account = findAccount(args.accountName);
            if (!account) return { error: `Account "${args.accountName}" not found.` };
            accountId = account.id;
        }

        if (PortfolioStrategy.missingTopics(strategy).length) {
            return {
                strategy: strategy.name,
                status: 'draft',
                missing: PortfolioStrategy.missingTopics(strategy),
                note: 'This strategy is unfinished, so there is nothing firm to measure against. Offer to finish it with start_strategy_interview.'
            };
        }

        const report = PortfolioStrategy.evaluate(strategy, { accountId });
        if (!report || report.empty) {
            return { strategy: strategy.name, status: 'no-data', note: 'Nothing held in scope yet.' };
        }

        // Rounded on the way out: two decimals of drift is noise the model
        // would otherwise repeat back verbatim.
        const r2 = (n) => Math.round(n * 10) / 10;
        const result = {
            strategy: strategy.name,
            strategyId: strategy.id,
            scope: args.accountName || 'whole portfolio',
            status: report.status,
            headline: report.headline,
            targets: report.targets.map(t => ({
                sleeve: t.label,
                targetPct: t.targetPct,
                band: `${t.minPct}-${t.maxPct}`,
                actualPct: r2(t.actualPct),
                status: t.status,
                adjustment: Math.abs(t.deltaValue) < 1 ? 'none'
                    : `${t.deltaValue > 0 ? 'add' : 'trim'} $${Math.round(Math.abs(t.deltaValue)).toLocaleString('en-US')}`
            })),
            guardrails: report.rules.map(r => ({
                rule: r.label, status: r.status, detail: r.detail,
                ...(r.status === 'judgment' ? { note: 'Stated in words — you judge this one against the holdings.' } : {})
            })),
            notCoveredByPlan: report.unclassified
                ? { pct: r2(report.unclassified.pct), tickers: report.unclassified.tickers, includesCash: report.unclassified.includesCash }
                : null,
            unpricedHoldings: report.unpriced.length ? report.unpriced : undefined
        };
        // The user's standing instructions for this plan belong beside
        // its adherence numbers — "am I on plan" includes the plans made
        // ABOUT the plan (a DCA schedule, a rebalance rule of thumb).
        return AgentTools._withDecisions(result,
            [{ key: `strategy:${strategy.id}`, into: result }], ctx);
    // Scoring holdings against a strategy is pure arithmetic — safe in a
    // parallel read batch despite the name.
    }, { readOnly: true, dataClass: 'portfolio' });

    reg({
        name: 'start_strategy_interview',
        description: 'Begin or resume the guided intake that turns a conversation into a saved investment strategy. Returns the agenda, the next question to ask, and the user\'s current holdings for context. Call this FIRST whenever the user wants to create, build, or set up a strategy — the agenda is fixed, do not improvise your own questions.',
        parameters: { type: 'object', properties: {
            name: { type: 'string', description: 'Existing/draft strategy to continue; omit to start a new one' }
        }}
    }, (args = {}) => {
        const existing = args.name ? PortfolioStrategy.find(args.name) : null;
        const strategy = existing
            || PortfolioStrategy.all().find(s => (s.status || 'active') === 'draft')
            || null;

        const missing = PortfolioStrategy.missingTopics(strategy);
        const next = missing.length ? PortfolioStrategy.topic(missing[0]) : null;

        // Current holdings ride along so the allocation topic can be a
        // PROPOSAL grounded in what the user actually owns, rather than a
        // blank "what percentages do you want?" the user cannot answer.
        const holdings = (PortfolioApp.computeHoldings() || []).slice(0, 15);
        const total = holdings.reduce((s, h) => s + (h.currentValue || 0), 0)
            + (PortfolioApp.computeTotalCash() || 0);
        const context = {
            accounts: (PortfolioApp.getAccounts() || []).map(a => a.name),
            currentHoldings: total > 0 ? holdings.map(h => ({
                ticker: PortfolioApp.displayTicker(h.ticker),
                pctOfPortfolio: Math.round((h.currentValue / total) * 1000) / 10
            })) : [],
            cashPct: total > 0 ? Math.round((PortfolioApp.computeTotalCash() / total) * 1000) / 10 : null
        };

        return {
            instructions:
                'Run this as an interview, not a form. Ask ONE topic at a time, in the order given, ' +
                'and wait for the answer before moving on. For each: ask the question in your own words, ' +
                'say in a sentence why it matters (use `why`), and offer the examples as a starting point ' +
                'so the user has something to react to. After each answer, call save_strategy with just ' +
                'that field, then ask the next question. save_strategy needs a name from the very first ' +
                'call, so give it a short working title drawn from their first answer (e.g. "Retirement") ' +
                'and settle the real name at the end, on the coverage topic. ' +
                'Do not ask every topic at once, do not add topics ' +
                'of your own, and never save a number the user did not agree to. For the allocation topic, ' +
                'PROPOSE a mix based on their earlier answers and what they already hold (in `context`), ' +
                'then let them correct it. When nothing is left, call check_strategy and show them how ' +
                'their real holdings line up with what they just described.',
            strategy: strategy ? { name: strategy.name, status: strategy.status } : null,
            covered: strategy
                ? PortfolioStrategy.INTERVIEW.filter(t => !missing.includes(t.id)).map(t => t.id)
                : [],
            remaining: missing,
            nextTopic: next,
            agenda: PortfolioStrategy.INTERVIEW.map(t => ({
                id: t.id, question: t.question, why: t.why,
                examples: t.examples, hint: t.hint
            })),
            context
        };
    // Only reads the agenda + current draft.
    }, { readOnly: true });

    reg({
        name: 'save_strategy',
        description: 'Create or update an investment strategy. Merges — pass only the fields just agreed and call again as the interview proceeds, so an interrupted conversation still leaves a usable draft. Everything saved must be something the user actually said or explicitly approved. Returns what is still missing.',
        parameters: { type: 'object', properties: {
            name: { type: 'string', description: 'Strategy name — the key for create-or-update' },
            objective: { type: 'string', description: 'What the money is for, in the user\'s words' },
            horizon: { type: 'string', description: 'When they expect to need it, e.g. "20+ years"' },
            riskLevel: { type: 'string', description: 'The drop they said they could hold through, e.g. "about 30%"' },
            thesis: { type: 'string', description: 'How they want it invested and why' },
            coverage: { type: 'string', description: 'Which accounts this plan covers, e.g. "everything" or "the IRA and 401(k)"' },
            reviewCadence: { type: 'string', description: 'e.g. "quarterly"' },
            targets: { type: 'array', description: 'The target mix. Confirm the percentages with the user before saving.', items: { type: 'object', properties: {
                label: { type: 'string', description: 'Sleeve name, e.g. "US index core"' },
                tickers: { type: 'array', items: { type: 'string' }, description: 'Tickers in this sleeve (options match their underlying)' },
                includeCash: { type: 'boolean', description: 'True for the cash sleeve' },
                targetPct: { type: 'number' },
                minPct: { type: 'number', description: 'Band floor; defaults to target-5' },
                maxPct: { type: 'number', description: 'Band ceiling; defaults to target+5' }
            }}},
            rules: { type: 'array', description: 'Guardrails. kind max_position/min_cash/max_cash take value (a percent); avoid/only take tickers; custom takes text and is left for you to judge.', items: { type: 'object', properties: {
                kind: { type: 'string', enum: ['max_position', 'min_cash', 'max_cash', 'avoid', 'only', 'custom'] },
                value: { type: 'number' },
                tickers: { type: 'array', items: { type: 'string' } },
                exclude: { type: 'array', items: { type: 'string' }, description: 'max_position only: tickers the cap does not apply to. A position cap almost always means single stocks, so put broad index/bond funds here.' },
                text: { type: 'string', description: 'The rule in the user\'s words' }
            }}},
            isDefault: { type: 'boolean', description: 'Make this the overall strategy accounts fall back to' },
            changeNote: { type: 'string', description: 'One line for the change log, e.g. "Raised cash floor to 10% after job change"' }
        }, required: ['name'] }
    }, (args = {}) => {
        if (!args.name || !String(args.name).trim()) {
            return { error: 'A strategy needs a name.' };
        }
        const saved = PortfolioStrategy.save(args);
        refresh();

        const missing = PortfolioStrategy.missingTopics(saved);
        const next = missing.length ? PortfolioStrategy.topic(missing[0]) : null;
        return {
            success: true,
            strategy: saved.name,
            status: saved.status,
            isOverall: !!saved.isDefault,
            missing,
            nextTopic: next,
            hint: next
                ? 'Ask the next question. Do not summarize the whole plan yet.'
                : 'The strategy is complete. Call check_strategy now and show the user how their actual holdings line up with it.'
        };
    });

    reg({
        name: 'delete_strategy',
        description: 'Delete a saved investment strategy. Accounts following it fall back to the overall plan, and if it WAS the overall plan another one is promoted. This cannot be undone — confirm the exact name with the user first, and never delete one to "replace" it when save_strategy would update it in place.',
        parameters: { type: 'object', properties: {
            name: { type: 'string', description: 'Strategy name (fuzzy match) — confirm with the user before calling' }
        }, required: ['name'] }
    }, (args = {}) => {
        const strategy = PortfolioStrategy.find(args.name);
        if (!strategy) {
            return { error: `No strategy matching "${args.name}".`, available: PortfolioStrategy.all().map(s => s.name) };
        }
        // Read the consequences BEFORE removing: accounts pointed at this
        // plan are reset to follow the overall one, and if this WAS the
        // overall one another strategy is promoted. The user deserves to
        // be told both in the same breath as the deletion.
        const reassigned = PortfolioStrategy.accountsUsing(strategy.id)
            .filter(a => a.strategyId === strategy.id)
            .map(a => a.name);
        const wasOverall = !!strategy.isDefault;

        if (!PortfolioStrategy.remove(strategy.id)) return { error: 'Could not delete that strategy.' };
        refresh();

        const overall = PortfolioStrategy.getDefault();
        return {
            success: true,
            deleted: strategy.name,
            reassignedToOverall: reassigned,
            newOverall: wasOverall ? (overall ? overall.name : null) : undefined,
            remaining: PortfolioStrategy.all().map(s => s.name)
        };
    }, {
        ask: true,
        describe: (args) => {
            const s = PortfolioStrategy.find(args.name);
            const followers = s ? PortfolioStrategy.accountsUsing(s.id).filter(a => a.strategyId === s.id).map(a => a.name) : [];
            return `Delete the strategy <strong>${esc(s ? s.name : args.name || 'Unknown')}</strong>` +
                (followers.length ? ` — ${esc(followers.join(', '))} will follow the overall plan instead` : '') +
                `. This cannot be undone.`;
        }
    });

    reg({
        name: 'assign_strategy',
        description: 'Set which strategy an account follows.',
        parameters: { type: 'object', properties: {
            accountName: { type: 'string' },
            strategyName: { type: 'string', description: 'Strategy to follow, or "overall" to fall back to the default one' }
        }, required: ['accountName', 'strategyName'] }
    }, (args = {}) => {
        const account = findAccount(args.accountName);
        if (!account) {
            return { error: `Account "${args.accountName}" not found.`, available: (PortfolioApp.getAccounts() || []).map(a => a.name) };
        }

        const wantsOverall = /^(overall|default|none|inherit)$/i.test(String(args.strategyName || '').trim());
        let strategy = null;
        if (!wantsOverall) {
            strategy = PortfolioStrategy.find(args.strategyName);
            if (!strategy) {
                return { error: `No strategy matching "${args.strategyName}".`, available: PortfolioStrategy.all().map(s => s.name) };
            }
        }

        PortfolioStrategy.assignAccount(account.id, strategy ? strategy.id : null);
        refresh();

        const applied = PortfolioStrategy.forAccount(account.id);
        return {
            success: true,
            account: account.name,
            follows: applied.strategy ? applied.strategy.name : null,
            inherited: applied.inherited
        };
    });
})();
