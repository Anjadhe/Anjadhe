// Live setup evidence must agree with Settings, without contacting providers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let servers = [], checks = 0, fail = false;
const context = vm.createContext({
    console,
    AccountsManager: { getAll: () => Array.from({ length: 5 }, (_, i) => ({
        email: `person${i}@example.test`, services: { mail: true, calendar: true }
    })) },
    window: { electronMCP: { listServers: async () => {
        checks++;
        if (fail) throw new Error('private-error-details');
        return servers;
    } } }
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/agent/agent-tools.js'), 'utf8')
    + '\nthis.tools = AgentTools;', context);
const status = () => context.tools.execute('get_setup_status', {});
const slack = { name: 'work-team', url: 'https://mcp.slack.com/mcp/', enabled: true,
    auth: 'oauth', authStatus: 'connected', running: false, tools: [],
    oauth: 'secret-token', headers: { Authorization: 'secret-header' }, env: { KEY: 'secret-key' } };

(async () => {
    // The reported reproduction: five Google accounts and an idle, connected
    // Slack workspace. No monitoring bridge or loaded MCP registry is needed.
    servers = [slack];
    let result = await status();
    assert.equal(result.accounts.connected, 5);
    assert.equal(result.toolServers.checked, true);
    assert.equal(result.toolServers.servers[0].service, 'Slack');
    assert.equal(result.toolServers.servers[0].status, 'connected');
    assert.equal(result.toolServers.servers[0].toolCount, 0);
    assert.doesNotMatch(JSON.stringify(result), /secret-|Authorization|https:\/\//);

    // Fresh main-process evidence wins over previous answers and tool caches.
    for (const authStatus of ['disconnected', 'connecting', 'reconnect', 'connected']) {
        servers = [{ ...slack, authStatus, tools: [{ name: 'search' }] }];
        result = await status();
        assert.equal(result.toolServers.servers[0].status, authStatus);
    }
    assert.equal(checks, 5);
    servers = [{ ...slack, enabled: false }, { ...slack, name: 'second-workspace' }];
    result = await status();
    assert.equal(result.toolServers.servers[0].status, 'disabled');
    assert.equal(result.toolServers.servers[1].status, 'connected');

    servers = [
        { ...slack, url: 'https://mcp.notion.com/mcp' },
        { ...slack, url: 'https://mcp.linear.app/mcp/' },
        { ...slack, name: 'slack', url: 'https://mcp.slack.com.evil.test/mcp', auth: null },
        { name: 'local-tools', enabled: true, command: 'private-command', args: ['secret-arg'] }
    ];
    result = await status();
    assert.deepEqual(Array.from(result.toolServers.servers, s => s.service),
        ['Notion', 'Linear', 'Custom tool server', 'Custom tool server']);
    assert.equal(result.toolServers.servers[2].status, 'configured');
    assert.equal(result.toolServers.servers[3].status, 'configured');
    assert.doesNotMatch(JSON.stringify(result), /private-command|secret-arg/);

    servers = [];
    result = await status();
    assert.equal(result.toolServers.checked, true);
    assert.equal(result.toolServers.servers.length, 0);
    fail = true;
    result = await status();
    assert.equal(result.toolServers.checked, false);
    assert.doesNotMatch(JSON.stringify(result), /private-error-details/);
    fail = false;
    servers = null;
    assert.equal((await status()).toolServers.checked, false);
    delete context.window.electronMCP;
    assert.equal((await status()).toolServers.checked, false);
    console.log('setup-connector-status-test: live OAuth states, Google separation, unknown checks and secret exclusion passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
