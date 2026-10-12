/** Browser authorization for hosted MCP servers. Main process only.
 * OAuth state/verifiers live only for the pending sign-in. Credentials are
 * encrypted as one machine-local record, never returned through IPC.
 * Only an explicit Settings action opens a browser; tool calls only refresh.
 */
const { randomBytes, createHash, timingSafeEqual } = require('crypto');
const http = require('http');
const { oauthResultPage, OAUTH_RESULT_CSP } = require('./oauth-result-page');
const Slack = require('./slack-mcp');

function secureUrl(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
        throw new Error('MCP sign-in requires an HTTPS URL without credentials or fragments.');
    }
    return url;
}

class MCPOAuth {
    constructor({ read, write, secrets, openExternal, fetch: fetchImpl = globalThis.fetch,
        timeoutMs = 5 * 60 * 1000 }) {
        Object.assign(this, { read, write, secrets, openExternal, fetch: fetchImpl, timeoutMs });
        this.pending = new Map();
        this.refreshes = new Map();
        this.generations = new Map();
    }

    _load(name) {
        const stored = this.read(name)?.oauth;
        if (!stored) return null;
        try { return JSON.parse(this.secrets.decryptString(Buffer.from(stored.enc, 'base64'))); }
        catch { throw new Error('Could not unlock this connection. Reconnect in Tool Servers.'); }
    }

    _save(name, data, generation) {
        if ((this.generations.get(name) || 0) !== generation || !this.read(name)) {
            throw new Error('Sign-in was cancelled.');
        }
        if (!this.secrets.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable.');
        this.write(name, { enc: this.secrets.encryptString(JSON.stringify(data)).toString('base64') });
    }

    status(name) {
        if (this.pending.has(name)) return 'connecting';
        try {
            const data = this._load(name);
            return data?.access_token && (data.refresh_token || !data.expiresAt || data.expiresAt > Date.now())
                ? 'connected' : 'disconnected';
        } catch { return 'reconnect'; }
    }

    cancel(name) {
        this.generations.set(name, (this.generations.get(name) || 0) + 1);
        this.pending.get(name)?.abort();
        this.pending.delete(name);
        this.refreshes.delete(name);
    }

    disconnect(name) {
        this.cancel(name);
        this.write(name, null);
    }

    async _json(url, options = {}) {
        secureUrl(url);
        const res = await this.fetch(String(url), {
            ...options, redirect: 'error', signal: options.signal || AbortSignal.timeout(15000),
            headers: { Accept: 'application/json', ...options.headers }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            // Never echo OAuth response bodies: they may contain credentials.
            const error = new Error(`MCP sign-in request failed (HTTP ${res.status}).`);
            error.invalidGrant = data.error === 'invalid_grant' || data.error === 'invalid_client';
            throw error;
        }
        return data;
    }

    async discover(serverUrl, signal) {
        const server = secureUrl(serverUrl);
        // Read the resource challenge without credentials, then well-known
        // path + origin fallbacks for servers that do not advertise a challenge.
        const response = await this.fetch(server.href, {
            method: 'POST', redirect: 'error', signal,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
                protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'anjadhe', version: '1.0' }
            } })
        });
        const challenge = response.headers.get('www-authenticate') || '';
        await response.body?.cancel();
        const advertised = challenge.match(/\bresource_metadata="([^"]+)"/i)?.[1];
        const candidates = advertised ? [advertised] : [
            `${server.origin}/.well-known/oauth-protected-resource${server.pathname === '/' ? '' : server.pathname}`,
            `${server.origin}/.well-known/oauth-protected-resource`
        ];
        let resource;
        for (const url of [...new Set(candidates)]) {
            try { resource = await this._json(url, { signal }); break; }
            catch (e) { if (signal?.aborted || advertised) throw e; }
        }
        const slack = Slack.isSlack(serverUrl);
        // Slack identifies the protected resource by its origin, not /mcp.
        if (!resource?.resource || new URL(resource.resource).href !== (slack ? 'https://mcp.slack.com/' : server.href)) {
            throw new Error('The sign-in resource does not match this MCP server.');
        }
        const issuer = secureUrl(resource.authorization_servers?.[0]);
        const metadata = await this._json(`${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname === '/' ? '' : issuer.pathname}`, { signal });
        if (new URL(metadata.issuer).href !== issuer.href) throw new Error('MCP sign-in issuer mismatch.');
        for (const key of ['authorization_endpoint', 'token_endpoint']) secureUrl(metadata[key]);
        if (slack) {
            // Slack advertises client_secret_post even for registered PKCE apps.
            // Pin all endpoints before applying its documented public-client exception.
            if (metadata.issuer !== 'https://mcp.slack.com' ||
                metadata.authorization_endpoint !== 'https://slack.com/oauth/v2_user/authorize' ||
                metadata.token_endpoint !== 'https://slack.com/api/oauth.v2.user.access') {
                throw new Error('Slack sign-in endpoints do not match.');
            }
        } else {
            if (!metadata.registration_endpoint) throw new Error('This server requires a registered OAuth client.');
            secureUrl(metadata.registration_endpoint);
        }
        if (!metadata.code_challenge_methods_supported?.includes('S256')) throw new Error('This server does not support secure PKCE sign-in.');
        if (!slack && metadata.token_endpoint_auth_methods_supported && !metadata.token_endpoint_auth_methods_supported.includes('none')) {
            throw new Error('This server does not support desktop sign-in without a client secret.');
        }
        return { metadata, resource: resource.resource, scope: slack ? Slack.SCOPES.join(',') : (resource.scopes_supported || metadata.scopes_supported || []).join(' ') };
    }

    async authorize(name) {
        if (this.pending.has(name)) throw new Error('Sign-in is already in progress.');
        const config = this.read(name);
        if (!config || config.auth !== 'oauth' || config.enabled === false) throw new Error('Enable this OAuth server before connecting.');
        const slack = Slack.isSlack(config.url);
        if (slack && !Slack.validClientId(Slack.clientId())) throw new Error('Slack connection is not available in this build yet.');
        if (!this.secrets.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable.');
        const generation = this.generations.get(name) || 0;
        const controller = new AbortController();
        this.pending.set(name, controller);
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let listener;
        try {
            const { metadata, resource, scope } = await this.discover(config.url, controller.signal);
            const state = randomBytes(32).toString('base64url');
            const verifier = randomBytes(32).toString('base64url');
            listener = await this._callback(state, metadata.issuer, controller.signal, slack ? Slack.LOOPBACK_URI : null);
            const redirectUri = slack ? Slack.REDIRECT_URI : listener.url;
            const client = slack ? { client_id: Slack.clientId() } : await this._json(metadata.registration_endpoint, {
                method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ client_name: 'nenva', client_uri: 'https://nenva.co',
                    redirect_uris: [listener.url], grant_types: ['authorization_code', 'refresh_token'],
                    response_types: ['code'], token_endpoint_auth_method: 'none', ...(scope ? { scope } : {}) })
            });
            if (typeof client.client_id !== 'string' || !client.client_id || client.client_secret ||
                (client.token_endpoint_auth_method && client.token_endpoint_auth_method !== 'none')) {
                throw new Error('This server did not register a public desktop client.');
            }
            const url = secureUrl(metadata.authorization_endpoint);
            const params = { response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri,
                code_challenge: createHash('sha256').update(verifier).digest('base64url'),
                code_challenge_method: 'S256', state, resource, ...(scope ? { scope } : {}) };
            for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
            if (controller.signal.aborted) throw new Error('Sign-in was cancelled.');
            await this.openExternal(url.href);
            const code = await listener.code;
            const data = { serverUrl: config.url, metadata, resource, client_id: client.client_id };
            const tokens = await this._token(data, { grant_type: 'authorization_code', code,
                code_verifier: verifier, redirect_uri: redirectUri }, controller.signal);
            this._save(name, this._withTokens(data, tokens), generation);
        } catch (e) {
            if (controller.signal.aborted) throw new Error('Sign-in cancelled or timed out. Connect again when you are ready.');
            throw e;
        } finally {
            clearTimeout(timer);
            listener?.close();
            if (this.pending.get(name) === controller) this.pending.delete(name);
        }
    }

    async _callback(state, issuer, signal, redirectUri = null) {
        let resolveCode, rejectCode;
        const code = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
        code.catch(() => {}); // cancellation can precede browser launch
        const server = http.createServer((req, res) => {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Content-Security-Policy', OAUTH_RESULT_CSP);
            res.setHeader('Referrer-Policy', 'no-referrer');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            const invalid = () => {
                res.writeHead(400);
                res.end(oauthResultPage('Could not verify sign-in', 'This response could not be matched to your sign-in. Return to nenva and connect again.'));
            };
            let url;
            try { url = new URL(req.url, 'http://127.0.0.1'); }
            catch { invalid(); return; }
            const received = Buffer.from(url.searchParams.get('state') || '');
            const expected = Buffer.from(state);
            if (req.method !== 'GET' || url.pathname !== '/callback' || received.length !== expected.length || !timingSafeEqual(received, expected)) {
                invalid(); return;
            }
            if (url.searchParams.has('iss') && url.searchParams.get('iss') !== issuer) {
                invalid(); return;
            }
            if (url.searchParams.has('error') || !url.searchParams.get('code')) {
                res.end(oauthResultPage('Sign-in not completed', 'The connection was not approved. You can try again from Settings in nenva.'));
                rejectCode(new Error('The tool server declined sign-in.'));
            } else {
                res.end(oauthResultPage('Authorization received', 'Your sign-in response has reached nenva on this Mac. The app will finish connecting and show you when it is ready.', true));
                resolveCode(url.searchParams.get('code'));
            }
            server.close();
        });
        const close = () => { server.close(); server.closeAllConnections(); };
        const abort = () => { rejectCode(new Error('Sign-in cancelled.')); close(); };
        signal.addEventListener('abort', abort, { once: true });
        try {
            await new Promise((resolve, reject) => {
                server.once('error', error => reject(error.code === 'EADDRINUSE'
                    ? new Error('The sign-in return port is in use. Finish any other Slack sign-in and try again.') : error));
                server.listen(redirectUri ? Number(new URL(redirectUri).port) : 0, '127.0.0.1', resolve);
            });
            if (signal.aborted) throw new Error('Sign-in cancelled.');
            return { url: redirectUri || `http://127.0.0.1:${server.address().port}/callback`, code,
                close: () => { signal.removeEventListener('abort', abort); close(); } };
        } catch (e) { signal.removeEventListener('abort', abort); close(); throw e; }
    }

    async _token(data, params, signal) {
        const tokens = await this._json(data.metadata.token_endpoint, { method: 'POST', signal,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ ...params, client_id: data.client_id, resource: data.resource }).toString() });
        if (Slack.isSlack(data.serverUrl)) {
            // Slack reports OAuth failures as HTTP 200 and calls bearer user
            // tokens "user". Neither exception applies to arbitrary servers.
            if (tokens.ok === false || tokens.error) {
                const messages = {
                    invalid_client: 'nenva’s Slack connection needs an update. Please contact support.',
                    bad_client_secret: 'nenva’s Slack sign-in configuration needs an update. Please contact support.',
                    invalid_scope: 'nenva’s Slack permissions need an update. Please contact support.',
                    bad_redirect_uri: 'nenva’s Slack sign-in configuration needs an update. Please contact support.',
                    invalid_redirect_uri: 'nenva’s Slack sign-in configuration needs an update. Please contact support.',
                    app_not_admin_approved: 'Ask your Slack workspace administrator to approve the app.'
                };
                const error = new Error(messages[tokens.error] || 'Slack sign-in failed. Please try signing in again.');
                error.invalidGrant = ['invalid_grant', 'invalid_client', 'invalid_refresh_token', 'token_revoked', 'token_expired', 'refresh_token_expired', 'account_inactive'].includes(tokens.error);
                throw error;
            }
            if (tokens.token_type === 'user') return { ...tokens, token_type: 'Bearer' };
        }
        return tokens;
    }

    _withTokens(data, tokens) {
        if (typeof tokens.access_token !== 'string' || !tokens.access_token ||
            String(tokens.token_type).toLowerCase() !== 'bearer') throw new Error('The server returned invalid sign-in credentials.');
        return { ...data, access_token: tokens.access_token,
            refresh_token: tokens.refresh_token || data.refresh_token,
            expiresAt: Number(tokens.expires_in) > 0 ? Date.now() + Number(tokens.expires_in) * 1000 : null };
    }

    async accessToken(name, rejectedToken) {
        const config = this.read(name);
        const data = this._load(name);
        if (!config || config.enabled === false || !data?.access_token || data.serverUrl !== config.url) {
            throw new Error('Connect this server in Tool Servers first.');
        }
        // A concurrent request may already have replaced the rejected token.
        if ((!rejectedToken || rejectedToken !== data.access_token) && (!data.expiresAt || data.expiresAt > Date.now() + 60000)) {
            return data.access_token;
        }
        if (this.refreshes.has(name)) return this.refreshes.get(name);
        const generation = this.generations.get(name) || 0;
        const work = (async () => {
            if (!data.refresh_token) { this.write(name, null); throw new Error('Sign-in expired. Reconnect in Tool Servers.'); }
            let tokens;
            try { tokens = await this._token(data, { grant_type: 'refresh_token', refresh_token: data.refresh_token }); }
            catch (e) {
                if (e.invalidGrant && (this.generations.get(name) || 0) === generation) {
                    this.write(name, null);
                    throw new Error('Sign-in expired or was revoked. Reconnect in Tool Servers.');
                }
                throw e;
            }
            const updated = this._withTokens(data, tokens);
            this._save(name, updated, generation);
            return updated.access_token;
        })();
        this.refreshes.set(name, work);
        try { return await work; }
        finally { if (this.refreshes.get(name) === work) this.refreshes.delete(name); }
    }
}

module.exports = { MCPOAuth, secureUrl };
