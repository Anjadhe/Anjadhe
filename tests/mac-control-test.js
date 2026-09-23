/**
 * Mac control — the pure halves (docs/COWORK_AGENT.md C14): main's step
 * validation and app blocklist (the boundary), and the renderer's
 * vocabulary, approval rules and consent line.
 *
 *   node tests/mac-control-test.js
 */
const assert = require('assert');
const path = require('path');

const { normalizeMacStep, isBlockedBundle, isBlockedName } = require(path.join(__dirname, '../js/main/mac-control.js'));
global.ScreenTools = require(path.join(__dirname, '../js/agent/screen-tools.js'));
const MacTools = require(path.join(__dirname, '../js/agent/mac-tools.js'));

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n  ${e.message}`); process.exitCode = 1; }
}

// ── main: M1 blocklist ───────────────────────────────────────────────────
test('credential, settings, terminal and self apps are blocked by bundle id', () => {
    for (const b of ['com.apple.keychainaccess', 'com.apple.Passwords', 'com.apple.systempreferences',
        'com.apple.Terminal', 'com.googlecode.iterm2', 'com.1password.1password', 'com.bitwarden.desktop',
        'com.anjadhe.app', 'com.github.Electron']) {
        assert.ok(isBlockedBundle(b), b);
    }
    for (const b of ['com.apple.Safari', 'com.google.Chrome', 'com.apple.finder', 'com.apple.iWork.Numbers']) {
        assert.ok(!isBlockedBundle(b), b);
    }
});
test('and by name when opening or looking', () => {
    for (const n of ['Keychain Access', 'system settings', 'Terminal', 'iTerm', '1Password 7', 'Anjadhe', 'nenva', 'Terminal.app']) {
        assert.ok(isBlockedName(n), n);
    }
    for (const n of ['Safari', 'Numbers', 'Finder', 'Terminal Notes']) assert.ok(!isBlockedName(n), n);
    assert.match(normalizeMacStep({ kind: 'open', app: 'Keychain Access' }).error, /never operates/);
});

// ── main: M2 step validation ─────────────────────────────────────────────
test('open takes http(s) addresses and plain app names only', () => {
    assert.deepStrictEqual(normalizeMacStep({ kind: 'open', app: 'Safari', url: 'https://example.com/a?b=1' }),
        { kind: 'open', app: 'Safari', url: 'https://example.com/a?b=1' });
    assert.ok(normalizeMacStep({ kind: 'open', url: 'file:///etc/passwd' }).error);
    assert.ok(normalizeMacStep({ kind: 'open', url: 'javascript:alert(1)' }).error);
    assert.ok(normalizeMacStep({ kind: 'open', url: 'example.com' }).error);
    assert.ok(normalizeMacStep({ kind: 'open', app: '/Applications/Safari.app' }).error);
    assert.ok(normalizeMacStep({ kind: 'open' }).error);
});
test('press needs a number; click needs coordinates; type is bounded', () => {
    assert.deepStrictEqual(normalizeMacStep({ kind: 'press', n: 3 }), { kind: 'press', double: false, n: 3 });
    assert.ok(normalizeMacStep({ kind: 'press' }).error);
    assert.ok(normalizeMacStep({ kind: 'press', n: 0 }).error);
    assert.ok(normalizeMacStep({ kind: 'press', n: 1.5 }).error);
    assert.deepStrictEqual(normalizeMacStep({ kind: 'click', x: 10, y: 20, double: true }), { kind: 'click', x: 10, y: 20, double: true });
    assert.ok(normalizeMacStep({ kind: 'click', x: -1, y: 20 }).error);
    assert.deepStrictEqual(normalizeMacStep({ kind: 'type', text: 'hi', n: 2, clear: true }), { kind: 'type', text: 'hi', clear: true, n: 2 });
    assert.ok(normalizeMacStep({ kind: 'type', text: '' }).error);
    assert.ok(normalizeMacStep({ kind: 'type', text: 'x'.repeat(2001) }).error);
});
test('keys: allowlist, and no force-quit, lock, log-out or Spotlight combos', () => {
    assert.deepStrictEqual(normalizeMacStep({ kind: 'key', key: 'cmd+s' }), { kind: 'key', key: 's', modifiers: ['meta'], label: 'cmd+s' });
    for (const k of ['cmd+option+esc', 'ctrl+cmd+q', 'shift+cmd+q', 'cmd+space', 'ctrl+space']) {
        assert.ok(normalizeMacStep({ kind: 'key', key: k }).error, k);
    }
    assert.ok(normalizeMacStep({ kind: 'key', key: 'F5' }).error);
});
test('menu paths split on > and are bounded; scroll direction is checked', () => {
    assert.deepStrictEqual(normalizeMacStep({ kind: 'menu', path: 'File > Export…' }), { kind: 'menu', path: ['File', 'Export…'] });
    assert.ok(normalizeMacStep({ kind: 'menu', path: '' }).error);
    assert.ok(normalizeMacStep({ kind: 'menu', path: 'a>b>c>d>e>f' }).error);
    assert.deepStrictEqual(normalizeMacStep({ kind: 'scroll' }), { kind: 'scroll', direction: 'down' });
    assert.ok(normalizeMacStep({ kind: 'scroll', direction: 'left' }).error);
    assert.ok(normalizeMacStep({ kind: 'drag' }).error);
});

// ── renderer: vocabulary ─────────────────────────────────────────────────
test('other-app asks summon the group', () => {
    for (const s of [
        'open safari and go to amazon.com',
        'log in to my bank website and download the statement',
        'use chrome to look up flights',
        'open Numbers and make a budget table',
        'can you do this on my mac for me',
        'add the book to my cart',
        'go to github.com and star the repo',
        'open the Weather app'
    ]) assert.ok(MacTools.domainMatch(s), s);
});
test('ordinary asks do not', () => {
    for (const s of [
        'what is on my calendar tomorrow',
        'summarize my notes about the trip',
        'add a task to buy milk',
        'how many numbers are in this list'
    ]) assert.ok(!MacTools.domainMatch(s), s);
});

// ── renderer: M4 approvals ───────────────────────────────────────────────
const none = () => false;
const amazon = (k) => k === 'mac_site:amazon.com';
const shop = () => ({
    app: 'Safari', bundleId: 'com.apple.Safari', url: 'https://www.amazon.com/cart',
    marks: [
        { n: 1, role: 'button', label: 'Place your order' },
        { n: 2, role: 'link', label: 'Product details' },
        { n: 3, role: 'text field', label: 'Search' },
        { n: 4, role: 'button', label: 'Accept all cookies' },
        { n: 5, role: 'button', label: 'Add to Cart' }
    ]
});

test('sites: host without www; parents down to two labels cover it', () => {
    assert.strictEqual(MacTools.siteOf('https://www.Amazon.com/cart?x=1'), 'amazon.com');
    assert.strictEqual(MacTools.siteOf('file:///etc/hosts'), null);
    assert.deepStrictEqual(MacTools.siteKeys('smile.amazon.com'), ['mac_site:smile.amazon.com', 'mac_site:amazon.com']);
});
test('a website not approved before asks, once per site', () => {
    MacTools._snap = shop();
    const open = MacTools.approvalNeeded({ action: 'open', url: 'https://www.amazon.com/' }, none);
    assert.strictEqual(open.site, 'amazon.com');
    assert.strictEqual(open.grantKey, 'mac_site:amazon.com');
    assert.ok(!open.sensitive);
    assert.strictEqual(MacTools.approvalNeeded({ action: 'open', url: 'https://smile.amazon.com/x' }, amazon), null, 'a subdomain rides the approval');
    assert.strictEqual(MacTools.approvalNeeded({ action: 'click', element: 2 }, none).site, 'amazon.com', 'a click on a page of an unapproved site asks');
    assert.strictEqual(MacTools.approvalNeeded({ action: 'scroll' }, none), null, 'scrolling is reading');
    assert.ok(MacTools.approvalNeeded({ action: 'open', url: 'https://checkout.stripe.com/pay' }, amazon).site, 'another site asks');
});
test('on an approved site ordinary steps run without asking', () => {
    MacTools._snap = shop();
    assert.strictEqual(MacTools.approvalNeeded({ action: 'click', element: 2 }, amazon), null);
    assert.strictEqual(MacTools.approvalNeeded({ action: 'click', element: 4 }, amazon), null, 'cookie banners are not sensitive');
    assert.strictEqual(MacTools.approvalNeeded({ action: 'click', element: 5 }, amazon), null, 'adding to a cart is not buying');
    assert.strictEqual(MacTools.approvalNeeded({ action: 'type', element: 3, text: 'running shoes' }, amazon), null);
    assert.strictEqual(MacTools.approvalNeeded({ action: 'press', key: 'Enter' }, amazon), null);
    assert.strictEqual(MacTools.approvalNeeded({ action: 'click', x: 5, y: 5 }, amazon, 'Product details'), null);
});
test('sensitive steps ask every time, even on an approved site', () => {
    MacTools._snap = shop();
    const order = MacTools.approvalNeeded({ action: 'click', element: 1 }, amazon);
    assert.ok(order.sensitive && !order.site, 'order click');
    assert.ok(MacTools.approvalNeeded({ action: 'click', x: 5, y: 5 }, amazon, 'Buy now').sensitive, 'label under a position click');
    assert.ok(MacTools.approvalNeeded({ action: 'click', x: 5, y: 5 }, amazon, '').sensitive, 'unreadable point in a browser');
    assert.ok(MacTools.approvalNeeded({ action: 'type', text: '4111 1111 1111 1111' }, amazon).sensitive);
    assert.ok(MacTools.approvalNeeded({ action: 'type', text: '123-45-6789' }, amazon).sensitive);
    const both = MacTools.approvalNeeded({ action: 'click', element: 1 }, none);
    assert.ok(both.site && both.sensitive, 'new site and sensitive together');
    for (const label of ['Confirm order', 'Proceed to checkout', 'Pay $42.00', 'Send', 'Delete account', 'Sign in', 'Subscribe', 'Complete purchase']) {
        MacTools._snap.marks[0].label = label;
        assert.ok(MacTools.approvalNeeded({ action: 'click', element: 1 }, amazon)?.sensitive, label);
    }
});
test('in a local app only sensitive labels, menus and card text ask', () => {
    MacTools._snap = {
        app: 'Numbers', bundleId: 'com.apple.iWork.Numbers', url: null,
        marks: [{ n: 1, role: 'button', label: 'Add Sheet' }, { n: 2, role: 'button', label: 'Delete' }]
    };
    assert.strictEqual(MacTools.approvalNeeded({ action: 'click', element: 1 }, none), null);
    assert.ok(MacTools.approvalNeeded({ action: 'click', element: 2 }, none).sensitive);
    assert.strictEqual(MacTools.approvalNeeded({ action: 'type', text: 'Budget 2026' }, none), null);
    assert.strictEqual(MacTools.approvalNeeded({ action: 'press', key: 'Enter' }, none), null);
    assert.ok(MacTools.approvalNeeded({ action: 'menu', menu: 'Edit > Delete' }, none).sensitive);
    assert.strictEqual(MacTools.approvalNeeded({ action: 'menu', menu: 'File > Export To > PDF…' }, none), null);
    assert.strictEqual(MacTools.approvalNeeded({ action: 'open', app: 'Numbers' }, none), null, 'opening an app does not ask');
});
test('Enter in a messaging app sends the message, so it asks', () => {
    MacTools._snap = { app: 'Messages', bundleId: 'com.apple.MobileSMS', url: null, marks: [] };
    assert.ok(MacTools.approvalNeeded({ action: 'press', key: 'Return' }, none).sensitive);
    assert.strictEqual(MacTools.approvalNeeded({ action: 'type', text: 'on my way' }, none), null);
});

// ── renderer: consent line ───────────────────────────────────────────────
test('consent line names the element, the app and the site, escaped', () => {
    MacTools._snap = {
        app: 'Safari', bundleId: 'com.apple.Safari', url: 'https://shop.example.com/cart',
        marks: [{ n: 1, role: 'button', label: 'Buy <now>' }]
    };
    const html = MacTools.describeAct({ action: 'click', element: 1 });
    assert.ok(html.includes('Buy &lt;now&gt;') && html.includes('in Safari (shop.example.com)'), html);
    assert.ok(MacTools.describeAct({ action: 'open', url: 'https://a.com/?q=<x>', app: 'Chrome' }).includes('https://a.com/?q=&lt;x&gt;'));
    assert.ok(MacTools.describeAct({ action: 'menu', menu: 'File > Export…' }).includes('File &gt; Export…'));
});


// ── renderer: B1 one browser per task ────────────────────────────────────
test('account and own-browser asks route to the user\'s own browser', () => {
    for (const t of [
        'open browser, go to amazon, find the price of mac neo and add to cart',
        'add the blue one to my cart', 'what is in my amazon cart', 'check out on target.com',
        'track my order from amazon', 'log in to my bank and download the statement',
        'open chrome and go to linkedin', 'use my browser to book the table', 'buy the cheapest one',
        'in safari open my account page', 'I\'m signed in already, just reorder the coffee',
    ]) assert.strictEqual(MacTools.browserRoute(t), 'own', t);
});
test('public reading does not force a browser', () => {
    for (const t of [
        'summarize the top stories on techcrunch.com', 'what does the apple.com page say about the neo',
        'find ten staff engineer jobs and their links', 'go to example.com and read the pricing',
        'what browser should I use', '', null,
    ]) assert.strictEqual(MacTools.browserRoute(t), null, String(t));
});

console.log(`mac-control: ${passed} passed${process.exitCode ? ', with failures' : ''}`);
