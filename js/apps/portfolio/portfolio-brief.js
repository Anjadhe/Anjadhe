/**
 * PortfolioBrief — the daily market-and-portfolio brief, written by the
 * user's AI model ONCE per calendar day and shown at the top of the All
 * Accounts page (`#portfolio-brief`). The whole-portfolio sibling of the
 * per-ticker business profile (PortfolioProfile): same laws, one subject.
 *
 * What it says: what kind of day the market had (indexes, yields,
 * volatility, commodities), what the portfolio did against it, which
 * positions moved and what they did to the total, how the book sits
 * against the plan, the dated headlines, what is worth watching, a
 * bottom line.
 *
 * Laws:
 *  - GROUNDED, not recalled. The model is handed a FACT SHEET built here
 *    (pure `factSheet`, pinned by tests/portfolio-brief-test.js) from the
 *    app's own arithmetic — getSummary, computeHoldings, the value-history
 *    snapshots, PortfolioStrategy.evaluate — plus Yahoo's index quotes
 *    (`yahoo-quotes`, the same IPC the price refresh uses) and the dated
 *    headlines PortfolioNews and the news engine already fetch. Every
 *    figure it may cite is on the sheet; the prompt says to say "not on
 *    the sheet" rather than fill in.
 *  - THE USER'S MONEY IS IN THE PROMPT ON PURPOSE. Unlike the ticker
 *    profile (about the company), the brief is about the reader's own
 *    book — so it is gated exactly like ambient portfolio reads (the
 *    Portfolio data class under Cloud Privacy), and it DESCRIBES, never
 *    prescribes: no buy / sell / rebalance instructions.
 *  - ONCE A DAY, and REWRITABLE. Keyed by the local calendar day; the page
 *    re-reads it. A failed run is retryable; a finished one is not re-asked
 *    until tomorrow — except by the page's own "Rewrite" button
 *    (`ensure({force: true, manual: true})`), which is the user asking for
 *    a fresh read after the close, after a trade, or after a correction.
 *  - MACHINE-LOCAL. localStorage `portfolio-brief-cache`, never the synced
 *    portfolio blob (the volatile-data law).
 *  - CONSENT follows DocTidy: auto when the brain is on this Mac or the
 *    Portfolio class may leave; otherwise a button naming the destination,
 *    and the click is the consent. Every run lands in LLM Logs.
 *  - IT GOES FIRST. PortfolioProfile's daily sweep writes the brief before
 *    the forty ticker profiles, so a home-page visit still produces
 *    today's brief; on a metered brain it is written on page open only.
 */
const PortfolioBrief = {
    SOURCE: 'portfolio-brief',
    CACHE_KEY: 'portfolio-brief-cache',
    MARKET_NEWS_KEY: 'portfolio-brief-market-news',
    EXPANDED_KEY: 'portfolio-brief-expanded',
    MARKET_NEWS_TTL_MS: 30 * 60 * 1000,
    MARKET_HEADLINES: 6,
    HOLDING_HEADLINES: 10,
    TOP_HOLDINGS: 12,
    MOVER_PCT: 1.5,
    MAX_MOVERS: 6,
    MAX_OUTPUT_TOKENS: 2200,
    // The market, as a handful of quotes. Yahoo's quote endpoint accepts
    // index (^), futures (=F) and crypto (-USD) symbols alike.
    MARKET_SYMBOLS: [
        ['^GSPC', 'S&P 500'],
        ['^IXIC', 'Nasdaq Composite'],
        ['^DJI', 'Dow Jones Industrial Average'],
        ['^RUT', 'Russell 2000'],
        ['^VIX', 'VIX (volatility index)'],
        ['^TNX', '10-year Treasury yield, in %'],
        ['GC=F', 'Gold (futures, $/oz)'],
        ['CL=F', 'Crude oil WTI (futures, $/bbl)'],
        ['BTC-USD', 'Bitcoin (USD)']
    ],

    _cache: null,
    // Set by "Ask about this brief…": while true, the page's AgentContext
    // provider hands the chat the brief's text (PortfolioApp's provider
    // reads contextBlock()). Cleared on a scope change.
    chatting: false,
    _inflight: null,        // Promise<entry> while a run is on
    _partial: '',           // text so far
    _listeners: new Set(),

    /* ---------- storage ---------- */

    cache() {
        if (!this._cache) {
            try { this._cache = JSON.parse(localStorage.getItem(this.CACHE_KEY) || 'null') || {}; }
            catch { this._cache = {}; }
        }
        return this._cache;
    },
    _save() {
        try { localStorage.setItem(this.CACHE_KEY, JSON.stringify(this.cache())); } catch { /* cache only */ }
    },

    /** Local calendar day, the unit of "once a day". */
    today(now = new Date()) {
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    },

    /** The stored brief, any day, or null. */
    get() { const e = this.cache().entry; return e && (e.text || e.error) ? e : null; },
    isToday(entry) { return !!entry && entry.day === this.today(); },

    /* ---------- policy (the DocTidy shape, shared with PortfolioProfile) ---------- */

    available() {
        return typeof AgentService !== 'undefined' && !!AgentService.model
            && typeof LLMLogger !== 'undefined' && typeof LLMLogger.callStream === 'function';
    },
    autoAllowed() {
        if (!this.available()) return false;
        if (typeof CloudPrivacy === 'undefined') return true;
        return !CloudPrivacy.brainLeaves() || CloudPrivacy.allows('portfolio');
    },
    destination() {
        try { return (typeof CloudPrivacy !== 'undefined' && CloudPrivacy.brainLeaves()) ? (CloudPrivacy.brainDestination() || 'your AI model') : null; }
        catch { return null; }
    },
    _modelLabel() {
        try {
            const entry = AgentService.getDefaultEntry?.() || null;
            if (entry?.engine === 'anjadhe' && AgentService.anjadheEntryLabel) return AgentService.anjadheEntryLabel(entry);
            return entry?.label || entry?.model || AgentService.model || 'your AI model';
        } catch { return 'your AI model'; }
    },
    _numCtx() {
        try {
            const entry = AgentService.getDefaultEntry?.() || null;
            const n = AgentService.entryNumCtx ? AgentService.entryNumCtx(entry) : (AgentService.numCtx || 8192);
            return (Number.isFinite(n) && n > 0) ? n : 8192;
        } catch { return AgentService.numCtx || 8192; }
    },
    async _webOn() {
        try { const s = await window.electronSearch?.getStatus?.(); return !!(s && s.enabled && s.provider); }
        catch { return false; }
    },

    /* ---------- the fact sheet (pure; Node-tested) ---------- */

    _money(n) {
        if (!Number.isFinite(n)) return null;
        const abs = Math.abs(n);
        const s = abs.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: abs >= 1000 ? 0 : 2, maximumFractionDigits: abs >= 1000 ? 0 : 2 });
        return n < 0 ? `-${s}` : s;
    },
    _signed(n) {
        if (!Number.isFinite(n)) return null;
        const m = this._money(Math.abs(n));
        return n < 0 ? `-${m}` : `+${m}`;
    },
    _pct(n, digits = 1) {
        if (!Number.isFinite(n)) return null;
        return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
    },

    /**
     * The portfolio's move since a past snapshot: the newest snapshot on or
     * before `fromDate`, else the earliest one after it (a history that
     * starts on Jan 2 still has a "start of the year") — either within
     * `slack` days of the date. A gap wider than that means the history
     * does not reach back, and nothing is claimed.
     */
    changeSince(history, { fromDate, key = 'totalValue', current, slack = 4 } = {}) {
        const list = (history || []).filter(s => s && s.date && Number.isFinite(s[key])).sort((a, b) => a.date.localeCompare(b.date));
        const days = (a, b) => Math.abs(Date.parse(a + 'T12:00:00') - Date.parse(b + 'T12:00:00')) / 86400000;
        const snap = [...list].reverse().find(s => s.date <= fromDate) || list.find(s => s.date > fromDate);
        if (!snap || days(fromDate, snap.date) > slack) return null;
        if (!Number.isFinite(current) || snap[key] === 0) return null;
        const change = current - snap[key];
        return { fromDate: snap.date, from: snap[key], to: current, change, pct: (change / Math.abs(snap[key])) * 100 };
    },

    _dateMinus(today, days) {
        const d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() - days);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },

    /**
     * Turn the app's own numbers (+ quotes and headlines) into the lines
     * the model is allowed to cite. Everything here is arithmetic the app
     * already does; nothing is model-written. Pure over plain data:
     *   summary          PortfolioApp.getSummary(holdings)
     *   holdings         [{label, currentValue, currentPrice, dayChange, dayChangePercent, profitLossPercent}]
     *   accounts         [{name, type, value, cash, plan}]
     *   history          value-history snapshots [{date, totalValue, netWorth}]
     *   plan             {name, objective, horizon, riskLevel, thesis, report} | null
     *   accountPlans     [{account, name, headline, status}]
     *   market           [{label, price, changePercent}] (quotes that came back)
     *   marketHeadlines  [{title, source, publishedAt}]
     *   holdingHeadlines [{ticker, title, source, publishedAt}]
     */
    factSheet({ today, summary, holdings = [], accounts = [], history = [], plan = null, accountPlans = [], market = [], marketHeadlines = [], holdingHeadlines = [], ago = null, weekend = false } = {}) {
        const s = summary || {};
        const lines = [];
        const add = (label, val) => { if (val != null && val !== '') lines.push(`- ${label}: ${val}`); };
        const section = (title) => { lines.push('', `${title}:`); };
        const when = (ts) => ago ? ago(ts) : (ts ? new Date(ts).toISOString().slice(0, 10) : '');

        lines.push(`Date: ${today}${weekend ? ' (weekend — market figures are the last session\'s close)' : ''}`);

        section('The market (last quote; change is over the last session)');
        if (market.length) {
            market.forEach(q => {
                const px = Number.isFinite(q.price) ? q.price.toLocaleString('en-US', { maximumFractionDigits: 2 }) : null;
                if (px != null) add(q.label, `${px} (${this._pct(q.changePercent) || 'n/a'})`);
            });
        } else {
            lines.push('- Market quotes could not be fetched today; do not describe the market\'s day beyond what the headlines say.');
        }

        const hasDebt = (s.liabilitiesTotal || 0) > 0;
        const headline = hasDebt ? s.netWorth : s.totalValue;
        const invested = (s.totalValue || 0) - (s.cash || 0) - (s.realEstateValue || 0);
        section('The portfolio today');
        add(hasDebt ? 'Net worth' : 'Total value', this._money(headline));
        if (hasDebt) add('Total assets', this._money(s.totalValue));
        add('Investments (stocks, funds, options)', this._money(invested));
        add('Cash', this._money(s.cash || 0));
        if ((s.realEstateValue || 0) > 0) add('Real estate', this._money(s.realEstateValue));
        if (hasDebt) add('Debt', this._money(s.liabilitiesTotal));
        if (s.totalDayBase > 0) add('Today\'s change in investments', `${this._signed(s.totalDayChange)} (${this._pct(s.totalDayChangePercent)})`);
        else lines.push('- Today\'s change: not available (no priced positions carried into today)');
        if ((s.totalCost || 0) > 0) add('All-time gain on investments (against cost)', `${this._signed(s.totalPL)} (${this._pct(s.totalPLPercent)})`);
        add('Positions', String(holdings.length));

        const key = hasDebt ? 'netWorth' : 'totalValue';
        const since = [
            ['One week ago', this.changeSince(history, { fromDate: this._dateMinus(today, 7), key, current: headline })],
            ['One month ago', this.changeSince(history, { fromDate: this._dateMinus(today, 30), key, current: headline, slack: 6 })],
            ['Start of the year', this.changeSince(history, { fromDate: `${today.slice(0, 4)}-01-01`, key, current: headline, slack: 10 })]
        ].filter(([, c]) => c);
        if (since.length) {
            section(`Change in ${hasDebt ? 'net worth' : 'total value'} since (from the app\'s own daily snapshots; includes deposits and withdrawals, not only market moves)`);
            since.forEach(([label, c]) => add(`${label} (${c.fromDate})`, `${this._signed(c.change)} (${this._pct(c.pct)}) from ${this._money(c.from)}`));
        }

        const priced = holdings.filter(h => h.currentPrice > 0);
        const total = priced.reduce((t, h) => t + (h.currentValue || 0), 0);
        if (priced.length) {
            const byValue = priced.slice().sort((a, b) => (b.currentValue || 0) - (a.currentValue || 0));
            section(`Largest positions (weight of investments; today; all-time gain against cost)`);
            byValue.slice(0, this.TOP_HOLDINGS).forEach(h => {
                const w = total > 0 ? (h.currentValue / total) * 100 : 0;
                lines.push(`- ${h.label}: ${this._money(h.currentValue)}, ${w.toFixed(1)}% of investments, today ${this._pct(h.dayChangePercent) || 'n/a'}, all-time ${this._pct(h.profitLossPercent) || 'n/a'}`);
            });
            if (byValue.length > this.TOP_HOLDINGS) lines.push(`- …and ${byValue.length - this.TOP_HOLDINGS} smaller positions`);
            const top1 = total > 0 ? (byValue[0].currentValue / total) * 100 : 0;
            const top5 = total > 0 ? (byValue.slice(0, 5).reduce((t, h) => t + h.currentValue, 0) / total) * 100 : 0;
            add('Concentration', `largest position ${top1.toFixed(1)}% of investments; top five ${top5.toFixed(1)}%`);

            const movers = priced.filter(h => Number.isFinite(h.dayChangePercent) && Math.abs(h.dayChangePercent) >= this.MOVER_PCT);
            const up = movers.filter(h => h.dayChangePercent > 0).sort((a, b) => b.dayChangePercent - a.dayChangePercent).slice(0, this.MAX_MOVERS);
            const down = movers.filter(h => h.dayChangePercent < 0).sort((a, b) => a.dayChangePercent - b.dayChangePercent).slice(0, this.MAX_MOVERS);
            section(`Today's movers (positions moving ${this.MOVER_PCT}% or more)`);
            if (!up.length && !down.length) lines.push('- None. A quiet day for the positions.');
            up.forEach(h => lines.push(`- Up: ${h.label} ${this._pct(h.dayChangePercent)} (${this._signed(h.dayChange)})`));
            down.forEach(h => lines.push(`- Down: ${h.label} ${this._pct(h.dayChangePercent)} (${this._signed(h.dayChange)})`));
        }
        const unpriced = holdings.filter(h => !(h.currentPrice > 0));
        if (unpriced.length) add('Positions without a price today', unpriced.map(h => h.label).join(', '));

        if (accounts.length) {
            section('Accounts');
            accounts.forEach(a => lines.push(`- ${a.name}${a.type ? ` (${a.type})` : ''}: ${this._money(a.value)}${a.cash > 0 ? `, of which cash ${this._money(a.cash)}` : ''}${a.plan ? `, follows its own plan "${a.plan}"` : ''}`));
        }

        if (plan) {
            section(`The plan: "${plan.name}"`);
            add('Objective', plan.objective); add('Horizon', plan.horizon); add('Risk level', plan.riskLevel);
            if (plan.thesis) add('Thesis', String(plan.thesis).slice(0, 600));
            const r = plan.report;
            if (r && !r.empty) {
                add('Status (computed by the app)', `${r.status} — ${r.headline}`);
                (r.targets || []).forEach(t => lines.push(`- Target "${t.label}": ${t.actualPct.toFixed(1)}% now against ${t.targetPct}% (band ${t.minPct}–${t.maxPct}%) — ${t.status === 'ok' ? 'within band' : t.status}`));
                if (r.unclassified) lines.push(`- Not covered by any target: ${r.unclassified.pct.toFixed(1)}% (${r.unclassified.tickers.join(', ')}${r.unclassified.includesCash ? ', and cash' : ''})`);
                (r.rules || []).filter(x => x.status !== 'ok').forEach(x => lines.push(`- Rule "${x.label || x.text || 'guardrail'}": ${x.status}${x.detail ? ` — ${x.detail}` : ''}`));
            }
        } else {
            lines.push('', 'The plan: none written yet (Portfolio › Strategy). Do not invent one.');
        }
        if (accountPlans.length) {
            section('Accounts on their own plan (computed by the app)');
            accountPlans.forEach(p => lines.push(`- ${p.account} — "${p.name}": ${p.status} — ${p.headline}`));
        }

        const news = [];
        marketHeadlines.slice(0, this.MARKET_HEADLINES).forEach(h => news.push(`- Market: ${h.title}${h.source ? ` — ${h.source}` : ''}${when(h.publishedAt) ? ` (${when(h.publishedAt)})` : ''}`));
        holdingHeadlines.slice(0, this.HOLDING_HEADLINES).forEach(h => news.push(`- ${h.ticker}: ${h.title}${h.source ? ` — ${h.source}` : ''}${when(h.publishedAt) ? ` (${when(h.publishedAt)})` : ''}`));
        if (news.length) { section('Recent headlines (dated, sourced — the only news you may mention)'); lines.push(...news); }

        return { text: lines.join('\n'), positions: holdings.length, hasPlan: !!plan, hasMarket: market.length > 0, headlines: news.length };
    },

    /* ---------- prompt ---------- */

    _systemPrompt() {
        const sections = [
            'The market today — what kind of session it was, from the index, yield, volatility and commodity lines on the fact sheet: broad or narrow, risk-on or risk-off, calm or jumpy. When the quotes are missing, say the market could not be read today and move on. On a weekend, describe the last session as the last session.',
            'Your portfolio today — the headline number and today\'s move, set against the market\'s (did the book do better or worse than the indexes, and roughly why given what it holds); then the longer view from the week / month / year-to-date lines where the sheet has them, noting that those include money added or withdrawn.',
            'What moved — the positions that moved most today, up and down, and what they did to the total; a word on concentration where the top positions dominate. When nothing moved, one sentence.',
            'Against your plan — read the plan\'s computed status and targets: on plan, drifting, or in breach, and which target or rule. Describe the gap; do not tell the reader what to do about it. Omit this section entirely when the sheet has no plan.',
            'In the news — ONLY the headlines on the fact sheet, market first, then holdings, each with its age and what it might mean for this book. Omit the whole section when none are listed.',
            'Worth watching — two to four specific things for the coming days that follow from the sections above (a position near a target band, a large mover, a headline with a follow-through). Never invent dates, earnings, or events that are not on the sheet.',
            'Bottom line — three sentences the reader can carry away.'
        ];
        return [
            'You are a calm, precise investment writer preparing the daily brief for one individual investor about THEIR OWN portfolio and the market it sits in. Address the reader as "you". Write in plain English, in Markdown.',
            'Use exactly these sections, in this order. Each heading is "## " followed by the section title (the words before the dash below); the text after the dash says what the section covers:',
            ...sections.map((s, i) => `${i + 1}. ${s}`),
            '',
            'Rules:',
            '- Every number, date and headline you cite must come from the fact sheet. Never invent a figure. When a figure is not on the sheet, say so plainly instead of guessing.',
            '- DESCRIBE, never prescribe: no instructions to buy, sell, trim, add, or rebalance, and no "consider …" suggestions about trades. Reporting that the plan says a target is over or under its band is fine; telling the reader to fix it is not.',
            '- Your general knowledge is welcome for context (what an index is, what a yield move usually means), marked "as of my knowledge" where it could have changed. Interpret the sheet; do not restate it as a list. No tables. No bullet list longer than six items.',
            '- Be proportionate: a quiet day gets a short brief. Do not pad.',
            '- No disclaimers, no "consult a financial advisor", no offers to help further.',
            '- Never repeat a sentence you have already written. When the brief is complete, stop.'
        ].join('\n');
    },

    /* ---------- inputs (renderer only) ---------- */

    async _waitForPrices() {
        // The page's own refresh may be in flight; a brief written from
        // yesterday's quotes while today's are loading would be wrong twice.
        for (let i = 0; i < 40 && PortfolioApp.isRefreshing; i++) await new Promise(r => setTimeout(r, 500));
        try { if (!PortfolioApp.isRefreshing) await PortfolioApp.autoRefreshPrices(); } catch { /* the cache stands */ }
    },

    async _market() {
        try {
            const q = await window.electronNet?.fetchYahooQuotes?.(this.MARKET_SYMBOLS.map(([s]) => s));
            if (!q) return [];
            return this.MARKET_SYMBOLS.map(([sym, label]) => q[sym] ? { symbol: sym, label, price: q[sym].price, changePercent: q[sym].changePercent } : null).filter(Boolean);
        } catch { return []; }
    },

    async _marketHeadlines() {
        if (!(await this._webOn())) return [];
        let cached = null;
        try { cached = JSON.parse(localStorage.getItem(this.MARKET_NEWS_KEY) || 'null'); } catch { cached = null; }
        if (cached && Array.isArray(cached.items) && (Date.now() - cached.at) < this.MARKET_NEWS_TTL_MS) return cached.items;
        try {
            const r = await window.electronSearch.news(['stock market today']);
            const t = (r && Array.isArray(r.topics)) ? r.topics[0] : null;
            if (!t || t.error || !Array.isArray(t.items)) return cached?.items || [];
            const now = Date.now();
            const items = t.items.map(it => ({ title: String(it.title || '').slice(0, 200), source: String(it.source || '').slice(0, 60), url: String(it.url || ''), publishedAt: it.publishedAt ? Date.parse(it.publishedAt) : NaN }))
                .filter(it => it.title && Number.isFinite(it.publishedAt) && now - it.publishedAt < 3 * 86400000)
                .sort((a, b) => b.publishedAt - a.publishedAt)
                .slice(0, this.MARKET_HEADLINES);
            try { localStorage.setItem(this.MARKET_NEWS_KEY, JSON.stringify({ at: now, items })); } catch { /* cache only */ }
            return items;
        } catch { return cached?.items || []; }
    },

    async _holdingHeadlines() {
        if (typeof PortfolioNews === 'undefined' || !(await this._webOn())) return [];
        try {
            const r = await PortfolioNews.headlines({ limit: this.HOLDING_HEADLINES });
            return (r.items || []).map(it => ({ ticker: PortfolioApp.displayTicker(it.ticker), title: it.title, source: it.source, publishedAt: it.publishedAt }));
        } catch { return []; }
    },

    /** Everything the fact sheet needs, gathered from the app. */
    async _inputs() {
        PortfolioApp.loadData();
        await this._waitForPrices();
        const label = (t) => PortfolioApp.displayTicker(t);
        const holdings = PortfolioApp.computeHoldings().map(h => ({ label: label(h.ticker), currentValue: h.currentValue, currentPrice: h.currentPrice, dayChange: h.dayChange, dayChangePercent: h.dayChangePercent, profitLossPercent: h.profitLossPercent }));
        const summary = PortfolioApp.getSummary(PortfolioApp.computeHoldings());
        const strat = (typeof PortfolioStrategy !== 'undefined') ? PortfolioStrategy : null;
        const dflt = strat ? strat.getDefault() : null;
        const accounts = PortfolioApp.getAccounts().map(a => {
            const s = PortfolioApp.getSummary(PortfolioApp.computeHoldings(a.id), a.id);
            const own = (strat && a.strategyId && dflt && a.strategyId !== dflt.id) ? strat.getById(a.strategyId) : null;
            return { id: a.id, name: a.name, type: a.type || '', value: s.totalValue, cash: s.cash, plan: own ? own.name : null, own };
        }).filter(a => a.value > 0 || a.cash > 0);
        let plan = null;
        if (dflt && dflt.status !== 'draft') {
            let report = null;
            try { report = strat.evaluate(dflt); } catch { report = null; }
            plan = { name: dflt.name, objective: dflt.objective, horizon: dflt.horizon, riskLevel: dflt.riskLevel, thesis: dflt.thesis, report };
        }
        const accountPlans = accounts.filter(a => a.own && a.own.status !== 'draft').map(a => {
            let r = null;
            try { r = strat.evaluate(a.own, { accountId: a.id }); } catch { r = null; }
            return r && !r.empty ? { account: a.name, name: a.own.name, status: r.status, headline: r.headline } : null;
        }).filter(Boolean);
        const [market, marketHeadlines, holdingHeadlines] = await Promise.all([this._market(), this._marketHeadlines(), this._holdingHeadlines()]);
        const ago = (typeof PortfolioNews !== 'undefined' && PortfolioNews._ago) ? (ts) => PortfolioNews._ago(ts) : null;
        const day = new Date().getDay();
        return {
            today: this.today(), summary, holdings, history: PortfolioApp.valueHistory || [],
            accounts: accounts.map(({ own, id, ...rest }) => rest), plan, accountPlans,
            market, marketHeadlines, holdingHeadlines, ago, weekend: day === 0 || day === 6
        };
    },

    /* ---------- the run ---------- */

    /** Is there a portfolio to brief? */
    hasPortfolio() {
        try {
            PortfolioApp.loadData();
            return PortfolioApp.getAccounts().length > 0 && PortfolioApp.computeHoldings().length > 0;
        } catch { return false; }
    },

    /**
     * Today's brief: the cached one when it exists, else one run of the
     * model. `manual: true` is a click (consent given); `force: true`
     * rewrites today's (the Rewrite button). Resolves the entry, or {error}.
     */
    async ensure({ manual = false, force = false } = {}) {
        const have = this.cache().entry;
        if (!force && this.isToday(have) && have.text) return have;
        if (this._inflight) return this._inflight;
        if (!this.hasPortfolio()) return { error: 'Nothing to brief yet.' };
        if (!this.available()) return { error: 'No AI model is set up (Settings › AI Assistant).' };
        if (!manual && !this.autoAllowed()) return { error: 'Portfolio data may not leave this Mac on its own.', needsConsent: true };
        const run = this._generate().finally(() => { this._inflight = null; this._partial = ''; });
        this._inflight = run;
        this._emit({ started: true });
        return run;
    },

    async _generate() {
        const inputs = await this._inputs();
        if (!inputs.holdings.length) return this._fail('Nothing to brief yet.');
        const sheet = this.factSheet(inputs);
        const system = this._systemPrompt();
        const user = `Today is ${inputs.today}. Write my daily market and portfolio brief.\n\nFACT SHEET (from the Portfolio app and Yahoo Finance, ${inputs.today}):\n${sheet.text}`;
        // Chat's own context size (a different num_ctx would reload the
        // local model on every alternation with chat); the output budget
        // fits inside it.
        const numCtx = this._numCtx();
        const promptTokens = Math.ceil((system.length + user.length) / 3.2);
        const numPredict = Math.max(700, Math.min(this.MAX_OUTPUT_TOKENS, numCtx - promptTokens - 200));
        const params = {
            model: AgentService.model,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user }
            ],
            keep_alive: AgentService.keepAlive,
            think: false,
            options: { temperature: 0.3, repeat_penalty: 1.1, repeat_last_n: 256, num_predict: numPredict, num_ctx: numCtx },
            logTag: this.SOURCE,
            logDetail: 'All accounts'
        };
        let text = '';
        let lastPaint = 0;
        const onChunk = (chunk, event) => {
            if (event || typeof chunk !== 'string') return;
            text += chunk;
            this._partial = text;
            const now = Date.now();
            if (now - lastPaint > 400) { lastPaint = now; this._emit({ partial: text }); }
        };
        let response;
        try { response = await LLMLogger.callStream(this.SOURCE, params, onChunk); }
        catch (e) { return this._fail(e.message || String(e)); }
        if (response && response.error) return this._fail(String(response.error).slice(0, 300));
        const clean = text.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        if (!clean) return this._fail('The model returned no text.');
        const entry = { day: inputs.today, at: Date.now(), model: this._modelLabel(), text: clean, error: null, positions: sheet.positions, hasMarket: sheet.hasMarket, headlines: sheet.headlines };
        this.cache().entry = entry;
        this._save();
        this._emit({ entry });
        return entry;
    },

    // A failed day keeps the last good brief and records the error on it.
    _fail(error) {
        const prev = this.cache().entry;
        const entry = Object.assign({}, prev || { day: null, text: '' }, { error, errorAt: Date.now() });
        this.cache().entry = entry;
        this._save();
        this._emit({ entry });
        return { error, entry };
    },

    _emit(ev) { for (const fn of [...this._listeners]) { try { fn(ev); } catch { /* a listener is a courtesy */ } } },
    _listen(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); },

    /** BackgroundWork descriptor: null when idle. */
    writing() { return this._inflight ? { current: 'All accounts' } : null; },

    /**
     * What a chat opened from the brief is about: the text itself, so
     * "this brief" / "the market section" resolve without a tool call.
     * Null when there is no brief or the user did not come through the
     * pill (the overview block stays lean and points at the tool).
     */
    contextBlock() {
        if (!this.chatting) return null;
        const e = this.get();
        if (!e || !e.text) return null;
        const text = e.text.length > 12000 ? e.text.slice(0, 12000) + '\n…(truncated)' : e.text;
        return {
            // Shaped for AgentUI._deriveContextLabel: the floating pill reads
            // "Ask about this brief" (leading CURRENT and the parenthetical go).
            title: 'CURRENT BRIEF (today’s market and portfolio)',
            body: `The user opened this chat from the daily market-and-portfolio brief on Portfolio › All Accounts ("Ask about this brief"). "This brief", "it", or a section name means the text below, written ${this.isToday(e) ? 'today' : 'on ' + e.day} by ${e.model || 'their AI model'} from the app's own numbers and that day's quotes. Answer from it; use list_portfolio, get_ticker_detail, check_strategy or get_holdings_news only when they ask for something beyond it. Keep its stance: describe, never tell them what to trade.\n\n--- BRIEF ---\n${text}\n--- END BRIEF ---`,
            suggestedPrompts: [
                'What in this brief matters most for me?',
                'Explain the market section in plain terms',
                'Which of my positions drove today’s move?'
            ]
        };
    },

    /* ---------- rendering ---------- */

    _expanded() { try { return localStorage.getItem(this.EXPANDED_KEY) === '1'; } catch { return false; } },
    _setExpanded(on) { try { localStorage.setItem(this.EXPANDED_KEY, on ? '1' : '0'); } catch { /* per-Mac */ } },

    _dayLabel(day) {
        if (!day) return '';
        if (day === this.today()) return 'today';
        const y = new Date(); y.setDate(y.getDate() - 1);
        if (day === this.today(y)) return 'yesterday';
        return 'on ' + new Date(day + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    },
    _timeLabel(at) {
        if (!at) return '';
        try { return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); } catch { return ''; }
    },

    _html(md) {
        let html = (typeof AgentUI !== 'undefined' && typeof AgentUI.formatContent === 'function') ? AgentUI.formatContent(md) : `<p>${AppManager.escapeHtml(md)}</p>`;
        // The page's hide-values toggle blurs every dollar figure; prose is
        // no exception, or the toggle would be worth nothing here.
        if (PortfolioApp.hideValues) html = html.replace(/[-+]?\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:[KMBk]\b|million|billion))?/g, '••••');
        return html;
    },

    /**
     * Fill `#portfolio-brief` on the All Accounts page. Paints what is
     * cached, then asks for today's (auto when allowed), streaming into
     * place while the page still shows All Accounts.
     */
    renderForOverview() {
        const el = document.getElementById('portfolio-brief');
        if (!el) return;
        if (!this.hasPortfolio()) { el.innerHTML = ''; return; }
        if (!this.available()) {
            el.innerHTML = `<div class="portfolio-profile-head"><h4 class="portfolio-ticker-section-title">Today’s brief</h4></div><p class="portfolio-news-empty">A daily brief on the market and your portfolio appears here once an AI model is set up (Settings › AI Assistant).</p>`;
            return;
        }
        if (this._unlisten) { this._unlisten(); this._unlisten = null; }
        const paint = (state = {}) => {
            if (!el.isConnected || PortfolioApp.currentAccountFilter !== 'all') return;
            el.innerHTML = this._sectionHtml(state);
            this._bind(el);
        };
        const entry = this.get();
        const running = !!this._inflight;
        paint({ entry, partial: running ? this._partial : null, running });
        this._unlisten = this._listen((ev) => {
            if (ev.started) paint({ entry: this.get(), partial: '', running: true });
            else if (ev.partial != null) paint({ entry: this.get(), partial: ev.partial, running: true });
            else paint({ entry: ev.entry || this.get(), running: false });
        });
        if ((!this.isToday(entry) || !entry.text) && this.autoAllowed() && !running) {
            // A run that failed today is not retried on every repaint —
            // "Try again" is the retry.
            if (!(entry?.error && entry.errorAt && this.today(new Date(entry.errorAt)) === this.today())) {
                this.ensure().catch(() => {});
            }
        }
    },

    _sectionHtml({ entry, partial, running }) {
        const esc = AppManager.escapeHtml;
        const expanded = this._expanded();
        let meta = '', body = '', actions = '', dim = false;
        if (running) {
            meta = partial ? `Writing today’s brief with ${esc(this._modelLabel())}…` : 'Reading the numbers…';
            if (partial) body = this._html(partial);
            else if (entry?.text) { body = this._html(entry.text); dim = true; }
        } else if (entry?.text && this.isToday(entry)) {
            meta = `Written today at ${esc(this._timeLabel(entry.at))} by ${esc(entry.model || 'your AI model')}`;
            body = this._html(entry.text);
        } else if (entry?.text) {
            meta = `Written ${esc(this._dayLabel(entry.day))} by ${esc(entry.model || 'your AI model')}`;
            body = this._html(entry.text);
            dim = !this.autoAllowed();
        }
        const dest = this.destination();
        const withDest = dest ? ` with ${esc(dest)}` : '';
        if (!running && entry?.error && !(entry.text && this.isToday(entry))) {
            meta = `${meta ? meta + ' · ' : ''}Today’s brief could not be written: ${esc(entry.error)}`;
            actions = `<button type="button" class="portfolio-profile-btn" data-brief-retry>Try again</button>`;
        } else if (!running && !this.isToday(entry) && !this.autoAllowed()) {
            meta = meta || 'Not written yet';
            actions = `<button type="button" class="portfolio-profile-btn" data-brief-write>Write today’s brief${withDest}</button>`;
        } else if (!running && entry?.text) {
            // The on-demand door: a fresh read after the close, a trade, or
            // a change of plan. Names the destination when the brain leaves.
            actions = `<button type="button" class="portfolio-profile-btn" data-brief-rewrite title="Write a fresh brief from the latest numbers">Rewrite now${withDest}</button>`;
        }
        if (!body && !running && !actions) return '';
        const foldable = body && !running;
        const toggle = foldable ? `<button type="button" class="portfolio-profile-toggle" data-brief-toggle>${expanded ? 'Show less' : 'Read the full brief'}</button>` : '';
        // The chat door: the composer opens with the brief as its subject
        // (contextBlock). Only over a finished brief.
        if (entry?.text && !running) actions += `<button type="button" class="ask-prompt-btn ask-prompt-open portfolio-profile-ask" data-brief-ask>Ask about this brief&hellip;</button>`;
        return `
            <div class="portfolio-profile-head">
                <h4 class="portfolio-ticker-section-title">Today’s brief · market and portfolio</h4>
                <span class="portfolio-profile-meta">${meta}</span>
            </div>
            ${body ? `<div class="portfolio-profile-body feed-card-body${foldable && !expanded ? ' is-folded' : ''}${dim ? ' is-stale' : ''}">${body}</div>` : ''}
            ${(toggle || actions) ? `<div class="portfolio-profile-actions">${toggle}${actions}</div>` : ''}`;
    },

    _bind(el) {
        el.querySelector('[data-brief-toggle]')?.addEventListener('click', () => {
            this._setExpanded(!this._expanded());
            this.renderForOverview();
        });
        const write = (force) => () => {
            this.ensure({ manual: true, force }).catch(() => {});
            this.renderForOverview();
        };
        el.querySelector('[data-brief-write]')?.addEventListener('click', write(false));
        el.querySelector('[data-brief-retry]')?.addEventListener('click', write(false));
        el.querySelector('[data-brief-rewrite]')?.addEventListener('click', write(true));
        el.querySelector('[data-brief-ask]')?.addEventListener('click', () => {
            this.chatting = true;
            if (typeof AgentUI !== 'undefined') AgentUI.openComposer();
        });
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = PortfolioBrief;
