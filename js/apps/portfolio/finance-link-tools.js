/**
 * Linking banks and brokerages, and keeping accounts by hand, through the
 * assistant (2026-10-12, docs/THREAD_PANELS.md step 3). The Finance pages
 * held these buttons; with the pages gone every one of them is a tool
 * (minimum UI, agent parity), under the same approvals.
 *
 *   list_linked_institutions  what is linked, its accounts, sign-in state
 *   link_institution          opens Plaid's own sign-in in the browser and
 *                             returns at once; when the person finishes there
 *                             the accounts are added (no picker) and a
 *                             code-written note lands in the conversation
 *                             that asked, naming what was added
 *   relink_institution        sign in again where the bank asked (update mode)
 *   unlink_institution        removes the link at Plaid and the accounts it
 *                             brought in (the Settings card's Unlink)
 *   create_account            an account kept by hand ("my Vanguard IRA")
 *   reconcile_brokerage       close the positions a sync found differing
 *
 * The Mac holds no Plaid credential (docs/PORTFOLIO.md); every write asks.
 * Linking tools exist only where linking does (the `brokerage` flag).
 */
(function registerFinanceLinkTools() {
    if (typeof AgentTools === 'undefined' || typeof PortfolioApp === 'undefined') return;
    const esc = (v) => (typeof UIUtils !== 'undefined' ? UIUtils.escapeHtml(String(v == null ? '' : v)) : String(v == null ? '' : v));
    const reg = (def, handler, opts) => AgentTools.register({ type: 'function', function: def }, handler, Object.assign({ source: 'portfolio', group: 'portfolio', blockUntrusted: true }, opts || {}));
    const ACCOUNT_TYPES = ['brokerage', '401k', 'ira', 'roth-ira', 'hsa', 'savings', 'checking', 'other'];

    /** A code-written note in the conversation that asked (never a model's words), and a repaint. */
    const noteInChat = (convId, text) => {
        if (typeof AgentService === 'undefined') return;
        const conv = convId ? (AgentService.conversations || []).find(c => c.id === convId) : null;
        if (conv && !conv.private) {
            conv.messages.push({ role: 'assistant', content: text, timestamp: new Date().toISOString(), metadata: { financeLink: true } });
            conv.updatedAt = new Date().toISOString();
            AgentService._saveConversations();
        }
        if (typeof UIUtils !== 'undefined') UIUtils.showToast(esc(text), 'success', 8000);
        if (typeof ThreadsPage !== 'undefined') ThreadsPage._repaint();
    };
    const names = list => list.map(a => a.name).join(', ');

    // ── Hand-kept accounts (always) ─────────────────────────────────────

    reg({
        name: 'create_account',
        description: 'Start an investment account kept by hand (no link), when the person tells you about one: "I have a Vanguard IRA", "my 401k at work". Add its positions after with add_transaction (type holding) and its cash with update_cash. For a bank or brokerage they want synced, use link_institution instead.',
        parameters: { type: 'object', properties: {
            name: { type: 'string', description: 'What they call it, e.g. "Vanguard IRA"' },
            type: { type: 'string', enum: ACCOUNT_TYPES },
            cash: { type: 'number', description: 'Cash in it now, only when they said a figure' }
        }, required: ['name', 'type'] }
    }, (a = {}) => {
        const name = String(a.name || '').trim().slice(0, 80);
        if (!name) return { error: 'A name is needed.' };
        PortfolioApp.loadData();
        const had = PortfolioApp.getAccounts().find(x => String(x.name || '').toLowerCase() === name.toLowerCase());
        if (had) return { error: `There is already an account named "${had.name}".`, id: had.id };
        const acct = PortfolioApp.createAccount(name, ACCOUNT_TYPES.includes(a.type) ? a.type : 'other', Number.isFinite(Number(a.cash)) ? Number(a.cash) : null);
        return { created: true, id: acct.id, name: acct.name, type: acct.type, thread: `anjadhe://account/${acct.id}`,
            note: 'Its thread holds its drawer; attach it to a thing nenva looks after with attach_to_sender (kind account, id "portfolio:<id>") when it belongs to one.' };
    }, { ask: true, describe: (a) => `Start the account <strong>${esc(a.name)}</strong>${a.type ? ` (${esc(a.type)})` : ''}${Number.isFinite(Number(a.cash)) ? ` with ${esc(Number(a.cash).toLocaleString('en-US', { style: 'currency', currency: 'USD' }))} cash` : ''}` });

    // ── Linking (only where it exists) ──────────────────────────────────

    if (typeof InstitutionLink === 'undefined' || !InstitutionLink.available()) return;
    const bk = () => (typeof PortfolioBrokerage !== 'undefined' && PortfolioBrokerage.available() ? PortfolioBrokerage : null);
    const sp = () => (typeof Anjadhe !== 'undefined' ? Anjadhe.use('spending') : null);

    /** Every institution this Mac knows: Connect's list, plus links the apps still hold. */
    const institutions = async () => {
        let items = [], error = null;
        try { const r = await window.electronBrokerage.items(); if (r.error) error = InstitutionLink.failMessage(r, r.error); else items = r.items || []; } catch (e) { error = e.message; }
        PortfolioApp.loadData();
        const by = new Map(items.map(it => [it.itemId, { itemId: it.itemId, institution: it.institution || null, status: it.status || 'ok', investments: [], banks: [] }]));
        for (const a of (bk() ? bk().linkedAccounts() : [])) {
            const id = a.brokerage.itemId;
            if (!by.has(id)) by.set(id, { itemId: id, institution: a.brokerage.institution, status: 'missing', investments: [], banks: [] });
            by.get(id).investments.push({ id: `portfolio:${a.id}`, name: a.name, needsSignIn: !!a.brokerage.needsLogin, lastSyncAt: a.brokerage.lastSyncAt || null, positionsDiffering: (a.brokerage.drift || []).length });
        }
        const s = sp();
        for (const l of (s ? s.links() : [])) {
            if (!by.has(l.id)) by.set(l.id, { itemId: l.id, institution: l.institution, status: l.here ? 'missing' : 'elsewhere', investments: [], banks: [] });
            const it = by.get(l.id);
            it.lastBankSyncAt = l.lastSyncAt || null;
            if (l.needsLogin) it.status = 'login_required';
            it.banks = s.accountsFor(l.id).map(a => ({ id: `spending:${a.id}`, name: a.name, type: a.type }));
        }
        return { list: [...by.values()], error };
    };
    const findItem = async (want) => {
        const { list } = await institutions();
        const w = String(want || '').trim().toLowerCase();
        return list.find(x => x.itemId === want) || list.find(x => String(x.institution || '').toLowerCase() === w) || list.find(x => w && String(x.institution || '').toLowerCase().includes(w)) || null;
    };

    reg({
        name: 'list_linked_institutions',
        description: 'The banks, cards and brokerages linked through nenva cloud: each institution with its itemId, its accounts (ids as "portfolio:<id>" for investments and "spending:<id>" for banks and cards, the ids attach_to_sender takes), whether it needs the person to sign in again, and when it last synced.',
        parameters: { type: 'object', properties: {} }
    }, async () => {
        const { list, error } = await institutions();
        return { institutions: list, ...(error ? { connectError: error } : {}), ...(!list.length ? { hint: 'Nothing is linked. link_institution connects a bank (kind bank) or a brokerage (kind brokerage).' } : {}) };
    }, { readOnly: true, dataClass: 'portfolio' });

    reg({
        name: 'link_institution',
        description: 'Link a bank or card (kind bank: balances and transactions for spending) or a brokerage (kind brokerage: holdings, cash and trades) through nenva cloud. Opens Plaid\'s own sign-in page in the person\'s browser and returns at once; nothing is linked yet when this returns. When they finish signing in there, every account the institution reports is added and a note naming them appears in this conversation. Tell them to sign in in the browser window that opened.',
        parameters: { type: 'object', properties: {
            kind: { type: 'string', enum: ['bank', 'brokerage'] }
        }, required: ['kind'] }
    }, (a = {}, ctx = {}) => {
        if (ctx && ctx.ambient) return { error: 'Linking needs the person present to sign in.' };
        if (InstitutionLink.busy()) return { error: 'A sign-in is already open in the browser; finish or close that one first.' };
        const kind = a.kind === 'brokerage' ? 'brokerage' : 'bank';
        if (kind === 'brokerage' && !bk()) return { error: 'Brokerage linking is not available in this build.' };
        const convId = ctx.convId || null;
        (async () => {
            const done = await InstitutionLink.start({ products: InstitutionLink.PRODUCTS[kind], what: kind === 'bank' ? 'your bank' : 'your brokerage' });
            if (!done) return;   // cancelled, expired or refused: InstitutionLink already said so
            const r = kind === 'bank' ? await sp().addAccounts(done.item) : await bk().addAccounts(done.item);
            const inst = done.item.institution || (kind === 'bank' ? 'your bank' : 'your brokerage');
            if (r.error && !r.accounts.length) { noteInChat(convId, `Linked ${inst}, but no accounts were added: ${r.error}`); return; }
            noteInChat(convId, r.accounts.length
                ? `Linked ${inst}. Added ${names(r.accounts)}. They are in Your money; say if you would rather not track any of them, or which thing they belong to.`
                : `Linked ${inst}. Every account there was already in Your money.`);
            PortfolioApp.changed();
        })().catch(e => console.warn('[finance] link failed:', e));
        return { started: true, kind, note: 'Plaid\'s sign-in opened in the browser. Nothing is linked until they finish there; a note will follow in this conversation.' };
    }, { ask: true, describe: (a) => `Open Plaid's sign-in in your browser to link ${a.kind === 'brokerage' ? 'a brokerage' : 'a bank or card'} through nenva cloud` });

    reg({
        name: 'relink_institution',
        description: 'Sign in again to a linked institution that asked for it (list_linked_institutions shows needsSignIn / status login_required). Opens Plaid\'s sign-in in the browser and returns at once; a note follows in this conversation when it is done.',
        parameters: { type: 'object', properties: { institution: { type: 'string', description: 'Its itemId or name' } }, required: ['institution'] }
    }, async (a = {}, ctx = {}) => {
        if (ctx && ctx.ambient) return { error: 'Signing in needs the person present.' };
        const it = await findItem(a.institution);
        if (!it) return { error: `Nothing linked matches "${a.institution}". Call list_linked_institutions.` };
        const convId = ctx.convId || null;
        (async () => {
            let ok = false;
            if (it.investments.length && bk()) ok = await bk().relink(it.itemId);
            else if (sp()) ok = await sp().relink(it.itemId);
            if (ok) noteInChat(convId, `Signed in again to ${it.institution || 'the institution'}.`);
        })().catch(e => console.warn('[finance] relink failed:', e));
        return { started: true, institution: it.institution, note: 'Plaid\'s sign-in opened in the browser; a note follows when it is done.' };
    }, { ask: true, describe: () => 'Open Plaid\'s sign-in in your browser to sign in again' });

    reg({
        name: 'unlink_institution',
        description: 'Disconnect a linked institution: the link is removed at Plaid and the accounts it brought in (with their positions, trades and transactions) leave nenva. Accounts kept by hand are never touched.',
        parameters: { type: 'object', properties: { institution: { type: 'string', description: 'Its itemId or name' } }, required: ['institution'] }
    }, async (a = {}) => {
        const it = await findItem(a.institution);
        if (!it) return { error: `Nothing linked matches "${a.institution}". Call list_linked_institutions.` };
        let ok = false;
        // One Connect call, then each half clears its own records (the Settings card's order).
        if (it.investments.length && bk()) { ok = await bk().unlink(it.itemId); if (sp()) sp().forgetItem(it.itemId); }
        else if (sp()) ok = await sp().unlink(it.itemId);
        else if (bk()) ok = await bk().unlink(it.itemId);
        PortfolioApp.changed();
        return ok ? { unlinked: true, institution: it.institution, removed: [...it.investments, ...it.banks].map(x => x.name) } : { error: 'Could not unlink; nenva cloud may be unreachable. Try again.' };
    }, { ask: true, describe: (a) => `Disconnect <strong>${esc(a.institution)}</strong> from nenva cloud and remove the accounts it brought in` });

    if (bk()) reg({
        name: 'reconcile_brokerage',
        description: 'Make a linked account match its brokerage where a sync found positions that differ (list_linked_institutions shows positionsDiffering): each difference is closed with a dated holding or sale. Only the tickers named, or every difference. Nothing is ever reconciled on its own.',
        parameters: { type: 'object', properties: {
            account: { type: 'string', description: 'The account, "portfolio:<id>" or its name' },
            tickers: { type: 'array', items: { type: 'string' } }
        }, required: ['account'] }
    }, (a = {}) => {
        PortfolioApp.loadData();
        const want = String(a.account || '').replace(/^portfolio:/, '').trim();
        const acct = PortfolioApp.getAccounts().find(x => x.id === want) || PortfolioApp.getAccounts().find(x => String(x.name || '').toLowerCase() === want.toLowerCase());
        if (!acct || !acct.brokerage) return { error: `No linked account "${a.account}".` };
        if (!(acct.brokerage.drift || []).length) return { ok: true, note: 'Its positions already match the brokerage.' };
        const rows = bk().applyDrift(acct.id, a.tickers);
        PortfolioApp.changed();
        const after = PortfolioApp.getAccounts().find(x => x.id === acct.id);
        return { ok: true, account: acct.name, adjusted: rows.map(r => `${r.type === 'holding' ? 'added' : 'removed'} ${r.quantity} ${PortfolioApp.displayTicker(r.ticker)}`), stillDiffering: ((after && after.brokerage && after.brokerage.drift) || []).length };
    }, { ask: true, describe: (a) => `Adjust <strong>${esc(a.account)}</strong> to match its brokerage${Array.isArray(a.tickers) && a.tickers.length ? ` (${esc(a.tickers.join(', '))})` : ''}` });
})();
