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
    assert.equal(M.vet({ about: 'M<1>', kind: 'appointment', title: 'Cleaning' }, f, [folder], NOW).about, 'matter:d1', 'a label with the brackets copied');
    assert.equal(M.vet({ about: 'M<1>', kind: 'appointment', title: 'Cleaning' }, f, [], NOW).about, 'new', 'a folder named when none were shown can only be a new thing: kept, not dropped');
    assert.equal(M.vet({ about: 'C1', kind: 'appointment', title: 'Cleaning' }, f, [], NOW).about, 'new');
    assert.equal(M.vet({ about: 'C1', kind: 'appointment', title: 'Cleaning' }, f, [folder], NOW), null, 'with folders shown, a label that is not one of them is refused');
    assert.equal(M.vet({ about: 'M1', change: 'new' }, f, [folder], NOW).change, 'same', '"new" about a folder that exists is not a change');
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

// ── One folder holds the whole thing (2026-10-03) ──
{
    // An office's email and its text share no sender, thread or number: the
    // same day as an open folder is what makes it a candidate.
    const dentist = { id: 'matter:d1', state: 'open', updatedAt: '2026-10-01T00:00:00Z', title: 'Cleaning with Dr. Lee', when: { date: '2026-10-08', time: '10:30' }, ids: [], sources: [{ address: 'office@leedental.com' }] };
    const other = { id: 'matter:x', state: 'open', updatedAt: '2026-10-01T00:00:00Z', title: 'Water bill', when: { date: '2026-10-20' }, ids: [], sources: [{ address: 'bill@water.gov' }] };
    const text = facts(msg('t9', '+1 555 010 2000', '', 'Reminder: cleaning Thu Oct 8 10:30. Reply C to confirm', { source: 'imessage', chat: { handle: '+15550102000', key: 'chat-9' } }), { eventDate: '2026-10-08' });
    assert.equal(M.candidates(text, [other, dentist], NOW).map(x => x.id).join(), 'matter:d1', 'the same day brings the email folder in');

    // The person's own task: offered, picked, related, and the step is that task.
    const tasks = M.tasksAround(['2026-10-08'], NOW, [
        { id: 'a', title: 'Call the dentist about the crown', scheduledDate: '2026-10-06' },
        { id: 'b', title: 'Far away', scheduledDate: '2026-12-01' },
        { id: 'c', title: 'Done already', scheduledDate: '2026-10-07', lastCompletedDate: '2026-10-02' },
        { id: 'd', title: 'Undated thing', createdAt: '2026-09-30T00:00:00Z' }]);
    assert.equal(tasks.map(t => t.id).join(), 'a,d', 'open tasks within a week, then undated');
    const j = M.vet({ about: 'M1', kind: 'appointment', title: 'Cleaning with Dr. Lee', change: 'same', task: 'T1', calendar: 'C1',
        next: { what: 'Call about the crown', how: 'none', yours: true, is_task: true }, tell: 'file' }, text, [dentist], NOW, [{ id: 'ev-1' }], tasks);
    assert.equal(j.taskId, 'a'); assert.equal(j.calendarEventId, 'ev-1');
    assert.equal(M.vet({ about: 'M1', task: 'T7' }, text, [dentist], NOW, [], tasks).taskId, null, 'a task it was not shown');
    const store = { 'matter:d1': dentist };
    const m = M.apply(store, j, text, NOW);
    assert.equal(m.sources.length, 2, 'the text joins the email folder');
    assert.equal(m.tasks.join(), 'a'); assert.equal(m.next.taskId, 'a', 'the step is the task they already had, so none is made');
    const m2 = M.apply({}, { ...j, about: 'new', next: { ...j.next, isTask: false } }, facts(msg('t10', 'x@y.com', 'x', 'x')), NOW);
    assert.equal(m2.tasks.join(), 'a'); assert.equal(m2.next.taskId, null, 'a task about the thing that is not the step stays only related');

    // The calendar event's facts, and what changed on it, live on the folder.
    M.mergeCalendar(m, { id: 'ev-1', title: 'Dentist', date: '2026-10-08', time: '10:30', location: '12 Main St' }, NOW);
    M.mergeCalendar(m, { id: 'ev-1', title: 'Dentist', date: '2026-10-09', time: '09:00', location: '12 Main St' }, NOW);
    assert.equal(m.calendar.date, '2026-10-09');
    assert.equal(m.log.map(l => l.text).join(' | '), 'On your calendar: "Dentist" Thu, Oct 8, 10:30 AM | Your calendar moved it to Fri, Oct 9, 9:00 AM');
    M.mergeCalendar(m, { id: 'ev-1', title: 'Dentist', date: '2026-10-09', time: '09:00', location: '12 Main St' }, NOW);
    assert.equal(m.log.length, 2, 'nothing changed, nothing written');
}
console.log('matters: one folder holds the whole thing passed');

// ── One door, and one folder per thing (2026-10-05, MATTERS.md §15) ──
{
    // An observation from anything is the record mail produces.
    const mail = facts(msg('e1', 'Dr. Lee Dental <office@leedental.com>', 'Your cleaning', 'Thu Oct 8 at 10:30'));
    assert.equal(mail.source, 'email'); assert.equal(mail.own, false);
    const said = M.observation({ id: 'chat:c1:4', source: 'chat', at: '2026-10-02T09:00:00Z', text: 'I paid it, confirmation 88001234', summary: 'I paid it' });
    assert.deepEqual([said.source, said.own, said.meta.name, said.meta.imessage], ['chat', true, 'You', false]);
    assert.deepEqual(said.ids, ['88001234'], 'the same identity facts are read from the person\'s words');
    assert.equal(M.vet({ about: 'new', kind: 'bill', title: 'Thing', tell: 'now' }, said, [], NOW).tell, 'file', 'what the person said themselves is never news to them');

    // What the person said is a source on the folder, never a message.
    const store = {};
    const bill = M.apply(store, { about: 'new', kind: 'bill', title: 'City Water bill', status: 'Due Oct 12', change: 'new', when: '2026-10-12',
        next: { what: 'Pay the bill', how: 'none', yours: true }, tell: 'morning' },
        facts(msg('w1', '"City Water" <billing@citywater.gov>', 'Your water bill', 'Due Oct 12')), NOW);
    M.apply(store, { about: bill.id, kind: 'bill', title: '', status: 'Paid', change: 'done', tell: 'file' }, said, NOW);
    assert.equal(bill.state, 'done'); assert.equal(bill.next.state, 'done');
    assert.deepEqual(bill.sources.map(s => s.kind), ['email', 'chat']);
    assert.equal(M.messagesOf(bill).length, 1, 'counts and "open the message" read only mail and texts');
    const step = M.apply(store, { about: bill.id, kind: 'bill', title: '', status: 'Disputing it', change: 'changed', next: { what: 'Call the water office', how: 'none', yours: true }, tell: 'file' },
        M.observation({ id: 'chat:c1:6', source: 'chat', text: 'I will call the water office' }), NOW);
    assert.equal(step.state, 'open', 'their own words reopen it');
    assert.equal(step.next.messageId, 'w1', 'a step they named still opens the message it came from');
}
{
    // The second look: folders the first search could not offer.
    const dentist = { id: 'matter:d1', kind: 'appointment', state: 'open', updatedAt: '2026-10-01T00:00:00Z', title: 'Cleaning with Dr. Okonkwo', when: { date: '2026-10-08' }, ids: [], sources: [{ from: 'Okonkwo Dental', address: 'office@okonkwodental.com', summary: 'Cleaning Thu Oct 8' }] };
    const water = { id: 'matter:w1', kind: 'bill', state: 'open', updatedAt: '2026-10-01T00:00:00Z', title: 'City Water bill', when: { date: '2026-10-20' }, ids: [], sources: [{ from: 'City Water', address: 'bill@water.gov', summary: 'Your bill is due' }] };
    const gym = { id: 'matter:g1', kind: 'subscription', state: 'open', updatedAt: '2026-10-01T00:00:00Z', title: 'Gym membership', when: { date: '2026-11-01' }, ids: [], sources: [{ from: 'FitClub', address: 'hi@fitclub.com', summary: 'Your membership renews' }] };
    const all = [dentist, water, gym];
    // A portal's reminder: another sender, no thread, a different day in its text.
    const portal = facts(msg('p1', 'PatientPortal <no-reply@portal.example>', 'Message from Okonkwo Dental', 'Please complete your forms before your visit.'));
    assert.deepEqual(M.candidates(portal, all, NOW), [], 'nothing by sender, thread, number or day');
    assert.deepEqual(M.near(portal, { kind: 'appointment', title: 'Forms for Okonkwo Dental visit', when: null }, all, [], NOW).map(m => m.id), ['matter:d1'], 'an uncommon shared name brings the folder in');
    assert.deepEqual(M.near(portal, { kind: 'appointment', title: 'Forms for Okonkwo Dental visit' }, all, [dentist], NOW), [], 'a folder already shown is not shown again');
    const other = facts(msg('p2', 'Shop <orders@shop.example>', 'Your order shipped', 'It is on the way.'));
    assert.deepEqual(M.near(other, { kind: 'order', title: 'Order from Shop' }, all, [], NOW), [], 'nothing alike, no second call');
    const eye = facts(msg('p3', 'Eye Clinic <hi@eyes.example>', 'See you soon', 'Your exam is Oct 9.'), { eventDate: '2026-10-09' });
    assert.deepEqual(M.near(eye, { kind: 'appointment', title: 'Eye exam', when: '2026-10-09' }, all, [], NOW).map(m => m.id), ['matter:d1'],
        'the same kind around the same days is worth a look; the assistant decides');
}
{
    // Two folders that are one thing: found by fact, joined, and taken back.
    const iso = '2026-10-01T00:00:00Z';
    const a = { id: 'matter:e1', kind: 'appointment', state: 'open', createdAt: '2026-09-28T00:00:00Z', updatedAt: iso, title: 'Cleaning with Dr. Okonkwo', status: 'Waiting for you to confirm', when: { date: '2026-10-08', time: null }, ids: [],
        sources: [{ id: 'e1', kind: 'email', at: '2026-09-28T00:00:00Z', from: 'Okonkwo Dental' }], next: { what: 'Confirm', state: 'done' }, tasks: ['t1'] };
    const b = { id: 'matter:t1', kind: 'appointment', state: 'open', createdAt: '2026-09-30T00:00:00Z', updatedAt: iso, title: 'Okonkwo Dental appointment', when: { date: '2026-10-08', time: '10:30' }, ids: ['k7q2zp1'],
        sources: [{ id: 't1', kind: 'imessage', at: '2026-09-30T00:00:00Z', from: 'Okonkwo Dental' }], next: { what: 'Reply C', state: 'open', taskId: 't2' }, calendarEventId: 'ev-1', log: [{ at: iso, from: 'calendar', text: 'On your calendar' }] };
    const c = { id: 'matter:w1', kind: 'bill', state: 'open', createdAt: iso, updatedAt: iso, title: 'City Water bill', when: { date: '2026-10-08' }, ids: [], sources: [{ id: 'w1', from: 'City Water' }] };
    const visit2 = { id: 'matter:e9', kind: 'appointment', state: 'open', createdAt: iso, updatedAt: iso, title: 'Crown fitting with Dr. Okonkwo', when: { date: '2026-11-20' }, ids: [], sources: [{ id: 'e9', from: 'Okonkwo Dental' }] };
    const found = M.pairs([a, b, c, visit2], [], NOW);
    assert.deepEqual(found.map(p => [p.a.id, p.b.id]), [['matter:e1', 'matter:t1']], 'the same name on the same day; another visit weeks away and a bill that day are not offered');
    assert.deepEqual(M.pairs([a, b], [M._pairKey(a.id, b.id)], NOW), [], 'a pair judged to be two things is never asked again');

    // An answer that names a folder while the facts say otherwise earns one narrow question.
    const cleaning = { id: 'matter:c', state: 'open', kind: 'appointment', when: { date: '2026-10-08', time: '10:30' }, ids: ['k7q2zp1'], code: 'ABC123' };
    const at = (extra = {}) => facts(msg('z', 'Okonkwo Dental', 's', 'b'), extra);
    assert.match(M.disagrees(at(), { change: 'same', when: '2026-11-20' }, cleaning), /2026-10-08.*2026-11-20/, 'another visit weeks away');
    assert.equal(M.disagrees(at(), { change: 'changed', when: '2026-10-09', time: '09:00' }, cleaning), null, 'moved by a day is a change, not a question');
    assert.match(M.disagrees(at(), { change: 'same', when: '2026-10-08', time: '16:15' }, cleaning), /10:30.*16:15/, 'another hour that day with "nothing new"');
    assert.equal(M.disagrees(at(), { change: 'changed', when: '2026-10-08', time: '11:00' }, cleaning), null, 'a new time that day, said to be a change');
    assert.equal(M.disagrees(at(), { change: 'done', when: '2026-09-22' }, cleaning), null, 'a settlement carries its own date');
    assert.match(M.disagrees(at(), { change: 'same', next: { what: 'Pay' } }, { ...cleaning, state: 'done' }), /already done/, 'a step opened on a settled folder');
    assert.equal(M.disagrees(at(), { change: 'done' }, { ...cleaning, state: 'done' }), null);
    assert.ok(M.disagrees(facts(msg('z2', 'x', 'Account k7q2zp1', 'b')), { change: 'same', when: '2026-11-20' }, cleaning), 'a shared number does not end the question: an account number is on every month\'s bill');
    assert.equal(M.disagrees(at({ reservation: { confirmationCode: 'abc123' } }), { change: 'same', when: '2026-11-20' }, cleaning), null, 'a shared booking code does');
    assert.match(M._samePrompt(M._describe(a), M._describe(b), 'x differs'), /A: Cleaning with Dr. Okonkwo.*\n.*B: Okonkwo Dental appointment[\s\S]*Note: x differs\./);

    M._data = { version: 2, matters: { [a.id]: a, [b.id]: b, [c.id]: c }, aliases: {} };
    global.StorageManager = { set() {}, get() { return null; } };
    const r = M.merge(b.id, a.id, { now: NOW });
    assert.equal(r.keep.id, 'matter:e1', 'the older folder is kept'); assert.equal(r.gone, 'matter:t1');
    const k = r.keep;
    assert.deepEqual(k.sources.map(s => s.id), ['e1', 't1']); assert.deepEqual(k.ids, ['k7q2zp1']);
    assert.equal(k.next.what, 'Reply C', 'the open step survives'); assert.deepEqual(k.tasks, ['t1', 't2']);
    assert.deepEqual([k.when.time, k.calendarEventId, k.title, k.status], ['10:30', 'ev-1', 'Cleaning with Dr. Okonkwo', 'Waiting for you to confirm'], 'its own facts win, the other fills the gaps');
    assert.ok(k.log.some(l => l.from === 'joined'), 'the join is in its history');
    assert.equal(M.get('matter:t1'), k, 'the old id still finds the folder (its chat and commitments follow)');
    assert.deepEqual(M.aliasesOf('matter:e1'), ['matter:t1']); assert.equal(M.all().length, 2);
    assert.equal(M.forSource('t1'), k); assert.equal(M.lastJoin('matter:t1'), 'matter:t1');
    k.sources.push({ id: 'e2', kind: 'email', at: '2026-10-02T00:00:00Z', from: 'Okonkwo Dental' });   // filed after the join
    assert.ok(M.unmerge('matter:t1'));
    assert.deepEqual(M.get('matter:e1').sources.map(s => s.id), ['e1', 'e2'], 'what was filed since stays on the kept one');
    assert.deepEqual(M.get('matter:t1').sources.map(s => s.id), ['t1']); assert.equal(M.get('matter:e1').next.state, 'done');
    assert.deepEqual(M.pairs(M.all(), M._data.distinct, NOW), [], 'taken back means two things, for good');
    assert.equal(M.unmerge('matter:t1'), false);

    // The person's own words on a folder, and Undo.
    const w = M.get('matter:w1');
    w.next = { what: 'Pay the bill', state: 'open', how: 'none', yours: true };
    const out = M.foldOwn(M.observation({ id: 'chat:c9:2', source: 'chat', text: 'I paid that yesterday', summary: 'I paid that yesterday' }),
        { about: 'matter:w1', kind: 'bill', title: '', status: 'Paid', change: 'done', tell: 'file', note: 'You said: "I paid that yesterday"' }, NOW);
    assert.equal(out.m.state, 'done'); assert.equal(out.m.log[out.m.log.length - 1].text, 'You said: "I paid that yesterday"');
    assert.equal(M.foldOwn(M.observation({ id: 'chat:c9:2', source: 'chat', text: 'x' }), { about: 'matter:w1', change: 'done' }, NOW), null, 'one turn is filed once');
    assert.ok(M.undoOwn(out.token));
    assert.deepEqual([M.get('matter:w1').state, M.get('matter:w1').next.state, M.get('matter:w1').sources.length], ['open', 'open', 1], 'Undo puts the folder back as it was');
    assert.equal(M.undoOwn(out.token), false);
    M._data = null;
}
{
    // Nothing major missed: what was passed over, what is waiting, taking a message back out.
    const soon = facts(msg('n1', 'School <office@school.example>', 'Picture day', 'Picture day is Oct 20.'), { eventDate: '2026-10-20' });
    assert.equal(M.stakes(soon, NOW), '2026-10-20', 'a date still ahead');
    assert.equal(M.stakes(facts(msg('n2', 'Shop', 'Receipt', 'Thanks'), { eventDate: '2026-09-01' }), NOW), false, 'a date behind is not a stake');
    assert.equal(M.stakes(facts(msg('n3', 'Shop', 'Invoice', 'x'), { amount: '$12.00' }), NOW), true);
    assert.equal(M.stakes(facts(msg('n4', 'News', 'Weekly', 'x')), NOW), false);
    global.StorageManager = { set() {}, get() { return null; } };
    M._data = { version: 2, matters: {}, aliases: {} };
    M._passOver(soon, NOW);
    M._passOver(facts(msg('n4', 'News', 'Weekly', 'x')), NOW);
    M._passOver(M.observation({ id: 'chat:c:1', source: 'chat', text: 'mom has surgery on the 14th', dates: ['2026-10-14'] }), NOW);
    assert.deepEqual(Object.keys(M._data.passed).sort(), ['chat:c:1', 'n1'], 'only what carried a stake is recorded');
    assert.ok(M._data.passed['chat:c:1'].f && !M._data.passed.n1.f, 'the person\'s words keep themselves; mail is read again by id');
    assert.deepEqual(M.dueRelook(M._data.passed, NOW).map(p => p.id), ['chat:c:1', 'n1'], 'soonest first');
    M._data.passed.n1.looks = 1;
    assert.deepEqual(M.dueRelook(M._data.passed, NOW).map(p => p.id), ['chat:c:1'], 'one second look each');
    assert.deepEqual(M.dueRelook(M._data.passed, Date.parse('2026-10-20T12:00:00')), [], 'not once its day has passed');

    M._waitFor(soon, 'connect ECONNREFUSED');
    M._waitFor(soon, 'no answer');
    M._waitFor(facts(msg('n5', 'x', 'x', 'x')), 'Email stays on this Mac: blocked by privacy');
    assert.deepEqual(Object.keys(M._data.retry), ['n1'], 'a refusal for privacy is not queued');
    assert.equal(M._data.retry.n1.tries, 2);
    const later = Date.now() + 31 * 60000;
    assert.equal(M.dueRetry(M._data.retry, Date.now()).length, 0, 'not within the half hour');
    assert.equal(M.dueRetry(M._data.retry, later).length, 1);
    M._data.retry.n1.tries = 4;
    assert.equal(M.dueRetry(M._data.retry, later).length, 0, 'and not forever');

    const store = M._data.matters;
    const water = M.apply(store, { about: 'new', kind: 'bill', title: 'City Water bill', status: 'Due Oct 12', change: 'new', when: '2026-10-12', next: { what: 'Pay the bill', how: 'none', yours: true }, tell: 'morning' },
        facts(msg('w1', '"City Water" <billing@citywater.gov>', 'Your water bill', 'Due Oct 12')), NOW);
    M.apply(store, { about: water.id, kind: 'bill', title: 'City Water and Power', status: 'Paid', change: 'done', tell: 'file' },
        facts(msg('p1', 'City Power <billing@citypower.gov>', 'Payment received', 'Thanks for your payment.')), NOW + 1000);
    assert.equal(water.state, 'done');
    assert.equal(M.pullOut('nope'), null);
    const out = M.pullOut('p1', NOW + 2000);
    assert.deepEqual([out.m.title, out.m.status, out.m.state, out.m.next.state, out.m.sources.length], ['City Water bill', 'Due Oct 12', 'open', 'open', 1], 'the folder is back where it stood before that message');
    assert.ok(out.m.log.some(l => l.from === 'moved'));
    assert.deepEqual(M._offerable({ id: 'p1' }).map(m => m.id), [], 'that message is never offered that folder again');
    assert.equal(M._offerable({ id: 'other' }).length, 1);
    assert.equal(M.pullOut('w1'), null, 'a folder\'s only message is the folder');

    // The last check before a card is shown, and what review reports.
    const dup = M.apply(store, { about: 'new', kind: 'bill', title: 'Water bill from City Water', status: 'Due Oct 12', change: 'new', when: '2026-10-12', next: { what: 'Pay', how: 'none', yours: true }, tell: 'morning' },
        facts(msg('w9', 'Bill Pay <alerts@bank.example>', 'City Water bill due', 'Due Oct 12')), NOW + 3000);
    M._rev = 1; M._held = null; M.tidy = () => Promise.resolve(null);
    assert.deepEqual([...M.heldBack(NOW)], [dup.id], 'of two that look like one thing, the newer waits');
    M._data.unjudged = [M._pairKey(water.id, dup.id)]; M._rev = 2;
    assert.deepEqual([...M.heldBack(NOW)], [], 'it fails open: a pair that could not be judged shows both');
    const log = console.log; console.log = () => {};
    const r = M.review(NOW);
    console.log = log;
    assert.equal(r.alike.length, 1); assert.equal(r.passedOver.length, 2); assert.equal(r.waiting, 1); assert.equal(r.stats.passed, 2);
    M._data = null;
}
{
    // One at a time: the second observation waits for the first to be filed.
    const order = [];
    const slow = M._enqueue(async () => { await new Promise(r => setTimeout(r, 20)); order.push('first'); });
    const fast = M._enqueue(async () => { order.push('second'); });
    const failed = M._enqueue(async () => { throw new Error('x'); }).catch(() => order.push('failed'));
    const after = M._enqueue(async () => { order.push('after'); });
    Promise.all([slow, fast, failed, after]).then(() => {
        assert.deepEqual(order, ['first', 'second', 'failed', 'after'], 'in order, and a failure does not stop the queue');
        console.log('matters: one door, the second look, join and take back, own words, the queue passed');
    }).catch(e => { console.error(e); process.exit(1); });
}
