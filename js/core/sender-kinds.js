/**
 * Kinds of senders: GUIDANCE for the assistant, never a classification
 * (docs/SENDERS.md "Kinds of senders", Ram 2026-10-10: "they should be
 * guidance and not code level classifications"). No code branches on a kind
 * and nothing is matched against these words. The placement prompt reads
 * SIZE (what makes a good sender, with examples and the too-big / too-small
 * cases); a sender's look will read WATCH (what is worth watching for things
 * like it). Most real senders will not be on this list, and the prompt says
 * so: a small model copies examples literally.
 */
const SenderKinds = {
    SIZE: `A SENDER is one long-lived thing in the person's life that you look after for them, sized so you can say in ONE sentence what "all good" means for it.
Examples (only examples; most of their senders will be things not named here, called what THEY would call them):
- Auto insurance: covered, paid, the renewal not missed, the price still fair.
- Car upkeep for one car: service on time, registration current, recalls handled.
- Utilities: every bill paid, no unexplained spike (one sender for all of them unless one has its own story).
- Each credit card: paid on time, no surprise charges.
- Subscriptions: every charge is one they want; trials cancelled before they charge.
- Taxes for one year; Retirement (401k, IRA); Stock investments; Stock from work; Kids' college (529); HSA.
- Your dental; your medical; kids' dental; kids' medical (dental and medical are separate: different offices, rhythms and paperwork).
- Prescriptions for one person; pet care; an aging parent's care.
- School payments; school events (separate: a fee and a field trip serve different "all good"s).
- Music classes for a child; a sports team; summer camp; childcare.
- A goal they are working on: build muscle, better sleep, learn Spanish.
- One trip.
- Passports and IDs; phone plan; work benefits.
- A one-off thing gets a sender of its own: a dishwasher repair, a return, a move.
TOO BIG (never a sender): School, Health, Finances, Home, Kids, Shopping. Use the narrower things inside them.
TOO SMALL (never a sender): one bill, one order, one appointment. Those are events INSIDE a sender (the water bill goes in Utilities, a cleaning in Your dental).
Split by person or provider only when "all good" differs; the same counterparty with the same rhythm is usually one sender.`,

    WATCH: `What is worth watching, for things like these (guidance, never a checklist):
- Insurance: the renewal date, a premium change, ID cards, claims.
- A car: service reminders, recall notices, registration and inspection dates.
- Bills and cards: due dates, a charge that is not like the others, an annual fee before it hits.
- Utilities: a bill far above the usual, with the likely cause said plainly (a jump in water usage is often a leak; a jump in power is often a rate change or the season) and the simple way to check it offered.
- Subscriptions: price rises, a trial about to charge.
- Investments: contributions against plan, drift from their own strategy, cash left uninvested; never a market call or a price prediction.
- Health: the next cleaning or checkup, results, a follow-up the doctor asked for that has no appointment.
- Kids' activities: fees, schedule changes, forms before a season starts, the teacher's messages.
- IDs: expiry against booked trips.
- Goals: the steps they planned against what they did.`
};

if (typeof module !== 'undefined') module.exports = SenderKinds;
