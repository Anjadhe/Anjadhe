/** Linear's plain-language door onto the existing machine-local MCP connection.
 * A reference source: no background import, local replica or new tool policy.
 */
const LinearConnector = {
    URL: 'https://mcp.linear.app/mcp',
    _servers: [],
    _loaded: false,
    _busy: false,
    _error: '',
    _readError: '',
    _revision: 0,

    matches(server) { return server.auth === 'oauth' && server.url?.replace(/\/$/, '') === this.URL; },
    server() {
        const matches = this._servers.filter(s => this.matches(s));
        return matches.find(s => s.authStatus === 'connecting')
            || matches.find(s => s.enabled && s.authStatus === 'connected') || matches[0];
    },
    status() {
        const server = this.server();
        const on = !!(server?.enabled && server.authStatus === 'connected');
        const connecting = server?.authStatus === 'connecting';
        const error = this._error || this._readError;
        return { on, error: !!error || server?.authStatus === 'reconnect',
            value: !window.electronMCP ? 'Not available' : this._readError ? 'Needs attention' : !this._loaded ? 'Loading…'
                : connecting ? 'Waiting for sign-in' : this._busy ? 'Connecting…'
                    : error ? 'Needs attention' : on ? 'Connected'
                        : server?.authStatus === 'reconnect' ? 'Sign in again'
                            : server && !server.enabled ? 'Off' : 'Not connected',
            detail: error };
    },
    _changed() { window.dispatchEvent(new CustomEvent('anjadhe:connectors-changed')); },
    async refresh() {
        if (!window.electronMCP) return;
        const revision = ++this._revision;
        try {
            const servers = await window.electronMCP.listServers();
            if (revision !== this._revision) return;
            this._servers = servers;
            this._loaded = true;
            this._readError = '';
        } catch {
            if (revision !== this._revision) return;
            this._readError = 'Could not check your Linear connection. Try again.';
        }
        this._changed();
    },
    async connect() {
        if (this._busy || !window.electronMCP || typeof SettingsApp === 'undefined') return;
        this._busy = true; this._error = ''; this._changed();
        try {
            await this.refresh();
            if (this._readError) return;
            let server = this.server();
            if (!server) {
                // Reuse any existing Linear connection; never replace a user's
                // differently configured server just because it has this name.
                let name = 'linear', suffix = 2;
                while (this._servers.some(s => s.name === name)) name = `linear-${suffix++}`;
                const added = await window.electronMCP.addServer({ name, url: this.URL, auth: 'oauth' });
                if (added.error) throw new Error(added.error);
                server = { name: added.name };
            } else if (!server.enabled) {
                const enabled = await window.electronMCP.setEnabled(server.name, true);
                if (enabled.error) throw new Error(enabled.error);
            }
            const result = await SettingsApp._connectMCPServer(server.name, { label: 'Linear' });
            if (result?.error) this._error = result.error;
        } catch (e) { this._error = e.message || 'Could not connect to Linear. Try again.'; }
        finally { this._busy = false; await this.refresh(); }
    },
    async disconnect() {
        this._error = '';
        try {
            // Disconnect every Linear connection so the simple page cannot say
            // "disconnected" while a duplicate still grants access.
            const servers = await window.electronMCP.listServers();
            for (const server of servers.filter(s => this.matches(s))) {
                const result = await window.electronMCP.disconnectServer(server.name);
                if (result.error) throw new Error(result.error);
                if (typeof MCPTools !== 'undefined') MCPTools.unregisterServer(server.name);
            }
        } catch (e) { this._error = e.message || 'Could not disconnect. Try again.'; }
        await this.refresh();
    },
    async cancel() {
        try {
            const server = this.server();
            if (server) {
                const result = await window.electronMCP.cancelAuthorization(server.name);
                if (result.error) throw new Error(result.error);
            }
        } catch (e) { this._error = e.message || 'Could not cancel sign-in. Try again.'; }
        await this.refresh();
    },
    init() {
        if (typeof FEATURES !== 'undefined' && !FEATURES.isEnabled('mcp')) return;
        if (typeof Sources !== 'undefined') Sources.register({
            id: 'linear', label: 'Linear', icon: 'check', iconAsset: 'linear.svg', kind: 'tasks', mode: 'reference', writesBack: true,
            words: 'workspace issues projects cycles teams tickets bugs milestones',
            reads: 'Linear issues, projects and comments you ask nenva to find, read, create or update. Content you ask it to read is shared with your selected AI model.',
            status: () => this.status(), page: S => S._linearHtml()
        });
        window.electronMCP?.onServersChanged?.(() => this.refresh());
        this.refresh();
    }
};
LinearConnector.init();
