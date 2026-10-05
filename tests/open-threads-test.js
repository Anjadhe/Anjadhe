#!/usr/bin/env node
/**
 * OpenThreads' pure core (js/agent/open-threads.js, docs/OPEN_THREADS.md):
 * T1 (code decides when a turn is examined), T2 (quotes verbatim, fixed
 * outcomes, a blocker only when it is true right now), T4 (a plan is a
 * `later` thread and needs the person's words), T5 (identity).
 *
 *   node tests/open-threads-test.js
 */
const OT = require('../js/agent/open-threads.js');

let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const snap = { googleAccounts: 0, mail: false, calendar: false, webSearch: false, vision: true, featuresOff: ['workrooms', 'brokerage'] };
const connected = { googleAccounts: 1, mail: true, calendar: true, webSearch: true, vision: true, featuresOff: [] };

console.log('T1 — when a turn is examined');
check('an ordinary answered turn is not', OT.signals({ userText: 'what is 2+2', answerText: 'It is 4.', toolLog: [] }).length === 0);
check('a failed tool is a sign', OT.signals({ userText: 'x', answerText: 'Here you go', toolLog: [{ tool: 'search_emails', ok: false, error: 'Not authenticated' }] }).length === 1);
check('"I can\'t" in the answer is a sign', OT.signals({ userText: 'read my mail', answerText: "I can't read your email because Gmail isn't connected." }).length >= 1);
check('"isn\'t connected" alone is a sign', OT.signals({ userText: 'x', answerText: 'Your calendar is not connected yet.' }).length === 1);
check('a plan for later is a sign', OT.signals({ userText: "I'll decide on the flights next week", answerText: 'Sounds good.' }).length === 1);
check('a tool-budget stop is a sign', OT.signals({ userText: 'x', answerText: 'y', toolLimit: true }).length === 1);
check('an errored turn is a sign', OT.signals({ userText: 'x', answerText: '', isError: true }).length === 1);

console.log('T2 — the model proposes, code decides');
const user = 'Can you check my Chase statement and tell me what I spent on dining?';
let t = OT.validate({ thread: { outcome: 'couldnt', asked: 'check my Chase statement', summary: 'Dining spend from the Chase statement', blocker: 'no_mail', feature: null, next: null } }, { userText: user, snapshot: snap });
check('a valid thread passes', t && t.outcome === 'couldnt' && t.blocker === 'no_mail', JSON.stringify(t));
t = OT.validate({ thread: { outcome: 'couldnt', asked: 'check my bank account', summary: 's', blocker: null } }, { userText: user, snapshot: snap });
check('an "asked" not in the person\'s words is dropped', t === null);
t = OT.validate({ thread: { outcome: 'failed', asked: 'check my Chase statement', summary: 's' } }, { userText: user, snapshot: snap });
check('an outcome off the list is dropped', t === null);
t = OT.validate({ thread: { outcome: 'couldnt', asked: 'check my Chase statement', summary: '' } }, { userText: user, snapshot: snap });
check('no summary is dropped', t === null);
t = OT.validate({ thread: { outcome: 'couldnt', asked: 'check my Chase statement', summary: 'open', blocker: 'no_mail' } }, { userText: user, snapshot: connected });
check('a blocker that is NOT true right now is removed (thread kept)', t && t.blocker === null);
t = OT.validate({ thread: { outcome: 'couldnt', asked: 'check my Chase statement', summary: 'open', blocker: 'no_wifi' } }, { userText: user, snapshot: snap });
check('a blocker off the list is removed', t && t.blocker === null);
t = OT.validate({ thread: { outcome: 'couldnt', asked: 'check my Chase statement', summary: 'open', blocker: 'feature_off', feature: 'brokerage' } }, { userText: user, snapshot: snap });
check('feature_off with a flag that is off is kept', t && t.blocker === 'feature_off' && t.feature === 'brokerage');
t = OT.validate({ thread: { outcome: 'couldnt', asked: 'check my Chase statement', summary: 'open', blocker: 'feature_off', feature: 'proactive' } }, { userText: user, snapshot: snap });
check('feature_off naming a flag a person cannot toggle is removed', t && t.blocker === null);
t = OT.validate({ thread: { outcome: 'couldnt', asked: 'Check my CHASE   statement', summary: 'open' } }, { userText: user, snapshot: snap });
check('the quote check ignores case and spacing', !!t);
t = OT.validate({ outcome: 'partly', asked: 'check my Chase statement', summary: 'open' }, { userText: user, snapshot: snap });
check('a bare thread object (no wrapper) is read too', !!t);
check('{"thread": null} is null', OT.validate({ thread: null }, { userText: user, snapshot: snap }) === null);
check('garbage is null', OT.validate('nope', { userText: user, snapshot: snap }) === null);

console.log('T4 — a plan is "later", in the person\'s words');
const plan = "Thanks. I'll decide on the Austin flights next week once I know the dates.";
t = OT.validate({ thread: { outcome: 'later', asked: 'decide on the Austin flights', summary: 'Choose Austin flights', next: { quote: "I'll decide on the Austin flights next week", when: 'next week' } } }, { userText: plan, snapshot: snap });
check('a later thread with the plan quoted passes', t && t.next && t.next.when === 'next week', JSON.stringify(t));
t = OT.validate({ thread: { outcome: 'later', asked: 'decide on the Austin flights', summary: 'Choose flights', next: null } }, { userText: plan, snapshot: snap });
check('a later thread without the plan is dropped', t === null);
t = OT.validate({ thread: { outcome: 'later', asked: 'decide on the Austin flights', summary: 'Choose flights', next: { quote: 'book them on Friday', when: 'Friday' } } }, { userText: plan, snapshot: snap });
check('a plan not in the person\'s words is dropped', t === null);

console.log('T5 — identity, and blockers checked later');
check('identity is conversation + message index', OT.identity('c1', 7) === 'c1:7');
const thread = { blocker: 'no_web_search' };
check('blocker holds while web search is off', OT.blockerHolds(thread, snap) === true);
check('blocker gone once web search is on → can do it now', OT.blockerHolds(thread, connected) === false);
check('no blocker never holds', OT.blockerHolds({ blocker: null }, snap) === false);

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nAll checks passed');
