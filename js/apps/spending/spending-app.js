/**
 * Spending — where the money goes (docs/SPENDING.md). Bank and credit-card
 * transactions linked through Plaid on Anjadhe Connect, shown by month,
 * category and merchant. Behind the `brokerage` feature flag with the
 * Portfolio linking it shares a door with.
 *
 * The laws, in brief:
 *
 *  - The Mac holds NO bank credential. Connect keeps the sealed Plaid token;
 *    the synced `spending` blob carries `links` (one per institution:
 *    itemId, the transactions-sync CURSOR, lastSyncAt, needsLogin,
 *    linkedMachineId), `accounts` (the bank's accounts + balances),
 *    `transactions` (Plaid's id IS the record id; the bank's fields, plus
 *    the user's own `category` override) and `rules` (merchant → category,
 *    keyed by the normalised merchant). Record-merged + tombstoned
 *    (main.js RECORD_MERGE_ARRAYS), so the linking Mac's syncs and the
 *    other Mac's category edits both survive.
 *  - Transactions are PROXIED by Connect, never stored or logged there.
 *  - The linking Mac is the pulling Mac (Connect keys are per Mac); the
 *    other Mac reads what sync brings.
 *  - Sync is Plaid's cursor protocol: added / modified / removed pages
 *    until has_more is false, THEN the cursor is saved — a cut-off run
 *    simply asks for the same page again. Pending rows settle when the
 *    posted row names them (`pendingId`) or Plaid removes them.
 *  - Nothing here is model-written: categories come from Plaid's
 *    personal-finance taxonomy, the user's override wins, and every number
 *    on the page is arithmetic over the rows. No budgets (by decision,
 *    2026-09-09).
 *  - "Spending" = money out that is not a transfer, an income line or a
 *    credit-card payment (paying the card is not a second purchase).
 *    Refunds inside a category net against it.
 *
 * The pure functions (everything above `_data`) are plain data in, plain
 * data out, Node-exported and pinned by tests/spending-test.js.
 */
const SpendingApp = {
    KEY: 'spending',
    HISTORY_MONTHS: 24,

    // Plaid personal_finance_category.primary → label. Order = display
    // order in breakdowns when totals tie.
    CATEGORIES: {
        FOOD_AND_DRINK: 'Food & drink',
        GENERAL_MERCHANDISE: 'Shopping',
        GROCERIES: 'Groceries',
        TRANSPORTATION: 'Transportation',
        TRAVEL: 'Travel',
        RENT_AND_UTILITIES: 'Rent & utilities',
        HOME_IMPROVEMENT: 'Home',
        MEDICAL: 'Medical',
        PERSONAL_CARE: 'Personal care',
        ENTERTAINMENT: 'Entertainment',
        GENERAL_SERVICES: 'Services',
        GOVERNMENT_AND_NON_PROFIT: 'Government & giving',
        LOAN_PAYMENTS: 'Loan payments',
        BANK_FEES: 'Bank fees',
        INCOME: 'Income',
        TRANSFER_IN: 'Transfer in',
        TRANSFER_OUT: 'Transfer out',
        OTHER: 'Other'
    },
    // Not spending: money moving between the user's own accounts, income,
    // and paying the credit card (its purchases are already counted).
    NOT_SPEND: new Set(['INCOME', 'TRANSFER_IN', 'TRANSFER_OUT']),
    NOT_SPEND_DETAILED: new Set(['LOAN_PAYMENTS_CREDIT_CARD_PAYMENT']),

    // ── Pure ─────────────────────────────────────────────────────────────

    /** Plaid's checking/savings/credit vocabulary → ours. */
    accountTypeFor(plaidAccount) {
        const t = String(plaidAccount?.type || '').toLowerCase();
        const s = String(plaidAccount?.subtype || '').toLowerCase();
        if (t === 'credit') return 'credit';
        if (t === 'loan') return 'loan';
        if (t === 'depository') {
            if (s === 'savings' || s === 'money market' || s === 'cd') return 'savings';
            return 'checking';
        }
        return 'other';
    },

    /** Only accounts that carry everyday transactions belong here. */
    isBankAccount(plaidAccount) {
        const t = String(plaidAccount?.type || '').toLowerCase();
        return t === 'depository' || t === 'credit';
    },

    /** "Chase Checking ····1234" */
    accountNameFor(plaidAccount, institution) {
        const inst = String(institution || '').trim();
        const nm = String(plaidAccount?.name || plaidAccount?.officialName || 'Account').trim();
        const base = inst && !nm.toLowerCase().includes(inst.toLowerCase()) ? `${inst} ${nm}` : nm;
        return plaidAccount?.mask ? `${base} ····${plaidAccount.mask}` : base;
    },

    /** The record a rule is keyed by: "starbucks" for "Starbucks #1234", "STARBUCKS STORE 12". */
    merchantKey(name) {
        return String(name || '').toLowerCase()
            .replace(/\b(pos|purchase|debit|credit|card|payment|online|www|com|inc|llc|ltd|co)\b/g, ' ')
            .replace(/[#*]\s*\d+\w*/g, ' ')
            .replace(/\b\d{3,}\b/g, ' ')
            .replace(/[^a-z0-9]+/g, ' ')
            .trim().split(/\s+/).slice(0, 3).join(' ');
    },

    /** What a row is called on the page: the merchant when Plaid found one, else the bank's description. */
    merchantOf(t) {
        return String(t?.merchant || t?.name || 'Unknown').trim() || 'Unknown';
    },

    /**
     * The name as the page prints it. Plaid's merchant is already clean;
     * a bank's raw description ("ZELLE TO PARKMERCED APTS", "ACH DEPOSIT
     * GUSTO PAYROLL") is shouted upper-case with reference numbers, so it
     * is title-cased and its trailing ids trimmed. Display only — the
     * stored row keeps the bank's text.
     */
    prettyName(t) {
        if (t?.merchant) return String(t.merchant).trim();
        let s = String(t?.name || 'Unknown').trim();
        if (!s) return 'Unknown';
        if (s === s.toUpperCase() && /[A-Z]/.test(s)) {
            s = s.replace(/[*#][A-Z0-9*#-]*$/g, '').replace(/\s+(#|\*)?[A-Z0-9*#-]*\d[A-Z0-9*#-]*$/g, '').replace(/\s{2,}/g, ' ').trim();
            const small = new Set(['to', 'of', 'and', 'the', 'for', 'at', 'from', 'a', 'in', 'on']);
            s = s.toLowerCase().split(' ').map((w, i) => {
                if (/^(ach|atm|pos|llc|inc|usa|sf|nyc|la|tv|hoa|irs|dmv)$/.test(w)) return w.toUpperCase();
                if (i && small.has(w)) return w;
                return w.charAt(0).toUpperCase() + w.slice(1);
            }).join(' ');
        }
        return s || 'Unknown';
    },

    /** Two-letter monogram for a merchant row. */
    monogram(name) {
        const words = String(name || '').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
        if (!words.length) return '·';
        if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
        return (words[0][0] + words[1][0]).toUpperCase();
    },

    /**
     * The category a row counts under: the user's rule for its merchant,
     * else the user's override on the row, else Plaid's primary, else
     * OTHER. Returns the id; label via categoryLabel.
     */
    categoryOf(t, rulesByKey) {
        const key = this.merchantKey(this.merchantOf(t));
        const rule = rulesByKey && key ? rulesByKey[key] : null;
        if (rule && rule.category) return rule.category;
        if (t?.category && typeof t.category === 'string') return t.category;
        const p = t?.plaidCategory?.primary;
        return p && this.CATEGORIES[p] ? p : 'OTHER';
    },

    categoryLabel(id) {
        return this.CATEGORIES[id] || String(id || 'Other').toLowerCase().replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
    },

    /** Money out that is really spending (see the header). */
    isSpend(t, cat) {
        if (!t || !(t.amount > 0)) return false;
        if (this.NOT_SPEND.has(cat)) return false;
        if (t.plaidCategory?.detailed && this.NOT_SPEND_DETAILED.has(t.plaidCategory.detailed) && cat === 'LOAN_PAYMENTS') return false;
        return true;
    },

    /** A refund in a spending category nets against it. */
    isRefund(t, cat) {
        return !!t && t.amount < 0 && !this.NOT_SPEND.has(cat);
    },

    monthKey(date) {
        return String(date || '').slice(0, 7);
    },

    addMonths(month, n) {
        const [y, m] = String(month).split('-').map(Number);
        const d = new Date(Date.UTC(y, m - 1 + n, 1));
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    },

    monthLabel(month) {
        const [y, m] = String(month).split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    },

    rulesByKey(rules) {
        const out = {};
        for (const r of Array.isArray(rules) ? rules : []) if (r && r.id) out[r.id] = r;
        return out;
    },

    /**
     * One month in numbers. `spend` is GROSS purchases (what left the
     * accounts as spending), `refunds` what came back in spending
     * categories, `net` the difference — the headline is gross, because a
     * month with one big refund otherwise read as "you spent −$315" (the
     * sandbox did exactly that, 2026-09-09). Per-category and per-merchant
     * totals are NET (a refund belongs to what it refunded). `upTo`
     * (YYYY-MM-DD) caps the window so "same point last month" is honest.
     */
    monthSummary(transactions, rules, month, { upTo = null } = {}) {
        const byKey = this.rulesByKey(rules);
        const cats = new Map();
        const merchants = new Map();
        let spend = 0, refunds = 0, income = 0, transfersOut = 0, transfersIn = 0, count = 0, pending = 0;
        for (const t of Array.isArray(transactions) ? transactions : []) {
            if (!t || this.monthKey(t.date) !== month) continue;
            if (upTo && String(t.date) > upTo) continue;
            const cat = this.categoryOf(t, byKey);
            if (cat === 'INCOME' && t.amount < 0) { income += -t.amount; continue; }
            if (cat === 'TRANSFER_IN') { transfersIn += -t.amount; continue; }
            if (cat === 'TRANSFER_OUT') { transfersOut += t.amount; continue; }
            const spends = this.isSpend(t, cat);
            const refunded = this.isRefund(t, cat);
            if (!spends && !refunded) continue;
            const amt = t.amount;
            if (spends) { spend += amt; count++; } else refunds += -amt;
            if (t.pending) pending++;
            const c = cats.get(cat) || { id: cat, label: this.categoryLabel(cat), total: 0, count: 0 };
            c.total += amt; c.count++; cats.set(cat, c);
            const name = this.merchantOf(t);
            const mk = this.merchantKey(name) || name.toLowerCase();
            const m = merchants.get(mk) || { key: mk, name, total: 0, count: 0, category: cat };
            m.total += amt; m.count++; merchants.set(mk, m);
        }
        const r2 = n => Math.round(n * 100) / 100;
        const byCategory = [...cats.values()].map(c => ({ ...c, total: r2(c.total) })).filter(c => c.total !== 0).sort((a, b) => b.total - a.total);
        const byMerchant = [...merchants.values()].map(m => ({ ...m, total: r2(m.total) })).filter(m => m.total !== 0).sort((a, b) => b.total - a.total);
        return { month, spend: r2(spend), refunds: r2(refunds), net: r2(spend - refunds), income: r2(income), transfersIn: r2(transfersIn), transfersOut: r2(transfersOut), count, pending, byCategory, byMerchant };
    },

    /** Spend per month for the `n` months ending at `month` (oldest first): [{month, spend}]. */
    monthTrend(transactions, rules, month, n = 12) {
        const out = [];
        for (let i = n - 1; i >= 0; i--) {
            const m = this.addMonths(month, -i);
            out.push({ month: m, spend: this.monthSummary(transactions, rules, m).spend });
        }
        return out;
    },

    /** Spend per calendar day of `month`: array indexed 0..days-1, plus the busiest day. */
    dailySpend(transactions, rules, month) {
        const [y, mo] = String(month).split('-').map(Number);
        const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
        const out = new Array(days).fill(0);
        const byKey = this.rulesByKey(rules);
        for (const t of Array.isArray(transactions) ? transactions : []) {
            if (!t || this.monthKey(t.date) !== month) continue;
            const cat = this.categoryOf(t, byKey);
            if (!this.isSpend(t, cat) && !this.isRefund(t, cat)) continue;
            const d = Number(String(t.date).slice(8, 10)) - 1;
            if (d >= 0 && d < days) out[d] += t.amount;
        }
        let top = -1, topV = 0;
        out.forEach((v, i) => { if (v > topV) { topV = v; top = i; } });
        return { days: out.map(v => Math.round(v * 100) / 100), top: top >= 0 ? top + 1 : null, topValue: Math.round(topV * 100) / 100 };
    },

    /**
     * Charges that come back on a beat: a merchant with ≥3 spends whose
     * gaps are all roughly a month (25–35 days) or a week (6–8 days), at
     * a steady amount (within 20% of the median, or the median ± $2).
     * Pure date arithmetic — nothing is guessed. `next` is last + cadence.
     */
    recurring(transactions, rules, { today = null } = {}) {
        const byKey = this.rulesByKey(rules);
        const groups = new Map();
        for (const t of Array.isArray(transactions) ? transactions : []) {
            if (!t || t.pending) continue;
            const cat = this.categoryOf(t, byKey);
            if (!this.isSpend(t, cat)) continue;
            const name = this.merchantOf(t);
            const key = this.merchantKey(name) || name.toLowerCase();
            const g = groups.get(key) || { key, name, category: cat, rows: [] };
            g.rows.push({ date: String(t.date).slice(0, 10), amount: t.amount });
            groups.set(key, g);
        }
        const dayMs = 86400000;
        const days = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / dayMs);
        const out = [];
        for (const g of groups.values()) {
            const rows = g.rows.sort((a, b) => a.date.localeCompare(b.date));
            if (rows.length < 3) continue;
            const amounts = rows.map(r => r.amount).sort((a, b) => a - b);
            const median = amounts[Math.floor(amounts.length / 2)];
            const steady = rows.every(r => Math.abs(r.amount - median) <= Math.max(2, median * 0.2));
            if (!steady) continue;
            const gaps = [];
            for (let i = 1; i < rows.length; i++) gaps.push(days(rows[i - 1].date, rows[i].date));
            let cadence = null;
            if (gaps.every(d => d >= 25 && d <= 35)) cadence = 'monthly';
            else if (gaps.every(d => d >= 6 && d <= 8)) cadence = 'weekly';
            else if (gaps.every(d => d >= 360 && d <= 370)) cadence = 'yearly';
            if (!cadence) continue;
            const last = rows[rows.length - 1].date;
            const step = cadence === 'monthly' ? 30 : cadence === 'weekly' ? 7 : 365;
            const next = new Date(Date.parse(last + 'T00:00:00Z') + step * dayMs).toISOString().slice(0, 10);
            // A beat that stopped (no charge for two periods) is history, not a subscription.
            if (today && days(last, today) > step * 2 + 5) continue;
            out.push({ key: g.key, name: g.name, category: g.category, cadence, amount: Math.round(median * 100) / 100, count: rows.length, last, next });
        }
        return out.sort((a, b) => b.amount - a.amount);
    },

    /**
     * Apply one page of Plaid's transactions/sync to the blob (mutates).
     * `accountIdFor` maps a Plaid account id to a Spending account id (null
     * = an account the user did not add; its rows are dropped). Returns
     * counts. A row the user re-categorised keeps the override through a
     * modification; a removed row is tombstoned; a posted row that names
     * its pending twin retires the twin.
     */
    applySyncPage(blob, page, accountIdFor, { now = new Date().toISOString() } = {}) {
        const txns = blob.transactions;
        const byId = new Map(txns.map(t => [t.id, t]));
        const counts = { added: 0, modified: 0, removed: 0 };
        const tomb = (id) => { blob.tombstones = blob.tombstones || {}; blob.tombstones[id] = now; };
        const drop = (id) => {
            if (!byId.has(id)) return false;
            byId.delete(id);
            const i = txns.findIndex(t => t.id === id);
            if (i >= 0) txns.splice(i, 1);
            tomb(id);
            return true;
        };
        const shape = (t, accountId) => ({
            id: t.id,
            accountId,
            date: String(t.date || '').slice(0, 10),
            authorizedDate: t.authorizedDate ? String(t.authorizedDate).slice(0, 10) : null,
            name: String(t.name || '').slice(0, 200),
            merchant: t.merchant ? String(t.merchant).slice(0, 120) : null,
            amount: Math.round((Number(t.amount) || 0) * 100) / 100,
            currency: t.currency || 'USD',
            pending: !!t.pending,
            pendingId: t.pendingId || null,
            channel: t.channel || null,
            plaidCategory: t.category && t.category.primary ? { primary: String(t.category.primary), detailed: t.category.detailed ? String(t.category.detailed) : null } : null
        });
        for (const t of page.added || []) {
            if (!t || !t.id || !t.date) continue;
            const accountId = accountIdFor(t.accountId);
            if (!accountId) continue;
            const existing = byId.get(t.id);
            if (existing) {
                Object.assign(existing, shape(t, accountId), { category: existing.category || null, updatedAt: now });
                counts.modified++;
            } else {
                const row = { ...shape(t, accountId), category: null, createdAt: now, updatedAt: now };
                txns.push(row); byId.set(row.id, row);
                counts.added++;
            }
            // A posted row retires the pending row it settles.
            if (t.pendingId && t.pendingId !== t.id) {
                const twin = byId.get(t.pendingId);
                if (twin) {
                    const cur = byId.get(t.id);
                    if (twin.category && !cur.category) cur.category = twin.category;
                    drop(t.pendingId);
                }
            }
        }
        for (const t of page.modified || []) {
            if (!t || !t.id) continue;
            const existing = byId.get(t.id);
            const accountId = accountIdFor(t.accountId);
            if (!accountId) { if (existing) { drop(t.id); counts.removed++; } continue; }
            if (!existing) {
                const row = { ...shape(t, accountId), category: null, createdAt: now, updatedAt: now };
                txns.push(row); byId.set(row.id, row);
                counts.added++;
                continue;
            }
            Object.assign(existing, shape(t, accountId), { category: existing.category || null, updatedAt: now });
            counts.modified++;
        }
        for (const r of page.removed || []) {
            const id = typeof r === 'string' ? r : r?.id;
            if (id && drop(id)) counts.removed++;
        }
        return counts;
    },

    /** Rows older than the history window are pruned on save (tombstoned so the other Mac prunes too). */
    pruneOld(blob, { today, months = this.HISTORY_MONTHS, now = new Date().toISOString() } = {}) {
        const floor = this.addMonths(this.monthKey(today), -(months - 1)) + '-01';
        const keep = [];
        let pruned = 0;
        for (const t of blob.transactions) {
            if (t.date && t.date < floor) { blob.tombstones = blob.tombstones || {}; blob.tombstones[t.id] = now; pruned++; }
            else keep.push(t);
        }
        blob.transactions = keep;
        return pruned;
    },

    // ── State ────────────────────────────────────────────────────────────

    _data: null,
    _initialized: false,
    _month: null,
    _filter: '',
    _accountFilter: null,   // the nav's account scope; null = every account
    _page: 'overview',      // overview | categories | merchants | recurring | transactions

    PAGES: [
        { id: 'overview', label: 'Overview' },
        { id: 'categories', label: 'Categories' },
        { id: 'merchants', label: 'Merchants' },
        { id: 'recurring', label: 'Recurring' },
        { id: 'transactions', label: 'Transactions' }
    ],

    init() {
        if (this._initialized) return;
        this._initialized = true;
        this.loadData();
        if (typeof SpendingSync !== 'undefined') SpendingSync.init();
        if (typeof NavResizer !== 'undefined') {
            NavResizer.attach({
                layoutSel: '#spending-view .spending-layout',
                resizerId: 'spending-nav-resizer',
                cssVar: '--spending-nav-width',
                storageKey: 'spending-nav-width',
                defaultW: 210,
                min: 150,
                max: 400
            });
        }
        document.getElementById('spending-sidebar-toggle')?.addEventListener('click', () => {
            const layout = document.querySelector('#spending-view .spending-layout');
            if (!layout) return;
            const collapsed = layout.classList.toggle('sidebar-collapsed');
            try { localStorage.setItem('spending-sidebar-collapsed', collapsed ? '1' : '0'); } catch { /* per-Mac nicety */ }
        });
        try {
            if (localStorage.getItem('spending-sidebar-collapsed') === '1') document.querySelector('#spending-view .spending-layout')?.classList.add('sidebar-collapsed');
        } catch { /* ignore */ }
    },

    /** Navigate: a page, optionally with an account scope and a text filter. */
    show({ page = null, accountId, filter, month } = {}) {
        if (page && this.PAGES.some(p => p.id === page)) this._page = page;
        if (accountId !== undefined) this._accountFilter = accountId || null;
        if (filter !== undefined) this._filter = filter || '';
        if (month !== undefined) this._month = month || null;
        this.render();
        window.scrollTo({ top: 0 });
    },

    empty() {
        return { links: [], accounts: [], transactions: [], rules: [], tombstones: {} };
    },

    loadData() {
        const d = StorageManager.get(this.KEY);
        const blob = (d && typeof d === 'object') ? d : {};
        this._data = {
            links: Array.isArray(blob.links) ? blob.links : [],
            accounts: Array.isArray(blob.accounts) ? blob.accounts : [],
            transactions: Array.isArray(blob.transactions) ? blob.transactions : [],
            rules: Array.isArray(blob.rules) ? blob.rules : [],
            tombstones: (blob.tombstones && typeof blob.tombstones === 'object') ? blob.tombstones : {}
        };
        return this._data;
    },

    get data() {
        if (!this._data) this.loadData();
        return this._data;
    },

    /**
     * Persist. `blob` lets a long-running writer (SpendingSync.sync, which
     * awaits Connect between pages) save the object it built even if a
     * render's loadData() swapped `_data` for a fresh copy meanwhile — the
     * first sync lost every row that way (2026-09-09: the page re-rendered
     * after the picker closed, and the sync's final save wrote the empty
     * reloaded blob). The main-process record union keeps anything newer
     * that landed in the store in between.
     */
    saveData(blob = null) {
        if (blob) this._data = blob;
        if (!this._data) return;
        StorageManager.set(this.KEY, {
            links: this._data.links,
            accounts: this._data.accounts,
            transactions: this._data.transactions,
            rules: this._data.rules,
            tombstones: this._data.tombstones || {},
            modifiedAt: new Date().toISOString()
        });
        // Re-read: the main-process record union may have kept rows this
        // renderer never loaded (the other Mac's category edits).
        this.loadData();
    },

    /** Call BEFORE removing a record in every delete path (record-merged blob). */
    _tombstone(id) {
        if (!id) return;
        this.data.tombstones = this.data.tombstones || {};
        this.data.tombstones[id] = new Date().toISOString();
    },

    today() {
        return (typeof UIUtils !== 'undefined') ? UIUtils.todayISO() : new Date().toISOString().slice(0, 10);
    },

    /**
     * The month on screen: the user's pick, else this month — unless this
     * month has no rows and an earlier one does (a fresh link whose bank
     * posts lag, a sandbox whose data sits in the past), in which case the
     * latest month with rows, so a page never opens empty over real data.
     */
    currentMonth() {
        if (this._month) return this._month;
        const now = this.monthKey(this.today());
        if (this.data.transactions.some(t => this.monthKey(t?.date) === now)) return now;
        const latest = this.monthsWithData().find(m => m !== now && m < now);
        return latest || now;
    },

    accounts() { return this.data.accounts.filter(a => a && a.id); },
    transactions() { return this.data.transactions; },
    rules() { return this.data.rules; },
    links() { return this.data.links; },

    accountById(id) { return this.data.accounts.find(a => a.id === id) || null; },

    /** The month's rows, newest first, through the page's text/account filters. */
    monthRows(month = this.currentMonth(), { filter = this._filter, accountId = this._accountFilter } = {}) {
        const q = String(filter || '').trim().toLowerCase();
        const byKey = this.rulesByKey(this.data.rules);
        return this.data.transactions
            .filter(t => t && this.monthKey(t.date) === month)
            .filter(t => !accountId || t.accountId === accountId)
            .filter(t => !q || this.merchantOf(t).toLowerCase().includes(q) || String(t.name || '').toLowerCase().includes(q) || this.categoryLabel(this.categoryOf(t, byKey)).toLowerCase().includes(q))
            .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id)));
    },

    /** Months with any rows, newest first — the month picker's range. */
    monthsWithData() {
        const set = new Set();
        for (const t of this.data.transactions) if (t?.date) set.add(this.monthKey(t.date));
        set.add(this.monthKey(this.today()));
        return [...set].sort().reverse();
    },

    /** Rows outside `month`, for the empty-month line. */
    rowsElsewhere(month) {
        let n = 0, latest = null;
        for (const t of this.data.transactions) {
            const m = this.monthKey(t?.date);
            if (!m || m === month) continue;
            n++;
            if (!latest || m > latest) latest = m;
        }
        return { count: n, latest };
    },

    /** The rows the page is looking at: every account, or the one the rail selected. */
    scopedTransactions(accountId = this._accountFilter) {
        return accountId ? this.data.transactions.filter(t => t && t.accountId === accountId) : this.data.transactions;
    },

    /** Unscoped by default (tools and the widget read the whole book); pass accountId for the page's scope. */
    summary(month = this.currentMonth(), { upTo = null, accountId = null } = {}) {
        return this.monthSummary(this.scopedTransactions(accountId), this.data.rules, month, { upTo });
    },

    /**
     * Re-categorise: the row alone, or every row from its merchant (a rule,
     * which also covers rows that arrive later). Both are user edits and
     * stamp updatedAt.
     */
    setCategory(txnId, category, { allFromMerchant = false } = {}) {
        const t = this.data.transactions.find(x => x.id === txnId);
        if (!t) return false;
        const now = new Date().toISOString();
        const cat = this.CATEGORIES[category] ? category : 'OTHER';
        if (allFromMerchant) {
            const key = this.merchantKey(this.merchantOf(t));
            if (key) {
                const existing = this.data.rules.find(r => r.id === key);
                if (existing) { existing.category = cat; existing.merchant = this.merchantOf(t); existing.updatedAt = now; }
                else this.data.rules.push({ id: key, merchant: this.merchantOf(t), category: cat, createdAt: now, updatedAt: now });
                // Row-level overrides under the rule would silently outrank
                // it the next time the rule changes — clear them.
                for (const x of this.data.transactions) {
                    if (x.category && this.merchantKey(this.merchantOf(x)) === key) { x.category = null; x.updatedAt = now; }
                }
            }
        }
        t.category = cat;
        t.updatedAt = now;
        this.saveData();
        return true;
    },

    removeRule(key) {
        const i = this.data.rules.findIndex(r => r.id === key);
        if (i < 0) return false;
        this._tombstone(key);
        this.data.rules.splice(i, 1);
        this.saveData();
        return true;
    },

    render() {
        this.loadData();
        if (typeof SpendingUI !== 'undefined') SpendingUI.render();
        if (typeof SpendingSync !== 'undefined') SpendingSync.ensureFresh();
    }
};

if (typeof AppManager !== 'undefined') AppManager.register('spending', SpendingApp);

// Ambient context: what the assistant knows about this month without a
// tool call — one line of arithmetic, never the rows (those are a gated
// read behind the `spending` privacy class).
if (typeof AgentContext !== 'undefined' && typeof AgentContext.register === 'function') {
    AgentContext.register('spending', () => {
        SpendingApp.loadData();
        if (!SpendingApp.accounts().length || !SpendingApp.transactions().length) return null;
        const today = SpendingApp.today();
        const month = SpendingApp.monthKey(today);
        const cur = SpendingApp.summary(month);
        const top = cur.byCategory.slice(0, 3).map(c => `${c.label} $${Math.round(c.total)}`).join(', ');
        return {
            recordKey: 'spending:summary',
            recordLabel: 'Spending this month',
            title: 'SPENDING SNAPSHOT',
            body: `The user is viewing Spending (${SpendingApp.accounts().length} linked bank/card account${SpendingApp.accounts().length === 1 ? '' : 's'}). So far in ${SpendingApp.monthLabel(month)}: $${Math.round(cur.spend)} across ${cur.count} purchases${top ? ` (top: ${top})` : ''}. Use spending_summary and list_spending for detail; set_spending_category to re-file a purchase.`,
            suggestedPrompts: [
                'Where did most of my money go this month?',
                'What am I paying for every month?',
                'How does this month compare with last month?'
            ]
        };
    });
}

if (typeof module !== 'undefined' && module.exports) module.exports = SpendingApp;
