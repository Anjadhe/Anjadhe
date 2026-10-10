#!/usr/bin/env node
/** Failures are quiet (docs/ROUTINES_UX.md I7): RoutineFailures' pure core. */
const assert = require('assert');
const F = require('../js/core/routine-failures.js');

const H = 3600000;
const t0 = Date.parse('2026-10-08T15:00:00Z');

// causes are facts about the error
assert.equal(F.causeOf('connect ECONNREFUSED 100.109.184.76:8080'), 'model');
assert.equal(F.causeOf("You've used this month's nenva cloud allowance on the Plus plan."), 'model');
assert.equal(F.causeOf('No response from model'), 'model');
assert.equal(F.causeOf('The model wrote its research plan instead of the answer'), 'routine');

// a record counts from the first failure since the last good run
let f = F.next(null, 'HTTP 403', t0);
assert.deepEqual([f.count, f.since, f.cause], [1, new Date(t0).toISOString(), 'routine']);
f = F.next(f, 'HTTP 403', t0 + 2 * H);
assert.equal(f.count, 2);
assert.equal(f.since, new Date(t0).toISOString(), 'since stays at the first failure');

// stuck: three in a row, or two a day apart; one is never stuck
assert.equal(F.stuck(F.next(null, 'x', t0), t0 + 48 * H), false, 'one failure is quiet');
assert.equal(F.stuck(f, t0 + 3 * H), false, 'two failures within hours are quiet');
assert.equal(F.stuck(f, t0 + 21 * H), true, 'two failures a day apart are stuck');
assert.equal(F.stuck(F.next(f, 'x', t0 + 3 * H), t0 + 3 * H), true, 'three in a row are stuck');

const titles = { a: 'Visa bulletin', b: 'Quantum roundup', c: 'Strategy review' };
const titleOf = id => titles[id] || null;

// one failure each: nothing on Now
assert.deepEqual(F.cards({ a: F.next(null, 'HTTP 403', t0) }, titleOf, t0 + H), []);

// the model is the cause for two routines: ONE card, about the model
const down = 'connect ECONNREFUSED 100.109.184.76:8080';
let fails = { a: F.next(F.next(null, down, t0), down, t0 + H), b: F.next(null, down, t0 + H) };
let cards = F.cards(fails, titleOf, t0 + 2 * H);
assert.equal(cards.length, 1);
assert.equal(cards[0].thing, 'routines:model');
assert.equal(cards[0].title, 'Your routines can’t reach the model');
assert.match(cards[0].body, /^2 routines haven’t run since .*ECONNREFUSED/);
assert.equal(cards[0].model, true);

// one routine on the model: still the model card, named
fails = { a: F.next(F.next(F.next(null, down, t0), down, t0 + H), down, t0 + 2 * H) };
cards = F.cards(fails, titleOf, t0 + 2 * H);
assert.equal(cards[0].title, '“Visa bulletin” can’t reach the model');

// a routine's own failure, stuck: one card for that routine
fails = { c: F.next(F.next(F.next(null, 'HTTP 403', t0), 'HTTP 403', t0 + 24 * H), 'HTTP 403', t0 + 48 * H) };
cards = F.cards(fails, titleOf, t0 + 48 * H);
assert.deepEqual(cards.map(c => [c.thing, c.title, c.routineId]), [['routine:c', '“Strategy review” keeps failing', 'c']]);

// a deleted routine speaks for nothing
assert.deepEqual(F.cards({ gone: F.next(F.next(F.next(null, 'x', t0), 'x', t0), 'x', t0) }, titleOf, t0), []);

console.log('routine-failures: causes, streaks and Now cards passed');
