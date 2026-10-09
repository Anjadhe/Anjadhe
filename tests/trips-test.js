#!/usr/bin/env node
// Trips (js/core/trips.js): the facts a trip is built from, and the checks on
// what the assistant says about it.
const assert = require('assert');
const T = require('../js/core/trips.js');

const res = {};
const m = (id, r, extra = {}) => { res[`src-${id}`] = r; return { id: `matter:${id}`, kind: 'reservation', state: 'open', sources: [{ id: `src-${id}` }], ...extra }; };
const flight = m('f', { kind: 'flight', vendor: 'United', confirmationCode: 'K7Q2ZP', start: '2026-10-09T08:05', from: 'SFO', to: 'SEA', returnStart: '2026-10-13T18:00', returnEnd: '2026-10-13T20:10' });
const hotel = m('h', { kind: 'lodging', vendor: 'Marriott Downtown', place: 'Seattle', start: '2026-10-09', end: '2026-10-11' });
const car = m('c', { kind: 'car', vendor: 'Hertz', place: 'SEA airport', start: '2026-10-09T11:00', end: '2026-10-13T16:00' });
const dinner = m('d', { kind: 'dining', vendor: 'Canlis', start: '2026-10-10T19:30' });
const lone = m('l', { kind: 'dining', vendor: 'Nopa', start: '2026-10-22T19:00' });
const gone = m('g', { kind: 'lodging', vendor: 'Ace Hotel', place: 'Portland', start: '2026-10-11', end: '2026-10-13' }, { state: 'cancelled' });
const later = m('n', { kind: 'flight', vendor: 'Delta', to: 'JFK', start: '2026-11-20T07:00' });
const resOf = id => res[id] || null;

const trips = T.cluster([flight, hotel, car, dinner, lone, gone, later].map(x => T.booking(x, resOf)), '2026-10-02');
assert.equal(trips.length, 2, 'Seattle and New York; a lone dinner is not a trip');
const sea = trips[0];
assert.deepEqual(sea.bookings.map(b => b.kind), ['flight', 'car', 'lodging', 'dining'], 'flight, car, stay and the dinner, in time order');
assert.equal(sea.start, '2026-10-09'); assert.equal(sea.end, '2026-10-13', 'the return leg sets the end');
assert.equal(sea.place, 'Seattle', 'a stay names the place');
assert.equal(sea.key, 'matter:f');
assert.ok(!sea.bookings.some(b => b.vendor === 'Ace Hotel'), 'a cancelled booking is not on the trip');
const nights = T.nights(sea);
assert.deepEqual(nights.map(n => !!n.stay), [true, true, false, false], 'two nights with no stay');
assert.match(T.factsText(sea), /Nights with NO stay booked: .*\(2026-10-11\); .*\(2026-10-12\)/);
assert.deepEqual(T.gaps(sea), ['2026-10-11', '2026-10-12']);
assert.match(T.itinerary(sea)[0].line, /return Tue, Oct 13, 6:00/, 'a round trip says when it comes back');
assert.equal(T.nightsAgree({ missing_nights: ['2026-10-12', '2026-10-11'] }, T.gaps(sea)), true);
assert.equal(T.nightsAgree({ missing_nights: ['2026-10-10'] }, T.gaps(sea)), false, 'a misread night is caught');
assert.equal(T.nightsAgree({}, T.gaps(sea)), null);
assert.match(T.itinerary(sea)[0].line, /^Flight: United, SFO to SEA · .*confirmation K7Q2ZP/);
assert.equal(T.cluster([T.booking(dinner, resOf)], '2026-10-02').length, 0);
assert.equal(T.cluster(trips[0].bookings, '2026-10-20').length, 0, 'a trip that ended is gone');

const facts = T.factsText(sea);
const cands = [{ id: 'park', subject: 'SFO parking reserved Oct 9', summary: 'Parking at SFO Oct 9 to Oct 13' }, { id: 'bank', subject: 'Statement', summary: 'Your statement' }];
const ok = T.vet({ name: 'Seattle', belongs: ['park', 'made-up'], brief: 'You fly out Friday at 8:05 and the Marriott covers two nights.', offers: [{ label: 'Find a hotel for Oct 11', ask: 'Find me hotel options in Seattle for Oct 11 and 12' }, { label: '', ask: 'x' }] }, cands, facts);
assert.deepEqual(ok.belongs, ['park'], 'only ids it was shown');
assert.ok(ok.brief, 'a brief whose numbers are all in the facts stays');
assert.equal(ok.offers.length, 1, 'an offer needs a label and an ask');
const bad = T.vet({ brief: 'Your flight leaves at 9:40 from gate 52.', belongs: [] }, cands, facts);
assert.equal(bad.brief, '', 'a time the bookings do not hold drops the brief');
assert.equal(T.vet('nonsense', cands, facts), null);
console.log('trips: facts, nights, checks passed');
