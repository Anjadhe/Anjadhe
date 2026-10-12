// Linear's published discovery shape and the everyday Settings connection flow.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { JSDOM } = require('jsdom');
const { MCPOAuth } = require('../js/main/mcp-oauth');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const URL = 'https://mcp.linear.app/mcp';
const origin = 'https://mcp.linear.app';
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json', ...headers }
});

async function oauthTest() {
    // Metadata verified against Linear's public endpoint on 2026-10-07.
    const metadata = {
        issuer: origin, authorization_endpoint: origin + '/authorize',
        token_endpoint: origin + '/token', registration_endpoint: origin + '/register',
        scopes_supported: ['read', 'write', 'openid', 'email'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
        code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true
    };
    const record = { url: URL, auth: 'oauth', enabled: true };
    let registration, authorization, refreshes = 0;
    const auth = new MCPOAuth({
        read: () => record,
        write: (_, data) => { if (data) record.oauth = data; else delete record.oauth; },
        secrets: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() },
        fetch: async (url, init) => {
            assert.equal(init.redirect, 'error');
            if (url === URL) return json({}, 401, {
                'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`
            });
            if (url === origin + '/.well-known/oauth-protected-resource/mcp') return json({
                resource: URL, authorization_servers: [origin], scopes_supported: ['read', 'write'], bearer_methods_supported: ['header']
            });
            if (url === origin + '/.well-known/oauth-authorization-server') return json(metadata);
            if (url === origin + '/register') {
                registration = JSON.parse(init.body);
                assert.equal(registration.token_endpoint_auth_method, 'none');
                assert.equal(registration.scope, 'read write', 'request resource scopes, not identity scopes');
                assert.match(registration.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
                return json({ client_id: 'linear-desktop', token_endpoint_auth_method: 'none' });
            }
            assert.equal(url, origin + '/token');
            const params = new URLSearchParams(init.body);
            assert.equal(params.get('client_id'), 'linear-desktop');
            assert.equal(params.get('resource'), URL);
            assert.equal(params.has('client_secret'), false);
            if (params.get('grant_type') === 'authorization_code') {
                assert.equal(params.get('redirect_uri'), registration.redirect_uris[0]);
                assert.equal(params.get('code'), 'fixture-code');
                assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
                return json({ access_token: 'fixture-token', refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: 3600 });
            }
            assert.equal(params.get('grant_type'), 'refresh_token');
            assert.equal(params.get('refresh_token'), 'fixture-refresh');
            refreshes++;
            return json({ access_token: 'rotated-token', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600 });
        },
        openExternal: async url => {
            authorization = new globalThis.URL(url);
            assert.equal(authorization.origin + authorization.pathname, origin + '/authorize');
            assert.equal(authorization.searchParams.get('scope'), 'read write');
            assert.equal(authorization.searchParams.get('resource'), URL);
            assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
            const callback = new globalThis.URL(authorization.searchParams.get('redirect_uri'));
            callback.searchParams.set('state', authorization.searchParams.get('state'));
            callback.searchParams.set('iss', origin);
            callback.searchParams.set('code', 'fixture-code');
            assert.equal((await fetch(callback)).status, 200);
        }
    });
    await auth.authorize('linear');
    assert.equal(auth.status('linear'), 'connected');
    assert.equal(await auth.accessToken('linear'), 'fixture-token');
    assert.deepEqual(await Promise.all([auth.accessToken('linear', 'fixture-token'), auth.accessToken('linear', 'fixture-token')]), ['rotated-token', 'rotated-token']);
    assert.equal(refreshes, 1);
    auth.disconnect('linear');
    assert.equal(record.oauth, undefined);
    await assert.rejects(auth.accessToken('linear'), /Connect/);
}

async function connectorTest() {
    const dom = new JSDOM('<div id="settings-mcp-list"></div>', { runScripts: 'outside-only' });
    const w = dom.window;
    let app, modal, authorization, failList = false;
    const servers = [];
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
    await app._loadMCPServers();
    const preset = w.document.querySelector('[data-mcp-preset="linear"]');
    assert.equal(preset.textContent, 'Connect');
    assert.equal(preset.closest('[data-mcp-preset-row]').querySelector('input'), null);
    assert.equal(app.MCP_PRESETS.find(p => p.name === 'linear').url, URL);
    w.document.getElementById('settings-mcp-list').replaceChildren();
    app._loadMCPServers = async () => {};
    servers.push({ name: 'linear', url: 'https://custom.test/mcp', auth: 'oauth' });
    w.eval(['js/core/sources.js', 'js/core/linear-connector.js', 'js/core/simple-connectors.js'].map(read).join('\n')
        + '\nwindow.connector = LinearConnector; window.sources = Sources;');
    const connector = w.connector;
    await connector.refresh();
    assert.equal(w.sources.get('linear').mode, 'reference');
    assert.equal(w.sources.get('linear').feeds.length, 0);
    assert.match(w.SimpleSettings._connectorsHtml(), /Linear/);
    const connecting = connector.connect();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(servers[1].name, 'linear-2', 'preserve unrelated custom servers');
    assert.equal(authorizations.length, 0, 'no browser until explicit Continue');
    assert.equal(modal.title, 'Connect directly to Linear');
    assert.match(w.document.body.textContent, /127\.0\.0\.1/);
    assert.equal(w.document.querySelector('input'), null, 'users never enter app credentials');
    assert.doesNotMatch(w.document.body.textContent, /Client ID|PKCE|registered app/);
    modal.buttons[1].onClick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(authorizations[0], 'linear-2');
    await connector.refresh();
    assert.match(w.SimpleSettings._connectorHtml('linear'), /Cancel sign-in/);
    await w.SimpleSettings._connectorClick('linear-cancel', {});
    await connecting;
    assert.equal(connector.status().on, false);
    const retry = connector.connect();
    await new Promise(resolve => setImmediate(resolve));
    modal.onClose(); // Escape / Cancel
    await retry;
    assert.equal(authorizations.length, 1);
    servers[1].authStatus = 'connected';
    await connector.refresh();
    assert.match(w.SimpleSettings._connectorHtml('linear'), /Disconnect/);
    assert.doesNotMatch(w.SimpleSettings._connectorHtml('linear'), /data-ss="linear-connect"/);
    assert.match(w.SimpleSettings._connectorHtml('linear'), /goes to your AI model/);
    servers.push({ name: 'second-workspace', url: URL + '/', auth: 'oauth', enabled: true, authStatus: 'connected' });
    await connector.disconnect();
    assert.deepEqual(disconnected, ['linear-2', 'second-workspace']);
    assert.deepEqual(unregistered, disconnected);
    failList = true;
    await connector.connect();
    assert.equal(authorizations.length, 1, 'failed list never authorizes an unknown connection');
    assert.equal(connector.status().value, 'Needs attention');
    dom.window.close();
}

async function routingTest() {
    const dom = new JSDOM('<div id="app-views"></div>', { runScripts: 'outside-only' });
    const w = dom.window;
    w.AppManager = { currentApp: 'simplesettings', register() {} };
    w.eval(read('js/core/simple-settings.js') + '\nwindow.settings = SimpleSettings;');
    const settings = w.settings;
    let rendered = 0, action;
    settings.render = () => { rendered++; };
    settings._connectorClick = ss => { action = ss; };
    settings.mount();
    settings._page = 'connector:linear';
    w.dispatchEvent(new w.CustomEvent('anjadhe:connectors-changed'));
    assert.equal(rendered, 1, 'Linear page refreshes on connection events');
    const button = w.document.createElement('button');
    button.dataset.ss = 'linear-connect';
    w.document.getElementById('simplesettings-view').append(button);
    button.click();
    assert.equal(action, 'linear-connect', 'the live Settings event router reaches the connector');
    dom.window.close();
}

(async () => {
    await oauthTest();
    await connectorTest();
    await routingTest();
    console.log('linear-mcp-test: OAuth discovery, PKCE, refresh, connector lifecycle and Settings routing passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
