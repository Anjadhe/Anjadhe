#!/usr/bin/env node
/**
 * The assistant's own looks — pure core (js/core/proactive.js,
 * docs/PROACTIVE.md). Like noticing-test.js, much of this asserts SILENCE:
 * a nudge about something the person never asked, or a prep for a meeting
 * they declined, is worse than nothing.
 *
 *   node tests/proactive-test.js
 */

const P = require('../js/core/proactive.js');

let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-30T09:00:00');
const ME = 'ram@example.com';

// ── addresses ──
console.log('addresses');
check('a display-name address resolves', P.addr('Sam Lee <Sam@X.com>') === 'sam@x.com');
check('a list splits, quoted commas survive',
    JSON.stringify(P.addrs('"Lee, Sam" <sam@x.com>, b@y.com')) === JSON.stringify(['sam@x.com', 'b@y.com']));
check('a name comes from the display name', P.name('"Sam Lee" <sam@x.com>') === 'Sam Lee');
check('a bare address names its local part', P.name('sam@x.com') === 'sam');
check('no-reply is a machine', P.isMachine('no-reply@x.com') && P.isMachine('notifications@github.com'));
check('a person is not', !P.isMachine('sam@x.com'));

// ── meeting prep ──
console.log('meeting prep');
const ev = (o = {}) => ({
    id: 'e1', account: ME, summary: 'Pricing review', allDay: false, status: 'confirmed',
    start: new Date(NOW + 30 * MIN), end: new Date(NOW + 60 * MIN),
    attendees: [{ email: ME, self: true, responseStatus: 'accepted' }, { email: 'sam@x.com', displayName: 'Sam Lee' }],
    ...o
});
check('a meeting in 30 min with someone is prepped', P.prepCandidates([ev()], NOW).length === 1);
check('one in 10 min is too late to prep', P.prepCandidates([ev({ start: new Date(NOW + 10 * MIN) })], NOW).length === 0);
check('one in 2 hours is not yet', P.prepCandidates([ev({ start: new Date(NOW + 2 * HOUR) })], NOW).length === 0);
check('a block with nobody else is not a meeting',
    P.prepCandidates([ev({ attendees: [{ email: ME, self: true }] })], NOW).length === 0);
check('a room is not a person',
    P.prepCandidates([ev({ attendees: [{ email: ME, self: true }, { email: 'room@x.com', resource: true }] })], NOW).length === 0);
check('a declined meeting is never prepped',
    P.prepCandidates([ev({ attendees: [{ email: ME, self: true, responseStatus: 'declined' }, { email: 'sam@x.com' }] })], NOW).length === 0);
check('all-day and cancelled are skipped',
    P.prepCandidates([ev({ allDay: true }), ev({ status: 'cancelled' })], NOW).length === 0);
check('the identity is the event AND its start (each instance once)',
    P.prepIdentity(ev()) !== P.prepIdentity(ev({ start: new Date(NOW + DAY + 30 * MIN) })));

const mail = [
    { messageId: 'm1', account: ME, from: 'Sam Lee <sam@x.com>', to: ME, subject: 'Pricing question', internalDate: String(NOW - 2 * DAY), labels: ['INBOX'] },
    { messageId: 'm2', account: ME, from: 'Sam Lee <sam@x.com>', to: ME, subject: 'Old thing', internalDate: String(NOW - 40 * DAY), labels: ['INBOX'] },
    { messageId: 'm3', account: ME, from: 'Pat <pat@z.com>', to: ME, subject: 'Unrelated', internalDate: String(NOW - DAY), labels: ['INBOX'] }
];
const facts = P.prepFacts(ev(), mail, NOW);
check('facts name the other people', facts.people.length === 1 && facts.people[0].name === 'Sam Lee');
check('the last email with them is found', facts.lastEmail && facts.lastEmail.id === 'm1');
check('mail older than a month does not count',
    P.prepFacts(ev(), [mail[1]], NOW).lastEmail === null);
const notice = P.prepNotice(facts, null, NOW);
check('the notice title says how soon', notice.title === 'In 30 min: Pricing review', notice.title);
check('the notice body is facts', /With Sam Lee/.test(notice.body) && /Pricing question/.test(notice.body));
check('a brief is one bounded sentence', P.validateBrief('x'.repeat(500)).length <= P.BRIEF_MAX + 1);
check('"null" is no brief', P.validateBrief('null') === null && P.validateBrief('') === null);

// ── follow-ups: candidates (arithmetic) ──
console.log('follow-up candidates');
const sent = (o = {}) => ({
    messageId: 's1', threadId: 't1', account: ME, from: ME, to: 'Sam Lee <sam@x.com>',
    subject: 'Contract', internalDate: String(NOW - 4 * DAY), labels: ['SENT'], ...o
});
const cand = (list, opts = {}) => P.followupCandidates(list, NOW, { ownAddresses: [ME], ...opts });
check('a sent email, 4 days, no reply, is a candidate', cand([sent()]).length === 1);
check('1 day old is too soon', cand([sent({ internalDate: String(NOW - DAY) })]).length === 0);
check('a month old is too late', cand([sent({ internalDate: String(NOW - 30 * DAY) })]).length === 0);
check('incoming mail is never a candidate', cand([sent({ labels: ['INBOX'] })]).length === 0);
check('a reply in the thread settles it',
    cand([sent(), { messageId: 'r1', threadId: 't1', account: ME, from: 'sam@x.com', to: ME, internalDate: String(NOW - 2 * DAY), labels: ['INBOX'] }]).length === 0);
check('the same thread id in ANOTHER account does not',
    cand([sent(), { messageId: 'r1', threadId: 't1', account: 'other@example.com', from: 'sam@x.com', internalDate: String(NOW - 2 * DAY), labels: ['INBOX'] }]).length === 1);
check('to no-reply is skipped', cand([sent({ to: 'no-reply@x.com' })]).length === 0);
check('to a crowd is skipped', cand([sent({ to: 'a@x.com, b@x.com, c@x.com, d@x.com' })]).length === 0);
check('to only myself is skipped', cand([sent({ to: ME })]).length === 0);
check('already examined is skipped', cand([sent()], { skip: id => id === P.followupId(sent()) }).length === 0);

// ── the person outranks the model (P3/P4) ──
console.log('learning');
check('two "Not now"s and no accepts suppress a recipient',
    P.suppressed('sam@x.com', { 'sam@x.com': { dismissed: 2, accepted: 0 } }));
check('one accept keeps them', !P.suppressed('sam@x.com', { 'sam@x.com': { dismissed: 5, accepted: 1 } }));
check('a suppressed recipient is no longer a candidate',
    cand([sent()], { feedback: { 'sam@x.com': { dismissed: 2 } } }).length === 0);
check('too few decisions never quiets a kind', !P.quietKind({ accepted: 0, dismissed: 3 }));
check('mostly ignored, after enough decisions, goes quiet', P.quietKind({ accepted: 1, dismissed: 9 }));
check('a kind they use stays loud', !P.quietKind({ accepted: 4, dismissed: 4 }));

// ── follow-ups: the model's answer (P1) ──
console.log('validating the model');
const text = 'Hi Sam,\n\nCould you send the signed contract by Friday? Thanks.\n\nOn Mon, Sam wrote:\n> Can we talk pricing?';
const own = P.ownWords(text);
check('own words stop at the quoted thread', !/pricing/i.test(own) && /signed contract/.test(own));
check('a request is noticed', P.asksSomething(own));
check('a thank-you is not a request', !P.asksSomething('Thanks for lunch today, it was great.'));
const ok = P.validateFollowup({ follow_up: true, quote: 'Could you send the signed contract by Friday?', draft: 'Hi Sam, just checking on the signed contract. Thanks! Ram' },
    { text: own, email: sent(), now: NOW, ownAddresses: [ME] });
check('a verbatim quote with a draft is kept', ok && ok.state === 'ready' && ok.to[0] === 'sam@x.com');
check('it is keyed by account and message', ok && ok.id === `followup:${ME}:s1`);
check('"no" is a real answer', P.validateFollowup({ follow_up: false }, { text: own }) === 'no');
check('a quote that is not in their words is dropped',
    P.validateFollowup({ follow_up: true, quote: 'Can we talk pricing?', draft: 'Hi Sam, following up on pricing.' }, { text: own, email: sent() }) === null);
check('an empty draft is dropped',
    P.validateFollowup({ follow_up: true, quote: 'Could you send the signed contract by Friday?', draft: '' }, { text: own, email: sent() }) === null);
check('a rambling draft is dropped',
    P.validateFollowup({ follow_up: true, quote: 'Could you send the signed contract by Friday?', draft: 'x'.repeat(2000) }, { text: own, email: sent() }) === null);
check('malformed is null, not guessed', P.validateFollowup({ follow_up: 'maybe' }, { text: own }) === null && P.validateFollowup(null, {}) === null);

// ── settling ──
console.log('settling');
check('their reply settles as answered',
    P.settledBy(ok, [{ messageId: 'r1', threadId: 't1', account: ME, internalDate: String(NOW), labels: ['INBOX'] }]) === 'answered');
check('the person writing again settles as sent',
    P.settledBy(ok, [{ messageId: 's2', threadId: 't1', account: ME, internalDate: String(NOW), labels: ['SENT'] }]) === 'sent');
check('nothing new leaves it open', P.settledBy(ok, [sent()]) === null);

// ── the morning notice ──
console.log('morning');
check('a quiet morning says nothing', P.morningNotice({}) === null);
const m = P.morningNotice({ meetings: [{ start: NOW + HOUR, title: 'Standup' }], due: 2, overdue: 1, followups: 1 });
check('a busy one joins facts', m && /1 meeting, first at .+ \(Standup\)/.test(m.body) && /2 tasks due today/.test(m.body)
    && /1 overdue/.test(m.body) && /1 follow-up drafted/.test(m.body), m && m.body);

if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
}
console.log('\nall proactive checks passed');
