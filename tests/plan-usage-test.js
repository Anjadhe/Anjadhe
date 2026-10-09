#!/usr/bin/env node
/**
 * PlanUsage (js/core/plan-usage.js, docs/BILLING.md): the Plan page's
 * facts from Connect's /v1/usage (new and old shape), the code-written
 * 100% lines, and the once-per-month 80% / 100% notices. Percentages and
 * counts only (law B2); no price or purchase anywhere (no prices until
 * checkout exists).
 *
 *   node tests/plan-usage-test.js
 */
const assert = require('node:assert/strict');
const P = require('../js/core/plan-usage.js');

// ── view: the v2 answer ──
const v2 = { tier: 'plus', plan: 'plus', period: '2026-11', resetsAt: '2026-12-01',
    ai: { percent: 62, chatPercent: 40, backgroundPercent: 22 }, searches: { used: 1840, allowance: 3000 },
    used: 1840, quota: 3000, llm: { requests: 5, requestQuota: 10000, tokens: 100, tokenQuota: 25000000 } };
let v = P.view(v2);
assert.equal(v.state, 'ok');
assert.equal(v.plan, 'Plus');
assert.equal(v.resets, 'December 1', 'the reset date read as a date, not shifted by time zone');
assert.deepEqual(v.ai, { percent: 62, chatPercent: 40, backgroundPercent: 22 });
assert.equal(v.aiLevel, 'ok');
assert.deepEqual(v.searches, { used: 1840, allowance: 3000 });
assert.equal(v.searchLevel, 'ok');

// ── view: an older Connect (no ai / searches): derived like the server does ──
v = P.view({ tier: 'free', period: '2026-11', resetsAt: '2026-12-01', used: 280, quota: 300,
    llm: { requests: 850, requestQuota: 1000, tokens: 1000000, tokenQuota: 2500000 } });
assert.equal(v.plan, 'Free');
assert.equal(v.ai.percent, 85, 'the larger of requests and tokens');
assert.equal(v.aiLevel, 'high');
assert.equal(v.searchLevel, 'high');

// ── view: states ──
assert.equal(P.view({ error: 'offline' }).state, 'error');
assert.deepEqual(P.view({ notProvisioned: true }, { local: true }), { state: 'unused', local: true });
assert.equal(P.view({ ...v2, ai: { percent: 100, chatPercent: 100, backgroundPercent: 0 } }).aiLevel, 'out');

// ── billing (P3): passed through from the server, nothing invented ──
let b = P.view(v2).billing;
assert.deepEqual(b, { available: false, elsewhere: false, paid: false, status: null, lapsed: false, renews: '', manage: false, trialEnds: '',
    topup: { searches: 0, cloud: false }, packs: [], plans: [] }, 'an older Connect: nothing to buy');
b = P.view({ ...v2, billing: { available: true, source: 'trial', trial: { endsAt: '2026-10-21' }, topup: { searches: 1200, cloud: true },
    packs: [{ id: 'searches-2000', searches: 2000, cloud: false }, { id: 'Bad Id', searches: 1 }], plans: [{ id: 'plus', intervals: ['month'] }] } }).billing;
assert.equal(b.trialEnds, 'October 21');
assert.deepEqual(b.topup, { searches: 1200, cloud: true });
assert.deepEqual(b.packs, [{ id: 'searches-2000', searches: 2000, cloud: false }], 'only well-formed packs');
assert.match(P.quotaMessage({ kind: 'background', resetsAt: '2026-11-01' }), /background work .* is used\. It resets on November 1\. Chat still works\./);
b = P.view({ ...v2, billing: { available: true, source: 'tier', status: null, renews: null, manage: false,
    plans: [{ id: 'plus', intervals: ['month', 'year', 'weird'], searches: 3000 }, { id: '<b>', intervals: ['month'] }] } }).billing;
assert.equal(b.available, true);
assert.deepEqual(b.plans, [{ id: 'plus', name: 'Plus', intervals: ['month', 'year'], searches: 3000 }], 'only well-formed plans and known intervals');
b = P.view({ ...v2, billing: { available: true, source: 'code', status: 'past_due', renews: '2026-12-01', manage: true, plans: [] } }).billing;
assert.equal(b.paid, true);
assert.equal(b.renews, 'December 1');
assert.equal(b.available, false, 'nothing on sale, nothing to choose');
b = P.view({ ...v2, billing: { available: true, source: 'tier', status: 'canceled', plans: [{ id: 'plus', intervals: ['month'] }] } }).billing;
assert.equal(b.lapsed, true, 'a plan that ended says so');

// ── region: paid plans are sold in the US only at launch ──
const onSale = { ...v2, billing: { available: true, source: 'tier', packs: [{ id: 'searches-2000', searches: 2000 }],
    plans: [{ id: 'plus', intervals: ['month'] }] } };
assert.equal(P.sellsIn('US'), true);
assert.equal(P.sellsIn('us'), true);
assert.equal(P.sellsIn(''), true, 'an unknown region is not refused');
assert.equal(P.sellsIn('GB'), false);
b = P.view(onSale, { country: 'US' }).billing;
assert.equal(b.available, true);
assert.equal(b.elsewhere, false);
assert.equal(b.packs.length, 1);
b = P.view(onSale, { country: 'DE' }).billing;
assert.equal(b.available, false, 'nothing to choose outside the US');
assert.equal(b.elsewhere, true, 'the page says why');
assert.deepEqual(b.packs, [], 'no top-ups outside the US');
b = P.view({ ...v2, billing: { available: true, source: 'code', status: 'active', manage: true, plans: [{ id: 'plus', intervals: ['month'] }] } }, { country: 'DE' }).billing;
assert.equal(b.paid, true, 'a plan already bought keeps working and stays manageable');
assert.equal(b.manage, true);

// ── quotaMessage: code's words, no switch, no price ──
const ai = P.quotaMessage({ resetsAt: '2026-12-01', plan: 'free' });
assert.match(ai, /nenva cloud allowance on the Free plan/);
assert.match(ai, /December 1/);
assert.match(ai, /Settings › Model/);
assert.doesNotMatch(ai, /\$|buy|upgrade|price/i, 'nothing to buy until checkout exists');
const s = P.quotaMessage({ resetsAt: '2026-12-01', kind: 'search' });
assert.match(s, /web searches\./, 'an older Connect names no plan, and the line names none');
assert.match(s, /own search key/);
assert.match(P.quotaMessage({}), /start of next month/);

// ── noticeDue: once per level, per kind, per month ──
const high = { ...v2, ai: { percent: 83, chatPercent: 60, backgroundPercent: 23 } };
let n = P.noticeDue(high);
assert.equal(n.key, 'ai:80:2026-11');
assert.match(n.title, /83%/);
assert.equal(P.noticeDue(high, new Set(['ai:80:2026-11'])), null, 'shown once');
const out = { ...v2, ai: { percent: 100, chatPercent: 70, backgroundPercent: 30 }, searches: { used: 3000, allowance: 3000 } };
n = P.noticeDue(out, new Set(['ai:80:2026-11']));
assert.equal(n.key, 'ai:100:2026-11', 'running out is its own notice');
n = P.noticeDue(out, new Set(['ai:100:2026-11']));
assert.equal(n.key, 'search:100:2026-11');
assert.match(n.body, /3,000 web searches/);
assert.equal(P.noticeDue({ ...high, period: '2026-12' }, new Set(['ai:80:2026-11'])).key, 'ai:80:2026-12', 'a new month starts clean');
assert.equal(P.noticeDue(v2), null, 'nothing owed under 80%');
assert.equal(P.noticeDue({ error: 'x' }), null);

console.log('plan-usage: view, quota lines and notices passed');
