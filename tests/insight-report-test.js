// InsightReport (js/apps/email/insight-report.js): read-only counts of what
// insights became, per kind, so noise is measured before it is cut.
const assert = require('assert');
const R = require('../js/apps/email/insight-report.js');
const NOW = Date.parse('2026-10-02T12:00:00');
const ago = (d) => new Date(NOW - d * 86400000).toISOString();

const analyses = {
    s1: { type: 'bill', kind: 'monthly statement', actionRequired: false, readAt: ago(1), tell: 'file' },   // filed by the assistant
    s2: { type: 'bill', kind: 'monthly statement', actionRequired: false, tell: 'file' },                   // filed by the assistant
    b1: { type: 'bill', kind: 'bill due', actionRequired: true },                                 // needs action, a task
    o1: { type: 'delivery', actionRequired: false, readAt: ago(1), tell: 'file' },                            // no kind: subject used
    old: { type: 'bill', actionRequired: false, readAt: ago(40) },                                // outside the window
    rolled: { type: 'bill', rolledUp: true }
};
const emails = {
    s1: { from: '"Fidelity" <alerts@fidelity.com>', subject: 'Your statement is ready', at: ago(2) },
    s2: { from: '"Fidelity" <alerts@fidelity.com>', subject: 'Your statement is ready', at: ago(5) },
    b1: { from: '"City Water" <billing@city.gov>', subject: 'Bill due Oct 10', at: ago(1) },
    o1: { from: 'Amazon <ship@amazon.com>', subject: 'Your package has shipped', at: ago(1) },
    old: { from: 'x <x@y.z>', subject: 'old', at: ago(40) }
};
const tasks = [{ id: 't1', sourceEmailId: 'b1', lastCompletedDate: '2026-10-02' }];
const ledger = { 'b1::pay the water bill': 't1', 's1::review statement': 'gone-task', 'a1::attend': 'cal:1' };
const r = R.build({ analyses, emails, tasks, ledger, now: NOW, days: 30,
    verdicts: { v1: { why: 'irrelevant', at: ago(1) }, v2: { why: 'suppressed-kind', at: ago(1) }, v3: { why: 'irrelevant', at: ago(50) } },
    dismissed: { 'alerts@fidelity.com': [{ type: 'bill', at: ago(1) }] }, notified: { bill: 3 } });

const bill = r.rows.find(g => g.type === 'bill');
assert.equal(bill.insights, 3, 'old and rolled-up insights are not counted');
assert.equal(bill.needAction, 1);
assert.equal(bill.filed, 2, 'statements the assistant filed');
assert.equal(bill.doneNoAction, 0, 'filed is not shown, so not noise');
assert.equal(bill.ignored, 0);
assert.equal(bill.notUseful, 1);
assert.equal(bill.noise, 0);
assert.equal(bill.tasks, 2, 'a deleted task still counts as made');
assert.equal(bill.tasksDone, 1); assert.equal(bill.tasksDeleted, 1);
assert.equal(bill.notified, 3);
assert.deepEqual(bill.kinds[0], { kind: 'monthly statement', n: 2 });

assert.equal(r.rows.find(g => g.type === 'delivery').kinds[0].kind, '"package has shipped"', 'no kind: the cleaned subject');
assert.deepEqual(r.filed, { irrelevant: 1, 'suppressed-kind': 1 });
assert.equal(r.senders[0].address, 'alerts@fidelity.com');
assert.equal(r.senders[0].noise, 0, 'filed statements are not noise');
const t = R.text(r);
assert.match(t, /^Last 30 days: 4 insights; 1 shown, 3 filed\. Noise 0 of the 1 shown/);
// A SHOWN insight that took attention and gave nothing back is still noise.
{
    const r2 = R.build({ now: NOW, days: 30, analyses: { ap: { type: 'appointment', actionRequired: false, readAt: ago(1) }, rn: { type: 'renewal', actionRequired: false } },
        emails: { ap: { from: 'Clinic <c@x.com>', subject: 'Reminder', at: ago(1) }, rn: { from: 'Svc <s@x.com>', subject: 'Renews', at: ago(5) } } });
    const ap = r2.rows.find(g => g.type === 'appointment'), rn = r2.rows.find(g => g.type === 'renewal');
    assert.equal(ap.doneNoAction, 1); assert.equal(rn.ignored, 1); assert.equal(r2.total.noise, 2); assert.equal(r2.total.filed, 0);
}
console.log('insight-report: counts, noise, kinds, senders passed');
