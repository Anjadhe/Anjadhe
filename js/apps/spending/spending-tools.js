/**
 * Spending — the package's contribution to the assistant.
 *
 * Registered HERE, from the app's own folder (docs/PLATFORM.md "App
 * packages"): the tools with their policy, the words that summon the
 * group, the ⌘K/search_all source. Reads carry `dataClass: 'spending'`
 * (a CloudPrivacy class that is OFF by default — bank rows are the most
 * revealing data in the app after journal entries) and are untrusted-
 * blocked; the two writes ask. Nothing in js/agent/ or js/core/ names
 * spending.
 */
(function registerSpendingTools() {
    if (typeof AgentTools === 'undefined' || typeof SpendingApp === 'undefined') return;

    const SOURCE = 'spending';
    const esc = (v) => (typeof UIUtils !== 'undefined' ? UIUtils.escapeHtml(String(v == null ? '' : v)) : String(v == null ? '' : v));
    const reg = (def, handler, opts) => AgentTools.register({ type: 'function', function: def }, handler, Object.assign({ source: SOURCE, group: SOURCE }, opts || {}));
    const r2 = n => Math.round((n || 0) * 100) / 100;

    // ── The words that summon the group ────────────────────────────────
    const VOCAB = /\b(spending|spend|spent|expens\w*|purchas\w*|bank|checking|savings|credit\s?cards?|debit|merchants?|bills?|subscriptions?|recurring|groceries|restaurants?|dining|utilities|rent|paycheck|deposits?|withdraw\w*|charges?|refunds?|transactions?|money\s+(went|going|goes)|how\s+much\s+(did|do|have)\s+i)\b/;
    function mentionsAccountName(s) {
        try {
            const accounts = StorageManager.get('spending')?.accounts || [];
            const flat = s.replace(/[^a-z0-9]/g, '');
            return accounts.some(a => {
                const n = (a.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                return n.length >= 4 && flat.includes(n);
            });
        } catch { return false; }
    }
    AgentTools.registerDomain(SOURCE, (s) => VOCAB.test(s) || mentionsAccountName(s));

    function findAccount(name) {
        const want = String(name || '').trim().toLowerCase();
        if (!want) return null;
        const accounts = SpendingApp.accounts();
        return accounts.find(a => String(a.name || '').toLowerCase() === want)
            || accounts.find(a => String(a.name || '').toLowerCase().includes(want))
            || null;
    }

    function monthArg(v) {
        const s = String(v || '').trim();
        if (/^\d{4}-\d{2}$/.test(s)) return s;
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.slice(0, 7);
        return null;
    }

    function rowOut(t, byKey) {
        return {
            id: t.id,
            date: t.date,
            merchant: SpendingApp.merchantOf(t),
            description: t.name && t.name !== t.merchant ? t.name : undefined,
            amount: t.amount,           // Plaid's sign: positive = money out
            category: SpendingApp.categoryLabel(SpendingApp.categoryOf(t, byKey)),
            pending: t.pending || undefined,
            account: SpendingApp.accountById(t.accountId)?.name || null
        };
    }

    reg({
        name: 'spending_summary',
        description: 'Spending overview for one month (default: the current month): total spent (gross purchases; refunds reported separately with the net), the same point last month, income, transfers, spending by category and by merchant (net of refunds), charges that come back every month, and each linked account\'s balance. Amounts are USD; "spent" excludes transfers, income and credit-card payments. Call this first for "how much did I spend", "where does my money go", "what am I paying for every month".',
        parameters: { type: 'object', properties: {
            month: { type: 'string', description: 'YYYY-MM (default: this month)' }
        }}
    }, (args = {}) => {
        SpendingApp.loadData();
        if (!SpendingApp.accounts().length) return { linked: false, hint: 'No bank or card is linked. In Spending, click "+ Link a bank or card" to connect one through Anjadhe Cloud.' };
        const today = SpendingApp.today();
        const month = monthArg(args.month) || SpendingApp.monthKey(today);
        const cur = SpendingApp.summary(month);
        const prevMonth = SpendingApp.addMonths(month, -1);
        const isCurrent = month === SpendingApp.monthKey(today);
        const prev = SpendingApp.summary(prevMonth, isCurrent ? { upTo: `${prevMonth}-${today.slice(8, 10)}` } : {});
        const rec = SpendingApp.recurring(SpendingApp.transactions(), SpendingApp.rules(), { today });
        return {
            month,
            partial: isCurrent || undefined,
            spent: cur.spend,
            refunds: cur.refunds || undefined,
            net: cur.refunds ? cur.net : undefined,
            lastMonth: { month: prevMonth, spent: prev.spend, samePoint: isCurrent || undefined, change: r2(cur.spend - prev.spend) },
            income: cur.income,
            transfersOut: cur.transfersOut,
            purchases: cur.count,
            pending: cur.pending || undefined,
            byCategory: cur.byCategory.map(c => ({ category: c.label, total: c.total, purchases: c.count })),
            topMerchants: cur.byMerchant.slice(0, 10).map(m => ({ merchant: m.name, total: m.total, purchases: m.count })),
            recurring: rec.slice(0, 15).map(r => ({ merchant: r.name, amount: r.amount, cadence: r.cadence, last: r.last, nextAbout: r.next })),
            accounts: SpendingApp.accounts().map(a => ({ name: a.name, type: a.type, balance: a.balance?.current ?? null, owed: a.type === 'credit' || undefined }))
        };
    }, { dataClass: 'spending', blockUntrusted: true, readOnly: true });

    reg({
        name: 'list_spending',
        description: 'List bank and card transactions, newest first (cap 60). Filter by month, a date range, category, merchant text, or account. Amounts positive = money out, negative = money in (refunds, deposits). Use spending_summary for totals; this is for the rows behind them ("what did I buy at Costco", "show last week\'s purchases").',
        parameters: { type: 'object', properties: {
            month: { type: 'string', description: 'YYYY-MM' },
            from: { type: 'string', description: 'YYYY-MM-DD (inclusive)' },
            to: { type: 'string', description: 'YYYY-MM-DD (inclusive)' },
            category: { type: 'string', description: 'Category label or id, e.g. "Groceries" or GROCERIES' },
            search: { type: 'string', description: 'Merchant or description text' },
            accountName: { type: 'string', description: 'One linked account by name' },
            limit: { type: 'number', description: 'Default 40, max 60' }
        }}
    }, (args = {}) => {
        SpendingApp.loadData();
        if (!SpendingApp.accounts().length) return { linked: false, transactions: [] };
        const byKey = SpendingApp.rulesByKey(SpendingApp.rules());
        const month = monthArg(args.month);
        const q = String(args.search || '').trim().toLowerCase();
        const catWant = String(args.category || '').trim().toLowerCase();
        const acct = args.accountName ? findAccount(args.accountName) : null;
        if (args.accountName && !acct) return { error: `No linked account named "${args.accountName}"` };
        const limit = Math.max(1, Math.min(60, Number(args.limit) || 40));
        const rows = SpendingApp.transactions()
            .filter(t => !month || SpendingApp.monthKey(t.date) === month)
            .filter(t => !args.from || t.date >= String(args.from).slice(0, 10))
            .filter(t => !args.to || t.date <= String(args.to).slice(0, 10))
            .filter(t => !acct || t.accountId === acct.id)
            .filter(t => {
                if (!catWant) return true;
                const id = SpendingApp.categoryOf(t, byKey);
                return id.toLowerCase() === catWant || SpendingApp.categoryLabel(id).toLowerCase() === catWant;
            })
            .filter(t => !q || SpendingApp.merchantOf(t).toLowerCase().includes(q) || String(t.name || '').toLowerCase().includes(q))
            .sort((a, b) => String(b.date).localeCompare(String(a.date)));
        const out = rows.slice(0, limit).map(t => rowOut(t, byKey));
        const total = r2(rows.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0));
        return { count: rows.length, shown: out.length, totalOut: total, transactions: out };
    }, { dataClass: 'spending', blockUntrusted: true, readOnly: true });

    reg({
        name: 'set_spending_category',
        description: 'Re-categorise a transaction (id from list_spending). With allFromMerchant=true the category becomes a rule for every purchase from that merchant, past and future. Categories: ' + Object.values(SpendingApp.CATEGORIES).join(', ') + '. The user is asked to confirm.',
        parameters: { type: 'object', properties: {
            id: { type: 'string', description: 'Transaction id' },
            category: { type: 'string', description: 'Category label or id' },
            allFromMerchant: { type: 'boolean', description: 'Apply to every purchase from this merchant (default false)' }
        }, required: ['id', 'category'] }
    }, (args = {}) => {
        SpendingApp.loadData();
        const t = SpendingApp.transactions().find(x => x.id === args.id);
        if (!t) return { error: 'No such transaction' };
        const want = String(args.category || '').trim().toLowerCase();
        const id = Object.entries(SpendingApp.CATEGORIES).find(([k, v]) => k.toLowerCase() === want || v.toLowerCase() === want)?.[0];
        if (!id) return { error: `Unknown category "${args.category}"`, categories: Object.values(SpendingApp.CATEGORIES) };
        SpendingApp.setCategory(t.id, id, { allFromMerchant: !!args.allFromMerchant });
        if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'spending') SpendingApp.render();
        return { ok: true, merchant: SpendingApp.merchantOf(t), category: SpendingApp.categoryLabel(id), rule: !!args.allFromMerchant };
    }, {
        ask: true, blockUntrusted: true,
        describe: (args) => `File <strong>${esc(args.id ? (SpendingApp.transactions().find(x => x.id === args.id) ? SpendingApp.merchantOf(SpendingApp.transactions().find(x => x.id === args.id)) : 'a transaction') : 'a transaction')}</strong> under <strong>${esc(args.category || '?')}</strong>${args.allFromMerchant ? ' — and every purchase from that merchant' : ''}`
    });

    // Registered only when the flag is on: an absent tool is the honest
    // shape for a feature the user cannot reach.
    if (typeof SpendingSync !== 'undefined' && SpendingSync.available()) reg({
        name: 'sync_spending',
        description: 'Pull the latest transactions and balances from the user\'s LINKED banks and cards (connected through Anjadhe Cloud). Reports what is linked, how stale each is, and what arrived. Use dryRun=true to only report link status. Linking a new bank is not a tool action: tell the user to click "+ Link a bank or card" in Spending.',
        parameters: { type: 'object', properties: {
            dryRun: { type: 'boolean', description: 'true = report link status only, pull nothing' }
        }}
    }, async (args = {}) => {
        SpendingApp.loadData();
        const links = SpendingApp.links();
        const status = links.map(l => ({
            institution: l.institution || null,
            accounts: SpendingApp.accounts().filter(a => a.itemId === l.id).map(a => a.name),
            lastSyncAt: l.lastSyncAt || null,
            syncsFromThisMac: SpendingSync.isHere(l),
            needsSignIn: !!l.needsLogin
        }));
        if (!links.length) return { linked: [], hint: 'No bank or card is linked. In Spending, click "+ Link a bank or card" to connect one through Anjadhe Cloud.' };
        if (args.dryRun) return { linked: status };
        const r = await SpendingSync.sync(null, { manual: false });
        if (r.busy) return { error: 'A sync is already running', linked: status };
        return { synced: r.synced, added: r.added, modified: r.modified, removed: r.removed, errors: r.errors, linked: status };
    }, {
        ask: true, blockUntrusted: true,
        describe: (args) => args.dryRun ? 'Report which banks and cards are linked (no pull)' : 'Pull the latest transactions from your linked banks and cards through Anjadhe Cloud'
    });

    // ── ⌘K / search_all ────────────────────────────────────────────────
    if (typeof GlobalSearch !== 'undefined' && typeof GlobalSearch.registerSource === 'function') {
        GlobalSearch.registerSource(SOURCE, {
            label: 'Spending',
            index(push) {
                const blob = StorageManager.get('spending') || {};
                for (const a of (Array.isArray(blob.accounts) ? blob.accounts : [])) {
                    push(a.id, a.name, `${a.type || ''} ${a.institution || ''} bank card`, { sub: a.type || 'Account', meta: { kind: 'account' } });
                }
                // Merchants, not rows: 24 months of rows would swamp the index.
                const seen = new Map();
                for (const t of (Array.isArray(blob.transactions) ? blob.transactions : [])) {
                    const name = SpendingApp.merchantOf(t);
                    const key = SpendingApp.merchantKey(name) || name.toLowerCase();
                    const cur = seen.get(key);
                    if (!cur || t.date > cur.date) seen.set(key, { name, date: t.date });
                }
                for (const [key, m] of seen) push(`merchant:${key}`, m.name, 'purchase spending merchant', { sub: 'Merchant', meta: { kind: 'merchant', name: m.name, month: SpendingApp.monthKey(m.date) } });
            },
            open(hit) {
                if (hit.meta?.kind === 'merchant') {
                    SpendingApp._filter = hit.meta.name || '';
                    SpendingApp._month = hit.meta.month || null;
                    SpendingApp._accountFilter = null;
                } else {
                    SpendingApp._accountFilter = hit.id;
                }
                AppManager.openApp('spending');
            }
        });
    }
})();
