'use strict';
// Pins js/main/deep-link.js: the anjadhe:// grammar, the http(s)-only rule,
// and the round trip with the link the Chrome extension builds.
const assert = require('assert');
const { parseDeepLink, buildReadLink, deepLinkFromArgv } = require('../js/main/deep-link');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok', name); };

t('read link with url and title', () => {
    const r = parseDeepLink('anjadhe://read?url=https%3A%2F%2Fexample.com%2Fa%2Fb%3Fx%3D1&title=Hello%20World');
    assert.deepStrictEqual(r, { action: 'read', url: 'https://example.com/a/b?x=1', title: 'Hello World' });
});
t('title is optional', () => {
    assert.deepStrictEqual(parseDeepLink('anjadhe://read?url=http://news.example.org/story'),
        { action: 'read', url: 'http://news.example.org/story', title: '' });
});
t('alternate spellings of the action', () => {
    assert.strictEqual(parseDeepLink('anjadhe:read?url=https://a.com/x').url, 'https://a.com/x');
    assert.strictEqual(parseDeepLink('anjadhe:///read?url=https://a.com/x').url, 'https://a.com/x');
    assert.strictEqual(parseDeepLink('ANJADHE://READ?url=https://a.com/x').url, 'https://a.com/x');
});
t('only http(s) targets pass', () => {
    assert.strictEqual(parseDeepLink('anjadhe://read?url=file:///etc/passwd'), null);
    assert.strictEqual(parseDeepLink('anjadhe://read?url=javascript:alert(1)'), null);
    assert.strictEqual(parseDeepLink('anjadhe://read?url=chrome://settings'), null);
    assert.strictEqual(parseDeepLink('anjadhe://read?url=not a url'), null);
    assert.strictEqual(parseDeepLink('anjadhe://read'), null);
});
t('unknown actions and other schemes are refused', () => {
    assert.strictEqual(parseDeepLink('anjadhe://delete?url=https://a.com'), null);
    assert.strictEqual(parseDeepLink('https://read?url=https://a.com'), null);
    assert.strictEqual(parseDeepLink(''), null);
    assert.strictEqual(parseDeepLink(null), null);
});
t('title is whitespace-collapsed and capped', () => {
    const r = parseDeepLink('anjadhe://read?url=https://a.com&title=' + encodeURIComponent('  a \n b  ' + 'x'.repeat(500)));
    assert.ok(r.title.startsWith('a b '));
    assert.strictEqual(r.title.length, 300);
});
t('round trip with the extension builder', () => {
    const link = buildReadLink('https://www.ft.com/content/abc?utm=1', 'Markets fall | FT');
    const r = parseDeepLink(link);
    assert.strictEqual(r.url, 'https://www.ft.com/content/abc?utm=1');
    assert.strictEqual(r.title, 'Markets fall | FT');
});
t('argv scan', () => {
    assert.strictEqual(deepLinkFromArgv(['/app', '--flag', 'anjadhe://read?url=https://a.com']), 'anjadhe://read?url=https://a.com');
    assert.strictEqual(deepLinkFromArgv(['/app', '--flag']), null);
});
console.log(`deep-link: ${n} tests passed`);
