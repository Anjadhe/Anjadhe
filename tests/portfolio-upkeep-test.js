// Finance upkeep from a chat (2026-10-08, docs/AI_NATIVE.md parity batch 5):
// the assistant fixes and removes what the Finance pages fix and remove,
// by the pages' own rules. Runs the REAL PortfolioApp (adjustCash,
// txnAmount, _tombstone, saveData) over an in-memory store.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const R = path.join(__dirname, '..') + '/';
const noop = () => {};
const clone = (v) => JSON.parse(JSON.stringify(v));
const mem = {
    portfolio: {
        accounts: [
            { id: 'acc1', name: 'Brokerage', type: 'brokerage', cashBalance: 1000, createdAt: '2026-01-01' },
            { id: 'acc2', name: 'Old IRA', type: 'other', cashBalance: null, createdAt: '2026-01-01' }
        ],
        transactions: [
            { id: 't1', accountId: 'acc1', type: 'buy', ticker: 'AAPL', quantity: 10, pricePerShare: 50, date: '2026-09-01', notes: '' },
            { id: 't2', accountId: 'acc2', type: 'holding', ticker: 'VTI', quantity: 5, pricePerShare: 200, date: '2026-01-02', notes: '' }
        ],
        properties: [{ id: 'p1', name: 'Condo', currentValue: 300000, purchasePrice: 250000 }],
        liabilities: [
            { id: 'l1', name: 'Condo mortgage', type: 'mortgage', balance: 200000, propertyId: 'p1' },
            { id: 'l2', name: 'Honda loan', type: 'auto', balance: 4000 }
        ],
        strategies: [], watchlist: [], shares: [], tombstones: {}
    }
};
const spending = { rules: [{ id: 'm:starbucks', merchant: 'Starbucks', category: 'dining' }] };
const tools = {}, asks = new Set();
const linksRemoved = [];
Object.assign(globalThis, {
    window: globalThis,
    document: { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null, addEventListener: noop, createElement: () => ({ style: {}, classList: { add: noop } }) },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    StorageManager: { get: (k) => (k in mem ? clone(mem[k]) : null), set: (k, v) => { mem[k] = clone(v); } },
    AppManager: { register: noop, escapeHtml: (s) => String(s), currentApp: 'home' },
    UIUtils: { escapeHtml: (s) => String(s), showToast: noop },
    FEATURES: { isEnabled: () => false },
    LinkManager: { removeAllLinksForItem: (app, id) => linksRemoved.push(`${app}:${id}`) },
    AgentTools: { register: (def, handler, opts = {}) => { tools[def.function.name] = handler; if (opts.ask) asks.add(def.function.name); return { ok: true }; } },
    SpendingApp: { CATEGORIES: { dining: 'Dining' }, loadData: noop, get data() { return spending; },
        removeRule(id) { const i = spending.rules.findIndex(r => r.id === id); if (i < 0) return false; spending.rules.splice(i, 1); return true; } }
});
const load = (f) => (0, eval)(fs.readFileSync(R + f, 'utf8').replace(/^const (\w+) =/m, 'globalThis.$1 ='));
load('js/apps/portfolio/portfolio-prices.js');
load('js/apps/portfolio/portfolio-app.js');
PortfolioApp.refreshPrices = noop;
PortfolioApp.loadData();
load('js/apps/portfolio/portfolio-upkeep-tools.js');
const store = () => mem.portfolio;
const cash = (id) => store().accounts.find(a => a.id === id).cashBalance;

// Reads
let r = tools.list_transactions({ account: 'brokerage' });
assert.equal(r.count, 1);
assert.equal(r.transactions[0].id, 't1');
assert.ok(tools.list_transactions({ account: 'nope' }).error);

// Fix a buy: 10 @ 50 became 10 @ 40. Cash had already paid 500 (as recorded,
// 1000 is after it); reverse 500, apply 400 → 1100.
r = tools.change_transaction({ id: 't1', pricePerShare: 40 });
assert.equal(r.success, true);
assert.equal(cash('acc1'), 1100, 'cash moves as an edit on the page moves it');
assert.match(r.was, /at 50/);
assert.match(r.now, /at 40/);
// A sell larger than what is held is refused, as on the page.
assert.match(tools.change_transaction({ id: 't1', type: 'sell', quantity: 99 }).error, /to sell/);
assert.ok(tools.change_transaction({ id: 't1', date: 'yesterday' }).error);
// A holding never touches cash; an account not tracking cash stays null.
tools.change_transaction({ id: 't2', quantity: 6 });
assert.equal(cash('acc2'), null);

// Delete the buy: its 400 comes back, and the record is tombstoned.
r = tools.delete_transaction({ id: 't1' });
assert.equal(r.success, true);
assert.equal(cash('acc1'), 1500);
assert.ok(store().tombstones.t1, 'tombstoned so sync cannot resurrect it');
assert.ok(!store().transactions.some(t => t.id === 't1'));

// Accounts
r = tools.change_account({ account: 'old ira', name: 'Rollover IRA', type: 'ira' });
assert.equal(r.now.name, 'Rollover IRA');
assert.equal(store().accounts.find(a => a.id === 'acc2').type, 'ira');
assert.ok(tools.change_account({ account: 'Rollover IRA', type: 'piggybank' }).error);
r = tools.delete_account({ account: 'Rollover IRA' });
assert.equal(r.transactionsRemoved, 1);
assert.ok(store().tombstones.acc2 && store().tombstones.t2, 'the account and its transactions are tombstoned');
assert.deepEqual(linksRemoved, ['portfolio:acc2']);
store().accounts.push({ id: 'acc3', name: 'Shared', shared: { shareId: 's1' } });
PortfolioApp.loadData();
assert.match(tools.delete_account({ account: 'Shared' }).error, /shared/);

// Debts and property: removing the condo keeps its mortgage, unlinked.
r = tools.remove_property({ name: 'condo' });
assert.deepEqual(r.debtsKept, ['Condo mortgage']);
assert.equal(store().liabilities.find(l => l.id === 'l1').propertyId, null);
assert.ok(store().tombstones.p1);
r = tools.remove_liability({ name: 'Honda loan' });
assert.equal(r.removed, 'Honda loan');
assert.ok(store().tombstones.l2);
assert.ok(tools.remove_liability({ name: 'nope' }).error);
assert.ok(tools.save_property({ name: 'Lake house' }).error, 'a new property needs its value');
r = tools.save_property({ name: 'Lake house', currentValue: 450000, purchasePrice: 380000 });
assert.equal(r.created, true);
r = tools.save_property({ name: 'lake house', currentValue: 470000 });
assert.equal(r.created, false);
assert.equal(store().properties.find(p => p.name === 'Lake house').currentValue, 470000);

// Watchlist
assert.deepEqual([...tools.watchlist({ action: 'add', ticker: 'nvda' }).watching], ['NVDA']);
assert.equal(tools.watchlist({ action: 'add', ticker: 'NVDA' }).note, 'Already watched.');
assert.deepEqual([...tools.watchlist({ action: 'remove', ticker: 'NVDA' }).watching], []);
assert.ok(tools.watchlist({ action: 'remove', ticker: 'NVDA' }).error);
assert.ok(tools.watchlist({ action: 'add', ticker: 'not a ticker!' }).error);

// Spending rule
assert.equal(tools.remove_spending_rule({}).rules[0].merchant, 'Starbucks');
assert.equal(tools.remove_spending_rule({ merchant: 'starbucks' }).removed, 'Starbucks');
assert.ok(tools.remove_spending_rule({ merchant: 'starbucks' }).error);

// Every change asks; reads and the watchlist do not.
for (const n of ['change_transaction', 'delete_transaction', 'change_account', 'delete_account', 'remove_liability', 'save_property', 'remove_property']) assert.ok(asks.has(n), `${n} asks`);
for (const n of ['list_transactions', 'watchlist']) assert.ok(!asks.has(n), `${n} does not ask`);

console.log('portfolio-upkeep: transactions, accounts, debts, property, watchlist and rules fixed by the pages\' own rules');
