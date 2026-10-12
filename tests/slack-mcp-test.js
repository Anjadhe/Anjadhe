// Slack's real metadata shape, registered PKCE, token quirks and connector UX.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { JSDOM } = require('jsdom');
const { MCPOAuth } = require('../js/main/mcp-oauth');
const Slack = require('../js/main/slack-mcp');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const metadata = {
    issuer: 'https://mcp.slack.com', authorization_endpoint: 'https://slack.com/oauth/v2_user/authorize',
    token_endpoint: 'https://slack.com/api/oauth.v2.user.access',
    token_endpoint_auth_methods_supported: ['client_secret_post'], code_challenge_methods_supported: ['S256']
};

async function oauthTest() {
    const record = { url: Slack.URL, auth: 'oauth', enabled: true, oauthClientId: 'legacy-per-user-id' };
    let authorizeUrl, tokens = 0, refreshError, overrideMetadata = {}, overrideResource;
    let cancelInBrowser = false;
    const auth = new MCPOAuth({
        read: () => record, write: (_, value) => { record.oauth = value; }, timeoutMs: 3000,
        secrets: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() },
        fetch: async (url, options) => {
            assert.equal(options.redirect, 'error');
            if (url === Slack.URL) return json({}, 401, { 'www-authenticate': 'Bearer resource_metadata="https://mcp.slack.com/.well-known/oauth-protected-resource"' });
            if (url === 'https://mcp.slack.com/.well-known/oauth-protected-resource') return json({
                resource: overrideResource || 'https://mcp.slack.com', authorization_servers: ['https://mcp.slack.com']
            });
            if (url === 'https://mcp.slack.com/.well-known/oauth-authorization-server') return json({ ...metadata, ...overrideMetadata });
            assert.equal(url, metadata.token_endpoint, 'no dynamic registration request');
            const body = new URLSearchParams(options.body);
            assert.equal(body.get('client_id'), '123.456');
            assert.equal(body.get('resource'), 'https://mcp.slack.com');
            assert.equal(body.has('client_secret'), false);
            tokens++;
            if (body.get('grant_type') === 'authorization_code') {
                assert.equal(body.get('redirect_uri'), Slack.REDIRECT_URI);
                assert.equal(body.get('code'), 'test-code');
                assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), authorizeUrl.searchParams.get('code_challenge'));
                return json({ ok: true, access_token: 'slack-user-token', refresh_token: 'slack-refresh', token_type: 'user', expires_in: 3600 });
            }
            assert.equal(body.get('refresh_token'), 'slack-refresh');
            if (refreshError) return json({ ok: false, error: refreshError, secret_detail: 'do-not-echo' });
            return json({ ok: true, access_token: 'slack-rotated', refresh_token: 'slack-refresh-2', token_type: 'user', expires_in: 3600 });
        },
        openExternal: async value => {
            authorizeUrl = new URL(value);
            assert.equal(authorizeUrl.origin + authorizeUrl.pathname, metadata.authorization_endpoint);
            assert.equal(authorizeUrl.searchParams.get('scope'), Slack.SCOPES.join(','));
            assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
            assert.equal(authorizeUrl.searchParams.get('redirect_uri'), Slack.REDIRECT_URI);
            assert.equal(authorizeUrl.searchParams.has('client_secret'), false);
            if (cancelInBrowser) { auth.cancel('slack'); return; }
            assert.equal(Slack.REDIRECT_URI, 'https://api.nenva.co/v1/oauth/slack/callback');
            const url = new URL(Slack.LOOPBACK_URI);
            // Hit the IPv4 loopback listener deterministically in this test.
            url.hostname = '127.0.0.1';
            url.searchParams.set('state', 'wrong'); url.searchParams.set('code', 'test-code');
            assert.equal((await fetch(url)).status, 400);
            url.searchParams.set('state', authorizeUrl.searchParams.get('state'));
            assert.equal((await fetch(url)).status, 200);
        }
    });
    assert.equal(Slack.isSlack('https://mcp.slack.com.evil.test/mcp'), false);
    assert.equal(Slack.isSlack('https://mcp.slack.com/mcp?other=1'), false);
    assert.equal(Slack.validClientId('xoxp-secret'), false);
    assert.equal(Slack.clientId(record), '123.456', 'registration belongs to nenva, not the connection record');
    process.env.NENVA_SLACK_CLIENT_ID = 'not-a-client-id';
    await assert.rejects(auth.authorize('slack'), /not available in this build/);
    process.env.NENVA_SLACK_CLIENT_ID = '123.456';
    await auth.authorize('slack');
    assert.equal(auth.status('slack'), 'connected');
    assert.equal(await auth.accessToken('slack'), 'slack-user-token');
    const before = tokens;
    assert.deepEqual(await Promise.all([auth.accessToken('slack', 'slack-user-token'), auth.accessToken('slack', 'slack-user-token')]), ['slack-rotated', 'slack-rotated']);
    assert.equal(tokens, before + 1);
    assert.equal(auth._load('slack').refresh_token, 'slack-refresh-2');
    auth.disconnect('slack');
    assert.equal(record.oauth, null);
    await assert.rejects(auth.accessToken('slack'), /Connect/);
    await auth.authorize('slack');
    refreshError = 'internal_error';
    await assert.rejects(auth.accessToken('slack', 'slack-user-token'), e => /Slack sign-in failed/.test(e.message) && !e.message.includes('do-not-echo'));
    assert.ok(record.oauth, 'transient Slack errors preserve credentials');
    refreshError = 'invalid_refresh_token';
    await assert.rejects(auth.accessToken('slack', 'slack-user-token'), /revoked/);
    assert.equal(record.oauth, null, 'HTTP-200 invalid refresh clears stale credentials');
    refreshError = null;
    cancelInBrowser = true;
    await assert.rejects(auth.authorize('slack'), /cancelled/);
    assert.equal(record.oauth, null);
    cancelInBrowser = false;
    overrideMetadata = { token_endpoint: 'https://other.test/token' };
    await assert.rejects(auth.authorize('slack'), /endpoints do not match/);
    overrideMetadata = {};
    overrideResource = 'https://other.test';
    await assert.rejects(auth.authorize('slack'), /resource does not match/);
    const manifest = JSON.parse(read('docs/slack-app-manifest.json'));
    assert.deepEqual(manifest.oauth_config.scopes.user, Slack.SCOPES);
    assert.deepEqual(manifest.oauth_config.redirect_urls, [Slack.REDIRECT_URI]);
    assert.equal(manifest.oauth_config.pkce_enabled, true);
}

async function connectorTest() {
    const dom = new JSDOM('<div id="settings-mcp-list"></div>', { runScripts: 'outside-only' });
    const w = dom.window;
    let app, modal, authorization, failList = false;
    const servers = [{ name: 'slack', url: 'https://custom.test/mcp', auth: 'oauth' }];
    const disconnected = [], unregistered = [], authorizations = [], callbacks = [];
    w.AppManager = { register: (_, value) => { app = value; } };
    w.UIUtils = { escapeHtml: value => String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;'), showToast() {} };
    w.PermissionManager = { ready: async () => {}, listGrants: () => [] };
    w.Modal = { create(value) {
        modal = value;
        const content = w.document.createElement('div');
        content.innerHTML = value.content; w.document.body.append(content);
        return { close() { content.remove(); value.onClose?.(); } };
    } };
    w.electronMCP = {
        listServers: async () => { if (failList) throw new Error('offline'); return structuredClone(servers); },
        onServersChanged: cb => callbacks.push(cb),
        addServer: async s => { servers.push({ ...s, enabled: true, tools: [], authStatus: 'disconnected' }); return { name: s.name }; },
        setEnabled: async name => { servers.find(s => s.name === name).enabled = true; return {}; },
        authorizeServer: async (...args) => {
            assert.equal(args.length, 1, 'Settings passes only the server name, no registration configuration');
            const [name] = args;
            authorizations.push(name); servers.find(s => s.name === name).authStatus = 'connecting';
            return new Promise(resolve => { authorization = resolve; });
        },
        cancelAuthorization: async name => { servers.find(s => s.name === name).authStatus = 'disconnected'; authorization({ error: 'Cancelled' }); return {}; },
        disconnectServer: async name => { disconnected.push(name); servers.find(s => s.name === name).authStatus = 'disconnected'; return {}; }
    };
    w.MCPTools = { unregisterServer: name => unregistered.push(name) };
    w.SimpleSettings = { _esc: w.UIUtils.escapeHtml, _chev: '', _tile: () => '', render() {} };
    w.eval(read('js/apps/settings/settings-app.js'));
    w.SettingsApp = app;
    app._loadMCPServers = async () => {};
    w.eval(['js/core/sources.js', 'js/core/slack-connector.js', 'js/core/simple-connectors.js'].map(read).join('\n')
        + '\nwindow.connector = SlackConnector; window.sources = Sources;');
    const connector = w.connector;
    await connector.refresh();
    assert.equal(w.sources.get('slack').mode, 'reference');
    assert.equal(w.sources.get('slack').feeds.length, 0);
    assert.match(w.SimpleSettings._connectorsHtml(), /Slack/);
    const connecting = connector.connect();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(servers[1].name, 'slack-2', 'preserve unrelated custom servers');
    assert.equal(authorizations.length, 0, 'no browser until explicit Continue');
    assert.equal(modal.title, 'Connect to Slack');
    assert.match(w.document.body.textContent, /nenva Connect/);
    assert.match(w.document.body.textContent, /one-time sign-in code/);
    assert.equal(w.document.querySelector('input'), null, 'users never enter app credentials');
    assert.doesNotMatch(w.document.body.textContent, /Client ID|PKCE|registered app/);
    modal.buttons[1].onClick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(authorizations[0], 'slack-2');
    await connector.refresh();
    assert.match(w.SimpleSettings._connectorHtml('slack'), /Cancel sign-in/);
    await w.SimpleSettings._connectorClick('slack-cancel', {});
    await connecting;
    assert.equal(connector.status().on, false);
    const retry = connector.connect();
    await new Promise(resolve => setImmediate(resolve));
    modal.onClose(); // Escape / Cancel
    await retry;
    assert.equal(authorizations.length, 1);
    servers[1].authStatus = 'connected';
    await connector.refresh();
    assert.match(w.SimpleSettings._connectorHtml('slack'), /Disconnect/);
    assert.doesNotMatch(w.SimpleSettings._connectorHtml('slack'), /data-ss="slack-connect"/);
    assert.match(w.SimpleSettings._connectorHtml('slack'), /goes to your AI model/);
    assert.match(w.SimpleSettings._connectorHtml('slack'), /data-id="privacy"/, 'the details live on the Privacy page');
    assert.doesNotMatch(w.SimpleSettings._connectorHtml('slack'), /access tokens|bounded queue/, 'one sentence of fine print');
    // A saved token is not a working connection: Slack refused the app after
    // sign-in, and a refresh must keep saying so (2026-10-08).
    servers[1].connectError = 'Slack refused the connection: App not approved for Slack MCP server access.';
    await connector.refresh();
    assert.equal(connector.status().on, false, 'a refused connection is not connected');
    assert.equal(connector.status().value, 'Needs attention');
    assert.match(w.SimpleSettings._connectorHtml('slack'), /App not approved/);
    assert.match(w.SimpleSettings._connectorHtml('slack'), /data-ss="slack-connect"/);
    assert.match(w.SimpleSettings._connectorHtml('slack'), /data-ss="slack-disconnect"/);
    delete servers[1].connectError;
    await connector.refresh();
    assert.equal(connector.status().value, 'Connected');
    servers.push({ name: 'second-workspace', url: Slack.URL + '/', auth: 'oauth', enabled: true, authStatus: 'connected' });
    await connector.disconnect();
    assert.deepEqual(disconnected, ['slack-2', 'second-workspace']);
    assert.deepEqual(unregistered, disconnected);
    failList = true;
    await connector.connect();
    assert.equal(authorizations.length, 1, 'failed list never authorizes an unknown connection');
    assert.equal(connector.status().value, 'Needs attention');
    dom.window.close();
}

(async () => {
    const previous = process.env.NENVA_SLACK_CLIENT_ID;
    try {
        delete process.env.NENVA_SLACK_CLIENT_ID;
        assert.ok(Slack.validClientId(Slack.clientId()), 'shipped registration is configured without user setup');
        process.env.NENVA_SLACK_CLIENT_ID = '123.456';
        await oauthTest(); await connectorTest();
    } finally {
        if (previous === undefined) delete process.env.NENVA_SLACK_CLIENT_ID;
        else process.env.NENVA_SLACK_CLIENT_ID = previous;
    }
    console.log('slack-mcp-test: registered PKCE, Slack token errors, endpoint boundaries and connector flows passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
