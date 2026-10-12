#!/usr/bin/env node
/**
 * Linking through the assistant (docs/THREAD_PANELS.md step 3): the link
 * tool returns at once, the accounts land when the sign-in finishes, and a
 * code-written note names them in the conversation that asked. Plaid,
 * Connect and the two halves are stubs.
 */
const assert = require('assert');
const tools = {};
global.AgentTools = { register(def, fn, opts) { tools[def.function.name] = { fn, opts: opts || {} }; } };
global.UIUtils = { escapeHtml: s => String(s), showToast() {} };
let finishSignIn;
global.InstitutionLink = {
    PRODUCTS: { bank: ['transactions'], brokerage: ['investments'] },
    _busy: false,
    available: () => true, busy() { return this._busy; },
    start({ products }) { this._busy = true; this.lastProducts = products; return new Promise(r => { finishSignIn = v => { this._busy = false; r(v); }; }); },
    failMessage: (r, f) => (r && r.error) || f
};
const conv = { id: 'c1', messages: [] };
global.AgentService = { conversations: [conv], _saveConversations() {} };
let changed = 0;
const accounts = [];
global.PortfolioApp = {
    loadData() {}, changed() { changed++; }, getAccounts: () => accounts, displayTicker: t => t,
    createAccount(name, type, cash) { const a = { id: `p${accounts.length + 1}`, name, type, cashBalance: cash }; accounts.push(a); return a; }
};
const spending = { links: () => [], accountsFor: () => [], addAccounts: async () => ({ accounts: [{ name: 'Chase Checking ····1234' }, { name: 'Sapphire ····9876' }] }) };
global.Anjadhe = { use: n => (n === 'spending' ? spending : null) };
global.PortfolioBrokerage = { available: () => true, linkedAccounts: () => [], addAccounts: async () => ({ accounts: [], error: 'That brokerage reported no investment accounts.' }) };
global.window = { electronBrokerage: { items: async () => ({ items: [] }) } };
require('../js/apps/portfolio/finance-link-tools.js');

(async () => {
    // Every write asks; the read does not.
    for (const n of ['create_account', 'link_institution', 'relink_institution', 'unlink_institution', 'reconcile_brokerage']) assert.ok(tools[n] && tools[n].opts.ask, `${n} asks`);
    assert.ok(tools.list_linked_institutions.opts.readOnly);

    // Linking: returns before anything is linked; the note follows the sign-in.
    const r = await tools.link_institution.fn({ kind: 'bank' }, { convId: 'c1' });
    assert.ok(r.started && /Nothing is linked until/.test(r.note), 'the reply is told nothing is linked yet');
    assert.deepStrictEqual(InstitutionLink.lastProducts, ['transactions'], 'a bank link asks for transactions');
    assert.strictEqual(conv.messages.length, 0);
    const again = await tools.link_institution.fn({ kind: 'brokerage' }, { convId: 'c1' });
    assert.ok(again.error, 'one sign-in at a time');
    finishSignIn({ status: 'done', item: { itemId: 'i1', institution: 'Chase' } });
    await new Promise(res => setTimeout(res, 10));
    assert.strictEqual(conv.messages.length, 1);
    assert.match(conv.messages[0].content, /^Linked Chase\. Added Chase Checking ····1234, Sapphire ····9876\./);
    assert.ok(conv.messages[0].metadata.financeLink, 'code-written, marked as such');
    assert.ok(changed >= 1, 'the drawers repaint');

    // A brokerage that reports nothing: said plainly.
    await tools.link_institution.fn({ kind: 'brokerage' }, { convId: 'c1' });
    finishSignIn({ status: 'done', item: { itemId: 'i2', institution: 'Schwab' } });
    await new Promise(res => setTimeout(res, 10));
    assert.match(conv.messages[1].content, /Linked Schwab, but no accounts were added: That brokerage reported no investment accounts\./);

    // Cancelled in the browser: nothing in the chat.
    await tools.link_institution.fn({ kind: 'bank' }, { convId: 'c1' });
    finishSignIn(null);
    await new Promise(res => setTimeout(res, 10));
    assert.strictEqual(conv.messages.length, 2);

    // Never in an ambient run.
    assert.ok((await tools.link_institution.fn({ kind: 'bank' }, { ambient: true })).error);

    // An account kept by hand.
    const c = await tools.create_account.fn({ name: 'Vanguard Roth', type: 'roth-ira', cash: 2500 });
    assert.ok(c.created && accounts[0].cashBalance === 2500 && accounts[0].type === 'roth-ira');
    assert.ok((await tools.create_account.fn({ name: 'vanguard roth', type: 'ira' })).error, 'no second account of the same name');

    console.log('finance-link-tools: linking in the background, the note in the chat, accounts kept by hand passed');
})().catch(e => { console.error(e); process.exit(1); });
