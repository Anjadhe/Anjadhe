// Search must find insight content and draw matches in every list section.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="fyi-view"><input id="fyi-search"><div id="fyi-body"></div></div>', { url: 'https://app.test' });
const ctx = vm.createContext({
    console, window: dom.window, document: dom.window.document,
    localStorage: dom.window.localStorage,
    AppManager: { register() {} },
    UIUtils: { escapeHtml: s => String(s), humanizeIsoDates: s => s },
    Matters: require('../js/core/matters.js'),
});
for (const [file, name] of [['email/email-app.js', 'EmailApp'], ['fyi/fyi-page.js', 'FyiPage']]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/apps', file), 'utf8') + `\nthis.${name} = ${name};`, ctx);
}
const F = ctx.FyiPage, E = ctx.EmailApp;
const row = (id, a, matter) => ({ id, a, matter, ts: Date.now(), email: {
    from: 'Billing <billing@example.com>', to: 'me@example.com', subject: 'Your statement',
    bodyText: 'body-only-secret',
} });
const receipt = row('receipt', { type: 'receipt', summary: 'Payment received',
    insights: ['The ceramic workshop includes glazing materials.'], amount: '$48' });
const bill = row('bill', { type: 'bill', summary: 'Balance due', actionItems: [{ text: 'Choose a payment method' }] }, {
    title: 'Café membership', status: 'Awaiting bank transfer', state: 'open',
    next: { state: 'open', what: 'Send the signed authorization' },
    sources: [{ from: 'Maya', summary: 'The pottery studio renewed your plan' }],
});
const done = row('done', { type: 'delivery', summary: 'The telescope arrived' }, { state: 'done' });
let rows = [receipt, bill, done];
const ids = query => Array.from(F._searchRows(rows, query), r => r.id);
assert.deepEqual(ids('ceramic glazing'), ['receipt']);
assert.deepEqual(ids('"glazing materials"'), ['receipt']);
assert.deepEqual(ids('reciepts'), ['receipt'], 'type labels and typo tolerance still work');
assert.deepEqual(ids('CAFE membership'), ['bill'], 'the visible folder title, ignoring accents');
assert.deepEqual(ids('bank transfer'), ['bill']);
assert.deepEqual(ids('signed authorization'), ['bill']);
assert.deepEqual(ids('pottery Maya'), ['bill'], 'earlier message summaries remain findable');
assert.deepEqual(ids('from:billing subject:statement ceramic'), ['receipt']);
assert.deepEqual(ids('is:read telescope'), ['done']);
assert.deepEqual(ids('is:unread telescope'), []);
assert.deepEqual(ids('body-only-secret'), [], 'insight search does not read email bodies');

// Exercise the real input handler and render path: a lone Filed match used
// to produce "Nothing matches" even though the matcher found its content.
F._items = () => rows;
F._gateMessage = () => null;
F._paintStatus = () => {};
F._paintLede = () => {};
E.getProfileAnalyses = () => ({});
F._cardHtml = r => `<article data-fyi-card="${r.id}">${r.a.summary}</article>`;
F._wire();
const search = dom.window.document.getElementById('fyi-search');
const body = dom.window.document.getElementById('fyi-body');
function searchFor(query) {
    search.value = query;
    search.dispatchEvent(new dom.window.Event('input'));
}
searchFor('glazing');
assert.ok(body.querySelector('[data-fyi-card="receipt"]'));
assert.ok(body.querySelector('.fyi-filed[open]'));
assert.ok(!body.textContent.includes('Nothing matches.'));
searchFor('authorization');
assert.ok(body.querySelector('#fyi-needs-title'));
assert.ok(body.querySelector('[data-fyi-card="bill"]'));
searchFor('telescope');
assert.ok(body.querySelector('.fyi-done[open] [data-fyi-card="done"]'));
F._kind = 'bill';
searchFor('glazing');
assert.ok(body.textContent.includes('Nothing matches.'), 'kind chips still narrow search');
F._kind = null;
searchFor('xyzzymissing');
assert.ok(body.textContent.includes('Nothing matches.'));
rows = Array.from({ length: F.DONE_SHOWN + 3 }, (_, i) => ({ ...receipt, id: `receipt-${i}` }));
searchFor('glazing');
assert.equal(body.querySelectorAll('[data-fyi-card]').length, rows.length, 'search includes matches beyond the fold');
searchFor('');
assert.equal(body.querySelectorAll('[data-fyi-card]').length, F.DONE_SHOWN, 'clearing search restores the ordinary list');

ctx.Trips = { fallbackBrief: () => 'Bring a passport', itinerary: () => [{ line: 'Overnight in Kyoto' }] };
rows = [{ id: 'trip:1', a: { type: 'reservation', summary: 'Japan trip' }, email: receipt.email,
    trip: {}, members: [receipt] }];
assert.deepEqual(ids('glazing'), ['trip:1'], 'grouping does not hide member insight content');
assert.deepEqual(ids('passport Kyoto'), ['trip:1']);
console.log('fyi-search: content matching and rendered results passed');
