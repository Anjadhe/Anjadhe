// Pins js/apps/portfolio/finance-transfer.js: Finance's plain JSON export
// and its merge-by-id import (FT1-FT4).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '../js/apps/portfolio/finance-transfer.js'), 'utf8');
const ctx = { console, JSON, Date, Map, Set, Object, Number, String, Array };
vm.createContext(ctx);
vm.runInContext(src + '\nthis.FT = FinanceTransfer;', ctx);
const FT = ctx.FT;
const j = x => JSON.parse(JSON.stringify(x));

const portfolio = {
    accounts: [
        { id: 'a1', name: 'Brokerage', type: 'brokerage', updatedAt: '2026-10-01T00:00:00Z', brokerage: { itemId: 'item', linkedMachineId: 'mac' } },
        { id: 'a2', name: 'From a friend', shared: { from: 'x' } }
    ],
    transactions: [
        { id: 't1', accountId: 'a1', ticker: 'AAPL', shares: 10, price: 150, type: 'buy', updatedAt: '2026-10-01T00:00:00Z' },
        { id: 't2', accountId: 'a2', ticker: 'MSFT', shares: 1 }
    ],
    properties: [{ id: 'p1', name: 'Home' }], liabilities: [{ id: 'l1', name: 'Mortgage' }],
    strategies: [{ id: 's1', name: 'Plan' }], watchlist: [{ id: 'w1', symbol: 'NVDA' }],
    shares: [{ id: 'sh1' }], tombstones: { gone: '2026-01-01T00:00:00Z' }
};
const history = { snapshots: [{ date: '2026-10-01', netWorth: 100 }, { date: '2026-10-02', netWorth: 110 }] };
const spending = { links: [{ id: 'link1', itemId: 'item' }], accounts: [{ id: 'b1', name: 'Checking', itemId: 'item' }],
    transactions: [{ id: 'bt1', accountId: 'b1', amount: 12 }], rules: [{ id: 'r1', merchant: 'Cafe', category: 'Food' }] };

// 1. Export: own accounts only, links stripped, shares/tombstones/links left out.
const file = j(FT.build({ portfolio, history, spending }, new Date('2026-10-11T10:00:00Z')));
assert.equal(file.format, 'nenva-finance');
assert.deepEqual(file.portfolio.accounts.map(a => a.id), ['a1']);
assert.equal(file.portfolio.accounts[0].brokerage, undefined, 'the brokerage link does not travel');
assert.deepEqual(file.portfolio.transactions.map(t => t.id), ['t1'], 'a shared account\'s rows stay behind');
assert.equal(file.portfolio.shares, undefined);
assert.equal(file.spending.links, undefined);
assert.equal(file.history.snapshots.length, 2);
assert.equal(portfolio.accounts[0].brokerage.itemId, 'item', 'the export never edits the live data');
assert.match(FT.summary(FT.counts(file)), /1 account, 1 transaction, 1 property, 1 debt, 1 strategy, 1 watched ticker, 2 snapshots/);

// 2. Round trip into an empty Finance (after an erase): everything comes back.
const parsed = FT.parse(JSON.stringify(file));
const empty = { portfolio: {}, history: { snapshots: [] }, spending: {} };
const r = j(FT.plan(parsed, empty, '2026-10-11T12:00:00Z'));
assert.equal(r.portfolio.transactions[0].shares, 10);
assert.equal(r.history.snapshots.length, 2);
assert.equal(r.spending.rules[0].category, 'Food');
assert.equal(r.report.added, 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1);
assert.equal(r.report.snapshots, 2);

// 3. FT1: merge by id: newer wins, older does not, nothing removed; this Mac's day wins.
{
    const cur = {
        portfolio: { transactions: [
            { id: 't1', accountId: 'a1', shares: 99, updatedAt: '2026-10-05T00:00:00Z' },
            { id: 'local', accountId: 'a1', shares: 1 }
        ], accounts: [{ id: 'a1', name: 'Old name', updatedAt: '2026-09-01T00:00:00Z' }] },
        history: { snapshots: [{ date: '2026-10-02', netWorth: 999 }] }, spending: {}
    };
    const m = j(FT.plan(parsed, cur, '2026-10-11T12:00:00Z'));
    assert.equal(m.portfolio.transactions.find(t => t.id === 't1').shares, 99, 'a newer local copy is kept');
    assert.ok(m.portfolio.transactions.some(t => t.id === 'local'), 'nothing is removed');
    assert.equal(m.portfolio.accounts[0].name, 'Brokerage', 'a newer imported copy replaces');
    assert.equal(m.history.snapshots.find(s => s.date === '2026-10-02').netWorth, 999);
    assert.equal(m.history.snapshots.length, 2);
}

// 4. FT2: a tombstoned record is restored and stamped past the tombstone.
{
    const cur = { portfolio: { tombstones: { t1: '2026-10-09T00:00:00Z', other: '2026-01-01T00:00:00Z' } }, history: {}, spending: {} };
    const m = j(FT.plan(parsed, cur, '2026-10-11T12:00:00Z'));
    const t1 = m.portfolio.transactions.find(t => t.id === 't1');
    assert.equal(t1.updatedAt, '2026-10-11T12:00:00Z');
    assert.equal(m.portfolio.tombstones.t1, undefined);
    assert.ok(m.portfolio.tombstones.other, 'other deletes stand');
    assert.equal(m.report.restored, 1);
}

// 5. FT4: not an export → refused whole.
assert.ok(FT.parse('not json').error);
assert.ok(FT.parse('{"facts": []}').error);
assert.ok(FT.parse(JSON.stringify({ format: 'nenva-finance', version: 99 })).error);

console.log('finance-transfer-test: all passed');
