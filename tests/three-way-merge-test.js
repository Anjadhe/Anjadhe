// Merging a phone edit into the Mac's copy (js/main/three-way-merge.js,
// laws M1–M5). The two failures it exists for: a phone check-off replacing
// every task change made on the Mac since, and a task deleted on the Mac
// coming back from the phone's stale copy.
const assert = require('node:assert/strict');
const { mergePhoneEdit } = require('../js/main/three-way-merge');

const t = (id, extra = {}) => ({ id, title: id, done: false, ...extra });
const blob = (...items) => ({ scheduleItems: items, version: 1 });

// The ghost-task case: Mac deleted b and added d; the phone, still holding
// a and b, checked a off. Both changes land; b stays deleted.
{
    const base = blob(t('a'), t('b'), t('c'));
    const mine = blob(t('a'), t('c'), t('d'));
    const theirs = blob(t('a', { done: true }), t('b'), t('c'));
    const out = mergePhoneEdit(base, mine, theirs);
    assert.deepEqual(out.scheduleItems.map(r => [r.id, r.done]), [['a', true], ['c', false], ['d', false]]);
}

// M1: only one side changed — that side, exactly.
{
    const base = blob(t('a'));
    assert.deepEqual(mergePhoneEdit(base, base, blob(t('a', { done: true }))), blob(t('a', { done: true })));
    assert.deepEqual(mergePhoneEdit(base, blob(t('a', { title: 'A' })), base), blob(t('a', { title: 'A' })));
}

// M2: field-level — the Mac renamed, the phone completed, the same record.
{
    const base = blob(t('a'));
    const out = mergePhoneEdit(base, blob(t('a', { title: 'Renamed' })), blob(t('a', { done: true })));
    assert.deepEqual(out.scheduleItems[0], { id: 'a', title: 'Renamed', done: true });
}

// M3: a delete never swallows the other side's edit.
{
    const base = blob(t('a'), t('b'));
    assert.deepEqual(mergePhoneEdit(base, blob(t('a')), blob(t('a'), t('b', { done: true }))).scheduleItems.map(r => r.id), ['a', 'b'],
        'the Mac deleted b but the phone completed it: kept');
    assert.deepEqual(mergePhoneEdit(base, blob(t('a'), t('b', { title: 'B2' })), blob(t('a'))).scheduleItems.map(r => r.id), ['a', 'b'],
        'the phone deleted b but the Mac edited it: kept');
    assert.deepEqual(mergePhoneEdit(base, blob(t('a'), t('b')), blob(t('a'))).scheduleItems.map(r => r.id), ['a'],
        'the phone deleted an untouched record: gone');
}

// Both added records: both kept, phone's after the Mac's.
{
    const base = blob(t('a'));
    const out = mergePhoneEdit(base, blob(t('a'), t('m')), blob(t('a'), t('p')));
    assert.deepEqual(out.scheduleItems.map(r => r.id), ['a', 'm', 'p']);
}

// M4: both changed the same field — newer record stamp wins, else the phone.
{
    const base = blob(t('a', { updatedAt: '2026-10-01' }));
    const macNewer = mergePhoneEdit(base, blob(t('a', { title: 'mac', updatedAt: '2026-10-03' })), blob(t('a', { title: 'phone', updatedAt: '2026-10-02' })));
    assert.equal(macNewer.scheduleItems[0].title, 'mac');
    const plain = mergePhoneEdit(blob(t('a')), blob(t('a', { title: 'mac' })), blob(t('a', { title: 'phone' })));
    assert.equal(plain.scheduleItems[0].title, 'phone');
    assert.equal(mergePhoneEdit({ x: 1 }, { x: 2 }, { x: 3 }).x, 3);
}

// Top-level keys: added, removed, changed on either side.
{
    const out = mergePhoneEdit({ a: 1, b: 2, c: 3 }, { a: 1, b: 2, c: 4, d: 5 }, { a: 1, c: 3, e: 6 });
    assert.deepEqual(out, { a: 1, c: 4, d: 5, e: 6 });
}

// M5: no base — union, nothing deleted.
{
    const out = mergePhoneEdit(undefined, blob(t('a'), t('c')), blob(t('a', { done: true }), t('b')));
    assert.deepEqual(out.scheduleItems.map(r => [r.id, r.done]), [['a', true], ['c', false], ['b', false]]);
}

// Inputs are never mutated; a missing Mac value takes the phone's.
{
    const base = blob(t('a')); const mine = blob(t('a'), t('m')); const theirs = blob(t('a', { done: true }));
    const snap = JSON.stringify([base, mine, theirs]);
    mergePhoneEdit(base, mine, theirs);
    assert.equal(JSON.stringify([base, mine, theirs]), snap);
    assert.deepEqual(mergePhoneEdit(base, undefined, theirs), theirs);
}

// M5 with a base STAMP but no stored base (the first sync after this
// update): a phone-only record older than the base is one the Mac deleted —
// it stays deleted; one the phone touched after is kept.
{
    const since = '2026-09-30T17:42:00.000Z';
    const mine = blob(t('a'));
    const theirs = blob(t('a'), t('ghost', { modifiedAt: '2026-09-20T00:00:00.000Z' }), t('new', { modifiedAt: '2026-10-02T09:00:00.000Z' }));
    const out = mergePhoneEdit(undefined, mine, theirs, { haveBase: false, since });
    assert.deepEqual(out.scheduleItems.map(r => r.id), ['a', 'new']);
}

console.log('three-way-merge-test: ok');
