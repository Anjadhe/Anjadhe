'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');
const os = require('node:os');

const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
const address = value => String(value || '').toLowerCase().replace(/^\[|\]$/g, '')
    .split('%')[0].replace(/^::ffff:/, '');
const loopback = value => value === '::1' || (net.isIP(value) === 4 && value.startsWith('127.'));

function endpointIdentity(baseUrl) {
    try {
        const url = new URL(baseUrl);
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        let root = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
        if (root === '/v1') root = '';
        // Credentials and query values never become resource/telemetry labels.
        // A backend multiplexed behind a path keeps a distinct identity.
        const canonical = url.origin + root;
        return { id: 'server-' + hash(canonical), canonical, host: address(url.hostname) };
    } catch { return null; }
}

function createLLMResourceResolver({ networkInterfaces = os.networkInterfaces,
    hostname = os.hostname, lookup = host => dns.lookup(host, { all: true }),
    now = Date.now, timeoutMs = 500 } = {}) {
    const names = new Map();
    const ownAddresses = () => {
        try { return new Set(Object.values(networkInterfaces()).flat()
            .filter(Boolean).map(item => address(item.address))); }
        catch { return new Set(); } // missing locality hints must not disable a working transport
    };
    async function onThisMac(host) {
        if (host === 'localhost' || loopback(host)) return true;
        const own = ownAddresses();
        if (own.has(host)) return true;
        if (net.isIP(host)) return false;
        const localName = String(hostname()).toLowerCase().replace(/\.$/, '');
        if (host === localName || host === localName.replace(/\.local$/, '')) return true;
        let cached = names.get(host);
        if (!cached || cached.until <= now()) {
            let timer;
            const promise = Promise.race([
                Promise.resolve().then(() => lookup(host)).catch(() => []),
                new Promise(resolve => { timer = setTimeout(() => resolve([]), timeoutMs); })
            ]).then(rows => { clearTimeout(timer); return rows; });
            cached = { until: now() + 60000, promise };
            names.set(host, cached);
            if (names.size > 128) names.delete(names.keys().next().value);
        }
        const rows = await cached.promise;
        return rows.some(row => loopback(address(row.address)) || own.has(address(row.address)));
    }

    return async function resolve(params = {}, { provider = 'local', customBaseUrl = '', policies = {} } = {}) {
        policies = policies && typeof policies === 'object' ? policies : {};
        const override = params.providerOverride;
        const engine = override === 'local' ? 'llamacpp' : override === 'custom' ? 'server'
            : (!override && params.engine) || (provider === 'custom' ? 'server' : provider === 'local' ? 'llamacpp' : provider);
        // Official providers retain their existing adapter/limiter behavior.
        if (['openai', 'anthropic', 'anjadhe'].includes(engine)) return null;
        if (engine !== 'server') return { key: 'local-inference', endpointId: 'managed-llamacpp',
            kind: 'local', capacity: 1 };
        const identity = endpointIdentity(override || !params.engine
            ? customBaseUrl : params.baseUrl || customBaseUrl);
        if (!identity) return null; // the existing transport reports invalid configuration
        const policy = policies[identity.id] || policies[identity.canonical] || {};
        const local = typeof policy.local === 'boolean' ? policy.local : await onThisMac(identity.host);
        return { endpointId: identity.id, kind: local ? 'local' : 'server',
            key: local ? 'local-inference' : policy.resourceGroup
                ? 'server-group-' + hash(String(policy.resourceGroup)) : identity.id,
            capacity: local ? 1 : Math.max(1, Math.min(8, Math.trunc(policy.concurrency) || 1)) };
    };
}

module.exports = { createLLMResourceResolver, endpointIdentity };
