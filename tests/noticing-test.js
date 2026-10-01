#!/usr/bin/env node
/**
 * Noticing P0's pure core (js/core/noticing.js, docs/NOTICING.md).
 *
 * Most of these assert SILENCE, which is the opposite of every other test in
 * this repo and the whole point of the feature: a noticing pass that says
 * something about an ordinary week is worse than one that says nothing.
 *
 *   node tests/noticing-test.js
 */

const N = require('../js/core/noticing.js');

let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-12T18:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

// ── the shortlist gate ──
console.log('what is worth a call');
check('"I miss my puppy" is a thought', N.substantial('I miss my puppy'));
check('"ok" is not', !N.substantial('ok'));
check('"test test" is not (two words)', !N.substantial('test test'));
check('empty is not', !N.substantial('') && !N.substantial(null));
check('html becomes text, paragraphs stay apart',
    N.plainText('<p>I miss my puppy.</p><p>She would be three.</p>')
    === 'I miss my puppy.\n\nShe would be three.');
check('a run of breaks does not become a wall of blank lines',
    N.plainText('<p>a</p><br><br><br><p>b</p>') === 'a\n\nb');
check('entities come back', N.plainText('<p>Sam &amp; I talked</p>') === 'Sam & I talked');

// ── identity, never a timestamp (T1/T4) ──
console.log('identity');
check('same entry, same text, same identity',
    N.identity('journal', 'e1', 'I miss my puppy') === N.identity('journal', 'e1', 'I miss my puppy'));
check('edited text is a new thing',
    N.identity('journal', 'e1', 'I miss my puppy') !== N.identity('journal', 'e1', 'I miss my puppy a lot'));
check('same words in another entry are another thing',
    N.identity('journal', 'e1', 'same') !== N.identity('journal', 'e2', 'same'));

// ── when an entry is ready (N2, T3) ──
console.log('settling');
const entry = (text, editedMsAgo) => ({ text, modifiedAt: iso(NOW - editedMsAgo) });
check('a finished entry is due', N.dueState(entry('I miss my puppy', 2 * HOUR), NOW, { floorMs: NOW - DAY }) === 'due');
check('still being written is not (N2)',
    N.dueState(entry('I miss my puppy', 30 * 1000), NOW, { floorMs: NOW - DAY }) === 'unsettled');
check('one minute old is not', N.dueState(entry('I miss my puppy', MIN), NOW, { floorMs: NOW - DAY }) === 'unsettled');
check('written before the feature was armed is never a candidate (T3)',
    N.dueState(entry('I miss my puppy', 2 * HOUR), NOW, { floorMs: NOW - HOUR }) === 'before-floor');
check('older than the horizon is stale',
    N.dueState(entry('I miss my puppy', 30 * DAY), NOW, { floorMs: 0 }) === 'stale');
check('a thin entry never gets a call', N.dueState(entry('ok', 2 * HOUR), NOW, { floorMs: 0 }) === 'thin');
check('an undated entry is not guessed at', N.dueState({ text: 'I miss my puppy' }, NOW, {}) === 'undated');

// ── N1: noticed, never inferred ──
console.log('the quote is the anchor (N1)');
const TEXT = 'Long day. I miss my puppy. Went to bed early.';
const ctx = { text: TEXT, source: 'journal', recordId: 'e1', now: NOW, budgeted: true };
{
    const m = N.validate({ moment: { kind: 'Missing Someone', quote: 'I miss my puppy.', confidence: 'high' } }, ctx);
    check('a verbatim quote survives', m && m.quote === 'I miss my puppy.');
    check('kind is slugged to plain words', m.kind === 'missing someone');
    check('confidence rides through', m.confidence === 'high');
    check('state is new and nothing else', m.state === 'new');
    check('it carries a merge stamp (N10)', !!m.updatedAt && !!m.createdAt);
}
check('a quote the entry does not contain is dropped',
    N.validate({ moment: { kind: 'grief', quote: 'I am devastated about the dog.', confidence: 'high' } }, ctx) === null);
check('a paraphrase is not a quote',
    N.validate({ moment: { kind: 'grief', quote: 'I miss my dog.', confidence: 'high' } }, ctx) === null);
check('whitespace differences still match',
    !!N.validate({ moment: { kind: 'missing', quote: '  I miss   my puppy. ', confidence: 'low' } }, ctx));
check('null is a normal answer', N.validate({ moment: null }, ctx) === null);
check('no answer at all is fine', N.validate(null, ctx) === null && N.validate('nope', ctx) === null);
check('a moment with no kind is dropped',
    N.validate({ moment: { kind: '', quote: 'I miss my puppy.', confidence: 'high' } }, ctx) === null);
check('an unknown confidence falls to low',
    N.validate({ moment: { kind: 'missing', quote: 'I miss my puppy.', confidence: 'certain' } }, ctx).confidence === 'low');
check('a quote longer than the cap is dropped',
    N.validate({ moment: { kind: 'x', quote: 'a'.repeat(400), confidence: 'low' } }, ctx) === null);

// ── N7: silence has a budget ──
console.log('the budget (N7)');
const moment = (daysAgo, budgeted = true) => ({ id: 'm' + Math.random(), noticedAt: iso(NOW - daysAgo * DAY), budgeted });
check('an empty week allows one', N.budgeted([], NOW));
check('one this week still allows one', N.budgeted([moment(1)], NOW));
check('two this week is the cap', !N.budgeted([moment(1), moment(3)], NOW));
check('over-budget moments do not themselves count',
    N.budgeted([moment(1), moment(2, false), moment(3, false)], NOW));
check('last week does not count against this one',
    N.budgeted([moment(9), moment(11)], NOW));

// ── the ledger is bounded ──
console.log('bounds');
{
    const many = Array.from({ length: N.MOMENT_MAX + 5 }, (_, i) => ({ id: 'm' + i, noticedAt: iso(NOW - i * HOUR) }));
    const gone = N.overflow(many);
    check('the oldest overflow is named for tombstoning', gone.length === 5);
    check('the newest are kept', !gone.includes('m0') && gone.includes('m' + (N.MOMENT_MAX + 4)));
    check('a small ledger overflows nothing', N.overflow([{ id: 'a', noticedAt: iso(NOW) }]).length === 0);
}

console.log(failures ? `\n${failures} failing` : '\nall good');
process.exit(failures ? 1 : 0);
