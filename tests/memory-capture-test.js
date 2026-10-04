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
