#!/usr/bin/env node
// Matters (js/core/matters.js), rebuilt AI-native 2026-10-02: the facts code
// keeps, how related folders are found, the checks on the assistant's answer,
// and what an answer does to a folder. The judgment itself is the model's and
// is not tested here.
const assert = require('assert');
const M = require('../js/core/matters.js');
const NOW = Date.parse('2026-10-02T12:00:00');

const msg = (id, from, subject, body, extra = {}) => ({ messageId: id, from, subject, bodyText: body, date: '2026-10-01T10:00:00Z', ...extra });
const facts = (m, a = {}) => M.facts(m, { summary: m.subject, ...a }, m.bodyText);

// ── Facts ──
{
    assert.deepEqual(M.identifiers('Your order #112-3344556-7788990 shipped. Confirmation K7Q2ZP1. Tracking 1Z999AA10123456784').sort(),
        ['112-3344556-7788990', '1z999aa10123456784', 'k7q2zp1'].sort());
    assert.deepEqual(M.identifiers('Thanks, see you at 10:30'), [], 'times and short numbers are not identifiers');
    assert.deepEqual(M.links('Pay at https://pay.city.gov/acct/1. Unsubscribe: https://x.com/unsubscribe?u=1 or https://pay.city.gov/acct/1'), ['https://pay.city.gov/acct/1']);
    const f = facts(msg('t1', 'Dr. Lee Dental', 'Reminder', 'Reply C to confirm', { source: 'imessage', chat: { handle: '+1 (555) 010-2000', key: 'chat-1' } }));
    assert.equal(f.meta.imessage, true); assert.equal(f.meta.thread, 'chat-1'); assert.equal(f.meta.address, '+1 (555) 010-2000');
}

// ── Finding related folders, by fact ──
{
    const water = { id: 'matter:w1', state: 'open', updatedAt: '2026-09-28T00:00:00Z', title: 'City Water bill', ids: ['88001234'], sources: [{ address: 'billing@citywater.gov', thread: 'th-1' }] };
    const dentist = { id: 'matter:d1', state: 'open', updatedAt: '2026-09-28T00:00:00Z', title: 'Cleaning', ids: [], sources: [{ address: '+15550102000', thread: 'chat-1' }] };
    const old = { id: 'matter:o1', state: 'done', updatedAt: '2026-01-01T00:00:00Z', title: 'Old bill', ids: [], sources: [{ address: 'billing@citywater.gov' }] };
    const f = facts(msg('w2', '"City Water" <billing@citywater.gov>', 'Reminder: account 88001234', 'Your bill is due.'));
    const c = M.candidates(f, [dentist, old, water], NOW);
    assert.deepEqual(c.map(x => x.id), ['matter:w1'], 'same sender and a shared number; an old closed one and an unrelated one are not offered');
    const viaCode = facts(msg('x', 'Expedia <trips@expedia.com>', 'Itinerary', 'Booking'), { reservation: { confirmationCode: 'K7Q2ZP' } });
    assert.deepEqual(M.candidates(viaCode, [{ id: 'matter:f', state: 'open', updatedAt: '2026-09-30', code: 'k7q2zp', ids: [], sources: [{ address: 'receipts@united.com' }] }], NOW).map(x => x.id), ['matter:f'],
        'another sender with the same confirmation code is the same booking');
}

// ── The checks on the assistant's answer ──
const dentistText = msg('d2', 'Dr. Lee Dental', 'Appointment reminder', 'Your cleaning is Thu Oct 8 at 10:30 AM. Reply C to confirm. https://lee.example/confirm', { source: 'imessage', chat: { handle: '+15550102000', key: 'chat-1' } });
{
    const f = facts(dentistText, { eventDate: '2026-10-08' });
    const folder = { id: 'matter:d1', title: 'Cleaning with Dr. Lee', status: '', sources: [] };
    const ok = M.vet({ about: 'M1', kind: 'appointment', title: 'Cleaning with Dr. Lee', status: 'Waiting for you to confirm', change: 'same',
        when: '2026-10-08', time: '10:30', next: { what: 'Reply C to confirm', label: 'Confirm', by: '2026-10-07', how: 'reply', reply: 'C', yours: false }, tell: 'morning' }, f, [folder], NOW);
    assert.equal(ok.about, 'matter:d1'); assert.equal(ok.next.reply, 'C'); assert.equal(ok.time, '10:30'); assert.equal(ok.tell, 'morning');
    assert.equal(M.vet({ about: 'M3', kind: 'bill' }, f, [folder], NOW), null, 'a folder it was not shown');
    assert.equal(M.vet({ about: 'whatever' }, f, [], NOW), null);
    assert.deepEqual(M.vet({ about: 'none', tell: 'file' }, f, [], NOW), { about: 'none', tell: 'file' });
    const bad = M.vet({ about: 'new', kind: 'appointment', title: 'Cleaning at 9:15', status: 'Costs $240', when: '2031-01-01', time: '25:00',
        next: { what: 'Reply Y', how: 'reply', reply: 'Y' }, tell: 'loud' }, f, [], NOW);
    assert.equal(bad.title, '', 'a time the message does not hold');
    assert.equal(bad.status, '', 'an amount the message does not hold');
    assert.equal(bad.when, null, 'a date too far off'); assert.equal(bad.time, null);
    assert.equal(bad.next.how, 'none', 'a reply code the message never asks for is not offered');
    assert.equal(bad.tell, 'morning', 'an unknown tell is morning, never now');
    const link = M.vet({ about: 'new', kind: 'appointment', title: 'Cleaning', next: { what: 'Confirm online', how: 'link', link: 1 }, tell: 'now' }, f, [], NOW);
    assert.equal(link.next.url, 'https://lee.example/confirm', 'a link from the message');
    assert.equal(M.vet({ about: 'new', title: 'x', next: { what: 'Pay', how: 'link', link: 4 } }, f, [], NOW).next.how, 'none', 'a link it made up');
    assert.equal(M.vet({ about: 'new', kind: 'spaceship', title: 'x' }, f, [], NOW).kind, 'other');
}

// ── What an answer does ──
{
    const store = {};
    const f1 = facts(msg('w1', '"City Water" <billing@citywater.gov>', 'Your water bill', 'Amount due $41.00 by Oct 12. https://pay.citywater.gov/a/1'), { amount: '$41.00' });
    const m = M.apply(store, { about: 'new', kind: 'bill', title: 'City Water bill', status: 'Due Oct 12', change: 'new', when: '2026-10-12',
        next: { what: 'Pay $41.00', label: 'Pay', by: '2026-10-12', how: 'link', url: 'https://pay.citywater.gov/a/1', yours: true }, tell: 'morning' }, f1, NOW);
    assert.equal(m.id, 'matter:w1'); assert.equal(m.next.state, 'open'); assert.equal(M.workStep(m).what, 'Pay $41.00');
    assert.deepEqual(M.card(m), { title: 'City Water bill', body: 'Due Oct 12. Pay $41.00', primary: 'Pay', dismiss: 'Already done' });
    m.next.taskId = 'task-1';
    const f2 = facts(msg('w2', '"City Water" <billing@citywater.gov>', 'Reminder: bill due', 'Your $41.00 bill is due Oct 12.'));
    M.apply(store, { about: 'matter:w1', kind: 'bill', title: '', status: 'Due Oct 12', change: 'same',
        next: { what: 'Pay the bill', label: 'Pay', by: '2026-10-12', how: 'none', yours: true }, tell: 'file' }, f2, NOW);
    assert.equal(m.sources.length, 2, 'a reminder is a source on the same folder');
    assert.equal(m.title, 'City Water bill', 'an empty title keeps the old one');
    assert.equal(m.next.taskId, 'task-1', 'the step keeps its task across a reminder');
    const f3 = facts(msg('w3', '"City Water" <billing@citywater.gov>', 'Payment received', 'Thanks, we received your $41.00 payment.'));
    M.apply(store, { about: 'matter:w1', kind: 'bill', status: 'Paid', change: 'done', tell: 'file' }, f3, NOW);
    assert.equal(m.state, 'done'); assert.equal(m.next.state, 'done'); assert.equal(M.openStep(m), null);
    assert.equal(M.apply(store, { about: 'none', tell: 'file' }, f3, NOW), null);
    const flight = M.apply(store, { about: 'new', kind: 'reservation', title: 'United to Seattle', change: 'new', when: '2026-10-09', time: '08:05', tell: 'morning' },
        facts(msg('u1', 'United', 'Booked', 'Confirmation K7Q2ZP'), { reservation: { kind: 'flight', vendor: 'United', confirmationCode: 'K7Q2ZP', to: 'SEA', returnEnd: '2026-10-13T20:10' } }), NOW);
    assert.deepEqual([flight.resKind, flight.vendor, flight.code, flight.place, flight.end], ['flight', 'United', 'K7Q2ZP', 'SEA', '2026-10-13'], 'a booking keeps the extractor\'s facts');
    assert.ok(!M.settle(flight, Date.parse('2026-10-12T12:00:00')), 'not over until the return');
    assert.ok(M.settle(flight, Date.parse('2026-10-14T12:00:00'))); assert.equal(flight.state, 'past');
    const cancel = M.apply(store, { about: 'new', kind: 'appointment', title: 'Haircut', change: 'new', when: '2026-10-05', next: { what: 'Reply Y', how: 'reply', reply: 'Y' }, tell: 'morning' },
        facts(msg('h1', 'Salon', 'Haircut', 'Reply Y')), NOW);
    M.apply(store, { about: cancel.id, kind: 'appointment', status: 'Cancelled', change: 'cancelled', tell: 'now' }, facts(msg('h2', 'Salon', 'Cancelled', 'Cancelled')), NOW);
    assert.equal(cancel.state, 'cancelled'); assert.equal(cancel.next.state, 'done');
}

// ── Check-in, and your own reply closing a step ──
{
    const m = { kind: 'reservation', resKind: 'flight', state: 'open', when: { date: '2026-10-10', time: '08:05' }, checkinUrl: 'https://united.com/checkin' };
    assert.equal(M.checkinFor(m, Date.parse('2026-10-09T07:00:00')), null);
    assert.deepEqual(M.checkinFor(m, Date.parse('2026-10-09T09:00:00')), { url: 'https://united.com/checkin' });
    assert.equal(M.checkinFor({ ...m, checkedIn: true }, Date.parse('2026-10-09T09:00:00')), null);
    const d = { state: 'open', sources: [{ kind: 'imessage', thread: 'chat-1' }], next: { state: 'open', how: 'reply', reply: 'C', to: '+1 555 010 2000', askedAt: '2026-10-01T10:00:00Z' } };
    assert.equal(M.noteReply([d], { channel: 'imessage', to: '+15550102000', at: '2026-09-30T10:00:00Z' }).length, 0, 'a text sent before it was asked');
    assert.equal(M.noteReply([d], { channel: 'imessage', to: '(555) 010-2000', at: '2026-10-01T11:00:00Z' }).length, 1);
    assert.equal(d.next.state, 'done');
}
console.log('matters: facts, related folders, checks, what an answer does, check-in, replies passed');

// ── Ignore (2026-10-02: "sometimes we don't RSVP when we are not going") ──
{
    const store = {};
    const f = facts(msg('pls-1', 'PLS <events@pls.org>', 'Movie Night', 'Please RSVP for PLS Movie Night on Oct 16.'));
    const m = M.apply(store, { about: 'new', kind: 'other', title: 'PLS Movie Night', status: 'RSVP requested', change: 'new', when: '2026-10-16',
        next: { what: 'RSVP for PLS Movie Night', label: 'RSVP', how: 'reply', reply: null, yours: false }, tell: 'morning' }, f, NOW);
    M._data = { version: 2, matters: store };
    global.StorageManager = { set() {}, get() { return null; } };
    const before = M.ignore(m.id);
    assert.equal(m.state, 'ignored'); assert.equal(m.next.state, 'skipped'); assert.equal(M.openStep(m), null, 'nothing left to do');
    assert.ok(!M.openMatters().includes(m), 'off Now');
    M.unignore(m.id, before);
    assert.equal(m.state, 'open'); assert.equal(M.openStep(m).what, 'RSVP for PLS Movie Night', 'Undo puts it back');
    M._data = null;
}
console.log('matters: ignore and undo passed');
