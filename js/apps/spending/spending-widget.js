/**
 * Spending on home — a GLANCE widget, the second after Portfolio.
 *
 * The test that earns the kind is "does the user come looking for this?"
 * People open a banking app to see what they have spent this month the
 * way they open a brokerage app to see the number; so this card shows
 * state whenever there are transactions at all. It sits under Portfolio
 * (order 20) and, like every glance card, under every attention card.
 *
 * What it shows: the month so far, the same point last month (pure
 * arithmetic, day-of-month capped), and the top three categories. No
 * budgets (by decision), no model text.
 */
(function () {
    Widgets.register('spending', {
        kind: 'glance',
        title: 'Spending',
        app: 'spending',
        order: 20,
        load() {
            if (typeof SpendingApp === 'undefined') return null;
            SpendingApp.loadData();
            if (!SpendingApp.accounts().length || !SpendingApp.transactions().length) return null;
            const today = SpendingApp.today();
            const month = SpendingApp.monthKey(today);
            const cur = SpendingApp.summary(month);
            const prevMonth = SpendingApp.addMonths(month, -1);
            const prev = SpendingApp.summary(prevMonth, { upTo: `${prevMonth}-${today.slice(8, 10)}` });
            const esc = UIUtils.escapeHtml.bind(UIUtils);
            const money = SpendingUI.money.bind(SpendingUI);
            let compare = '';
            if (prev.spend > 0) {
                const diff = cur.spend - prev.spend;
                const pct = Math.round((diff / prev.spend) * 100);
                compare = `<span class="spw-compare ${diff > 0 ? 'is-up' : diff < 0 ? 'is-down' : ''}">${esc(money(diff, { sign: true }))}${pct ? ` (${pct > 0 ? '+' : ''}${pct}%)` : ''} vs this point last month</span>`;
            }
            const cats = cur.byCategory.slice(0, 3);
            const parts = cur.byCategory.filter(c => c.total > 0);
            const partsTotal = parts.reduce((s, c) => s + c.total, 0);
            const comp = partsTotal > 0 ? `<div class="spw-comp" aria-hidden="true">${parts.map(c => `<span class="spw-comp-seg" data-cat="${esc(c.id)}" style="flex-grow:${Math.max(0.5, Math.round((c.total / partsTotal) * 1000) / 10)}"></span>`).join('')}</div>` : '';
            const needsLogin = typeof SpendingSync !== 'undefined' && SpendingApp.links().some(l => l.needsLogin && SpendingSync.isHere(l));
            return {
                tone: needsLogin ? 'warn' : undefined,
                body: `<div class="spw">
                    <div class="spw-headline">
                        <span class="spw-value">${esc(money(cur.spend))}</span>
                        <span class="spw-sub">spent so far in ${esc(SpendingApp.monthLabel(month).split(' ')[0])}</span>
                    </div>
                    ${compare ? `<div class="spw-line">${compare}</div>` : ''}
                    ${comp}
                    ${cats.length ? `<div class="spw-cats">${cats.map(c => `<span class="spw-cat"><span class="spw-cat-dot" data-cat="${esc(c.id)}"></span><span class="spw-cat-label">${esc(c.label)}</span><span class="spw-cat-value">${esc(money(c.total))}</span></span>`).join('')}</div>` : ''}
                    ${needsLogin ? '<div class="spw-line spw-warn">A bank needs you to sign in again</div>' : ''}
                </div>`
            };
        }
    });
})();
