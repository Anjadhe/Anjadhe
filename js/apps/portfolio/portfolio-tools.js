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

    // ── The words that summon the group ────────────────────────────────
    // Portfolio has no single market noun, so account/transaction/broker
    // words AND the user's own account names all gate the group (2026-07-31
    // miss: the agent had no portfolio tools and tried to log a trade in
    // notes). Account names are punctuation-insensitive ("padma - robinhood"
    // matches "Padma-Robinhood"); names under 4 chars are skipped as noise.
    const VOCAB = /\b(portfolios?|stocks?|tickers?|shares?|holdings?|invest\w*|net\s?worth|dividends?|strateg\w+|allocations?|rebalanc\w+|diversif\w+|asset\s?mix|risk\s?tolerance|accounts?|transactions?|trades?|brokerages?|401k|403b|ira|hsa|robinhood|fidelity|e-?trade|schwab|vanguard)\b/;
    function mentionsAccountName(s) {
        try {
            const accounts = StorageManager.get('portfolio')?.accounts || [];
            const flat = s.replace(/[^a-z0-9]/g, '');
            return accounts.some(a => {
                const n = (a.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                return n.length >= 4 && flat.includes(n);
            });
        } catch { return false; }
    }
    AgentTools.registerDomain(SOURCE, (s, text) =>
        VOCAB.test(s)
        || /\b(buy|sell)\b.*\b(shares?|stocks?)\b/.test(s)
        || /\b(on|off)[-\s]plan\b/.test(s)
        || /\b(following|follow|stick\w*\s+to|sticking\s+to)\s+(my|the)\s+plan\b/.test(s)
        || /\b(investment|financial|portfolio)\s+plans?\b/.test(s)
        || /\$[A-Z]{1,5}\b/.test(text)
        || mentionsAccountName(s));

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
        // A ticker page is something a chat can be about, never a decision host.
        RecordTypes.register('ticker', {
            label: 'Ticker', plural: 'tickers', words: [], app: SOURCE, decisions: false,
            recordKey: (id) => `portfolio:ticker:${id}`, match: /^portfolio:ticker:(.+)$/,
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

    // ── Starter routine + quick-start pill ──────────────────────────────
    // Portfolio review (one since 2026-08-04; three from 2026-07-30): the
    // pre-market / midday / close trio was three feed posts a day saying
    // mostly the same thing, so it collapsed into one review after the
    // close — the only edition with a full day to report. Runs through the
    // assistant (useContext) so the read-only portfolio tools ground every
    // number; weekdays only — markets are closed on weekends and a review
    // of nothing is noise. Skipped entirely when there is no portfolio
    // data (the prompt body says to stay silent). `marketTime` is an
    // America/New_York wall-clock anchor that StarterPrompts.seed converts
    // to THIS Mac's local time — a literal '16:30' is only right in one
    // timezone (3.5 hours late in California).
    if (typeof StarterPrompts !== 'undefined') {
        StarterPrompts.register({
            id: 'starter-market-review',
            title: 'Market Review',
            config: { offline: true, interval: 'weekdays', web: false, useContext: true },
            marketTime: '16:30',
            body: 'Write my daily market review, just after the market close. Call list_portfolio; if I hold nothing, reply with one quiet line saying there is nothing to review and stop. Otherwise call refresh_portfolio_prices and summarize the day: total change, my best and worst positions, and my cash position. Then call check_strategy and state plainly whether I am on plan, using only its computed numbers — name any drift or breach without lecturing. Then call get_holdings_news and mention only the returned headlines, with how old each is — never stories from memory; skip this entirely if it returns none. End with anything genuinely worth discussing, or nothing if the day was unremarkable.'
        });
        // The three reviews it replaced: removed from an install only while
        // untouched — an edited or rescheduled copy is the user's routine.
        StarterPrompts.retire({
            id: 'starter-portfolio-premarket', title: 'Pre-Market Review', interval: 'weekdays', time: '07:30',
            body: 'Write my pre-market portfolio review. First call list_portfolio; if I hold nothing, reply with one quiet line saying there is nothing to review and stop. Otherwise call refresh_portfolio_prices, then get_news and pull out only the headlines that touch my holdings or their industries — use only headlines the tool returned, never stories from memory. Note any pre-market moves on my positions. Keep it to a few short bullets and end with two or three specific things worth watching today.'
        });
        StarterPrompts.retire({
            id: 'starter-portfolio-midday', title: 'Midday Market Check', interval: 'weekdays', time: '12:30',
            body: 'Do a midday check on my portfolio. Call list_portfolio, then refresh_portfolio_prices. Report only the positions moving 2% or more today and what they are doing to my total. If nothing is moving that much, say the portfolio is quiet in one line and stop — do not pad it.'
        });
        StarterPrompts.retire({
            id: 'starter-portfolio-close', title: 'Market Close Review', interval: 'weekdays', time: '16:30',
            body: 'Write my market-close review. Call list_portfolio and refresh_portfolio_prices, then summarize the day: total change, my best and worst positions, and my cash position. Then call check_strategy and state plainly whether I am on plan, using only its computed numbers — name any drift or breach without lecturing. End with anything genuinely worth discussing, or nothing if the day was unremarkable. If I hold nothing, reply with one quiet line and stop.'
        });
    }
    if (typeof AgentUI !== 'undefined' && AgentUI.registerSuggestion) {
        AgentUI.registerSuggestion({ text: 'How is my portfolio doing?',
            when: () => ((StorageManager.get('portfolio')?.accounts) || []).length > 0 });
    }

    // ── Undo bookkeeping: the arrays a whole-blob restore cannot shrink ──
    if (typeof WriteLedger !== 'undefined') {
        WriteLedger.registerMergedArrays('portfolio', ['accounts', 'transactions', 'properties', 'strategies', 'watchlist']);
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
    }, (args) => {
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
        return out;
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
            note: res.items.length ? 'Every headline below is a real, dated article; quote its age. Newest first across tickers.'
                : 'No recent headlines for these symbols in the last 7 days. Say so; do not fill in from memory.',
            headlines: res.items.map(it => ({ ticker: it.ticker, title: it.title, source: it.source, published: ago(it.publishedAt), url: it.url }))
        };
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
            createdAt: now.toISOString()
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
