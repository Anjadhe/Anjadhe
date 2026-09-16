#!/usr/bin/env node
/**
 * PromptSuggestions — the pure half of the hourly "Try asking…" writer
 * (js/agent/prompt-suggestions.js): the fact sheet the model may cite, the
 * reply validator, the due-now decision and the per-surface rotation.
 *
 *   node tests/prompt-suggestions-test.js
 */

const PS = require('../js/agent/prompt-suggestions.js');

let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── factSheet ────────────────────────────────────────────────────────────
const inputs = {
    hour: 8, daypart: 'morning', weekday: 'Thursday',
    brain: 'Gemma 3 12B', brainLeaves: false, webOn: true, voiceOn: false, googleMail: true,
    apps: ['Tasks', 'Notes', 'Portfolio'], frequent: ['Tasks (41×)', 'Notes (12×)'],
    setupPending: ['Study your writing voice'],
    tasks: { overdue: 2, today: 3, doneToday: 1, open: 14, todayTitles: ['Call the dentist', 'Ship the invoice', 'Book flights to Seattle', 'Fourth', 'Fifth'], overdueTitles: ['Renew passport'] },
    goals: { active: 2, titles: ['Launch the newsletter', 'Learn Spanish'], dueSoon: ['Launch the newsletter'] },
    calendar: { today: 2, tomorrow: 1, next: ['Standup', 'Dentist'] },
    email: { connected: true, unreadInsights: 4, folders: ['bill', 'reservation'] },
    notes: { count: 30, recent: ['Q4 plan', 'Reading list'] },
    routines: 2, documents: 12,
    journal: { count: 5, lastDaysAgo: 3 },
    portfolio: { holdings: 9, top: ['NVDA', 'VOO', 'AAPL'], dayDirection: 'up', watchlist: 4 },
    spending: { monthSpend: 2340.5, topCategory: 'Food and drink', dueSoon: 2 },
    recentChats: ['Plan the Seattle trip', 'Draft the invoice email'],
    shown: ['What should I focus on today?']
};
const sheet = PS.factSheet(inputs);
check('sheet: time line first', /^Time: Thursday morning \(8:00\)\./.test(sheet.text));
check('sheet: tasks line with counts and titles', /Tasks: 2 overdue, 3 due today, 1 done today, 14 open in all\. Today: "Call the dentist", "Ship the invoice", "Book flights to Seattle", "Fourth"\. Overdue: "Renew passport"\./.test(sheet.text), sheet.text);
check('sheet: caps titles at four', !sheet.text.includes('"Fifth"'));
check('sheet: projects with target date', /Projects: 2 active — "Launch the newsletter", "Learn Spanish"; target date within two weeks: "Launch the newsletter"\./.test(sheet.text));
check('sheet: calendar', /Calendar: 2 events today — "Standup", "Dentist"; 1 tomorrow\./.test(sheet.text));
check('sheet: email folders', /Email insights waiting: 4 \(bill, reservation\)\./.test(sheet.text));
check('sheet: spending', /Spending this month: \$2,341, mostly Food and drink; 2 recurring charges due within ten days\./.test(sheet.text));
check('sheet: portfolio', /Portfolio: 9 holdings \(largest: NVDA, VOO, AAPL\); up today; 4 on the watchlist\./.test(sheet.text));
check('sheet: journal days ago', /Journal: 5 entries; last one 3 days ago\./.test(sheet.text));
check('sheet: setup pending', /Setup not finished: Study your writing voice\./.test(sheet.text));
check('sheet: already suggested', /Already suggested last time \(do not repeat\): "What should I focus on today\?"\./.test(sheet.text));
check('sheet: hash is 8 hex', /^[0-9a-f]{8}$/.test(sheet.hash));

const later = PS.factSheet({ ...inputs, hour: 9, daypart: 'morning', shown: [] });
check('hash: ignores the hour and the shown line', later.hash === sheet.hash);
const changed = PS.factSheet({ ...inputs, tasks: { ...inputs.tasks, overdue: 3 } });
check('hash: changes with the data', changed.hash !== sheet.hash);

const empty = PS.factSheet({});
check('sheet: empty inputs still name the time and say none yet', /Time: a weekday daytime\./.test(empty.text) && /Tasks: none yet\./.test(empty.text) && /Projects: none yet\./.test(empty.text));
check('sheet: nothing gated appears when absent', !/Notes:|Journal:|Portfolio:|Spending/.test(empty.text));

// ── parseReply ───────────────────────────────────────────────────────────
const good = PS.parseReply('{"prompts":["What is overdue and what can wait?","Plan my morning around the standup","Draft the invoice email for me","Summarise the 4 bills waiting in email","Start a journal entry for Thursday","Show how the newsletter project is going"]}');
check('parse: six from a JSON object', good.length === 6, JSON.stringify(good));
check('parse: keeps order', good[0] === 'What is overdue and what can wait?');

const fenced = PS.parseReply('Sure, here you go:\n```json\n["Show me today\'s tasks", "What did I spend on food this month?", "Review my overdue work"]\n```');
check('parse: fenced bare array', fenced.length === 3, JSON.stringify(fenced));

const lines = PS.parseReply('1. "What should I do first today?"\n2. Draft a note about the Q4 plan\n- Which recurring charges are due soon?\n');
check('parse: numbered lines without JSON', lines.length === 3 && lines[0] === 'What should I do first today?' && lines[1] === 'Draft a note about the Q4 plan', JSON.stringify(lines));

const messy = PS.parseReply(JSON.stringify({ prompts: [
    'What is overdue?', 'what is overdue?', '   ', 'Go', 'See https://example.com for more',
    'Here are the prompts you asked for', 'This one is a paragraph. It has two sentences. And a third.',
    'A'.repeat(90), { text: 'Draft the invoice email' }, 'Plan the Seattle trip'
] }));
check('parse: dedupes, drops short, links, preambles, paragraphs and overlong', messy.length === 3 && messy.join('|') === 'What is overdue?|Draft the invoice email|Plan the Seattle trip', JSON.stringify(messy));

const dotted = PS.parseReply('["Help me renew my passport today.", "What should I journal about?", "Draft a note for the launch."]');
check('parse: strips a trailing period', dotted.join('|') === 'Help me renew my passport today|What should I journal about?|Draft a note for the launch', JSON.stringify(dotted));

check('parse: fewer than three is nothing', PS.parseReply('["Only one prompt here"]').length === 0);
check('parse: garbage is nothing', PS.parseReply('I cannot help with that.').length === 0);
check('parse: caps at eight', PS.parseReply(JSON.stringify(Array.from({ length: 12 }, (_, i) => `Prompt number ${i} for today?`))).length === 8);

// ── due ──────────────────────────────────────────────────────────────────
const H = 3600000, now = 10 * H;
check('due: nothing cached yet', PS.due({ items: [] }, 'a', now, H) === true);
check('due: a failed run waits one ttl', PS.due({ items: [], failedAt: now - H / 2 }, 'a', now, H) === false);
check('due: fresh set, same sheet', PS.due({ items: ['x'], at: now - H / 2, hash: 'a' }, 'a', now, H) === false);
check('due: fresh set, changed sheet still waits the ttl', PS.due({ items: ['x'], at: now - H / 2, hash: 'a' }, 'b', now, H) === false);
check('due: old enough and changed', PS.due({ items: ['x'], at: now - 2 * H, hash: 'a' }, 'b', now, H) === true);
check('due: old enough, unchanged, under a day', PS.due({ items: ['x'], at: now - 5 * H, hash: 'a' }, 'a', now, H) === false);
check('due: a day old regenerates regardless', PS.due({ items: ['x'], at: now - 25 * H, hash: 'a' }, 'a', now + 20 * H, H) === true);
check('due: force', PS.due({ items: ['x'], at: now, hash: 'a' }, 'a', now, H, { force: true }) === true);
check('due: metered ttl respected', PS.due({ items: ['x'], at: now - 2 * H, hash: 'a' }, 'b', now, 6 * H) === false);

// ── pick ─────────────────────────────────────────────────────────────────
const set = ['a', 'b', 'c', 'd', 'e'];
const t0 = 5 * H;
check('pick: rotates by hour', PS.pick(set, 3, { now: t0 }).join('') === 'abc' && PS.pick(set, 3, { now: t0 + H }).join('') === 'bcd');
check('pick: surface offset', PS.pick(set, 3, { now: t0, offset: 3 }).join('') === 'dea');
check('pick: never more than the set', PS.pick(['a', 'b'], 4, { now: t0 }).length === 2);
check('pick: empty', PS.pick([], 3).length === 0);

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nALL PROMPT SUGGESTION CHECKS PASSED');
