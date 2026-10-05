/* Approvals by risk, decided in MAIN (js/main/workroom-browser.js).
 * free: look, scroll, find, wait, focus keys, closing a cookie notice.
 * site: the first step on a website asks once ("Yes" = this workroom,
 *       "Always" = saved on this Mac).
 * step: buying / paying / sending / signing in asks EVERY time.
 * egress: a workroom holding private data asks before opening a site it has
 *       not used, even a saved one. */
const assert = require('node:assert/strict');
const WorkroomBrowser = require('../js/main/workroom-browser');
(async () => {
    const leases = new Map([['room', { sender: 1, token: 'lease' }], ['other', { sender: 1, token: 'lease2' }]]);
    const asked = []; let answer = { approved: true };
    const store = { leases, get: id => ({ status: leases.has(id) ? 'running' : 'paused' }), snapshot: () => [{ id: 'room', status: 'running' }],
        requestApproval: async (id, token, sender, request) => { asked.push({ id, ...request }); return answer; } };
    const values = new Map();
    const settings = { get: (key, fallback) => values.has(key) ? values.get(key) : fallback, set: (key, value) => values.set(key, value) };
    const executed = [];
    const page = { url: 'https://shop.test/', elements: [{ n: 1, role: 'button', label: 'Add to cart' }, { n: 2, role: 'button', label: 'Place order' },
        { n: 3, role: 'input', label: 'Search', type: 'search', submits: 'Search' }, { n: 4, role: 'input', label: 'Coupon', type: 'text', submits: 'Pay now' }] };
    const chrome = { url: 'about:blank', backUrl: null,
        state() { return { connected: true, starting: false, url: this.url, backUrl: this.backUrl, actions: ['look', 'act'] }; },
        async execute(action, args, options) { executed.push({ action, args, options }); if (args.action === 'open') this.url = args.url; return { ...page, url: this.url }; },
        async preview() { return { status: 'live' }; } };
    const browser = new WorkroomBrowser({ store: () => store, settings, chrome });
    const run = { id: 'room', token: 'lease' };
    const act = (args, extra = {}) => browser.execute(1, { action: 'act', args, run, ...extra });

    // Looking never asks.
    await browser.execute(1, { action: 'look', run, image: true });
    assert.equal(asked.length, 0); assert.equal(executed.at(-1).options.image, true);

    // The first step on a website asks once; the answer covers this workroom.
    await act({ action: 'open', url: 'https://shop.test/' });
    assert.equal(asked.length, 1); assert.equal(asked[0].kind, 'site'); assert.equal(asked[0].origin, 'https://shop.test');
    assert.match(asked[0].summary, /shop\.test/);
    await act({ action: 'click', n: 1 });
    await act({ action: 'type', n: 3, text: 'kettle', submit: true });
    assert.equal(asked.length, 1, 'Ordinary steps on an allowed website do not ask again');
    for (const free of [{ action: 'scroll', direction: 'down' }, { action: 'find', text: 'kettle' }, { action: 'wait' }, { action: 'press', key: 'Escape' }, { action: 'dismiss_consent' }]) await act(free);
    assert.equal(asked.length, 1, 'Free steps never ask');

    // W24: a buying step asks every time and can never be saved.
    await act({ action: 'click', n: 2 });
    await act({ action: 'click', n: 2 });
    assert.equal(asked.length, 3); assert.equal(asked.at(-1).kind, 'step'); assert.match(asked.at(-1).sensitive, /Place order/);
    assert.match(asked.at(-1).summary, /Click .Place order. on shop\.test/);
    // Enter in a field presses its form's button: judged by THAT label.
    await act({ action: 'type', n: 4, text: 'SAVE10', submit: true });
    assert.equal(asked.at(-1).kind, 'step', 'Enter in a form whose button pays is a paying step');
    await act({ action: 'press', key: 'Enter' });
    assert.equal(asked.at(-1).kind, 'step', 'A bare Enter asks while any form in view would pay');
    // A number main never observed cannot be checked, so it asks.
    await act({ action: 'click', n: 99 });
    assert.equal(asked.at(-1).kind, 'step'); assert.match(asked.at(-1).sensitive, /could not be read/);
    // Card-shaped text is the user's to type, wherever it is headed.
    await act({ action: 'type', n: 3, text: '4111 1111 1111 1111' });
    assert.match(asked.at(-1).sensitive, /card, account or ID/);

    // A declined step does nothing and says so.
    const before = executed.length; answer = { approved: false };
    const declined = await act({ action: 'click', n: 2 });
    assert.equal(declined.denied, true); assert.match(declined.error, /did not allow/); assert.equal(executed.length, before);
    answer = { approved: true };

    // Another workroom starts from nothing: site approvals are per workroom…
    const other = { id: 'other', token: 'lease2' };
    browser.holder = null;
    await browser.execute(1, { action: 'act', args: { action: 'click', n: 1 }, run: other });
    assert.equal(asked.at(-1).kind, 'site'); assert.equal(asked.at(-1).id, 'other');
    // …unless the user said Always, which is saved on this Mac.
    answer = { approved: true, always: true }; browser.holder = null;
    await act({ action: 'open', url: 'https://news.test/a' });
    assert.deepEqual(browser.trustedSites(), ['https://news.test']);
    answer = { approved: true }; browser.forget('other'); browser.holder = null;
    const count = asked.length;
    await browser.execute(1, { action: 'act', args: { action: 'open', url: 'https://news.test/b' }, run: other });
    assert.equal(asked.length, count, 'A saved website does not ask');
    // Egress: once a workroom holds private data, opening a site it has not used asks even if saved.
    browser.forget('other'); browser.holder = null;
    await browser.execute(1, { action: 'act', args: { action: 'open', url: 'https://news.test/?q=private' }, run: other, tainted: true });
    assert.equal(asked.length, count + 1); assert.match(asked.at(-1).detail, /news\.test\/\?q=private/, 'The question shows the full address');
    // Removing the permission takes effect at once.
    browser.revoke('https://news.test'); assert.deepEqual(browser.trustedSites(), []);

    // ONE tab: a second workroom waits for the first to let go.
    browser.holder = 'room';
    let got = false; const waiting = browser.acquire(1, other).then(() => { got = true; });
    await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(got, false);
    browser.release(run); await waiting; assert.equal(got, true);

    // No lease, no browser.
    leases.delete('room');
    await assert.rejects(act({ action: 'scroll', direction: 'down' }), /paused or no longer active/);
    leases.set('room', { sender: 1, token: 'lease' });
    await assert.rejects(browser.execute(2, { action: 'look', run }), /paused or no longer active/, 'Another window cannot use this lease');
    await assert.rejects(browser.execute(1, { action: 'act', args: { action: 'run_script' }, run }), /Unsupported browser step/);
    // An extension older than the app is named with its fix.
    chrome.state = function () { return { connected: true, url: this.url, actions: ['navigate', 'snapshot'] }; };
    await assert.rejects(browser.execute(1, { action: 'look', run }), /reload the nenva extension/);
    console.log('workroom-browser-test passed');
})().catch(error => { console.error(error); process.exit(1); });
