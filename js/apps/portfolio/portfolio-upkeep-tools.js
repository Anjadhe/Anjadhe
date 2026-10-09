/**
 * Finance upkeep tools — the Edit and Delete buttons of the Finance pages,
 * for the assistant (2026-10-08, docs/AI_NATIVE.md parity inventory,
 * batch 5). "I entered that buy wrong", "I paid off the car loan", "we sold
 * the condo", "watch NVDA" had no path from a chat: the tools could add a
 * transaction or a debt but never fix or remove one.
 *
 * Every write follows the page's own rules, in PortfolioApp's in-memory
 * model then ONE saveData (the record-merged write):
 *   - a transaction's cash effect is reversed and re-applied exactly as
 *     saveTransaction / deleteTransaction do (adjustCash: 'holding' never
 *     touches cash, an account not tracking cash is left alone);
 *   - every delete tombstones BEFORE saveData (PortfolioApp._tombstone), or
 *     a sync merge resurrects the record (docs/PORTFOLIO.md);
 *   - deleting an account takes its transactions and note links with it
 *     and tells the brokerage link (deleteCurrentAccount); an account shared
 *     by a contact is theirs and is refused here;
 *   - deleting a property keeps its mortgage and drops the link
 *     (deleteProperty); removing a spending rule is SpendingApp.removeRule.
 * Only figures the person gave. Every change asks, shows what changes, and
 * is blocked in untrusted turns; the watchlist (a list of symbols to look
 * at) and the reads do not ask.
 */
(function registerPortfolioUpkeepTools() {
    if (typeof AgentTools === 'undefined' || typeof PortfolioApp === 'undefined') return;

    const esc = (v) => (typeof UIUtils !== 'undefined' ? UIUtils.escapeHtml(String(v == null ? '' : v)) : String(v == null ? '' : v));
    const reg = (def, handler, opts) => AgentTools.register({ type: 'function', function: def }, handler, Object.assign({ source: 'portfolio', group: 'portfolio', blockUntrusted: true }, opts || {}));
    const refresh = () => { if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'portfolio') { PortfolioApp.loadData(); PortfolioApp.render(); } };
    const now = () => new Date().toISOString();
    const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));
    const ACCOUNT_TYPES = ['brokerage', '401k', 'ira', 'roth-ira', 'hsa', 'savings', 'checking', 'other'];

    const findAccount = (ref) => {
        const r = String(ref || '').trim().toLowerCase();
        return r ? PortfolioApp.accounts.find(a => a.id === ref || String(a.name || '').toLowerCase() === r) || null : null;
    };
    const byNameOrId = (list, ref) => {
        const r = String(ref || '').trim().toLowerCase();
        return r ? (list || []).find(x => x.id === ref || String(x.name || '').toLowerCase() === r) || null : null;
    };
    const txnBrief = (t) => {
        const a = PortfolioApp.accounts.find(x => x.id === t.accountId);
        return { id: t.id, date: t.date, type: t.type, ticker: PortfolioApp.displayTicker ? PortfolioApp.displayTicker(t.ticker) : t.ticker, symbol: t.ticker,
            quantity: t.quantity, pricePerShare: t.pricePerShare, account: a ? a.name : undefined, notes: t.notes || undefined };
    };
    const txnLine = (t) => { const b = txnBrief(t); return `${b.type} ${b.quantity} × ${b.ticker} at ${b.pricePerShare} on ${b.date}${b.account ? ` in ${b.account}` : ''}`; };

    // ── Transactions ──

    reg({
        name: 'list_transactions',
        description: 'The buys, sells and holdings recorded in Finance, newest first, with their ids: to find one the person wants to fix or remove. Filter by account and/or ticker.',
        parameters: { type: 'object', properties: {
            account: { type: 'string', description: 'Account name or id' },
            ticker: { type: 'string' },
            limit: { type: 'number', description: 'Default 30' }
        } }
    }, (a = {}) => {
        PortfolioApp.loadData();
        let list = PortfolioApp.transactions.slice();
        if (a.account) { const acc = findAccount(a.account); if (!acc) return { error: `No account "${a.account}".`, accounts: PortfolioApp.accounts.map(x => x.name) }; list = list.filter(t => t.accountId === acc.id); }
        if (a.ticker) { const tk = String(a.ticker).toUpperCase(); list = list.filter(t => t.ticker === tk || String(t.ticker).startsWith(tk)); }
        list.sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')));
        const n = Math.max(1, Math.min(200, Number(a.limit) || 30));
        return { count: list.length, transactions: list.slice(0, n).map(txnBrief) };
    }, { readOnly: true, dataClass: 'portfolio' });

    reg({
        name: 'change_transaction',
        description: 'Fix a recorded transaction (id from list_transactions): its type, ticker, quantity, price, date, notes or account. Cash moves the way it does when the person edits it on the page (the old effect reversed, the new one applied). Only figures the person gave.',
        parameters: { type: 'object', properties: {
            id: { type: 'string' },
            type: { type: 'string', enum: ['buy', 'sell', 'holding'] },
            ticker: { type: 'string' }, quantity: { type: 'number' }, pricePerShare: { type: 'number' },
            date: { type: 'string', description: 'YYYY-MM-DD' }, notes: { type: 'string' },
            account: { type: 'string', description: 'Move it to this account (name or id)' }
        }, required: ['id'] }
    }, (a = {}) => {
        PortfolioApp.loadData();
        const t = PortfolioApp.transactions.find(x => x.id === a.id);
        if (!t) return { error: 'No transaction with that id. Call list_transactions.' };
        const next = { type: a.type || t.type, ticker: a.ticker ? String(a.ticker).toUpperCase() : t.ticker,
            quantity: num(a.quantity) ?? t.quantity, pricePerShare: num(a.pricePerShare) ?? t.pricePerShare,
            date: a.date || t.date, notes: a.notes != null ? String(a.notes) : t.notes, accountId: t.accountId };
        if (a.account) { const acc = findAccount(a.account); if (!acc) return { error: `No account "${a.account}".` }; next.accountId = acc.id; }
        if (!(next.quantity > 0) || !(next.pricePerShare > 0)) return { error: 'Quantity and price must be above zero.' };
        if (!/^\d{4}-\d{2}-\d{2}$/.test(next.date || '')) return { error: 'date must be YYYY-MM-DD.' };
        if (next.type === 'sell') {
            const held = (PortfolioApp.computeHoldings(next.accountId).find(h => h.ticker === next.ticker) || {}).totalShares || 0;
            const own = t.type === 'sell' && t.ticker === next.ticker && t.accountId === next.accountId ? t.quantity : 0;
            if (next.quantity > held + own) return { error: `Only ${held + own} of ${next.ticker} to sell in that account.` };
        }
        const before = txnLine(t);
        if (t.type !== 'holding') PortfolioApp.adjustCash(t.accountId, t.type === 'buy' ? 'sell' : 'buy', PortfolioApp.txnAmount(t));
        Object.assign(t, next, { updatedAt: now() });
        if (t.type !== 'holding') PortfolioApp.adjustCash(t.accountId, t.type, PortfolioApp.txnAmount(t));
        PortfolioApp.saveData();
        refresh();
        return { success: true, was: before, now: txnLine(PortfolioApp.transactions.find(x => x.id === t.id) || t) };
    }, { ask: true, describe: (a) => {
        const t = PortfolioApp.transactions.find(x => x.id === a.id);
        const bits = ['type', 'ticker', 'quantity', 'pricePerShare', 'date', 'notes', 'account'].filter(k => a[k] != null && a[k] !== '').map(k => `${k === 'pricePerShare' ? 'price' : k} → ${esc(a[k])}`);
        return `Change <strong>${esc(t ? txnLine(t) : a.id)}</strong>${bits.length ? `: ${bits.join(', ')}` : ''}`;
    } });

    reg({
        name: 'delete_transaction',
        description: 'Remove a recorded transaction (id from list_transactions). Its cash effect is reversed, as on the page.',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    }, (a = {}) => {
        PortfolioApp.loadData();
        const t = PortfolioApp.transactions.find(x => x.id === a.id);
        if (!t) return { error: 'No transaction with that id. Call list_transactions.' };
        const line = txnLine(t);
        if (t.type !== 'holding') PortfolioApp.adjustCash(t.accountId, t.type === 'buy' ? 'sell' : 'buy', PortfolioApp.txnAmount(t));
        PortfolioApp._tombstone(t.id);
        PortfolioApp.transactions = PortfolioApp.transactions.filter(x => x.id !== t.id);
        PortfolioApp.saveData();
        refresh();
        return { success: true, deleted: line };
    }, { ask: true, describe: (a) => { const t = PortfolioApp.transactions.find(x => x.id === a.id); return `Delete <strong>${esc(t ? txnLine(t) : a.id)}</strong>`; } });

    // ── Accounts ──

    reg({
        name: 'change_account',
        description: 'Rename an account or set its type (' + ACCOUNT_TYPES.join(', ') + '), as Edit account does.',
        parameters: { type: 'object', properties: {
            account: { type: 'string', description: 'Its name or id' },
            name: { type: 'string' }, type: { type: 'string', enum: ACCOUNT_TYPES }
        }, required: ['account'] }
    }, (a = {}) => {
        PortfolioApp.loadData();
        const acc = findAccount(a.account);
        if (!acc) return { error: `No account "${a.account}".`, accounts: PortfolioApp.accounts.map(x => x.name) };
        const name = a.name ? String(a.name).replace(/\s+/g, ' ').trim() : '';
        if (!name && !a.type) return { error: 'Give a new name or a type.' };
        if (a.type && !ACCOUNT_TYPES.includes(a.type)) return { error: `type must be one of ${ACCOUNT_TYPES.join(', ')}.` };
        const was = { name: acc.name, type: acc.type };
        if (name) acc.name = name;
        if (a.type) acc.type = a.type;
        acc.updatedAt = now();
        PortfolioApp.saveData();
        refresh();
        return { success: true, was, now: { name: acc.name, type: acc.type } };
    }, { ask: true, describe: (a) => `Change the account <strong>${esc(a.account)}</strong>${a.name ? `: name → ${esc(a.name)}` : ''}${a.type ? `${a.name ? ',' : ':'} type → ${esc(a.type)}` : ''}` });

    reg({
        name: 'delete_account',
        description: 'Delete an account and every transaction in it, as Delete account does. An account a contact shared is theirs: the person removes it on the page.',
        parameters: { type: 'object', properties: { account: { type: 'string', description: 'Its name or id' } }, required: ['account'] }
    }, (a = {}) => {
        PortfolioApp.loadData();
        const acc = findAccount(a.account);
        if (!acc) return { error: `No account "${a.account}".`, accounts: PortfolioApp.accounts.map(x => x.name) };
        if (acc.shared) return { error: 'A contact shared this account; the person removes it on the Finance page.' };
        const txns = PortfolioApp.transactions.filter(t => t.accountId === acc.id);
        if (typeof PortfolioBrokerage !== 'undefined' && PortfolioBrokerage.onAccountDeleted) { try { PortfolioBrokerage.onAccountDeleted(acc); } catch { /* the delete goes on */ } }
        PortfolioApp._tombstone(acc.id);
        txns.forEach(t => PortfolioApp._tombstone(t.id));
        PortfolioApp.accounts = PortfolioApp.accounts.filter(x => x.id !== acc.id);
        PortfolioApp.transactions = PortfolioApp.transactions.filter(t => t.accountId !== acc.id);
        if (typeof LinkManager !== 'undefined' && LinkManager.removeAllLinksForItem) { try { LinkManager.removeAllLinksForItem('portfolio', acc.id); } catch { /* links only */ } }
        PortfolioApp.saveData();
        refresh();
        return { success: true, deleted: acc.name, transactionsRemoved: txns.length };
    }, { ask: true, describe: (a) => {
        const acc = findAccount(a.account);
        const n = acc ? PortfolioApp.transactions.filter(t => t.accountId === acc.id).length : 0;
        return `Delete the account <strong>${esc(acc ? acc.name : a.account)}</strong> and its ${n} transaction${n === 1 ? '' : 's'}${acc && acc.brokerage ? `, and its ${esc(acc.brokerage.institution || 'brokerage')} link` : ''}`;
    } });

    // ── Debts and property ──

    reg({
        name: 'remove_liability',
        description: 'Remove a debt (paid off, refinanced away, entered by mistake), by its name or id. To change its balance or rate use save_liability.',
        parameters: { type: 'object', properties: { name: { type: 'string', description: 'Its name or id' } }, required: ['name'] }
    }, (a = {}) => {
        PortfolioApp.loadData();
        const l = byNameOrId(PortfolioApp.liabilities, a.name);
        if (!l) return { error: `No debt "${a.name}".`, debts: PortfolioApp.liabilities.map(x => x.name) };
        PortfolioApp._tombstone(l.id);
        PortfolioApp.liabilities = PortfolioApp.liabilities.filter(x => x.id !== l.id);
        PortfolioApp.saveData();
        refresh();
        return { success: true, removed: l.name };
    }, { ask: true, describe: (a) => `Remove the debt <strong>${esc((byNameOrId(PortfolioApp.liabilities, a.name) || {}).name || a.name)}</strong>` });

    reg({
        name: 'save_property',
        description: 'Record a home or other property, or update one by name: its current value (needed for a new one), address, purchase price and date, notes. Only figures the person gave. Its mortgage is a debt (save_liability).',
        parameters: { type: 'object', properties: {
            name: { type: 'string', description: 'e.g. "Our home"' },
            currentValue: { type: 'number' }, address: { type: 'string' },
            purchasePrice: { type: 'number' }, purchaseDate: { type: 'string', description: 'YYYY-MM-DD' }, notes: { type: 'string' }
        }, required: ['name'] }
    }, (a = {}) => {
        PortfolioApp.loadData();
        const name = String(a.name || '').replace(/\s+/g, ' ').trim();
        if (!name) return { error: 'A property needs a name.' };
        const value = num(a.currentValue);
        if (value != null && value < 0) return { error: 'The value cannot be negative.' };
        let p = byNameOrId(PortfolioApp.properties, name);
        const created = !p;
        if (created) {
            if (value == null) return { error: 'A new property needs its current value.' };
            p = { id: crypto.randomUUID(), name, address: '', currentValue: value, purchasePrice: 0, purchaseDate: '', notes: '', createdAt: now() };
            PortfolioApp.properties.push(p);
        }
        if (value != null) p.currentValue = value;
        if (a.address != null) p.address = String(a.address).trim();
        if (num(a.purchasePrice) != null) p.purchasePrice = num(a.purchasePrice);
        if (a.purchaseDate) p.purchaseDate = String(a.purchaseDate);
        if (a.notes != null) p.notes = String(a.notes).trim();
        p.updatedAt = now();
        PortfolioApp.saveData();
        refresh();
        return { success: true, created, property: { id: p.id, name: p.name, currentValue: p.currentValue, purchasePrice: p.purchasePrice || undefined } };
    }, { ask: true, describe: (a) => `${byNameOrId(PortfolioApp.properties, a.name) ? 'Update' : 'Record'} the property <strong>${esc(a.name)}</strong>${a.currentValue != null ? `: value ${esc(a.currentValue)}` : ''}` });

    reg({
        name: 'remove_property',
        description: 'Remove a property (sold, entered by mistake), by its name or id. A mortgage on it stays as a debt, unlinked, as on the page.',
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
    }, (a = {}) => {
        PortfolioApp.loadData();
        const p = byNameOrId(PortfolioApp.properties, a.name);
        if (!p) return { error: `No property "${a.name}".`, properties: PortfolioApp.properties.map(x => x.name) };
        PortfolioApp._tombstone(p.id);
        PortfolioApp.properties = PortfolioApp.properties.filter(x => x.id !== p.id);
        const kept = [];
        PortfolioApp.liabilities.forEach(l => { if (l.propertyId === p.id) { l.propertyId = null; l.updatedAt = now(); kept.push(l.name); } });
        PortfolioApp.saveData();
        refresh();
        return { success: true, removed: p.name, debtsKept: kept.length ? kept : undefined };
    }, { ask: true, describe: (a) => `Remove the property <strong>${esc((byNameOrId(PortfolioApp.properties, a.name) || {}).name || a.name)}</strong>` });

    // ── Watchlist ──

    reg({
        name: 'watchlist',
        description: 'The symbols the person watches without owning them: list them, or add or remove one ("watch NVDA", "stop watching Tesla").',
        parameters: { type: 'object', properties: {
            action: { type: 'string', enum: ['list', 'add', 'remove'] },
            ticker: { type: 'string' }
        }, required: ['action'] }
    }, (a = {}) => {
        PortfolioApp.loadData();
        const list = () => PortfolioApp.getWatchlist().map(w => w.ticker);
        if (a.action === 'list') return { watching: list() };
        const t = String(a.ticker || '').trim().toUpperCase();
        if (!/^[A-Z][A-Z0-9.\-^=]{0,14}$/.test(t)) return { error: 'Give a ticker symbol, e.g. NVDA.' };
        if (a.action === 'add') { const added = PortfolioApp.addToWatchlist(t); refresh(); return { success: true, added: added ? t : undefined, note: added ? undefined : 'Already watched.', watching: list() }; }
        if (a.action === 'remove') {
            if (!PortfolioApp.isWatched(t)) return { error: `${t} is not on the watchlist.`, watching: list() };
            PortfolioApp.removeFromWatchlist(t); refresh();
            return { success: true, removed: t, watching: list() };
        }
        return { error: 'action must be list, add or remove.' };
    }, { dataClass: 'portfolio' });

    // ── Spending: a merchant's category rule ──

    if (typeof SpendingApp !== 'undefined') {
        reg({
            name: 'remove_spending_rule',
            description: 'Stop putting every purchase from a merchant in one category (a rule made with set_spending_category allFromMerchant), as the category dialog\'s "Forget this rule" does. With no merchant, lists the rules.',
            parameters: { type: 'object', properties: { merchant: { type: 'string', description: 'The merchant, or the rule id' } } }
        }, (a = {}) => {
            SpendingApp.loadData();
            const rules = (SpendingApp.data && SpendingApp.data.rules) || [];
            const shown = rules.map(r => ({ id: r.id, merchant: r.merchant, category: (SpendingApp.CATEGORIES || {})[r.category] || r.category }));
            if (!a.merchant) return { rules: shown };
            const m = String(a.merchant).trim().toLowerCase();
            const r = rules.find(x => x.id === a.merchant || String(x.merchant || '').toLowerCase() === m) || rules.find(x => String(x.merchant || '').toLowerCase().includes(m));
            if (!r) return { error: `No rule for "${a.merchant}".`, rules: shown };
            if (!SpendingApp.removeRule(r.id)) return { error: 'Could not remove it.' };
            if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'portfolio' && SpendingApp.render) { try { SpendingApp.render(); } catch { /* the rule is gone */ } }
            return { success: true, removed: r.merchant || r.id };
        }, { group: 'spending', source: 'spending', describe: (a) => `Forget the category rule for <strong>${esc(a.merchant || '')}</strong>` });
    }
})();
