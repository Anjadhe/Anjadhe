#!/usr/bin/env node
/**
 * Silence — docs/ROUTINES_UX.md U3: "a run may say nothing, and saying
 * nothing posts nothing."
 *
 * Two pure halves are pinned here, and both are load-bearing in the same
 * direction: a FALSE POSITIVE eats a real digest. `readQuiet` therefore has
 * to be strict about what counts as the token and nothing else, and the
 * ledger has to keep enough quiet runs that "quiet" can never be mistaken
 * for "never ran" on the routine's page.
 *
 *   node tests/routine-quiet-test.js
 */

const PromptFeed = require('../js/apps/prompts/prompt-feed.js');
const RoutineEngine = require('../js/agent/routine-engine.js');

let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── what counts as silence ──
console.log('the token, and nothing but the token');
const quiet = (s) => PromptFeed.readQuiet(s);

check('the bare token', !!quiet('NOTHING_NEW'));
check('with whitespace around it', !!quiet('  NOTHING_NEW\n'));
check('bolded, as a small model writes it', !!quiet('**NOTHING_NEW**'));
check('in backticks', !!quiet('`NOTHING_NEW`'));
check('in a code fence', !!quiet('```\nNOTHING_NEW\n```'));
check('lower case', !!quiet('nothing_new'));
check('quoted', !!quiet('"NOTHING_NEW"'));

console.log('a reason may ride along on the same line');
check('after an em dash', quiet('NOTHING_NEW — no new invoices since Tuesday')?.reason === 'no new invoices since Tuesday');
check('after a colon', quiet('NOTHING_NEW: quiet week.')?.reason === 'quiet week');
check('through the closing emphasis', quiet('**NOTHING_NEW** — nothing moved')?.reason === 'nothing moved');
check('the bare token has an empty reason', quiet('NOTHING_NEW').reason === '');

// The strictness IS the feature: every case below must POST.
console.log('everything else posts');
check('an ordinary answer', quiet('Here are your three headlines.') === null);
check('the token then prose on a new line', quiet('NOTHING_NEW\nActually, here is the digest.') === null);
check('the token mentioned mid-sentence', quiet('Your NOTHING_NEW flag was not needed; here are 3 items.') === null);
check('the token then a long essay on one line', quiet('NOTHING_NEW ' + 'x'.repeat(PromptFeed.QUIET_REASON_MAX + 1)) === null);
check('a word that merely starts with it', quiet('NOTHING_NEWSLETTER arrived today') === null);
check('empty content is not silence (it is an error)', quiet('') === null && quiet(null) === null);
check('a digest that says it has nothing, in prose, still posts',
    quiet('There is nothing new to report today.') === null);

// The token last, with the reason before it — the shape the live brain
// actually produced once it understood silence ("Nothing from the landlord
// about a rent increase. NOTHING_NEW"). LENGTH is what keeps this safe.
console.log('the token may come last');
check('prose then the token',
    quiet('Nothing from the landlord about a rent increase. NOTHING_NEW')?.reason
        === 'Nothing from the landlord about a rent increase');
check('a long answer that ends with the token still posts',
    quiet('Here are your three headlines: ' + 'a'.repeat(300) + ' NOTHING_NEW') === null);
check('prose, a line break, then the token posts (one line only)',
    quiet('Nothing found.\nNOTHING_NEW') === null);
check('the token buried mid-answer posts',
    quiet('I found NOTHING_NEW in the mail, so here is what I did look at instead, at length.') === null);

// ── the clause the model is given ──
console.log('the clause names the token it will be parsed by');
check('the clause contains the token', PromptFeed.quietClause().includes(PromptFeed.QUIET_TOKEN));
check('the clause forbids using it to dodge a question',
    /never use it to avoid/i.test(PromptFeed.quietClause()));
// Both sentences were added because a live run failed without them: the
// override loses to "write a complete answer", and the watch-routine line
// is the case that actually occurs.
check('the clause overrides the write-a-complete-answer instruction',
    /overrides any instruction/i.test(PromptFeed.quietClause()));
check('the clause names the watch-routine case',
    /watches for something and finds no match/i.test(PromptFeed.quietClause()));

// ── silence as a verb ──
console.log('the report_nothing tool');
const tool = PromptFeed.QUIET_TOOL;
check('is a function definition named report_nothing', tool?.function?.name === 'report_nothing');
check('takes an optional reason only',
    !!tool.function.parameters.properties.reason && !(tool.function.parameters.required || []).length);
check('tells the model calling it IS the answer',
    /calling this IS the answer/i.test(tool.function.description));

// ── the repair loop's one pure half (U2) ──
console.log('a rewritten instruction, unwrapped');
const clean = (t) => PromptFeed._cleanRewrite(t);
check('a code fence is stripped', clean('```\nWrite two lines.\n```') === 'Write two lines.');
check('quotes are stripped', clean('"Write two lines."') === 'Write two lines.');
check('a preamble is dropped', clean('Here is the rewritten instruction: Write two lines.') === 'Write two lines.');
check('a label on its own line is dropped', clean('Rewritten instruction:\nWrite two lines.') === 'Write two lines.');
check('an ordinary rewrite is untouched', clean('Write two lines.') === 'Write two lines.');
check('nothing back is nothing', clean('') === '' && clean(null) === '');
// A prompt that begins with a fence reads as a code block for the rest of
// the routine's life, which is why this runs before the body is replaced.
check('the fence never survives', !clean('```text\nDo the thing\n```').includes('`'));

// ── the ledger ──
console.log('the quiet ledger');
RoutineEngine.state = { runs: {}, errors: {}, seen: {}, quiet: {} };
RoutineEngine.save = () => {};   // no StorageManager in Node

for (let i = 0; i < RoutineEngine.QUIET_MAX + 5; i++) RoutineEngine.stampQuiet('r1', 'reason ' + i);
check('capped at QUIET_MAX', RoutineEngine.quietRuns('r1').length === RoutineEngine.QUIET_MAX);
check('newest first', RoutineEngine.quietRuns('r1')[0].reason === 'reason ' + (RoutineEngine.QUIET_MAX + 4));
check('a routine with no quiet runs reads as an empty list',
    Array.isArray(RoutineEngine.quietRuns('nope')) && RoutineEngine.quietRuns('nope').length === 0);

// The streak is arithmetic against the newest POSTED edition, so it can
// never disagree with the history the detail lists beside it.
const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
check('every quiet run counts when nothing has ever posted',
    RoutineEngine.quietStreak('r1', null) === RoutineEngine.QUIET_MAX);
check('a posted edition since then ends the streak',
    RoutineEngine.quietStreak('r1', future) === 0);
check('quiet runs after the last edition are the streak',
    RoutineEngine.quietStreak('r1', past) === RoutineEngine.QUIET_MAX);

// A quiet run is a SUCCESSFUL run: it must not touch the error ledger, and
// `runs` is stamped by the run itself, not by the quiet stamp.
check('stamping quiet writes no error', !Object.keys(RoutineEngine.state.errors).length);
check('stamping quiet does not stamp runs', !Object.keys(RoutineEngine.state.runs).length);
check('statusFor reports the newest quiet stamp',
    !!RoutineEngine.statusFor('r1').lastQuietAt);

// ── the day in one line (P5, U4) ──
// Assembled, never written: the clause rules are the whole guarantee that
// this line cannot say something the editions do not.
console.log('the day in one line');
// `_headlineOf` walks the DOM; the clause logic under test does not. Swap
// it for the identity so the rules below are what is being measured.
PromptFeed._headlineOf = (it) => it.__headline || '';

const DAY = 24 * 60 * 60 * 1000;
const todayISO = (hoursAgo = 1) => new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
// Headlines here are what a real run produces: a short whole statement.
// A one-word stand-in would be dropped by the "say it whole or not at all"
// rule and every ordering test would silently measure nothing.
const post = (promptId, promptTitle, headline, hoursAgo = 1) =>
    ({ id: 'p_' + promptId + '_' + hoursAgo, promptId, promptTitle,
       __headline: headline || 'Something happened', createdAt: todayISO(hoursAgo) });

RoutineEngine.state = { runs: {}, errors: {}, seen: {}, quiet: {} };
// prompt-feed.js reads both of these off the GLOBAL scope, the way every
// renderer module does — a module-local `const` here is invisible to it,
// which is why the quiet half of the line silently produced nothing.
global.RoutineEngine = RoutineEngine;
global.NotePrompts = { list: () => [{ id: 'r-news', title: 'Morning News' }] };

// A clause carries its two halves separately — the row renders the name
// bold and the statement beside it, so the join here is the test's own.
const labels = (items) => PromptFeed._briefClauses(items).map(c => `${c.name} — ${c.text}`);

check('one edition is not a line',
    PromptFeed._briefClauses([post('a', 'Market Review', 'One drop')]).length === 1);
check('two are', labels([post('a', 'Market Review', 'One drop'), post('b', 'Briefing', 'Three things')]).length === 2);
check('a clause is the routine and its own headline',
    labels([post('a', 'Market Review', 'One drop'), post('b', 'Briefing', 'Three things')])[0]
        .includes('Market Review') === true);
check('newest first',
    labels([post('a', 'Older', 'An older thing', 5), post('b', 'Newer', 'A newer thing', 1)])[0].startsWith('Newer'));
check('yesterday is not today',
    PromptFeed._briefClauses([post('a', 'Yesterday', 'Old news', 30), post('b', 'Also yesterday', 'Older news', 26)]).length === 0);
check('one clause per routine, not per edition',
    labels([post('a', 'Market Review', 'The newest one'), post('a', 'Market Review', 'An older one', 4),
            post('b', 'Briefing', 'Three things')]).length === 2);
check('two routines with the same name say it once',
    labels([post('a', 'Morning News', 'One thing'), post('b', 'Morning News', 'Two things'),
            post('c', 'Briefing', 'Three things')]).length === 2);
check('published posts are not "what my routines did"',
    PromptFeed._briefClauses([{ id: 'x', published: true, promptTitle: 'Anjadhe', __headline: 'A published note', createdAt: todayISO() },
                              post('a', 'Market Review', 'One drop')]).length === 1);
check('at most BRIEF_CLAUSES_MAX',
    labels([post('a', 'A', 'One thing'), post('b', 'B', 'Two things'), post('c', 'C', 'Three things'),
            post('d', 'D', 'Four things'), post('e', 'E', 'Five things')]).length === PromptFeed.BRIEF_CLAUSES_MAX);
// Said WHOLE or not at all — the line had become "latest trends in
// consumer… — did not finish · Identify new investment… — One caveat up
// front: this run's live market-news…", which reads as truncated junk.
console.log('no clause is ever truncated');
const noEllipsis = (ls) => ls.every(l => !l.includes('…'));
check('a routine whose NAME is a sentence sits the line out',
    labels([post('a', 'latest trends in consumer focussed private personal assistants', 'Three things happened'),
            post('b', 'Market Review', 'The day: down 0.3%'),
            post('c', 'Briefing', 'Two meetings today')]).length === 2);
check('a headline too long to say whole is dropped with its clause',
    labels([post('a', 'Long one', 'x '.repeat(80)),
            post('b', 'Market Review', 'The day: down 0.3%'),
            post('c', 'Briefing', 'Two meetings today')]).length === 2);
check('nothing in the line is ever elided',
    noEllipsis(labels([post('a', 'Market Review', 'The day: down 0.3%'),
                       post('b', 'Emails from teachers', 'Two came in from teachers today, both already captured as insights.')])));
check('a long sentence is cut at its comma, whole',
    PromptFeed._briefClauses([post('a', 'Emails from teachers', 'Two came in from teachers today, both already captured as insights.'),
                              post('b', 'Market Review', 'The day: down 0.3%')])[0].text
        === 'Two came in from teachers today');
check('a lead-in before a colon is not a headline',
    PromptFeed._briefText("One caveat up front: this run's live market-news feed was unavailable, so there is less here.") === '');
check('two words is a headline', PromptFeed._briefText('Nothing moved.') === 'Nothing moved');
check('one word is not', PromptFeed._briefText('Quiet.') === '');
check('a clause keeps its two halves apart (the row renders them, not a join)',
    (() => {
        const c = PromptFeed._briefClauses([post('a', 'Market Review', 'The day: down 0.3%'),
                                            post('b', 'Briefing', 'Two meetings today')])[0];
        return c.name === 'Market Review' && c.text === 'The day: down 0.3%' && !('label' in c);
    })());

// U3's silences are part of the day — as a clause, never as a card.
RoutineEngine.stampQuiet('r-news', '');
check('a quiet run gets a clause',
    labels([post('a', 'Market Review', 'One drop')]).some(l => /Morning News — nothing to report/.test(l)));
check('and it is not a card (the feed posted nothing for it)',
    PromptFeed._briefClauses([post('a', 'Market Review', 'One drop')]).some(c => c.kind === 'quiet'));
check('a quiet routine with no record left is skipped',
    (() => { RoutineEngine.stampQuiet('r-gone', ''); return !labels([post('a', 'A', 'One thing')]).some(l => /r-gone/.test(l)); })());

// ── the trigger, written (P7, U7) ──
// The model proposes; this decides. Anything the record cannot hold is
// refused outright rather than half-applied — a routine quietly running
// daily when the user said "the first Monday of the month" is the failure
// this whole feature would otherwise introduce.
console.log('a written trigger, checked against what the record can hold');
const T = (j) => PromptFeed._validTrigger(j);
check('a clock schedule', JSON.stringify(T({ type: 'time', interval: 'weekdays', time: '7:00' }))
    === JSON.stringify({ type: 'time', interval: 'weekdays', time: '07:00' }));
check('a single-digit hour is padded', T({ type: 'time', interval: 'daily', time: '7:05' }).time === '07:05');
check('an interval the form does not offer is refused', T({ type: 'time', interval: 'monthly' }) === null);
check('an hourly schedule carries no clock time', T({ type: 'time', interval: 'hourly', time: '09:00' }).time === '');
check('a bad time is dropped, not guessed', T({ type: 'time', interval: 'daily', time: 'morning' }).time === '');
check('a 25th hour is not a time', T({ type: 'time', interval: 'daily', time: '25:00' }).time === '');
check('an email rule with one field', T({ type: 'email', contains: 'invoice' }).contains === 'invoice');
check('an email rule with NO field is refused (the form\'s own rule)', T({ type: 'email' }) === null);
check('a file rule needs a folder', T({ type: 'file', pattern: '*.pdf' }) === null);
check('a file rule with one', T({ type: 'file', folder: '~/Downloads', pattern: '*.pdf' }).folder === '~/Downloads');
check('an unknown type is refused', T({ type: 'cron', expr: '0 7 * * 1' }) === null);
check('nothing is refused', T(null) === null && T('daily') === null);
check('the three types are the form\'s three',
    PromptFeed.TRIGGER_TYPES.length === 3 && PromptFeed.TRIGGER_TYPES.includes('time'));

// ── the detail's ask pills (P4) ──
// They are the door for "make it weekly" / "why does it never find
// anything", and WHICH of them appear is arithmetic over the routine's own
// state — an offer to change something it already does teaches the user it
// does the opposite.
console.log('the pills that offer to change a routine');
global.AppManager = { register() {} };
global.AgentUI = { askWithPrompt() {} };
global.UIUtils = { escapeHtml: (t) => String(t) };
const PromptsApp = require('../js/apps/prompts/prompts-app.js');

const pillsFor = (cfg, streak = 0) => {
    const html = PromptsApp._askPillsHtml({ id: 'r1', title: 'Morning News' }, cfg, streak);
    return [...html.matchAll(/&ldquo;([^&]+)&rdquo;/g)].map(m => m[1]);
};
const daily = { interval: 'daily', trigger: { type: 'time' }, runMode: 'digest', web: false };

check('a daily routine is offered weekly', pillsFor(daily).includes('Make it weekly'));
check('a weekly one is not', !pillsFor({ ...daily, interval: 'weekly' }).includes('Make it weekly'));
check('an email-triggered one is not (there is no schedule to change)',
    !pillsFor({ ...daily, trigger: { type: 'email' } }).includes('Make it weekly'));
// Since U3 every digest already stays quiet on a run with nothing to say.
check('nothing offers to make it quieter',
    !pillsFor(daily).some(p => /only when|quiet|silent/i.test(p)));
check('web search is offered when off', pillsFor(daily).includes('Let it search the web'));
check('and not when already on', !pillsFor({ ...daily, web: true }).includes('Let it search the web'));
check('a routine that acts is not offered web search',
    !pillsFor({ ...daily, runMode: 'task' }).includes('Let it search the web'));
check('a silent streak asks why',
    pillsFor(daily, PromptsApp.QUIET_STREAK_HINT).includes('Why does it never find anything?'));
check('a routine with something to say does not',
    !pillsFor(daily, 1).includes('Why does it never find anything?'));
check('there is always an open-ended one',
    pillsFor(daily).some(p => /Change what it does/.test(p)));
// The pills navigate; they never write (the HelpActions law).
const html = PromptsApp._askPillsHtml({ id: 'r1', title: 'Morning News' }, daily, 0);
check('every pill is a question, not an action', !/onclick|href/i.test(html));

// ── measured by whether it is read (P6, U8) ──
console.log('rarely opened');
// prompts-app.js reaches PromptFeed through the GLOBAL scope too — the
// same trap the brief hit. Without this line every rate reads as 0 of 0
// and "rarely opened" is silently never true.
global.PromptFeed = PromptFeed;
const rarely = (shown, opened) => {
    PromptFeed.readRate = () => ({ shown, opened });
    return PromptsApp._readStats('r1').rarely;
};
check('a routine nobody opens is rarely opened', rarely(10, 1));
check('one nobody opens at all is too', rarely(6, 0));
check('one that gets read is not', !rarely(10, 6));
check('too few editions to judge yet', !rarely(3, 0), 'three runs is not a verdict');
check('exactly at the threshold counts',
    rarely(PromptsApp.RARELY_MIN_EDITIONS, 0));
check('a fifth opened of ten is the line', rarely(10, 2) && !rarely(10, 3));
check('a routine with no editions is not judged', !rarely(0, 0));

console.log(failures ? `\n${failures} failing` : '\nall good');
process.exit(failures ? 1 : 0);
