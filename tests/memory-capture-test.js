// MemoryCapture: eligibility (K1/K5), the quote law (K2) and forget-by-id
// (K3). The 2026-10-02 case: a follow-up with no
// "remember" in it, answered "Stored too", must be looked at.
const assert = require('assert');
const C = require('../js/agent/memory-capture.js');

// K1 — no word list decides what is looked at (AI native 2026-10-02): the
// assistant reads every eligible turn; only a message too short to hold a
// fact is skipped, and private / lean / untrusted chats never are read.
assert.equal(typeof C.worthReading, 'undefined');
assert.equal(typeof C.claimsSaved, 'undefined', 'whether the answer claimed a save is the model\'s call too');
assert.ok(C.eligible({ id: 'c' }));
assert.ok(!C.eligible({ id: 'c', contextMode: 'simple' }));
assert.ok(!C.eligible({ id: 'c' }, { untrusted: true }));

// K2/K3 — vetting
const user = "Actually I left Acme in August. My partner's name is Sam.";
const v = C.vet([
    { text: 'Partner is Sam', heading: 'people', subject: 'partner', quote: "My partner's name is Sam" },
    { text: 'Works at Globex', heading: 'work', subject: 'employer', quote: 'I work at Globex' },        // not in the user's words
    { forget: 'f1', quote: 'I left Acme in August' },
    { forget: 'nope', quote: 'I left Acme in August' },                                                // unknown id
    { text: 'x', heading: 'about', quote: 'ok' }                                                        // quote too short
], { known: [{ id: 'f1' }], userText: user });
assert.deepEqual(v.save.map(s => s.subject), ['partner']);
assert.deepEqual(v.forget.map(f => f.id), ['f1']);
assert.equal(v.dropped, 3);
// curly quotes in the person's words still match
assert.ok(C.quoteOk("my partner's name", 'My partner’s name is Sam'));

console.log('memory-capture: gates, quotes, forget, claims passed');

// K6 — a card's chat knows the message its card came from, so "these alerts
// can be ignored" becomes a sentence on Memory › Email (2026-10-05).
assert.equal(C.aboutBlock(null), '');
assert.equal(C.aboutBlock({ subject: 'x' }), '', 'no sender, nothing to name');
const ab = C.aboutBlock({ from: 'AC Library', address: 'donotreply@aclibrary.org', subject: 'Your AC Library materials may be overdue' });
assert.ok(ab.includes('AC Library <donotreply@aclibrary.org>') && ab.includes('may be overdue') && ab.includes('heading "email"'));
assert.ok(C.aboutBlock({ from: '+15551234567', address: '+15551234567', text: true }).includes('a text'));
// the fact still needs the person's own words (K2)
assert.equal(C.vet([{ text: 'Ignore overdue notices from AC Library (donotreply@aclibrary.org).', heading: 'email', subject: 'library notices', quote: 'alerts from library can be ignored' }],
    { userText: 'these alerts from library can be ignored' }).save[0].heading, 'email');
console.log('memory-capture: card chats name their sender passed');

// K7 — in a sender's thread, a lasting fact about the THING is kept on the
// sender, not in Memory (docs/SENDERS.md M5); same quote rule, forget by its id.
{
    const text = 'Our GEICO policy number is 4471-22 and the agent is Dana';
    const v = C.vet([
        { text: 'Policy number is 4471-22.', on: 'thing', subject: 'policy number', quote: 'policy number is 4471-22' },
        { text: 'Agent is Dana.', heading: 'thing', quote: 'not what they said' },            // no quote: dropped
        { forget: 'sf_old', quote: 'the agent is Dana' },                                 // a known thing fact
        { text: 'Has a GEICO policy.', heading: 'about', quote: 'Our GEICO policy' }      // about the person
    ], { userText: text, thingKnown: [{ id: 'sf_old', text: 'Agent is Rob.' }] });
    assert.deepEqual(v.thing.map(f => f.subject), ['policy number']);
    assert.deepEqual(v.forgetThing.map(f => f.id), ['sf_old']);
    assert.equal(v.save.length, 1);
    assert.equal(v.dropped, 1);
    // Outside a sender's thread "on: thing" is just a fact about the person.
    assert.equal(C.vet([{ text: 'Policy number is 4471-22.', on: 'thing', quote: 'policy number is 4471-22' }], { userText: text }).save.length, 1);
    assert.equal(C.thingBlock(null), '');
    const tb = C.thingBlock({ name: 'Auto insurance', allGood: 'Covered and paid.' }, [{ id: 'sf_1', subject: 'agent', text: 'Agent is Rob.' }]);
    assert.ok(tb.includes('"Auto insurance"') && tb.includes('Covered and paid') && tb.includes('id sf_1 [agent] Agent is Rob.') && tb.includes('"heading": "thing"'));
    console.log('memory-capture: thing facts kept on the sender passed');
}
{
    assert.ok(C.numbersOk('Agent is Priya Shah.', 'our agent is Priya Shah now'));
    assert.ok(C.numbersOk('Policy GX-4471-22.', 'policy number is GX-4471-22'));
    assert.ok(!C.numbersOk('Agent is Priya Shah, 555-201-7788.', 'our agent is Priya Shah now'));
    const v = C.vet([{ text: 'Agent is Priya, 555-201-7788.', heading: 'thing', quote: 'agent is Priya' }], { userText: 'our agent is Priya now', thingKnown: [] });
    assert.equal(v.thing.length, 0);
    console.log('memory-capture: thing facts carry no number the person did not type passed');
}
