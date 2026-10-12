#!/usr/bin/env node
/**
 * "Repeat this…" — docs/ROUTINES_UX.md P3, the door routines actually come
 * from (U1's first). What is pinned here is the SHAPE of what gets armed,
 * because this is the one door excused from U2: nothing runs in front of
 * the user before the record is written, so the record had better be the
 * one they asked for.
 *
 *   node tests/routine-from-chat-test.js
 */

const PromptFeed = require('../js/apps/prompts/prompt-feed.js');

let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

// RoutineFromChat reads NotePrompts / RoutineEngine off the global scope,
// the way every renderer module does. Stub the two it writes through.
const created = [];
global.NotePrompts = {
    DEFAULTS: { target: 'assistant', offline: false, runMode: 'digest', interval: 'daily', web: false, useContext: false },
    create(rec) { created.push(rec); return { id: 'note_' + created.length, ...rec }; }
};
global.RoutineEngine = { _machineId: 'mac-under-test', onRoutinesChanged() { this.nudged = true; } };
global.window = undefined;

const RoutineFromChat = require('../js/apps/prompts/routine-from-chat.js');

// ── the name it falls back to ──
console.log('a name when the model gives none');
check('four words of the question', RoutineFromChat._titleFrom('How did my day go, honestly?') === 'How did my day');
check('trailing punctuation goes', !/[?.!]$/.test(RoutineFromChat._titleFrom('How did my day go?')));
check('nothing at all still names it', RoutineFromChat._titleFrom('') === 'New routine');

// ── what gets armed ──
console.log('the record this door writes');
const made = RoutineFromChat.arm({ title: 'Daily recap', body: 'Walk through my tasks.', interval: 'daily', time: '08:00' });
const cfg = created[0].config;
check('a routine was created', !!made && created.length === 1);
check('it is armed', cfg.offline === true);
// The single most important line in this file: a routine born from a chat
// ANSWER writes an answer. Arming an acting run from a button that never
// showed what it would do would walk around every consent law at once.
check('it WRITES, never acts', cfg.runMode === 'digest');
check('it carries the user context the chat had', cfg.useContext === true);
check('it does not quietly turn on web search', cfg.web === false);
check('it is a time trigger', cfg.trigger.type === 'time' && cfg.trigger.interval === 'daily');
check('the time rides along', cfg.time === '08:00');
check('it is pinned to this Mac', cfg.homeMachineId === 'mac-under-test');
check('the scheduler was nudged', RoutineEngine.nudged === true);

const hourly = RoutineFromChat.arm({ title: 'Hourly', body: 'Check things.', interval: 'hourly', time: '08:00' });
check('a non-clock interval carries no time', created[1].config.time === null, JSON.stringify(created[1].config.time));

const unnamed = RoutineFromChat.arm({ title: '', body: 'Do the thing.', interval: 'weekly', time: '' });
check('an empty name still becomes a routine', !!unnamed && created[2].title === 'New routine');
check('a weekly with no time falls back to the default', created[2].config.time === RoutineFromChat.DEFAULT_TIME);

// ── the cadence vocabulary ──
console.log('the cadence the model may suggest');
check('it is a fixed list', Array.isArray(PromptFeed.QUIET_INTERVALS) && PromptFeed.QUIET_INTERVALS.length === 5);
check('every value the sheet offers is in it',
    RoutineFromChat.INTERVALS.every(([v]) => PromptFeed.QUIET_INTERVALS.includes(v)));

console.log(failures ? `\n${failures} failing` : '\nall good');
process.exit(failures ? 1 : 0);
