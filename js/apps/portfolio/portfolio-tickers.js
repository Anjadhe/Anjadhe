/**
 * Tickers page — every symbol the user has a relationship with, on one
 * sortable, filterable table (scope 'tickers' in the Portfolio left nav,
 * 2026-09-10 by request).
 *
 * The rows are a CONSOLIDATION of two records that already exist: positions
 * (computeHoldings — across every account, or one) and the watchlist. A
 * ticker held in three accounts is one row here; a ticker both held and
 * watched is one row wearing a "Watching" chip. Nothing on this page is
 * stored — it is a view over the holdings arithmetic and the price cache,
 * and a row opens the same ticker detail page the holdings table and the
 * watchlist open.
 *
 * The consolidation, the filter and the sort are pure over plain data
 * (`consolidate` / `filter` / `sort` / `summarize`) and pinned by
 * tests/portfolio-tickers-test.js; `render` is the page over them.
 *
 * Column semantics, because the rows are mixed:
 *   - Shares / Avg cost / Value / Weight / P&L are position numbers, and
 *     read "—" on a watch-only row.
 *   - Day is the position's move for a held row (dollars + percent, the
 *     holdings table's number) and the quote's per-share move for a
 *     watch-only row (the watchlist section's number). Sorting Day sorts
 *     by PERCENT, the one figure comparable across both.
 *   - Weight is the position's share of the scoped book (holdings + cash),
 *     so it agrees with the holdings table at the same scope.
 */
const PortfolioTickers = {

    /** Filter state — a view preference for the session, never stored. */
    _filter: { query: '', source: 'all', kind: 'all', accountId: '' },

    /** Company-name fetches in flight (see _ensureNames). */
    _naming: false,

    // ── Pure: consolidation ──────────────────────────────────────────────

    /**
     * One row per ticker across holdings and the watchlist.
     *
     * @param {object} p
     * @param {Array}  p.holdings   computeHoldings() rows (scoped or not)
     * @param {Array}  p.watchlist  [{ ticker }]
     * @param {object} p.priceCache { TICKER: { price, change, changePercent, estimated, after } }
     * @param {number} [p.totalValue] denominator for Weight (holdings + cash); defaults to the holdings' value
     * @param {function} [p.nameOf]  ticker → company name ('' when unknown)
     * @param {function} [p.labelOf] ticker → display label (options get their friendly form)
     * @param {function} [p.optionMetaOf] ticker → option meta or null
     */
    consolidate({ holdings = [], watchlist = [], priceCache = {}, totalValue = null, nameOf = null, labelOf = null, optionMetaOf = null } = {}) {
        const denom = totalValue != null ? totalValue : holdings.reduce((s, h) => s + (h.currentValue || 0), 0);
        const watched = new Set(watchlist.map(w => String(w.ticker || '').toUpperCase()).filter(Boolean));
        const rows = [];
        const seen = new Set();

        for (const h of holdings) {
            const ticker = h.ticker;
            seen.add(ticker);
            const value = h.currentPrice ? (h.currentValue || 0) : 0;
            rows.push({
                ticker,
                label: labelOf ? labelOf(ticker) : ticker,
                name: nameOf ? (nameOf(ticker) || '') : '',
                option: h.option || (optionMetaOf ? optionMetaOf(ticker) : null),
                held: true,
                watched: watched.has(ticker),
                shares: h.totalShares || 0,
                avgCost: h.avgCostBasis || 0,
                price: h.currentPrice || 0,
                priceEstimated: !!h.priceEstimated,
                after: h.after || null,
                value,
                weight: h.currentPrice && denom > 0 ? (value / denom) * 100 : 0,
                pl: h.currentPrice ? (h.profitLoss || 0) : null,
                plPct: h.currentPrice ? (h.profitLossPercent || 0) : null,
                dayChange: h.currentPrice ? (h.dayChange || 0) : null,
                dayPct: h.currentPrice ? (h.dayChangePercent || 0) : null,
                accounts: Array.isArray(h.accounts) ? [...h.accounts] : [],
                accountCount: Array.isArray(h.accounts) ? h.accounts.length : 0
            });
        }

        for (const t of watched) {
            if (seen.has(t)) continue;
            seen.add(t);
            const c = priceCache[t] || null;
            const price = c?.price || 0;
            rows.push({
                ticker: t,
                label: labelOf ? labelOf(t) : t,
                name: nameOf ? (nameOf(t) || '') : '',
                option: optionMetaOf ? optionMetaOf(t) : null,
                held: false,
                watched: true,
                shares: 0,
                avgCost: null,
                price,
                priceEstimated: !!c?.estimated,
                after: c?.after || null,
                value: null,
                weight: null,
                pl: null,
                plPct: null,
                dayChange: price ? (c?.change || 0) : null,
                dayPct: price ? (c?.changePercent || 0) : null,
                accounts: [],
                accountCount: 0
            });
        }

        return rows;
    },

    // ── Pure: filter ─────────────────────────────────────────────────────

    /**
     * @param {Array} rows   consolidate() output
     * @param {object} f     { query, source: 'all'|'held'|'watch', kind: 'all'|'stocks'|'options', accountId }
     */
    filter(rows, f = {}) {
        const q = String(f.query || '').trim().toLowerCase();
        const source = f.source || 'all';
        const kind = f.kind || 'all';
        const accountId = f.accountId || '';
        return rows.filter(r => {
            if (source === 'held' && !r.held) return false;
            if (source === 'watch' && !r.watched) return false;
            if (kind === 'options' && !r.option) return false;
            if (kind === 'stocks' && r.option) return false;
            if (accountId && !r.accounts.includes(accountId)) return false;
            if (q) {
                const hay = `${r.ticker} ${r.label || ''} ${r.name || ''}`.toLowerCase();
                if (!hay.includes(q)) return false;
            }
            return true;
        });
    },

    // ── Pure: sort ───────────────────────────────────────────────────────

    TEXT_COLS: ['ticker', 'name'],
    /** Column → the row field it sorts on (Day sorts by percent, see above). */
    SORT_FIELD: {
        ticker: 'label', name: 'name', shares: 'shares', avgCost: 'avgCost', price: 'price',
        value: 'value', weight: 'weight', pl: 'pl', day: 'dayPct', accounts: 'accountCount'
    },

    /**
     * Stable sort; rows with no value for the column ("—") sink to the
     * bottom whichever direction is chosen, so a watch-only row never tops
     * a Value sort just because null reads as small.
     */
    sort(rows, { col = 'value', dir = 'desc' } = {}) {
        const field = this.SORT_FIELD[col] || col;
        const text = this.TEXT_COLS.includes(col);
        const sign = dir === 'asc' ? 1 : -1;
        const missing = (v) => v == null || (typeof v === 'number' && !isFinite(v)) || (text && v === '');
        return rows
            .map((r, i) => ({ r, i }))
            .sort((a, b) => {
                const av = a.r[field], bv = b.r[field];
                const am = missing(av), bm = missing(bv);
                if (am && bm) return a.i - b.i;
                if (am) return 1;
                if (bm) return -1;
                const c = text ? String(av).localeCompare(String(bv)) : (av - bv);
                return c !== 0 ? sign * c : a.i - b.i;
            })
            .map(x => x.r);
    },

    // ── Pure: summary ────────────────────────────────────────────────────

    /** Counts and totals for the head line. */
    summarize(rows) {
        const out = { total: rows.length, held: 0, watched: 0, both: 0, options: 0, value: 0, dayChange: 0, pl: 0, accounts: new Set() };
        for (const r of rows) {
            if (r.held) out.held++;
            if (r.watched) out.watched++;
            if (r.held && r.watched) out.both++;
            if (r.option) out.options++;
            if (r.held) {
                out.value += r.value || 0;
                out.dayChange += r.dayChange || 0;
                out.pl += r.pl || 0;
                for (const a of r.accounts) out.accounts.add(a);
            }
        }
        out.accountCount = out.accounts.size;
        delete out.accounts;
        return out;
    },

    // ── Page ─────────────────────────────────────────────────────────────

    hide() {
        const el = document.getElementById('portfolio-tickers-page');
        if (el) el.hidden = true;
        document.querySelector('#portfolio-view .portfolio-main')?.classList.remove('tickers-scope');
    },

    /** Company name for a ticker: the detail cache first, then today's or
     *  any earlier business profile (which carries the name it was written
     *  for), else empty. Options describe themselves. */
    nameOf(ticker) {
        const n = PortfolioUI.tickerName(ticker);
        if (n) return n;
        if (PortfolioApp.optionMeta(ticker)) return '';
        const p = (typeof PortfolioProfile !== 'undefined') ? PortfolioProfile.get(ticker) : null;
        return p?.name && p.name !== ticker ? p.name : '';
    },

    /** The rows for the current filter, consolidated at the account scope
     *  the filter names (an account filter re-scopes the holdings so the
     *  numbers are that account's, and watch-only rows fall away). */
    _rows() {
        const f = this._filter;
        const accountId = f.accountId && PortfolioApp.getAccounts().some(a => a.id === f.accountId) ? f.accountId : '';
        if (accountId !== f.accountId) f.accountId = accountId;
        const holdings = PortfolioApp.computeHoldings(accountId || null);
        const cash = accountId ? PortfolioApp.computeCash(accountId) : PortfolioApp.computeTotalCash();
        const totalValue = holdings.reduce((s, h) => s + (h.currentValue || 0), 0) + cash;
        const all = this.consolidate({
            holdings,
            watchlist: PortfolioApp.getWatchlist(),
            priceCache: PortfolioApp.priceCache,
            totalValue,
            nameOf: (t) => this.nameOf(t),
            labelOf: (t) => PortfolioApp.displayTicker(t),
            optionMetaOf: (t) => PortfolioApp.optionMeta(t)
        });
        return { all, shown: this.sort(this.filter(all, f), PortfolioApp.sort.tickers) };
    },

    render() {
        const el = document.getElementById('portfolio-tickers-page');
        if (!el) return;
        document.querySelector('#portfolio-view .portfolio-main')?.classList.add('tickers-scope');
        el.hidden = false;

        const esc = AppManager.escapeHtml;
        const f = this._filter;
        const accounts = PortfolioApp.getAccounts();
        const { all, shown } = this._rows();
        // The head line counts the whole book, not the filter — it says
        // what the page is; the toolbar's "N of M" says what the filter did.
        const everything = f.accountId ? this.consolidate({
            holdings: PortfolioApp.computeHoldings(),
            watchlist: PortfolioApp.getWatchlist(),
            priceCache: PortfolioApp.priceCache
        }) : all;
        const sum = this.summarize(everything);
        const hasOptions = everything.some(r => r.option);

        const subParts = [];
        subParts.push(`${sum.total} ticker${sum.total === 1 ? '' : 's'}`);
        if (sum.held) subParts.push(`${sum.held} held across ${sum.accountCount} account${sum.accountCount === 1 ? '' : 's'}`);
        if (sum.watched) subParts.push(`${sum.watched} on the watchlist`);
        const sub = sum.total
            ? subParts.join(' · ')
            : 'Every symbol you hold or follow, on one table.';

        const seg = (name, value, label) =>
            `<button type="button" class="tickers-seg-btn${f[name] === value ? ' is-active' : ''}" data-seg="${name}" data-value="${esc(value)}">${label}</button>`;

        el.innerHTML = `
            <header class="tickers-head">
                <div class="tickers-head-main">
                    <h2 class="tickers-title">Tickers</h2>
                    <p class="tickers-sub">${esc(sub)}</p>
                </div>
                <div class="tickers-head-actions">
                    <button type="button" class="secondary-btn tickers-add-btn" data-add-ticker title="Follow a ticker you don't own">+ Add ticker</button>
                </div>
            </header>
            <div class="tickers-toolbar" role="search">
                <label class="tickers-search" title="Filter by ticker or company name">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.5" y2="16.5"/></svg>
                    <input type="search" id="portfolio-tickers-query" placeholder="Filter tickers" value="${esc(f.query)}" autocomplete="off" spellcheck="false" aria-label="Filter by ticker or company name">
                </label>
                <div class="tickers-seg" role="group" aria-label="Source">
                    ${seg('source', 'all', 'All')}${seg('source', 'held', 'Held')}${seg('source', 'watch', 'Watching')}
                </div>
                ${hasOptions ? `<div class="tickers-seg" role="group" aria-label="Kind">
                    ${seg('kind', 'all', 'All')}${seg('kind', 'stocks', 'Stocks &amp; funds')}${seg('kind', 'options', 'Options')}
                </div>` : ''}
                ${accounts.length > 1 ? `<select class="tickers-select" id="portfolio-tickers-account" aria-label="Account">
                    <option value="">All accounts</option>
                    ${accounts.map(a => `<option value="${esc(a.id)}"${f.accountId === a.id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}
                </select>` : ''}
                <span class="tickers-count" id="portfolio-tickers-count"></span>
            </div>
            <div id="portfolio-tickers-table"></div>
        `;

        this._renderTable(shown, all.length);

        el.querySelector('[data-add-ticker]').addEventListener('click', () => PortfolioApp.showWatchlistSearchModal());
        const input = el.querySelector('#portfolio-tickers-query');
        input.addEventListener('input', () => { f.query = input.value; this._refresh(); });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && input.value) { e.stopPropagation(); input.value = ''; f.query = ''; this._refresh(); }
        });
        el.querySelectorAll('[data-seg]').forEach(btn => btn.addEventListener('click', () => {
            const name = btn.dataset.seg;
            if (f[name] === btn.dataset.value) return;
            f[name] = btn.dataset.value;
            el.querySelectorAll(`[data-seg="${name}"]`).forEach(b => b.classList.toggle('is-active', b === btn));
            this._refresh();
        }));
        el.querySelector('#portfolio-tickers-account')?.addEventListener('change', (e) => {
            f.accountId = e.target.value;
            this._refresh();
        });

        this._ensureNames(all);
    },

    /** Filter changed: rebuild the table only, so the search keeps focus. */
    _refresh() {
        const { all, shown } = this._rows();
        this._renderTable(shown, all.length);
    },

    _renderTable(rows, totalCount) {
        const host = document.getElementById('portfolio-tickers-table');
        if (!host) return;
        const esc = AppManager.escapeHtml;
        const count = document.getElementById('portfolio-tickers-count');
        if (count) count.textContent = totalCount ? (rows.length === totalCount ? `${totalCount}` : `${rows.length} of ${totalCount}`) : '';

        if (!totalCount) {
            host.innerHTML = `
                <div class="portfolio-card tickers-card">
                    <div class="empty-state">
                        <span class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg></span>
                        <h3>No tickers yet</h3>
                        <p>Record a holding in an account, or follow a ticker with <b>+ Add ticker</b>.</p>
                    </div>
                </div>`;
            return;
        }

        const th = (label, col, isNum, title) => {
            const html = PortfolioUI.buildSortableHeader('tickers', label, col, isNum);
            return title ? html.replace('<th ', `<th title="${esc(title)}" `) : html;
        };
        const body = rows.length ? rows.map(r => this._rowHtml(r)).join('')
            : '<tr class="tickers-none"><td colspan="8">No tickers match this filter.</td></tr>';

        host.innerHTML = `
            <div class="portfolio-card tickers-card">
            <table class="portfolio-table portfolio-tickers-table">
                <thead>
                    <tr>
                        ${th('Ticker', 'ticker', false)}
                        ${th('Shares', 'shares', true)}
                        ${th('Avg Cost', 'avgCost', true)}
                        ${th('Price', 'price', true)}
                        ${th('Value', 'value', true, 'Position value, with its weight in the scoped book underneath')}
                        ${th('P&amp;L', 'pl', true)}
                        ${th('Day', 'day', true, "Today's move: the position's for a held ticker, the quote's for a watched one. Sorts by percent.")}
                        ${th('Accounts', 'accounts', true)}
                    </tr>
                </thead>
                <tbody>${body}</tbody>
            </table>
            </div>`;

        PortfolioUI.attachSortListener(host);
        host.querySelectorAll('.portfolio-row').forEach(row => {
            row.addEventListener('click', () => PortfolioApp.openTickerDetail(row.dataset.ticker));
        });
    },

    _rowHtml(r) {
        const esc = AppManager.escapeHtml;
        const ui = PortfolioUI;
        const dash = '&mdash;';
        const accounts = PortfolioApp.getAccounts();
        let acctCell = dash;
        let acctTitle = '';
        // Compact on purpose (the column budget is the 874px main column):
        // one account is named, several are a count with the names in the
        // tooltip.
        if (r.accountCount === 1) {
            const a = accounts.find(x => x.id === r.accounts[0]);
            acctCell = `<span class="tickers-acct-name">${esc(a ? a.name : '1 account')}</span>`;
            acctTitle = a ? a.name : '';
        } else if (r.accountCount > 1) {
            acctCell = `<span class="tickers-acct-n">${r.accountCount}</span>`;
            acctTitle = r.accounts.map(id => accounts.find(x => x.id === id)?.name).filter(Boolean).join(', ');
        }
        // Weight rides under the value — its own column did not fit beside
        // Accounts, and the two numbers describe the same position.
        const weight = r.held && r.price && r.weight != null
            ? `<span class="tickers-weight" title="${r.weight.toFixed(1)}% of the scoped book"><span class="portfolio-weight-track"><span class="portfolio-weight-bar" style="width:${Math.min(100, r.weight)}%;--pf-hue:${ui.tickerHue(r.ticker)}"></span></span><span class="tickers-weight-pct">${r.weight.toFixed(1)}%</span></span>`
            : '';
        const day = r.dayChange != null
            ? (r.held ? ui.plCell(r.dayChange, r.dayPct)
                : `<span class="portfolio-cell-pl ${ui.plClass(r.dayChange)}">${ui.formatPL(r.dayChange)}<span class="portfolio-cell-pct">${ui.formatPercent(r.dayPct)}</span></span>`)
            : dash;
        // No inline after-hours quote here (the holdings table carries it):
        // it doubled the Price column and pushed Day off the page.
        const priceRow = { currentPrice: r.price, priceEstimated: r.priceEstimated, after: null };
        return `
            <tr class="portfolio-row tickers-row${r.held ? ' is-held' : ' is-watch'}" data-ticker="${esc(r.ticker)}">
                <td class="portfolio-ticker">
                    <span class="portfolio-ticker-cell">
                        ${ui.tickerMono(r.ticker)}
                        <span class="portfolio-ticker-main">
                            <span class="portfolio-ticker-sym">${ui.tickerCellHtml({ ticker: r.ticker, option: r.option })}${r.watched ? '<span class="tickers-chip" title="On your watchlist">Watching</span>' : ''}</span>
                            ${r.name ? `<span class="portfolio-ticker-name">${esc(r.name)}</span>` : ''}
                        </span>
                    </span>
                </td>
                <td class="num">${r.held ? ui.formatShares(r.shares) : dash}</td>
                <td class="num portfolio-cell-quiet">${r.held ? ui.formatMoney(r.avgCost) : dash}</td>
                <td class="num">${ui.priceCellHtml(priceRow)}</td>
                <td class="num portfolio-cell-strong"><span class="tickers-value">${r.held && r.price ? ui.hv(ui.formatMoney(r.value)) : dash}${weight}</span></td>
                <td class="num">${r.pl != null ? ui.plCell(r.pl, r.plPct) : dash}</td>
                <td class="num">${day}</td>
                <td class="num portfolio-cell-quiet tickers-accounts"${acctTitle ? ` title="${esc(acctTitle)}"` : ''}>${acctCell}</td>
            </tr>`;
    },

    /**
     * Company names for rows that have none: fetched quietly, one at a
     * time, into PortfolioApp.companyInfoCache (the ticker page's own
     * cache), then the table repaints once. Single-flight, capped per
     * pass, options skipped (they describe themselves).
     */
    async _ensureNames(rows) {
        if (this._naming) return;
        const missing = rows
            .filter(r => !r.option && !r.name && !PortfolioApp.companyInfoCache[r.ticker])
            .map(r => r.ticker)
            .slice(0, 40);
        if (!missing.length) return;
        this._naming = true;
        try {
            for (const t of missing) {
                if (PortfolioApp.currentAccountFilter !== 'tickers') break;
                await PortfolioApp.fetchCompanyInfo(t);
            }
        } finally {
            this._naming = false;
        }
        const page = document.getElementById('portfolio-tickers-page');
        if (page && !page.hidden && PortfolioApp.currentAccountFilter === 'tickers') this._refresh();
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = PortfolioTickers;
