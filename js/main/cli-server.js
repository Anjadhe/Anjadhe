/**
 * CLIServer — terminal access to the running app (docs/COWORK_AGENT.md C7.3).
 *
 * A loopback-only HTTP server that lets the `anjadhe` CLI drive the SAME
 * brain the app runs: requests are relayed to the renderer (where
 * AgentService/TaskService live), events stream back as NDJSON lines.
 * Deliberately a thin pipe — no second agent stack, no model access of its
 * own, so permissions, model routing, memory, and transparency logs all
 * stay where they are.
 *
 * Security model:
 *  - Binds 127.0.0.1 only, and ONLY while the user has Terminal access
 *    enabled in Settings (off by default).
 *  - Every request needs the per-install bearer token, minted on first
 *    enable and written 0600 to ~/.anjadhe_cli.json for the CLI to read
 *    (deleted on disable). The token never appears in logs or sync.
 *  - The CLI inherits the app's permission machinery: a tool call that
 *    would show the in-app dialog becomes a permission_request event the
 *    CLI answers at the TTY — grants land in the same PermissionManager.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CLI_PORT = 18789;
// Under ANJADHE_DATA_ROOT (blank-slate testing) every writable location the
// app owns must derive from it — the CLI finds the redirected file via
// ANJADHE_CLI_CONFIG.
const CLI_CONFIG_PATH = process.env.ANJADHE_DATA_ROOT
    ? path.join(path.resolve(process.env.ANJADHE_DATA_ROOT), 'cli.json')
    : path.join(os.homedir(), '.anjadhe_cli.json');
const REQUEST_BODY_CAP = 256 * 1024;

const CLIServer = {
    _store: null,
    _getWindow: null,
    _server: null,
    _token: null,
    // requestId -> { res } — open NDJSON streams awaiting renderer events.
    _pending: new Map(),
    _seq: 0,

    init(settingsStore, getWindow, appVersion) {
        this._store = settingsStore;
        this._getWindow = getWindow;
        this._version = appVersion || '0.0.0';
        if (this._store.get('cliEnabled', false) === true) {
            this.enable().catch((e) => console.error('[cli] enable at startup failed:', e.message));
        }
    },

    isEnabled() {
        return !!this._server;
    },

    async enable() {
        if (this._server) return { enabled: true, port: CLI_PORT };
        let token = this._store.get('cliToken', null);
        if (!token) {
            token = crypto.randomBytes(24).toString('hex');
            this._store.set('cliToken', token);
        }
        this._token = token;
        await new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => this._handle(req, res));
            server.on('error', reject);
            server.listen(CLI_PORT, '127.0.0.1', () => { this._server = server; resolve(); });
        });
        this._store.set('cliEnabled', true);
        // The CLI's discovery file: mode 0600, owner-only.
        fs.writeFileSync(CLI_CONFIG_PATH, JSON.stringify({ port: CLI_PORT, token }), { mode: 0o600 });
        console.log(`[cli] terminal access enabled on 127.0.0.1:${CLI_PORT}`);
        return { enabled: true, port: CLI_PORT };
    },

    disable() {
        if (this._server) {
            for (const [, p] of this._pending) { try { p.res.end(); } catch {} }
            this._pending.clear();
            try { this._server.close(); } catch {}
            this._server = null;
        }
        this._store.set('cliEnabled', false);
        try { fs.unlinkSync(CLI_CONFIG_PATH); } catch {}
        console.log('[cli] terminal access disabled');
        return { enabled: false };
    },

    status() {
        let binPath = null;
        try { binPath = path.join(require('electron').app.getAppPath(), 'bin', 'anjadhe'); } catch { /* not in electron */ }
        return {
            enabled: this.isEnabled(),
            port: CLI_PORT,
            configPath: CLI_CONFIG_PATH,
            binPath,
            installedAt: this._findInstalled()
        };
    },

    _installDirs() {
        return ['/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];
    },

    _findInstalled() {
        for (const dir of this._installDirs()) {
            const p = path.join(dir, 'anjadhe');
            if (fs.existsSync(p)) return p;
        }
        return null;
    },

    /**
     * One-click install (Settings button): write a small launcher into
     * /usr/local/bin (if writable) or ~/.local/bin. The launcher runs the
     * CLI script with the APP'S OWN binary as the Node runtime
     * (ELECTRON_RUN_AS_NODE), so the user doesn't need Node.js installed —
     * and it keeps working when the app updates because it re-reads
     * process.execPath at install time only... so it's re-written on every
     * install click; the Settings card offers reinstall when paths drift.
     */
    installCommand() {
        const script = path.join(require('electron').app.getAppPath(), 'bin', 'anjadhe');
        if (!fs.existsSync(script)) return { error: `CLI script missing at ${script}` };
        // Self-cleaning: macOS has no uninstall hook, so if the user trashes
        // the app, the next `anjadhe` run explains itself, removes the stale
        // token file, and deletes itself — no orphaned command.
        // Single-quote the interpolated paths so a directory containing a
        // shell metacharacter can't break out of the generated script.
        // (These paths are app-owned, not attacker-controlled — belt and
        // suspenders.) A literal single quote becomes '\''.
        const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
        const launcher = '#!/bin/sh\n'
            + '# anjadhe — generated by Anjadhe (Settings → AI Assistant → Terminal Access)\n'
            + `APP_BIN=${shq(process.execPath)}\n`
            + `CLI_JS=${shq(script)}\n`
            + 'if [ ! -x "$APP_BIN" ] || [ ! -f "$CLI_JS" ]; then\n'
            + '    echo "The Anjadhe app this command belonged to is no longer installed - removing the command." >&2\n'
            + '    rm -f "$HOME/.anjadhe_cli.json"\n'
            + '    rm -f "$0"\n'
            + '    exit 1\n'
            + 'fi\n'
            + 'export ELECTRON_RUN_AS_NODE=1\n'
            + 'exec "$APP_BIN" "$CLI_JS" "$@"\n';
        let lastErr = null;
        for (const dir of this._installDirs()) {
            try {
                fs.mkdirSync(dir, { recursive: true });
                const dest = path.join(dir, 'anjadhe');
                fs.writeFileSync(dest, launcher, { mode: 0o755 });
                // PATH hint against the user's real shell PATH (the GUI app's
                // own PATH is launchd-minimal and would always complain).
                let onPath = true;
                try {
                    const MCPManager = require('./mcp-manager');
                    onPath = MCPManager.resolveShellPath().split(':').includes(dir);
                } catch { /* assume fine */ }
                return { installedAt: dest, onPath, pathHint: onPath ? null : `Add to your PATH: export PATH="${dir}:$PATH"` };
            } catch (e) {
                lastErr = e;
            }
        }
        return { error: `Could not install the command: ${lastErr ? lastErr.message : 'no writable location'}` };
    },

    uninstallCommand() {
        const p = this._findInstalled();
        if (!p) return { removed: false };
        try { fs.unlinkSync(p); return { removed: true }; }
        catch (e) { return { error: `Could not remove ${p}: ${e.message}` }; }
    },

    /** Renderer → CLI: forward one event onto the request's NDJSON stream. */
    emitEvent(requestId, event) {
        const p = this._pending.get(requestId);
        if (!p) return;
        try {
            p.res.write(JSON.stringify(event) + '\n');
            if (event && (event.type === 'done' || event.type === 'error')) {
                p.res.end();
                this._pending.delete(requestId);
            }
        } catch {
            this._pending.delete(requestId);
        }
    },

    _auth(req) {
        const h = String(req.headers.authorization || '');
        const got = h.startsWith('Bearer ') ? h.slice(7) : '';
        if (!got || !this._token) return false;
        const a = Buffer.from(got), b = Buffer.from(this._token);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    },

    _json(res, code, obj) {
        const body = JSON.stringify(obj);
        res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
    },

    _readBody(req) {
        return new Promise((resolve, reject) => {
            let data = '';
            req.on('data', (c) => {
                data += c;
                if (data.length > REQUEST_BODY_CAP) { reject(new Error('body too large')); req.destroy(); }
            });
            req.on('end', () => {
                try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid JSON body')); }
            });
            req.on('error', reject);
        });
    },

    async _handle(req, res) {
        if (!this._auth(req)) { this._json(res, 401, { error: 'bad or missing token' }); return; }
        const url = String(req.url || '');
        try {
            if (req.method === 'GET' && url === '/v1/ping') {
                this._json(res, 200, { ok: true, app: 'anjadhe', version: this._version });
                return;
            }
            const win = this._getWindow && this._getWindow();
            if (!win || win.isDestroyed()) {
                this._json(res, 503, { error: 'The Anjadhe window is not open — open the app and try again.' });
                return;
            }
            if (req.method === 'POST' && (url === '/v1/ask' || url === '/v1/task')) {
                const body = await this._readBody(req);
                const message = String(body.message || '').trim();
                if (!message) { this._json(res, 400, { error: 'message required' }); return; }
                const requestId = `cli_${Date.now().toString(36)}_${++this._seq}`;
                res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
                this._pending.set(requestId, { res });
                req.on('close', () => {
                    // CLI hung up (Ctrl-C): renderer keeps running its turn —
                    // the conversation persists — but events stop flowing.
                    this._pending.delete(requestId);
                });
                win.webContents.send('cli-request', {
                    requestId,
                    kind: url === '/v1/task' ? 'task' : 'ask',
                    message,
                    autoApprove: body.yes === true
                });
                return;
            }
            if (req.method === 'POST' && url === '/v1/answer') {
                const body = await this._readBody(req);
                const win2 = this._getWindow();
                if (win2 && !win2.isDestroyed()) {
                    win2.webContents.send('cli-answer', {
                        askId: String(body.askId || ''),
                        approved: body.approved === true,
                        scope: ['once', 'session', 'always'].includes(body.scope) ? body.scope : 'once'
                    });
                }
                this._json(res, 200, { ok: true });
                return;
            }
            this._json(res, 404, { error: 'unknown endpoint' });
        } catch (e) {
            try { this._json(res, 400, { error: e.message }); } catch {}
        }
    }
};

module.exports = CLIServer;
