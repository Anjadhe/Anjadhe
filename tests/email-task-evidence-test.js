// Mail may create work only from a quoted obligation and deadline, never
// from a notice's timestamp or a fabricated 7 AM schedule.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const M = require('../js/core/matters');
const now = Date.parse('2026-10-07T12:00:00Z');
const email = body => ({ messageId: 'mail-1', from: 'Account Service <security@example.com>', subject: 'Account access', bodyText: body, date: '2026-10-07T06:00:00Z' });
const misleading = { summary: 'Review app access by 2026-10-07', eventDate: '2026-10-07', actionRequired: true, actionItems: [{ text: 'Review app access', dueDate: '2026-10-07' }] };
const raw = next => ({ about: 'new', kind: 'other', title: 'Account access', when: '2026-10-07', next, tell: 'morning' });
const vetted = (mail, next, analysis = misleading) => M.vet(raw(next), M.facts(mail, analysis, mail.bodyText), [], now);

function run(mail, j, analysis = misleading, manual = false) {
    const store = {};
    const matter = { id: 'matter:mail-1', state: 'open', when: { date: '2026-10-07' }, next: j?.next ? { ...j.next, state: 'open' } : null };
    const ctx = { console, window: {}, document: { addEventListener() {}, getElementById() { return null; } },
        localStorage: { getItem: () => null, setItem() {} },
        AppManager: { register() {}, updateStats() {} }, ScheduleApp: {},
        UIUtils: { generateId: () => 'task-1', showToast() {} },
        StorageManager: { get: key => store[key], set: (key, value) => { store[key] = value; } },
        Matters: { ...M, forSource: () => matter, linkTask: (_id, _step, id) => { matter.next.taskId = id; } }
    };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/apps/email/email-app.js'), 'utf8') + '\nthis.EmailApp = EmailApp;', ctx);
    const E = ctx.EmailApp;
    E.emailById = () => mail;
    E.priorityAnalyses = { [mail.messageId]: analysis };
    if (manual) E.addTaskFromInsight(mail.messageId);
    else { E.syncActionItemsToSchedule(mail, analysis); E.syncActionItemsToSchedule(mail, analysis); }
    return store.schedule?.scheduleItems || [];
}

const notice = email('You granted nenva access to your Google Account on October 7. If this was not you, review your account access.');
const precaution = 'If this was not you, review your account access.';
let j = vetted(notice, { what: 'Review app access', yours: true, by: '2026-10-07', quote: precaution });
assert.equal(j.next.by, null, 'the message timestamp is not a quoted deadline');
assert.equal(run(notice, j).length, 0, 'no task even when a raw extraction and event date suggest today');
j = vetted(notice, { what: 'Review app access', yours: true, by: '2026-10-07', quote: precaution, by_quote: misleading.summary });
assert.equal(j.next.byQuote, null, 'generated summary cannot prove a deadline');
assert.equal(run(notice, j).length, 0);
j = vetted(notice, { what: 'Review app access', yours: true, by: '2026-10-07', quote: 'You must review access today.', by_quote: '2026-10-07T06:00:00Z' });
assert.equal(j.next.quote, null, 'invented obligation rejected');
assert.equal(j.next.by, null, 'Date header cannot prove a deadline');
assert.equal(run(notice, j).length, 0);
assert.equal(run(notice, { next: { what: 'Review app access', yours: true, by: '2026-10-07' } }).length, 0, 'old unevidenced steps cannot create new tasks');

// A real required recovery step must survive; this is not a security-mail blacklist.
const recoveryText = 'We confirmed unauthorized access. Reset your password by October 8 to restore your account.';
const recovery = email(recoveryText);
j = vetted(recovery, { what: 'Reset your password', yours: true, quote: recoveryText, by: '2026-10-08', by_quote: 'by October 8', time: '07:00' });
let tasks = run(recovery, j);
assert.equal(tasks.length, 1, 'real dated work is created once');
assert.equal(tasks[0].scheduledDate, '2026-10-08');
assert.equal(tasks[0].startTime, '', 'no supplied time means no invented 7 AM');
assert.equal(j.next.time, null, 'unquoted model time rejected');

const billText = 'Pay your bill by October 9 at 14:30.';
const bill = email(billText);
j = vetted(bill, { what: 'Pay your bill', yours: true, quote: billText, by: '2026-10-09', by_quote: 'by October 9', time: '14:30', time_quote: 'at 14:30' });
tasks = run(bill, j);
assert.equal(tasks.length, 1);
assert.equal(tasks[0].startTime, '14:30', 'an explicit deadline time is retained');
assert.equal(tasks[0].scheduledDate, '2026-10-09', 'uses the obligation deadline, not the general event date');

// Missing deadline stays undated even when the source contains other dates.
j = vetted(bill, { what: 'Pay your bill', yours: true, quote: billText });
assert.equal(run(bill, j).length, 0);
// The user's explicit Add task action remains available, but does not invent a time.
tasks = run(bill, null, { actionItems: [{ text: 'Pay your bill', dueDate: '2026-10-09' }] }, true);
assert.equal(tasks[0].startTime, '');
console.log('email-task-evidence: notice dates, source quotes, real obligations, time and dedup passed');
