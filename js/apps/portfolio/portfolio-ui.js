/**
 * Portfolio UI
 * Renders holdings table, account sidebar, transaction list, dashboard preview
 */

const PortfolioUI = {

    /**
     * The places (calm pass, 2026-10-06): where the money is, as the
     * Settings page's rows — a tile, a name, a quiet value, a chevron —
     * in groups that render only when they hold something. They replaced
     * the left nav (renderNav, deleted the same day): All Accounts lists them; every other scope names itself in
     * the breadcrumb, whose "Finance" comes back here. Adding things is
     * the header's ⋯ menu, never a row of its own.
     */
    renderPlaces(scope) {
        const el = document.getElementById('portfolio-places');
        if (!el) return;
        if (scope !== 'all') { el.innerHTML = ''; return; }
        const esc = AppManager.escapeHtml;
        const money = (v) => this.hv(this.formatMoney(v).replace(/\.\d\d$/, ''));
        const row = (attrs, icon, name, sub, value) => `
            <button type="button" class="pf-row" ${attrs}>
                <span class="pf-tile" aria-hidden="true">${this.ACCOUNT_TYPE_ICON(icon)}</span>
                <span class="pf-row-copy">
                    <span class="pf-row-label">${esc(name)}</span>
                    ${sub ? `<span class="pf-row-sub">${sub}</span>` : ''}
                </span>
                ${value ? `<span class="pf-row-value">${value}</span>` : ''}
                ${this.CHEV}
            </button>`;
        const group = (title, rows) => rows.length
            ? `${title ? `<div class="pf-eyebrow">${esc(title)}</div>` : ''}<div class="pf-group">${rows.join('')}</div>` : '';

        const accounts = PortfolioApp.getAccounts().map(a => {
            const summary = PortfolioApp.getSummary(PortfolioApp.computeHoldings(a.id), a.id);
            return row(`data-scope="${esc(a.id)}"`, a.type || 'other', a.name,
                `${esc(this.formatAccountType(a.type))}${a.brokerage ? ' · linked' : ''}`, money(summary.totalValue));
        });
        // The plan is a page of its own (Overview · Strategy under the
        // tabs), not a row here.

        const property = [
            ...PortfolioApp.getProperties().map(p => row(`data-record="property" data-id="${esc(p.id)}"`, 'property', p.name,
                esc(p.address || ''), money(p.currentValue || 0))),
            ...PortfolioApp.getLiabilities().map(l => row(`data-record="liability" data-id="${esc(l.id)}"`, 'liability', l.name,
                esc([PortfolioApp.liabilityTypeLabel(l.type), l.lender].filter(Boolean).join(' · ')), '−' + money(l.balance || 0)))
        ];

        // Spending is a tab over this page (renderFinanceTabs), not rows.
        el.innerHTML = group('Accounts', accounts) + group('Property and debt', property);

        el.querySelectorAll('[data-scope]').forEach(btn =>
            btn.addEventListener('click', () => PortfolioApp.setScope(btn.dataset.scope)));
        el.querySelectorAll('[data-record]').forEach(btn =>
            btn.addEventListener('click', () => {
                if (btn.dataset.record === 'property') PortfolioApp.openPropertyDetail(btn.dataset.id);
                else PortfolioApp.openLiabilityDetail(btn.dataset.id);
            }));
        this._bindStrategyRow(el);
    },

    /**
     * Finance's two halves as tabs (2026-10-06, by request: "a tabbed user
     * interface … to show Investments and Spending"). Drawn at the top of
     * each half's home — All Accounts and Spending's pages — and nowhere
     * deeper (an account, a ticker, Strategy are drill-ins with their own
     * breadcrumb). Spending's tab exists only when Spending can be used: a
     * bank can be linked, or one already is; otherwise there is one half and
     * no tabs.
     */
    spendingUsable() {
        return typeof SpendingApp !== 'undefined' && typeof SpendingSync !== 'undefined'
            && (SpendingSync.available() || SpendingApp.accounts().length > 0);
    },

    financeTabsHtml(active) {
        if (!this.spendingUsable()) return '';
        const tab = (id, label) => `<button type="button" role="tab" class="finance-tab${active === id ? ' is-active' : ''}" data-finance-tab="${id}" aria-selected="${active === id}">${label}</button>`;
        return `<div class="finance-tablist" role="tablist" aria-label="Finance">${tab('investments', 'Investments')}${tab('spending', 'Spending')}</div>`;
    },

    bindFinanceTabs(root) {
        root.querySelectorAll('[data-finance-tab]').forEach(b => b.addEventListener('click', () => {
            if (b.classList.contains('is-active')) return;
            if (b.dataset.financeTab === 'spending') { AppManager.openApp('spending'); SpendingApp.show({}); }
            else { AppManager.openApp('portfolio'); PortfolioApp.setScope('all'); }
        }));
    },

    /**
     * Investments' own pages as words under the tabs (2026-10-06):
     * Overview · Strategy, the same shape as Spending's page words. Shown
     * on those pages; a
     * drill-in (an account, a ticker) keeps its breadcrumb instead.
     */
    // Tickers and Watchlist left 2026-10-09 (docs/COACH.md §7: Finance keeps
    // the person's own picture; a holding is a row in its account and opens
    // its own page).
    INV_PAGES: [{ id: 'all', label: 'Overview' }, { id: 'strategy', label: 'Strategy' }],

    renderFinanceTabs(scope) {
        const el = document.getElementById('finance-tabs-investments');
        if (!el) return;
        const home = this.INV_PAGES.some(p => p.id === scope);
        el.innerHTML = home ? `${this.financeTabsHtml('investments')}
            <div class="inv-pages" role="tablist" aria-label="Investments">
                ${this.INV_PAGES.map(p => `<button type="button" role="tab" class="inv-page${scope === p.id ? ' is-active' : ''}" data-inv-page="${p.id}" aria-selected="${scope === p.id}">${p.label}</button>`).join('')}
            </div>` : '';
        this.bindFinanceTabs(el);
        el.querySelectorAll('[data-inv-page]').forEach(b => b.addEventListener('click', () => {
            const id = b.dataset.invPage;
            // Strategy's word opens the list, never a plan left open.
            if (id === 'strategy' && typeof PortfolioStrategyPage !== 'undefined') { PortfolioStrategyPage._openId = null; PortfolioStrategyPage.focusedStrategyId = null; }
            if (id !== scope || id === 'strategy') PortfolioApp.setScope(id);
        }));
    },

    CHEV: '<svg class="pf-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',

    /** Account name + type above the masthead when scoped; hidden at All.
     *  Also flips the header's account action buttons (Cash/Edit/Delete). */
    renderScopeHeader(account) {
        const header = document.getElementById('portfolio-scope-header');
        if (header) {
            header.hidden = !account;
            if (account) {
                document.getElementById('portfolio-account-name').textContent = account.name;
                document.getElementById('portfolio-account-type-display').textContent = this.formatAccountType(account.type);
            }
            // Linked brokerage: one quiet line under the type, and the
            // header's Sync button. Drift and sign-in are named here and
            // acted on from the buttons; nothing on this line is a door.
            const linkedEl = document.getElementById('portfolio-account-linked');
            const st = (account && !account.shared && typeof PortfolioBrokerage !== 'undefined') ? PortfolioBrokerage.statusLine(account) : null;
            if (linkedEl) {
                const parts = [st?.text].filter(Boolean);
                linkedEl.hidden = !parts.length;
                linkedEl.textContent = parts.join(' · ');
                linkedEl.dataset.tone = st?.needsLogin ? 'warn' : (st?.drift ? 'attn' : 'ok');
            }
            const syncBtn = document.getElementById('portfolio-account-sync-btn');
            if (syncBtn) {
                syncBtn.hidden = !st || !st.here;
                syncBtn.textContent = st?.needsLogin ? 'Sign in again' : 'Sync now';
                syncBtn.disabled = !!(typeof PortfolioBrokerage !== 'undefined' && PortfolioBrokerage.syncing());
            }
            const driftBtn = document.getElementById('portfolio-account-drift-btn');
            if (driftBtn) {
                driftBtn.hidden = !st || !st.drift;
                driftBtn.textContent = st?.drift ? `Review ${st.drift}` : '';
            }
        }
        for (const id of ['portfolio-account-cash-btn', 'portfolio-account-edit-btn', 'portfolio-account-delete-btn']) {
            const btn = document.getElementById(id);
            if (btn) btn.hidden = !account;
        }
        // Cash is the broker's number on a linked account; the manual
        // Cash door would be overwritten by the next sync.
        const cashBtn = document.getElementById('portfolio-account-cash-btn');
        if (cashBtn && account?.brokerage) cashBtn.hidden = true;
        // A shared-in account is read-only: no Cash, Edit or new
        // transactions; Delete reads "Remove" (it removes the copy).
        const shared = !!account?.shared;
        const editBtn = document.getElementById('portfolio-account-edit-btn');
        if (editBtn && shared) editBtn.hidden = true;
        if (cashBtn && shared) cashBtn.hidden = true;
        const delBtn = document.getElementById('portfolio-account-delete-btn');
        if (delBtn) delBtn.textContent = shared ? 'Remove' : 'Delete';
        const addBtn = document.getElementById('portfolio-add-transaction-btn');
        if (addBtn) addBtn.hidden = shared;
    },

    /** Holdings / Transactions tab strip (both scopes). */
    renderTabs(currentView) {
        document.getElementById('portfolio-holdings-tab')?.classList.toggle('active', currentView === 'holdings');
        document.getElementById('portfolio-txns-tab')?.classList.toggle('active', currentView === 'transactions');
    },

    /** First-run: no accounts yet — a welcome pitch (the News-app recipe;
     *  the sidebar that used to carry the New Account button is gone, so
     *  this is also where that door lives). */
    renderNoAccountsState() {
        const container = document.getElementById('portfolio-holdings');
        if (!container) return;
        container.innerHTML = UIUtils.appWelcome({
            title: 'Your whole portfolio',
            lede: 'Track every account in one place — brokerage, retirement, cash — with live quotes and real market charts. AI helps you build the plan; arithmetic checks it.',
            cta: `<button id="portfolio-empty-create-btn" class="primary-btn" type="button">+ New Account</button>`,
            rows: [
                ['Every account, one page',
                 'Accounts, holdings, transactions and value history side by side, with live quotes and real price-history charts for every ticker.'],
                ['A plan, checked by math',
                 'Describe your strategy in a conversation with the assistant. The app then computes whether you are on plan — target mix, guardrails, drift — so adherence is never an AI’s opinion.'],
                ['Add trades without typing',
                 'Tell the assistant what you bought, or hand it a screenshot of the confirmation — or connect Gmail and executed trades are spotted in your mail. Every capture is added to the right account in one reviewed click; nothing is recorded without your OK.'],
                ['Yours, on your Mac',
                 'Your accounts and transactions live on your Mac — no portfolio service in the middle.']
            ]
        });
        document.getElementById('portfolio-empty-create-btn')?.addEventListener('click', () => {
            PortfolioApp.showCreateAccountModal();
        });
    },

    /**
     * "Prices as of …" freshness caption in the toolbar. Without it the user
     * can't tell live day-change from a three-day-old weekend cache.
     */
    renderPricesAsOf(priceCache, holdings) {
        const el = document.getElementById('portfolio-prices-asof');
        if (!el) return;
        const times = (holdings || [])
            .map(h => priceCache?.[h.ticker]?.updatedAt)
            .filter(Boolean);
        if (!times.length) {
            el.textContent = '';
            el.classList.remove('stale', 'is-live');
            return;
        }
        // Live quotes on screen (PortfolioLive, market open): say so, with
        // the time of the latest tick, instead of the oldest fetch.
        const now = Date.now();
        const live = typeof PortfolioLive !== 'undefined' && PortfolioLive.running()
            ? (holdings || []).map(h => priceCache?.[h.ticker]).filter(c => PortfolioLive.isLive(c, now))
            : [];
        el.classList.toggle('is-live', live.length > 0);
        if (live.length) {
            const at = new Date(Math.max(...live.map(c => c.updatedAt)));
            el.textContent = `Live · ${at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
            el.title = 'US stocks and ETFs update every 15 seconds while the market is open (Robinhood). Funds, non-US listings and options update every 5 minutes (Yahoo Finance).';
            el.classList.remove('stale');
            return;
        }
        el.title = 'When stock prices were last fetched';
        const oldest = Math.min(...times);
        const d = new Date(oldest);
        const sameDay = d.toDateString() === new Date().toDateString();
        const label = sameDay
            ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
            : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        el.textContent = `Prices as of ${label}`;
        el.classList.toggle('stale', Date.now() - oldest > 24 * 3600 * 1000);
    },

    /**
     * The strategy at the foot of the hero card. Since 2026-09-30 an active
     * plan shows as a BAND — name, the verdict with its counts, the mix strip
     * — built from the Strategy overview card's own pieces
     * (PortfolioStrategyPage._verdictLine / _mixStrip, the same
     * PortfolioStrategy.evaluate() arithmetic), so the account page and the
     * Strategy page cannot disagree. The verdict is the PLAN's (every
     * account it covers), which is why an account page names whose plan it
     * is. A draft, or no plan yet, stays the one quiet line. A plan opens
     * straight to its OWN page on the Strategy scope (by request, same day:
     * the card already named the plan, so the overview would be a detour);
     * "No strategy yet" opens the overview, where building starts.
     */
    renderStrategyLine(containerId, show = true, accountId = null) {
        const container = document.getElementById(containerId);
        if (!container) return;
        // At All Accounts the plan is a row among the places
        // (renderPlaces); this container carries it at an account scope.
        const html = show && accountId ? this.strategyRowHtml(accountId) : '';
        container.innerHTML = html ? `<div class="pf-group">${html}</div>` : '';
        this._bindStrategyRow(container);
    },

    /**
     * The plan as ONE row (calm pass, 2026-10-06; was a band at the foot of
     * the hero card): "Strategy", then the plan's name and its verdict from
     * the Strategy page's own arithmetic (PortfolioStrategy.evaluate via
     * PortfolioStrategyPage._verdictLine), so the row and the page cannot
     * disagree. Scoped to an account, it is the plan that account is judged
     * against, and says whose. '' when there is nothing to say.
     */
    strategyRowHtml(accountId = null) {
        if (typeof AgentUI === 'undefined' || typeof PortfolioStrategy === 'undefined') return '';
        const account = accountId ? PortfolioApp.accounts.find(a => a.id === accountId) : null;
        if (account?.shared) return '';   // someone else's money: no plan of ours applies
        const resolved = accountId
            ? PortfolioStrategy.forAccount(accountId)
            : { strategy: PortfolioStrategy.getDefault(), inherited: false };
        const strategy = resolved.strategy;
        if (!strategy && !PortfolioApp.computeHoldings(accountId).length) return '';
        const esc = AppManager.escapeHtml;
        let sub = '', value = '';
        if (!strategy) {
            value = 'Build one with nenva';
        } else if ((strategy.status || 'active') === 'draft') {
            sub = esc(strategy.name);
            value = 'Unfinished';
        } else {
            sub = esc(strategy.name) + (accountId ? ` · ${resolved.inherited ? 'overall plan' : 'this account'}` : '');
            let report = null;
            try { report = PortfolioStrategy.evaluate(strategy); } catch (e) { report = null; }
            const measurable = !!((strategy.targets || []).length || (strategy.rules || []).length);
            if (!measurable) value = 'No targets yet';
            else if (!report || report.empty) value = 'Not measured yet';
            else {
                const words = { 'on-track': 'On plan', drift: 'Drifting', breach: 'Off plan' };
                const targets = report.targets || [];
                const inBand = targets.length ? `${targets.filter(t => t.status === 'ok').length} of ${targets.length} in band` : '';
                value = `<span class="pf-plan-verdict" data-status="${esc(report.status)}">${words[report.status] || 'On plan'}</span>${inBand ? ` · ${inBand}` : ''}`;
            }
        }
        return `
            <button type="button" class="pf-row" data-open-plan="${strategy ? esc(strategy.id) : ''}">
                <span class="pf-tile" aria-hidden="true">${this.ACCOUNT_TYPE_ICON('strategy')}</span>
                <span class="pf-row-copy">
                    <span class="pf-row-label">Strategy</span>
                    ${sub ? `<span class="pf-row-sub">${sub}</span>` : ''}
                </span>
                <span class="pf-row-value">${value}</span>
                ${this.CHEV}
            </button>`;
    },

    _bindStrategyRow(el) {
        el.querySelectorAll('[data-open-plan]').forEach(btn => btn.addEventListener('click', () => {
            const id = btn.dataset.openPlan;
            PortfolioApp.setScope('strategy');
            if (id && typeof PortfolioStrategyPage !== 'undefined') PortfolioStrategyPage.open(id);
        }));
    },

    /**
     * Render the summary masthead
     */
    renderSummaryBar(holdings, accountFilter = 'all') {
        const container = document.getElementById('portfolio-summary');
        if (!container) return;

        const accountId = accountFilter === 'all' ? null : accountFilter;
        const summary = PortfolioApp.getSummary(holdings, accountId);
        container.innerHTML = this.mastheadHtml(summary);
        // The lede says what the big number is; the prices' freshness
        // (renderPricesAsOf) follows it on the same line.
        const what = document.getElementById('portfolio-lede-what');
        if (what) {
            const account = accountId ? PortfolioApp.accounts.find(a => a.id === accountId) : null;
            what.textContent = account
                ? this.formatAccountType(account.type)
                : (summary.liabilitiesTotal > 0 ? 'Net worth' : 'Total value');
        }
    },

    /**
     * Masthead (calm pass, 2026-10-06): one serif number and two plain
     * lines under it, in the voice of Now — what moved (today, all time;
     * the only colour on the page's top is the direction of those two
     * figures) and what the number is made of, as words: investments +
     * cash + real estate − debt. Classes with nothing in them are left
     * out, and a single class says nothing. Was a tinted card with pills,
     * a stacked bar and a legend with swatches.
     */
    mastheadHtml(summary) {
        const hasDebt = summary.liabilitiesTotal > 0;
        const headline = hasDebt ? summary.netWorth : summary.totalValue;
        const stockValue = summary.totalValue - (summary.cash || 0) - (summary.realEstateValue || 0);

        const change = (value, pct, label) => {
            if (PortfolioApp.hideValues) return `<span>•••• ${label}</span>`;
            const money = this.formatPL(value).replace(/\.\d\d$/, '');
            const p = pct != null && isFinite(pct) ? ` (${Math.abs(pct).toFixed(Math.abs(pct) >= 10 ? 1 : 2)}%)` : '';
            return `<span><span class="${this.plClass(value)}">${money}${p}</span> ${label}</span>`;
        };
        const moves = [
            summary.totalDayBase > 0 ? change(summary.totalDayChange, summary.totalDayChangePercent, 'today') : '',
            summary.totalCost > 0 ? change(summary.totalPL, summary.totalPLPercent, 'all time') : ''
        ].filter(Boolean).join('<span class="pf-sep">·</span>');

        const classes = [
            { label: 'Investments', value: stockValue },
            { label: 'Cash', value: summary.cash || 0 },
            { label: 'Real estate', value: summary.realEstateValue || 0 }
        ].filter(c => c.value > 0);
        const terms = classes.map(c => `${c.label} ${this.hv(this.formatMoney(c.value).replace(/\.\d\d$/, ''))}`);
        if (hasDebt) terms.push(`Debt −${this.hv(this.formatMoney(summary.liabilitiesTotal).replace(/\.\d\d$/, ''))}`);
        const composition = (classes.length > 1 || hasDebt) ? terms.join('<span class="pf-sep">·</span>') : '';

        return `
            <div class="portfolio-masthead-value ${hasDebt && headline < 0 ? 'pl-negative' : ''}">${this.moneyHero(headline)}</div>
            ${moves ? `<div class="pf-moves">${moves}</div>` : ''}
            ${this.afterLineHtml(summary.afterSession, summary.afterChange, summary.afterBase, headline)}
            ${composition ? `<div class="pf-composition">${composition}</div>` : ''}
        `;
    },

    /** Extended-session sub-line ("AH +$120 (+0.4%)"); '' when no quote.
     *  Also '' when the user turned extended-session prices off
     *  (PortfolioApp.toggleAfterHours) — gating here rather than at each
     *  call site means the summary bar and every cluster header obey the
     *  setting, and so will anything added later that uses this helper. */
    afterLineHtml(session, change, base, headline) {
        if (!PortfolioApp.showAfterHours) return '';
        if (!session || !base) return '';
        const pct = (change / base) * 100;
        const pre = session === 'pre';
        // The headline value is always the regular-session number; extended
        // quotes never flow into totals, P&L or snapshots. When a headline is
        // given, say what it WOULD be so the user need not add it up.
        const would = (typeof headline === 'number' && headline !== 0)
            ? ` <span class="portfolio-after-hours-would" title="${pre ? 'Pre-market' : 'After-hours'} value if this held">&asymp; ${this.hv(this.formatMoney(headline + change))}</span>`
            : '';
        return `<div class="portfolio-after-hours ${this.hvPlClass(change)}" title="${pre ? 'Pre-market' : 'After-hours'} move">${pre ? 'Pre' : 'AH'} ${this.hv(this.formatPL(change))} (${this.formatPercent(pct)})${would}</div>`;
    },

    /**
     * Build a sortable table header. One builder for every sortable table;
     * scope names the PortfolioApp.sort entry it reads and toggles.
     */
    buildSortableHeader(scope, label, col, isNum) {
        const s = PortfolioApp.sort[scope];
        const isActive = s.col === col;
        // Calm pass (2026-10-06): the arrow shows on the sorted column only.
        const arrow = isActive ? (s.dir === 'asc' ? '▲' : '▼') : '';
        const classes = ['sortable-th'];
        if (isNum) classes.push('num');
        if (isActive) classes.push('sort-active');
        return `<th class="${classes.join(' ')}" data-sort-scope="${scope}" data-col="${col}">${label}${arrow ? `<span class="sort-arrow">${arrow}</span>` : ''}</th>`;
    },

    /** Sort-click delegation for every thead under container. Attach after
     *  each render (theads are recreated with the markup, so no stacking). */
    attachSortListener(container) {
        container.querySelectorAll('thead').forEach(thead => {
            thead.addEventListener('click', (e) => {
                const th = e.target.closest('[data-sort-scope]');
                if (th) PortfolioApp.setSort(th.dataset.sortScope, th.dataset.col);
            });
        });
    },

    /**
     * Body rows — one plain row per holding, in the user's sort. No symbol
     * clustering (removed 2026-07-30 by request: simple view); options are
     * ordinary rows with their friendly contract label.
     */
    holdingsRowsHtml(holdings, totalValue) {
        return PortfolioApp.sortHoldings(holdings)
            .map(h => this.holdingRowHtml(h, totalValue))
            .join('');
    },

    /**
     * One holding row (calm pass, 2026-10-06): five columns, one figure in
     * each. Shares, average cost and price live on the ticker page. Only
     * Today is coloured — it is the change worth seeing at a glance; the
     * all-time gain is ink with its sign, and its percent is in the tooltip
     * like Today's dollars.
     */
    holdingRowHtml(h, totalValue) {
        const weight = totalValue > 0 ? (h.currentValue / totalValue) * 100 : 0;
        const name = this.tickerName(h.ticker);
        const priced = !!h.currentPrice;
        const pct = (v) => isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%` : '&mdash;';
        return `
            <tr class="portfolio-row" data-ticker="${h.ticker}">
                <td class="portfolio-ticker">
                    <span class="portfolio-ticker-cell">
                        <span class="portfolio-ticker-main">
                            <span class="portfolio-ticker-sym">${this.tickerCellHtml(h)}</span>
                            ${name ? `<span class="portfolio-ticker-name">${AppManager.escapeHtml(name)}</span>` : ''}
                        </span>
                    </span>
                </td>
                <td class="num portfolio-cell-strong">${priced ? this.hv(this.formatMoney(h.currentValue).replace(/\.\d\d$/, '')) : '&mdash;'}</td>
                <td class="num portfolio-cell-quiet">${priced ? `${weight.toFixed(1)}%` : '&mdash;'}</td>
                <td class="num ${priced ? this.plClass(h.dayChange) : ''}" title="${priced ? this.hv(this.formatPL(h.dayChange)) + ' today' : ''}">${priced ? pct(h.dayChangePercent) : '&mdash;'}</td>
                <td class="num" title="${priced ? pct(h.profitLossPercent) + ' all time' : ''}">${priced ? this.hv(this.formatPL(h.profitLoss).replace(/\.\d\d$/, '')) : '&mdash;'}</td>
            </tr>
        `;
    },

    renderHoldingsTable(holdings, containerId = 'portfolio-holdings', cashOverride = null) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (holdings.length === 0) {
            container.innerHTML = `<p class="pf-empty">No holdings yet. Add a transaction from the &hellip; menu, or tell nenva what you own.</p>`;
            return;
        }

        const cash = cashOverride !== null ? cashOverride : PortfolioApp.computeTotalCash();
        const totalValue = holdings.reduce((s, h) => s + h.currentValue, 0) + cash;

        // No heading inside: the Holdings | Transactions switch above names
        // it, and the masthead already carries today and all time.
        container.innerHTML = `
            <div class="pf-table-panel portfolio-holdings-card">
            <table class="portfolio-table portfolio-holdings-table">
                <thead>
                    <tr>
                        ${this.buildSortableHeader('holdings', 'Ticker', 'ticker', false)}
                        ${this.buildSortableHeader('holdings', 'Value', 'currentValue', true)}
                        ${this.buildSortableHeader('holdings', 'Weight', 'weight', true)}
                        ${this.buildSortableHeader('holdings', 'Today', 'dayChangePercent', true)}
                        ${this.buildSortableHeader('holdings', 'All time', 'profitLoss', true)}
                    </tr>
                </thead>
                <tbody>
                    ${this.holdingsRowsHtml(holdings, totalValue)}
                    ${this.renderCashRow(cash, totalValue)}
                </tbody>
            </table>
            </div>
        `;

        this.attachSortListener(container);

        // Row click to open ticker or cash detail
        container.querySelectorAll('.portfolio-row').forEach(row => {
            row.addEventListener('click', () => {
                if (row.dataset.cash) {
                    PortfolioApp.openCashDetail();
                } else {
                    PortfolioApp.openTickerDetail(row.dataset.ticker);
                }
            });
        });
    },

    /**
     * Notes linked to the portfolio or an account before 2026-10-09, one tap
     * away (read-only: a new note is said in the page's chat and kept on
     * the account). No section when there are none.
     */
    renderLinkedNotes(containerId, itemId) {
        const el = document.getElementById(containerId);
        if (!el) return;
        let notes = [];
        try { notes = (typeof LinkManager !== 'undefined' && LinkManager.resolveLinks('portfolio', itemId)?.notes) || []; } catch { notes = []; }
        el.hidden = !notes.length;
        if (!notes.length) { el.innerHTML = ''; return; }
        const esc = AppManager.escapeHtml;
        el.innerHTML = `<div class="pf-eyebrow">Notes</div><div class="pf-group">${notes.map(n => `
            <button type="button" class="pf-row" data-note="${esc(n.itemId)}">
                <span class="pf-row-copy"><span class="pf-row-label">${esc(n.title || 'Untitled')}</span></span>
                ${this.CHEV}
            </button>`).join('')}</div>`;
        el.querySelectorAll('[data-note]').forEach(b => b.addEventListener('click', () => {
            if (typeof NotesApp !== 'undefined' && NotesApp.openEditor) NotesApp.openEditor(b.dataset.note);
        }));
    },

    /**
     * Render transaction list. `opts.hideTicker` drops the symbol from each
     * row — for the ticker detail's tab, where every row would repeat the
     * one symbol the page is about.
     */
    renderTransactionList(transactions, container, opts = {}) {
        if (transactions.length === 0) {
            container.innerHTML = '<p class="pf-empty">No transactions yet. Add one from the &hellip; menu, or tell nenva what you bought.</p>';
            return;
        }

        // Calm pass (2026-10-06): on one white panel, the kind as a plain
        // word (was a coloured BUY / HELD pill).
        container.innerHTML = `
            <div class="portfolio-txn-list pf-table-panel">
                ${transactions.map(txn => {
                    const account = PortfolioApp.accounts.find(a => a.id === txn.accountId);
                    // A linked brokerage's cash event (dividend, deposit,
                    // fee, interest): label from its subtype, the amount as
                    // the total, no "shares @ price". Not editable (no
                    // click target) — see openTransactionEditor.
                    if (txn.type === 'cash') {
                        const label = String(txn.subtype || 'cash').replace(/[_-]+/g, ' ');
                        return `
                        <div class="portfolio-txn-item portfolio-txn-cash" data-txn-id="${txn.id}">
                            <div class="portfolio-txn-left">
                                <span class="portfolio-txn-type cash">${AppManager.escapeHtml(label)}</span>
                                ${(!opts.hideTicker && txn.ticker) ? `<span class="portfolio-txn-ticker">${AppManager.escapeHtml(PortfolioApp.displayTicker(txn.ticker))}</span>` : ''}
                                <span class="portfolio-txn-detail">${AppManager.escapeHtml(txn.notes || '')}</span>
                            </div>
                            <div class="portfolio-txn-right">
                                <span class="portfolio-txn-total">${this.hv((txn.amount < 0 ? '−' : '+') + this.formatMoney(Math.abs(txn.amount || 0)))}</span>
                                <span class="portfolio-txn-date">${this.formatDate(txn.date)}</span>
                                ${account ? `<span class="portfolio-txn-account">${AppManager.escapeHtml(account.name)}</span>` : ''}
                            </div>
                        </div>`;
                    }
                    return `
                        <div class="portfolio-txn-item" data-txn-id="${txn.id}">
                            <div class="portfolio-txn-left">
                                <span class="portfolio-txn-type ${txn.type}">${txn.type === 'holding' ? 'Held' : txn.type.charAt(0).toUpperCase() + txn.type.slice(1)}</span>
                                ${opts.hideTicker ? '' : `<span class="portfolio-txn-ticker">${AppManager.escapeHtml(PortfolioApp.displayTicker(txn.ticker))}</span>`}
                                <span class="portfolio-txn-detail">${this.formatShares(txn.quantity)} @ ${this.formatMoney(txn.pricePerShare)}</span>
                            </div>
                            <div class="portfolio-txn-right">
                                <span class="portfolio-txn-total">${this.hv(this.formatMoney(PortfolioApp.txnAmount(txn)))}</span>
                                <span class="portfolio-txn-date">${this.formatDate(txn.date)}</span>
                                ${account ? `<span class="portfolio-txn-account">${AppManager.escapeHtml(account.name)}</span>` : ''}
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;

        // Click to edit (cash ledger rows from a linked brokerage excepted)
        container.querySelectorAll('.portfolio-txn-item:not(.portfolio-txn-cash)').forEach(item => {
            item.addEventListener('click', () => {
                PortfolioApp.openTransactionEditor(item.dataset.txnId);
            });
        });
    },

    // ---- Transaction Editor ----

    renderTransactionEditor(transaction, accounts, defaultAccountId) {
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

        // Type toggle
        const buyRadio = document.getElementById('txn-type-buy');
        const sellRadio = document.getElementById('txn-type-sell');
        const holdingRadio = document.getElementById('txn-type-holding');
        if (buyRadio && sellRadio) {
            if (transaction?.type === 'sell') {
                sellRadio.checked = true;
            } else if (transaction?.type === 'holding' && holdingRadio) {
                holdingRadio.checked = true;
            } else {
                buyRadio.checked = true;
            }
        }

        // Asset mode (stock vs option) — derived from the edited ticker;
        // option contracts are stored as OCC symbols, so parsing tells us.
        const optMeta = transaction ? PortfolioApp.optionMeta(transaction.ticker) : null;
        const stockRadio = document.getElementById('txn-asset-stock');
        const optionRadio = document.getElementById('txn-asset-option');
        if (stockRadio && optionRadio) {
            (optMeta ? optionRadio : stockRadio).checked = true;
        }
        const callRadio = document.getElementById('txn-opt-call');
        const putRadio = document.getElementById('txn-opt-put');
        if (callRadio && putRadio) {
            (optMeta?.optionType === 'put' ? putRadio : callRadio).checked = true;
        }

        // Account select
        const accountSelect = document.getElementById('txn-account-select');
        if (accountSelect) {
            accountSelect.innerHTML = `
                <option value="">Select account...</option>
                ${accounts.map(a => `<option value="${a.id}" ${(transaction?.accountId || defaultAccountId) === a.id ? 'selected' : ''}>${AppManager.escapeHtml(a.name)}</option>`).join('')}
            `;
        }

        // Fields
        const fields = {
            'txn-ticker-input': optMeta ? '' : (transaction?.ticker || ''),
            'txn-opt-underlying': optMeta?.underlying || '',
            'txn-opt-strike': optMeta?.strike || '',
            'txn-opt-expiration': optMeta?.expiration || '',
            'txn-quantity-input': transaction?.quantity || '',
            'txn-price-input': transaction?.pricePerShare || '',
            'txn-date-input': transaction?.date || today,
            'txn-notes-input': transaction?.notes || ''
        };

        Object.entries(fields).forEach(([id, value]) => {
            const el = document.getElementById(id);
            if (el) el.value = value;
        });

        // Title
        const titleEl = document.getElementById('portfolio-transaction-title');
        if (titleEl) titleEl.textContent = transaction ? 'Edit Transaction' : 'New Transaction';

        // Live preview wiring. Property-assigned handlers (not
        // addEventListener) so re-opening the editor doesn't stack
        // duplicates — same pattern as the Customize-apps list.
        const uppercaseOnInput = (input) => {
            input.oninput = () => {
                // Tickers are uppercase — fix as the user types.
                const pos = input.selectionStart;
                input.value = input.value.toUpperCase();
                input.setSelectionRange(pos, pos);
                this.updateTxnPreview();
            };
        };
        const tickerInput = document.getElementById('txn-ticker-input');
        if (tickerInput) uppercaseOnInput(tickerInput);
        const underlyingInput = document.getElementById('txn-opt-underlying');
        if (underlyingInput) uppercaseOnInput(underlyingInput);
        ['txn-account-select', 'txn-quantity-input', 'txn-price-input',
         'txn-opt-strike', 'txn-opt-expiration'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.oninput = () => this.updateTxnPreview();
        });
        document.querySelectorAll('input[name="txn-type"], input[name="txn-opt-type"]').forEach(r => {
            r.onchange = () => this.updateTxnPreview();
        });
        document.querySelectorAll('input[name="txn-asset"]').forEach(r => {
            r.onchange = () => this.updateTxnAssetMode();
        });

        const useBtn = document.getElementById('txn-use-price-btn');
        if (useBtn) {
            useBtn.onclick = async () => {
                const ticker = this.txnEditorTicker();
                if (!ticker) return;
                useBtn.disabled = true;
                useBtn.textContent = 'Fetching…';
                const quote = await PriceFetcher.fetchSingle(ticker);
                useBtn.disabled = false;
                useBtn.textContent = 'Use current';
                if (quote?.price) {
                    const priceInput = document.getElementById('txn-price-input');
                    if (priceInput) priceInput.value = quote.price.toFixed(2);
                    this.updateTxnPreview();
                } else {
                    UIUtils.showToast(`Couldn't fetch a price for ${PortfolioApp.displayTicker(ticker)}`, 'error');
                }
            };
        }

        this.updateTxnAssetMode();
    },

    /**
     * The ticker the editor currently describes: the stock symbol as typed,
     * or the OCC symbol assembled from the option fields ('' until the
     * contract is fully specified).
     */
    txnEditorTicker() {
        const isOption = document.querySelector('input[name="txn-asset"]:checked')?.value === 'option';
        if (!isOption) {
            return (document.getElementById('txn-ticker-input')?.value || '').trim().toUpperCase();
        }
        const underlying = (document.getElementById('txn-opt-underlying')?.value || '').trim().toUpperCase();
        const optionType = document.querySelector('input[name="txn-opt-type"]:checked')?.value || 'call';
        const strike = parseFloat(document.getElementById('txn-opt-strike')?.value);
        const expiration = document.getElementById('txn-opt-expiration')?.value;
        if (!underlying || !(strike > 0) || !expiration) return '';
        return PortfolioApp.buildOccSymbol(underlying, expiration, optionType, strike);
    },

    /** Swap the editor between stock fields and option-contract fields. */
    updateTxnAssetMode() {
        const isOption = document.querySelector('input[name="txn-asset"]:checked')?.value === 'option';
        const show = (id, on) => {
            const el = document.getElementById(id);
            if (el) el.hidden = !on;
        };
        show('txn-ticker-group', !isOption);
        show('txn-underlying-group', isOption);
        show('txn-option-row', isOption);
        const qtyLabel = document.getElementById('txn-quantity-label');
        if (qtyLabel) qtyLabel.textContent = isOption ? 'Contracts' : 'Shares';
        this.updateTxnPreview();
    },

    /**
     * Transaction editor live math: order total, cash-after in the chosen
     * account (accounting for the reversal of the transaction being
     * edited), and how many shares are on hand when selling.
     */
    updateTxnPreview() {
        const type = document.querySelector('input[name="txn-type"]:checked')?.value || 'buy';
        const isOption = document.querySelector('input[name="txn-asset"]:checked')?.value === 'option';
        const accountId = document.getElementById('txn-account-select')?.value || '';
        const ticker = this.txnEditorTicker();
        const qty = parseFloat(document.getElementById('txn-quantity-input')?.value);
        const price = parseFloat(document.getElementById('txn-price-input')?.value);
        const mult = isOption ? 100 : 1;

        const useBtn = document.getElementById('txn-use-price-btn');
        if (useBtn) useBtn.hidden = !ticker;

        // Holding mode: explain the semantics and relabel price as avg cost.
        const typeHint = document.getElementById('txn-type-hint');
        if (typeHint) typeHint.hidden = type !== 'holding';
        const priceLabel = document.getElementById('txn-price-label');
        if (priceLabel) {
            priceLabel.textContent = isOption
                ? (type === 'holding' ? 'Avg premium' : 'Premium')
                : (type === 'holding' ? 'Avg cost' : 'Price');
        }
        const premiumHint = document.getElementById('txn-premium-hint');
        if (premiumHint) premiumHint.hidden = !isOption;

        const unit = isOption ? 'contract' : 'share';
        const hint = document.getElementById('txn-owned-hint');
        if (hint) {
            if (type === 'sell' && ticker && accountId) {
                const holding = PortfolioApp.computeHoldings(accountId).find(h => h.ticker === ticker);
                const owned = holding?.totalShares || 0;
                const label = PortfolioApp.displayTicker(ticker);
                hint.hidden = false;
                hint.textContent = owned > 0
                    ? `You hold ${owned} ${unit}${owned === 1 ? '' : 's'} of ${label} in this account.`
                    : `No ${label} ${unit}s in this account.`;
            } else {
                hint.hidden = true;
            }
        }

        // The sheet's headline reads the order back as a sentence, built
        // from the fields alone ("Buy 10 AAPL at $150.00") — never typed,
        // never model-written.
        const headline = document.getElementById('txn-headline');
        if (headline) {
            const verb = { buy: 'Buy', sell: 'Sell', holding: 'Hold' }[type] || 'Buy';
            const what = ticker ? PortfolioApp.displayTicker(ticker) : '';
            const unitWord = isOption ? (qty === 1 ? 'contract' : 'contracts') : 'shares';
            const amount = qty > 0 ? `${qty} ` : '';
            const at = price > 0 ? ` at ${this.formatMoney(price)}` : '';
            let line = '';
            if (what) line = `${verb} ${amount}${isOption && amount ? `${unitWord} of ` : ''}${what}${at}`;
            else if (amount) line = `${verb} ${amount}${unitWord}${at}`;
            headline.textContent = line || (PortfolioApp.editingTransaction ? 'Transaction' : 'New transaction');
        }

        const summary = document.getElementById('txn-summary');
        if (!summary) return;
        if (!(qty > 0) || !(price > 0)) {
            summary.hidden = true;
            return;
        }
        const total = qty * price * mult;
        let cashLine = '';
        if (type === 'holding') {
            // Holdings never move cash — say so instead of showing math.
            cashLine = ' &middot; Cash unchanged';
        } else if (accountId) {
            let cash = PortfolioApp.computeCash(accountId);
            // Editing: the old transaction's cash effect gets reversed on
            // save, so fold that reversal into the preview ('holding' had
            // no cash effect, so there's nothing to reverse).
            const old = PortfolioApp.editingTransaction;
            if (old && old.accountId === accountId && old.type !== 'holding') {
                cash += (old.type === 'buy' ? 1 : -1) * PortfolioApp.txnAmount(old);
            }
            const after = type === 'buy' ? cash - total : cash + total;
            const acct = PortfolioApp.getAccounts().find(a => a.id === accountId);
            const afterStr = this.formatMoney(after);
            cashLine = ` &middot; Cash in ${AppManager.escapeHtml(acct?.name || 'account')} after: ` +
                (after < 0 ? `<span class="txn-cash-warn">${afterStr}</span>` : afterStr);
        }
        summary.hidden = false;
        summary.innerHTML = `${type === 'holding' ? 'Cost basis' : 'Total'}: <strong>${this.formatMoney(total)}</strong>${cashLine}`;
    },

    // ---- Ticker Detail View ----

    /**
     * The ticker page's masthead (calm pass, 2026-10-06): the price as the
     * serif number, today's move under it, and — for a position — one
     * sentence of what the person owns. Its own function so the live tick
     * (PortfolioLive) can replace just this block (it keeps the
     * .portfolio-summary class that tick looks for). '' with no price yet.
     * Was a five-figure strip where "Portfolio weight" wore a plus sign.
     */
    tickerSummaryHtml(ticker, holding, priceData, portfolioTotal) {
        const esc = AppManager.escapeHtml;
        const price = holding?.currentPrice || priceData?.price;
        if (!price) return '';
        const estimated = holding ? holding.priceEstimated : priceData?.estimated;
        const pct = priceData?.changePercent ?? holding?.dayChangePercent;
        const per = priceData?.change;
        // A public market price is not the user's value: never hv-masked.
        const move = isFinite(pct)
            ? `<div class="pf-moves"><span><span class="${this.plClass(pct)}">${isFinite(per) ? this.formatPL(per) + ' ' : ''}(${Math.abs(pct).toFixed(2)}%)</span> today</span></div>`
            : '';
        const after = holding ? this.afterLineHtml(holding.after?.session, holding.after ? holding.after.change : 0, holding.after ? price : 0) : '';
        let position = '';
        if (holding) {
            const weight = portfolioTotal > 0 ? (holding.currentValue / portfolioTotal) * 100 : 0;
            const shares = this.formatShares(holding.totalShares);
            const parts = [
                `You own ${PortfolioApp.hideValues ? '••' : shares} ${holding.totalShares === 1 ? 'share' : 'shares'}, worth ${this.hv(this.formatMoney(holding.currentValue).replace(/\.\d\d$/, ''))}`,
                holding.costBasis > 0 ? `<span class="${this.hvPlClass(holding.profitLoss)}">${this.hv(this.formatPL(holding.profitLoss).replace(/\.\d\d$/, ''))} (${Math.abs(holding.profitLossPercent || 0).toFixed(1)}%)</span> all time` : '',
                portfolioTotal > 0 ? `${weight.toFixed(1)}% of your portfolio` : ''
            ].filter(Boolean);
            position = `<p class="pf-position">${parts.join('<span class="pf-sep">·</span>')}</p>`;
        }
        return `
            <div class="portfolio-summary pf-ticker-mast" data-ticker="${esc(ticker)}">
                <div class="portfolio-masthead-value">${estimated ? '<span title="Estimated from the adjacent strikes&rsquo; quotes">~</span>' : ''}${this.formatMoney(price)}</div>
                ${move}
                ${after}
                ${position}
            </div>`;
    },

    /**
     * The ticker page (calm pass, 2026-10-06), in the order a person reads
     * it: who it is (a lede), the price and their position (the masthead),
     * ONE chart (price, or their value, by a switch), where they hold it and
     * what they did (Accounts | Transactions), what is being said about it
     * now (headlines), what the business is (the profile and the company's
     * own description, folded), and last the research sites as quiet links.
     * It used to open on four lines of company boilerplate and five pills.
     */
    renderTickerDetail(ticker, holding, byAccount, companyInfo, priceData, tickerHistory, hideValues) {
        const container = document.getElementById('portfolio-ticker-content');
        if (!container) return;
        const esc = AppManager.escapeHtml;

        const allHoldings = PortfolioApp.computeHoldings();
        const portfolioTotal = allHoldings.reduce((s, h) => s + h.currentValue, 0) + PortfolioApp.computeTotalCash();
        let html = '';

        // The lede: the company's name and its sector, or the contract.
        const optMeta = PortfolioApp.optionMeta(ticker);
        let lede = '';
        if (optMeta) {
            const days = PortfolioApp.optionDaysToExpiry(optMeta);
            const expiryNote = days < 0 ? 'expired'
                : days === 0 ? 'expires today'
                : `${days} day${days === 1 ? '' : 's'} to expiration`;
            lede = [`${optMeta.optionType === 'put' ? 'Put' : 'Call'} option on ${esc(optMeta.underlying)}`,
                `strike ${this.formatMoney(optMeta.strike)}`, `expires ${this.formatDate(optMeta.expiration)}`, expiryNote, '1 contract = 100 shares'].join('<span class="pf-sep">·</span>');
        } else if (!companyInfo) {
            lede = 'Loading&hellip;';
        } else if (!companyInfo.error) {
            lede = [esc(companyInfo.name), companyInfo.sector ? esc(companyInfo.sector) : ''].filter(Boolean).join('<span class="pf-sep">·</span>');
        }
        if (lede) html += `<p class="pf-lede">${lede}</p>`;

        html += this.tickerSummaryHtml(ticker, holding, priceData, portfolioTotal);

        // ONE chart. Price is the market's (Yahoo, with ranges); "Your
        // value" is this position's own snapshots, offered only when there
        // are some. Two stacked charts on different date ranges read as one
        // story told twice.
        const canValue = !!(holding && tickerHistory && tickerHistory.length >= 2);
        const mode = canValue ? (PortfolioApp.tickerChartMode || 'price') : 'price';
        const range = PortfolioApp.tickerChartRange || '1y';
        html += `
            <div class="portfolio-detail-chart-head">
                ${canValue ? `
                <div class="pf-switch" role="tablist" aria-label="Chart">
                    <button type="button" role="tab" class="${mode === 'price' ? 'is-active' : ''}" data-chart-mode="price" aria-selected="${mode === 'price'}">Price</button>
                    <button type="button" role="tab" class="${mode === 'value' ? 'is-active' : ''}" data-chart-mode="value" aria-selected="${mode === 'value'}">Your value</button>
                </div>` : '<span></span>'}
                ${mode === 'price' ? `
                <div class="portfolio-chart-ranges" role="tablist" aria-label="Price history range">
                    ${[['1m', '1M'], ['3m', '3M'], ['1y', '1Y'], ['5y', '5Y'], ['max', 'Max']].map(([id, label]) =>
                        `<button type="button" role="tab" class="portfolio-chart-range-btn ${id === range ? 'is-active' : ''}"
                            data-ticker-range="${id}" aria-selected="${id === range}">${label}</button>`).join('')}
                </div>` : ''}
            </div>
            ${mode === 'price'
                ? '<div id="portfolio-ticker-price-chart" class="portfolio-detail-chart"></div>'
                : '<div id="portfolio-ticker-value-chart" class="portfolio-detail-chart"></div>'}
        `;

        // Where it is held, and what was done: the main page's switch, one
        // scope down. Shares, cost and gain per account live here now, so
        // the main table can stay at five columns.
        const txns = PortfolioApp.getTickerTransactions(ticker);
        const tab = txns.length ? (PortfolioApp.tickerTab || 'holdings') : 'holdings';
        if (byAccount.length > 0 || txns.length > 0) {
            html += `
                <div class="portfolio-tabs portfolio-ticker-tabs">
                    <button type="button" class="portfolio-tab${tab === 'holdings' ? ' active' : ''}" data-ticker-tab="holdings">Accounts</button>
                    ${txns.length ? `<button type="button" class="portfolio-tab${tab === 'transactions' ? ' active' : ''}" data-ticker-tab="transactions">Transactions</button>` : ''}
                </div>
            `;
        }
        if (tab === 'holdings' && byAccount.length > 0) {
            html += `
                <div class="pf-table-panel">
                <table class="portfolio-table">
                    <thead>
                        <tr>
                            <th>Account</th>
                            <th class="num">Shares</th>
                            <th class="num">Avg cost</th>
                            <th class="num">Value</th>
                            <th class="num">All time</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${byAccount.map(h => `
                            <tr class="portfolio-row" data-account="${esc(h.account.id)}">
                                <td>${esc(h.account.name)}<span class="portfolio-ticker-name">${esc(this.formatAccountType(h.account.type))}</span></td>
                                <td class="num">${this.formatShares(h.totalShares)}</td>
                                <td class="num portfolio-cell-quiet">${this.formatMoney(h.avgCostBasis)}</td>
                                <td class="num portfolio-cell-strong">${h.currentPrice ? this.hv(this.formatMoney(h.currentValue).replace(/\.\d\d$/, '')) : '&mdash;'}</td>
                                <td class="num" title="${h.currentPrice ? Math.abs(h.profitLossPercent || 0).toFixed(1) + '%' : ''}">${h.currentPrice ? this.hv(this.formatPL(h.profitLoss).replace(/\.\d\d$/, '')) : '&mdash;'}</td>
                            </tr>`).join('')}
                    </tbody>
                </table>
                </div>
            `;
        }
        if (tab === 'transactions') html += '<div id="portfolio-ticker-txns"></div>';

        // What the business is: the company's own description (Yahoo's
        // profile, not a model's), folded to two lines.
        const about = (!optMeta && companyInfo && !companyInfo.error) ? companyInfo : null;
        const facts = about ? [about.industry, about.country, about.employees ? `${about.employees.toLocaleString()} employees` : '']
            .filter(Boolean).map(esc) : [];
        const site = about?.website ? UIUtils.safeHref(about.website) : '';
        html += `
            <section class="pf-about">
                <div class="pf-eyebrow">About</div>
                ${about?.description ? `
                <p class="pf-about-text is-folded">${esc(about.description)}</p>
                <button type="button" class="pf-link" data-about-more>More</button>` : ''}
                ${facts.length || site ? `<p class="pf-about-facts">${facts.join('<span class="pf-sep">·</span>')}${site ? `${facts.length ? '<span class="pf-sep">·</span>' : ''}<a class="pf-link" href="${esc(site)}" target="_blank" rel="noopener noreferrer">${esc(about.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a>` : ''}</p>` : ''}
            </section>`;

        // Research elsewhere: quiet links, last (pills under the name until
        // 2026-10-06). Options link via their underlying.
        html += `
            <p class="pf-openin">Open in
                ${PortfolioApp.TICKER_SITES.map(s => `<button type="button" class="pf-link" data-site="${s.action}">${esc(s.label)}</button>`).join('<span class="pf-sep">·</span>')}
            </p>`;

        // The ticker's own chat (2026-10-09): questions about the position
        // and notes about it are said here.
        html += `<div class="pf-chat">${PortfolioApp.chatBoxHtml('ticker', ticker)}</div>`;

        container.innerHTML = html;

        if (mode === 'price') this.loadTickerPriceChart(ticker, tickerHistory);
        else this.renderDetailChart('portfolio-ticker-value-chart', tickerHistory, 'value', hideValues);

        container.querySelectorAll('[data-site]').forEach(link =>
            link.addEventListener('click', () => PortfolioApp.openTickerSite(link.dataset.site)));
        container.querySelectorAll('[data-ticker-range]').forEach(btn =>
            btn.addEventListener('click', () => PortfolioApp.setTickerChartRange(btn.dataset.tickerRange)));
        container.querySelectorAll('[data-chart-mode]').forEach(btn =>
            btn.addEventListener('click', () => PortfolioApp.setTickerChartMode(btn.dataset.chartMode)));
        container.querySelector('[data-about-more]')?.addEventListener('click', (e) => {
            const text = container.querySelector('.pf-about-text');
            const folded = text.classList.toggle('is-folded');
            e.currentTarget.textContent = folded ? 'More' : 'Less';
        });
        container.querySelectorAll('tr[data-account]').forEach(row =>
            row.addEventListener('click', () => {
                PortfolioApp.closeTickerDetail();
                PortfolioApp.setScope(row.dataset.account);
            }));

        // Same renderer as the main view's tab — it binds its own row clicks,
        // so editing a transaction works identically from here. The ticker
        // column is dropped: every row on this page carries the same symbol.
        const txnPane = document.getElementById('portfolio-ticker-txns');
        if (txnPane) this.renderTransactionList(txns, txnPane, { hideTicker: true });

        container.querySelectorAll('[data-ticker-tab]').forEach(btn =>
            btn.addEventListener('click', () => PortfolioApp.switchTickerTab(btn.dataset.tickerTab)));
    },

    /**
     * Render a cash line item row for the holdings table
     */
    renderCashRow(cash, totalValue) {
        if (!cash) return '';
        const weight = totalValue > 0 ? (cash / totalValue) * 100 : 0;
        return `
            <tr class="portfolio-cash-row portfolio-row" data-cash="true">
                <td class="portfolio-ticker"><span class="portfolio-ticker-cell"><span class="portfolio-ticker-main"><span class="portfolio-ticker-sym">Cash</span><span class="portfolio-ticker-name">Uninvested</span></span></span></td>
                <td class="num portfolio-cell-strong">${this.hv(this.formatMoney(cash).replace(/\.\d\d$/, ''))}</td>
                <td class="num portfolio-cell-quiet">${weight.toFixed(1)}%</td>
                <td class="num"></td>
                <td class="num"></td>
            </tr>
        `;
    },

    renderCashDetail(accounts) {
        const container = document.getElementById('portfolio-ticker-content');
        if (!container) return;

        const accountsWithCash = accounts
            .map(a => ({ account: a, name: a.name, type: a.type, cash: PortfolioApp.computeCash(a.id) }))
            .filter(a => a.cash !== 0);

        const { col, dir: d } = PortfolioApp.sort.cash;
        const dir = d === 'asc' ? 1 : -1;
        accountsWithCash.sort((a, b) => {
            if (col === 'name' || col === 'type') {
                return dir * (a[col] || '').localeCompare(b[col] || '');
            }
            return dir * ((a[col] || 0) - (b[col] || 0));
        });

        const totalCash = accountsWithCash.reduce((sum, a) => sum + a.cash, 0);
        const esc = AppManager.escapeHtml;
        const money = (v) => this.hv(this.formatMoney(v).replace(/\.\d\d$/, ''));

        // Calm pass (2026-10-06): the masthead's shape, and the accounts as
        // Settings rows that open the account.
        let html = `
            <p class="pf-lede">Cash across your accounts</p>
            <div class="pf-detail-mast"><div class="portfolio-masthead-value">${this.moneyHero(totalCash)}</div></div>`;
        if (accountsWithCash.length > 0) {
            html += `
                <div class="pf-eyebrow">By account</div>
                <div class="pf-group">
                    ${accountsWithCash.map(a => `
                    <button type="button" class="pf-row" data-scope="${esc(a.account.id)}">
                        <span class="pf-tile" aria-hidden="true">${this.ACCOUNT_TYPE_ICON(a.account.type || 'other')}</span>
                        <span class="pf-row-copy">
                            <span class="pf-row-label">${esc(a.account.name)}</span>
                            <span class="pf-row-sub">${esc(this.formatAccountType(a.account.type))}</span>
                        </span>
                        <span class="pf-row-value">${money(a.cash)}</span>
                        ${this.CHEV}
                    </button>`).join('')}
                </div>`;
        } else {
            html += '<p class="pf-empty">No cash balances. Set an account&rsquo;s cash from its &hellip; menu.</p>';
        }

        container.innerHTML = html;
        container.querySelectorAll('[data-scope]').forEach(btn => btn.addEventListener('click', () => {
            PortfolioApp.closeTickerDetail();
            PortfolioApp.setScope(btn.dataset.scope);
        }));
    },

    // ---- Properties Section ----

    // ---- Liability and property pages (calm pass, 2026-10-06) ----
    // The masthead's shape: a lede, the serif number, a plain line or two;
    // the facts as Settings rows; notes as prose; Edit and Delete as quiet
    // links at the foot. They were a strip of six equal figures, notes in a
    // card and two buttons.

    /** One fact row: label, value. A row with `attrs` is a door. */
    _factRow(label, value, attrs = '') {
        return `
            <${attrs ? 'button type="button"' : 'div'} class="pf-row pf-fact-row" ${attrs}>
                <span class="pf-row-copy"><span class="pf-row-label">${label}</span></span>
                <span class="pf-row-value">${value}</span>
                ${attrs ? this.CHEV : ''}
            </${attrs ? 'button' : 'div'}>`;
    },

    _notesHtml(notes) {
        return notes ? `<section class="pf-section"><div class="pf-eyebrow">Notes</div><p class="pf-notes">${AppManager.escapeHtml(notes)}</p></section>` : '';
    },

    _footLinksHtml(prefix) {
        return `<p class="pf-openin"><button type="button" class="pf-link" id="${prefix}-edit-btn">Edit</button><span class="pf-sep">·</span><button type="button" class="pf-link" id="${prefix}-delete-btn">Delete</button></p>`;
    },

    renderLiabilityDetail(liability) {
        const container = document.getElementById('portfolio-liability-content');
        if (!container) return;

        const esc = AppManager.escapeHtml;
        const money = (v) => this.hv(this.formatMoney(v).replace(/\.\d\d$/, ''));
        const paid = liability.originalAmount > 0 ? liability.originalAmount - (liability.balance || 0) : null;
        const paidPct = paid !== null && liability.originalAmount > 0 ? (paid / liability.originalAmount) * 100 : null;
        const property = liability.propertyId ? PortfolioApp.properties.find(p => p.id === liability.propertyId) : null;
        const equity = property ? (property.currentValue || 0) - (liability.balance || 0) : null;
        const lede = [PortfolioApp.liabilityTypeLabel(liability.type), liability.lender].filter(Boolean).map(esc).join('<span class="pf-sep">·</span>');
        const line = [
            paid !== null ? `${money(paid)} paid down (${Math.abs(paidPct).toFixed(1)}%) of ${money(liability.originalAmount)}` : '',
            liability.monthlyPayment != null ? `${money(liability.monthlyPayment)} a month` : ''
        ].filter(Boolean).join('<span class="pf-sep">·</span>');
        const facts = [
            liability.interestRate != null ? this._factRow('Interest rate', `${liability.interestRate}%`) : '',
            liability.startDate ? this._factRow('Started', this.formatDate(liability.startDate)) : '',
            property ? this._factRow('Secured by', esc(property.name), 'data-open-property') : '',
            property ? this._factRow('Equity in it', `<span class="${this.hvPlClass(equity)}">${money(equity)}</span> of ${money(property.currentValue)}`) : ''
        ].filter(Boolean);

        container.innerHTML = `
            ${lede ? `<p class="pf-lede">${lede}</p>` : ''}
            <div class="pf-detail-mast">
                <div class="portfolio-masthead-value">${this.moneyHero(liability.balance || 0)}</div>
                <div class="pf-moves">owed${line ? `<span class="pf-sep">·</span>${line}` : ''}</div>
            </div>
            ${facts.length ? `<div class="pf-group">${facts.join('')}</div>` : ''}
            ${this._notesHtml(liability.notes)}
            ${this._footLinksHtml('portfolio-liability')}
        `;

        document.getElementById('portfolio-liability-edit-btn')?.addEventListener('click', () => PortfolioApp.showEditLiabilityModal(liability.id));
        document.getElementById('portfolio-liability-delete-btn')?.addEventListener('click', () => PortfolioApp.deleteLiability(liability.id));
        container.querySelector('[data-open-property]')?.addEventListener('click', () => {
            document.getElementById('portfolio-liability-view').classList.remove('active');
            PortfolioApp.viewingLiabilityId = null;
            document.getElementById('portfolio-view').classList.add('active');
            PortfolioApp.openPropertyDetail(property.id);
        });
    },

    renderPropertyDetail(property) {
        const container = document.getElementById('portfolio-property-content');
        if (!container) return;

        const esc = AppManager.escapeHtml;
        const money = (v) => this.hv(this.formatMoney(v).replace(/\.\d\d$/, ''));
        const pl = (property.currentValue || 0) - (property.purchasePrice || 0);
        const plPct = property.purchasePrice > 0 ? (pl / property.purchasePrice) * 100 : 0;
        // Debts secured by this property — the mortgage line and the equity
        // that is left after it.
        const secured = PortfolioApp.liabilitiesForProperty(property.id);
        const owed = secured.reduce((s, l) => s + (l.balance || 0), 0);
        const equity = (property.currentValue || 0) - owed;

        const move = property.purchasePrice
            ? `<span class="${this.hvPlClass(pl)}">${this.hv(this.formatPL(pl).replace(/\.\d\d$/, ''))} (${Math.abs(plPct).toFixed(1)}%)</span> since you bought it`
            : '';
        const bought = [property.purchasePrice ? `for ${money(property.purchasePrice)}` : '', property.purchaseDate ? `on ${this.formatDate(property.purchaseDate)}` : '']
            .filter(Boolean).join(' ');
        const facts = [
            ...secured.map(l => this._factRow(esc(PortfolioApp.liabilityTypeLabel(l.type)), `−${money(l.balance)}`, `data-liability-id="${esc(l.id)}"`)),
            secured.length ? this._factRow('Equity', `<span class="${this.hvPlClass(equity)}">${money(equity)}</span>`) : ''
        ].filter(Boolean);

        container.innerHTML = `
            ${property.address ? `<p class="pf-lede">${esc(property.address)}</p>` : ''}
            <div class="pf-detail-mast">
                <div class="portfolio-masthead-value">${this.moneyHero(property.currentValue || 0)}</div>
                ${move ? `<div class="pf-moves">${move}</div>` : ''}
                ${bought ? `<div class="pf-composition">Bought ${bought}</div>` : ''}
            </div>
            ${facts.length ? `<div class="pf-group">${facts.join('')}</div>` : ''}
            ${this._notesHtml(property.notes)}
            ${this._footLinksHtml('portfolio-property')}
        `;

        document.getElementById('portfolio-property-edit-btn')?.addEventListener('click', () => PortfolioApp.showEditPropertyModal(property.id));
        document.getElementById('portfolio-property-delete-btn')?.addEventListener('click', () => PortfolioApp.deleteProperty(property.id));
        container.querySelectorAll('[data-liability-id]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.getElementById('portfolio-property-view').classList.remove('active');
                PortfolioApp.viewingPropertyId = null;
                document.getElementById('portfolio-view').classList.add('active');
                PortfolioApp.openLiabilityDetail(btn.dataset.liabilityId);
            });
        });
    },

    /**
     * The ticker detail's Price History chart: real market data for the
     * selected range, drawn when the fetch lands. Falls back to the app's
     * own tracked snapshots (the pre-2026-08-21 chart) when Yahoo is
     * unreachable, saying so — an offline chart wearing live clothes would
     * be a lie.
     */
    async loadTickerPriceChart(ticker, tickerHistory) {
        const el = document.getElementById('portfolio-ticker-price-chart');
        if (!el) return;
        el.style.display = '';
        el.innerHTML = '<p class="portfolio-chart-sparse">Loading price history&hellip;</p>';

        const range = PortfolioApp.tickerChartRange || '1y';
        const hist = await PortfolioApp.getMarketHistory(ticker, range);

        // The page may have moved on while the fetch was in flight — a
        // different ticker, a different range, or a full re-render that
        // replaced this container.
        if (PortfolioApp.viewingTicker !== ticker) return;
        if ((PortfolioApp.tickerChartRange || '1y') !== range) return;
        if (document.getElementById('portfolio-ticker-price-chart') !== el) return;

        if (hist && hist.length >= 2) {
            // Market prices are public data — never hv-masked.
            this.renderDetailChart('portfolio-ticker-price-chart', hist, 'price', false);
            return;
        }
        if (tickerHistory && tickerHistory.length >= 2) {
            this.renderDetailChart('portfolio-ticker-price-chart', tickerHistory, 'price', false);
            el.insertAdjacentHTML('beforeend',
                '<p class="portfolio-chart-note">Market history unavailable &mdash; showing prices tracked since this position was added.</p>');
            return;
        }
        el.innerHTML = '<p class="portfolio-chart-sparse">Price history unavailable.</p>';
    },

    // ---- Detail Charts (ticker price/value, account value) ----

    renderDetailChart(containerId, history, valueKey, hideValues) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (!history || history.length < 2) {
            container.innerHTML = '';
            container.style.display = 'none';
            return;
        }

        container.style.display = '';
        const width = container.clientWidth || 600;
        const height = 160;
        const padding = { top: 16, right: 16, bottom: 28, left: hideValues ? 16 : 64 };

        const values = history.map(s => s[valueKey]);
        const minVal = Math.min(...values);
        const maxVal = Math.max(...values);
        const range = maxVal - minVal || 1;

        const chartW = width - padding.left - padding.right;
        const chartH = height - padding.top - padding.bottom;

        const toX = (i) => padding.left + (i / (history.length - 1)) * chartW;
        const toY = (v) => padding.top + chartH - ((v - minVal) / range) * chartH;

        const first = values[0];
        const last = values[values.length - 1];
        const isUp = last >= first;
        const lineColor = isUp ? '#16a34a' : '#dc2626';
        const fillColor = isUp ? 'rgba(22, 163, 74, 0.08)' : 'rgba(220, 38, 38, 0.08)';

        let pathD = `M ${toX(0)} ${toY(values[0])}`;
        for (let i = 1; i < values.length; i++) {
            pathD += ` L ${toX(i)} ${toY(values[i])}`;
        }
        let areaD = pathD + ` L ${toX(values.length - 1)} ${padding.top + chartH} L ${toX(0)} ${padding.top + chartH} Z`;

        // Y-axis
        let yLabelsHtml = '';
        if (!hideValues) {
            const yTicks = 4;
            for (let i = 0; i <= yTicks; i++) {
                const val = minVal + (range * i / yTicks);
                const y = toY(val);
                const label = val >= 1000000 ? `$${(val / 1000000).toFixed(1)}M` :
                              val >= 1000 ? `$${(val / 1000).toFixed(0)}K` :
                              `$${val.toFixed(0)}`;
                yLabelsHtml += `<text x="${padding.left - 8}" y="${y + 4}" text-anchor="end" class="portfolio-chart-label">${label}</text>`;
                yLabelsHtml += `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" class="portfolio-chart-grid"/>`;
            }
        }

        // X-axis. Windows longer than about a year label month+year — six
        // bare "Aug 21"-style labels across five years say nothing.
        const spanMs = new Date(history[history.length - 1].date + 'T00:00:00') - new Date(history[0].date + 'T00:00:00');
        const xFmt = spanMs > 370 * 86400000
            ? { month: 'short', year: '2-digit' }
            : { month: 'short', day: 'numeric' };
        let xLabelsHtml = '';
        const maxXLabels = Math.min(6, history.length);
        const step = Math.max(1, Math.floor((history.length - 1) / (maxXLabels - 1)));
        let lastLabelIdx = 0;
        for (let i = 0; i < history.length; i += step) {
            const x = toX(i);
            const d = new Date(history[i].date + 'T00:00:00');
            const label = d.toLocaleDateString('en-US', xFmt);
            xLabelsHtml += `<text x="${x}" y="${height - 4}" text-anchor="middle" class="portfolio-chart-label">${label}</text>`;
            lastLabelIdx = i;
        }
        // Tail label only when it sits clear of the last stepped one — a
        // 252-point daily series otherwise prints two dates on top of each
        // other at the right edge.
        if (history.length - 1 - lastLabelIdx >= step / 2) {
            const x = toX(history.length - 1);
            const d = new Date(history[history.length - 1].date + 'T00:00:00');
            const label = d.toLocaleDateString('en-US', xFmt);
            xLabelsHtml += `<text x="${x}" y="${height - 4}" text-anchor="middle" class="portfolio-chart-label">${label}</text>`;
        }

        // Hover dots
        let dotsHtml = '';
        for (let i = 0; i < values.length; i++) {
            dotsHtml += `<circle cx="${toX(i)}" cy="${toY(values[i])}" r="12" fill="transparent" class="portfolio-chart-hover-dot" data-idx="${i}"/>`;
            dotsHtml += `<circle cx="${toX(i)}" cy="${toY(values[i])}" r="3" fill="${lineColor}" opacity="0" class="portfolio-chart-dot" data-idx="${i}"/>`;
        }

        container.innerHTML = `
            <svg width="${width}" height="${height}" class="portfolio-chart-svg">
                ${yLabelsHtml}
                ${xLabelsHtml}
                <path d="${areaD}" fill="${fillColor}"/>
                <path d="${pathD}" fill="none" stroke="${lineColor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
                ${dotsHtml}
            </svg>
            <div class="portfolio-chart-tooltip" style="display:none;"></div>
        `;

        // Hover interaction
        const svg = container.querySelector('svg');
        const tooltip = container.querySelector('.portfolio-chart-tooltip');
        const allDots = container.querySelectorAll('.portfolio-chart-dot');

        svg.addEventListener('mousemove', (e) => {
            const rect = svg.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;

            let nearest = 0;
            let nearestDist = Infinity;
            for (let i = 0; i < values.length; i++) {
                const dist = Math.abs(toX(i) - mouseX);
                if (dist < nearestDist) {
                    nearestDist = dist;
                    nearest = i;
                }
            }

            allDots.forEach(d => d.setAttribute('opacity', '0'));
            const activeDot = container.querySelector(`.portfolio-chart-dot[data-idx="${nearest}"]`);
            if (activeDot) activeDot.setAttribute('opacity', '1');
            const cross = container.querySelector('#portfolio-chart-cross');
            if (cross) { cross.setAttribute('x1', toX(nearest)); cross.setAttribute('x2', toX(nearest)); cross.setAttribute('opacity', '1'); }

            const entry = history[nearest];
            const d = new Date(entry.date + 'T00:00:00');
            const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            const valStr = hideValues ? '••••' : this.formatMoney(entry[valueKey]);
            const changeFromFirst = entry[valueKey] - first;
            const changePct = first > 0 ? (changeFromFirst / first) * 100 : 0;
            const changeStr = hideValues ? '' : ` <span class="${this.plClass(changeFromFirst)}">${this.formatPL(changeFromFirst)} (${this.formatPercent(changePct)})</span>`;

            tooltip.innerHTML = `<strong>${dateStr}</strong><br>${valStr}${changeStr}`;
            tooltip.style.display = '';

            const tx = toX(nearest);
            const tooltipW = tooltip.offsetWidth;
            let left = tx - tooltipW / 2;
            if (left < 0) left = 0;
            if (left + tooltipW > width) left = width - tooltipW;
            tooltip.style.left = left + 'px';
            tooltip.style.top = '0px';
        });

        svg.addEventListener('mouseleave', () => {
            allDots.forEach(d => d.setAttribute('opacity', '0'));
            tooltip.style.display = 'none';
        });
    },

    // ---- Value History Chart ----

    /** Slice value history down to the selected window ('1m'|'3m'|'1y'|'all'). */
    filterHistoryByRange(history, chartRange) {
        const days = { '1m': 30, '3m': 91, '1y': 365 }[chartRange];
        if (!days) return history;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        return history.filter(s => new Date(s.date + 'T00:00:00') >= cutoff);
    },

    renderValueChart(fullHistory, hideValues) {
        const container = document.getElementById('portfolio-value-chart');
        if (!container) return;

        if (!fullHistory || fullHistory.length < 2) {
            container.innerHTML = '';
            container.style.display = 'none';
            return;
        }

        container.style.display = '';

        const chartRange = PortfolioApp.chartRange || 'all';
        const history = this.filterHistoryByRange(fullHistory, chartRange);

        const rangesHtml = `
            <div class="portfolio-chart-ranges" role="tablist" aria-label="Chart time range">
                ${[['1m', '1M'], ['3m', '3M'], ['1y', '1Y'], ['all', 'All']].map(([id, label]) =>
                    `<button type="button" role="tab" class="portfolio-chart-range-btn ${id === chartRange ? 'is-active' : ''}"
                        data-range="${id}" aria-selected="${id === chartRange}">${label}</button>`).join('')}
            </div>`;
        const bindRanges = () => {
            container.querySelectorAll('.portfolio-chart-range-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    PortfolioApp.chartRange = btn.dataset.range;
                    // Machine-local — a display preference, not portfolio data.
                    try { localStorage.setItem('portfolio-chart-range', btn.dataset.range); } catch (e) { /* ignore */ }
                    this.renderValueChart(fullHistory, hideValues);
                });
            });
        };

        // A window narrower than the history can leave <2 points — keep the
        // pills so the user can widen the range again.
        if (history.length < 2) {
            container.innerHTML = rangesHtml +
                '<p class="portfolio-chart-sparse">Not enough history in this range yet.</p>';
            bindRanges();
            return;
        }
        const width = container.clientWidth || 600;
        const height = 180;
        const padding = { top: 20, right: 16, bottom: 28, left: hideValues ? 16 : 64 };

        const values = history.map(s => s.totalValue);
        const minVal = Math.min(...values);
        const maxVal = Math.max(...values);
        const range = maxVal - minVal || 1;

        const chartW = width - padding.left - padding.right;
        const chartH = height - padding.top - padding.bottom;

        const toX = (i) => padding.left + (i / (history.length - 1)) * chartW;
        const toY = (v) => padding.top + chartH - ((v - minVal) / range) * chartH;

        // Determine color based on overall direction
        const first = values[0];
        const last = values[values.length - 1];
        const isUp = last >= first;
        const lineColor = isUp ? '#16a34a' : '#dc2626';
        const fillColor = isUp ? 'rgba(22, 163, 74, 0.08)' : 'rgba(220, 38, 38, 0.08)';

        // Check dark mode
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        if (isDark) {
            // Adjust fill for dark mode
        }

        // Build SVG path
        let pathD = `M ${toX(0)} ${toY(values[0])}`;
        for (let i = 1; i < values.length; i++) {
            pathD += ` L ${toX(i)} ${toY(values[i])}`;
        }

        // Fill area path
        let areaD = pathD + ` L ${toX(values.length - 1)} ${padding.top + chartH} L ${toX(0)} ${padding.top + chartH} Z`;

        // Y-axis labels
        const yTicks = 4;
        let yLabelsHtml = '';
        // Tick labels with enough precision to differ from each other: a
        // $1.45M–$1.52M range used to print "$1.5M" four times.
        const fmtTick = (val) => {
            const step = range / yTicks;
            if (val >= 1000000) { const d = step >= 100000 ? 1 : step >= 10000 ? 2 : 3; return `$${(val / 1000000).toFixed(d)}M`; }
            if (val >= 1000) { const d = step >= 1000 ? 0 : 1; return `$${(val / 1000).toFixed(d)}K`; }
            return `$${val.toFixed(0)}`;
        };
        if (!hideValues) {
            for (let i = 0; i <= yTicks; i++) {
                const val = minVal + (range * i / yTicks);
                const y = toY(val);
                const label = fmtTick(val);
                yLabelsHtml += `<text x="${padding.left - 8}" y="${y + 4}" text-anchor="end" class="portfolio-chart-label">${label}</text>`;
                yLabelsHtml += `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" class="portfolio-chart-grid"/>`;
            }
        }

        // X-axis labels (show a subset of dates)
        let xLabelsHtml = '';
        const maxXLabels = Math.min(6, history.length);
        const step = Math.max(1, Math.floor((history.length - 1) / (maxXLabels - 1)));
        for (let i = 0; i < history.length; i += step) {
            // The last date always prints below; a regular label within
            // half a step of it would overprint ("Aug 30 Sep 9").
            if (i !== history.length - 1 && history.length - 1 - i < step / 2) continue;
            const x = toX(i);
            const d = new Date(history[i].date + 'T00:00:00');
            const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            xLabelsHtml += `<text x="${x}" y="${height - 4}" text-anchor="middle" class="portfolio-chart-label">${label}</text>`;
        }
        // Always show last date
        if ((history.length - 1) % step !== 0) {
            const x = toX(history.length - 1);
            const d = new Date(history[history.length - 1].date + 'T00:00:00');
            const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            xLabelsHtml += `<text x="${x}" y="${height - 4}" text-anchor="middle" class="portfolio-chart-label">${label}</text>`;
        }

        // Tooltip dots (invisible, activated by hover)
        let dotsHtml = '';
        for (let i = 0; i < values.length; i++) {
            dotsHtml += `<circle cx="${toX(i)}" cy="${toY(values[i])}" r="12" fill="transparent" class="portfolio-chart-hover-dot" data-idx="${i}"/>`;
            dotsHtml += `<circle cx="${toX(i)}" cy="${toY(values[i])}" r="3" fill="${lineColor}" opacity="0" class="portfolio-chart-dot" data-idx="${i}"/>`;
        }

        const gid = `pf-grad-${isUp ? 'up' : 'down'}`;
        container.innerHTML = `
            ${rangesHtml}
            <svg width="${width}" height="${height}" class="portfolio-chart-svg">
                <defs>
                    <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stop-color="${lineColor}" stop-opacity="0.22"/>
                        <stop offset="100%" stop-color="${lineColor}" stop-opacity="0"/>
                    </linearGradient>
                </defs>
                ${yLabelsHtml}
                ${xLabelsHtml}
                <path d="${areaD}" fill="url(#${gid})"/>
                <path d="${pathD}" fill="none" stroke="${lineColor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
                <line id="portfolio-chart-cross" x1="0" x2="0" y1="${padding.top}" y2="${padding.top + chartH}" class="portfolio-chart-cross" opacity="0"/>
                ${dotsHtml}
            </svg>
            <div id="portfolio-chart-tooltip" class="portfolio-chart-tooltip" style="display:none;"></div>
        `;
        bindRanges();

        // Hover interaction
        const svg = container.querySelector('svg');
        const tooltip = container.querySelector('#portfolio-chart-tooltip');
        const allDots = container.querySelectorAll('.portfolio-chart-dot');

        svg.addEventListener('mousemove', (e) => {
            const rect = svg.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;

            // Find nearest data point
            let nearest = 0;
            let nearestDist = Infinity;
            for (let i = 0; i < values.length; i++) {
                const dist = Math.abs(toX(i) - mouseX);
                if (dist < nearestDist) {
                    nearestDist = dist;
                    nearest = i;
                }
            }

            allDots.forEach(d => d.setAttribute('opacity', '0'));
            const activeDot = container.querySelector(`.portfolio-chart-dot[data-idx="${nearest}"]`);
            if (activeDot) activeDot.setAttribute('opacity', '1');
            const cross = container.querySelector('#portfolio-chart-cross');
            if (cross) { cross.setAttribute('x1', toX(nearest)); cross.setAttribute('x2', toX(nearest)); cross.setAttribute('opacity', '1'); }

            const entry = history[nearest];
            const d = new Date(entry.date + 'T00:00:00');
            const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            const valStr = hideValues ? '••••' : this.formatMoney(entry.totalValue);
            const changeFromFirst = entry.totalValue - first;
            const changePct = first > 0 ? (changeFromFirst / first) * 100 : 0;
            const changeStr = hideValues ? '' : ` <span class="${this.plClass(changeFromFirst)}">${this.formatPL(changeFromFirst)} (${this.formatPercent(changePct)})</span>`;

            tooltip.innerHTML = `<strong>${dateStr}</strong><br>${valStr}${changeStr}`;
            tooltip.style.display = '';

            // Position tooltip
            const tx = toX(nearest);
            const tooltipW = tooltip.offsetWidth;
            let left = tx - tooltipW / 2;
            if (left < 0) left = 0;
            if (left + tooltipW > width) left = width - tooltipW;
            tooltip.style.left = left + 'px';
            tooltip.style.top = '0px';
        });

        svg.addEventListener('mouseleave', () => {
            allDots.forEach(d => d.setAttribute('opacity', '0'));
            container.querySelector('#portfolio-chart-cross')?.setAttribute('opacity', '0');
            tooltip.style.display = 'none';
        });
    },

    // ---- Snapshots View ----

    renderSnapshotsChart(history, hideValues) {
        const container = document.getElementById('portfolio-snapshots-chart');
        if (!container) return;

        if (!history || history.length < 2) {
            container.innerHTML = '<p style="padding: 1rem; opacity: 0.5;">Need at least 2 snapshots to show chart.</p>';
            return;
        }

        container.style.display = '';
        const width = container.clientWidth || 600;
        const height = 220;
        const padding = { top: 20, right: 16, bottom: 28, left: hideValues ? 16 : 64 };

        const values = history.map(s => s.totalValue);
        const minVal = Math.min(...values);
        const maxVal = Math.max(...values);
        const range = maxVal - minVal || 1;

        const chartW = width - padding.left - padding.right;
        const chartH = height - padding.top - padding.bottom;

        const toX = (i) => padding.left + (i / (history.length - 1)) * chartW;
        const toY = (v) => padding.top + chartH - ((v - minVal) / range) * chartH;

        const first = values[0];
        const last = values[values.length - 1];
        const isUp = last >= first;
        const lineColor = isUp ? '#16a34a' : '#dc2626';
        const fillColor = isUp ? 'rgba(22, 163, 74, 0.08)' : 'rgba(220, 38, 38, 0.08)';

        let pathD = `M ${toX(0)} ${toY(values[0])}`;
        for (let i = 1; i < values.length; i++) {
            pathD += ` L ${toX(i)} ${toY(values[i])}`;
        }
        let areaD = pathD + ` L ${toX(values.length - 1)} ${padding.top + chartH} L ${toX(0)} ${padding.top + chartH} Z`;

        let yLabelsHtml = '';
        if (!hideValues) {
            const yTicks = 4;
            for (let i = 0; i <= yTicks; i++) {
                const val = minVal + (range * i / yTicks);
                const y = toY(val);
                const label = val >= 1000000 ? `$${(val / 1000000).toFixed(1)}M` :
                              val >= 1000 ? `$${(val / 1000).toFixed(0)}K` :
                              `$${val.toFixed(0)}`;
                yLabelsHtml += `<text x="${padding.left - 8}" y="${y + 4}" text-anchor="end" class="portfolio-chart-label">${label}</text>`;
                yLabelsHtml += `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" class="portfolio-chart-grid"/>`;
            }
        }

        let xLabelsHtml = '';
        const maxXLabels = Math.min(8, history.length);
        const step = Math.max(1, Math.floor((history.length - 1) / (maxXLabels - 1)));
        for (let i = 0; i < history.length; i += step) {
            // The last date always prints below; a regular label within
            // half a step of it would overprint ("Aug 30 Sep 9").
            if (i !== history.length - 1 && history.length - 1 - i < step / 2) continue;
            const x = toX(i);
            const d = new Date(history[i].date + 'T00:00:00');
            const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            xLabelsHtml += `<text x="${x}" y="${height - 4}" text-anchor="middle" class="portfolio-chart-label">${label}</text>`;
        }
        if ((history.length - 1) % step !== 0) {
            const x = toX(history.length - 1);
            const d = new Date(history[history.length - 1].date + 'T00:00:00');
            const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            xLabelsHtml += `<text x="${x}" y="${height - 4}" text-anchor="middle" class="portfolio-chart-label">${label}</text>`;
        }

        let dotsHtml = '';
        for (let i = 0; i < values.length; i++) {
            dotsHtml += `<circle cx="${toX(i)}" cy="${toY(values[i])}" r="4" fill="${lineColor}" class="portfolio-chart-dot" data-idx="${i}"/>`;
        }

        container.innerHTML = `
            <svg width="${width}" height="${height}" class="portfolio-chart-svg">
                ${yLabelsHtml}
                ${xLabelsHtml}
                <path d="${areaD}" fill="${fillColor}"/>
                <path d="${pathD}" fill="none" stroke="${lineColor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
                ${dotsHtml}
            </svg>
        `;
    },

    renderSnapshotsTable(history, hideValues) {
        const container = document.getElementById('portfolio-snapshots-table');
        if (!container) return;

        if (!history || history.length === 0) {
            container.innerHTML = '<p class="pf-empty">No snapshots yet. Take one to start the history.</p>';
            return;
        }

        // Calm pass (2026-10-06): three columns — the day, the total, the
        // move — on one white panel; what the total was made of is the
        // row's tooltip. The latest 30 show; the rest are one tap away.
        const sorted = [...history].sort((a, b) => b.date.localeCompare(a.date));
        const all = this._snapshotsAll === true;
        const shown = all ? sorted : sorted.slice(0, 30);
        const money = (v) => hideValues ? '••••' : this.formatMoney(v).replace(/\.\d\d$/, '');

        const rows = shown.map(snap => {
            const d = new Date(snap.date + 'T00:00:00');
            const dateStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
            const parts = hideValues ? '' : [
                `Investments ${money(snap.stockValue || 0)}`, `Cash ${money(snap.cash || 0)}`,
                snap.realEstateValue ? `Real estate ${money(snap.realEstateValue)}` : '',
                snap.liabilities ? `Debt ${money(snap.liabilities)}` : ''
            ].filter(Boolean).join(' · ');
            // Day-over-day change. The percent survives masking — a
            // relative move doesn't leak balances the way dollars do.
            const prevIdx = history.indexOf(snap) - 1;
            let changeHtml = '';
            if (prevIdx >= 0) {
                const prev = history[prevIdx];
                const change = snap.totalValue - prev.totalValue;
                const changePct = prev.totalValue > 0 ? (change / prev.totalValue) * 100 : 0;
                changeHtml = `<span class="${this.plClass(change)}">${hideValues ? '' : this.formatPL(change).replace(/\.\d\d$/, '') + ' '}(${Math.abs(changePct).toFixed(2)}%)</span>`;
            }
            return `
                <tr title="${AppManager.escapeHtml(parts)}">
                    <td>${dateStr}</td>
                    <td class="num portfolio-cell-strong">${money(snap.totalValue)}</td>
                    <td class="num">${changeHtml}</td>
                    <td class="num pf-snap-x"><button class="snapshot-delete-btn" data-date="${snap.date}" title="Delete this snapshot" aria-label="Delete this snapshot">&times;</button></td>
                </tr>`;
        }).join('');

        container.innerHTML = `
            <div class="pf-table-panel">
            <table class="portfolio-table">
                <thead>
                    <tr><th>Date</th><th class="num">Total value</th><th class="num">Change</th><th></th></tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
            </div>
            ${sorted.length > shown.length ? `<p class="pf-more"><button type="button" class="pf-link" data-snap-all>Show all ${sorted.length}</button></p>` : ''}
        `;

        container.querySelector('[data-snap-all]')?.addEventListener('click', () => {
            this._snapshotsAll = true;
            this.renderSnapshotsTable(history, hideValues);
        });
        container.querySelectorAll('.snapshot-delete-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                PortfolioApp.deleteSnapshot(btn.dataset.date);
            });
        });
    },

    // ---- Dashboard Preview ----

    renderDashboardPreview() {
        const container = document.getElementById('portfolio-preview');
        if (!container) return;

        const holdings = PortfolioApp.computeHoldings();
        const totalCash = PortfolioApp.computeTotalCash();
        const properties = PortfolioApp.properties || [];

        if (holdings.length === 0 && totalCash === 0 && properties.length === 0) {
            container.innerHTML = '<p class="preview-empty">No holdings yet</p>';
            return;
        }

        const summary = PortfolioApp.getSummary(holdings);
        const top3 = holdings.slice(0, 3);

        container.innerHTML = `
            <div class="portfolio-preview-summary">
                <span class="portfolio-preview-value">${this.hv(this.formatMoney(summary.totalValue))}</span>
                <span class="portfolio-preview-pl ${this.hvPlClass(summary.totalPL)}">${this.hv(this.formatPL(summary.totalPL))} (${this.formatPercent(summary.totalPLPercent)})</span>
            </div>
            <ul class="preview-list">
                ${top3.map(h => `
                    <li class="preview-item">
                        <span class="portfolio-preview-ticker">${AppManager.escapeHtml(PortfolioApp.displayTicker(h.ticker))}</span>
                        <span class="portfolio-preview-item-value">${this.hv(this.formatMoney(h.currentValue))}</span>
                    </li>
                `).join('')}
            </ul>
            ${holdings.length > 3 ? `<p class="preview-more">+${holdings.length - 3} more</p>` : ''}
        `;
    },

    // ---- Utility: Refreshing indicator ----

    setRefreshing(isRefreshing) {
        const btn = document.getElementById('portfolio-refresh-btn');
        if (btn) {
            btn.disabled = isRefreshing;
            btn.textContent = isRefreshing ? 'Refreshing...' : 'Refresh Prices';
        }
    },

    // ---- Hide Values Toggle ----

    updateHideValuesBtn(hidden) {
        const btn = document.getElementById('portfolio-toggle-values');
        if (!btn) return;
        // Eye (visible) vs eye-off (masked) — CSS swaps on .is-masked.
        btn.classList.toggle('is-masked', hidden);
        const label = hidden ? 'Show values' : 'Hide values';
        btn.title = label;
        btn.setAttribute('aria-label', label);
    },

    // ---- Formatting helpers ----

    // ── Redesign helpers (2026-09-09): color as data ─────────────────────
    // A ticker's hue is a stable hash into a 12-hue palette, so AAPL is the
    // same color on every row, chart and page; options wear their
    // underlying's hue; cash is green. Account types carry their own hues
    // (--pf-type) on the nav and scope header.
    TICKER_HUES: ['#4F6BED', '#0EA5E9', '#14B8A6', '#65A30D', '#F59E0B', '#F97316', '#EF4444', '#EC4899', '#8B5CF6', '#6366F1', '#0891B2', '#B45309'],
    tickerHue(ticker) {
        const meta = PortfolioApp.optionMeta(ticker);
        const key = String(meta ? meta.underlying : ticker || '').toUpperCase();
        let h = 0;
        for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
        return this.TICKER_HUES[h % this.TICKER_HUES.length];
    },
    /**
     * Monogram tile for a ticker (or 'Cash'). **The portfolio's list views
     * no longer use it (2026-09-15, by request: "it shows the same symbol
     * as the ticker symbol itself")** — holdings, transactions, the cash
     * row and the ticker page lead with the symbol
     * alone. What is left is the home widget's movers strip, where the
     * tile IS the label and there is no symbol beside it.
     */
    tickerMono(ticker, { cash = false } = {}) {
        if (cash) return '<span class="portfolio-mono is-cash" aria-hidden="true">$</span>';
        const meta = PortfolioApp.optionMeta(ticker);
        const text = String(meta ? meta.underlying : ticker || '').replace(/[^A-Za-z0-9]/g, '').slice(0, meta ? 3 : 4).toUpperCase() || '·';
        return `<span class="portfolio-mono${meta ? ' is-option' : ''}${text.length > 3 ? ' is-long' : ''}" style="--pf-hue:${this.tickerHue(ticker)}" aria-hidden="true">${AppManager.escapeHtml(text)}</span>`;
    },
    /** Company name for a ticker when the profile cache knows it (empty otherwise). */
    tickerName(ticker) {
        const meta = PortfolioApp.optionMeta(ticker);
        if (meta) return `${meta.optionType === 'put' ? 'Put' : 'Call'} · ${this.formatMoney(meta.strike)} · ${this.formatDate(meta.expiration)}`;
        const info = PortfolioApp.companyInfoCache?.[ticker];
        return info && !info.error && info.name && info.name !== ticker ? info.name : '';
    },
    /** Big number: whole dollars in the serif, cents small. */
    moneyHero(value) {
        if (PortfolioApp.hideValues) return '••••••';
        const v = Math.abs(Number(value) || 0);
        const whole = Math.floor(v).toLocaleString('en-US');
        const cents = String(Math.round((v - Math.floor(v)) * 100)).padStart(2, '0');
        return `${value < 0 ? '<span class="portfolio-hero-sign">−</span>' : ''}<span class="portfolio-hero-currency">$</span>${whole}<span class="portfolio-hero-cents">.${cents}</span>`;
    },
    /** Compact "+$15,011 · 25.4%" cell text (one line) for tables. */
    plCell(value, pct) {
        if (!isFinite(value)) return '&mdash;';
        const money = this.hv(this.formatPL(value).replace(/\.\d\d$/, ''));
        const p = pct != null && isFinite(pct) ? `<span class="portfolio-cell-pct">${this.formatPercent(pct).replace(/\.\d\d%$/, m => (Math.abs(pct) >= 10 ? m.slice(0, -2) + '%' : m))}</span>` : '';
        return `<span class="portfolio-cell-pl ${this.hvPlClass(value)}">${money}${p}</span>`;
    },
    ACCOUNT_TYPE_ICON(type) {
        const s = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
        switch (type) {
            case 'all': return `<svg viewBox="0 0 24 24" width="14" height="14" ${s}><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`;
            case '401k': case 'ira': case 'roth-ira': return `<svg viewBox="0 0 24 24" width="14" height="14" ${s}><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5h3.75a1.75 1.75 0 0 1 0 3.5H9.5h4a1.75 1.75 0 0 1 0 3.5H9.5"/></svg>`;
            case 'hsa': return `<svg viewBox="0 0 24 24" width="14" height="14" ${s}><path d="M12 21s-7-4.5-7-11a7 7 0 0 1 14 0c0 6.5-7 11-7 11z"/><path d="M12 8v6M9 11h6"/></svg>`;
            case 'savings': return `<svg viewBox="0 0 24 24" width="14" height="14" ${s}><path d="M4 12.5a7 7 0 0 1 7-7h4a5.5 5.5 0 0 1 5.5 5.5v1.5l1.5.5v3l-1.8.6a5.5 5.5 0 0 1-2.2 2.9V21h-3v-1.5h-4V21H8v-2.2A7 7 0 0 1 4 12.5z"/></svg>`;
            case 'checking': return `<svg viewBox="0 0 24 24" width="14" height="14" ${s}><path d="M3 9.5 12 4l9 5.5"/><line x1="4" y1="20" x2="20" y2="20"/><line x1="6" y1="10" x2="6" y2="20"/><line x1="10" y1="10" x2="10" y2="20"/><line x1="14" y1="10" x2="14" y2="20"/><line x1="18" y1="10" x2="18" y2="20"/></svg>`;
            case 'property': return `<svg viewBox="0 0 24 24" width="14" height="14" ${s}><path d="M3 10.5 12 4l9 6.5"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/></svg>`;
            case 'liability': return `<svg viewBox="0 0 24 24" width="14" height="14" ${s}><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/><path d="M7 15h3"/></svg>`;
            case 'strategy': return `<svg viewBox="0 0 24 24" width="14" height="14" ${s}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg>`;
            case 'tickers': return `<svg viewBox="0 0 24 24" width="14" height="14" ${s}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15.5l3-3.5 2.5 2 4.5-5"/></svg>`;
            default: return `<svg viewBox="0 0 24 24" width="14" height="14" ${s}><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>`;
        }
    },

    formatMoney(value) {
        if (value === 0 || value === undefined || value === null) return '$0.00';
        const abs = '$' + Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        // A negative balance (e.g. cash overdrawn by a buy) must read as
        // negative — Math.abs alone silently flipped the sign.
        return value < 0 ? '-' + abs : abs;
    },

    formatPL(value) {
        if (!value) return '$0.00';
        const sign = value >= 0 ? '+' : '-';
        return sign + '$' + Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },

    formatPercent(value) {
        if (!value) return '0.00%';
        const sign = value >= 0 ? '+' : '';
        return sign + value.toFixed(2) + '%';
    },

    /** Format a sensitive value (hidden when hideValues is on) */
    hv(formatted) {
        return PortfolioApp.hideValues ? '••••' : formatted;
    },

    formatShares(value) {
        if (Number.isInteger(value)) return value.toString();
        return value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    },

    /** Price cell: interpolated option marks read as estimates (~), and an
     *  extended-session quote gets a small pre/after-hours sub-line —
     *  unless the user turned those off (PortfolioApp.showAfterHours). */
    priceCellHtml(h) {
        if (!h.currentPrice) return '&mdash;';
        const p = this.formatMoney(h.currentPrice);
        let html = h.priceEstimated
            ? `<span class="portfolio-price-estimated" title="Estimated from the adjacent strikes' quotes (no direct market quote for this contract)">~${p}</span>`
            : p;
        if (PortfolioApp.showAfterHours && h.after && h.after.price > 0) {
            const pre = h.after.session === 'pre';
            // Inline, not a block: a second line under the price made every
            // stock row taller than the option rows beside it during extended
            // hours (2026-08-26). The row keeps its shape; the cell gets wider.
            html += ` <span class="portfolio-after-hours is-inline ${this.plClass(h.after.change)}" title="${pre ? 'Pre-market' : 'After-hours'} quote">${pre ? 'Pre' : 'AH'} ${this.formatMoney(h.after.price)} (${this.formatPercent(h.after.changePercent)})</span>`;
        }
        return html;
    },

    /** Ticker cell HTML: friendly contract label + expiry chip for options.
     *  stripUnderlying: inside a symbol cluster the header already names the
     *  underlying, so the option label starts at the strike. */
    tickerCellHtml(h, stripUnderlying = false) {
        if (!h.option) return AppManager.escapeHtml(h.ticker);
        let text = PortfolioApp.displayTicker(h.ticker);
        if (stripUnderlying && text.startsWith(h.option.underlying + ' ')) {
            text = text.slice(h.option.underlying.length + 1);
        }
        const label = AppManager.escapeHtml(text);
        const days = PortfolioApp.optionDaysToExpiry(h.option);
        let chip = '';
        if (days < 0) chip = '<span class="portfolio-opt-expiry is-expired">Expired</span>';
        else if (days === 0) chip = '<span class="portfolio-opt-expiry is-soon">Expires today</span>';
        else if (days <= 7) chip = `<span class="portfolio-opt-expiry is-soon">${days}d left</span>`;
        return label + chip;
    },

    formatDate(dateStr) {
        const d = new Date(dateStr + 'T00:00:00');
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    },

    formatAccountType(type) {
        const map = {
            'brokerage': 'Brokerage',
            '401k': '401(k)',
            'ira': 'IRA',
            'roth-ira': 'Roth IRA',
            'hsa': 'HSA',
            'savings': 'Savings',
            'checking': 'Checking',
            'other': 'Other'
        };
        return map[type] || type;
    },

    plClass(value) {
        if (!value || value === 0) return '';
        return value > 0 ? 'pl-positive' : 'pl-negative';
    },

    /** P&L class that hides color when values are hidden */
    hvPlClass(value) {
        return PortfolioApp.hideValues ? '' : this.plClass(value);
    }
};
