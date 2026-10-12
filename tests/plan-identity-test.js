// Settings › Plan, whose plan it is (js/core/simple-settings-pages.js,
// docs/BILLING.md B5): the plan follows the registration email, so the
// page names the address and the one action each state needs, says "Use
// on another Mac" by email, and keeps the plan code folded as a fallback.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

globalThis.SimpleSettings = { _chev: '', _esc: s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) };
new Function(fs.readFileSync(path.join(__dirname, '../js/core/simple-settings-pages.js'), 'utf8'))();
const S = globalThis.SimpleSettings;
const as = (status) => { globalThis.LicenseClaim = { _status: status }; };

// Not registered: register first.
as({ licensed: false });
let h = S._planIdentityHtml({ verified: false });
assert.match(h, /data-ss="plan-register"/);
assert.match(h, /follows your registration email/);

// Registered by key file, no address here: send them to Registration.
as({ licensed: true, email: null });
h = S._planIdentityHtml({ verified: false });
assert.match(h, /data-ss="page" data-id="registration"/);

// Registered, not proven on this Mac: Confirm.
as({ licensed: true, email: 'ram@example.com' });
h = S._planIdentityHtml({ verified: false });
assert.match(h, /ram@example\.com/);
assert.match(h, /data-ss="plan-confirm"/);

// Proven: no action, says the plan follows the address.
h = S._planIdentityHtml({ verified: true });
assert.match(h, /Confirmed on this Mac/);
assert.doesNotMatch(h, /data-ss="plan-/);

// The address is escaped.
as({ licensed: true, email: 'a<b>@example.com' });
assert.doesNotMatch(S._planIdentityHtml({ verified: true }), /<b>/);

// A bought plan: Manage, another Mac by email, Remove; the code folded away.
as({ licensed: true, email: 'ram@example.com' });
const v = (billing) => ({ billing: { paid: false, granted: false, manage: false, available: false, elsewhere: false, plans: [], packs: [], ...billing } });
S._planCodeOpen = false; S._planShowCode = null;
h = S._planBuyHtml(v({ paid: true, manage: true }));
assert.match(h, /data-ss="plan-manage"/);
assert.match(h, /Register there with ram@example\.com/);
assert.match(h, /data-ss="plan-code"/);
assert.doesNotMatch(h, /data-ss="plan-show-code"/, 'the code stays folded until asked for');
S._planCodeOpen = true;
h = S._planBuyHtml(v({ paid: true, manage: true }));
assert.match(h, /data-ss="plan-show-code"/);
assert.match(h, /data-plan-code-input/, '"I have a code" lives in the fold');
assert.equal(S._lastPlanPaid, true);

// A plan nenva gave: nothing to manage, no code.
S._planCodeOpen = false;
h = S._planBuyHtml(v({ granted: true }));
assert.match(h, /Given to you by nenva/);
assert.doesNotMatch(h, /plan-manage|plan-code/);

// Free: the fold holds "I have a code" only.
S._planCodeOpen = true;
h = S._planBuyHtml(v({}));
assert.match(h, /data-plan-code-input/);
assert.doesNotMatch(h, /data-ss="plan-show-code"/);
assert.equal(S._lastPlanPaid, false);

console.log('plan-identity: whose plan, the action per state, another Mac by email, the code folded passed');
