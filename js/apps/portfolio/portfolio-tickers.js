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
 * TWO VIEWS over the same rows (2026-09-15, by request). **Positions** is
 * the table above. **Indicators** is the same tickers wearing the verdicts
 * the daily business profile already wrote (PortfolioProfile.VERDICTS —
 * valuation, soundness, AI role, near/long-term risk and value, news tone),
 * one column each, every column sortable, so "which of mine looks cheap"
 * or "which carries the least near-term risk" is one click. Nothing is
 * computed here: a cell is the model's own word, lifted at write time, and
 * a ticker with no profile yet reads "—" and sinks in every sort. There is
 * no composite score — the app does not average someone else's judgments
 * into a number that looks like arithmetic. A column's FIRST click sorts
 * best-first (cheap, sound, low risk, strong value, positive news), which
 * is the whole point of the view; `defaultDir` derives that from the
 * spec's own tones, so a new verdict gets it for free.
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

    /** Which table: 'positions' | 'indicators'. Per-Mac, like the sort and
     *  the other Portfolio view preferences. */
    VIEW_KEY: 'portfolio-tickers-view',
    VIEWS: [{ id: 'positions', label: 'Positions' }, { id: 'indicators', label: 'Indicators' }],
    _view: null,

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

    TEXT_COLS: ['ticker', 'name', 'profile'],
    /** Column → the row field it sorts on (Day sorts by percent, see above).
     *  An indicator column is `ind:<verdict key>` and reads its rank — see
     *  `_sortValue`. */
    SORT_FIELD: {
        ticker: 'label', name: 'name', shares: 'shares', avgCost: 'avgCost', price: 'price',
        value: 'value', weight: 'weight', pl: 'pl', day: 'dayPct', accounts: 'accountCount',
        profile: 'profileDay'
    },

    /** The value a column sorts on: an indicator's rank, else the field. */
    _sortValue(row, col) {
        if (String(col).startsWith('ind:')) {
            const cell = row.ind ? row.ind[col.slice(4)] : null;
            // "Not on the sheet" is not a position on the scale: it sinks
            // with the unprofiled rather than pretending to be the low end.
            return cell && !cell.unknown ? cell.rank : null;
        }
        return row[this.SORT_FIELD[col] || col];
    },

    /**
     * Stable sort; rows with no value for the column ("—") sink to the
     * bottom whichever direction is chosen, so a watch-only row never tops
     * a Value sort just because null reads as small.
     */
    sort(rows, { col = 'value', dir = 'desc' } = {}) {
        const text = this.TEXT_COLS.includes(col);
        const sign = dir === 'asc' ? 1 : -1;
        const missing = (v) => v == null || (typeof v === 'number' && !isFinite(v)) || (text && v === '');
        return rows
            .map((r, i) => ({ r, i }))
            .sort((a, b) => {
                const av = this._sortValue(a.r, col), bv = this._sortValue(b.r, col);
                const am = missing(av), bm = missing(bv);
                if (am && bm) return a.i - b.i;
                if (am) return 1;
                if (bm) return -1;
                const c = text ? String(av).localeCompare(String(bv)) : (av - bv);
                return c !== 0 ? sign * c : a.i - b.i;
            })
            .map(x => x.r);
    },

    // ── Pure: indicators (the profile's verdicts as columns) ─────────────

    /**
     * Hang each row's profile verdicts on it as `ind`, one entry per verdict
     * the profile actually gave:
     *
     *   ind[key] = { word, rank, steps, tone, unknown, categorical }
     *
     * `rank` is the word's place on that verdict's own scale (low → high, as
     * the spec orders its options), which is what the columns sort by; an
     * extra word like the news "None", and "Unknown", carry no rank. The
     * words are the model's, lifted at write time by
     * PortfolioProfile.parseVerdicts — nothing is judged or averaged here.
     *
     * @param {Array} rows                consolidate() output
     * @param {Array} p.specs             PortfolioProfile.VERDICTS
     * @param {function} p.profileOf      ticker → { day, verdicts, fund } | null
     */
    attachIndicators(rows, { specs = [], profileOf = null } = {}) {
        return rows.map(r => {
            const p = profileOf ? profileOf(r.ticker) : null;
            const verdicts = (p && p.verdicts) || {};
            const fund = !!(p && p.fund);
            const ind = {};
            for (const spec of specs) {
                const word = verdicts[spec.key];
                if (!word) continue;
                const options = (fund && spec.fundOptions) ? spec.fundOptions : spec.options;
                const idx = options.indexOf(word);
                ind[spec.key] = {
                    word,
                    rank: idx >= 0 ? idx : null,
                    steps: options.length,
                    tone: (spec.tone && spec.tone[word]) || 'ink',
                    unknown: word === 'Unknown',
                    categorical: !!spec.categorical
                };
            }
            const count = Object.keys(ind).length;
            return { ...r, ind, indCount: count, profiled: count > 0, profileDay: (p && p.day) || null };
        });
    },

    /**
     * Which way a verdict column sorts on its FIRST click: best first, read
     * off the spec's own tones rather than a second table that could drift
     * from them. Cheap / Sound / Low risk / Strong value / Positive news
     * come to the top; a categorical scale (AI role) keeps its spec order.
     */
    defaultDir(col, specs = this.specs()) {
        if (!String(col).startsWith('ind:')) return null;
        const spec = (specs || []).find(v => v.key === col.slice(4));
        if (!spec || !spec.options || !spec.options.length) return null;
        const tone = spec.tone || {};
        const good = (w) => tone[w] === 'good' || tone[w] === 'accent';
        if (good(spec.options[spec.options.length - 1])) return 'desc';
        if (good(spec.options[0])) return 'asc';
        return 'desc';
    },

    /** Profile coverage over a set of rows, for the head line. */
    summarizeIndicators(rows, { today = null } = {}) {
        const out = { total: rows.length, profiled: 0, today: 0 };
        for (const r of rows) {
            if (r.profiled) out.profiled++;
            if (today && r.profileDay === today) out.today++;
        }
        out.missing = out.total - out.profiled;
        return out;
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

    /** The verdict spec, the one place it is defined (PortfolioProfile). */
    specs() {
        return (typeof PortfolioProfile !== 'undefined' && Array.isArray(PortfolioProfile.VERDICTS)) ? PortfolioProfile.VERDICTS : [];
    },

    /** The stored profile behind a ticker (an option reads its underlying's),
     *  with its verdicts — lifted on the spot when the entry predates the
     *  Verdicts section, the same fallback the ticker page makes. */
    _profileOf(ticker) {
        if (typeof PortfolioProfile === 'undefined') return null;
        // The Indicators view is the profiles wearing a table; when the
        // setting is off they are not shown here either.
        if (!PortfolioProfile.settingOn()) return null;
        const e = PortfolioProfile.get(ticker);
        if (!e || !e.text) return null;
        const verdicts = e.verdicts || PortfolioProfile.parseVerdicts(e.text, { fund: !!e.fund }).verdicts;
        return { day: e.day || null, fund: !!e.fund, verdicts: verdicts || {} };
    },

    view() {
        if (!this._view) {
            let stored = null;
            try { stored = localStorage.getItem(this.VIEW_KEY); } catch { stored = null; }
            this._view = this.VIEWS.some(v => v.id === stored) ? stored : 'positions';
        }
        return this._view;
    },
    setView(id) {
        if (!this.VIEWS.some(v => v.id === id) || id === this.view()) return;
        this._view = id;
        try { localStorage.setItem(this.VIEW_KEY, id); } catch { /* per-Mac */ }
        this.render();
    },

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
        const indicators = this.view() === 'indicators';
        const withInd = indicators
            ? this.attachIndicators(all, { specs: this.specs(), profileOf: (t) => this._profileOf(t) })
            : all;
        const sortState = indicators ? PortfolioApp.sort.indicators : PortfolioApp.sort.tickers;
        return { all: withInd, shown: this.sort(this.filter(withInd, f), sortState) };
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
        const view = this.view();
        // The indicators view says what it can say: how many of these
        // tickers have a profile to read verdicts off. The sweep fills the
        // rest in quietly, so the line is a fact, not a chore.
        const cov = view === 'indicators' ? this.summarizeIndicators(all, { today: this._today() }) : null;
        const sub = view === 'indicators'
            ? (cov.total
                ? (cov.profiled
                    ? `${cov.profiled} of ${cov.total} profiled${cov.today ? ` · ${cov.today} today` : ''}${cov.missing ? ` · ${cov.missing} waiting` : ''}`
                    : 'No business profiles written yet.')
                : 'What your AI model makes of each one.')
            : (sum.total
                ? subParts.join(' · ')
                : 'Every symbol you hold or follow, on one table.');

        const seg = (name, value, label) =>
            `<button type="button" class="tickers-seg-btn${f[name] === value ? ' is-active' : ''}" data-seg="${name}" data-value="${esc(value)}">${label}</button>`;
        const viewSeg = `<div class="tickers-seg tickers-view-seg" role="group" aria-label="View">
                    ${this.VIEWS.map(v => `<button type="button" class="tickers-seg-btn${view === v.id ? ' is-active' : ''}" data-view="${v.id}"${view === v.id ? ' aria-current="true"' : ''}>${esc(v.label)}</button>`).join('')}
                </div>`;

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
                ${viewSeg}
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

        this._paint(shown, all.length);

        el.querySelectorAll('[data-view]').forEach(btn => btn.addEventListener('click', () => this.setView(btn.dataset.view)));
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
        this._paint(shown, all.length);
    },

    /** Whichever table the view names. */
    _paint(rows, totalCount) {
        if (this.view() === 'indicators') this._renderIndicatorTable(rows, totalCount);
        else this._renderTable(rows, totalCount);
    },

    _today() {
        return (typeof PortfolioProfile !== 'undefined') ? PortfolioProfile.today() : null;
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

    // ── The indicators table ─────────────────────────────────────────────

    /** Column headings — the spec's label, shortened where the table is
     *  tighter than the prose. The tooltip carries the full scale. */
    IND_HEAD: {
        valuation: 'Valuation', soundness: 'Soundness', ai: 'AI role',
        nearRisk: 'Near risk', longRisk: 'Long risk',
        nearValue: 'Near value', longValue: 'Long value', news: 'News'
    },

    /** "Today" / "3d" / "" for a profile's day. */
    _dayAge(day) {
        if (!day) return '';
        const today = this._today();
        if (day === today) return 'Today';
        const a = new Date(`${day}T00:00:00`), b = new Date(`${today}T00:00:00`);
        const n = Math.round((b - a) / 86400000);
        if (!isFinite(n) || n < 0) return day;
        return n === 1 ? 'Yesterday' : `${n}d ago`;
    },

    _renderIndicatorTable(rows, totalCount) {
        const host = document.getElementById('portfolio-tickers-table');
        if (!host) return;
        const esc = AppManager.escapeHtml;
        const count = document.getElementById('portfolio-tickers-count');
        if (count) count.textContent = totalCount ? (rows.length === totalCount ? `${totalCount}` : `${rows.length} of ${totalCount}`) : '';

        if (!totalCount) return this._renderTable(rows, totalCount);   // the same "No tickers yet" card

        const specs = this.specs();
        if (!rows.some(r => r.profiled)) {
            const dest = (typeof PortfolioProfile !== 'undefined') ? PortfolioProfile.destination() : null;
            const auto = (typeof PortfolioProfile !== 'undefined') ? PortfolioProfile.autoAllowed() : false;
            const off = (typeof PortfolioProfile !== 'undefined') && !PortfolioProfile.settingOn();
            host.innerHTML = `
                <div class="portfolio-card tickers-card">
                    <div class="empty-state">
                        <span class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="20" y2="7"/><circle cx="15" cy="7" r="2.2"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="8" cy="12" r="2.2"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="17" cy="17" r="2.2"/></svg></span>
                        <h3>No indicators yet</h3>
                        <p>${!off
                            ? (auto
                                ? 'Your AI model writes a business profile for each ticker once a day, and its verdicts land here. Leave Portfolio open for a minute.'
                                : `Open a ticker and press <b>Write today&rsquo;s profile</b>${dest ? ` with ${esc(dest)}` : ''} &mdash; its verdicts land here.`)
                            : 'Turn on <b>Generate stock profile using AI</b> in Settings &rsaquo; Portfolio and the verdicts land here.'}</p>
                    </div>
                </div>`;
            return;
        }

        const th = (label, col, title) => {
            const html = PortfolioUI.buildSortableHeader('indicators', label, col, true);
            return title ? html.replace('<th ', `<th title="${esc(title)}" `) : html;
        };
        const headCells = specs.map(spec => {
            const scale = [...(spec.options || []), ...(spec.extra || [])].join(' · ');
            return th(esc(this.IND_HEAD[spec.key] || spec.label), `ind:${spec.key}`,
                `${spec.label}: ${scale}. Click to sort ${this.defaultDir(`ind:${spec.key}`, specs) === 'asc' ? 'lowest' : 'best'} first.`);
        }).join('');
        const body = rows.length
            ? rows.map(r => this._indRowHtml(r, specs)).join('')
            : `<tr class="tickers-none"><td colspan="${specs.length + 2}">No tickers match this filter.</td></tr>`;

        host.innerHTML = `
            <div class="portfolio-card tickers-card tickers-ind-card">
            <table class="portfolio-table portfolio-tickers-table portfolio-tickers-ind">
                <thead>
                    <tr>
                        ${PortfolioUI.buildSortableHeader('indicators', 'Ticker', 'ticker', false)}
                        ${headCells}
                        ${th('Profile', 'profile', 'When the profile these verdicts come from was written')}
                    </tr>
                </thead>
                <tbody>${body}</tbody>
            </table>
            </div>
            <p class="tickers-ind-note">Every word here is your AI model&rsquo;s own judgment from that day&rsquo;s profile, not a calculation. Open a ticker to read the reasoning behind it.</p>`;

        PortfolioUI.attachSortListener(host);
        host.querySelectorAll('.portfolio-row').forEach(row => {
            row.addEventListener('click', () => PortfolioApp.openTickerDetail(row.dataset.ticker));
        });
    },

    _indRowHtml(r, specs) {
        const esc = AppManager.escapeHtml;
        const ui = PortfolioUI;
        const dash = '&mdash;';
        // A cell is one word. No meter, no pill: eight columns of bars and
        // chips read as a wall (2026-09-15, by request). Only the ENDS of a
        // scale keep a colour — the good end and the bad end — because in a
        // grid of two hundred words a tinted middle ('warn': Moderate,
        // Mixed, Limited) is most of the page shouting. Middles, the whole
        // categorical AI column and "Not said" stay quiet ink; the profile's
        // own tiles, where there are eight words and not two hundred, still
        // show the amber.
        const cells = specs.map(spec => {
            const c = r.ind ? r.ind[spec.key] : null;
            if (!c) return `<td class="tickers-ind portfolio-cell-quiet">${dash}</td>`;
            const ends = c.tone === 'good' || c.tone === 'bad';
            const tone = (c.unknown || c.categorical || !ends) ? 'ink' : c.tone;
            const word = c.unknown ? 'Not said' : c.word;
            const scale = [...(spec.options || []), ...(spec.extra || [])].join(' · ');
            return `<td class="tickers-ind${c.unknown ? ' is-unknown' : ''}" data-tone="${tone}" title="${esc(`${spec.label}: ${c.unknown ? 'the fact sheet could not say' : `${c.word} (${scale})`}`)}">
                    <span class="tickers-ind-word">${esc(word)}</span>
                </td>`;
        }).join('');
        const age = this._dayAge(r.profileDay);
        return `
            <tr class="portfolio-row tickers-row${r.held ? ' is-held' : ' is-watch'}" data-ticker="${esc(r.ticker)}">
                <td class="portfolio-ticker">
                    <span class="portfolio-ticker-cell">
                        <span class="portfolio-ticker-main">
                            <span class="portfolio-ticker-sym">${ui.tickerCellHtml({ ticker: r.ticker, option: r.option })}${r.watched && !r.held ? '<span class="tickers-chip" title="On your watchlist">Watching</span>' : ''}</span>
                            ${r.name ? `<span class="portfolio-ticker-name">${esc(r.name)}</span>` : ''}
                        </span>
                    </span>
                </td>
                ${cells}
                <td class="num portfolio-cell-quiet tickers-ind-when">${age ? esc(age) : dash}</td>
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
