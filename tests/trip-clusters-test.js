#!/usr/bin/env node
/**
 * EmailTrips clustering — the arithmetic behind the home Trips card
 * (js/apps/email/email-trips.js). Pure date logic, so it runs standalone:
 *
 *   node tests/trip-clusters-test.js
 *
 * The clock is pinned (todayISO is a parameter, the eval-harness rule), so
 * every case is reproducible.
 */

const EmailTrips = require('../js/apps/email/email-trips.js');

const TODAY = '2026-08-10';
let failures = 0;

function check(name, cond, detail) {
    if (cond) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

const res = (over) => ({
    kind: 'other', vendor: null, confirmationCode: 'ABC123',
    start: null, end: null, returnStart: null, returnEnd: null,
    from: null, to: null, place: null, status: 'confirmed', cancelBy: null,
    ...over,
});
const insight = (id, r) => [id, { type: 'reservation', reservation: res(r) }];

// ── 1. The canonical trip: flight + hotel + dinner chain into one ──
{
    const analyses = Object.fromEntries([
        insight('m1', { kind: 'flight', vendor: 'United', from: 'SFO', to: 'SEA', start: '2026-08-20T07:05', returnStart: '2026-08-23T18:10', returnEnd: '2026-08-23T20:15' }),
        insight('m2', { kind: 'lodging', vendor: 'Marriott Downtown', place: 'Seattle', start: '2026-08-20', end: '2026-08-23' }),
        insight('m3', { kind: 'dining', vendor: 'Canlis', place: 'Seattle', start: '2026-08-21T19:00' }),
    ]);
    const trips = EmailTrips.trips(analyses, TODAY);
    check('flight+hotel+dinner is one trip', trips.length === 1, `got ${trips.length}`);
    check('trip holds all three', trips[0]?.items.length === 3);
    check('span runs to the return leg', trips[0]?.end === '2026-08-23');
    check('named after the stay, not the airport code', trips[0]?.dest === 'Seattle', trips[0]?.dest);
    check('coveredIds matches membership',
        [...EmailTrips.coveredIds(analyses, TODAY)].sort().join() === 'm1,m2,m3');
}

// ── 2. Anchor rule: a lone dinner is not a trip ──
{
    const analyses = Object.fromEntries([
        insight('m1', { kind: 'dining', vendor: 'Chez Panisse', start: '2026-08-12T19:30' }),
    ]);
    check('lone dinner founds nothing', EmailTrips.trips(analyses, TODAY).length === 0);
    check('lone hotel IS a trip', EmailTrips.trips(Object.fromEntries([
        insight('m2', { kind: 'lodging', vendor: 'Inn', start: '2026-09-01', end: '2026-09-03' }),
    ]), TODAY).length === 1);
}

// ── 3. Cancelled reservations are off the trip ──
{
    const analyses = Object.fromEntries([
        insight('m1', { kind: 'flight', to: 'JFK', start: '2026-08-20', status: 'cancelled' }),
        insight('m2', { kind: 'lodging', place: 'New York', start: '2026-08-20', end: '2026-08-22' }),
    ]);
    const trips = EmailTrips.trips(analyses, TODAY);
    check('cancelled flight dropped, hotel remains', trips.length === 1 && trips[0].items.length === 1);
}

// ── 4. Lifecycle: gone the day after it ends, present through the last day ──
{
    const over = Object.fromEntries([insight('m1', { kind: 'lodging', start: '2026-08-05', end: '2026-08-09' })]);
    check('ended yesterday → gone', EmailTrips.trips(over, TODAY).length === 0);
    const today = Object.fromEntries([insight('m2', { kind: 'lodging', start: '2026-08-08', end: '2026-08-10' })]);
    check('ends today → still shown', EmailTrips.trips(today, TODAY).length === 1);
    const mid = Object.fromEntries([
        insight('m3', { kind: 'lodging', start: '2026-08-08', end: '2026-08-14' }),
        insight('m4', { kind: 'dining', start: '2026-08-09T19:00', place: null }),
    ]);
    const t = EmailTrips.trips(mid, TODAY);
    check('mid-trip: passed dinner still on the manifest', t.length === 1 && t[0].items.length === 2);
}

// ── 5. Back-to-back different destinations split; code-vs-city does not ──
{
    const twoTrips = Object.fromEntries([
        insight('m1', { kind: 'lodging', place: 'Seattle', start: '2026-08-20', end: '2026-08-24' }),
        insight('m2', { kind: 'lodging', place: 'Los Angeles', start: '2026-08-25', end: '2026-08-28' }),
    ]);
    check('adjacent different cities are two trips', EmailTrips.trips(twoTrips, TODAY).length === 2);

    const codeVsCity = Object.fromEntries([
        insight('m1', { kind: 'flight', to: 'SEA', start: '2026-08-20T07:00', end: '2026-08-20T09:10' }),
        insight('m2', { kind: 'lodging', place: 'Seattle', start: '2026-08-21', end: '2026-08-24' }),
    ]);
    check('code vs city never splits', EmailTrips.trips(codeVsCity, TODAY).length === 1);

    const overlap = Object.fromEntries([
        insight('m1', { kind: 'flight', to: 'SEA', start: '2026-08-20', returnStart: '2026-08-27' }),
        insight('m2', { kind: 'lodging', place: 'Portland', start: '2026-08-24', end: '2026-08-26' }),
    ]);
    check('overlap always merges, whatever the names', EmailTrips.trips(overlap, TODAY).length === 1);
}

// ── 6. pastDays: the Bundles index sees finished trips; the card never does ──
{
    const analyses = Object.fromEntries([
        insight('m1', { kind: 'lodging', place: 'Tahoe', start: '2026-07-01', end: '2026-07-04' }),
        insight('m2', { kind: 'flight', to: 'SEA', start: '2026-09-01', returnStart: '2026-09-05' }),
    ]);
    check('default (live) drops the finished trip', EmailTrips.trips(analyses, TODAY).length === 1);
    const withPast = EmailTrips.trips(analyses, TODAY, { pastDays: 90 });
    check('pastDays: 90 keeps it', withPast.length === 2);
    check('label names the destination', EmailTrips.label(withPast[1]) === 'Trip · SEA'
        && EmailTrips.label({ dest: null }) === 'Trip');
}

// ── 7. Garbage in, nothing out ──
{
    const analyses = Object.fromEntries([
        insight('m1', { kind: 'flight', start: null }),                    // code-only: no timeline
        ['m2', { type: 'bill' }],                                          // no reservation at all
        ['m3', null],
    ]);
    check('undated/absent reservations cluster to nothing', EmailTrips.trips(analyses, TODAY).length === 0);
}

console.log('');
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('All trip-cluster checks passed.');
