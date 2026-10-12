/**
 * W24 (docs/SPECIALIST_AGENTS.md): a Workroom browser may work a task up to
 * its confirm button, and the last irreversible press always asks — even on
 * a website the user chose to always allow. Two halves are pinned here: the
 * vocabulary that decides which steps those are, and the fields only a human
 * may fill. Both are enforced in MAIN, from main's own view of the page.
 */
const assert = require('node:assert/strict');
const { sensitiveStep } = require('../js/main/browser/sensitive-steps');
const { MANUAL_FIELDS, interact, look, screenshotMask } = require('../js/main/browser/page-operations');

const click = (label, extra = {}) => sensitiveStep('internal_browser_click', { ref: '1:2' }, { label, ...extra });

// ── The steps that always ask ────────────────────────────────────────────
for (const label of ['Buy tickets', 'Pay now', 'Place your order', 'Confirm', 'Checkout',
    'Proceed to payment', 'Complete your purchase', 'Sign in', 'Log in', 'Send',
    'Submit', 'Delete', 'Reserve', 'Book now', 'Subscribe', 'Agree and pay',
    'Continue to payment', 'Authorize', 'Complete your booking']) {
    assert.ok(click(label), `"${label}" must ask every time`);
}

// ── Ordinary work, which runs under a saved website permission ───────────
for (const label of ['Select seats', 'Check Seats', 'IMAX 70MM', 'September 21', 'Next',
    'Dublin, CA', 'Showtimes', 'More dates', 'Close', 'Search', 'Seat E31']) {
    assert.equal(click(label), null, `"${label}" is ordinary work and must not ask`);
}

// A control main cannot resolve is unreadable, so it asks. Fail closed.
assert.ok(sensitiveStep('internal_browser_click', { ref: '9:9' }, null), 'An unknown reference must ask');
assert.ok(sensitiveStep('internal_browser_click', {}, null), 'A missing reference must ask');

// Observation and movement are never sensitive; they carry no consequence.
for (const name of ['snapshot', 'take_screenshot', 'navigate', 'navigate_back', 'scroll']) {
    assert.equal(sensitiveStep(`internal_browser_${name}`, { url: 'https://example.com/buy', direction: 'down' }, null), null,
        `${name} is observation or movement, not an irreversible step`);
}

// ── Card-shaped text asks wherever it is headed ──────────────────────────
const typed = text => sensitiveStep('internal_browser_type', { ref: '1:2', text }, { label: 'Notes' });
assert.ok(typed('4111 1111 1111 1111'), 'A card number must ask');
assert.ok(typed('4111-1111-1111-1111'), 'A separated card number must ask');
assert.ok(typed('123-45-6789'), 'A national ID number must ask');
assert.equal(typed('Dublin, CA'), null);
assert.equal(typed('2 adjacent seats'), null);
assert.equal(typed('September 21 2026'), null, 'A date is not an account number');

// A risky word in the VALUE or NAME of a control counts too.
assert.ok(sensitiveStep('internal_browser_click', { ref: '1:2' }, { label: '', value: 'Place order' }));

// ── The fields only the user may fill ────────────────────────────────────
// A parsed-selector proxy: page-operations runs matches() in the page, so
// the contract pinned here is that MANUAL_FIELDS covers each shape.
const covers = selector => MANUAL_FIELDS.split(',').some(part => part.trim() === selector);
for (const selector of ['input[type="password"]', 'input[autocomplete="one-time-code"]',
    'input[autocomplete="username"]', 'input[type="email"]', 'input[autocomplete^="cc-"]',
    'input[name*="cvc" i]', 'input[name*="cvv" i]', 'input[name*="cardnum" i]',
    'input[aria-label*="card number" i]']) {
    assert.ok(covers(selector), `MANUAL_FIELDS must cover ${selector}`);
}

// Every operation takes the field set as an ARGUMENT, because both runtimes
// serialize these functions and a module constant would read as undefined
// inside them. A caller that forgets it must fail loudly, never silently
// unmask a card number.
for (const fn of [look, interact, screenshotMask]) {
    assert.ok(/manualFields/.test(fn.toString()), `${fn.name} must take the manual-field set as an argument`);
}
// (The refusal itself runs in the page; tests/browser-page-operations.cjs
// drives it in a real Chrome. Here we pin that the guard exists at all.)
assert.match(interact.toString(), /if \(!manualFields\) return \{ error:/,
    'interact must refuse outright when the field set is missing');

// The runtime that injects them must actually pass it at every call site.
// Chrome's extension worker is the only one since the app's own embedded
// browser went with the Web Browser app (2026-09-20).
const fs = require('node:fs');
for (const file of ['browser-extension/worker.js']) {
    const source = fs.readFileSync(require('node:path').join(__dirname, '..', file), 'utf8');
    for (const op of ['look', 'interact', 'screenshotMask']) {
        assert.ok(new RegExp(`${op}[^\\n]*MANUAL_FIELDS`).test(source), `${file} must pass MANUAL_FIELDS to ${op}`);
    }
}
// And nothing else may drive page-operations without it.
assert.ok(!/page-operations/.test(fs.readFileSync(require('node:path').join(__dirname, '..', 'js/main/workroom-browser.js'), 'utf8')),
    'workroom-browser.js drives Chrome through the extension; it must not inject page operations itself');

console.log('browser-sensitive-steps-test passed');
