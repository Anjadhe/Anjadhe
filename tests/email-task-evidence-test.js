// A folder's step from mail is dated only from a quoted obligation and
// deadline, never from a notice's timestamp or a fabricated 7 AM. That date
// is what the step's due notice reads (Proactive.stepPass). Since 2026-10-11
// mail makes folders, not tasks: filing writes no task at all.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../js/core/matters');
const now = Date.parse('2026-10-07T12:00:00Z');
const email = body => ({ messageId: 'mail-1', from: 'Account Service <security@example.com>', subject: 'Account access', bodyText: body, date: '2026-10-07T06:00:00Z' });
const misleading = { summary: 'Review app access by 2026-10-07', eventDate: '2026-10-07', actionRequired: true, actionItems: [{ text: 'Review app access', dueDate: '2026-10-07' }] };
const raw = next => ({ about: 'new', kind: 'other', title: 'Account access', when: '2026-10-07', next, tell: 'morning' });
const vetted = (mail, next, analysis = misleading) => M.vet(raw(next), M.facts(mail, analysis, mail.bodyText), [], now);

const notice = email('You granted nenva access to your Google Account on October 7. If this was not you, review your account access.');
const precaution = 'If this was not you, review your account access.';
let j = vetted(notice, { what: 'Review app access', yours: true, by: '2026-10-07', quote: precaution });
assert.equal(j.next.by, null, 'the message timestamp is not a quoted deadline');
j = vetted(notice, { what: 'Review app access', yours: true, by: '2026-10-07', quote: precaution, by_quote: misleading.summary });
assert.equal(j.next.byQuote, null, 'generated summary cannot prove a deadline');
j = vetted(notice, { what: 'Review app access', yours: true, by: '2026-10-07', quote: 'You must review access today.', by_quote: '2026-10-07T06:00:00Z' });
assert.equal(j.next.quote, null, 'invented obligation rejected');
assert.equal(j.next.by, null, 'Date header cannot prove a deadline');

// A real required recovery step keeps its date; this is not a security-mail blacklist.
const recoveryText = 'We confirmed unauthorized access. Reset your password by October 8 to restore your account.';
j = vetted(email(recoveryText), { what: 'Reset your password', yours: true, quote: recoveryText, by: '2026-10-08', by_quote: 'by October 8', time: '07:00' });
assert.equal(j.next.by, '2026-10-08', 'real dated work keeps its deadline');
assert.equal(j.next.time, null, 'unquoted model time rejected');

const billText = 'Pay your bill by October 9 at 14:30.';
j = vetted(email(billText), { what: 'Pay your bill', yours: true, quote: billText, by: '2026-10-09', by_quote: 'by October 9', time: '14:30', time_quote: 'at 14:30' });
assert.equal(j.next.by, '2026-10-09', 'uses the obligation deadline, not the general event date');
assert.equal(j.next.time, '14:30', 'an explicit deadline time is retained');
// Missing deadline stays undated even when the source contains other dates.
j = vetted(email(billText), { what: 'Pay your bill', yours: true, quote: billText });
assert.equal(j.next.by, null);

// Mail writes no task: the email app has no task-making path left.
const src = fs.readFileSync(path.join(__dirname, '../js/apps/email/email-app.js'), 'utf8');
for (const gone of ['syncActionItemsToSchedule', 'addTaskFromInsight', 'backfillScheduleSync'])
    assert.ok(!new RegExp(`\\b${gone}\\(`).test(src), `${gone} is gone`);
console.log('email-task-evidence: a step is dated only from quoted evidence, and mail makes no task; passed');
