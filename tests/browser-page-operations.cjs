// look / interact / marks in a REAL page. Rendered fixtures only: no external
// requests, no accounts. Run by hand: node tests/browser-page-operations.cjs
'use strict';
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const { look, interact, marks, MANUAL_FIELDS } = require('../js/main/browser/page-operations');
const items = Array.from({ length: 120 }, (_, i) => `<li><h3>Product ${i}</h3><p>Price $${i}</p><button>Add to cart</button><a href="/p/${i}">Details</a></li>`).join('');
const html = `<html><head><title>Shop</title><style>body{margin:0;font:14px sans-serif}li{height:90px}dialog{position:fixed;inset:40px}</style></head><body>
    <header><input type="search" aria-label="Search products" placeholder="Search"><select aria-label="Sort"><option>Featured</option><option>Price: low to high</option></select>
    <input type="text" readonly aria-label="City" value="Dublin"><input type="checkbox" aria-label="In stock"><button disabled>Disabled one</button></header>
    <form id="login"><input type="email" aria-label="Email"><input type="password" aria-label="Password"><input name="coupon" aria-label="Coupon"><button>Sign in</button></form>
    <div id="host"></div><ul>${items}</ul><p id="deep">Needle in a haystack</p><button id="deepbtn">Deep action</button>
    <div contenteditable="true" aria-label="Notes"></div>
    <dialog id="dlg" aria-label="Choose size"><p>Pick one</p><button>Small</button><button>Large</button><button>Close</button></dialog>
    <script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<button>Shadow reject</button>';
    document.querySelector('ul').addEventListener('click', e => { if (e.target.tagName === 'BUTTON') e.target.textContent = 'Added'; });</script></body></html>`;
(async () => {
    const browser = await chromium.launch({ executablePath: process.env.ANJADHE_TEST_CHROME || chromium.executablePath(), headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
        await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
        await page.goto('https://shop.test/');
        const run = (fn, ...args) => page.evaluate(({ code, args }) => (0, eval)('(' + code + ')')(...args), { code: fn.toString(), args });
        const see = () => run(look, 'e-' + Math.random(), {}, MANUAL_FIELDS);
        const by = (observed, label) => observed.elements.find(el => el.label === label);

        let observed = await see();
        const chars = JSON.stringify(observed).length;
        assert.ok(chars < 9000, `A look of a 120-product page stays small (${chars} chars)`);
        assert.ok(observed.elements.length < 40 && observed.more.below > 200, 'Only the viewport is listed; the rest is counted');
        assert.deepEqual(observed.elements.map(el => el.n), observed.elements.map((_, i) => i + 1), 'Numbered in order');
        assert.ok(observed.elements.every(el => el.y < 700 && el.y + el.h > 0), 'Every listed control is on screen');
        assert.equal(by(observed, 'Search products').placeholder, 'Search');
        assert.deepEqual(by(observed, 'Sort').options, ['Featured', 'Price: low to high']);
        assert.equal(by(observed, 'City').readOnly, true);
        assert.equal(by(observed, 'In stock').checked, false);
        assert.equal(by(observed, 'Disabled one').disabled, true);
        assert.ok(by(observed, 'Shadow reject'), 'Open shadow roots are reachable');
        // Fields only the user may fill: listed, flagged, never read, never typed into.
        assert.equal(by(observed, 'Password').manualOnly, true); assert.equal(by(observed, 'Email').manualOnly, true);
        assert.equal(by(observed, 'Password').value, undefined); assert.match(observed.manualFields, /Only the user/);
        assert.equal(by(observed, 'Coupon').submits, 'Sign in', 'What Enter in a field would press is reported for main to judge');
        assert.match((await run(interact, { action: 'type', n: by(observed, 'Password').n, text: 'x' }, MANUAL_FIELDS)).error, /Only the user/);
        assert.match((await run(interact, { action: 'locate', n: by(observed, 'Password').n }, MANUAL_FIELDS)).error, /Only the user/, 'A trusted click cannot reach them either');
        assert.match((await run(interact, { action: 'type', n: by(observed, 'Coupon').n, text: 'SAVE', submit: true }, MANUAL_FIELDS)).error, /theirs to submit/);
        assert.match((await run(interact, { action: 'click', n: 1 }, '')).error, /misconfigured/, 'No field set, no action');
        // Identical labels are told apart by the heading they sit under.
        const adds = observed.elements.filter(el => el.label === 'Add to cart');
        assert.ok(adds.length > 1 && adds.every(el => /^Product \d+$/.test(el.near)), 'near: ' + JSON.stringify(adds.map(el => el.near)));
        assert.ok(!by(observed, 'Search products').near, 'A unique label needs no context');
        assert.match(observed.text, /Product 0/); assert.doesNotMatch(observed.text, /Needle/, 'Text is what is in view');

        // Steps.
        assert.equal((await run(interact, { action: 'type', n: by(observed, 'Search products').n, text: 'kettle' }, MANUAL_FIELDS)).ok, true);
        assert.equal(await page.inputValue('[aria-label="Search products"]'), 'kettle');
        assert.match((await run(interact, { action: 'type', n: by(observed, 'City').n, text: 'x' }, MANUAL_FIELDS)).error, /picker/);
        assert.equal((await run(interact, { action: 'select', n: by(observed, 'Sort').n, text: 'price: low' }, MANUAL_FIELDS)).ok, true);
        assert.equal(await page.inputValue('[aria-label="Sort"]'), 'Price: low to high');
        assert.match((await run(interact, { action: 'select', n: by(observed, 'Sort').n, text: 'newest' }, MANUAL_FIELDS)).error, /Its options: Featured \| Price/);
        assert.match((await run(interact, { action: 'click', n: 999 }, MANUAL_FIELDS)).error, /no control numbered 999/);
        assert.match((await run(interact, { action: 'click', n: by(observed, 'Disabled one').n }, MANUAL_FIELDS)).error, /disabled/);
        const where = await run(interact, { action: 'locate', n: adds[0].n }, MANUAL_FIELDS);
        assert.equal(where.hit, true); assert.ok(where.x > 0 && where.y > 0);
        await run(interact, { action: 'click', n: adds[0].n }, MANUAL_FIELDS);
        assert.match((await run(interact, { action: 'click', n: adds[0].n }, MANUAL_FIELDS)).error, /changed since the last look/, 'A control that became something else is stale');

        // find and scroll move the viewport; the next look follows.
        assert.deepEqual(await run(interact, { action: 'find', text: 'needle in a' }, MANUAL_FIELDS), { ok: true, found: 1 });
        observed = await see();
        assert.match(observed.text, /Needle in a haystack/); assert.ok(by(observed, 'Deep action')); assert.ok(observed.more.above > 200);
        assert.deepEqual(await run(interact, { action: 'find', text: 'no such text' }, MANUAL_FIELDS), { ok: true, found: 0 });
        assert.equal((await run(interact, { action: 'type', n: by(observed, 'Notes').n, text: 'hello' }, MANUAL_FIELDS)).ok, true);
        assert.equal(await page.textContent('[aria-label="Notes"]'), 'hello');
        assert.equal((await run(interact, { action: 'scroll', direction: 'down' }, MANUAL_FIELDS)).moved, false, 'At the end, scrolling says so');
        assert.equal((await run(interact, { action: 'scroll', direction: 'up' }, MANUAL_FIELDS)).moved, true);

        // An open dialog owns the page.
        await page.evaluate(() => document.getElementById('dlg').showModal());
        observed = await see();
        assert.equal(observed.dialog, 'Choose size');
        assert.deepEqual(observed.elements.map(el => el.label), ['Small', 'Large', 'Close']);
        assert.match(observed.text, /Pick one/); assert.doesNotMatch(observed.text, /Product/);
        // Marks: one badge per listed control, gone afterwards.
        assert.equal((await run(marks, true)).drawn, 3);
        assert.equal(await page.evaluate(() => globalThis.__anjadheMarks.length), 3);
        await run(marks, false);
        assert.equal(await page.evaluate(() => [...document.documentElement.children].filter(el => el.tagName === 'DIV').length), 0, 'Marks never outlive the picture');
        console.log('browser-page-operations passed');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
