// PrefAsks + Rhythm (AI native 2026-10-02, docs/AI_NATIVE.md phase 4):
// preferences asked with taps, written as Memory sentences, learned from use.
const assert = require('assert');
const facts = [];
global.MemoryManager = {
    all: () => facts,
    remember: ({ text, subject, meta }) => { const i = facts.findIndex(f => f.subject === subject); const f = { id: 'f' + facts.length, text, subject, meta }; if (i >= 0) facts[i] = f; else facts.push(f); return { fact: f, status: 'new' }; }
};
const store = {};
global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
const P = require('../js/core/pref-asks.js');
global.PrefAsks = P;
const R = require('../js/core/rhythm.js');

let ready = false;
P.register({ id: 'brief', default: true, question: 'Keep writing a brief?', ready: () => ready,
    choices: [{ value: true, label: 'Yes', sentence: 'Write me a brief.' }, { value: false, label: 'No', sentence: "Don't write a brief." }] });
assert.equal(P.value('brief'), true, 'the default, nothing to set up');
assert.equal(P.due().length, 0, 'not asked before it matters');
ready = true;
assert.equal(P.due()[0].id, 'brief', 'asked once it matters');
P.snooze('brief');
assert.equal(P.due().length, 0, 'Not now waits');
P.set('brief', false, { quiet: true });
assert.equal(P.value('brief'), false);
assert.equal(facts[0].text, "Don't write a brief.", 'the answer is a sentence in Memory');
P.set('brief', true, { quiet: true });
assert.equal(facts.length, 1, 'a new answer replaces the old sentence');
assert.equal(P.due().length, 0, 'answered is not asked again');

// Learned, confirmed with one tap.
P.register({ id: 'remind', default: 'm0', question: 'q', choices: [{ value: 'm0', label: 'a', sentence: 'A.' }, { value: 'd1', label: 'b', sentence: 'B.' }] });
P.suggest('remind', 'd1', 'Use 1 day before?');
const q = P.due()[0];
assert.equal(q.question, 'Use 1 day before?');
assert.deepEqual(q.choices.map(c => c.value), ['d1', null]);
P.answer('remind', null);
assert.equal(P.due().length, 0, 'No keeps it as is, and is not asked again soon');

// Rhythm: 07:00 until five days are known, then a little before the usual first look.
assert.equal(R.learned({ a: 470, b: 480 }), null);
assert.equal(R.learned({ a: 455, b: 470, c: 480, d: 490, e: 900 }), null, 'an afternoon start does not count, so four mornings are not enough');
assert.equal(R.learned({ a: 455, b: 470, c: 480, d: 490, e: 495 }), '07:30');
console.log('pref-asks: defaults, taps, sentences, learning, rhythm passed');
