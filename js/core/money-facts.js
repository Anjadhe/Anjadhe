/**
 * Money facts — the one sheet the money coach reads (docs/MONEY_COACH.md,
 * 2026-10-03). AI native: code keeps the FACTS, the assistant judges.
 *
 * It joins what nenva already holds about the person's money, wherever it
 * came from: Portfolio (accounts, holdings, debts, the plan and how far the
 * holdings sit from it, the value history), Spending (linked banks and
 * cards: months, income, what comes back every month, balances) and the
 * folders kept from mail and texts (open bills and subscriptions). Any part
 * may be absent; the sheet says which, so the assistant never fills a gap
 * with a guess. Email first: a person with only Gmail connected still has a
 * sheet (their bills), and it grows as accounts are added.
 *
 *   MF1 Arithmetic only. Nothing here is written or judged by a model, and
 *       there is no threshold deciding what matters: that is the
 *       assistant's call, made from these numbers.
 *   MF2 Other packages are reached through Anjadhe.use only (gather()).
 *   MF3 A part the person has not let leave this Mac is left out for an
 *       ambient run on a cloud model, and the sheet says it was left out.
 *
 * Pure core: amount(text), sheet(data, now), lines(sheet). Pinned by
 * tests/money-facts-test.js.
 */
const MoneyFacts = {
    _r0: n => Math.round(Number(n) || 0),
    _r1: n => Math.round((Number(n) || 0) * 10) / 10,
    _iso(d) { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; },
    _days(a, b) { return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000); },

    /** "$1,284.20" / "USD 84" / 84.2 → a number, or null when there is none. Pure. */
    amount(v) {
        if (typeof v === 'number') return Number.isFinite(v) ? v : null;
        const m = String(v == null ? '' : v).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
        return m ? Number(m[0]) : null;
    },

    /**
     * The sheet. `data` is plain: { portfolio, spending, matters, withheld }
     * as gather() returns them (any may be null). Pure.
     */
    sheet(data, now = new Date()) {
        const d = data || {};
        const today = this._iso(now);
        const out = { asOf: today, has: { investments: false, bank: false, mail: false } };
        const missing = [];

        // ── What they own and owe (Portfolio) ──
        const p = d.portfolio;
        if (p && p.summary) {
            out.has.investments = true;
            const s = p.summary;
            out.netWorth = {
                assets: this._r0(s.totalValue), invested: this._r0(s.invested), cash: this._r0(s.cash),
                realEstate: this._r0(s.realEstateValue), debts: this._r0(s.liabilitiesTotal), netWorth: this._r0(s.netWorth)
            };
            // Change since a past snapshot: the latest one on or before the day.
            const hist = (p.history || []).filter(h => h && h.date).sort((a, b) => a.date.localeCompare(b.date));
            const worth = h => (h.netWorth != null ? h.netWorth : (h.totalValue || 0) - (h.liabilities || 0));
            const since = (day) => { let hit = null; for (const h of hist) { if (h.date <= day) hit = h; else break; } return hit; };
            const back = (n) => this._iso(new Date(new Date(now).getTime() - n * 86400000));
            const change = {};
            for (const [key, day] of [['days30', back(30)], ['days90', back(90)], ['thisYear', `${today.slice(0, 4)}-01-01`]]) {
                const h = since(day);
                if (h) change[key] = { from: h.date, change: this._r0(s.netWorth - worth(h)) };
            }
            if (Object.keys(change).length) out.netWorth.change = change;
            out.accounts = (p.accounts || []).map(a => ({ name: a.name, type: a.type || null, value: this._r0(a.value), cash: this._r0(a.cash) }));
            if ((p.top || []).length) out.largestHoldings = p.top.map(t => ({ ticker: t.ticker, pctOfAssets: this._r1(t.pct) }));
            out.plan = p.plan || null;
            if ((p.unpriced || []).length) missing.push(`No current price for ${p.unpriced.join(', ')}, so the invested total, net worth and the plan's status understate or misread those holdings.`);
        } else if (!d.withheld || !d.withheld.includes('portfolio')) missing.push('No investment accounts, property or debts recorded.');

        // ── Debts: recorded loans, plus what the cards hold ──
        const debts = ((p && p.liabilities) || []).map(l => ({
            name: l.name, type: l.type || null, balance: this._r0(l.balance),
            ...(l.interestRate != null ? { ratePct: Number(l.interestRate) } : {}),
            ...(l.monthlyPayment != null ? { monthlyPayment: this._r0(l.monthlyPayment) } : {})
        }));

        // ── Money in and out (Spending: linked banks and cards) ──
        const sp = d.spending;
        if (sp && (sp.accounts || []).length) {
            out.has.bank = true;
            const bal = a => Number(a.balance) || 0;
            const bank = sp.accounts.filter(a => a.type !== 'credit');
            const cards = sp.accounts.filter(a => a.type === 'credit');
            out.cash = { inBank: this._r0(bank.reduce((t, a) => t + bal(a), 0)), accounts: bank.map(a => ({ name: a.name, type: a.type, balance: this._r0(bal(a)) })) };
            for (const c of cards) if (bal(c) > 0) debts.push({ name: c.name, type: 'credit card', balance: this._r0(bal(c)), ...(c.limit ? { limit: this._r0(c.limit) } : {}) });
            const months = (sp.months || []).slice().sort((a, b) => b.month.localeCompare(a.month));
            const cur = months.find(m => m.month === today.slice(0, 7)) || null;
            // Whole months only: before this one, and after the month the bank's history starts in
            // (four days of a first month once read as "50 months of spending in the bank").
            const full = months.filter(m => m.month < today.slice(0, 7) && (!sp.since || m.month > sp.since.slice(0, 7)));
            const row = m => {
                const kept = m.income - (m.spend - (m.refunds || 0));
                return { month: m.month, spent: this._r0(m.spend), income: this._r0(m.income),
                    ...(m.income > 0 ? { kept: this._r0(kept), savingsRatePct: this._r1((kept / m.income) * 100) } : {}) };
            };
            const lived = full.filter(m => m.spend > 0).slice(0, 3);
            const avg = lived.length ? lived.reduce((t, m) => t + m.spend, 0) / lived.length : 0;
            out.spending = {
                ...(cur ? { thisMonth: { month: cur.month, spentSoFar: this._r0(cur.spend), incomeSoFar: this._r0(cur.income),
                    ...(sp.samePointLastMonth != null ? { samePointLastMonth: this._r0(sp.samePointLastMonth) } : {}),
                    topCategories: (cur.byCategory || []).slice(0, 5).map(c => ({ category: c.label, total: this._r0(c.total) })) } } : {}),
                months: full.slice(0, 3).map(row),
                ...(avg ? { averageMonth: this._r0(avg) } : {})
            };
            if (avg && out.cash.inBank > 0) out.cash.monthsOfSpending = this._r1(out.cash.inBank / avg);
            const rec = sp.recurring || [];
            if (rec.length) {
                const perMonth = r => r.cadence === 'weekly' ? r.amount * 52 / 12 : r.cadence === 'yearly' ? r.amount / 12 : r.amount;
                out.recurring = {
                    perMonth: this._r0(rec.reduce((t, r) => t + perMonth(r), 0)),
                    charges: rec.slice(0, 20).map(r => ({ merchant: r.name, amount: r.amount, cadence: r.cadence, times: r.count, last: r.last, nextAbout: r.next,
                        ...(r.lastAmount != null && r.lastAmount !== r.amount ? { lastAmount: r.lastAmount } : {}) }))
                };
            }
        } else if (!d.withheld || !d.withheld.includes('spending')) missing.push('No bank or card is linked, so income and spending are not known.');

        if (debts.length) out.debts = debts.sort((a, b) => (b.ratePct || 0) - (a.ratePct || 0) || b.balance - a.balance);

        // ── What mail and texts say is owed or renewing (Matters) ──
        if (Array.isArray(d.matters)) {
            out.has.mail = true;
            const bills = d.matters.filter(m => m && m.state === 'open' && ['bill', 'subscription'].includes(m.kind)).map(m => {
                const due = m.due || null;
                const amt = this.amount(m.amount);
                return { id: m.id, kind: m.kind, title: m.title, ...(amt != null ? { amount: amt } : {}),
                    ...(due ? { due, inDays: this._days(today, due) } : {}), ...(m.step ? { step: m.step } : {}) };
            }).sort((a, b) => (a.due || '9').localeCompare(b.due || '9'));
            if (bills.length) {
                out.bills = bills.slice(0, 20);
                const soon = bills.filter(b => b.inDays != null && b.inDays <= 14 && b.amount != null);
                if (soon.length) out.billsDueIn14Days = this._r0(soon.reduce((t, b) => t + b.amount, 0));
            }
        } else if (!d.withheld || !d.withheld.includes('email')) missing.push('Email is not connected, so bills and renewals are not known.');

        // ── Money seen in mail: receipts and renewals the insight pass read ──
        // Email first (docs/MONEY_COACH.md): with no bank linked this is what
        // is known about spending, and it says it is partial.
        if (Array.isArray(d.mail) && d.mail.length) {
            const ev = d.mail.map(e => ({ ...e, amount: this.amount(e.amount) })).filter(e => e.amount != null && e.amount > 0 && e.date);
            const receipts = ev.filter(e => e.kind === 'receipt');
            const byMonth = new Map();
            for (const e of receipts) {
                const k = e.date.slice(0, 7);
                const m = byMonth.get(k) || { month: k, total: 0, receipts: 0, from: new Map() };
                m.total += e.amount; m.receipts++; m.from.set(e.from || 'Unknown', (m.from.get(e.from || 'Unknown') || 0) + e.amount);
                byMonth.set(k, m);
            }
            const months = [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month)).slice(0, 4).map(m => ({
                month: m.month, total: this._r0(m.total), receipts: m.receipts,
                top: [...m.from.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([from, total]) => ({ from, total: this._r0(total) })) }));
            const renewals = ev.filter(e => e.kind === 'renewal').sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12)
                .map(e => ({ from: e.from || 'Unknown', amount: e.amount, seen: e.date, ...(e.due ? { due: e.due, inDays: this._days(today, e.due) } : {}) }));
            const inBy = new Map();
            for (const e of ev.filter(x => x.kind === 'income')) {
                const k = e.date.slice(0, 7);
                const m = inBy.get(k) || { month: k, total: 0, payments: [] };
                m.total += e.amount; m.payments.push({ from: e.from || 'Unknown', amount: e.amount, date: e.date });
                inBy.set(k, m);
            }
            const income = [...inBy.values()].sort((a, b) => b.month.localeCompare(a.month)).slice(0, 4).map(m => ({ month: m.month, total: this._r0(m.total), payments: m.payments.slice(0, 6) }));
            if (months.length || renewals.length || income.length) out.fromMail = {
                note: 'Only what their mail shows: purchases with no emailed receipt, and income with no email, are not counted.',
                ...(months.length ? { receiptsByMonth: months } : {}), ...(income.length ? { paidToThemByMonth: income } : {}), ...(renewals.length ? { renewals } : {}) };
        }

        // ── Goals with an amount (MoneyPlan; each is a commitment) ──
        if (Array.isArray(d.goals) && d.goals.length && typeof d.progress === 'function') {
            const known = [...((p && p.accounts) || []).map(a => ({ name: a.name, value: a.value })),
                ...((sp && sp.accounts) || []).filter(a => a.type !== 'credit').map(a => ({ name: a.name, value: Number(a.balance) || 0 }))];
            out.goals = d.goals.map(g => d.progress(g, known, today));
        } else if (Array.isArray(d.goals)) out.noGoals = true;

        if (missing.length) out.notKnown = missing;
        if (d.withheld && d.withheld.length) out.leftOut = d.withheld.map(c => `${c} (not allowed to leave this Mac for background work)`);
        return out;
    },

    /** The sheet as plain lines for a prompt. Pure. */
    lines(sheet) {
        const s = sheet || {};
        const $ = n => `$${Math.round(n).toLocaleString('en-US')}`;
        const out = [];
        if (s.netWorth) {
            const n = s.netWorth;
            out.push(`Net worth ${$(n.netWorth)}: ${$(n.invested)} invested, ${$(n.cash)} cash in investment accounts, ${$(n.realEstate)} property, ${$(n.debts)} recorded debt.`);
            for (const [k, label] of [['days30', '30 days'], ['days90', '90 days'], ['thisYear', 'this year']]) {
                const c = n.change && n.change[k];
                if (c) out.push(`Net worth change over ${label} (since ${c.from}): ${c.change < 0 ? '-' : '+'}${$(Math.abs(c.change))}.`);
            }
        }
        if ((s.largestHoldings || []).length) out.push(`Largest holdings by share of assets: ${s.largestHoldings.map(h => `${h.ticker} ${h.pctOfAssets}%`).join(', ')}.`);
        if (s.plan) out.push(`Investment plan "${s.plan.name}": ${s.plan.status}${s.plan.headline ? `. ${s.plan.headline}` : ''}${(s.plan.offTarget || []).length ? ` Off target: ${s.plan.offTarget.map(t => `${t.sleeve} ${t.actualPct}% against ${t.targetPct}%`).join('; ')}.` : ''}${(s.plan.brokenRules || []).length ? ` Broken rules: ${s.plan.brokenRules.join('; ')}.` : ''}`);
        else if (s.has && s.has.investments) out.push('No investment plan is saved.');
        if (s.cash) out.push(`In the bank: ${$(s.cash.inBank)}${s.cash.monthsOfSpending != null ? `, about ${s.cash.monthsOfSpending} months of spending` : ''}.`);
        if (s.spending) {
            const t = s.spending.thisMonth;
            if (t) out.push(`${t.month} so far: ${$(t.spentSoFar)} spent${t.samePointLastMonth != null ? ` (${$(t.samePointLastMonth)} at this point last month)` : ''}, ${$(t.incomeSoFar)} in${t.topCategories.length ? `. Most on ${t.topCategories.map(c => `${c.category} ${$(c.total)}`).join(', ')}` : ''}.`);
            for (const m of s.spending.months || []) out.push(`${m.month}: ${$(m.spent)} spent, ${$(m.income)} in${m.savingsRatePct != null ? `, kept ${$(m.kept)} (${m.savingsRatePct}%)` : ''}.`);
        }
        if (s.recurring) out.push(`Charges that come back: about ${$(s.recurring.perMonth)} a month. ${s.recurring.charges.map(c => `${c.merchant} $${c.amount} ${c.cadence}`).join('; ')}.`);
        for (const d of s.debts || []) out.push(`Debt: ${d.name} (${d.type || 'loan'}) ${$(d.balance)}${d.ratePct != null ? ` at ${d.ratePct}%` : ''}${d.monthlyPayment != null ? `, ${$(d.monthlyPayment)} a month` : ''}.`);
        for (const b of s.bills || []) out.push(`${b.kind === 'subscription' ? 'Subscription' : 'Bill'} from mail: ${b.title}${b.amount != null ? ` $${b.amount}` : ''}${b.due ? `, due ${b.due} (${b.inDays < 0 ? `${-b.inDays} days ago` : `in ${b.inDays} days`})` : ''}.`);
        for (const g of s.goals || []) out.push(`Goal "${g.title}": ${g.saved != null ? `${$(g.saved)} of ${$(g.target)} (${g.pct}%)` : `${$(g.target)}, nothing recorded toward it yet`}${g.by ? `, by ${g.by}` : ''}${g.perMonthNeeded ? `, needs ${$(g.perMonthNeeded)} a month from here` : ''}.`);
        if (s.noGoals) out.push('No money goals are saved (no emergency fund target, nothing with an amount and a date).');
        for (const m of (s.fromMail && s.fromMail.paidToThemByMonth) || []) out.push(`Paid to them, seen in mail, ${m.month}: ${$(m.total)} (${m.payments.map(x => `${x.from} $${x.amount}`).join(', ')}). Partial: only what was emailed.`);
        for (const m of (s.fromMail && s.fromMail.receiptsByMonth) || []) out.push(`Receipts in mail, ${m.month}: ${$(m.total)} across ${m.receipts} (${m.top.map(t => `${t.from} ${$(t.total)}`).join(', ')}). Partial: only emailed receipts.`);
        for (const r of (s.fromMail && s.fromMail.renewals) || []) out.push(`Renewal in mail: ${r.from} $${r.amount}${r.due ? `, due ${r.due}` : `, seen ${r.seen}`}.`);
        for (const m of s.notKnown || []) out.push(`Not known: ${m}`);
        for (const m of s.leftOut || []) out.push(`Left out: ${m}`);
        return out;
    },

    /**
     * Read the parts from the packages that hold them. `ctx` is the tool
     * context: for an ambient run, a part whose privacy class may not leave
     * for that run's model is withheld (MF3).
     */
    gather(ctx = null) {
        const use = (name) => { try { return typeof Anjadhe !== 'undefined' ? Anjadhe.use(name) : null; } catch { return null; } };
        const withheld = [];
        const may = (cls) => {
            if (!ctx || !ctx.ambient || typeof CloudPrivacy === 'undefined') return true;
            const ok = CloudPrivacy.allowsFor(cls, ctx.source);
            if (!ok) withheld.push(cls);
            return ok;
        };
        const out = { portfolio: null, spending: null, matters: null, mail: null, goals: null, progress: null, withheld };
        try { const P = use('portfolio'); if (P && P.facts && may('portfolio')) out.portfolio = P.facts(); } catch (e) { console.warn('[money] portfolio facts failed:', e); }
        try { const S = use('spending'); if (S && S.facts && may('spending')) out.spending = S.facts(); } catch (e) { console.warn('[money] spending facts failed:', e); }
        try {
            if (typeof Matters !== 'undefined' && may('email')) {
                const all = Matters.forAmbient ? Matters.forAmbient() : Matters.all();
                const connected = all.length > 0 || (typeof EmailApp !== 'undefined' && (EmailApp.emails || []).length > 0);
                if (connected) out.matters = all.map(m => {
                    const step = Matters.openStep(m);
                    return { id: m.id, kind: m.kind, state: m.state, title: Matters.titleOf(m), amount: m.amount || null,
                        due: (step && step.by) || (m.when && m.when.date) || null, step: step ? step.what : null };
                });
            }
        } catch (e) { console.warn('[money] matters facts failed:', e); }
        try {
            // Receipts and renewals the insight pass already read (type and
            // amount are its own; nothing is re-judged here), last 120 days.
            if (typeof EmailApp !== 'undefined' && EmailApp.priorityAnalyses && !withheld.includes('email')) {
                const since = Date.now() - 120 * 86400000;
                out.mail = Object.entries(EmailApp.priorityAnalyses).map(([id, a]) => {
                    const income = !!(a && a.holds && a.holds.income === true);
                    if (!a || (!income && !['receipt', 'renewal'].includes(a.type)) || !a.amount || a.amount === 'null') return null;
                    const e = EmailApp.emailById ? EmailApp.emailById(id) : null;
                    const at = e && Date.parse(e.date);
                    if (!at || at < since) return null;
                    return { id, kind: income ? 'income' : a.type, amount: a.amount, date: this._iso(at), from: EmailApp._extractSenderName(e.from) || '',
                        due: /^\d{4}-\d{2}-\d{2}/.test(String(a.eventDate || '')) ? String(a.eventDate).slice(0, 10) : null };
                }).filter(Boolean);
            }
        } catch (e) { console.warn('[money] mail facts failed:', e); }
        try {
            if (typeof MoneyPlan !== 'undefined') {
                const C = typeof Commitments !== 'undefined' && Commitments._inited ? Commitments : null;
                // The commitment holds the title, the date and whether it is still open.
                out.goals = MoneyPlan.goals().map(g => {
                    const c = C ? C.get(g.id) : null;
                    if (C && (!c || c.state !== 'open')) return null;
                    return c ? { ...g, title: c.title, by: c.by || g.by || null } : g;
                }).filter(Boolean);
                out.progress = (g, accounts, today) => MoneyPlan.progress(g, accounts, today);
            }
        } catch (e) { console.warn('[money] goals failed:', e); }
        return out;
    },

    current(ctx = null, now = new Date()) { return this.sheet(this.gather(ctx), now); }
};

if (typeof module !== 'undefined') module.exports = MoneyFacts;
