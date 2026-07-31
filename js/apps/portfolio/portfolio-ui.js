/**
 * Portfolio UI
 * Renders holdings table, account sidebar, transaction list, dashboard preview
 */

const PortfolioUI = {

    /**
     * Accounts nav — the left column that scopes the right pane. Reading-
     * surface rows: All Accounts, then one row per account with its quiet
     * value, then + New account.
     */
    renderNav(scope) {
        const nav = document.getElementById('portfolio-nav');
        if (!nav) return;
        const accounts = PortfolioApp.getAccounts();
        const esc = AppManager.escapeHtml;

        const row = (id, name, value, active) => `
            <button type="button" class="portfolio-nav-item${active ? ' is-active' : ''}" data-scope="${esc(id)}">
                <span class="portfolio-nav-name">${esc(name)}</span>
                ${value != null ? `<span class="portfolio-nav-value">${this.hv(this.formatMoney(value))}</span>` : ''}
            </button>`;

        const rows = [row('all', 'All Accounts', null, scope === 'all')];
        for (const a of accounts) {
            const summary = PortfolioApp.getSummary(PortfolioApp.computeHoldings(a.id), a.id);
            rows.push(row(a.id, a.name, summary.totalValue, scope === a.id));
        }
        nav.innerHTML = `
            <div class="portfolio-nav-label">Accounts</div>
            ${rows.join('')}
            <button type="button" class="portfolio-nav-item portfolio-nav-new" data-new-account>+ New account</button>
        `;

        nav.querySelectorAll('[data-scope]').forEach(btn =>
            btn.addEventListener('click', () => PortfolioApp.setScope(btn.dataset.scope)));
        nav.querySelector('[data-new-account]')?.addEventListener('click', () => PortfolioApp.showCreateAccountModal());
    },

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
        }
        for (const id of ['portfolio-account-cash-btn', 'portfolio-account-edit-btn', 'portfolio-account-delete-btn']) {
            const btn = document.getElementById(id);
            if (btn) btn.hidden = !account;
        }
    },

    /** Holdings / Transactions tab strip (both scopes). */
    renderTabs(currentView) {
        document.getElementById('portfolio-holdings-tab')?.classList.toggle('active', currentView === 'holdings');
        document.getElementById('portfolio-txns-tab')?.classList.toggle('active', currentView === 'transactions');
    },

    /** First-run: no accounts yet — the sidebar that used to carry the
     *  New Account button is gone, so the empty state offers it. */
    renderNoAccountsState() {
        const container = document.getElementById('portfolio-holdings');
        if (!container) return;
        container.innerHTML = `
            <div class="empty-state">
                <span class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg></span>
                <h3>No accounts yet</h3>
                <p>Create an account (brokerage, 401k, IRA&hellip;) to start tracking.</p>
                <button id="portfolio-empty-create-btn" class="primary-btn" style="margin-top: var(--space-md);">+ New Account</button>
            </div>
        `;
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
            el.classList.remove('stale');
            return;
        }
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
     * The one strategy trace left in the UI: a single quiet line — name and
     * objective — that hands the conversation to the assistant. All strategy
     * analysis (drift, adherence, the interview) lives in the agent; this
     * line only says a plan exists and opens the door.
     */
    renderStrategyLine(containerId, show = true) {
        const container = document.getElementById(containerId);
        if (!container) return;
        const hide = () => { container.innerHTML = ''; container.style.display = 'none'; };
        if (!show) { hide(); return; }

        const hasAssistant = typeof AgentUI !== 'undefined';
        const hasEngine = typeof PortfolioStrategy !== 'undefined';
        const hasHoldings = PortfolioApp.computeHoldings().length > 0;
        if (!hasAssistant || !hasEngine) { hide(); return; }

        const strategy = PortfolioStrategy.getDefault();
        if (!strategy && !hasHoldings) { hide(); return; }

        const esc = AppManager.escapeHtml;
        let html, prompt;
        if (!strategy) {
            html = `<span class="portfolio-strategy-line-hint">No strategy yet. Build one with Anjadhe</span>`;
            prompt = 'Help me build an investment strategy for my portfolio. ' +
                'I am not sure what a strategy needs to cover, so please walk me through it one question at a time.';
        } else if ((strategy.status || 'active') === 'draft') {
            html = `<span class="portfolio-strategy-line-name">${esc(strategy.name)}</span>
                <span class="portfolio-strategy-line-objective">Unfinished. Pick it up with Anjadhe</span>`;
            prompt = `Let's carry on building my investment strategy "${strategy.name}". ` +
                'Check what is still missing and ask me the next question.';
        } else {
            html = `<span class="portfolio-strategy-line-name">${esc(strategy.name)}</span>
                ${strategy.objective ? `<span class="portfolio-strategy-line-objective">${esc(strategy.objective)}</span>` : ''}`;
            prompt = `Am I still following my strategy "${strategy.name}"? Check my actual holdings against it.`;
        }

        container.style.display = '';
        container.innerHTML = `
            <button type="button" class="portfolio-strategy-line" title="Discuss with the assistant">
                ${html}<span class="portfolio-strategy-line-arrow">&rarr;</span>
            </button>
        `;
        container.querySelector('.portfolio-strategy-line').addEventListener('click', () => {
            AgentUI.askWithPrompt(prompt, { newChat: true });
        });
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
    },

    /**
     * Masthead: one big number with a quiet baseline of stats under it —
     * the home-page treatment (serif greeting over a hairline) applied to
     * money. Used by the main view and account detail alike.
     */
    mastheadHtml(summary) {
        const stats = [];
        stats.push(`<span class="${this.hvPlClass(summary.totalDayChange)}">${this.hv(this.formatPL(summary.totalDayChange))} today</span>`);
        stats.push(`<span class="${this.hvPlClass(summary.totalPL)}">${this.hv(this.formatPL(summary.totalPL))} (${this.formatPercent(summary.totalPLPercent)}) all time</span>`);
        if (summary.cash) {
            stats.push(`<span class="portfolio-masthead-quiet">${this.hv(this.formatMoney(summary.cash))} cash</span>`);
        }
        if (summary.realEstateValue) {
            stats.push(`<span class="portfolio-masthead-quiet">${this.hv(this.formatMoney(summary.realEstateValue))} real estate</span>`);
        }
        return `
            <div class="portfolio-masthead-value">${this.hv(this.formatMoney(summary.totalValue))}</div>
            <div class="portfolio-masthead-stats">${stats.join('<span class="portfolio-masthead-sep">&middot;</span>')}</div>
            ${this.afterLineHtml(summary.afterSession, summary.afterChange, summary.afterBase)}
        `;
    },

    /** Extended-session sub-line ("AH +$120 (+0.4%)"); '' when no quote.
     *  Also '' when the user turned extended-session prices off
     *  (PortfolioApp.toggleAfterHours) — gating here rather than at each
     *  call site means the summary bar and every cluster header obey the
     *  setting, and so will anything added later that uses this helper. */
    afterLineHtml(session, change, base) {
        if (!PortfolioApp.showAfterHours) return '';
        if (!session || !base) return '';
        const pct = (change / base) * 100;
        const pre = session === 'pre';
        return `<div class="portfolio-after-hours ${this.hvPlClass(change)}" title="${pre ? 'Pre-market' : 'After-hours'} move">${pre ? 'Pre' : 'AH'} ${this.hv(this.formatPL(change))} (${this.formatPercent(pct)})</div>`;
    },

    /**
     * Build a sortable table header. One builder for every sortable table;
     * scope names the PortfolioApp.sort entry it reads and toggles.
     */
    buildSortableHeader(scope, label, col, isNum) {
        const s = PortfolioApp.sort[scope];
        const isActive = s.col === col;
        const arrow = isActive ? (s.dir === 'asc' ? '▲' : '▼') : '▲';
        const classes = ['sortable-th'];
        if (isNum) classes.push('num');
        if (isActive) classes.push('sort-active');
        return `<th class="${classes.join(' ')}" data-sort-scope="${scope}" data-col="${col}">${label}<span class="sort-arrow">${arrow}</span></th>`;
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

    /** One holding row. */
    holdingRowHtml(h, totalValue) {
        const weight = totalValue > 0 ? (h.currentValue / totalValue) * 100 : 0;
        return `
            <tr class="portfolio-row" data-ticker="${h.ticker}">
                <td class="portfolio-ticker">${this.tickerCellHtml(h)}</td>
                <td class="num">${this.formatShares(h.totalShares)}</td>
                <td class="num">${this.formatMoney(h.avgCostBasis)}</td>
                <td class="num">${this.priceCellHtml(h)}</td>
                <td class="num">${h.currentPrice ? this.hv(this.formatMoney(h.currentValue)) : '&mdash;'}</td>
                <td class="num">${h.currentPrice ? this.formatPercent(weight) : '&mdash;'}</td>
                <td class="num ${this.hvPlClass(h.profitLoss)}">${h.currentPrice ? `${this.hv(this.formatPL(h.profitLoss))} (${this.formatPercent(h.profitLossPercent)})` : '&mdash;'}</td>
                <td class="num ${this.hvPlClass(h.dayChange)}">${h.currentPrice ? `${this.hv(this.formatPL(h.dayChange))} (${this.formatPercent(h.dayChangePercent)})` : '&mdash;'}</td>
            </tr>
        `;
    },

    renderHoldingsTable(holdings, containerId = 'portfolio-holdings', cashOverride = null) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (holdings.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <span class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="20" x2="20" y2="20"/><line x1="7" y1="20" x2="7" y2="12"/><line x1="12" y1="20" x2="12" y2="7"/><line x1="17" y1="20" x2="17" y2="10"/></svg></span>
                    <h3>No holdings yet</h3>
                    <p>Add a transaction, or enter a holding you already own</p>
                </div>
            `;
            return;
        }

        const cash = cashOverride !== null ? cashOverride : PortfolioApp.computeTotalCash();
        const totalValue = holdings.reduce((s, h) => s + h.currentValue, 0) + cash;

        container.innerHTML = `
            <table class="portfolio-table">
                <thead>
                    <tr>
                        ${this.buildSortableHeader('holdings', 'Ticker', 'ticker', false)}
                        ${this.buildSortableHeader('holdings', 'Shares', 'totalShares', true)}
                        ${this.buildSortableHeader('holdings', 'Avg Cost', 'avgCostBasis', true)}
                        ${this.buildSortableHeader('holdings', 'Price', 'currentPrice', true)}
                        ${this.buildSortableHeader('holdings', 'Value', 'currentValue', true)}
                        <th class="num">Weight</th>
                        ${this.buildSortableHeader('holdings', 'P&L', 'profitLoss', true)}
                        ${this.buildSortableHeader('holdings', 'Day', 'dayChange', true)}
                    </tr>
                </thead>
                <tbody>
                    ${this.holdingsRowsHtml(holdings, totalValue)}
                    ${this.renderCashRow(cash, totalValue)}
                </tbody>
            </table>
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
     * Linked notes — cross-app note links (LinkManager) for the whole
     * portfolio (itemId 'overview') or a single account. This section lists
     * them, opens them on click, and offers "+ New Note" (pre-linked) /
     * "+ Link Note" (picker).
     *
     * Labelled "Notes", NOT "Strategy Notes": the Strategy feature
     * (PortfolioStrategy) now owns that word, and two unrelated things
     * called strategy on the same page is worse than a duller label. Free
     * research and reading still belongs here.
     */
    renderNotesSection(containerId, itemId, onChanged) {
        const el = document.getElementById(containerId);
        if (!el || typeof LinkedItemsUI === 'undefined') return;
        el.innerHTML = LinkedItemsUI.renderAll('portfolio', itemId, {
            sections: [
                { targetApp: 'notes', label: 'Notes', buttonLabel: '+ Link Note' }
            ]
        });
        LinkedItemsUI.attachListeners(el, onChanged);
    },

    /**
     * Render transaction list
     */
    renderTransactionList(transactions, container) {
        if (transactions.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <span class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg></span>
                    <h3>No transactions yet</h3>
                    <p>Add a buy or sell transaction</p>
                </div>
            `;
            return;
        }

        container.innerHTML = `
            <div class="portfolio-txn-list">
                ${transactions.map(txn => {
                    const account = PortfolioApp.accounts.find(a => a.id === txn.accountId);
                    return `
                        <div class="portfolio-txn-item" data-txn-id="${txn.id}">
                            <div class="portfolio-txn-left">
                                <span class="portfolio-txn-type ${txn.type}">${txn.type.toUpperCase()}</span>
                                <span class="portfolio-txn-ticker">${AppManager.escapeHtml(PortfolioApp.displayTicker(txn.ticker))}</span>
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

        // Click to edit
        container.querySelectorAll('.portfolio-txn-item').forEach(item => {
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
                useBtn.textContent = 'Use current price';
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
        if (qtyLabel) qtyLabel.textContent = isOption ? 'Quantity (Contracts)' : 'Quantity (Shares)';
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
                ? (type === 'holding' ? 'Avg Premium Per Share' : 'Premium Per Share')
                : (type === 'holding' ? 'Avg Cost Per Share' : 'Price Per Share');
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

    renderTickerDetail(ticker, holding, byAccount, companyInfo, priceData, tickerHistory, hideValues) {
        const container = document.getElementById('portfolio-ticker-content');
        if (!container) return;

        const allHoldings = PortfolioApp.computeHoldings();
        const portfolioTotal = allHoldings.reduce((s, h) => s + h.currentValue, 0) + PortfolioApp.computeTotalCash();
        let html = '';

        // Option contract card (options have no company profile to fetch)
        const optMeta = PortfolioApp.optionMeta(ticker);
        if (optMeta) {
            const days = PortfolioApp.optionDaysToExpiry(optMeta);
            const expiryNote = days < 0 ? 'Expired'
                : days === 0 ? 'Expires today'
                : `${days} day${days === 1 ? '' : 's'} to expiration`;
            html += '<div class="portfolio-company-card">';
            html += `<h3 class="portfolio-company-name">${AppManager.escapeHtml(PortfolioApp.displayTicker(ticker))}</h3>`;
            html += `<div class="portfolio-company-meta">
                <span>${optMeta.optionType === 'put' ? 'Put' : 'Call'} option on ${AppManager.escapeHtml(optMeta.underlying)}</span>
                <span>Strike ${this.formatMoney(optMeta.strike)}</span>
                <span>Expires ${this.formatDate(optMeta.expiration)}</span>
                <span>${expiryNote}</span>
                <span>1 contract = 100 shares</span>
            </div>`;
            html += '</div>';
        } else if (!companyInfo) {
            html += '<div class="portfolio-company-loading">Loading company info...</div>';
        } else if (companyInfo.error) {
            html += '<div class="portfolio-company-loading">Company info unavailable</div>';
        } else {
            html += '<div class="portfolio-company-card">';
            html += `<h3 class="portfolio-company-name">${AppManager.escapeHtml(companyInfo.name)}</h3>`;

            const metaParts = [];
            if (companyInfo.sector) metaParts.push(`<span>${AppManager.escapeHtml(companyInfo.sector)}</span>`);
            if (companyInfo.industry) metaParts.push(`<span>${AppManager.escapeHtml(companyInfo.industry)}</span>`);
            if (companyInfo.country) metaParts.push(`<span>${AppManager.escapeHtml(companyInfo.country)}</span>`);
            if (companyInfo.employees) metaParts.push(`<span>${companyInfo.employees.toLocaleString()} employees</span>`);
            if (metaParts.length > 0) {
                html += `<div class="portfolio-company-meta">${metaParts.join('')}</div>`;
            }

            if (companyInfo.description) {
                html += `<p class="portfolio-company-description">${AppManager.escapeHtml(companyInfo.description)}</p>`;
            }
            if (companyInfo.website) {
                // M11: scheme-validate the remote (Yahoo) website URL before it
                // becomes an href; rel=noopener since target=_blank.
                const site = UIUtils.safeHref(companyInfo.website);
                html += `<a class="portfolio-company-website" href="${AppManager.escapeHtml(site)}" target="_blank" rel="noopener noreferrer">${AppManager.escapeHtml(companyInfo.website)}</a>`;
            }
            html += '</div>';
        }

        // Price summary bar
        if (holding) {
            html += `
                <div class="portfolio-summary">
                    <div class="portfolio-summary-item">
                        <span class="portfolio-summary-label">Price</span>
                        <span class="portfolio-summary-value">${this.priceCellHtml(holding)}</span>
                    </div>
                    <div class="portfolio-summary-item">
                        <span class="portfolio-summary-label">Total Value</span>
                        <span class="portfolio-summary-value">${this.hv(this.formatMoney(holding.currentValue))}</span>
                    </div>
                    <div class="portfolio-summary-item">
                        <span class="portfolio-summary-label">P&L</span>
                        <span class="portfolio-summary-value ${this.hvPlClass(holding.profitLoss)}">${this.hv(this.formatPL(holding.profitLoss))} (${this.formatPercent(holding.profitLossPercent)})</span>
                    </div>
                    <div class="portfolio-summary-item">
                        <span class="portfolio-summary-label">Day Change</span>
                        <span class="portfolio-summary-value ${this.hvPlClass(holding.dayChange)}">${this.hv(this.formatPL(holding.dayChange))} (${this.formatPercent(holding.dayChangePercent)})</span>
                    </div>
                    <div class="portfolio-summary-item">
                        <span class="portfolio-summary-label">Portfolio Weight</span>
                        <span class="portfolio-summary-value">${portfolioTotal > 0 ? this.formatPercent((holding.currentValue / portfolioTotal) * 100) : '—'}</span>
                    </div>
                </div>
            `;
        }

        // History charts
        if (tickerHistory && tickerHistory.length >= 2) {
            html += '<h4 class="portfolio-ticker-section-title">Price History</h4>';
            html += '<div id="portfolio-ticker-price-chart" class="portfolio-detail-chart"></div>';
            html += '<h4 class="portfolio-ticker-section-title">Value History</h4>';
            html += '<div id="portfolio-ticker-value-chart" class="portfolio-detail-chart"></div>';
        }

        // Holdings by account table
        if (byAccount.length > 0) {
            html += '<h4 class="portfolio-ticker-section-title">Holdings by Account</h4>';
            html += `
                <table class="portfolio-table">
                    <thead>
                        <tr>
                            <th>Account</th>
                            <th class="num">Type</th>
                            <th class="num">Shares</th>
                            <th class="num">Avg Cost</th>
                            <th class="num">Cost Basis</th>
                            <th class="num">Value</th>
                            <th class="num">Acct Weight</th>
                            <th class="num">P&L</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${byAccount.map(h => {
                            const acctSummary = PortfolioApp.getSummary(PortfolioApp.computeHoldings(h.account.id), h.account.id);
                            const acctWeight = acctSummary.totalValue > 0 ? (h.currentValue / acctSummary.totalValue) * 100 : 0;
                            return `
                            <tr>
                                <td>${AppManager.escapeHtml(h.account.name)}</td>
                                <td class="num">${this.formatAccountType(h.account.type)}</td>
                                <td class="num">${this.formatShares(h.totalShares)}</td>
                                <td class="num">${this.formatMoney(h.avgCostBasis)}</td>
                                <td class="num">${this.hv(this.formatMoney(h.costBasis))}</td>
                                <td class="num">${h.currentPrice ? this.hv(this.formatMoney(h.currentValue)) : '—'}</td>
                                <td class="num">${h.currentPrice ? this.formatPercent(acctWeight) : '—'}</td>
                                <td class="num ${this.hvPlClass(h.profitLoss)}">${h.currentPrice ? `${this.hv(this.formatPL(h.profitLoss))} (${this.formatPercent(h.profitLossPercent)})` : '—'}</td>
                            </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            `;
        }

        container.innerHTML = html;

        // Render charts after DOM insertion
        if (tickerHistory && tickerHistory.length >= 2) {
            this.renderDetailChart('portfolio-ticker-price-chart', tickerHistory, 'price', hideValues);
            this.renderDetailChart('portfolio-ticker-value-chart', tickerHistory, 'value', hideValues);
        }
    },

    /**
     * Render a cash line item row for the holdings table
     */
    renderCashRow(cash, totalValue) {
        if (!cash) return '';
        const weight = totalValue > 0 ? (cash / totalValue) * 100 : 0;
        return `
            <tr class="portfolio-cash-row portfolio-row" data-cash="true">
                <td class="portfolio-ticker">Cash</td>
                <td class="num">—</td>
                <td class="num">—</td>
                <td class="num">—</td>
                <td class="num">${this.hv(this.formatMoney(cash))}</td>
                <td class="num">${this.formatPercent(weight)}</td>
                <td class="num">—</td>
                <td class="num">—</td>
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

        let html = `
            <div class="portfolio-summary">
                <div class="portfolio-summary-item">
                    <span class="portfolio-summary-label">Total Cash</span>
                    <span class="portfolio-summary-value">${this.hv(this.formatMoney(totalCash))}</span>
                </div>
            </div>
        `;

        if (accountsWithCash.length > 0) {
            html += '<h4 class="portfolio-ticker-section-title">Cash by Account</h4>';
            html += `
                <table class="portfolio-table">
                    <thead>
                        <tr>
                            ${this.buildSortableHeader('cash', 'Account', 'name', false)}
                            ${this.buildSortableHeader('cash', 'Type', 'type', false)}
                            ${this.buildSortableHeader('cash', 'Balance', 'cash', true)}
                        </tr>
                    </thead>
                    <tbody>
                        ${accountsWithCash.map(a => `
                            <tr>
                                <td>${AppManager.escapeHtml(a.account.name)}</td>
                                <td class="num">${this.formatAccountType(a.account.type)}</td>
                                <td class="num">${this.hv(this.formatMoney(a.cash))}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            `;
        } else {
            html += `
                <div class="empty-state">
                    <h3>No cash balances</h3>
                    <p>Add cash to an account to see it here</p>
                </div>
            `;
        }

        container.innerHTML = html;
        this.attachSortListener(container);
    },

    // ---- Properties Section ----

    renderPropertiesSection(properties) {
        const container = document.getElementById('portfolio-holdings');
        if (!container || !properties || properties.length === 0) return;

        const sorted = PortfolioApp.sortProperties(properties);

        let html = `
            <div class="portfolio-properties-section">
                <h4 class="portfolio-ticker-section-title">Real Estate</h4>
                <table class="portfolio-table">
                    <thead>
                        <tr>
                            ${this.buildSortableHeader('properties', 'Name', 'name', false)}
                            ${this.buildSortableHeader('properties', 'Address', 'address', false)}
                            ${this.buildSortableHeader('properties', 'Value', 'currentValue', true)}
                            ${this.buildSortableHeader('properties', 'Purchase Price', 'purchasePrice', true)}
                            ${this.buildSortableHeader('properties', 'P&L', 'profitLoss', true)}
                        </tr>
                    </thead>
                    <tbody>
                        ${sorted.map(p => {
                            const pl = (p.currentValue || 0) - (p.purchasePrice || 0);
                            const plPct = p.purchasePrice > 0 ? (pl / p.purchasePrice) * 100 : 0;
                            const addr = p.address || '';
                            const truncAddr = addr.length > 30 ? addr.substring(0, 30) + '...' : addr;
                            return `
                                <tr class="portfolio-row portfolio-property-row" data-property-id="${p.id}">
                                    <td class="portfolio-ticker">${AppManager.escapeHtml(p.name)}</td>
                                    <td>${AppManager.escapeHtml(truncAddr)}</td>
                                    <td class="num">${this.hv(this.formatMoney(p.currentValue))}</td>
                                    <td class="num">${this.hv(this.formatMoney(p.purchasePrice))}</td>
                                    <td class="num ${this.hvPlClass(pl)}">${p.purchasePrice ? `${this.hv(this.formatPL(pl))} (${this.formatPercent(plPct)})` : '—'}</td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        `;

        container.insertAdjacentHTML('beforeend', html);

        // Sort clicks: scope only the properties table — the holdings table
        // above already attached its own listener this render.
        const section = container.querySelector('.portfolio-properties-section');
        if (section) this.attachSortListener(section);

        // Click row to open property detail
        container.querySelectorAll('.portfolio-property-row').forEach(row => {
            row.addEventListener('click', () => {
                PortfolioApp.openPropertyDetail(row.dataset.propertyId);
            });
        });
    },

    // ---- Property Detail View ----

    renderPropertyDetail(property) {
        const container = document.getElementById('portfolio-property-content');
        if (!container) return;

        const pl = (property.currentValue || 0) - (property.purchasePrice || 0);
        const plPct = property.purchasePrice > 0 ? (pl / property.purchasePrice) * 100 : 0;

        let html = `
            <div class="portfolio-company-card">
                ${property.address ? `<p class="portfolio-company-meta">${AppManager.escapeHtml(property.address)}</p>` : ''}
            </div>

            <div class="portfolio-summary">
                <div class="portfolio-summary-item">
                    <span class="portfolio-summary-label">Current Value</span>
                    <span class="portfolio-summary-value">${this.hv(this.formatMoney(property.currentValue))}</span>
                </div>
                <div class="portfolio-summary-item">
                    <span class="portfolio-summary-label">Purchase Price</span>
                    <span class="portfolio-summary-value">${this.hv(this.formatMoney(property.purchasePrice))}</span>
                </div>
                ${property.purchasePrice ? `
                <div class="portfolio-summary-item">
                    <span class="portfolio-summary-label">P&L</span>
                    <span class="portfolio-summary-value ${this.hvPlClass(pl)}">${this.hv(this.formatPL(pl))} (${this.formatPercent(plPct)})</span>
                </div>
                ` : ''}
                ${property.purchaseDate ? `
                <div class="portfolio-summary-item">
                    <span class="portfolio-summary-label">Purchase Date</span>
                    <span class="portfolio-summary-value">${this.formatDate(property.purchaseDate)}</span>
                </div>
                ` : ''}
            </div>

            ${property.notes ? `
            <div class="portfolio-company-card">
                <h4 class="portfolio-ticker-section-title" style="margin-top: 0;">Notes</h4>
                <p style="font-size: var(--text-sm); color: var(--color-text-secondary); margin: 0; white-space: pre-wrap;">${AppManager.escapeHtml(property.notes)}</p>
            </div>
            ` : ''}

            <div class="portfolio-toolbar" style="margin-top: var(--space-lg);">
                <button class="secondary-btn" id="portfolio-property-edit-btn">Edit</button>
                <button class="secondary-btn" id="portfolio-property-delete-btn">Delete</button>
            </div>
        `;

        container.innerHTML = html;

        // Wire edit/delete buttons
        document.getElementById('portfolio-property-edit-btn')?.addEventListener('click', () => {
            PortfolioApp.showEditPropertyModal(property.id);
        });
        document.getElementById('portfolio-property-delete-btn')?.addEventListener('click', () => {
            PortfolioApp.deleteProperty(property.id);
        });
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

        // X-axis
        let xLabelsHtml = '';
        const maxXLabels = Math.min(6, history.length);
        const step = Math.max(1, Math.floor((history.length - 1) / (maxXLabels - 1)));
        for (let i = 0; i < history.length; i += step) {
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
        if (!hideValues) {
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

        // X-axis labels (show a subset of dates)
        let xLabelsHtml = '';
        const maxXLabels = Math.min(6, history.length);
        const step = Math.max(1, Math.floor((history.length - 1) / (maxXLabels - 1)));
        for (let i = 0; i < history.length; i += step) {
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

        container.innerHTML = `
            ${rangesHtml}
            <svg width="${width}" height="${height}" class="portfolio-chart-svg">
                ${yLabelsHtml}
                ${xLabelsHtml}
                <path d="${areaD}" fill="${fillColor}"/>
                <path d="${pathD}" fill="none" stroke="${lineColor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
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
            container.innerHTML = '<p style="padding: 1rem; opacity: 0.5;">No snapshots yet. Click "Take Snapshot" to record one.</p>';
            return;
        }

        const sorted = [...history].sort((a, b) => b.date.localeCompare(a.date));

        let rows = '';
        sorted.forEach((snap, idx) => {
            const d = new Date(snap.date + 'T00:00:00');
            const dateStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
            const totalVal = hideValues ? '****' : this.formatMoney(snap.totalValue);
            const stockVal = hideValues ? '****' : this.formatMoney(snap.stockValue || 0);
            const cashVal = hideValues ? '****' : this.formatMoney(snap.cash || 0);
            const reVal = hideValues ? '****' : this.formatMoney(snap.realEstateValue || 0);

            // Day-over-day change. The percent survives masking — a
            // relative move doesn't leak balances the way dollars do.
            const prevIdx = history.indexOf(snap) - 1;
            let changeHtml = '—';
            if (prevIdx >= 0) {
                const prev = history[prevIdx];
                const change = snap.totalValue - prev.totalValue;
                const changePct = prev.totalValue > 0 ? (change / prev.totalValue) * 100 : 0;
                changeHtml = hideValues
                    ? `<span class="${this.plClass(change)}">${this.formatPercent(changePct)}</span>`
                    : `<span class="${this.plClass(change)}">${this.formatPL(change)} (${this.formatPercent(changePct)})</span>`;
            }

            rows += `
                <tr>
                    <td>${dateStr}</td>
                    <td class="num">${totalVal}</td>
                    <td class="num">${stockVal}</td>
                    <td class="num">${cashVal}</td>
                    <td class="num">${reVal}</td>
                    <td class="num">${changeHtml}</td>
                    <td><button class="snapshot-delete-btn secondary-btn" data-date="${snap.date}">Delete</button></td>
                </tr>
            `;
        });

        container.innerHTML = `
            <table class="portfolio-table">
                <thead>
                    <tr>
                        <th>Date</th>
                        <th class="num">Total Value</th>
                        <th class="num">Stocks</th>
                        <th class="num">Cash</th>
                        <th class="num">Real Estate</th>
                        <th class="num">Change</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;

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
            html += `<div class="portfolio-after-hours ${this.plClass(h.after.change)}" title="${pre ? 'Pre-market' : 'After-hours'} quote">${pre ? 'Pre' : 'AH'} ${this.formatMoney(h.after.price)} (${this.formatPercent(h.after.changePercent)})</div>`;
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
