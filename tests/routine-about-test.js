#!/usr/bin/env node
/**
 * What a routine is ABOUT — js/apps/prompts/routine-about.js.
 *
 * A routine had no reference to any record; the two review kinds faked one
 * with their TITLE. What is pinned here is the part that has to be exactly
 * right for a reference to be worth more than the convention it replaces:
 * what gets STORED (normalize) and how a record's absence is read
 * (resolve's tri-state), because a reference that resolves wrongly is worse
 * than no reference at all.
 *
 *   node tests/routine-about-test.js
 */

const RoutineAbout = require('../js/apps/prompts/routine-about.js');

let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── what gets stored ──
console.log('what is stored');
const known = (t) => ['goal', 'strategy', 'ticker', 'account'].includes(t);
const n = (a) => RoutineAbout.normalize(a, known);

check('a reference', JSON.stringify(n([{ type: 'goal', id: 'g1' }])) === '[{"type":"goal","id":"g1"}]');
check('several', n([{ type: 'goal', id: 'g1' }, { type: 'ticker', id: 'AAPL' }]).length === 2);
check('the type is lowercased', n([{ type: 'Goal', id: 'g1' }])[0].type === 'goal');
check('whitespace is trimmed', n([{ type: ' goal ', id: ' g1 ' }])[0].id === 'g1');
// An invented type is the model's most likely mistake, and a stored
// reference that can never resolve is worse than none.
check('an unknown type is dropped', n([{ type: 'spaceship', id: 'x' }]).length === 0);
check('a missing id is dropped', n([{ type: 'goal' }]).length === 0);
check('a missing type is dropped', n([{ id: 'g1' }]).length === 0);
check('junk is dropped', n(['goal:g1', null, 42, {}]).length === 0);
check('not an array is nothing', n(null).length === 0 && n('goal:g1').length === 0);
check('the same record twice is once', n([{ type: 'goal', id: 'g1' }, { type: 'goal', id: 'g1' }]).length === 1);
check('the same id under two types is two', n([{ type: 'goal', id: 'x' }, { type: 'ticker', id: 'x' }]).length === 2);
check('capped at MAX', n(Array.from({ length: 12 }, (_, i) => ({ type: 'goal', id: 'g' + i }))).length === RoutineAbout.MAX);

console.log('the keys other stores speak');
check('type:id, the decision-key form',
    JSON.stringify(RoutineAbout.keys([{ type: 'goal', id: 'g1' }, { type: 'ticker', id: 'AAPL' }]))
        === '["goal:g1","ticker:AAPL"]');

// ── how absence is read ──
// A2: `ids()` is tri-state. A Set says these are the live ids; null says
// "not knowable right now" and NEVER means deleted — a record whose app has
// not loaded is not a deleted record. This is DecisionStore.pruneOrphans'
// rule, and getting it wrong would strike through live records.
console.log('existence is tri-state');
global.RecordTypes = {
    _t: {
        goal: { label: 'Project', ids: () => new Set(['g1']), resolve: ({ id }) => (id === 'g1' ? { id, title: 'Ship v2' } : null),
                recordKey: (id) => `goals:${id}`, open() {} },
        ticker: { label: 'Ticker', ids: () => null, resolve: () => null, recordKey: (id) => `portfolio:ticker:${id}`, open() {} }
    },
    get(t) { return this._t[t] || null; }
};
const r = (a) => RoutineAbout.resolve(a);

check('a live record resolves to its title', r([{ type: 'goal', id: 'g1' }])[0].label === 'Ship v2');
check('and is known to exist', r([{ type: 'goal', id: 'g1' }])[0].exists === true);
check('a record its app says is gone reads as gone', r([{ type: 'goal', id: 'nope' }])[0].exists === false);
check('a record its app cannot speak for is UNKNOWN, not gone',
    r([{ type: 'ticker', id: 'AAPL' }])[0].exists === null);
check('an unknowable record still names its type',
    r([{ type: 'ticker', id: 'AAPL' }])[0].typeLabel === 'Ticker');
// An unresolved reference gets NO label rather than the type name echoed
// back: "Project · Project (deleted)" read as the record being called
// Project. The surface says what it knows instead.
check('and carries no invented label', r([{ type: 'ticker', id: 'AAPL' }])[0].label === '');
// A3: nothing caches a title, so a rename needs no sync path.
check('the label comes from the record, never from storage',
    r([{ type: 'goal', id: 'g1' }])[0].label === RecordTypes.get('goal').resolve({ id: 'g1' }).title);

// A resolver that throws tells us nothing — it must not read as deleted.
RecordTypes._t.goal.resolve = () => { throw new Error('boom'); };
RecordTypes._t.goal.ids = () => { throw new Error('boom'); };
check('a throwing record type is unknown, not gone', r([{ type: 'goal', id: 'g1' }])[0].exists === null);
check('and still names its type', r([{ type: 'goal', id: 'g1' }])[0].typeLabel === 'Project');

console.log(failures ? `\n${failures} failing` : '\nall good');
process.exit(failures ? 1 : 0);
