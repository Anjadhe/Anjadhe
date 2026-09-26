/**
 * Cookie / privacy consent dismissal (2026-09-20, Ram).
 *
 * Two halves are pinned here. The VOCABULARY, because the whole safety
 * argument is that the app picks the button and accept is not in its
 * language — a model reading "Accept all to continue" is exactly what a
 * consent wall is built to talk into clicking. And REACHABILITY, because
 * the reason banners could not be closed was never the choosing: the
 * snapshot stopped at the first shadow boundary, so a widget rendered in
 * an open shadow root or a same-origin frame was invisible to it.
 *
 * The clicking itself runs in a real page; tests/workroom-browser-electron.cjs
 * drives it against a fixture with both shapes.
 */
const assert = require('node:assert/strict');
const { dismissConsent, look } = require('../js/main/browser/page-operations');

const source = dismissConsent.toString();
const pattern = name => {
    const match = source.match(new RegExp(`const ${name} = (/.*/[a-z]*);`));
    assert.ok(match, `${name} must be a literal pattern in dismissConsent`);
    return eval(match[1]);
};
const REJECT_ALL = pattern('REJECT_ALL'), NECESSARY_ONLY = pattern('NECESSARY_ONLY');
const MANAGE = pattern('MANAGE'), ACKNOWLEDGE = pattern('ACKNOWLEDGE'), ESSENTIAL = pattern('ESSENTIAL');

// ── Accept is not in the vocabulary, in any of its disguises ─────────────
for (const label of ['Accept all', 'Accept All Cookies', 'Allow all', 'Allow All Cookies',
    'I agree', 'Agree and close', 'Agree and continue', 'Yes, I accept', 'Accept and continue',
    'OK, accept all', 'Enable all', 'Consent', 'Accept recommended settings', 'Allow selection',
    'Accept cookies', 'Got it, accept all']) {
    for (const [name, rx] of [['REJECT_ALL', REJECT_ALL], ['NECESSARY_ONLY', NECESSARY_ONLY], ['ACKNOWLEDGE', ACKNOWLEDGE]]) {
        assert.equal(rx.test(label), false, `${name} must never match "${label}"`);
    }
}

// ── The strict options it must recognise ────────────────────────────────
for (const label of ['Reject all', 'Reject All Cookies', 'Decline all', 'Refuse all', 'Deny all',
    'Reject all cookies', 'Decline optional cookies', 'Reject non-essential cookies']) {
    assert.ok(REJECT_ALL.test(label), `REJECT_ALL must match "${label}"`);
}
for (const label of ['Only necessary', 'Use necessary cookies only', 'Essential cookies only',
    'Strictly necessary only', 'Continue without accepting', 'Only essential']) {
    assert.ok(NECESSARY_ONLY.test(label) || REJECT_ALL.test(label), `necessary-only must match "${label}"`);
}
for (const label of ['Manage preferences', 'Customise choices', 'Customize Settings',
    'More options', 'Cookie settings', 'Let me choose', 'Manage options']) {
    assert.ok(MANAGE.test(label), `MANAGE must match "${label}"`);
}

// ── Which categories may stay on ────────────────────────────────────────
for (const label of ['Strictly necessary cookies', 'Essential', 'Required', 'Always active', 'Security']) {
    assert.ok(ESSENTIAL.test(label), `"${label}" is a category the site cannot work without`);
}
for (const label of ['Targeting cookies', 'Advertising', 'Marketing', 'Performance',
    'Analytics cookies', 'Social media', 'Personalisation', 'Measure advertising performance']) {
    assert.equal(ESSENTIAL.test(label), false, `"${label}" must be switched OFF, not kept`);
}

// ── The model names the control; the app keeps the VETO ─────────────────
// Detection by selector cannot find every bespoke consent widget, so vision
// does the identifying (Ram, 2026-09-20). What the app keeps is the refusal:
// a label that reads as accepting is never pressed, whoever named it.
assert.equal(dismissConsent.length, 1, 'dismissConsent takes a vision-named target');
const ACCEPT = pattern('ACCEPT'), REJECT_WORDS = pattern('REJECT_WORDS'), OFF_LIMITS = pattern('OFF_LIMITS');

for (const label of ['Accept all', 'Allow all cookies', 'I agree', 'Agree and continue',
    'Enable all', 'Opt in', 'Alle akzeptieren', 'Tout accepter', 'Aceptar todo',
    'Accetta tutti', 'Alles accepteren', 'Zustimmen']) {
    assert.ok(ACCEPT.test(label), `ACCEPT must catch "${label}" so it can be refused`);
}
// A strict choice that happens to contain an accept word must still pass:
// the code checks strict FIRST, so these are allowed, not vetoed.
for (const label of ['Allow only necessary', 'Accept only essential cookies']) {
    assert.ok(NECESSARY_ONLY.test(label) || REJECT_ALL.test(label),
        `"${label}" is a strict choice and must be recognised before the accept veto`);
}
for (const label of ['Alle ablehnen', 'Tout refuser', 'Rechazar', 'Rifiuta', 'Weigeren']) {
    assert.ok(REJECT_WORDS.test(label), `REJECT_WORDS must recognise "${label}"`);
}
// A consent dialog contains none of these, so a point over one means the
// model is not looking at what it thinks it is. W24 owns those steps.
for (const label of ['Buy tickets', 'Pay now', 'Place your order', 'Sign in', 'Delete account',
    'Confirm your purchase', 'Checkout']) {
    assert.ok(OFF_LIMITS.test(label), `OFF_LIMITS must refuse "${label}"`);
}
for (const label of ['Reject all', 'Manage preferences', 'Only necessary', 'Close']) {
    assert.equal(OFF_LIMITS.test(label), false, `"${label}" belongs to a consent dialog`);
}
// The veto and its honesty are both in the code, not only in the prompt.
assert.match(source, /never accepts on the user/, 'An accept control is refused with a reason');
assert.match(source, /clicked-unverified/, 'An unrecognised label is reported as pressed, not as a rejection');
assert.match(source, /clicked-unreadable/, 'An unreadable control is reported as unverifiable');
assert.match(source, /elementFromPoint/, 'A viewport point resolves to a real element before anything is pressed');

// ── Reachability: both operations walk shadow roots and same-origin frames
for (const [name, fn] of [['look', look], ['dismissConsent', dismissConsent]]) {
    const text = fn.toString();
    assert.match(text, /shadowRoot/, `${name} must look inside open shadow roots`);
    assert.match(text, /contentDocument/, `${name} must look inside same-origin frames`);
    // Serialized into the page by both runtimes, so it cannot call out to a
    // module-scope helper (see MANUAL_FIELDS).
    assert.doesNotMatch(text, /browserRoots\(/, `${name} must not call a module-scope helper`);
}
// A cross-origin frame is reported, never guessed at.
assert.match(source, /unreachable/, 'A cross-origin consent frame must report, not guess');
assert.match(source, /acknowledged/, 'An acknowledgement must not be reported as a rejection');

// The strict-first ordering is what makes "Allow only necessary" safe.
const strictIndex = source.indexOf('const strict = REJECT_ALL.test(text)');
const acceptIndex = source.indexOf('ACCEPT.test(text)');
assert.ok(strictIndex > 0 && acceptIndex > strictIndex,
    'The strict check must run BEFORE the accept veto, or "Allow only necessary" is refused');

// ── Renderer and main must agree on what exists ─────────────────────────
// Cmd+R reloads the renderer against current source while main keeps
// running the build it started with. A renderer that registers a tool main
// has never heard of met the model as "Unsupported browser action" with
// nothing pointing at the cause (reported against Sonnet 4.5, whose vision
// is what reaches the screenshot path at all).
const fs = require('node:fs'), path = require('node:path');
const repo = path.join(__dirname, '..');
const mainHalf = fs.readFileSync(path.join(repo, 'js/main/workroom-browser.js'), 'utf8');
const rendererHalf = fs.readFileSync(path.join(repo, 'js/agent/specialists/browser-tools.js'), 'utf8');

const list = (text, name) => { const found = text.match(new RegExp(name + "\\s*[:=]\\s*\\[([\\s\\S]*?)\\]")); assert.ok(found, name + ' must be ONE list'); return [...found[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]).sort(); };
const workerHalf = fs.readFileSync(path.join(repo, 'browser-extension/worker.js'), 'utf8');
// Two verbs, and every step an act can take, agreed by all three halves.
assert.deepEqual(list(mainHalf, 'static ACTIONS'), ['act', 'look']);
assert.deepEqual(list(workerHalf, 'const ACTIONS'), list(mainHalf, 'static ACTIONS'), 'The shipped extension and main must know the same verbs');
assert.deepEqual(list(workerHalf, 'const STEPS'), list(mainHalf, 'static STEPS'), 'The extension and main must know the same steps');
assert.deepEqual(list(rendererHalf, 'ACTIONS'), list(mainHalf, 'static STEPS'), 'Every step the model is offered is one main can run, and vice versa');
assert.ok(list(mainHalf, 'static STEPS').includes('dismiss_consent'));
// Closing a cookie notice can only ever refuse, so it never needs to ask.
assert.match(mainHalf, /static FREE = new Set\(\[[^\]]*'dismiss_consent'/);
// A loaded extension older than the app is named with its fix, because
// Chrome keeps running the worker it loaded until it is reloaded.
assert.match(mainHalf, /reload the nenva extension/);
assert.match(workerHalf, /actions: ACTIONS/, 'The extension reports what it can do in its state');

console.log('browser-consent-test passed');
