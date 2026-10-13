'use strict';
const assert = require('node:assert/strict');
const { LLMScheduler } = require('../js/main/llm-scheduler');
const { createLLMResourceResolver, endpointIdentity } = require('../js/main/llm-resource');

function clock() {
    let now = 1000, id = 0;
    const timers = new Map();
    return { now: () => now,
        setTimer: (fn, ms) => { timers.set(++id, { at: now + ms, fn }); return id; },
        clearTimer: id => timers.delete(id),
        advance(ms) {
            const until = now + ms;
            for (;;) {
                const first = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
                if (!first || first[1].at > until) break;
                now = first[1].at;
                timers.delete(first[0]);
                first[1].fn();
            }
            now = until;
        } };
}
const tick = () => Promise.resolve();
const local = { key: 'local-inference', kind: 'local', capacity: 1 };
const server = (key, capacity = 1) => ({ key, kind: 'server', capacity });

async function run() {
    // An existing background dispatch finishes; the user jumps ahead of the
    // next one. Capture/check calls in the same turn bypass ambient cooldown.
    {
        const time = clock(), s = new LLMScheduler(time), order = [];
        const inFlight = await s.acquire('background', local);
        const ambient = s.acquire('background', local).then(p => { order.push('ambient'); return p; });
        const answer = s.acquire('interactive', local).then(p => { order.push('answer'); return p; });
        inFlight.release();
        const p = await answer;
        assert.deepEqual(order, ['answer']);
        p.release();
        const check = await s.acquire('interactive', local);
        assert.equal(check.waitMs, 0, 'reply dependency does not wait twenty seconds');
        check.release();
        time.advance(19999); await tick();
        assert.deepEqual(order, ['answer']);
        time.advance(1);
        const bg = await ambient;
        assert.equal(bg.waitMs, 20000);
        bg.release(); bg.release();
        assert.equal(s.snapshot().backgroundActive, 0, 'release is idempotent');
        assert.equal(s.snapshot().interactiveActive, 0);
    }
    // Remote capacity is independent of the local machine and other endpoints.
    {
        const time = clock(), s = new LLMScheduler(time);
        const a = await s.acquire('interactive', local);
        const b = await s.acquire('interactive', server('b'));
        const c = await s.acquire('interactive', server('c'));
        const cloud = await s.acquire('interactive', null);
        assert.equal(cloud.waitMs, 0);
        assert.equal(s.snapshot().interactiveActive, 3);
        for (const permit of [a, b, c, cloud]) permit.release();
        const first = await s.acquire('background', server('parallel', 2));
        const user = await s.acquire('interactive', server('parallel', 2));
        let nextRan = false;
        const next = s.acquire('background', server('parallel', 2)).then(p => { nextRan = true; return p; });
        first.release(); await tick();
        assert.equal(nextRan, false, 'no new ambient dispatch alongside an active user turn');
        user.release();
        time.advance(20000);
        (await next).release();
    }
    // Cancellation removes queued dispatches without consuming a permit.
    {
        const time = clock(), s = new LLMScheduler(time);
        const active = await s.acquire('interactive', local);
        const controller = new AbortController();
        const queued = s.acquire('interactive', local, { signal: controller.signal });
        const rejected = assert.rejects(queued, { name: 'AbortError', code: 'ABORT_ERR' });
        controller.abort(); await rejected;
        assert.equal(s.snapshot().cancelledQueued, 1);
        assert.equal(s.snapshot().resources[0].interactiveQueued, 0);
        const one = s.acquire('interactive', local, { turnId: 'stopped' });
        const two = s.acquire('interactive', local, { turnId: 'stopped' });
        const checks = [assert.rejects(one, { name: 'AbortError' }), assert.rejects(two, { name: 'AbortError' })];
        assert.equal(s.cancelQueued('stopped'), 2);
        await Promise.all(checks);
        active.release();
        assert.equal(s.snapshot().interactiveRun, 1, 'cancelled dependencies never dispatch');
        assert.equal(s.snapshot().interactiveActive, 0);
        const aborted = new AbortController(); aborted.abort();
        await assert.rejects(s.acquire('interactive', local, { signal: aborted.signal }), { name: 'AbortError' });
    }
    // Continuous user traffic cannot starve a background job indefinitely.
    {
        const time = clock(), s = new LLMScheduler(time), order = [];
        const first = await s.acquire('interactive', local);
        const bg = s.acquire('background', local).then(p => { order.push('bg'); return p; });
        const foreground = s.acquire('interactive', local).then(p => { order.push('user'); return p; });
        time.advance(60000);
        first.release();
        const p = await bg;
        assert.deepEqual(order, ['bg']);
        p.release();
        (await foreground).release();
        assert.deepEqual(order, ['bg', 'user']);
    }
    // Resolve the actual routing; localhost, this Mac's LAN address and its
    // DNS alias share hardware. A different private IP is a remote resource.
    {
        let lookups = 0;
        const resolve = createLLMResourceResolver({
            networkInterfaces: () => ({ en1: [{ address: '192.168.1.11' }, { address: 'fe80::123%en1' }] }),
            hostname: () => 'studio.local',
            lookup: async host => { lookups++; return [{ address: host === 'my-alias' ? '192.168.1.11' : '192.168.1.50' }]; }
        });
        for (const host of ['127.0.0.1', '127.0.0.2', '[::1]', 'localhost', '192.168.1.11', 'studio.local', 'studio', 'my-alias']) {
            const r = await resolve({ engine: 'server', baseUrl: `http://${host}:8080/v1` });
            assert.equal(r.key, local.key, host);
            assert.equal(r.capacity, 1);
        }
        await resolve({ engine: 'server', baseUrl: 'http://my-alias:8080' });
        assert.equal(lookups, 1, 'hostname lookup is cached');
        const remote = await resolve({ engine: 'server', baseUrl: 'http://192.168.1.50:8080/v1' });
        assert.equal(remote.kind, 'server');
        assert.notEqual(remote.key, local.key);
        assert.equal(remote.capacity, 1);
        assert.equal((await resolve({ engine: 'server', baseUrl: 'http://127.inference.example:8080/v1' })).kind,
            'server', 'a domain beginning with 127 is not a loopback address');
        const a = endpointIdentity('http://user:secret@192.168.1.50:8080/v1/?token=secret');
        const b = endpointIdentity('http://192.168.1.50:8080/chat/completions');
        assert.equal(a.id, b.id, 'API-root variants identify the same service');
        assert.ok(!JSON.stringify(a).includes('secret'));
        assert.notEqual(b.id, endpointIdentity('http://192.168.1.50:8080/proxy/v1').id, 'proxy routes stay distinct');
        assert.equal(await resolve({ engine: 'server', baseUrl: 'invalid' }), null);
        for (const engine of ['openai', 'anthropic', 'anjadhe']) {
            assert.equal(await resolve({ engine }), null, engine + ' retains its provider limits');
            assert.equal(await resolve({}, { provider: engine }), null);
        }
        const custom = await resolve({ providerOverride: 'custom', engine: 'openai', baseUrl: 'http://localhost:8080' },
            { customBaseUrl: 'http://192.168.1.50:8080' });
        assert.equal(custom.kind, 'server', 'provider override uses the legacy endpoint, matching transport');
        assert.equal((await resolve({ engine: 'openai', providerOverride: 'local' })).key, local.key);
        assert.equal((await resolve({ engine: 'openai', providerOverride: 'remote' }, { provider: 'local' })).key,
            local.key, 'legacy overrides follow the selected provider rather than entry routing');
        const policies = { 'http://localhost:8080': { local: false, concurrency: 3, resourceGroup: 'proxy' },
            'http://192.168.1.50:8080': { concurrency: 3, resourceGroup: 'proxy' } };
        const proxy = await resolve({ engine: 'server', baseUrl: 'http://localhost:8080/v1' }, { policies });
        const alias = await resolve({ engine: 'server', baseUrl: 'http://192.168.1.50:8080/v1' }, { policies });
        assert.equal(proxy.key, alias.key, 'an operator can identify aliases or a local proxy');
        assert.equal(proxy.capacity, 3);
        assert.equal(proxy.kind, 'server');
        const unavailable = createLLMResourceResolver({
            networkInterfaces: () => { throw new Error('unavailable'); }, hostname: () => 'test',
            lookup: async () => []
        });
        assert.equal((await unavailable({ engine: 'server', baseUrl: 'http://localhost:8080' })).key, local.key);
        assert.equal((await unavailable({ engine: 'server', baseUrl: 'http://192.168.1.50:8080' })).kind,
            'server', 'unavailable interface hints do not block dispatch');
    }
    console.log('LLM scheduler: endpoint isolation, interactive dependencies, cooldown, fairness, cancellation, locality and frontier isolation passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
