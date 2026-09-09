/**
 * MCPManager — Model Context Protocol client for the assistant
 * (docs/COWORK_AGENT.md §2, phase C2). Main process only.
 *
 * Speaks MCP's stdio transport directly: newline-delimited JSON-RPC 2.0
 * (initialize → notifications/initialized → tools/list / tools/call). The
 * protocol surface the assistant needs is deliberately tiny, so a
 * hand-rolled client beats pulling the SDK into Electron's main process
 * (no ESM/CJS friction, and we own the lifecycle).
 *
 * Lifecycle mirrors the local-engine philosophy: servers start lazily on first
 * tool call, stop after IDLE_MS of no calls, and restart ONCE after a
 * crash (a flapping server stays down until the user re-tests it).
 *
 * Config lives in the machine-local settingsStore (`mcpServers`) — stdio
 * commands are machine paths, so this must never sync. Env values are
 * encrypted with safeStorage. Each server carries a `toolsCache` captured
 * on every successful connect, so the renderer can register tool schemas
 * at startup without spawning anything.
 */

const { spawn } = require('child_process');
const { nativeImage } = require('electron');
const Secrets = require('./secret-store');

// GUI-launched Electron on macOS gets launchd's minimal PATH, not the user's
// shell PATH — so `npx` / `node` / anything from homebrew or nvm is ENOENT
// even though it works fine in Terminal. Capture the login shell's PATH once
// (marker-delimited so rc-file chatter can't pollute it) and merge it with
// the inherited one; the hardcoded dirs are a fallback for when the shell
// probe itself fails.
let _shellPath = null;
function _resolvePath() {
    if (_shellPath === null) {
        try {
            const { execFileSync } = require('child_process');
            const shell = process.env.SHELL || '/bin/zsh';
            const out = execFileSync(shell, ['-ilc', 'printf "__P__%s__P__" "$PATH"'],
                { timeout: 5000, encoding: 'utf8' });
            _shellPath = out.match(/__P__(.*)__P__/s)?.[1] || '';
        } catch { _shellPath = ''; }
    }
    const merged = [
        ...(process.env.PATH || '').split(':'),
        ..._shellPath.split(':'),
        '/opt/homebrew/bin', '/usr/local/bin'
    ].filter(Boolean);
    return [...new Set(merged)].join(':');
}

const PROTOCOL_VERSION = '2025-06-18';
const IDLE_MS = 10 * 60 * 1000;   // stop a server after 10 min without calls
const CALL_TIMEOUT_MS = 60 * 1000;
const START_TIMEOUT_MS = 15 * 1000;
const OUTPUT_CAP = 8000;          // chars of tool output returned to the model

class MCPConnection {
    constructor(config, onExit) {
        this.config = config;
        this.onExit = onExit;
        this.proc = null;
        this.buffer = '';
        this.nextId = 1;
        this.pending = new Map();   // id -> {resolve, reject, timer}
        this.idleTimer = null;
        this.initialized = false;
    }

    async start() {
        // M7: don't hand the MCP child our whole environment — scrub
        // secret-shaped vars (GMAIL_CLIENT_SECRET, API keys in .env, …) with
        // the same denylist run_command uses. The server's OWN configured env
        // (decrypted) is merged on top, so intentional per-server secrets
        // still reach it; a malicious/supply-chain server just can't read
        // Anjadhe's unrelated secrets.
        const scrubbed = {};
        for (const [k, v] of Object.entries(process.env)) {
            if (!/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(k)) scrubbed[k] = v;
        }
        const env = { ...scrubbed, ...decryptEnv(this.config.env), PATH: _resolvePath() };
        this.proc = spawn(this.config.command, this.config.args || [], {
            env,
            cwd: require('os').homedir(),
            stdio: ['pipe', 'pipe', 'pipe']
        });
        // A missing binary surfaces as an async 'error' event (ENOENT), and
        // writes to the dead child's stdin error too. Without handlers both
        // are uncaught exceptions that crash the whole main process with
        // Electron's JS-error dialog — turn them into a clean rejection of
        // whatever call is in flight instead.
        this.proc.on('error', (err) => {
            const friendly = err.code === 'ENOENT'
                ? `Could not start "${this.config.command}": command not found. Is it installed and on your PATH?`
                : `Could not start MCP server: ${err.message}`;
            for (const [, p] of this.pending) {
                clearTimeout(p.timer);
                p.reject(new Error(friendly));
            }
            this.pending.clear();
            this.proc = null;
            this.initialized = false;
            if (this.idleTimer) clearTimeout(this.idleTimer);
            this.onExit?.(null);
        });
        this.proc.stdin.on('error', () => {});
        this.proc.stdout.on('data', (chunk) => this._onData(chunk));
        this.proc.stderr.on('data', (chunk) => {
            console.warn(`[mcp:${this.config.name}] stderr:`, String(chunk).slice(0, 500));
        });
        this.proc.on('exit', (code) => {
            for (const [, p] of this.pending) {
                clearTimeout(p.timer);
                p.reject(new Error(`MCP server exited (code ${code})`));
            }
            this.pending.clear();
            this.proc = null;
            this.initialized = false;
            if (this.idleTimer) clearTimeout(this.idleTimer);
            this.onExit?.(code);
        });

        // MCP handshake.
        const init = await this._request('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'anjadhe', version: '1.0' }
        }, START_TIMEOUT_MS);
        this._notify('notifications/initialized', {});
        this.initialized = true;
        this.serverInfo = init?.serverInfo || null;
        this._touch();
        return init;
    }

    stop() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        if (this.proc) {
            try { this.proc.kill(); } catch {}
        }
    }

    async listTools() {
        const res = await this._request('tools/list', {});
        this._touch();
        return (res?.tools || []).map(t => ({
            name: t.name,
            description: t.description || '',
            inputSchema: t.inputSchema || { type: 'object', properties: {} },
            // MCP tool annotations (2025-06-18 spec). Server-supplied HINTS,
            // not a security boundary — but the renderer uses destructiveHint
            // to keep a "trust this server" grant from silently covering a
            // destructive tool (M8).
            annotations: (t.annotations && typeof t.annotations === 'object') ? t.annotations : null
        }));
    }

    async callTool(name, args) {
        const res = await this._request('tools/call', { name, arguments: args || {} }, CALL_TIMEOUT_MS);
        this._touch();
        return res;
    }

    _touch() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            console.log(`[mcp:${this.config.name}] idle — stopping`);
            this.stop();
        }, IDLE_MS);
    }

    _onData(chunk) {
        this.buffer += String(chunk);
        let nl;
        while ((nl = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id !== undefined && this.pending.has(msg.id)) {
                const p = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                clearTimeout(p.timer);
                if (msg.error) p.reject(new Error(msg.error.message || 'MCP error'));
                else p.resolve(msg.result);
            }
            // Server-initiated requests/notifications (sampling, roots…) are
            // out of scope for v1 — ignored.
        }
    }

    _request(method, params, timeoutMs = CALL_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
            if (!this.proc || !this.proc.stdin.writable) {
                reject(new Error('MCP server is not running'));
                return;
            }
            const id = this.nextId++;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP ${method} timed out`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
    }

    _notify(method, params) {
        if (this.proc && this.proc.stdin.writable) {
            this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
        }
    }
}

/**
 * Streamable HTTP transport (C8.7) — hosted MCP servers, no local runtime.
 * Same surface as MCPConnection (start/stop/listTools/callTool). Each
 * JSON-RPC request is a POST to the server URL; the response is either
 * plain JSON or an SSE stream carrying the response message (both required
 * by the 2025 spec). The Mcp-Session-Id from initialize rides every later
 * request. The URL is user-entered in Settings (never model-controlled),
 * so localhost/private servers are deliberately allowed — a local bridge
 * is a legitimate MCP server.
 *
 * Legacy two-endpoint HTTP+SSE servers are NOT supported; initialize
 * failing with 4xx says so plainly instead of failing cryptically.
 */
class MCPHttpConnection {
    constructor(config, onExit) {
        this.config = config;
        this.onExit = onExit;   // unused (no process) — kept for interface parity
        this.nextId = 1;
        this.sessionId = null;
        this.initialized = false;
        this.serverInfo = null;
    }

    async start() {
        const init = await this._request('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'anjadhe', version: '1.0' }
        }, START_TIMEOUT_MS);
        await this._notify('notifications/initialized');
        this.initialized = true;
        this.serverInfo = init?.serverInfo || null;
        return init;
    }

    stop() {
        // Politely end the session where the server supports it.
        if (this.sessionId) {
            fetch(this.config.url, { method: 'DELETE', headers: this._headers() }).catch(() => {});
        }
        this.initialized = false;
        this.sessionId = null;
    }

    async listTools() {
        const res = await this._request('tools/list', {});
        return (res?.tools || []).map(t => ({
            name: t.name,
            description: t.description || '',
            inputSchema: t.inputSchema || { type: 'object', properties: {} },
            annotations: (t.annotations && typeof t.annotations === 'object') ? t.annotations : null
        }));
    }

    async callTool(name, args) {
        return await this._request('tools/call', { name, arguments: args || {} }, CALL_TIMEOUT_MS);
    }

    _headers() {
        const h = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            ...decryptEnv(this.config.headers)
        };
        if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
        if (this.initialized) h['MCP-Protocol-Version'] = PROTOCOL_VERSION;
        return h;
    }

    async _post(body, timeoutMs) {
        const res = await fetch(this.config.url, {
            method: 'POST',
            headers: this._headers(),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs)
        });
        const sid = res.headers.get('mcp-session-id');
        if (sid) this.sessionId = sid;
        return res;
    }

    async _request(method, params, timeoutMs = CALL_TIMEOUT_MS) {
        const id = this.nextId++;
        let res;
        try {
            res = await this._post({ jsonrpc: '2.0', id, method, params }, timeoutMs);
        } catch (e) {
            throw new Error(/abort|timeout/i.test(String(e?.name || e)) ? `MCP ${method} timed out` : `Could not reach ${this.config.url}: ${e.message}`);
        }
        if (res.status === 401 || res.status === 403) {
            throw new Error(`The server rejected the request (${res.status}) — check its access token in Settings.`);
        }
        if (!res.ok) {
            const bodyText = (await res.text().catch(() => '')).slice(0, 200);
            throw new Error(method === 'initialize'
                ? `The server refused to initialize (HTTP ${res.status}). It may require a token, or use the older SSE transport this app does not speak. ${bodyText}`
                : `MCP server error (HTTP ${res.status}): ${bodyText}`);
        }
        const ctype = (res.headers.get('content-type') || '').toLowerCase();
        if (ctype.includes('text/event-stream')) {
            const msg = await this._readSseResponse(res, id, timeoutMs);
            if (msg.error) throw new Error(msg.error.message || 'MCP error');
            return msg.result;
        }
        const msg = await res.json().catch(() => null);
        if (!msg) throw new Error('MCP server returned an unreadable response');
        if (msg.error) throw new Error(msg.error.message || 'MCP error');
        return msg.result;
    }

    /** Read an SSE body until the JSON-RPC response with our id arrives. */
    async _readSseResponse(res, id, timeoutMs) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // SSE events are separated by a blank line; data: lines carry payload.
            let sep;
            while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
                const rawEvent = buffer.slice(0, sep);
                buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '');
                const data = rawEvent.split(/\r?\n/)
                    .filter(l => l.startsWith('data:'))
                    .map(l => l.slice(5).trim())
                    .join('\n');
                if (!data) continue;
                let msg;
                try { msg = JSON.parse(data); } catch { continue; }
                if (msg.id === id) {
                    reader.cancel().catch(() => {});
                    return msg;
                }
                // Server-initiated requests/notifications: out of scope, skip.
            }
        }
        reader.cancel().catch(() => {});
        throw new Error('MCP response stream ended without an answer');
    }

    async _notify(method) {
        try {
            await this._post({ jsonrpc: '2.0', method, params: {} }, START_TIMEOUT_MS);
        } catch { /* notification delivery is best-effort */ }
    }
}

function encryptEnv(env) {
    const out = {};
    for (const [k, v] of Object.entries(env || {})) {
        if (!k || typeof v !== 'string') continue;
        out[k] = Secrets.isEncryptionAvailable()
            ? { enc: Secrets.encryptString(v).toString('base64') }
            : { plain: v };
    }
    return out;
}

function decryptEnv(env) {
    const out = {};
    for (const [k, v] of Object.entries(env || {})) {
        try {
            if (v && v.enc) out[k] = Secrets.decryptString(Buffer.from(v.enc, 'base64'));
            else if (v && v.plain !== undefined) out[k] = v.plain;
        } catch (e) {
            console.warn(`[mcp] could not decrypt env ${k}:`, e.message);
        }
    }
    return out;
}

const MCPManager = {
    _store: null,                 // settingsStore, injected via init
    _connections: new Map(),      // server name -> MCPConnection
    _restarted: new Set(),        // names that already used their one crash-restart
    _lastOutputs: new Map(),      // server name -> { tool, text, offset } for continue_output

    init(settingsStore) {
        this._store = settingsStore;
    },

    _servers() {
        const list = this._store.get('mcpServers');
        return Array.isArray(list) ? list : [];
    },

    _saveServers(list) {
        this._store.set('mcpServers', list);
    },

    /** Public listing — env/header values are never sent to the renderer. */
    listServers() {
        return this._servers().map(s => ({
            name: s.name,
            command: s.command,
            args: s.args || [],
            url: s.url || null,
            transport: s.url ? 'http' : 'stdio',
            enabled: s.enabled !== false,
            envKeys: Object.keys(s.env || {}),
            tools: s.toolsCache || [],
            running: this._connections.has(s.name)
        }));
    },

    /**
     * Register a server. Either a stdio launch command OR a hosted URL
     * (C8.7 — Streamable HTTP, no local runtime). `headers` (e.g. an
     * Authorization token) are stored encrypted exactly like env.
     */
    addServer({ name, command, args, env, url, headers }) {
        const clean = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
        if (!clean) return { error: 'name required' };
        const cleanUrl = String(url || '').trim();
        if (cleanUrl) {
            try {
                const u = new URL(cleanUrl);
                if (!/^https?:$/.test(u.protocol)) return { error: 'server URL must be http(s)' };
            } catch { return { error: 'server URL is not a valid URL' }; }
        } else if (!command || !String(command).trim()) {
            return { error: 'a launch command or a server URL is required' };
        }
        const servers = this._servers();
        if (servers.some(s => s.name === clean)) return { error: `A server named "${clean}" already exists` };
        const record = {
            name: clean,
            enabled: true,
            toolsCache: [],
            createdAt: new Date().toISOString()
        };
        if (cleanUrl) {
            record.url = cleanUrl;
            record.headers = encryptEnv(headers);
        } else {
            record.command = String(command).trim();
            record.args = Array.isArray(args) ? args.map(String) : [];
            record.env = encryptEnv(env);
        }
        servers.push(record);
        this._saveServers(servers);
        return { ok: true, name: clean };
    },

    /**
     * C8.7 failure honesty: is this runtime binary actually on this Mac?
     * Checked at Add time so "needs Node.js" is a sentence, not a cryptic
     * first-tool-call failure.
     */
    checkRuntime(binary) {
        const clean = String(binary || '').trim();
        if (!/^[a-z0-9._-]+$/i.test(clean)) return { found: false };
        const fs = require('fs');
        const path = require('path');
        for (const dir of _resolvePath().split(':')) {
            try {
                const p = path.join(dir, clean);
                fs.accessSync(p, fs.constants.X_OK);
                return { found: true, path: p };
            } catch { /* keep looking */ }
        }
        return { found: false };
    },

    removeServer(name) {
        this._stopServer(name);
        this._saveServers(this._servers().filter(s => s.name !== name));
        return { ok: true };
    },

    setEnabled(name, enabled) {
        const servers = this._servers();
        const s = servers.find(x => x.name === name);
        if (!s) return { error: 'unknown server' };
        s.enabled = enabled !== false;
        if (!s.enabled) this._stopServer(name);
        this._saveServers(servers);
        return { ok: true };
    },

    /**
     * Start (or reuse) the connection for a server. Lazy: called on first
     * tool call and by test/refresh. Refreshes toolsCache on every
     * successful connect so the renderer's registrations stay current.
     */
    async _connect(name) {
        const existing = this._connections.get(name);
        if (existing && existing.initialized) return existing;

        const config = this._servers().find(s => s.name === name);
        if (!config) throw new Error(`unknown MCP server: ${name}`);
        if (config.enabled === false) throw new Error(`MCP server "${name}" is disabled`);

        const conn = config.url
            ? new MCPHttpConnection(config)
            : new MCPConnection(config, (code) => {
                this._connections.delete(name);
                // One crash-restart: only for dirty exits,
                // and only once until a manual test/list resets the breaker.
                if (code !== 0 && code !== null && !this._restarted.has(name)) {
                    this._restarted.add(name);
                    console.warn(`[mcp:${name}] crashed (code ${code}) — will restart on next call`);
                }
            });
        this._connections.set(name, conn);
        try {
            await conn.start();
            const tools = await conn.listTools();
            const servers = this._servers();
            const s = servers.find(x => x.name === name);
            if (s) { s.toolsCache = tools; this._saveServers(servers); }
            this._restarted.delete(name);
            return conn;
        } catch (e) {
            this._connections.delete(name);
            conn.stop();
            throw e;
        }
    },

    _stopServer(name) {
        const conn = this._connections.get(name);
        if (conn) {
            conn.stop();
            this._connections.delete(name);
        }
    },

    /** Test/refresh: connect (starting if needed) and list tools. */
    async testServer(name) {
        this._restarted.delete(name);  // manual action resets the crash breaker
        try {
            const conn = await this._connect(name);
            const tools = await conn.listTools();
            return { ok: true, serverInfo: conn.serverInfo, tools };
        } catch (e) {
            return { error: e.message };
        }
    },

    /**
     * Call a tool. Flattens MCP's content array to text for the model,
     * windowed to the context budget. The FULL text is kept per server so
     * mcp_<server>_continue_output can page through it — a browser
     * snapshot of a real site (Amazon: 100k+ chars) is unusable if the
     * model can only ever see the first window.
     */
    async callTool(name, toolName, args) {
        try {
            const conn = await this._connect(name);
            // Main-side gate (M8): the renderer's permission dialog is the
            // primary consent gate, but main must not be a blind executor for
            // whatever the renderer sends. _connect already rejects unknown /
            // disabled servers; here we also reject any tool the server didn't
            // advertise, so a buggy or compromised renderer can't invoke an
            // arbitrary or fabricated tool name.
            const cfg = this._servers().find(s => s.name === name);
            const known = (cfg?.toolsCache || []).some(t => t.name === toolName);
            if (!known) return { error: `MCP server "${name}" does not expose a tool named "${toolName}".` };
            const res = await conn.callTool(toolName, args);
            // Image blocks (browser screenshots) ride back to the renderer as
            // downscaled JPEG data URLs — the agent injects them into the
            // model's context when the active model has vision, and explains
            // their absence when it doesn't. Same 1568px budget as chat
            // attachments; capped at 2 per call.
            const images = [];
            for (const c of (res?.content || [])) {
                if (c.type !== 'image' || !c.data || images.length >= 2) continue;
                try {
                    let img = nativeImage.createFromBuffer(Buffer.from(c.data, 'base64'));
                    if (img.isEmpty()) continue;
                    if (img.getSize().width > 1568) img = img.resize({ width: 1568 });
                    const jpg = img.toJPEG(80);
                    if (jpg.length <= 3 * 1024 * 1024) {
                        images.push({ mime: 'image/jpeg', dataUrl: `data:image/jpeg;base64,${jpg.toString('base64')}` });
                    }
                } catch { /* undecodable image block — falls through to the placeholder */ }
            }
            const text = (res?.content || [])
                .map(c => {
                    if (c.type === 'text') return c.text;
                    if (c.type === 'resource' && c.resource?.text) return c.resource.text;
                    // The renderer appends what actually happened to the
                    // image (attached vs. model can't see it).
                    if (c.type === 'image') return '[image captured]';
                    return `[${c.type} content omitted]`;
                })
                .join('\n');
            if (res?.isError) {
                return { error: text.slice(0, OUTPUT_CAP) || 'MCP tool reported an error' };
            }
            this._lastOutputs.set(name, { tool: toolName, text, offset: 0 });
            const win = this._outputWindow(name);
            if (images.length) win.images = images;
            return win;
        } catch (e) {
            return { error: e.message };
        }
    },

    /** Next OUTPUT_CAP-sized window of the last tool output for a server. */
    continueOutput(name) {
        if (!this._lastOutputs.has(name)) {
            return { error: 'No previous tool output to continue — call a tool first.' };
        }
        return this._outputWindow(name);
    },

    _outputWindow(name) {
        const st = this._lastOutputs.get(name);
        const start = st.offset;
        if (start > 0 && start >= st.text.length) {
            return { result: '(end of output — nothing more)' };
        }
        const chunk = st.text.slice(start, start + OUTPUT_CAP);
        st.offset = start + chunk.length;
        const remaining = st.text.length - st.offset;
        let note = '';
        if (remaining > 0) {
            note = `\n…[${st.tool} output truncated — characters ${start.toLocaleString()}–${st.offset.toLocaleString()} of ${st.text.length.toLocaleString()}. Call mcp_${name}_continue_output to read the next part]`;
        } else if (start > 0) {
            note = '\n[end of output]';
        }
        return { result: chunk + note, truncated: remaining > 0 };
    },

    stopAll() {
        for (const name of [...this._connections.keys()]) this._stopServer(name);
    }
};

module.exports = MCPManager;
// Shared by other main-process spawn sites (run_command) that hit the same
// Finder-launch minimal-PATH problem.
module.exports.resolveShellPath = _resolvePath;
