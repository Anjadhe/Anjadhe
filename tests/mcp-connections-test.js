const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { JSDOM } = require('jsdom');
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const secrets = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };

async function managerTest() {
    let servers = [], calls = [], rejects = 0, mode = 'normal', finishInitialize, finishCall;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        assert.equal(options.redirect, 'error', 'tokens must never follow redirects');
        if (url.endsWith('/token')) {
            return json({ access_token: 'new-token', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 3600 });
        }
        if (options.method === 'DELETE') return new Response(null, { status: 204 });
        const body = JSON.parse(options.body);
        calls.push(body);
        assert.equal(options.headers.Authorization, mode === 'retry' && rejects ? 'Bearer new-token' : 'Bearer token');
        if (body.method === 'initialize') {
            if (mode === 'delayed') await new Promise(resolve => { finishInitialize = resolve; });
            return json({ jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'fixture' } } });
        }
        if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
        if (body.method === 'tools/list') {
            const tool = body.params.cursor ? 'update_page' : 'search';
            const result = { tools: [{ name: tool, description: tool, inputSchema: { type: 'object', properties: {} }, annotations: { destructiveHint: tool === 'update_page' } }],
                ...(body.params.cursor ? {} : { nextCursor: 'page2' }) };
            // The second page comes back over SSE, as real hosted servers may.
            return body.params.cursor ? new Response(`data: ${JSON.stringify({ id: body.id, result })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
                : json({ id: body.id, result });
        }
        if (body.method === 'tools/call') {
            if (mode === 'delayed-call') await new Promise(resolve => { finishCall = resolve; });
            if (mode === 'retry' && rejects++ === 0) return json({}, 401);
            if (mode === 'forbidden') return json({}, 403);
            if (mode === 'network') throw new Error('network lost');
            return json({ id: body.id, result: { content: [{ type: 'text', text: 'Notion page contents' }] } });
        }
        throw new Error('Unexpected method');
    };
    const file = path.join(__dirname, '../js/main/mcp-manager.js');
    const localRequire = createRequire(file);
    const module = { exports: {} };
    new Function('require', 'module', fs.readFileSync(file, 'utf8'))(id => {
        if (id === 'electron') return { nativeImage: {}, shell: { openExternal() { throw new Error('Tool calls must never launch sign-in'); } } };
        if (id === './secret-store') return secrets;
        return localRequire(id);
    }, module);
    const manager = module.exports;
    manager.init({ get: () => structuredClone(servers), set: (key, value) => { servers = structuredClone(value); } });
    const credentials = () => manager._oauth._save('notion', { serverUrl: 'https://mcp.test/mcp', resource: 'https://mcp.test/mcp',
        metadata: { token_endpoint: 'https://mcp.test/token' }, client_id: 'client', access_token: 'token', refresh_token: 'refresh', expiresAt: Date.now() + 3600000 }, manager._oauth.generations.get('notion') || 0);
    try {
        assert.ok(manager.addServer({ name: 'bad', url: 'http://mcp.test/mcp', auth: 'oauth' }).error);
        assert.ok(manager.addServer({ name: 'bad', url: 'https://mcp.test/mcp', auth: 'oauth', headers: { Authorization: 'x' } }).error);
        assert.ok(manager.addServer({ name: 'notion', url: 'https://mcp.test/mcp', auth: 'oauth' }).ok);
        assert.match((await manager.testServer('notion')).error, /Connect/);
        assert.equal(calls.length, 0, 'disconnected tools cannot call the server');
        credentials();
        const result = await manager.testServer('notion');
        assert.equal(result.tools.length, 2, 'all pages of advertised tools are discovered');
        assert.equal(result.tools[1].annotations.destructiveHint, true);
        const publicList = JSON.stringify(manager.listServers());
        assert.doesNotMatch(publicList, /refresh_token|access_token|new-refresh|client_id|expiresAt/);
        assert.match((await manager.callTool('notion', 'invented', {})).error, /does not expose/);
        assert.equal((await manager.callTool('notion', 'search', {})).result, 'Notion page contents');
        mode = 'retry';
        assert.equal((await manager.callTool('notion', 'update_page', {})).result, 'Notion page contents');
        assert.equal(rejects, 2, 'a definite 401 is retried once with the refreshed token');
        mode = 'normal'; credentials();
        mode = 'forbidden';
        let count = calls.length;
        assert.match((await manager.callTool('notion', 'update_page', {})).error, /permission/);
        assert.equal(calls.length - count, 1, '403 never replays a write');
        mode = 'network'; count = calls.length;
        assert.match((await manager.callTool('notion', 'update_page', {})).error, /network lost/);
        assert.equal(calls.length - count, 1, 'ambiguous network errors never replay writes');
        mode = 'delayed-call';
        const lateCall = manager.callTool('notion', 'search', {});
        while (!finishCall) await new Promise(resolve => setImmediate(resolve));
        manager.disconnectServer('notion');
        finishCall();
        assert.match((await lateCall).error, /cancelled/);
        assert.equal(manager.listServers()[0].tools.length, 0);
        assert.equal(manager.listServers()[0].authStatus, 'disconnected');
        assert.match(manager.continueOutput('notion').error, /No previous/);
        assert.match((await manager.callTool('notion', 'search', {})).error, /Connect/);
        credentials(); mode = 'delayed';
        const connecting = manager.testServer('notion');
        while (!finishInitialize) await new Promise(resolve => setImmediate(resolve));
        manager.setEnabled('notion', false);
        finishInitialize();
        assert.match((await connecting).error, /cancelled/);
        assert.equal(manager.listServers()[0].tools.length, 0, 'late tool discovery cannot resurrect disabled tools');
        manager.removeServer('notion');
        assert.equal(manager.listServers().length, 0);
        manager.addServer({ name: 'slack', url: 'https://mcp.slack.com/mcp', auth: 'oauth' });
        let authorized;
        manager._oauth.authorize = async name => { authorized = name; };
        manager.testServer = async () => ({ ok: true, tools: [] });
        assert.ok((await manager.authorizeServer('slack')).ok);
        assert.equal(authorized, 'slack');
        assert.equal('oauthClientId' in manager.listServers()[0], false, 'registration configuration stays out of Settings');
        assert.throws(() => manager.slackReader('slack'), /Connect/);
        const slackCredentials = () => manager._oauth._save('slack', { serverUrl: 'https://mcp.slack.com/mcp', resource: 'https://mcp.slack.com',
            metadata: { token_endpoint: 'https://slack.com/api/oauth.v2.user.access' }, client_id: '1.2', access_token: 'slack-secret',
            refresh_token: 'slack-refresh', expiresAt: Date.now() + 3600000 }, manager._oauth.generations.get('slack') || 0);
        slackCredentials();
        const beforeReader = calls.length;
        const reader = manager.slackReader('slack');
        assert.equal(reader, manager.slackReader('slack'), 'one reader per connection');
        assert.equal(calls.length, beforeReader, 'reader construction cannot start monitoring or sign-in');
        manager.setEnabled('slack', false);
        assert.equal(reader.abort.signal.aborted, true);
        assert.throws(() => manager.slackReader('slack'), /Connect/);
        manager.setEnabled('slack', true);
        const disconnected = manager.slackReader('slack');
        manager.disconnectServer('slack');
        assert.equal(disconnected.abort.signal.aborted, true);
        slackCredentials();
        const stopped = manager.slackReader('slack');
        manager.stopAll();
        assert.equal(stopped.abort.signal.aborted, true, 'stopAll also stops adapters without a live MCP transport');
        manager.addServer({ name: 'slack-impostor', url: 'https://example.com/mcp', auth: 'oauth' });
        assert.throws(() => manager.slackReader('slack-impostor'), /Connect/);
    } finally { manager.stopAll(); globalThis.fetch = originalFetch; }
}

async function settingsTest() {
    const dom = new JSDOM('<div id="settings-mcp-list"></div><button id="settings-mcp-add-btn">Add</button>', { runScripts: 'outside-only' });
    const w = dom.window;
    let app, servers = [], authorizeCalls = 0, cancelCalls = 0, resolveAuth, modal;
    w.AppManager = { register(name, value) { app = value; } };
    w.UIUtils = { escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'), showToast() {} };
    w.PermissionManager = { ready: async () => {}, listGrants: () => [] };
    w.Modal = { create(value) {
        modal = value;
        const content = typeof value.content === 'string' ? w.document.createElement('div') : value.content;
        if (typeof value.content === 'string') content.innerHTML = value.content;
        w.document.body.append(content);
        return { close() { content.remove(); value.onClose?.(); } };
    } };
    w.electronMCP = {
        listServers: async () => structuredClone(servers),
        addServer: async params => { servers.push({ ...params, enabled: true, tools: [], authStatus: 'disconnected' }); return { name: params.name }; },
        authorizeServer: async () => { authorizeCalls++; servers[0].authStatus = 'connecting'; return new Promise(resolve => { resolveAuth = resolve; }); },
        cancelAuthorization: async () => { cancelCalls++; servers[0].authStatus = 'disconnected'; resolveAuth({ error: 'Cancelled' }); },
        disconnectServer: async () => { servers[0].authStatus = 'disconnected'; servers[0].tools = []; }
    };
    w.eval(fs.readFileSync(path.join(__dirname, '../js/apps/settings/settings-app.js'), 'utf8'));
    await app._loadMCPServers();
    const list = w.document.getElementById('settings-mcp-list');
    const notion = list.querySelector('[data-mcp-preset="notion"]');
    assert.equal(notion.textContent, 'Connect');
    assert.equal(notion.closest('[data-mcp-preset-row]').querySelector('input'), null);
    const click = list.onclick({ target: notion });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(authorizeCalls, 0, 'the explanation appears before browser sign-in starts');
    assert.equal(modal.title, 'Connect directly to Notion');
    assert.match(w.document.body.textContent, /127\.0\.0\.1/);
    assert.match(w.document.body.textContent, /your own computer/);
    assert.match(w.document.body.textContent, /credentials are stored securely on this Mac/);
    assert.equal(modal.buttons[1].text, 'Continue to Notion');
    modal.buttons[1].onClick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(authorizeCalls, 1);
    assert.equal(servers[0].auth, 'oauth');
    await app._loadMCPServers();
    assert.ok(list.querySelector('[data-mcp-action="test"]').disabled);
    await list.onclick({ target: list.querySelector('[data-mcp-action="cancel-auth"]') });
    await click;
    assert.equal(cancelCalls, 1);
    servers[0].authStatus = 'connected';
    servers[0].tools = [{ name: 'search' }];
    await app._loadMCPServers();
    assert.match(list.textContent, /Signed in/);
    assert.equal(list.querySelector('[data-mcp-action="authorize"]').textContent, 'Reconnect');
    assert.equal(list.querySelector('[data-mcp-action="trust"]').textContent, 'Trust', 'connecting does not grant trust');
    await list.onclick({ target: list.querySelector('[data-mcp-action="disconnect"]') });
    assert.match(list.textContent, /Not signed in/);
    const dismissed = app._connectMCPServer('notion');
    await new Promise(resolve => setImmediate(resolve));
    modal.onClose(); // Cancel, Escape, close button and backdrop share this hook.
    await dismissed;
    assert.equal(authorizeCalls, 1, 'dismissing the explanation leaves the browser unopened');
    app._addMCPServer();
    const select = w.document.getElementById('mcp-add-auth');
    select.value = 'oauth'; select.dispatchEvent(new w.Event('change'));
    assert.equal(w.document.getElementById('mcp-add-env').disabled, true);
    assert.equal(w.document.getElementById('mcp-add-env-field').hidden, true);
    w.document.getElementById('mcp-add-name').value = 'bad';
    w.document.getElementById('mcp-add-command').value = 'npx anything';
    await modal.buttons[1].onClick();
    assert.equal(servers.length, 1, 'browser auth rejects local commands');
    dom.window.close();
}

async function simpleConnectorTest() {
    const dom = new JSDOM('', { runScripts: 'outside-only' });
    const w = dom.window;
    const url = 'https://mcp.notion.com/mcp';
    let servers = [{ name: 'notion', url: 'https://different.test/mcp', auth: 'oauth' }];
    let changed, failList = false;
    const added = [], connected = [], disconnected = [], unregistered = [];
    w.electronMCP = {
        listServers: async () => { if (failList) throw new Error('offline'); return structuredClone(servers); },
        onServersChanged: cb => { changed = cb; },
        addServer: async s => { added.push(s.name); servers.push({ ...s, enabled: true }); return { name: s.name }; },
        setEnabled: async name => { servers.find(s => s.name === name).enabled = true; return {}; },
        disconnectServer: async name => { disconnected.push(name); servers.find(s => s.name === name).authStatus = 'disconnected'; return {}; }
    };
    w.SettingsApp = { _connectMCPServer: async name => { connected.push(name); servers.find(s => s.name === name).authStatus = 'connected'; return {}; } };
    w.MCPTools = { unregisterServer: name => unregistered.push(name) };
    w.SimpleSettings = { _esc: text => String(text).replace(/</g, '&lt;'), _chev: '', _tile: () => '' };
    w.eval(['js/core/sources.js', 'js/core/notion-connector.js', 'js/core/simple-connectors.js']
        .map(file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')).join('\n')
        + '\nwindow.testNotion = NotionConnector; window.testSources = Sources;');
    const notion = w.testNotion, sources = w.testSources;
    await notion.refresh();
    assert.equal(sources.get('notion').mode, 'reference');
    assert.equal(sources.get('notion').feeds.length, 0, 'Notion is not an ambient observation source');
    await notion.connect();
    assert.deepEqual(added, ['notion-2'], 'custom configuration with the name notion is preserved');
    assert.equal(notion.status().value, 'Connected');
    const html = w.SimpleSettings._connectorHtml('notion');
    assert.match(html, /Disconnect/);
    assert.doesNotMatch(html, /notion-connect|Sign in again/, 'a healthy connection does not prompt another sign-in');
    assert.doesNotMatch(html, /MCP|OAuth|Tool Servers|https:\/\//, 'the everyday page has no protocol setup');
    servers[1].authStatus = 'reconnect';
    await notion.refresh();
    assert.match(w.SimpleSettings._connectorHtml('notion'), /Sign in again/, 'a connection needing reauthorization offers sign-in');
    servers[1].authStatus = 'connecting';
    await notion.refresh();
    assert.match(w.SimpleSettings._connectorHtml('notion'), /Cancel sign-in/);
    assert.doesNotMatch(w.SimpleSettings._connectorHtml('notion'), /notion-connect/);
    servers[1].authStatus = 'connected';
    servers[1].enabled = false;
    await notion.refresh();
    await notion.connect();
    assert.deepEqual(connected, ['notion-2', 'notion-2'], 'an existing disabled connection is enabled and reused');
    assert.equal(added.length, 1);
    servers.push({ name: 'workspace', url: url + '/', auth: 'oauth', enabled: true, authStatus: 'connected' });
    await changed();
    await notion.disconnect();
    assert.deepEqual(disconnected, ['notion-2', 'workspace'], 'disconnect covers duplicate Notion connections');
    assert.deepEqual(unregistered, disconnected);
    assert.equal(notion.status().on, false);
    failList = true;
    await notion.connect();
    assert.equal(connected.length, 2, 'failed status reads cannot create or authorize an unknown connection');
    assert.equal(notion.status().value, 'Needs attention');
    failList = false;
    await notion.refresh();
    assert.equal(notion.status().value, 'Not connected', 'a successful refresh clears the status read error');
    dom.window.close();
}

async function agentRegistrationTest(provider = 'notion', url) {
    const dom = new JSDOM('', { runScripts: 'outside-only' });
    const w = dom.window;
    const tools = {};
    const server = { name: provider, url, enabled: true, auth: 'oauth', authStatus: 'connected', tools: [
        { name: 'search', description: 'Search Notion pages', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
        { name: 'delete_page', inputSchema: { type: 'object', properties: {} }, annotations: { destructiveHint: true } }
    ] };
    let listed = [server], changed;
    w.electronMCP = { listServers: async () => listed, onServersChanged: callback => { changed = callback; return () => {}; } };
    w.AgentTools = {
        _dynamicTools: tools,
        register(def, handler, meta) { tools[def.function.name] = { ...meta, def, handler }; return { ok: true }; },
        unregisterBySource(source) { for (const [name, tool] of Object.entries(tools)) if (tool.source === source) delete tools[name]; }
    };
    w.electronPermissions = { getGrants: async () => [] };
    for (const file of ['js/agent/mcp-tools.js', 'js/agent/permission-manager.js']) w.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
    await w.MCPTools.ready;
    await w.PermissionManager.ready();
    assert.equal(tools[`mcp_${provider}_search`].def.function.parameters.properties.query.type, 'string');
    if (url) assert.ok(tools[`mcp_${provider}_search`].keywords.includes('linear'), 'workspace-named connections respond to Linear requests');
    assert.equal(w.PermissionManager.resolve(`mcp_${provider}_search`, {}).decision, 'ask');
    assert.equal(w.PermissionManager.resolve(`mcp_${provider}_delete_page`, {}).decision, 'ask');
    w.PermissionManager._grants = [{ id: 'trust', tool: `mcp:${provider}` }];
    assert.equal(w.PermissionManager.resolve(`mcp_${provider}_search`, {}).decision, 'allow');
    assert.equal(w.PermissionManager.resolve(`mcp_${provider}_delete_page`, {}).decision, 'ask', 'destructive hints still require approval with server trust');
    listed = [{ ...server, authStatus: 'disconnected', tools: [] }];
    changed();
    await new Promise(resolve => setTimeout(resolve, 90));
    assert.equal(Object.keys(tools).length, 0, 'disconnect removes all tools, including cached output continuation');
    listed = [server]; changed();
    await new Promise(resolve => setTimeout(resolve, 90));
    assert.ok(tools[`mcp_${provider}_search`]);
    listed = []; changed();
    await new Promise(resolve => setTimeout(resolve, 90));
    assert.equal(Object.keys(tools).length, 0, 'removal from another window drops the registry entries');
    dom.window.close();
}

(async () => {
    await managerTest();
    await settingsTest();
    await simpleConnectorTest();
    await agentRegistrationTest();
    await agentRegistrationTest('linear');
    await agentRegistrationTest('engineering', 'https://mcp.linear.app/mcp/');
    console.log('mcp-connections-test: transport, tool discovery and Settings flows passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
