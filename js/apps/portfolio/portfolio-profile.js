/**
 * PortfolioProfile — the daily business profile of a ticker, written by the
 * user's AI model ONCE per calendar day and shown on the ticker page.
 *
 * What it teaches: what the company is, what it sells and how, who buys,
 * how sound the business is, where AI fits, whether the stock looks
 * expensive / fair / cheap, near- and long-term risks and value, the news,
 * a bottom line. A fund gets the fund shape of the same questions.
 *
 * Laws:
 *  - GROUNDED, not recalled. Every number the model may cite comes from a
 *    fact sheet built here from Yahoo's quoteSummary (price, valuation
 *    multiples, growth, margins, cash vs debt, analyst targets; holdings
 *    and expense ratio for a fund) plus the dated headlines PortfolioNews
 *    already caches. The prompt forbids invented figures and asks the model
 *    to say "not on the sheet" instead. The fact sheet builder is pure
 *    (`factSheet`) and pinned by tests/portfolio-profile-test.js.
 *  - ONCE A DAY. A profile is keyed by the local calendar day; opening the
 *    page again re-reads it. A failed run is retryable; a finished one is
 *    not re-asked until tomorrow. The old day's profile stays on screen
 *    (dimmed) while today's streams in.
 *  - MACHINE-LOCAL. The cache is localStorage `portfolio-profile-cache`,
 *    never the synced portfolio blob (the volatile-data law): a model's
 *    daily text must never re-stamp the blob the user's edits ride on.
 *  - CONSENT follows DocTidy: it runs on its own when the brain is on this
 *    Mac or CloudPrivacy allows the Portfolio class to leave (the same gate
 *    ambient portfolio reads use — a held symbol IS a holding); otherwise
 *    the page shows a button naming the destination, and the click is the
 *    consent. Every run lands in LLM Logs like any other call.
 *  - THE SWEEP is quiet and yields. When Portfolio (or its home card) is
 *    opened, held and watched symbols missing today's profile are written
 *    one at a time, waiting while the assistant is streaming, and only on
 *    an unmetered brain — a metered key writes profiles on open only, one
 *    page at a time. BackgroundWork lists it as resumable: each finished
 *    profile persists and the sweep resumes on the next visit.
 *  - The profile is ABOUT THE COMPANY. The user's position, cost basis and
 *    accounts are not in the prompt.
 *  - THE OWNER CAN CORRECT IT. A ticker is a decision host (RecordTypes
 *    'ticker', key `ticker:<SYMBOL>`): `correct_ticker_profile` saves the
 *    user's correction as a Decision and rewrites today's profile around
 *    every active note (`ensure(…, {force: true})`, the one exception to
 *    once-a-day); tomorrow's write reads the same notes, so a correction
 *    outlives the profile it fixed. `ownerNotesBlock` is the prompt seam.
 */
const PortfolioProfile = {
    SOURCE: 'portfolio-profile',
    CACHE_KEY: 'portfolio-profile-cache',
    EXPANDED_KEY: 'portfolio-profile-expanded',
    HEADLINES: 8,
    SWEEP_MAX: 40,          // symbols per daily sweep (holdings by weight, then watchlist)
    SWEEP_DELAY_MS: 8000,   // let the page settle before the first model call
    CHAT_POLL_MS: 5000,
    MAX_OUTPUT_TOKENS: 3500,
    FUND_TYPES: ['ETF', 'MUTUALFUND', 'INDEX', 'MONEYMARKET'],
    EQUITY_MODULES: 'assetProfile,quoteType,price,summaryDetail,defaultKeyStatistics,financialData',
    FUND_MODULES: 'assetProfile,quoteType,price,summaryDetail,defaultKeyStatistics,fundProfile,topHoldings',

    _cache: null,
    // Set by "Ask about this profile…": the subject whose profile text the
    // page's AgentContext provider hands the chat (contextBlock()). Cleared
    // when another symbol's page renders or the ticker page closes.
    chatting: null,
    _inflight: new Map(),   // subject -> Promise<entry>
    _partial: new Map(),    // subject -> text so far
    _listeners: new Map(),  // subject -> Set<fn>
    _sweep: null,           // { queue: [], current, done, total } while running
    _sweepTimer: null,

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

    /** The symbol a profile is about: an option contract reads as its underlying. */
    _subject(ticker) {
        if (!ticker || ticker === '__CASH__') return null;
        return PortfolioApp.optionMeta(ticker)?.underlying || String(ticker).toUpperCase();
    },

    /** The stored profile for a symbol, any day, or null. */
    get(ticker) {
        const s = this._subject(ticker);
        return s ? (this.cache()[s] || null) : null;
    },
    isToday(entry) { return !!entry && entry.day === this.today(); },

    /* ---------- policy (the DocTidy shape) ---------- */

    available() {
        return typeof AgentService !== 'undefined' && !!AgentService.model
            && typeof LLMLogger !== 'undefined' && typeof LLMLogger.callStream === 'function';
    },

    /** May a profile be written without a click? */
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

    /** Chat's own context size for the default brain (see AgentService.entryNumCtx). */
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

    _v(x) {
        if (x == null) return null;
        if (typeof x === 'object') return x.fmt != null ? x.fmt : (x.raw != null ? x.raw : null);
        return x;
    },
    _raw(x) {
        if (x == null) return null;
        if (typeof x === 'object') return x.raw != null ? x.raw : null;
        return x;
    },
    _isFund(type) { return !!type && this.FUND_TYPES.includes(String(type).toUpperCase()); },

    /**
     * Turn a Yahoo quoteSummary result (+ headlines) into the lines the
     * model is allowed to cite. Missing modules are simply absent; the
     * prompt tells the model to say so rather than fill in.
     */
    factSheet(summary, { ticker, today, headlines = [], ago = null } = {}) {
        const s = summary || {};
        const v = (x) => this._v(x);
        const price = s.price || {}, sd = s.summaryDetail || {}, ks = s.defaultKeyStatistics || {};
        const fd = s.financialData || {}, ap = s.assetProfile || {}, qt = s.quoteType || {};
        const fp = s.fundProfile || {}, th = s.topHoldings || {};
        const type = qt.quoteType || price.quoteType || null;
        const fund = this._isFund(type);
        const name = qt.longName || price.longName || qt.shortName || price.shortName || ticker;
        const lines = [];
        const add = (label, val, suffix = '') => { const x = v(val); if (x != null && x !== '' && x !== 'N/A') lines.push(`- ${label}: ${x}${suffix}`); };
        const section = (title) => { lines.push('', `${title}:`); };

        lines.push(`Symbol: ${ticker}`, `Name: ${name}`, `Date: ${today}`);
        add('Type', fund ? `${type} (fund)` : (type || 'EQUITY'));
        add('Exchange', price.exchangeName);
        add('Currency', price.currency);
        if (!fund) {
            add('Sector', ap.sector); add('Industry', ap.industry); add('Country', ap.country);
            add('Employees', ap.fullTimeEmployees);
            const ceo = (ap.companyOfficers || []).find(o => /chief executive|\bceo\b/i.test(o.title || ''));
            if (ceo?.name) add('CEO', ceo.name);
        } else {
            add('Fund family', fp.family); add('Category', fp.categoryName); add('Legal type', fp.legalType);
            add('Expense ratio', fp.feesExpensesInvestment?.annualReportExpenseRatio);
            add('Total net assets', sd.totalAssets);
            add('Inception', ks.fundInceptionDate);
        }

        section('Price and market');
        add('Price', price.regularMarketPrice);
        add('Day change', price.regularMarketChangePercent);
        add('Market cap', price.marketCap);
        add('52-week low', sd.fiftyTwoWeekLow); add('52-week high', sd.fiftyTwoWeekHigh);
        add('52-week change', ks['52WeekChange']); add('S&P 500 52-week change', ks.SandP52WeekChange);
        add('Beta', sd.beta);
        add('Average volume', sd.averageVolume);
        if (fund) { add('Yield', sd.yield); add('YTD return', sd.ytdReturn); add('3-year average return', ks.threeYearAverageReturn); add('5-year average return', ks.fiveYearAverageReturn); }

        if (!fund) {
            section('Valuation');
            add('Trailing P/E', sd.trailingPE); add('Forward P/E', sd.forwardPE);
            add('PEG ratio', ks.pegRatio);
            add('Price to sales (TTM)', sd.priceToSalesTrailing12Months);
            add('Price to book', ks.priceToBook);
            add('EV / EBITDA', ks.enterpriseToEbitda); add('EV / revenue', ks.enterpriseToRevenue);
            add('Dividend yield', sd.dividendYield); add('Payout ratio', sd.payoutRatio);
            add('Trailing EPS', ks.trailingEps); add('Forward EPS', ks.forwardEps);

            section('Business health (trailing twelve months unless noted)');
            add('Revenue', fd.totalRevenue); add('Revenue growth (yoy)', fd.revenueGrowth);
            add('Earnings growth (yoy)', fd.earningsGrowth); add('Quarterly earnings growth (yoy)', ks.earningsQuarterlyGrowth);
            add('Gross margin', fd.grossMargins); add('Operating margin', fd.operatingMargins); add('Profit margin', fd.profitMargins);
            add('EBITDA', fd.ebitda);
            add('Operating cash flow', fd.operatingCashflow); add('Free cash flow', fd.freeCashflow);
            add('Cash', fd.totalCash); add('Debt', fd.totalDebt); add('Debt to equity', fd.debtToEquity);
            add('Current ratio', fd.currentRatio);
            add('Return on equity', fd.returnOnEquity); add('Return on assets', fd.returnOnAssets);
            add('Institutional ownership', ks.heldPercentInstitutions); add('Short interest (% of float)', ks.shortPercentOfFloat);

            section('Analysts');
            add('Consensus', fd.recommendationKey); add('Analysts covering', fd.numberOfAnalystOpinions);
            add('Mean price target', fd.targetMeanPrice); add('Low target', fd.targetLowPrice); add('High target', fd.targetHighPrice);
        } else {
            const holds = (th.holdings || []).slice(0, 15).map(h => `${h.holdingName || h.symbol}${h.symbol ? ` (${h.symbol})` : ''} ${this._raw(h.holdingPercent) != null ? this._pct(this._raw(h.holdingPercent)) : ''}`.trim());
            if (holds.length) { section('Top holdings'); holds.forEach(h => lines.push(`- ${h}`)); }
            const sectors = (th.sectorWeightings || []).flatMap(o => Object.entries(o || {})).map(([k, val]) => ({ k, w: this._raw(val) })).filter(x => x.w != null && Number(x.w) > 0.005).sort((a, b) => Number(b.w) - Number(a.w)).slice(0, 8);
            if (sectors.length) { section('Sector weights'); sectors.forEach(x => lines.push(`- ${x.k.replace(/_/g, ' ')}: ${this._pct(x.w)}`)); }
            const eq = th.equityHoldings || {};
            if (Object.keys(eq).length) {
                section('Valuation of the holdings');
                add('Price to earnings', eq.priceToEarnings); add('Price to book', eq.priceToBook);
                add('Price to sales', eq.priceToSales); add('Price to cash flow', eq.priceToCashflow);
                add('Median market cap', eq.medianMarketCap);
            }
        }

        if (ap.longBusinessSummary) { section('Description (Yahoo Finance)'); lines.push(String(ap.longBusinessSummary).slice(0, 1800)); }
        if (ap.website) add('Website', ap.website);

        if (headlines.length) {
            section('Recent headlines (dated, sourced — the only news you may mention)');
            headlines.forEach(h => {
                const when = ago ? ago(h.publishedAt) : (h.publishedAt ? new Date(h.publishedAt).toISOString().slice(0, 10) : '');
                lines.push(`- ${h.title}${h.source ? ` — ${h.source}` : ''}${when ? ` (${when})` : ''}`);
            });
        }
        return { name, type, fund, text: lines.join('\n') };
    },

    _pct(x) {
        const n = Number(x);
        if (!isFinite(n)) return String(x);
        return (n <= 1 ? n * 100 : n).toFixed(1) + '%';
    },

    /* ---------- prompts ---------- */

    _systemPrompt(fund) {
        const sections = fund ? [
            'What it is — one paragraph: what kind of fund this is, who runs it, what it is designed to do, what index or strategy it follows.',
            'What it holds — the holdings and sectors from the fact sheet, what they have in common, how concentrated it is.',
            'How it works — structure, the expense ratio and what it costs per $10,000, distributions and yield, how it tracks or trades.',
            'Who it is for — the investor and the role it plays in a portfolio (core, satellite, income, hedge).',
            'How sound it is — assets, age, cost versus the category, tracking, liquidity; verdict: strong / sound / mixed / fragile, and why.',
            'Where AI fits — how exposed the holdings are to AI trends (as builders, beneficiaries, or unrelated), and how much that drives the fund.',
            'Is it expensive, cheap, or in between — the expense ratio against what is typical for this category, and the valuation of the holdings where the sheet gives it. One word — Expensive / Fair / Cheap — with the reasoning, or say the sheet cannot answer it.',
            'Near-term risks (next 12 months) — bullets.',
            'Long-term risks (3–10 years) — bullets.',
            'Near-term value — what could go right in the next 12 months.',
            'Long-term value — the durable case for owning it.',
            'In the news — ONLY the headlines on the fact sheet, what they suggest, each with its age. Omit the whole section when none are listed.',
            'Bottom line — three or four sentences an investor can carry away.'
        ] : [
            'What the company is — one paragraph: what it is, where it came from, what it is known for.',
            'What they sell — the products and services, and roughly which matter most to revenue.',
            'How they sell — the business model: how the money is made (hardware, subscriptions, ads, licensing, services…), the channels, pricing power, recurring versus one-time revenue.',
            'Who their customers are — the primary customer segments, concentration, geography.',
            'How sound the business is — read the fact sheet: growth, margins, cash generation, balance sheet (cash against debt), returns on capital. Say in one clause what each number means. Verdict: strong / sound / mixed / fragile, and why.',
            'Where AI fits — the company\'s real relationship to AI trends: builder, supplier, beneficiary, customer, threatened, or largely unrelated. Be specific and skeptical of hype.',
            'Is the stock expensive, cheap, or in between — use the valuation multiples on the fact sheet (trailing and forward P/E, PEG, EV/EBITDA, price to sales, price to book, dividend yield) against what is typical for its growth and industry, and the analyst targets against the price. One word — Expensive / Fair / Cheap — with the reasoning, or say the sheet cannot answer it.',
            'Near-term risks (next 12 months) — bullets.',
            'Long-term risks (3–10 years) — bullets.',
            'Near-term value — what could go right in the next 12 months.',
            'Long-term value — the durable case for owning it.',
            'In the news — ONLY the headlines on the fact sheet, what they suggest, each with its age. Omit the whole section when none are listed.',
            'Bottom line — three or four sentences an investor can carry away.'
        ];
        return [
            `You are a patient investment educator writing a complete business profile of one ${fund ? 'fund' : 'publicly traded company'} for an individual investor who wants to understand what they own. Write in plain, precise English, in Markdown.`,
            'Use exactly these sections, in this order. Each heading is "## " followed by the section title (the words before the dash below); the text after the dash says what the section covers:',
            ...sections.map((s, i) => `${i + 1}. ${s}`),
            '',
            'Rules:',
            '- Every number, date and quote you cite must come from the fact sheet. Never invent a figure. When a figure is not on the sheet, say that plainly instead of guessing.',
            '- Your general knowledge of the company is welcome in the qualitative sections; where something may have changed since your training, say "as of my knowledge" rather than presenting it as current.',
            '- Interpret the fact sheet; do not restate it as a list. No tables. No bullet list longer than six items.',
            '- No disclaimers, no "consult a financial advisor", no offers to help further. Do not address the reader\'s own position; you do not know it.',
            '- If an OWNER\'S CORRECTIONS AND NOTES block follows the fact sheet, treat each note as a standing instruction from the investor: fold it into the relevant section naturally (do not list the notes, do not say "the owner says"), and let it override your general knowledge.',
            '- Never repeat a sentence you have already written. When the profile is complete, stop.'
        ].join('\n');
    },

    /* ---------- the owner's corrections (Decisions on the ticker) ---------- */

    /** Active decisions on the symbol, newest first ([] without the store). */
    ownerNotes(subject) {
        if (typeof DecisionStore === 'undefined') return [];
        try { return DecisionStore.listFor(`ticker:${subject}`); } catch { return []; }
    },

    /**
     * The block the model is handed after the fact sheet: what the owner
     * corrected or asked for. Pure over the decision list (Node-tested).
     * Newest first, capped, each on one line — a note is a standing
     * instruction, not prose to be quoted.
     */
    ownerNotesBlock(notes, { max = 12, chars = 400 } = {}) {
        const list = (notes || []).filter(n => n && (n.body || '').trim()).slice(0, max);
        if (!list.length) return '';
        const lines = list.map(n => {
            const t = (n.title || '').trim(), b = (n.body || '').trim();
            const text = (t && t.toLowerCase() !== b.toLowerCase()) ? `${t}: ${b}` : b;
            return `- ${text.length > chars ? text.slice(0, chars) + '…' : text}`;
        });
        return ['OWNER\'S CORRECTIONS AND NOTES (from the investor who owns this profile — they outrank your general knowledge; write the profile so it reflects each one, and where a note contradicts the fact sheet say plainly which you followed and why):', ...lines].join('\n');
    },

    /* ---------- inputs ---------- */

    async _summary(subject) {
        const yahoo = subject.replace(/\./g, '-');
        const fetchMods = async (mods) => {
            try { return await window.electronNet.fetchYahooQuoteSummary(yahoo, mods); } catch { return null; }
        };
        // The wide set first — Yahoo omits modules a symbol lacks, and one
        // call serves both shapes; the narrow equity set is the retry.
        let s = await fetchMods(`${this.EQUITY_MODULES},fundProfile,topHoldings`);
        if (!s) s = await fetchMods(this.EQUITY_MODULES);
        if (!s) s = await fetchMods('assetProfile,quoteType,price');
        return s;
    },

    async _headlines(subject) {
        if (typeof PortfolioNews === 'undefined' || !(await this._webOn())) return [];
        try {
            const r = await PortfolioNews.headlines({ tickers: [subject], limit: this.HEADLINES });
            return (r.items || []).slice(0, this.HEADLINES);
        } catch { return []; }
    },

    /* ---------- the run ---------- */

    /**
     * Today's profile for `ticker`: the cached one when it exists, else one
     * run of the model. `manual: true` is a click (consent given); without
     * it the auto gate applies. `force: true` rewrites today's even when it
     * exists (an owner correction). Resolves the cache entry, or {error}.
     */
    async ensure(ticker, { manual = false, force = false } = {}) {
        const subject = this._subject(ticker);
        if (!subject) return { error: 'Nothing to profile.' };
        const have = this.cache()[subject];
        // `force` is the one exception to once-a-day: the owner corrected
        // the profile (correct_ticker_profile) and it is rewritten now.
        if (!force && this.isToday(have) && have.text) return have;
        if (this._inflight.has(subject)) return this._inflight.get(subject);
        if (!this.available()) return { error: 'No AI model is set up (Settings › AI Assistant).' };
        if (!manual && !this.autoAllowed()) return { error: 'Portfolio data may not leave this Mac on its own.', needsConsent: true };
        const run = this._generate(subject).finally(() => { this._inflight.delete(subject); this._partial.delete(subject); });
        this._inflight.set(subject, run);
        return run;
    },

    async _generate(subject) {
        const today = this.today();
        const [summary, headlines] = await Promise.all([this._summary(subject), this._headlines(subject)]);
        if (!summary) return this._fail(subject, 'Company data could not be fetched from Yahoo Finance right now.');
        const ago = (typeof PortfolioNews !== 'undefined' && PortfolioNews._ago) ? (ts) => PortfolioNews._ago(ts) : null;
        const sheet = this.factSheet(summary, { ticker: subject, today, headlines, ago });
        const notes = this.ownerNotes(subject);
        const notesBlock = this.ownerNotesBlock(notes);
        const system = this._systemPrompt(sheet.fund);
        const user = `Today is ${today}. Write the business profile for ${sheet.name} (${subject}).\n\nFACT SHEET (Yahoo Finance, ${today}):\n${sheet.text}${notesBlock ? `\n\n${notesBlock}` : ''}`;
        // The SAME context size chat and prewarm send: llama-server binds
        // one process to one (model, ctx) pair and a different num_ctx here
        // would reload the model (~60 s) on every alternation with chat. The
        // output budget fits inside it instead of stretching it.
        const numCtx = this._numCtx();
        const promptTokens = Math.ceil((system.length + user.length) / 3.2);
        const numPredict = Math.max(800, Math.min(this.MAX_OUTPUT_TOKENS, numCtx - promptTokens - 200));
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
            logDetail: subject
        };
        let text = '';
        let lastPaint = 0;
        const onChunk = (chunk, event) => {
            if (event || typeof chunk !== 'string') return;
            text += chunk;
            this._partial.set(subject, text);
            const now = Date.now();
            if (now - lastPaint > 400) { lastPaint = now; this._emit(subject, { partial: text }); }
        };
        let response;
        try { response = await LLMLogger.callStream(this.SOURCE, params, onChunk); }
        catch (e) { return this._fail(subject, e.message || String(e)); }
        if (response && response.error) return this._fail(subject, String(response.error).slice(0, 300));
        const clean = text.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        if (!clean) return this._fail(subject, 'The model returned no text.');
        const entry = { day: today, at: Date.now(), model: this._modelLabel(), name: sheet.name, fund: sheet.fund, text: clean, error: null, corrections: notes.length };
        this.cache()[subject] = entry;
        this._save();
        this._emit(subject, { entry });
        return entry;
    },

    // A failed day keeps the last good profile and records the error on
    // it, so the page can show both "written yesterday" and "try again".
    _fail(subject, error) {
        const prev = this.cache()[subject];
        const entry = Object.assign({}, prev || { day: null, text: '' }, { error, errorAt: Date.now() });
        this.cache()[subject] = entry;
        this._save();
        this._emit(subject, { entry });
        return { error, entry };
    },

    _emit(subject, ev) {
        const set = this._listeners.get(subject);
        if (!set) return;
        for (const fn of [...set]) { try { fn(ev); } catch { /* a listener is a courtesy */ } }
    },
    _listen(subject, fn) {
        if (!this._listeners.has(subject)) this._listeners.set(subject, new Set());
        this._listeners.get(subject).add(fn);
        return () => this._listeners.get(subject)?.delete(fn);
    },

    /* ---------- the daily sweep ---------- */

    /** Held symbols by weight, then the watchlist; options as underlyings, cash out. */
    sweepTickers() {
        const seen = new Set(); const out = [];
        const push = (t) => { const s = this._subject(t); if (s && !seen.has(s)) { seen.add(s); out.push(s); } };
        PortfolioApp.computeHoldings().slice().sort((a, b) => (b.currentValue || 0) - (a.currentValue || 0)).forEach(h => push(h.ticker));
        (PortfolioApp.getWatchlist?.() || []).forEach(w => push(w.ticker));
        return out.slice(0, this.SWEEP_MAX);
    },

    /** Ask for today's sweep, soon. Idempotent: a second call only re-checks. */
    scheduleSweep() {
        if (this._sweep || this._sweepTimer) return;
        if (!this.autoAllowed()) return;
        if (typeof AgentService !== 'undefined' && AgentService.isMeteredBrain?.()) return;
        this._sweepTimer = setTimeout(() => { this._sweepTimer = null; this.sweep().catch(() => {}); }, this.SWEEP_DELAY_MS);
    },

    async sweep() {
        if (this._sweep) return;
        try { PortfolioApp.loadData?.(); } catch { /* the page's own data is fine */ }
        const missing = this.sweepTickers().filter(s => !this.isToday(this.cache()[s]) || !this.cache()[s]?.text);
        const briefMissing = typeof PortfolioBrief !== 'undefined' && PortfolioBrief.hasPortfolio() && !(PortfolioBrief.isToday(PortfolioBrief.get()) && PortfolioBrief.get().text);
        if (!missing.length && !briefMissing) return;
        this._sweep = { queue: missing.slice(), current: null, done: 0, total: missing.length };
        try {
            // The whole-portfolio brief goes first: one call, the page the
            // user reads first, and a home visit is enough to produce it.
            if (typeof PortfolioBrief !== 'undefined' && this.autoAllowed()) {
                await this._waitForQuietChat();
                await PortfolioBrief.ensure().catch(() => {});
            }
            while (this._sweep.queue.length) {
                if (!this.autoAllowed() || AgentService.isMeteredBrain?.()) break;   // the gate can change mid-sweep
                await this._waitForQuietChat();
                const s = this._sweep.queue.shift();
                this._sweep.current = s;
                // The page may have written it meanwhile; ensure() returns that.
                await this.ensure(s).catch(() => {});
                this._sweep.done++;
            }
        } finally { this._sweep = null; }
    },

    async _waitForQuietChat() {
        for (let i = 0; i < 120; i++) {   // ten minutes at most, then go anyway
            let busy = false;
            try { busy = (AgentService.getActiveStreamingConvIds?.() || []).length > 0; } catch { busy = false; }
            if (!busy) return;
            await new Promise(r => setTimeout(r, this.CHAT_POLL_MS));
        }
    },

    /** BackgroundWork descriptor: null when idle. */
    sweeping() {
        if (this._sweep) {
            const left = this._sweep.total - this._sweep.done;
            return { left, current: this._sweep.current };
        }
        if (this._inflight.size) return { left: this._inflight.size, current: [...this._inflight.keys()][0] };
        return null;
    },

    /**
     * What a chat opened from the profile is about: the text itself, so
     * "this profile" / "the valuation section" resolve without a tool
     * call. Null unless the user came through the pill for THIS symbol.
     */
    contextBlock(ticker) {
        const subject = this._subject(ticker);
        if (!subject || this.chatting !== subject) return null;
        const e = this.cache()[subject];
        if (!e || !e.text) return null;
        const text = e.text.length > 12000 ? e.text.slice(0, 12000) + '\n…(truncated)' : e.text;
        const label = PortfolioApp.displayTicker(subject);
        return {
            // Shaped for AgentUI._deriveContextLabel: the floating pill reads
            // "Ask about this profile" (leading CURRENT and the parenthetical go).
            title: `CURRENT PROFILE (${label}’s business profile, written today)`,
            body: `The user opened this chat from the business profile on the ${label} page ("Ask about this profile"). "This profile", "it", or a section name means the text below, written ${this.isToday(e) ? 'today' : 'on ' + e.day} by ${e.model || 'their AI model'} from that day's Yahoo Finance fact sheet. Answer from it; use get_ticker_detail or get_holdings_news only for what it does not cover. When they correct something in it, call correct_ticker_profile.\n\n--- PROFILE ---\n${text}\n--- END PROFILE ---`,
            suggestedPrompts: [
                `Summarize the case for and against ${label}`,
                'What does the valuation section mean for me?',
                'Which risk here is the most likely?'
            ]
        };
    },

    /* ---------- rendering ---------- */

    _expanded() { try { return localStorage.getItem(this.EXPANDED_KEY) === '1'; } catch { return false; } },
    _setExpanded(on) { try { localStorage.setItem(this.EXPANDED_KEY, on ? '1' : '0'); } catch { /* per-Mac */ } },

    _dayLabel(day) {
        if (!day) return '';
        const today = this.today();
        if (day === today) return 'today';
        const y = new Date(); y.setDate(y.getDate() - 1);
        if (day === this.today(y)) return 'yesterday';
        const d = new Date(day + 'T12:00:00');
        return 'on ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    },

    _html(md) {
        if (typeof AgentUI !== 'undefined' && typeof AgentUI.formatContent === 'function') return AgentUI.formatContent(md);
        return `<p>${AppManager.escapeHtml(md)}</p>`;
    },

    /**
     * Fill the ticker page's profile section. Paints what is cached, then
     * asks for today's (auto when allowed), streaming into place while the
     * page is still showing this symbol.
     */
    renderForTicker(ticker) {
        const el = document.getElementById('portfolio-ticker-profile');
        if (!el) return;
        const subject = this._subject(ticker);
        if (!subject) { el.innerHTML = ''; return; }
        // A chat about one symbol's profile does not follow to the next.
        if (this.chatting && this.chatting !== subject) this.chatting = null;
        if (!this.available()) {
            el.innerHTML = `<h4 class="portfolio-ticker-section-title">Business profile</h4><p class="portfolio-news-empty">A daily business profile of ${AppManager.escapeHtml(PortfolioApp.displayTicker(subject))} appears here once an AI model is set up (Settings › AI Assistant).</p>`;
            return;
        }
        if (this._unlisten) { this._unlisten(); this._unlisten = null; }
        const paint = (state = {}) => {
            if (!el.isConnected || PortfolioApp.viewingTicker !== ticker) return;
            el.innerHTML = this._sectionHtml(subject, state);
            this._bind(el, subject, ticker);
        };
        const entry = this.cache()[subject] || null;
        const running = this._inflight.has(subject);
        paint({ entry, partial: running ? (this._partial.get(subject) || '') : null, running });
        this._unlisten = this._listen(subject, (ev) => {
            if (ev.partial != null) paint({ entry: this.cache()[subject] || null, partial: ev.partial, running: true });
            else paint({ entry: ev.entry || this.cache()[subject] || null, running: false });
        });
        if (!this.isToday(entry) || !entry.text) {
            if (this.autoAllowed() && !running) {
                // A run that failed today is not retried on every repaint —
                // the "Try again" button is the retry.
                if (!(entry?.error && entry.errorAt && this.today(new Date(entry.errorAt)) === this.today())) {
                    this.ensure(ticker).then(() => paint({ entry: this.cache()[subject] || null, running: false })).catch(() => {});
                    paint({ entry, partial: '', running: true });
                }
            }
        }
    },

    _sectionHtml(subject, { entry, partial, running }) {
        const esc = AppManager.escapeHtml;
        const label = PortfolioApp.displayTicker(subject);
        const expanded = this._expanded();
        let meta = '', body = '', actions = '', dim = false;
        if (running) {
            meta = partial ? `Writing today’s profile with ${esc(this._modelLabel())}…` : 'Reading the numbers…';
            if (partial) body = this._html(partial);
            else if (entry?.text) { body = this._html(entry.text); dim = true; }
        } else if (entry?.text && this.isToday(entry)) {
            const c = entry.corrections || 0;
            meta = `Written today by ${esc(entry.model || 'your AI model')}${c ? (c === 1 ? ' · reflects your note' : ` · reflects ${c} of your notes`) : ''} · refreshes once a day`;
            body = this._html(entry.text);
        } else if (entry?.text) {
            meta = `Written ${esc(this._dayLabel(entry.day))} by ${esc(entry.model || 'your AI model')}`;
            body = this._html(entry.text);
            dim = !this.autoAllowed();
        }
        if (!running && entry?.error && !(entry.text && this.isToday(entry))) {
            meta = `${meta ? meta + ' · ' : ''}Today’s profile could not be written: ${esc(entry.error)}`;
            actions = `<button type="button" class="portfolio-profile-btn" data-profile-retry>Try again</button>`;
        } else if (!running && !this.isToday(entry) && !this.autoAllowed()) {
            const dest = this.destination();
            meta = meta || 'Not written yet';
            actions = `<button type="button" class="portfolio-profile-btn" data-profile-write>Write today’s profile${dest ? ` with ${esc(dest)}` : ''}</button>`;
        }
        if (!body && !running && !actions) return '';
        const foldable = body && !running;
        const toggle = foldable ? `<button type="button" class="portfolio-profile-toggle" data-profile-toggle>${expanded ? 'Show less' : 'Read the full profile'}</button>` : '';
        // The chat door: the composer opens with the profile as its subject
        // (contextBlock). Only over a finished profile.
        if (entry?.text && !running) actions += `<button type="button" class="ask-prompt-btn ask-prompt-open portfolio-profile-ask" data-profile-ask>Ask about this profile&hellip;</button>`;
        return `
            <div class="portfolio-profile-head">
                <h4 class="portfolio-ticker-section-title">Business profile · ${esc(label)}</h4>
                <span class="portfolio-profile-meta">${meta}</span>
            </div>
            ${body ? `<div class="portfolio-profile-body feed-card-body${foldable && !expanded ? ' is-folded' : ''}${dim ? ' is-stale' : ''}">${body}</div>` : ''}
            ${(toggle || actions) ? `<div class="portfolio-profile-actions">${toggle}${actions}</div>` : ''}`;
    },

    _bind(el, subject, ticker) {
        el.querySelector('[data-profile-toggle]')?.addEventListener('click', () => {
            this._setExpanded(!this._expanded());
            this.renderForTicker(ticker);
        });
        const write = () => {
            this.ensure(ticker, { manual: true }).catch(() => {});
            this.renderForTicker(ticker);
        };
        el.querySelector('[data-profile-write]')?.addEventListener('click', write);
        el.querySelector('[data-profile-retry]')?.addEventListener('click', write);
        el.querySelector('[data-profile-ask]')?.addEventListener('click', () => {
            this.chatting = subject;
            if (typeof AgentUI !== 'undefined') AgentUI.openComposer();
        });
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = PortfolioProfile;
