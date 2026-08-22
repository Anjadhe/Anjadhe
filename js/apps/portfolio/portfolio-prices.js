/**
 * Portfolio Price Fetcher
 * Fetches stock prices via Yahoo Finance v8 API
 */

const PriceFetcher = {
    CACHE_TTL: 5 * 60 * 1000, // 5 minutes

    /**
     * Fetch prices for multiple tickers
     * @param {string[]} tickers - Array of stock ticker symbols
     * @param {Object} priceCache - Existing price cache
     * @returns {Object} Updated price cache
     */
    async fetchPrices(tickers, priceCache = {}) {
        if (!tickers || tickers.length === 0) return priceCache;

        const now = Date.now();
        const staleTickers = tickers.filter(ticker => {
            const cached = priceCache[ticker];
            return !cached || (now - cached.updatedAt > this.CACHE_TTL);
        });

        if (staleTickers.length === 0) return priceCache;

        const updated = { ...priceCache };

        // One batched main-process v7 quote first — the only Yahoo endpoint
        // that carries pre/post-market session data (`after` on the entry).
        // Anything it doesn't cover falls through to the per-ticker
        // chart/option-chain path below.
        let remaining = staleTickers;
        if (typeof window !== 'undefined' && typeof window.electronNet?.fetchYahooQuotes === 'function') {
            const batch = await window.electronNet.fetchYahooQuotes(
                staleTickers.map(t => t.replace(/\./g, '-'))
            );
            if (batch) {
                remaining = [];
                staleTickers.forEach(ticker => {
                    const q = batch[ticker.toUpperCase().replace(/\./g, '-')];
                    if (q) {
                        updated[ticker.toUpperCase()] = {
                            price: q.price,
                            change: q.change,
                            changePercent: q.changePercent,
                            updatedAt: now,
                            ...(q.after ? { after: q.after } : {})
                        };
                    } else {
                        remaining.push(ticker);
                    }
                });
            }
        }

        const results = await Promise.all(
            remaining.map(ticker => this.fetchSingle(ticker))
        );

        results.forEach(result => {
            if (result) {
                updated[result.ticker] = {
                    price: result.price,
                    change: result.change,
                    changePercent: result.changePercent,
                    updatedAt: now
                };
                // Interpolated option mark, not a market quote — the UI
                // renders these with a ~ so they read as estimates.
                if (result.estimated) updated[result.ticker].estimated = true;
            }
        });

        return updated;
    },

    /**
     * Fetch price for a single ticker
     * @param {string} ticker
     * @returns {Object|null}
     */
    async fetchSingle(ticker) {
        try {
            // Yahoo Finance uses hyphens for share classes (BRK.B -> BRK-B)
            const yahooTicker = ticker.replace(/\./g, '-');
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}?interval=1d&range=1d`;
            const response = await fetch(url);

            if (response.ok) {
                const data = await response.json();
                const result = data?.chart?.result?.[0];
                if (result) {
                    const meta = result.meta;
                    const price = meta.regularMarketPrice;
                    const previousClose = meta.chartPreviousClose || meta.previousClose;
                    const change = previousClose ? price - previousClose : 0;
                    const changePercent = previousClose ? (change / previousClose) * 100 : 0;

                    return {
                        ticker: ticker.toUpperCase(),
                        price,
                        change,
                        changePercent
                    };
                }
            }

            // Option contracts: the chart endpoint only carries some of
            // them. Fall back to the main-process Yahoo option quote —
            // direct contract quote first, then a mark interpolated between
            // the adjacent quoted strikes (flagged estimated).
            if (typeof PortfolioApp !== 'undefined' && PortfolioApp.optionMeta?.(ticker)
                && typeof window.electronNet?.fetchYahooOptionQuote === 'function') {
                const opt = await window.electronNet.fetchYahooOptionQuote(ticker);
                if (opt?.price > 0) {
                    return {
                        ticker: ticker.toUpperCase(),
                        price: opt.price,
                        change: opt.change || 0,
                        changePercent: opt.changePercent || 0,
                        estimated: !!opt.estimated
                    };
                }
            }
            return null;
        } catch (error) {
            console.error(`Failed to fetch price for ${ticker}:`, error);
            return null;
        }
    },

    /**
     * Symbol search (watchlist "Add ticker") via Yahoo's search endpoint —
     * same query1 host the chart endpoint uses, so no new network surface.
     * Returns [] for no matches; null when the endpoint itself failed, so
     * the caller can offer "add the symbol as typed" instead of a dead end.
     */
    async searchSymbols(query) {
        try {
            const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0&listsCount=0`;
            const response = await fetch(url);
            if (!response.ok) return null;
            const data = await response.json();
            return (data?.quotes || [])
                .filter(q => q.symbol && q.quoteType !== 'OPTION' && q.quoteType !== 'FUTURE')
                .map(q => ({
                    symbol: String(q.symbol).toUpperCase(),
                    name: q.shortname || q.longname || '',
                    exchange: q.exchDisp || q.exchange || ''
                }));
        } catch (error) {
            return null;
        }
    },

    /**
     * Real market price history for the ticker detail chart. The chart used
     * to plot only this app's own daily snapshots (prices tracked since the
     * position was added); this asks Yahoo's chart endpoint for the actual
     * series. Interval widens with the window so long ranges stay light.
     * Returns [{date: 'YYYY-MM-DD', price}] or null on failure.
     */
    HISTORY_RANGES: {
        '1m': { range: '1mo', interval: '1d' },
        '3m': { range: '3mo', interval: '1d' },
        '1y': { range: '1y', interval: '1d' },
        '5y': { range: '5y', interval: '1wk' },
        'max': { range: 'max', interval: '1mo' }
    },

    async fetchPriceHistory(ticker, rangeKey) {
        const cfg = this.HISTORY_RANGES[rangeKey] || this.HISTORY_RANGES['1y'];
        try {
            const yahooTicker = ticker.replace(/\./g, '-');
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}?interval=${cfg.interval}&range=${cfg.range}`;
            const response = await fetch(url);
            if (!response.ok) return null;
            const data = await response.json();
            const result = data?.chart?.result?.[0];
            const stamps = result?.timestamp || [];
            const closes = result?.indicators?.quote?.[0]?.close || [];
            const out = [];
            for (let i = 0; i < stamps.length; i++) {
                const c = closes[i];
                if (c == null || !isFinite(c)) continue;
                const d = new Date(stamps[i] * 1000);
                const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                // Widened intervals can land two stamps on one local date
                // (the current partial bar) — keep the newest.
                if (out.length && out[out.length - 1].date === date) out.pop();
                out.push({ date, price: c });
            }
            return out.length >= 2 ? out : null;
        } catch (error) {
            return null;
        }
    },

    /**
     * Fetch company info for a ticker via Yahoo Finance quoteSummary (through main process)
     * @param {string} ticker
     * @returns {Object|null} Company info object
     */
    async fetchCompanyInfo(ticker) {
        try {
            const yahooTicker = ticker.replace(/\./g, '-');
            const result = await window.electronNet.fetchYahooQuoteSummary(yahooTicker);
            if (!result) return null;

            const profile = result.assetProfile || {};
            const quoteType = result.quoteType || {};

            return {
                name: quoteType.longName || quoteType.shortName || ticker,
                sector: profile.sector || null,
                industry: profile.industry || null,
                description: profile.longBusinessSummary || null,
                website: profile.website || null,
                country: profile.country || null,
                employees: profile.fullTimeEmployees || null
            };
        } catch (error) {
            console.error(`Failed to fetch company info for ${ticker}:`, error);
            return null;
        }
    },

    /**
     * Check if a cached price is stale
     * @param {Object} cached - Cached price entry
     * @returns {boolean}
     */
    isStale(cached) {
        if (!cached) return true;
        return Date.now() - cached.updatedAt > this.CACHE_TTL;
    }
};
