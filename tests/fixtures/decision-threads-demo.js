'use strict';
// The Threads demo (docs/THREADS_DEMO.md, scripts/sim-scenarios/threads-demo.json)
// as decision fixtures: Emily's week, synthetic and shaped like real traffic,
// with the right answer for every message known in advance (the demo's own
// spec). Two sets, one per question:
//   sender  every message against every one of the five senders (true for its
//           own, false for the others; the look-alike mail is inconclusive)
//   matter  folder-and-message pairs the filer's narrow look would be asked
//           about (one occurrence seen twice; the next bill; another company's
//           quote; a question the facts cannot settle)
// Dates are relative to today, as the seed plants them. No model is called.
const Sim = require('../../js/main/sim-sources');
const SenderRecords = require('../../js/shared/senders-records');
const C = require('../../js/shared/decision-contract');
const scenario = require('../../scripts/sim-scenarios/threads-demo.json');
const now = new Date();
const fill = v => Sim.fill(v, now);
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const steps = Object.fromEntries(scenario.steps.map(s => [s.id, s]));
const SENDERS = {
    'Auto insurance': 'Covered, paid, the renewal never missed and the price still fair.',
    "Lily's music classes": 'Lily is in her classes, the schedule is right on the calendar and tuition is paid.',
    'Subscriptions': 'Every subscription is one you still use, at a price you know.',
    'Home utilities': 'Water paid on time, with bills in the usual range.',
    'Your dental': 'Cleanings on schedule and nothing outstanding with the office.'
};
const KINDS = { receipt: 'bill', bill: 'bill', renewal: 'subscription', subscription: 'subscription', appointment: 'appointment', general: 'other' };
/** Who a step is from, as the records keep it: { name, key } (a text's key is its handle). */
function party(step) {
    if (step.kind === 'text') return { name: step.chatName || step.handle, key: step.handle };
    const m = /^(.*?)\s*<([^>]+)>/.exec(step.from || '');
    const addr = (m ? m[2] : step.from || '').toLowerCase();
    return { name: (m ? m[1] : '').trim(), key: addr.split('@')[1] || addr };
}
const label = p => SenderRecords._fromLabel(p);
/** A message as the demo's extraction says it, in the words `SenderRecords.eligible` builds for a matter. */
function itemOf(id) {
    const s = steps[id];
    const a = s.analysis || {};
    const kind = KINDS[a.type] || 'other';
    const when = a.eventDate ? ` on ${fill(a.eventDate)}` : '';
    const title = s.kind === 'text' ? fill(String(s.text || '')).slice(0, 70) : fill(s.subject || 'Untitled');
    const summary = fill(a.summary || '').slice(0, 140);
    return { key: `matter:${id}`, kind: 'matter', from: party(s),
        text: `(${kind}${a.settled ? ', done' : ''}) ${title}${when} — from ${label(party(s))}${summary ? `: "${summary}"` : ''}` };
}
const members = Object.fromEntries(Object.entries(scenario.senders).map(([name, ids]) => [name, ids.filter(id => ['email', 'text'].includes(steps[id]?.kind))]));
/** A sender as `Senders.shown` presents it, without the item being judged among what it holds. */
function senderOf(name, except) {
    const ids = members[name].filter(id => id !== except);
    const from = []; const seen = new Set();
    for (const id of ids) { const p = party(steps[id]); if (!seen.has(p.key)) { seen.add(p.key); from.push(p); } }
    return { id: `sender:${name}`, name, allGood: SENDERS[name], from: from.slice(0, 4),
        holds: ids.slice(0, 4).map(id => fill(steps[id].kind === 'text' ? String(steps[id].text).slice(0, 60) : steps[id].subject)) };
}
// ── sender-membership ──
const own = Object.fromEntries(Object.entries(members).flatMap(([name, ids]) => ids.map(id => [id, name])));
const EXPECT = { 'X0.inject': null };   // a look-alike address claiming the policy, no identifier the records hold: never a confirmed join
const sender = [];
for (const id of Object.keys(steps).filter(k => ['email', 'text'].includes(steps[k].kind))) {
    const item = itemOf(id);
    for (const name of Object.keys(SENDERS)) {
        const candidate = senderOf(name, id);
        const why = SenderRecords.argues(item, candidate);
        const expected = id in EXPECT ? (name === 'Auto insurance' ? EXPECT[id] : false) : own[id] === name;
        const state = C.stateFor({ text: item.text }, candidate, why);
        if (!state) throw new Error('Invalid demo sender fixture ' + id);
        sender.push({ id: `demo-${id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-vs-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, expected, state, argued: !!why });
    }
}
// ── matter-membership ──
/** A folder or a message as Matters' narrow look describes them. */
function thing(id, over = {}) {
    const s = steps[id]; const a = s.analysis || {};
    const p = party(s);
    return { title: fill(s.kind === 'text' ? String(s.text).slice(0, 70) : s.subject), kind: KINDS[a.type] || 'other',
        when: a.eventDate ? fill(a.eventDate) : '', status: a.settled ? 'done' : 'open', amount: a.amount ? fill(a.amount) : '',
        from: p.name || p.key, latest: fill(a.summary || '').slice(0, 220), ...over };
}
const cleaning = { title: 'Cleaning with Dr. Patel', kind: 'appointment', when: fill('{{iso:thu+1}}'), time: '10:00', status: 'open', from: 'Bright Smile Dental',
    latest: fill('Next cleaning {{long:thu+1}} at 10:00 AM with Dr. Patel') };
const recital = { title: 'Fall recital at Eastside Hall', kind: 'appointment', when: fill('{{iso:tue+6+11}}'), time: '14:00', status: 'open', from: 'Eastside Music Studio',
    latest: fill('Fall recital {{long:tue+6+11}} 2:00 PM, arrive by 1:30') };
const pair = (id, a, b, reason, expected) => ({ id: `demo-${id}`, expected, state: C.USE_CASES['matter-membership'].stateFor(a, b, reason) });
const matter = [
    // Harbor's revised price for the same renewal date: the demo's story keeps it with the offer, but
    // as ONE occurrence it is arguable either way (a new offer, or the same renewal revised), so it is
    // not held against the model in either direction.
    pair('renewal-reply-same-renewal', thing('A0.offer'), thing('A5.harbor'), 'the folder is $724.00 and this message says $604.00, 6 days later', null),
    pair('trial-then-cancelled', thing('S0.max'), thing('S3.cancel'), '', true),
    pair('cleaning-moved-by-text', cleaning, thing('D0.text', { time: '' }), fill('the folder is for {{iso:thu+1}} and this message is about {{iso:thu+1}}, from another address'), true),
    pair('cleaning-confirmed-monday', { ...cleaning, latest: fill('Reply 1 for {{dmd:thu+1+4}} 9:00 AM, 2 for {{dmd:thu+1+6}} 2:30 PM') }, thing('D5.confirm', { time: '9:00' }),
        fill('the folder is for {{iso:thu+1}} and this message is about {{iso:thu+1+4}}'), true),
    pair('teacher-question-and-reply', thing('M0.text'), thing('M3.reply'), '', true),
    pair('water-next-bill', thing('H0.b6'), thing('H0.bill'), fill('the folder was already done around {{iso:-23d}} and this message is from {{iso:-1d}}; another amount: $64.20 then $142.80'), false),
    pair('water-two-past-bills', thing('H0.b1'), thing('H0.b2'), 'the folder is already done and this message is about a later due date', false),
    pair('renewal-offer-after-paid-term', thing('A0.r3'), thing('A0.offer'), fill('the folder was already done around {{iso:-182d}} and this message is from {{iso:-2d}}'), false),
    pair('two-paid-renewals', thing('A0.r1'), thing('A0.r2'), 'the folder is already done and this message is about a renewal six months later', false),
    pair('id-cards-after-renewal', thing('A0.r3'), thing('A0.cards'), '', false),
    pair('other-insurers-quote', thing('A0.offer'), thing('A4.lakeside'), 'the message is from another company', false),
    pair('two-quotes-two-companies', thing('A4.lakeside'), thing('A4.pioneer'), 'the message is from another company', false),
    pair('two-streaming-receipts', thing('S0.netflix'), thing('S0.spotify'), 'the message is from another company', false),
    pair('trial-and-other-receipt', thing('S0.max'), thing('S0.netflix'), 'the message is from another company', false),
    pair('forms-before-the-cleaning', cleaning, thing('D0.forms'), fill('the folder is for {{iso:thu+1}} and this message asks for something new'), false),
    pair('recital-and-teachers-question', recital, thing('M0.text'), 'the message is from another address', null),
    // A look-alike address with no policy identifier: never the renewal's folder ("different" is the safe answer; inconclusive would also do).
    pair('look-alike-policy-notice', thing('A0.offer'), thing('X0.inject'), 'the message is from another address', false)
];
for (const p of matter) if (!p.state) throw new Error('Invalid demo matter fixture ' + p.id);
module.exports = { sender, matter, today: iso(now) };
