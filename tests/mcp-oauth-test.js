// Exercise browser callback, PKCE, encrypted persistence and refresh races.
const assert = require('node:assert/strict');
const { createHash, randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { MCPOAuth, secureUrl } = require('../js/main/mcp-oauth');
const realFetch = globalThis.fetch;
const key = randomBytes(32);
const secrets = {
    isEncryptionAvailable: () => true,
    encryptString(text) {
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
        const bytes = Buffer.concat([cipher.update(text), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString(bytes) {
        const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        cipher.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString();
    }
};
const origin = 'https://mcp.example.test';
const metadata = { issuer: origin, authorization_endpoint: origin + '/authorize',
    token_endpoint: origin + '/token', registration_endpoint: origin + '/register',
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['default'] };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
function fixture(options = {}) {
    const records = new Map([['notion', { name: 'notion', url: origin + '/mcp', auth: 'oauth', enabled: true }]]);
    const calls = [];
    let authorization, registration, callbackUrl;
    const fetch = async (url, init = {}) => {
        assert.equal(init.redirect, 'error');
        calls.push({ url, init });
        if (url === origin + '/mcp') return json({}, 401, { 'www-authenticate': `Bearer resource_metadata="${origin}/resource"` });
        if (url === origin + '/resource') return json({ resource: origin + '/mcp', authorization_servers: [origin], scopes_supported: ['default'], ...options.resource });
        if (url === origin + '/.well-known/oauth-authorization-server') return json({ ...metadata, ...options.metadata });
        if (url === origin + '/register') {
            registration = JSON.parse(init.body);
            assert.equal(registration.token_endpoint_auth_method, 'none');
            assert.match(registration.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
            return json({ client_id: 'desktop-client', token_endpoint_auth_method: 'none' });
        }
        if (url === origin + '/token') {
            const params = new URLSearchParams(init.body);
            assert.equal(params.get('client_id'), 'desktop-client');
            assert.equal(params.get('resource'), origin + '/mcp');
            if (params.get('grant_type') === 'authorization_code') {
                assert.equal(params.get('code'), 'one-time-code');
                assert.equal(params.get('redirect_uri'), registration.redirect_uris[0]);
                assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
                return json({ access_token: 'initial-secret', refresh_token: 'refresh-secret', token_type: 'Bearer', expires_in: 3600 });
            }
            if (options.refresh) return options.refresh(params);
            return json({ access_token: 'rotated-secret', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600 });
        }
        throw new Error('Unexpected URL: ' + url);
    };
    const openExternal = async value => {
        authorization = new URL(value);
        assert.equal(authorization.origin, origin);
        assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(authorization.searchParams.get('resource'), origin + '/mcp');
        const url = new URL(authorization.searchParams.get('redirect_uri'));
        callbackUrl = url.href;
        url.searchParams.set('state', authorization.searchParams.get('state'));
        url.searchParams.set('code', 'one-time-code');
        url.searchParams.set('iss', origin);
        if (options.browser) return options.browser(url, auth);
        // Invalid callbacks must not settle or consume the valid callback.
        const invalid = new URL(url); invalid.searchParams.set('state', 'wrong');
        assert.equal((await realFetch(invalid)).status, 400);
        invalid.searchParams.set('state', url.searchParams.get('state')); invalid.searchParams.set('iss', 'https://other.test');
        assert.equal((await realFetch(invalid)).status, 400);
        const response = await realFetch(url);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.match(response.headers.get('content-type'), /text\/html/);
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
        const html = await response.text();
        assert.doesNotMatch(html, /one-time-code|initial-secret|<script|<link|<img/);
        assert.match(html, /Authorization received/);
        assert.match(html, /served by nenva on this Mac/);
        const styles = html.match(/<style>([\s\S]*?)<\/style>/)[1];
        assert.ok(response.headers.get('content-security-policy').includes(`'sha256-${createHash('sha256').update(styles).digest('base64')}'`), 'the restrictive policy allows the exact local stylesheet');
    };
    const dependencies = { read: name => records.get(name), write: (name, data) => {
        const record = records.get(name);
        if (record) { if (data) record.oauth = data; else delete record.oauth; }
    }, secrets, openExternal, fetch, timeoutMs: options.timeoutMs || 3000 };
    const auth = new MCPOAuth(dependencies);
    return { auth, records, calls, dependencies, get callbackUrl() { return callbackUrl; } };
}

async function run() {
    for (const url of ['http://mcp.test', 'https://user:pass@mcp.test', 'https://mcp.test/#secret', 'file:///tmp/x']) assert.throws(() => secureUrl(url));
    const f = fixture();
    assert.equal(f.auth.status('notion'), 'disconnected');
    await f.auth.authorize('notion');
    assert.equal(f.auth.status('notion'), 'connected');
    assert.doesNotMatch(JSON.stringify([...f.records]), /initial-secret|refresh-secret|one-time-code/);
    assert.equal(await f.auth.accessToken('notion'), 'initial-secret');
    const restarted = new MCPOAuth(f.dependencies);
    assert.equal(await restarted.accessToken('notion'), 'initial-secret', 'restart reuses encrypted credentials without browser sign-in');
    const count = f.calls.length;
    assert.deepEqual(await Promise.all([restarted.accessToken('notion', 'initial-secret'), restarted.accessToken('notion', 'initial-secret')]), ['rotated-secret', 'rotated-secret']);
    assert.equal(f.calls.length - count, 1, 'simultaneous 401s refresh only once');
    assert.equal(await restarted.accessToken('notion', 'initial-secret'), 'rotated-secret', 'late 401 reuses rotated token');
    assert.equal(restarted._load('notion').refresh_token, 'rotated-refresh');
    restarted.disconnect('notion');
    assert.equal(restarted.status('notion'), 'disconnected');
    await assert.rejects(restarted.accessToken('notion'), /Connect/);
    await assert.rejects(realFetch(f.callbackUrl), /fetch failed/, 'callback listener closed');

    const invalid = fixture({ refresh: () => json({ error: 'invalid_grant', error_description: 'secret' }, 400) });
    await invalid.auth.authorize('notion');
    await assert.rejects(invalid.auth.accessToken('notion', 'initial-secret'), /revoked/);
    assert.equal(invalid.records.get('notion').oauth, undefined);

    const offline = fixture({ refresh: () => json({ error: 'outage' }, 503) });
    await offline.auth.authorize('notion');
    await assert.rejects(offline.auth.accessToken('notion', 'initial-secret'), /503/);
    assert.ok(offline.records.get('notion').oauth, 'transient failures preserve refresh credentials');

    const expired = fixture();
    await expired.auth.authorize('notion');
    expired.auth._save('notion', { ...expired.auth._load('notion'), expiresAt: Date.now() - 1 }, 0);
    assert.equal(await expired.auth.accessToken('notion'), 'rotated-secret', 'expired access tokens refresh before any tool request');
    expired.auth._save('notion', { ...expired.auth._load('notion'), refresh_token: null, expiresAt: Date.now() - 1 }, 0);
    await assert.rejects(expired.auth.accessToken('notion'), /expired/);

    let finishRefresh;
    const racing = fixture({ refresh: () => new Promise(resolve => { finishRefresh = resolve; }) });
    await racing.auth.authorize('notion');
    const refreshing = racing.auth.accessToken('notion', 'initial-secret');
    racing.auth.disconnect('notion');
    finishRefresh(json({ access_token: 'late-token', token_type: 'Bearer' }));
    await assert.rejects(refreshing, /cancelled/);
    assert.equal(racing.records.get('notion').oauth, undefined, 'late refresh cannot resurrect disconnected credentials');

    const cancelled = fixture({ browser: (url, auth) => auth.cancel('notion') });
    await assert.rejects(cancelled.auth.authorize('notion'), /cancelled/);
    assert.equal(cancelled.auth.pending.size, 0);
    assert.equal(cancelled.records.get('notion').oauth, undefined);
    const denied = fixture({ browser: async url => { url.searchParams.delete('code'); url.searchParams.set('error', 'access_denied'); await realFetch(url); } });
    await assert.rejects(denied.auth.authorize('notion'), /declined/);
    const timed = fixture({ timeoutMs: 100, browser: () => {} });
    await assert.rejects(timed.auth.authorize('notion'), /timed out/);
    const mismatch = fixture({ resource: { resource: 'https://unrelated.test/mcp' } });
    await assert.rejects(mismatch.auth.authorize('notion'), /does not match/);
    const downgrade = fixture({ metadata: { token_endpoint: 'http://insecure.test/token' } });
    await assert.rejects(downgrade.auth.authorize('notion'), /HTTPS/);
    const noRegistration = fixture({ metadata: { registration_endpoint: undefined } });
    await assert.rejects(noRegistration.auth.authorize('notion'), /registered OAuth client/);
    const confidential = fixture({ metadata: { token_endpoint_auth_methods_supported: ['client_secret_post'] } });
    await assert.rejects(confidential.auth.authorize('notion'), /without a client secret/, 'Slack-specific PKCE exception never applies to other providers');
    const noEncryption = fixture();
    noEncryption.auth.secrets = { isEncryptionAvailable: () => false };
    await assert.rejects(noEncryption.auth.authorize('notion'), /Secure credential storage/);
    assert.equal(noEncryption.calls.length, 0);
    const brokenEncryption = fixture();
    brokenEncryption.records.get('notion').oauth = { enc: 'not-valid' };
    assert.equal(brokenEncryption.auth.status('notion'), 'reconnect');
    assert.ok(brokenEncryption.records.get('notion').oauth, 'unreadable blobs are preserved for recovery');
    console.log('mcp-oauth-test: authorization, refresh, cancellation and credential boundaries passed');
}

run().catch(e => { console.error(e); process.exitCode = 1; });
