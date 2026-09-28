/**
 * SpendingUI — the page, in the Portfolio shape: a left nav of PAGES and
 * ACCOUNTS beside the main column.
 *
 *   Pages     Overview (the month's number, its composition, the 12-month
 *             trend, the top categories and merchants, what is due soon,
 *             the latest rows) · Categories · Merchants · Recurring ·
 *             Transactions — each a full page over the same month.
 *   Accounts  a SCOPE, not a filter on one list: pick an account and every
 *             page reads only its rows ("All accounts" is the default).
 *   Month     the switcher sits at the top of every page.
 *
 * Every figure is arithmetic over SpendingApp's rows (nothing model-
 * written); the one write on the page is re-categorising a row or a
 * merchant. Color is DATA here (docs/SPENDING.md "Color"): one hue per
 * category on bars, chips, monograms and the composition bar; account
 * types on their icons; an accent on the charts; red/green on deltas and
 * money in. Chrome stays ink.
 */
const SpendingUI = {
    _wired: false,

    esc(s) { return (typeof UIUtils !== 'undefined') ? UIUtils.escapeHtml(String(s ?? '')) : String(s ?? ''); },

    money(n, { sign = false, cents = 'auto' } = {}) {
        const v = Number(n) || 0;
        const digits = cents === 'never' ? 0 : cents === 'always' ? 2 : (Math.abs(v) >= 1000 ? 0 : 2);
        const abs = Math.abs(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });
        if (v < 0) return `−${abs}`;
        return sign && v > 0 ? `+${abs}` : abs;
    },

    /** Big number: whole dollars in the serif, cents small. */
    moneyHero(n) {
        const v = Math.abs(Number(n) || 0);
        const whole = Math.floor(v).toLocaleString('en-US');
        const cents = String(Math.round((v - Math.floor(v)) * 100)).padStart(2, '0');
        return `<span class="spending-hero-currency">$</span>${this.esc(whole)}<span class="spending-hero-cents">.${cents}</span>`;
    },

    dayLabel(iso, { weekday = false } = {}) {
        const [y, m, d] = String(iso).split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { ...(weekday ? { weekday: 'short' } : {}), month: 'short', day: 'numeric', timeZone: 'UTC' });
    },

    shortMonth(month) {
        const [y, m] = String(month).split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
    },

    pct(part, whole) {
        if (!(whole > 0)) return '';
        const p = Math.round((part / whole) * 100);
        return p ? `${p}%` : '<1%';
    },

    ago(iso) {
        const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
        if (mins < 2) return 'just now';
        if (mins < 60) return `${mins} min ago`;
        if (mins < 36 * 60) return `${Math.round(mins / 60)}h ago`;
        return `${Math.round(mins / 1440)}d ago`;
    },

    shortName(a) { return String(a?.name || '').replace(/\s*····\d+$/, ''); },

    /** The name without the bank in front ("Total Checking" under a "Chase" sub-line) — for the narrow nav. */
    navName(a) {
        const short = this.shortName(a);
        const inst = String(a?.institution || '').trim();
        if (inst && short.toLowerCase().startsWith(inst.toLowerCase() + ' ') && short.length > inst.length + 3) return short.slice(inst.length + 1);
        return short;
    },

    TYPE: { checking: 'Checking', savings: 'Savings', credit: 'Credit card', loan: 'Loan', other: 'Account' },

    typeIcon(type) {
        const stroke = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
        if (type === 'all') return `<svg viewBox="0 0 24 24" width="14" height="14" ${stroke}><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`;
        if (type === 'credit') return `<svg viewBox="0 0 24 24" width="14" height="14" ${stroke}><rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><line x1="2.5" y1="10" x2="21.5" y2="10"/><line x1="6.5" y1="15" x2="10" y2="15"/></svg>`;
        if (type === 'savings') return `<svg viewBox="0 0 24 24" width="14" height="14" ${stroke}><path d="M4 12.5a7 7 0 0 1 7-7h4a5.5 5.5 0 0 1 5.5 5.5v1.5l1.5.5v3l-1.8.6a5.5 5.5 0 0 1-2.2 2.9V21h-3v-1.5h-4V21H8v-2.2A7 7 0 0 1 4 12.5z"/></svg>`;
        if (type === 'loan') return `<svg viewBox="0 0 24 24" width="14" height="14" ${stroke}><path d="M3 10.5 12 4l9 6.5"/><path d="M5 10v10h14V10"/><line x1="10" y1="20" x2="10" y2="14"/><line x1="14" y1="20" x2="14" y2="14"/></svg>`;
        return `<svg viewBox="0 0 24 24" width="14" height="14" ${stroke}><path d="M3 9.5 12 4l9 5.5"/><line x1="4" y1="20" x2="20" y2="20"/><line x1="6" y1="10" x2="6" y2="20"/><line x1="10" y1="10" x2="10" y2="20"/><line x1="14" y1="10" x2="14" y2="20"/><line x1="18" y1="10" x2="18" y2="20"/></svg>`;
    },

    // ── Render ───────────────────────────────────────────────────────────

    render() {
        const body = document.getElementById('spending-body');
        if (!body) return;
        this._wire();
        const app = SpendingApp;
        const available = typeof SpendingSync !== 'undefined' && SpendingSync.available();
        const linkBtn = document.getElementById('spending-link-btn');
        const syncBtn = document.getElementById('spending-sync-btn');
        if (linkBtn) linkBtn.hidden = !available;
        const hereLinks = app.links().filter(l => SpendingSync.isHere(l));
        if (syncBtn) {
            syncBtn.hidden = !available || !hereLinks.length;
            syncBtn.disabled = !!SpendingSync.syncing();
            syncBtn.textContent = SpendingSync.syncing() ? 'Syncing…' : 'Sync now';
        }

        if (!app.accounts().length) {
            document.getElementById('spending-nav').innerHTML = '';
            document.querySelector('#spending-view .spending-layout')?.classList.add('is-empty');
            body.innerHTML = this.emptyState(available);
            this._wireBody(body);
            return;
        }
        document.querySelector('#spending-view .spending-layout')?.classList.remove('is-empty');

        const month = app.currentMonth();
        const today = app.today();
        const isCurrent = month === app.monthKey(today);
        // The SCOPE: every account, or the one the nav selected. Every
        // section reads the same scoped rows, so the whole page changes.
        const scopeAccount = app._accountFilter ? app.accountById(app._accountFilter) : null;
        if (app._accountFilter && !scopeAccount) app._accountFilter = null;
        const scopeId = scopeAccount ? scopeAccount.id : null;
        const txns = app.scopedTransactions(scopeId);
        const cur = app.summary(month, { accountId: scopeId });
        const prevMonth = app.addMonths(month, -1);
        // Same point last month: the day-of-month cap makes the comparison
        // honest for the current (partial) month; a past month compares whole.
        const upTo = isCurrent ? `${prevMonth}-${today.slice(8, 10)}` : null;
        const prev = app.summary(prevMonth, { upTo, accountId: scopeId });
        const ctx = { month, today, isCurrent, cur, prev, txns, scopeAccount, scopeId };

        this.renderNav(ctx);
        const page = app._page;
        let html = this.scopeHeader(ctx) + this.monthBar(ctx);
        if (page === 'categories') html += this.categoriesPage(ctx);
        else if (page === 'merchants') html += this.merchantsPage(ctx);
        else if (page === 'recurring') html += this.recurringPage(ctx);
        else if (page === 'transactions') html += this.transactionsPage(ctx);
        else html += this.overviewPage(ctx);
        body.innerHTML = html;
        this._wireBody(body);
    },

    emptyState(available) {
        return `<div class="spending-empty">
            <div class="spending-empty-art" aria-hidden="true">
                <span data-cat="GROCERIES"></span><span data-cat="FOOD_AND_DRINK"></span><span data-cat="TRANSPORTATION"></span><span data-cat="GENERAL_MERCHANDISE"></span><span data-cat="TRAVEL"></span><span data-cat="ENTERTAINMENT"></span><span data-cat="PERSONAL_CARE"></span>
            </div>
            <div class="spending-empty-title">Every card swipe and bank debit, in one place.</div>
            <div class="spending-empty-sub">Link a checking account, savings account or credit card and Spending pulls the last two years of transactions, then keeps them current. You sign in on your bank’s own page through Plaid; no bank password reaches Anjadhe. Transactions travel through Anjadhe Cloud on their way to this Mac and are not stored or logged there. The categories are the bank’s and yours — nothing here is written by AI.</div>
            ${available
                ? '<button type="button" class="primary-btn" id="spending-empty-link">+ Link a bank or card</button>'
                : '<div class="spending-empty-note">Account linking is not available in this build.</div>'}
        </div>`;
    },

    // ── Nav ──────────────────────────────────────────────────────────────

    renderNav({ scopeId }) {
        const nav = document.getElementById('spending-nav');
        if (!nav) return;
        const app = SpendingApp;
        const links = new Map(app.links().map(l => [l.id, l]));
        const order = { checking: 0, savings: 1, credit: 2, loan: 3, other: 4 };
        const accounts = app.accounts().slice().sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9) || String(a.name).localeCompare(String(b.name)));
        let cash = 0, owed = 0;
        for (const a of accounts) { const b = a.balance?.current; if (b != null) { if (a.type === 'credit') owed += b; else cash += b; } }
        const pages = app.PAGES.map(p => `
            <button type="button" class="spending-nav-item${app._page === p.id ? ' is-active' : ''}" data-page="${p.id}">
                <span class="spending-nav-name">${this.esc(p.label)}</span>
            </button>`).join('');
        const acct = (a) => {
            const link = links.get(a.itemId);
            const st = link ? SpendingSync.statusLine(link) : null;
            const bal = a.balance?.current;
            return `<button type="button" class="spending-nav-item spending-nav-acct${scopeId === a.id ? ' is-active' : ''}" data-account="${this.esc(a.id)}" data-type="${this.esc(a.type || 'other')}" title="${this.esc(a.name)}${st ? ` · ${this.esc(st.text)}` : ''}">
                <span class="spending-nav-icon" aria-hidden="true">${this.typeIcon(a.type)}</span>
                <span class="spending-nav-main">
                    <span class="spending-nav-name">${this.esc(this.navName(a))}</span>
                    <span class="spending-nav-sub">${a.institution ? `${this.esc(a.institution)} · ` : ''}${this.esc(this.TYPE[a.type] || 'Account')}${a.mask ? ` ····${this.esc(a.mask)}` : ''}${st?.needsLogin ? ' · <em>sign in</em>' : ''}</span>
                </span>
                <span class="spending-nav-value${a.type === 'credit' ? ' is-owed' : ''}">${bal != null ? this.esc(this.money(bal, { cents: 'never' })) : '—'}</span>
            </button>`;
        };
        nav.innerHTML = `
            <div class="spending-nav-label">Spending</div>
            ${pages}
            <div class="spending-nav-label spending-nav-label-gap">Accounts</div>
            <button type="button" class="spending-nav-item spending-nav-acct${scopeId ? '' : ' is-active'}" data-account="" data-type="all" title="Every linked account">
                <span class="spending-nav-icon" aria-hidden="true">${this.typeIcon('all')}</span>
                <span class="spending-nav-main">
                    <span class="spending-nav-name">All accounts</span>
                    <span class="spending-nav-sub">${owed ? `${this.esc(this.money(owed, { cents: 'never' }))} owed on cards` : `${accounts.length} account${accounts.length === 1 ? '' : 's'}`}</span>
                </span>
                <span class="spending-nav-value">${this.esc(this.money(cash, { cents: 'never' }))}</span>
            </button>
            ${accounts.map(acct).join('')}
            ${(typeof SpendingSync !== 'undefined' && SpendingSync.available()) ? '<button type="button" class="spending-nav-item spending-nav-new" data-link>+ Link a bank or card</button>' : ''}`;
        nav.querySelectorAll('[data-page]').forEach(b => b.addEventListener('click', () => app.show({ page: b.dataset.page })));
        nav.querySelectorAll('[data-account]').forEach(b => b.addEventListener('click', () => app.show({ accountId: b.dataset.account || null })));
        nav.querySelector('[data-link]')?.addEventListener('click', async () => { await SpendingSync.link(); app.render(); });
    },

    // ── Shared page furniture ────────────────────────────────────────────

    /** Account name, type, balance and sync state above the month bar when scoped. */
    scopeHeader({ scopeAccount }) {
        if (!scopeAccount) return '';
        const a = scopeAccount;
        const link = SpendingApp.links().find(l => l.id === a.itemId);
        const st = link ? SpendingSync.statusLine(link) : null;
        const bal = a.balance?.current;
        const limit = a.balance?.limit;
        const util = a.type === 'credit' && limit > 0 && bal != null ? Math.min(100, Math.round((bal / limit) * 100)) : null;
        return `<header class="spending-scope-header" data-type="${this.esc(a.type || 'other')}">
            <span class="spending-scope-icon" aria-hidden="true">${this.typeIcon(a.type)}</span>
            <div class="spending-scope-main">
                <h3 class="spending-scope-name">${this.esc(this.shortName(a))}</h3>
                <div class="spending-scope-meta">${this.esc(this.TYPE[a.type] || 'Account')}${a.mask ? ` ····${this.esc(a.mask)}` : ''}${a.institution ? ` · ${this.esc(a.institution)}` : ''}${st ? ` · ${this.esc(st.text)}` : ''}</div>
                ${util != null ? `<div class="spending-scope-util" title="${util}% of a ${this.esc(this.money(limit, { cents: 'never' }))} limit"><span style="width:${util}%"></span></div>` : ''}
            </div>
            <div class="spending-scope-balance">${bal != null ? this.esc(this.money(bal)) : '—'}${a.type === 'credit' && bal != null ? ' <span class="spending-scope-note">owed</span>' : ''}</div>
            ${st?.needsLogin && link ? `<button type="button" class="secondary-btn spending-relink" data-item="${this.esc(link.id)}">Sign in again</button>` : ''}
            <button type="button" class="spending-scope-x" data-account="" title="Back to every account">All accounts</button>
        </header>`;
    },

    /** Month switcher, on every page. */
    monthBar({ month, today, isCurrent }) {
        const app = SpendingApp;
        const months = app.monthsWithData();
        const canPrev = months.some(m => m < month);
        const canNext = month < app.monthKey(today);
        const chev = (d) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="${d === 'l' ? '15 18 9 12 15 6' : '9 18 15 12 9 6'}"/></svg>`;
        const title = app.PAGES.find(p => p.id === app._page)?.label || 'Overview';
        return `<div class="spending-month-bar">
            <span class="spending-page-title">${this.esc(title)}</span>
            <div class="spending-month-nav">
                <button type="button" class="spending-month-btn" data-month="${this.esc(app.addMonths(month, -1))}" title="Previous month" ${canPrev ? '' : 'disabled'} aria-label="Previous month">${chev('l')}</button>
                <span class="spending-month-label">${this.esc(app.monthLabel(month))}${isCurrent ? '<span class="spending-month-tag">so far</span>' : ''}</span>
                <button type="button" class="spending-month-btn" data-month="${this.esc(app.addMonths(month, 1))}" title="Next month" ${canNext ? '' : 'disabled'} aria-label="Next month">${chev('r')}</button>
                ${!isCurrent ? `<button type="button" class="spending-month-today" data-month="${this.esc(app.monthKey(today))}">This month</button>` : ''}
            </div>
        </div>`;
    },

    cardHead(title, note, { page = null } = {}) {
        return `<header class="spending-card-head">
            <h4 class="spending-section-title">${this.esc(title)}</h4>
            <span class="spending-card-head-right">${note ? `<span class="spending-section-note">${note}</span>` : ''}${page ? `<button type="button" class="spending-see-all" data-page="${page}">See all →</button>` : ''}</span>
        </header>`;
    },

    // ── Overview ─────────────────────────────────────────────────────────

    overviewPage(ctx) {
        const { cur, today, txns } = ctx;
        const app = SpendingApp;
        const rec = app.recurring(txns, app.rules(), { today });
        const soon = new Date(Date.parse(today + 'T00:00:00Z') + 10 * 86400000).toISOString().slice(0, 10);
        const due = rec.filter(r => r.next >= today && r.next <= soon).sort((a, b) => a.next.localeCompare(b.next)).slice(0, 5);
        const monthly = rec.reduce((s, r) => s + (r.cadence === 'monthly' ? r.amount : r.cadence === 'weekly' ? r.amount * 4.33 : r.amount / 12), 0);
        const latest = app.monthRows(ctx.month, { filter: '' }).slice(0, 6);
        return `
            ${this.hero(ctx)}
            <div class="spending-columns">
                <section class="spending-card">
                    ${this.cardHead('Where it went', `${cur.byCategory.length} categor${cur.byCategory.length === 1 ? 'y' : 'ies'}`, { page: 'categories' })}
                    ${this.categoryList(cur, ctx.prev, 6)}
                </section>
                <section class="spending-card">
                    ${this.cardHead('Top merchants', `${cur.byMerchant.length} place${cur.byMerchant.length === 1 ? '' : 's'}`, { page: 'merchants' })}
                    ${this.merchantList(cur, 6)}
                </section>
            </div>
            <div class="spending-columns">
                <section class="spending-card">
                    ${this.cardHead('Due soon', rec.length ? `about ${this.esc(this.money(monthly, { cents: 'never' }))} a month recurring` : '', { page: 'recurring' })}
                    ${due.length ? `<ul class="spending-list">${due.map(r => this.recRow(r, today)).join('')}</ul>` : `<div class="spending-quiet">${rec.length ? 'Nothing due in the next ten days.' : 'No recurring charges found yet.'}</div>`}
                </section>
                <section class="spending-card">
                    ${this.cardHead('Latest', ctx.scopeAccount ? this.esc(this.shortName(ctx.scopeAccount)) : '', { page: 'transactions' })}
                    ${latest.length ? `<ul class="spending-rows spending-rows-compact">${latest.map(t => this.row(t, ctx, { compact: true })).join('')}</ul>` : '<div class="spending-quiet">No transactions this month yet.</div>'}
                </section>
            </div>`;
    },

    hero({ month, today, isCurrent, cur, prev, txns, scopeId }) {
        const app = SpendingApp;
        const daysIn = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
        const dayN = isCurrent ? Number(today.slice(8, 10)) : daysIn;
        const perDay = dayN ? cur.spend / dayN : 0;
        // Facts only: last month's whole total and this month's daily
        // average. No projection — "on pace for" read as a forecast.
        const lastWhole = isCurrent ? app.summary(app.addMonths(month, -1), { accountId: scopeId }).spend : null;
        let compare;
        if (prev.spend > 0) {
            const diff = cur.spend - prev.spend;
            const pctN = Math.round((diff / prev.spend) * 100);
            const tone = diff > 0 ? 'up' : diff < 0 ? 'down' : '';
            const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '=';
            compare = `<span class="spending-delta-pill ${tone}">${arrow} ${this.esc(this.money(Math.abs(diff), { cents: 'never' }))}${pctN ? ` · ${Math.abs(pctN)}%` : ''}</span> <span class="spending-hero-vs">vs ${this.esc(this.shortMonth(app.addMonths(month, -1)))}${isCurrent ? ' at this point' : ''}</span>`;
        } else {
            compare = '<span class="spending-hero-vs">nothing to compare with yet</span>';
        }
        const terms = [
            isCurrent && lastWhole ? { label: `All of ${this.shortMonth(app.addMonths(month, -1))}`, value: this.money(lastWhole, { cents: 'never' }) } : null,
            { label: 'Per day', value: this.money(perDay, { cents: 'never' }), hint: `${this.money(cur.spend, { cents: 'never' })} over ${dayN} day${dayN === 1 ? '' : 's'}` },
            cur.refunds ? { label: 'Refunds', value: this.money(cur.refunds, { cents: 'never' }), hint: `net ${this.money(cur.net, { cents: 'never' })} after refunds` } : null,
            cur.income ? { label: 'Income', value: this.money(cur.income, { cents: 'never' }) } : null,
            cur.transfersOut ? { label: 'Moved to savings', value: this.money(cur.transfersOut, { cents: 'never' }) } : null,
            { label: 'Purchases', value: String(cur.count) + (cur.pending ? `<span class="spending-term-sub"> · ${cur.pending} pending</span>` : '') }
        ].filter(Boolean);
        return `<section class="spending-hero">
            <div class="spending-hero-main">
                <div class="spending-hero-eyebrow">Spent${isCurrent ? ' so far' : ''}</div>
                <div class="spending-hero-value">${this.moneyHero(cur.spend)}</div>
                <div class="spending-hero-compare">${compare}</div>
                ${this.compositionBar(cur)}
                <div class="spending-terms">${terms.map(t => `
                    <div class="spending-term"${t.hint ? ` title="${this.esc(t.hint)}"` : ''}>
                        <span class="spending-term-label">${this.esc(t.label)}</span>
                        <span class="spending-term-value">${t.value}</span>
                    </div>`).join('')}
                </div>
            </div>
            <div class="spending-hero-side">
                ${this.trendChart(month, txns)}
            </div>
        </section>`;
    },

    /** The month as one stacked bar of its categories, with a legend of the top few. */
    compositionBar(cur) {
        const parts = cur.byCategory.filter(c => c.total > 0);
        const total = parts.reduce((s, c) => s + c.total, 0);
        if (!total) return '';
        const segs = parts.map(c => `<span class="spending-comp-seg" data-cat="${this.esc(c.id)}" data-filter="${this.esc(c.label)}" style="flex-grow:${Math.max(0.5, Math.round((c.total / total) * 1000) / 10)}" title="${this.esc(c.label)}: ${this.esc(this.money(c.total))} · ${this.esc(this.pct(c.total, total))}"></span>`).join('');
        const legend = parts.slice(0, 5).map(c => `<button type="button" class="spending-comp-key" data-filter="${this.esc(c.label)}"><span class="spending-comp-dot" data-cat="${this.esc(c.id)}"></span>${this.esc(c.label)} <span class="spending-comp-pct">${this.esc(this.pct(c.total, total))}</span></button>`).join('');
        const rest = parts.length - 5;
        return `<div class="spending-comp">
            <div class="spending-comp-bar">${segs}</div>
            <div class="spending-comp-legend">${legend}${rest > 0 ? `<button type="button" class="spending-comp-key is-rest" data-page="categories">+${rest} more</button>` : ''}</div>
        </div>`;
    },

    /** Twelve months of spend as bars; the month on screen is solid, the rest muted. Click jumps. */
    trendChart(month, txns = SpendingApp.transactions()) {
        const app = SpendingApp;
        const trend = app.monthTrend(txns, app.rules(), month, 12);
        const max = Math.max(...trend.map(t => t.spend), 1);
        const withData = trend.filter(t => t.spend > 0);
        const avg = withData.reduce((s, t) => s + t.spend, 0) / Math.max(1, withData.length);
        const W = 320, H = 96, PAD = 2, gap = 6;
        const bw = (W - gap * 11) / 12;
        const bars = trend.map((t, i) => {
            const h = t.spend > 0 ? Math.max(3, Math.round((t.spend / max) * (H - 20))) : 2;
            const x = i * (bw + gap);
            const y = H - 16 - h;
            const cls = t.month === month ? 'is-current' : (t.spend ? '' : 'is-empty');
            return `<g class="spending-bar-g ${cls}" data-month="${this.esc(t.month)}">
                <title>${this.esc(app.monthLabel(t.month))}: ${this.esc(this.money(t.spend, { cents: 'never' }))}</title>
                <rect class="spending-bar-hit" x="${x}" y="0" width="${bw}" height="${H}" rx="3"/>
                <rect class="spending-bar-rect" x="${x}" y="${y}" width="${bw}" height="${h}" rx="3"/>
                ${i % 3 === 0 || t.month === month ? `<text class="spending-bar-text" x="${x + bw / 2}" y="${H - 3}" text-anchor="middle">${this.esc(this.shortMonth(t.month))}</text>` : ''}
            </g>`;
        }).join('');
        const avgY = H - 16 - Math.round((avg / max) * (H - 20));
        return `<div class="spending-trend">
            <div class="spending-trend-head">
                <span class="spending-section-title">Last 12 months</span>
                <span class="spending-section-note">avg ${this.esc(this.money(avg, { cents: 'never' }))} a month</span>
            </div>
            <svg class="spending-trend-svg" viewBox="0 ${-PAD} ${W} ${H + PAD}" preserveAspectRatio="none" role="img" aria-label="Spend by month">
                <line class="spending-trend-avg" x1="0" x2="${W}" y1="${avgY}" y2="${avgY}"/>
                ${bars}
            </svg>
        </div>`;
    },

    // ── Categories ───────────────────────────────────────────────────────

    categoriesPage(ctx) {
        const { cur, prev } = ctx;
        return `<section class="spending-card">
            ${this.cardHead('Where it went', `${this.esc(this.money(cur.spend))} across ${cur.byCategory.length} categor${cur.byCategory.length === 1 ? 'y' : 'ies'}`)}
            ${this.compositionBar(cur)}
            ${this.categoryList(cur, prev, 40)}
        </section>`;
    },

    categoryList(cur, prev, limit = 10) {
        if (!cur.byCategory.length) return '<div class="spending-quiet">Nothing spent yet.</div>';
        const max = Math.max(...cur.byCategory.map(c => c.total), 1);
        const prevBy = new Map(prev.byCategory.map(c => [c.id, c.total]));
        return `<ul class="spending-list spending-cats">${cur.byCategory.slice(0, limit).map((c, i) => {
            const p = prevBy.get(c.id);
            const delta = p != null ? c.total - p : null;
            const isNew = p == null && c.total > 0;
            const refund = c.total < 0;
            return `<li class="spending-cat-row${refund ? ' is-refund' : ''}" data-cat="${this.esc(c.id)}" data-filter="${this.esc(c.label)}" title="${c.count} purchase${c.count === 1 ? '' : 's'}${refund ? ' · refunds outweighed purchases' : ` · ${this.esc(this.pct(c.total, cur.spend))} of the month`}">
                <span class="spending-cat-rank">${i + 1}</span>
                <span class="spending-cat-main">
                    <span class="spending-cat-line"><span class="spending-cat-dot"></span><span class="spending-cat-label">${this.esc(c.label)}</span><span class="spending-cat-count">${c.count}×</span><span class="spending-cat-share">${refund ? 'refund' : this.esc(this.pct(c.total, cur.spend))}</span><span class="spending-cat-value">${this.esc(this.money(c.total))}</span></span>
                    <span class="spending-cat-track"><span class="spending-cat-bar" style="width:${refund ? 0 : Math.max(1.5, Math.round((c.total / max) * 100))}%"></span></span>
                </span>
                <span class="spending-cat-delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}">${isNew ? 'new' : (delta != null && Math.round(delta) ? this.esc(this.money(delta, { sign: true, cents: 'never' })) : '')}</span>
            </li>`;
        }).join('')}</ul>`;
    },

    // ── Merchants ────────────────────────────────────────────────────────

    merchantsPage(ctx) {
        const { cur } = ctx;
        return `<section class="spending-card">
            ${this.cardHead('Top merchants', `${cur.byMerchant.length} place${cur.byMerchant.length === 1 ? '' : 's'} this month`)}
            ${this.merchantList(cur, 60)}
        </section>`;
    },

    merchantList(cur, limit = 8) {
        if (!cur.byMerchant.length) return '<div class="spending-quiet">Nothing spent yet.</div>';
        const max = Math.max(...cur.byMerchant.map(m => m.total), 1);
        return `<ul class="spending-list">${cur.byMerchant.slice(0, limit).map(m => {
            const name = SpendingApp.prettyName({ name: m.name });
            return `<li class="spending-merchant-row" data-filter="${this.esc(m.name)}">
                <span class="spending-mono" data-cat="${this.esc(m.category)}" aria-hidden="true">${this.esc(SpendingApp.monogram(name))}</span>
                <span class="spending-merchant-main">
                    <span class="spending-merchant-name">${this.esc(name)}</span>
                    <span class="spending-merchant-meta">${m.count} ${m.count === 1 ? 'purchase' : 'purchases'} · <span class="spending-merchant-cat" data-cat="${this.esc(m.category)}">${this.esc(SpendingApp.categoryLabel(m.category))}</span></span>
                    <span class="spending-merchant-track"><span class="spending-merchant-bar" data-cat="${this.esc(m.category)}" style="width:${Math.max(1, Math.round((Math.max(0, m.total) / max) * 100))}%"></span></span>
                </span>
                <span class="spending-merchant-value">${this.esc(this.money(m.total))}</span>
            </li>`;
        }).join('')}</ul>`;
    },

    // ── Recurring ────────────────────────────────────────────────────────

    recurringPage(ctx) {
        const { today, txns } = ctx;
        const app = SpendingApp;
        const rec = app.recurring(txns, app.rules(), { today });
        if (!rec.length) return `<section class="spending-card">${this.cardHead('Comes back every month', '')}<div class="spending-quiet">Nothing recurring found yet — three charges from one merchant on a monthly, weekly or yearly beat make one.</div></section>`;
        const monthly = rec.reduce((s, r) => s + (r.cadence === 'monthly' ? r.amount : r.cadence === 'weekly' ? r.amount * 4.33 : r.amount / 12), 0);
        const groups = [['monthly', 'Monthly'], ['weekly', 'Weekly'], ['yearly', 'Yearly']].map(([id, label]) => ({ id, label, rows: rec.filter(r => r.cadence === id).sort((a, b) => a.next.localeCompare(b.next)) })).filter(g => g.rows.length);
        return `<section class="spending-card">
            ${this.cardHead('Comes back every month', `about ${this.esc(this.money(monthly, { cents: 'never' }))} a month · ${rec.length} charge${rec.length === 1 ? '' : 's'}`)}
            ${groups.map(g => `
                <div class="spending-rec-group">
                    <div class="spending-rec-group-head">${this.esc(g.label)} <span class="spending-section-note">${this.esc(this.money(g.rows.reduce((s, r) => s + r.amount, 0), { cents: 'never' }))}</span></div>
                    <ul class="spending-recurring">${g.rows.map(r => this.recRow(r, today)).join('')}</ul>
                </div>`).join('')}
        </section>`;
    },

    recRow(r, today) {
        const app = SpendingApp;
        const soon = new Date(Date.parse(today + 'T00:00:00Z') + 7 * 86400000).toISOString().slice(0, 10);
        const due = r.next >= today && r.next <= soon;
        const name = app.prettyName({ name: r.name });
        return `<li class="spending-rec${due ? ' is-soon' : ''}" data-filter="${this.esc(r.name)}">
            <span class="spending-mono" data-cat="${this.esc(r.category)}" aria-hidden="true">${this.esc(app.monogram(name))}</span>
            <span class="spending-rec-main">
                <span class="spending-rec-name">${this.esc(name)}</span>
                <span class="spending-rec-meta">${this.esc(r.cadence)}${r.next >= today ? ` · next ${this.esc(this.dayLabel(r.next))}` : ` · last ${this.esc(this.dayLabel(r.last))}`}</span>
            </span>
            <span class="spending-rec-value">${this.esc(this.money(r.amount))}</span>
        </li>`;
    },

    // ── Transactions ─────────────────────────────────────────────────────

    transactionsPage(ctx) {
        const { month, today, txns, cur } = ctx;
        return `<section class="spending-card spending-rows-card">
            <header class="spending-card-head spending-rows-head">
                <div><h4 class="spending-section-title">Transactions</h4><span class="spending-section-note">${cur.count} purchase${cur.count === 1 ? '' : 's'}${cur.pending ? ` · ${cur.pending} pending` : ''}</span></div>
                <label class="spending-search"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg><input type="search" id="spending-filter" placeholder="Merchant or category" value="${this.esc(SpendingApp._filter)}"></label>
            </header>
            ${this.dayStrip(month, today, txns)}
            ${this.rows(month, ctx)}
        </section>`;
    },

    /** One thin bar per day of the month; today marked; the biggest day named. */
    dayStrip(month, today, txns = SpendingApp.transactions()) {
        const app = SpendingApp;
        const d = app.dailySpend(txns, app.rules(), month);
        if (!d.days.some(v => v > 0)) return '';
        // Rent day is 30× a coffee; on a linear scale every other day was a
        // sliver. Scale to the SECOND-largest day when the largest dwarfs
        // it, and draw that one clipped (a notched cap). Titles carry the
        // exact amounts either way.
        const sorted = d.days.slice().sort((a, b) => b - a);
        const clipped = sorted.length > 1 && sorted[1] > 0 && sorted[0] > 2.5 * sorted[1];
        const max = clipped ? sorted[1] : Math.max(sorted[0], 1);
        const isCurrent = month === app.monthKey(today);
        const todayN = isCurrent ? Number(today.slice(8, 10)) : null;
        const bars = d.days.map((v, i) => {
            const n = i + 1;
            const h = v > 0 ? Math.max(6, Math.min(100, Math.round((v / max) * 100))) : 4;
            const cls = [v > 0 ? '' : 'is-empty', todayN === n ? 'is-today' : '', todayN && n > todayN ? 'is-future' : '', d.top === n ? 'is-top' : '', clipped && d.top === n ? 'is-clipped' : ''].filter(Boolean).join(' ');
            return `<span class="spending-day ${cls}" data-day="${n}" title="${this.esc(this.dayLabel(`${month}-${String(n).padStart(2, '0')}`, { weekday: true }))}: ${this.esc(this.money(v))}"><span style="height:${h}%"></span></span>`;
        }).join('');
        return `<div class="spending-daystrip">
            <div class="spending-daystrip-bars">${bars}</div>
            <div class="spending-daystrip-foot">
                <span>1</span>
                <span class="spending-daystrip-note">${d.top ? `Busiest day ${this.esc(this.dayLabel(`${month}-${String(d.top).padStart(2, '0')}`, { weekday: true }))} · ${this.esc(this.money(d.topValue))}` : ''}</span>
                <span>${d.days.length}</span>
            </div>
        </div>`;
    },

    rows(month, ctx) {
        const app = SpendingApp;
        const rows = app.monthRows(month);
        if (!rows.length) {
            if (app._filter) return '<div class="spending-quiet">No transactions match.</div>';
            if (app._accountFilter) return `<div class="spending-quiet">Nothing on this account in ${this.esc(app.monthLabel(month))}.</div>`;
            const else_ = app.rowsElsewhere(month);
            if (!else_.count) return '<div class="spending-quiet">No transactions this month yet.</div>';
            return `<div class="spending-quiet">No transactions in ${this.esc(app.monthLabel(month))}. ${else_.count} in other months — <button type="button" class="spending-text-btn" data-jump-month="${this.esc(else_.latest)}">show ${this.esc(app.monthLabel(else_.latest))}</button>.</div>`;
        }
        const byKey = app.rulesByKey(app.rules());
        // Group by day; the day head carries that day's spend.
        const days = [];
        for (const t of rows) {
            const last = days[days.length - 1];
            if (!last || last.date !== t.date) days.push({ date: t.date, rows: [t], spend: 0 });
            else last.rows.push(t);
            const cat = app.categoryOf(t, byKey);
            if (app.isSpend(t, cat) || app.isRefund(t, cat)) days[days.length - 1].spend += t.amount;
        }
        return `<ul class="spending-rows">${days.map(day => `
            <li class="spending-day-group">
                <div class="spending-date-row"><span>${this.esc(this.dayLabel(day.date, { weekday: true }))}</span><span class="spending-date-total">${day.spend ? this.esc(this.money(day.spend)) : ''}</span></div>
                <ul class="spending-day-rows">${day.rows.map(t => this.row(t, ctx)).join('')}</ul>
            </li>`).join('')}</ul>`;
    },

    row(t, ctx, { compact = false } = {}) {
        const app = SpendingApp;
        const byKey = app.rulesByKey(app.rules());
        const cat = app.categoryOf(t, byKey);
        const spend = app.isSpend(t, cat);
        const acct = app.accountById(t.accountId);
        const many = !ctx.scopeAccount && app.accounts().length > 1;
        const name = app.prettyName(t);
        const raw = t.merchant && t.name ? app.prettyName({ name: t.name }) : '';
        const desc = raw && raw !== name ? raw : '';
        const meta = [compact ? this.dayLabel(t.date) : '', desc, many && acct ? (acct.mask ? `····${acct.mask}` : this.shortName(acct)) : '', !compact && t.channel === 'in store' ? 'in store' : ''].filter(Boolean).join(' · ');
        return `<li class="spending-row${t.pending ? ' is-pending' : ''}" data-txn="${this.esc(t.id)}">
            <span class="spending-mono" data-cat="${this.esc(cat)}" aria-hidden="true">${this.esc(app.monogram(name))}</span>
            <span class="spending-row-main">
                <span class="spending-row-name">${this.esc(name)}${t.pending ? '<span class="spending-row-pending">pending</span>' : ''}</span>
                <span class="spending-row-meta">${this.esc(meta)}</span>
            </span>
            <button type="button" class="spending-chip spending-cat-btn" data-cat="${this.esc(cat)}" data-txn="${this.esc(t.id)}" title="Change category">${this.esc(app.categoryLabel(cat))}</button>
            <span class="spending-row-amount${t.amount < 0 ? ' is-in' : ''}${!spend && t.amount > 0 ? ' is-quiet' : ''}">${this.esc(t.amount < 0 ? this.money(-t.amount, { sign: true, cents: 'always' }) : this.money(t.amount, { cents: 'always' }))}</span>
        </li>`;
    },

    /** Category picker for one row, with "every purchase from this merchant" as a rule. */
    changeCategory(txnId) {
        const app = SpendingApp;
        const t = app.transactions().find(x => x.id === txnId);
        if (!t) return;
        const byKey = app.rulesByKey(app.rules());
        const current = app.categoryOf(t, byKey);
        const merchant = app.merchantOf(t);
        const shown = app.prettyName(t);
        const key = app.merchantKey(merchant);
        const others = key ? app.transactions().filter(x => x.id !== t.id && app.merchantKey(app.merchantOf(x)) === key).length : 0;
        const opts = Object.entries(app.CATEGORIES).map(([id, label]) => `<option value="${id}" ${id === current ? 'selected' : ''}>${this.esc(label)}</option>`).join('');
        const modal = Modal.create({
            title: `Category for ${shown}`,
            className: 'spending-link-modal',
            content: `
                <p class="spending-link-lede">${this.esc(this.money(t.amount, { cents: 'always' }))} on ${this.esc(this.dayLabel(t.date, { weekday: true }))}. The bank filed it under <strong>${this.esc(app.categoryLabel(t.plaidCategory?.primary || 'OTHER'))}</strong>.</p>
                <label class="spending-field"><span>Category</span><select id="spending-cat-select">${opts}</select></label>
                <label class="spending-check"><input type="checkbox" id="spending-cat-all" ${others ? 'checked' : ''}> Apply to every purchase from ${this.esc(shown)}${others ? ` (${others} other${others === 1 ? '' : 's'}, and future ones)` : ' (and future ones)'}</label>
                ${byKey[key] ? `<button type="button" class="spending-text-btn" id="spending-cat-forget">Forget the rule for ${this.esc(byKey[key].merchant || shown)}</button>` : ''}`,
            buttons: [
                { text: 'Cancel', className: 'secondary-btn', onClick: () => modal.close() },
                {
                    text: 'Save', className: 'primary-btn', onClick: () => {
                        const cat = modal.element.querySelector('#spending-cat-select')?.value;
                        const all = !!modal.element.querySelector('#spending-cat-all')?.checked;
                        app.setCategory(t.id, cat, { allFromMerchant: all });
                        modal.close();
                        app.render();
                    }
                }
            ]
        });
        modal.element.querySelector('#spending-cat-forget')?.addEventListener('click', () => {
            app.removeRule(key);
            modal.close();
            app.render();
        });
    },

    // ── Wiring ───────────────────────────────────────────────────────────

    _wire() {
        if (this._wired) return;
        this._wired = true;
        document.getElementById('spending-link-btn')?.addEventListener('click', async () => {
            const btn = document.getElementById('spending-link-btn');
            btn.disabled = true;
            try { await SpendingSync.link(); } finally { btn.disabled = false; SpendingApp.render(); }
        });
        document.getElementById('spending-sync-btn')?.addEventListener('click', async () => {
            await SpendingSync.sync(null, { manual: true });
            SpendingApp.render();
        });
    },

    _wireBody(body) {
        const app = SpendingApp;
        body.querySelector('#spending-empty-link')?.addEventListener('click', async (e) => {
            e.currentTarget.disabled = true;
            try { await SpendingSync.link(); } finally { app.render(); }
        });
        body.querySelectorAll('[data-jump-month]').forEach(b => b.addEventListener('click', () => app.show({ month: b.dataset.jumpMonth })));
        body.querySelectorAll('.spending-month-btn, .spending-month-today').forEach(b => b.addEventListener('click', () => app.show({ month: b.dataset.month })));
        body.querySelectorAll('.spending-bar-g').forEach(g => g.addEventListener('click', () => app.show({ month: g.dataset.month })));
        body.querySelectorAll('[data-page]').forEach(b => b.addEventListener('click', () => app.show({ page: b.dataset.page })));
        body.querySelectorAll('.spending-scope-x').forEach(b => b.addEventListener('click', () => app.show({ accountId: null })));
        body.querySelectorAll('.spending-relink').forEach(b => b.addEventListener('click', async () => {
            b.disabled = true;
            try { await SpendingSync.relink(b.dataset.item); } finally { app.render(); }
        }));
        // A category, merchant or recurring row opens the Transactions page filtered to it.
        body.querySelectorAll('[data-filter]').forEach(el => el.addEventListener('click', () => app.show({ page: 'transactions', filter: el.dataset.filter })));
        const filter = body.querySelector('#spending-filter');
        if (filter) {
            let timer = null;
            filter.addEventListener('input', () => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    app._filter = filter.value;
                    const card = body.querySelector('.spending-rows-card');
                    const list = card?.querySelector('.spending-rows, .spending-quiet');
                    const scopeAccount = app._accountFilter ? app.accountById(app._accountFilter) : null;
                    if (list) { list.outerHTML = this.rows(app.currentMonth(), { scopeAccount }); this._wireRows(card); }
                }, 120);
            });
        }
        this._wireRows(body);
    },

    _wireRows(root) {
        root.querySelectorAll('.spending-cat-btn').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); this.changeCategory(b.dataset.txn); }));
    }
};
