#!/usr/bin/env node
/**
 * A routine keeps its newest MAX_PER_PROMPT runs (NotePrompts.pruneRuns,
 * which PromptFeed._prune wraps). "Newest" is by the run's own stamp, never
 * by array position, and a dropped run leaves its message key behind
 * (`removed`) so a stale copy of the chat cannot bring it back through the
 * record merge's message union. What the person or the assistant SAID in
 * the chat is never pruned (2026-10-07: a run is a message in the routine's
 * Standing chat).
 *
 *   node tests/routine-feed-prune-test.js
 */

const NotePrompts = require('../js/apps/notes/note-prompts.js');
globalThis.NotePrompts = NotePrompts;   // a global in the app (script tags)
const PromptFeed = require('../js/apps/prompts/prompt-feed.js');

let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

const MAX = PromptFeed.MAX_PER_PROMPT;
check('the feed cap IS the facade cap', MAX === NotePrompts.RUN_KEEP);
const day = (d) => new Date(Date.UTC(2026, 8, 1 + d, 14)).toISOString();
const run = (d, extra = {}) => ({ role: 'assistant', content: `Edition ${d}`, timestamp: day(d),
    metadata: { model: 'nenva cloud lite', routineRun: { id: `p${d}`, at: day(d), error: null, readAt: null } }, ...extra });

// Oldest-first, as the store hands it back, plus today's run on the end;
// the person's own turns sit among them.
const said = [{ role: 'user', content: 'make it shorter', timestamp: day(3) }, { role: 'assistant', content: 'Done — shorter from now on.', timestamp: day(3), metadata: {} }];
const messages = [...Array.from({ length: MAX }, (_, i) => run(i)), ...said, run(MAX)];

const out = NotePrompts.pruneRuns(messages);
const kept = new Set(out.messages.filter(NotePrompts.isRun.bind(NotePrompts)).map(m => m.metadata.routineRun.id));
check('today\'s run is kept', kept.has(`p${MAX}`));
check('yesterday\'s run is kept', kept.has(`p${MAX - 1}`));
check('the oldest run is the one dropped', !kept.has('p0'));
check('exactly MAX runs remain', kept.size === MAX);
check('what was said in the chat is untouched', said.every(m => out.messages.includes(m)));
check('the dropped run leaves its key', out.removed.length === 1 && out.removed[0].startsWith('assistant\u0000Edition 0'));

// Newest-first input gives the same answer.
const rev = NotePrompts.pruneRuns([...messages].reverse());
const keptRev = new Set(rev.messages.filter(NotePrompts.isRun.bind(NotePrompts)).map(m => m.metadata.routineRun.id));
check('order of the array does not matter', [...kept].every(id => keptRev.has(id)) && kept.size === keptRev.size);

// Under the cap nothing is dropped, and nothing is reported removed.
const under = NotePrompts.pruneRuns(messages.slice(0, MAX));
check('under the cap, nothing is dropped', under.messages.length === MAX && under.removed.length === 0);

// PromptFeed._prune is the same rule.
check('PromptFeed._prune wraps it', PromptFeed._prune(messages).length === out.messages.length);

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nroutine feed prune: all passed');
