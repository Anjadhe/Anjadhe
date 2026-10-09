#!/usr/bin/env node
/**
 * MoneySettle's pure core (js/core/money-settle.js): which bank rows could
 * have paid which bill, and the check on the assistant's answer.
 *
 *   node tests/money-settle-test.js
 */
const assert = require('assert');
const S = require('../js/core/money-settle.js');

const matters = [
    { id: 'water', kind: 'bill', state: 'open', title: 'City Water bill', amount: '$84.20', sources: [{ at: '2026-10-01T09:00:00Z', from: 'City Water' }] },
    { id: 'card', kind: 'bill', state: 'open', title: 'Chase statement', amount: '$1,250.00', sources: [{ at: '2026-10-02T09:00:00Z', from: 'Chase' }] },
    { id: 'paid', kind: 'bill', state: 'done', amount: '$84.20', sources: [] },
    { id: 'dentist', kind: 'appointment', state: 'open', amount: '$84.20', sources: [] },
    { id: 'noamount', kind: 'bill', state: 'open', sources: [] },
    { id: 'used', kind: 'bill', state: 'done', amount: '$30', paidRow: 'r-used', sources: [] },
    { id: 'gym', kind: 'subscription', state: 'open', title: 'Gym', amount: '30', sources: [{ at: '2026-09-20T09:00:00Z', from: 'Gym' }] }
];
const rows = [
    { id: 'r1', date: '2026-10-05', amount: 84.2, merchant: 'City Water Dept', account: 'Checking' },
    { id: 'r2', date: '2026-10-06', amount: 84.2, merchant: 'Trader Joes', account: 'Card' },
    { id: 'r3', date: '2026-09-28', amount: 84.2, merchant: 'City Water Dept' },
    { id: 'r4', date: '2026-10-07', amount: 1250, merchant: 'Chase Card Payment', pending: true },
    { id: 'r5', date: '2026-10-07', amount: -84.2, merchant: 'Refund' },
    { id: 'r6', date: '2026-10-08', amount: 84.25, merchant: 'Near miss' },
    { id: 'r-used', date: '2026-10-01', amount: 30, merchant: 'Gym' }
];
const c = S.candidates(matters, rows);
assert.deepEqual(c.map(x => x.matter.id), ['water'], 'open bills with an amount and a matching posted row only');
assert.deepEqual(c[0].rows.map(r => r.id), ['r1', 'r2'], 'exact amount, on or after the bill arrived, money out; a row used for another bill is not offered again');
assert.equal(S.candidates(matters, rows.map(r => r.id === 'r4' ? { ...r, pending: false } : r)).length, 2, 'a posted row joins; a pending one does not');
assert.equal(S.candidates([], rows).length, 0);

assert.deepEqual(S.vet({ paid: [{ folder: 'M1', row: 'B1' }] }, c).map(p => [p.matter.id, p.row.id]), [['water', 'r1']]);
assert.equal(S.vet({ paid: [{ folder: 'M2', row: 'B1' }] }, c).length, 0, 'a folder it was not shown');
assert.equal(S.vet({ paid: [{ folder: 'M1', row: 'B9' }] }, c).length, 0, 'a row it was not shown');
assert.equal(S.vet({ paid: [{ folder: 'M1', row: 'B1' }, { folder: 'M1', row: 'B2' }] }, c).length, 1, 'one row per bill');
assert.equal(S.vet(null, c).length, 0);
assert.equal(S.vet({ paid: [] }, c).length, 0, 'not sure is a fine answer');
{
    const two = S.candidates(matters, rows.map(r => r.id === 'r4' ? { ...r, pending: false } : r));
    assert.equal(S.vet({ paid: [{ folder: 'M2', row: 'B1' }] }, two).length, 0, 'a row belongs to the bill it was listed under');
    assert.deepEqual(S.vet({ paid: [{ folder: 'M2', row: 'B3' }] }, two).map(p => p.row.id), ['r4'], 'rows are numbered across the list');
    const p = S._prompt(two, m => m.title);
    assert.ok(/\[M1\] City Water bill — \$84\.2/.test(p) && /\[B3\] 2026-10-07 \$1250 to "Chase Card Payment"/.test(p));
}
console.log('money-settle: ok');
