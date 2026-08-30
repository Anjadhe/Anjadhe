/**
 * Portfolio on home — the one GLANCE widget.
 *
 * Every other widget is an attention queue that empties. Portfolio is the
 * exception, and the test that earns it is "does the user come looking for
 * this?" Nobody opens an app to check an unread count; people absolutely
 * open one to check what their money did today. So this card shows state,
 * and it shows it whenever there is a portfolio at all.
 *
 * The exception is fenced in two ways: `kind: 'glance'` is declared here in
 * plain sight, and js/core/widgets.js sorts every glance card BELOW every
 * attention card — so this number can never push an overdue bill down.
 *
 * What it shows, in descending order of how often it changes:
 *   1. value, day change, total P/L        the number people came for
 *   2. movers and laggards                 only when something actually moved
 *   3. strategy breaches                   an attention item, styled as one
 * Nothing else. No allocation split, no sparkline — that is why the app
 * exists.
 */
(function () {
    const MOVER_PCT = 2;        // matches the app's own "biggest mover" insight
    const MAX_MOVERS = 3;
    const MAX_BREACHES = 2;
    // Past this, a "day change" is describing a day that already ended, so
    // the movers band is dropped rather than presented as today's news.
    const STALE_MS = 12 * 60 * 60 * 1000;

    function newestPriceAt(holdings) {
        let newest = 0;
        for (const h of holdings) {
            const at = PortfolioApp.priceCache?.[h.ticker]?.updatedAt || 0;
            if (at > newest) newest = at;
        }
        return newest;
    }

    function agoLabel(ts) {
        const mins = Math.round((Date.now() - ts) / 60000);
        if (mins < 2) return 'just now';
        if (mins < 60) return `${mins} min ago`;
        const hrs = Math.round(mins / 60);
        if (hrs < 24) return `${hrs} hr ago`;
        return new Date(ts).toLocaleDateString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    }

    function moversHtml(list, dir) {
        const esc = UIUtils.escapeHtml.bind(UIUtils);
        return `<div class="pfw-movers-row">
            <span class="pfw-movers-label">${dir === 'up' ? 'Moving' : 'Lagging'}</span>
            <span class="pfw-movers-items">${list.map(h => `
                <span class="pfw-mover ${dir === 'up' ? 'is-up' : 'is-down'}">
                    <span class="pfw-mover-ticker">${esc(PortfolioApp.displayTicker(h.ticker))}</span>
                    <span class="pfw-mover-pct">${h.dayChangePercent >= 0 ? '+' : ''}${h.dayChangePercent.toFixed(1)}%</span>
                </span>`).join('')}</span>
        </div>`;
    }

    function breaches() {
        if (typeof PortfolioStrategy === 'undefined') return [];
        try {
            const strategy = PortfolioStrategy.getDefault();
            if (!strategy || strategy.status === 'draft') return [];
            const result = PortfolioStrategy.evaluate(strategy);
            return (result?.rules || []).filter(r => r.status === 'breach');
        } catch (e) {
            console.warn('[portfolio widget] strategy check failed:', e);
            return [];
        }
    }

    Widgets.register('portfolio', {
        kind: 'glance',
        title: 'Portfolio',
        app: 'portfolio',
        order: 10,
        load() {
            if (typeof PortfolioApp === 'undefined') return null;
            PortfolioApp.loadData();
            // Glance still means "when it exists" — an install that has never
            // held anything gets no card.
            if (!PortfolioApp.getAccounts().length) return null;

            const holdings = PortfolioApp.computeHoldings();
            const summary = PortfolioApp.getSummary(holdings);
            if (!(summary.totalValue > 0)) return null;

            const esc = UIUtils.escapeHtml.bind(UIUtils);
            const hv = PortfolioUI.hv.bind(PortfolioUI);
            const plClass = (v) => (v > 0 ? 'is-up' : v < 0 ? 'is-down' : '');

            // Money is blurred with the portfolio's own hide-values toggle.
            // Home is the screen most likely to have someone else looking at
            // it, so a toggle that didn't carry here would be worthless.
            // formatPL renders any falsy value — including NaN from an
            // incomplete transaction — as a confident "$0.00". On a glance
            // card that is a lie, so an unrepresentable figure is omitted
            // rather than shown as zero.
            const num = (v) => Number.isFinite(v);
            const change = (value, tail, cls) => num(value) ? `
                <span class="pfw-change ${plClass(value)}">
                    ${hv(PortfolioUI.formatPL(value))}
                    <span class="${cls}">${tail}</span>
                </span>` : '';

            let body = `
            <div class="pfw-headline">
                <div class="pfw-value">${hv(PortfolioUI.formatMoney(summary.liabilitiesTotal > 0 ? summary.netWorth : summary.totalValue))}</div>
                <div class="pfw-changes">
                    ${change(summary.totalDayChange,
                        (summary.totalDayBase > 0 && num(summary.totalDayChangePercent)
                            ? `${PortfolioUI.formatPercent(summary.totalDayChangePercent)} ` : '') + 'today',
                        'pfw-change-when')}
                    ${change(summary.totalPL,
                        num(summary.totalPLPercent) ? PortfolioUI.formatPercent(summary.totalPLPercent) : '',
                        'pfw-change-pct')}
                </div>
            </div>`;

            const newest = newestPriceAt(holdings);
            const stale = !newest || (Date.now() - newest) > STALE_MS;

            if (!stale) {
                // Gate on percent (a 2% move is the news), SELECT by dollars
                // so a $50 position up 9% never crowds out the holding that
                // actually moved the portfolio, then DISPLAY by percent —
                // ranking by a number the card doesn't show reads as broken
                // sorting.
                const byImpact = holdings
                    .filter(h => h.currentValue > 0
                        && Number.isFinite(h.dayChangePercent)
                        && Math.abs(h.dayChangePercent) >= MOVER_PCT)
                    .sort((a, b) => Math.abs(b.dayChange) - Math.abs(a.dayChange));
                const up = byImpact.filter(h => h.dayChangePercent > 0).slice(0, MAX_MOVERS)
                    .sort((a, b) => b.dayChangePercent - a.dayChangePercent);
                const down = byImpact.filter(h => h.dayChangePercent < 0).slice(0, MAX_MOVERS)
                    .sort((a, b) => a.dayChangePercent - b.dayChangePercent);
                if (up.length || down.length) {
                    body += `<div class="pfw-movers">
                        ${up.length ? moversHtml(up, 'up') : ''}
                        ${down.length ? moversHtml(down, 'down') : ''}
                    </div>`;
                }
            }

            const broken = breaches();
            if (broken.length) {
                body += `<div class="pfw-breaches">${broken.slice(0, MAX_BREACHES).map(r => `
                    <div class="pfw-breach">
                        <span class="pfw-breach-mark" aria-hidden="true">&#9888;</span>
                        <span class="pfw-breach-text">${esc(r.detail || r.label)}</span>
                    </div>`).join('')}
                    ${broken.length > MAX_BREACHES
                        ? `<div class="pfw-breach-more">+${broken.length - MAX_BREACHES} more off plan</div>` : ''}
                </div>`;
            }

            // Honest about what "today" is measured from. Shown only when the
            // quote is not fresh, so the common case stays uncluttered.
            const footer = (newest && (Date.now() - newest) > 15 * 60 * 1000)
                ? `<span class="pfw-asof">Prices as of ${esc(agoLabel(newest))}</span>`
                : '';

            // Tone follows the day's direction. Only while the quote is
            // fresh — a card tinted green over yesterday's close would be
            // asserting something it no longer knows.
            const tone = (!stale && num(summary.totalDayChange) && summary.totalDayChange !== 0)
                ? (summary.totalDayChange > 0 ? 'good' : 'warn')
                : undefined;

            return { body, footer, tone };
        }
    });
})();
