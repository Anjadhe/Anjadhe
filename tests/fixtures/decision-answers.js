'use strict';
// Synthetic response builder shared by tests, never by runtime inference.
module.exports = p => ({ same_sender: p === 0.5
    ? { type: 'choice', choice: 'inconclusive', probabilities: { same: 0, different: 0, inconclusive: 1 } }
    : { type: 'choice', choice: p >= 0.5 ? 'same' : 'different',
        probabilities: { same: p, different: 1 - p, inconclusive: 0 } } });
