/**
 * MCPTools — surfaces MCP server tools to the assistant
 * (docs/COWORK_AGENT.md §2, phase C2).
 *
 * Registration happens from each server's cached tool list (captured by
 * main on every successful connect), so startup spawns NOTHING — servers
 * start lazily on the first actual tool call. Each tool registers through
 * the existing AgentTools.register() with:
 *   - a namespaced, collision-proof name: mcp_<server>_<tool>
 *   - source 'mcp:<server>' so unregisterBySource cleans up on
 *     disable/remove/refresh
 *   - keywords from the server + tool names, so 200 MCP tools don't blow
 *     up a local model's prompt — the make-or-break detail for gemma
 * Permission class: mcp_* defaults to ask (PermissionManager); a per-server
 * trust grant ('mcp:<server>') silences that server's tools — EXCEPT ones the
 * server flags destructive (destructiveHint), which keep asking (M8).
 */

const MCPTools = {
    // Server names whose tool list includes browser_* tools. AgentService
    // reads this to ship the BROWSING guidance prose only when a browser
    // server's tools are scoped into the conversation.
    browserServers: new Set(),
    // Original tool identities, not model-supplied names or prefix guesses.
    _browserTools: new Map(),

    async init() {
        if (typeof FEATURES !== 'undefined' && !FEATURES.isEnabled('mcp')) return;
        if (!window.electronMCP?.listServers) return;
        this._registerSlackMonitoring();
        let servers;
        try { servers = await window.electronMCP.listServers(); } catch { return; }
        for (const s of (servers || [])) {
            if (s.enabled && (s.auth !== 'oauth' || s.authStatus === 'connected')) this._registerServer(s);
        }
        // Sign-in expiry/disconnect must drop cached tools in every window.
        if (!this._stopWatching) this._stopWatching = window.electronMCP.onServersChanged?.(() => {
            clearTimeout(this._refreshTimer);
            this._refreshTimer = setTimeout(async () => {
                try {
                    const current = await window.electronMCP.listServers();
                    const sources = new Set(Object.values(AgentTools._dynamicTools || {}).map(t => t.source));
                    for (const source of sources) {
                        if (source?.startsWith('mcp:') && !current.some(s => 'mcp:' + s.name === source)) this.unregisterServer(source.slice(4));
                    }
                    for (const server of current) this.refreshServer(server);
                } catch (e) { console.warn('[mcp-tools] Could not refresh connections:', e.message); }
            }, 50);
        });
    },

    _registerSlackMonitoring() {
        if (typeof AgentTools === 'undefined' || !window.electronSlackMonitor?.status) return;
        AgentTools.register({ type: 'function', function: { name: 'slack_monitoring_status',
            description: 'Check scoped Slack monitoring and help the user set up useful watches. Suggest requests needing them, changed responsibilities or blockers, rather than new-message notifications. Never guess who their manager is. Setup and optional morning reviews are in Settings > Connectors > Slack; scope and model require the person’s review.',
            parameters: { type: 'object', properties: {} } } }, async () => {
            const status = await window.electronSlackMonitor?.status();
            return { ...status, setup: 'Settings > Connectors > Slack',
                guidance: 'Ask which outcome and conversations matter. The person selects exact conversations and the model in setup. Connecting alone enables no monitoring. Optional morning reviews reuse findings and stay quiet without meaningful changes. Checks run only while this Mac runs nenva; coverage is incomplete.' };
        }, { source: 'slack-monitor', group: 'slack-monitor', keywords: ['slack', 'monitor', 'manager', 'watch'], blockUntrusted: true });
    },

    /** Re-register one server's tools (Settings calls this after test/toggle). */
    refreshServer(server) {
        if (typeof AgentTools === 'undefined') return;
        this.browserServers.delete(server.name);
        for (const [name, meta] of this._browserTools) if (meta.server === server.name) this._browserTools.delete(name);
        AgentTools.unregisterBySource('mcp:' + server.name);
        if (server.enabled && (server.auth !== 'oauth' || server.authStatus === 'connected')) this._registerServer(server);
    },

    unregisterServer(name) {
        for (const [tool, meta] of this._browserTools) if (meta.server === name) this._browserTools.delete(tool);
        this.browserServers.delete(name);
        if (typeof AgentTools === 'undefined') return;
        AgentTools.unregisterBySource('mcp:' + name);
    },

    _registerServer(server) {
        if (typeof AgentTools === 'undefined' || !Array.isArray(server.tools)) return;
        // Keyword scope: tokens from the server name + every tool name.
        // "github" + "create issue" etc. — the message must mention one for
        // the schemas to ship.
        const keywords = new Set(server.name.split(/[-_\s]+/));
        // A reused Linear connection may have a workspace-specific name.
        // Asking for Linear must still surface its tools.
        if (server.url?.replace(/\/$/, '') === 'https://mcp.linear.app/mcp') keywords.add('linear');
        const isSlack = server.url?.replace(/\/$/, '') === 'https://mcp.slack.com/mcp';
        if (isSlack) keywords.add('slack');
        for (const t of server.tools) {
            for (const w of String(t.name).split(/[-_\s]+/)) keywords.add(w);
        }
        // Browser servers (C6 — e.g. Playwright MCP) get web-INTENT words on
        // top of the tool-name tokens: "go to amazon.com", "log into the
        // airline website", "open https://…" name no tool, but they are
        // exactly the asks these tools exist for. com/org/net catch bare
        // domains (word boundaries sit at the dots).
        const isBrowser = server.tools.some(t => /^browser[_-]/.test(String(t.name)));
        if (isBrowser) {
            this.browserServers.add(server.name);
            for (const w of ['browse', 'website', 'websites', 'webpage', 'site',
                'url', 'urls', 'http', 'https', 'www', 'com', 'org', 'net',
                'visit', 'login', 'log in', 'sign in']) keywords.add(w);
        } else {
            this.browserServers.delete(server.name);
        }
        const words = [...keywords].filter(w => w.length >= 3);

        for (const t of server.tools) {
            const fnName = `mcp_${server.name}_${t.name}`.replace(/[^a-zA-Z0-9_]/g, '_');
            const res = AgentTools.register({
                type: 'function',
                function: {
                    name: fnName,
                    // Server attribution up front so the model (and the
                    // transparency logs) always know where a tool lives.
                    description: `[${server.name} MCP] ${t.description || t.name}`.slice(0, 320),
                    // MCP inputSchema is JSON Schema — pass through unchanged.
                    parameters: t.inputSchema
                }
            }, (args, ctx = {}) => isSlack && (ctx.ambient || ctx.unattended)
                ? { error: 'Background Slack work must use reviewed monitoring and its shared findings.', blocked: true }
                : this._call(server.name, t.name, args), {
                source: 'mcp:' + server.name,
                keywords: words,
                // A server-supplied hint (M8): when the tool declares itself
                // destructive, a "trust this server" grant won't auto-approve
                // it — it still asks each time.
                destructive: !!(t.annotations && t.annotations.destructiveHint === true)
            });
            if (!res.ok) console.warn(`[mcp-tools] could not register ${fnName}: ${res.error}`);
            else if (isBrowser) this._browserTools.set(fnName, { server: server.name, tool: t.name });
        }

        // Continuation tool: main windows big tool outputs (browser
        // snapshots of real sites run to 100k+ chars) — this pages
        // through the rest instead of losing it to the cap.
        const contName = `mcp_${server.name}_continue_output`.replace(/[^a-zA-Z0-9_]/g, '_');
        AgentTools.register({
            type: 'function',
            function: {
                name: contName,
                description: `[${server.name} MCP] Read the next part of the previous ${server.name} tool result — use whenever a result says it was truncated.`,
                parameters: { type: 'object', properties: {} }
            }
        }, (_args, ctx = {}) => isSlack && (ctx.ambient || ctx.unattended)
            ? { error: 'Background Slack work must use reviewed monitoring.', blocked: true }
            : window.electronMCP.continueOutput(server.name), {
            source: 'mcp:' + server.name,
            keywords: words
        });
        if (isBrowser) this._browserTools.set(contName, { server: server.name, tool: 'continue_output' });
    },

    async _call(serverName, toolName, args) {
        if (!window.electronMCP?.callTool) return { error: 'MCP not available in this build.' };
        // Lazy start + idle lifecycle + output caps all live in main.
        return await window.electronMCP.callTool(serverName, toolName, args);
    }
};

if (typeof window !== 'undefined') {
    window.MCPTools = MCPTools;
    // Register cached tools at startup (spawns nothing).
    MCPTools.ready = MCPTools.init();
}
