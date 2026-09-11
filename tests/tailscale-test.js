'use strict';
// Pins the pure half of js/main/tailscale.js: reading the relay's public
// wss URL out of a `tailscale serve status --json` ServeConfig, and picking
// the Funnel port when 443 is already taken.
const assert = require('assert');
const { funnelUrlFor, pickFunnelPort, targetPort } = require('../js/main/tailscale');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok', name); };
const HOST = 'rams-macbook-pro.tailb73d77.ts.net';
const cfg = (port, target, funnel = true) => ({
    TCP: { [String(port)]: { HTTPS: true } },
    Web: { [`${HOST}:${port}`]: { Handlers: { '/': { Proxy: target } } } },
    AllowFunnel: funnel ? { [`${HOST}:${port}`]: true } : {},
});

t('proxy target port parsing', () => {
    assert.strictEqual(targetPort('http://127.0.0.1:18436'), 18436);
    assert.strictEqual(targetPort('localhost:18436'), 18436);
    assert.strictEqual(targetPort('http://127.0.0.1:18436/'), 18436);
    assert.strictEqual(targetPort('18436'), 18436);
    assert.strictEqual(targetPort(null), 0);
});
t('funnel on 443 → wss://host with no port', () => {
    assert.strictEqual(funnelUrlFor(cfg(443, 'http://127.0.0.1:18436'), 18436), `wss://${HOST}`);
});
t('funnel on 8443 keeps the port', () => {
    assert.strictEqual(funnelUrlFor(cfg(8443, 'http://127.0.0.1:18436'), 18436), `wss://${HOST}:8443`);
});
t('tailnet-only serve (no AllowFunnel) is not a phone path', () => {
    assert.strictEqual(funnelUrlFor(cfg(443, 'http://127.0.0.1:18436', false), 18436), null);
});
t('someone else’s service on the port is not ours', () => {
    assert.strictEqual(funnelUrlFor(cfg(443, 'http://127.0.0.1:7777'), 18436), null);
});
t('empty / missing config', () => {
    assert.strictEqual(funnelUrlFor({}, 18436), null);
    assert.strictEqual(funnelUrlFor(null, 18436), null);
    assert.strictEqual(funnelUrlFor(cfg(443, 'http://127.0.0.1:18436'), 0), null);
});
t('a handler under a sub-path is not the relay', () => {
    const c = { Web: { [`${HOST}:443`]: { Handlers: { '/relay': { Proxy: 'http://127.0.0.1:18436' } } } }, AllowFunnel: { [`${HOST}:443`]: true } };
    assert.strictEqual(funnelUrlFor(c, 18436), null);
});
t('pick 443 on an empty config', () => {
    assert.strictEqual(pickFunnelPort({}, 18436), 443);
});
t('pick 443 when it already carries our relay', () => {
    assert.strictEqual(pickFunnelPort(cfg(443, 'http://127.0.0.1:18436'), 18436), 443);
});
t('skip 443 when another service holds it', () => {
    assert.strictEqual(pickFunnelPort(cfg(443, 'http://127.0.0.1:7777'), 18436), 8443);
});
t('skip a raw TCP forwarder too', () => {
    const c = { TCP: { '443': { TCPForward: '127.0.0.1:22' }, '8443': { TCPForward: '127.0.0.1:23' } } };
    assert.strictEqual(pickFunnelPort(c, 18436), 10000);
});
t('all three taken → null', () => {
    const c = { Web: {}, AllowFunnel: {} };
    for (const p of [443, 8443, 10000]) c.Web[`${HOST}:${p}`] = { Handlers: { '/': { Proxy: 'http://127.0.0.1:7777' } } };
    assert.strictEqual(pickFunnelPort(c, 18436), null);
});

console.log(`\nALL TAILSCALE CHECKS PASSED (${n})\n`);
