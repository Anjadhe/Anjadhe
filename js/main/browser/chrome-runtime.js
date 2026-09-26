'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const NativeBridge = require('./native-bridge');
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const httpURL = value => { try { const u = new URL(value); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; } };
class ChromeRuntime {
    constructor({ userData, source, operations, settings, hostCommand, executable, platform = process.platform, onChange = () => {} }) {
        Object.assign(this, { settings, source, operations, hostCommand, executable, platform, onChange });
        this.root = path.join(userData, 'chrome-browser'); this.profile = path.join(this.root, 'profile');
        this.extension = path.join(this.root, 'extension'); this.connection = null; this.controlEpoch = 0;
        this.target = {}; this.preparing = null; this.starting = null; this.retryAfter = 0;
    }
    findChrome() {
        if (this.executable) return this.executable;
        const paths = this.platform === 'darwin'
            ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
            : ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/opt/google/chrome/chrome'];
        return paths.find(candidate => fs.existsSync(candidate)) || null;
    }
    state() {
        return { engine: 'chrome', supported: this.platform !== 'win32', available: !!this.findChrome(),
            connected: !!this.connection?.socket, starting: !!this.starting, setupReady: fs.existsSync(path.join(this.extension, 'manifest.json')),
            extensionPath: this.extension, profilePath: this.profile, extensionId: this.extensionId || null,
            control: this.target.control || 'human', targetId: this.target.tabId || null,
            url: this.target.url || this.settings.get('workroom-chrome-url', 'about:blank'),
            title: this.target.title || 'Chrome', generation: this.target.generation || 0, backUrl: this.target.backUrl || null,
            // What the LOADED copy of the extension can do, and whether it is
            // behind this app. Chrome keeps running the worker it loaded, so
            // copying newer files into the folder changes nothing until the
            // user reloads the extension (or restarts Chrome).
            actions: this.extensionActions ? [...this.extensionActions] : null,
            stale: !!(this.extensionActions && this.staleActions().length), staleActions: this.staleActions() };
    }
    /** Actions this app knows that the loaded extension does not. */
    staleActions() {
        if (!this.extensionActions || !this.expectedActions) return [];
        return this.expectedActions.filter(action => !this.extensionActions.includes(action));
    }
    async prepare() {
        if (this.connection) return this.state();
        if (this.preparing) return this.preparing;
        this.preparing = this._prepare();
        try { return await this.preparing; } finally { this.preparing = null; }
    }
    async _prepare() {
        if (this.platform === 'win32') throw new Error('The Chrome preview currently supports macOS and Linux.');
        if (!this.findChrome()) throw new Error('Install Google Chrome to use this browser preview.');
        fs.mkdirSync(this.root, { recursive: true, mode: 0o700 }); fs.chmodSync(this.root, 0o700);
        fs.mkdirSync(this.profile, { recursive: true, mode: 0o700 });
        fs.mkdirSync(this.extension, { recursive: true, mode: 0o700 });
        const manifest = JSON.parse(fs.readFileSync(path.join(this.source, 'manifest.json'), 'utf8'));
        this.extensionId = crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
            .replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
        const hostName = 'com.anjadhe.browser_' + crypto.createHash('sha256').update(this.root).digest('hex').slice(0, 12);
        for (const file of ['manifest.json', 'worker.js', 'popup.html', 'popup.js', 'human-input.js']) fs.copyFileSync(path.join(this.source, file), path.join(this.extension, file));
        // The toolbar icons (written by scripts/build-icons.js).
        const icons = path.join(this.source, 'icons');
        if (fs.existsSync(icons)) {
            fs.mkdirSync(path.join(this.extension, 'icons'), { recursive: true });
            for (const f of fs.readdirSync(icons)) if (f.endsWith('.png')) fs.copyFileSync(path.join(icons, f), path.join(this.extension, 'icons', f));
        }
        fs.copyFileSync(this.operations, path.join(this.extension, 'page-operations.js'));
        fs.writeFileSync(path.join(this.extension, 'config.js'), 'const ANJADHE_HOST = ' + JSON.stringify(hostName) + ';\n');
        const bridge = new NativeBridge({ extensionId: this.extensionId });
        bridge.on('state', state => {
            if (!state || !Number.isInteger(state.generation) || !['agent', 'human'].includes(state.control)) return;
            // An older extension sends no list; treat that as "unknown", not
            // as "supports nothing", so nothing regresses for a loaded copy
            // that predates this handshake.
            if (Array.isArray(state.actions)) {
                this.extensionActions = state.actions.filter(action => typeof action === 'string').slice(0, 40);
            }
            if (this.target.control === 'agent' && state.control === 'human') this.controlEpoch++;
            this.target = { tabId: Number.isInteger(state.tabId) ? state.tabId : null, generation: state.generation,
                control: state.control, url: httpURL(state.url) || 'about:blank', backUrl: httpURL(state.backUrl), title: String(state.title || '').slice(0, 300) };
            if (httpURL(this.target.url)) this.settings.set('workroom-chrome-url', this.target.url);
            // WHY control moved, in the extension's own words. 'user' is what a
            // copy loaded before 2026-09-21 says when the user takes the wheel.
            this.onChange({ reason: state.reason === 'user' ? 'takeover' : state.reason || null });
        });
        bridge.on('connected', () => { this.target = {}; this.retryAfter = 0; this.settings.set('workroom-chrome-paired', true); this.onChange({ reason: 'reconnected' }); });
        bridge.on('disconnected', () => { this.target = {}; this.controlEpoch++; this.onChange({ reason: 'disconnect' }); });
        const port = await bridge.listen();
        try {
            const config = path.join(this.root, 'host.json'), launcher = path.join(this.root, 'native-host');
            fs.writeFileSync(config, JSON.stringify({ port, token: bridge.token, extensionId: this.extensionId }), { mode: 0o600 });
            fs.chmodSync(config, 0o600);
            fs.writeFileSync(launcher, '#!/bin/sh\nunset ELECTRON_RUN_AS_NODE\nexec ' + this.hostCommand(config).map(quote).join(' ') + ' "$@"\n', { mode: 0o700 });
            fs.chmodSync(launcher, 0o700);
            // Chrome uses NativeMessagingHosts beneath this dedicated user-data
            // directory. Never register the host in the user's everyday profile.
            const hosts = path.join(this.profile, 'NativeMessagingHosts');
            fs.mkdirSync(hosts, { recursive: true, mode: 0o700 });
            fs.writeFileSync(path.join(hosts, hostName + '.json'), JSON.stringify({
                name: hostName, description: 'nenva browser connection', path: launcher, type: 'stdio',
                allowed_origins: ['chrome-extension://' + this.extensionId + '/']
            }), { mode: 0o600 });
            this.connection = bridge;
        } catch (error) { bridge.close(); throw error; }
        return this.state();
    }
    async launch({ setup = false } = {}) {
        await this.prepare();
        this.retryAfter = 0;
        if (this.connection.socket && !setup) { await this.ensure({ autoLaunch: false }); await this.connection.request('show'); return this.state(); }
        await this.spawnChrome({ setup });
        return this.state();
    }
    async spawnChrome({ setup = false, background = false } = {}) {
        const url = setup ? 'chrome://extensions/' : httpURL(this.settings.get('workroom-chrome-url')) || 'about:blank';
        const args = ['--user-data-dir=' + this.profile, '--no-first-run', '--no-default-browser-check',
            ...(background ? ['--no-startup-window'] : ['--new-window', url])];
        // Chrome's extension creates the single, unfocused agent window after
        // connecting. LaunchServices -g also avoids activating Chrome on Mac.
        const macBackground = background && this.platform === 'darwin';
        const executable = this.findChrome();
        const child = spawn(macBackground ? '/usr/bin/open' : executable,
            macBackground ? ['-g', '-n', '-a', path.resolve(path.dirname(executable), '../..'), '--args', ...args] : args,
            { detached: true, stdio: 'ignore' });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
    }
    async startInBackground() {
        if (this.starting) return this.starting;
        if (Date.now() < this.retryAfter) throw new Error('Chrome could not reconnect. Open Browser setup and check that its extension is enabled, then Continue.');
        const epoch = this.controlEpoch;
        const starting = (async () => {
            await this.spawnChrome({ background: true });
            const deadline = Date.now() + 35000; // Includes the extension's 30s reconnect alarm.
            while (!this.connection?.socket) {
                if (epoch !== this.controlEpoch) throw new Error('Browser startup was cancelled. Continue when ready.');
                if (Date.now() >= deadline) { this.retryAfter = Date.now() + 30000; throw new Error('Chrome opened but its extension did not connect. Open Browser setup, enable the extension and Continue.'); }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (epoch !== this.controlEpoch) throw new Error('Browser startup was cancelled. Continue when ready.');
        })();
        this.starting = starting;
        try { await starting; } finally { if (this.starting === starting) this.starting = null; }
    }
    async ensure({ autoLaunch = true } = {}) {
        await this.prepare();
        if (!this.connection.socket && autoLaunch && (this.settings.get('workroom-chrome-paired') || this.settings.get('workroom-browser-engine') === 'chrome')) await this.startInBackground();
        if (!this.connection.socket) throw new Error('Chrome is not connected. Choose Browser setup, load the extension and click Connect.');
        await this.connection.request('ensure');
        return this.state();
    }
    async execute(action, args, { expectedOrigin, check, image = false }) {
        await this.ensure(); check();
        const epoch = this.controlEpoch;
        await this.connection.request('control', { control: 'agent' });
        check();
        if (epoch !== this.controlEpoch) throw new Error('Browser control changed. Continue from its current page.');
        const state = this.state();
        const value = await this.connection.request('execute', { action, args, expectedOrigin, image, tabId: state.targetId, generation: state.generation });
        check();
        if (epoch !== this.controlEpoch) throw new Error('Browser control changed. The old result was discarded.');
        return value;
    }
    async takeover() {
        this.controlEpoch++;
        if (this.connection?.socket) await this.connection.request('control', { control: 'human' });
        return this.state();
    }
    /** A picture of the tab for the chat, whoever is driving. */
    async view() {
        if (!this.connection?.socket) return { status: 'idle', message: 'Chrome is not connected.' };
        try { return await this.connection.request('view', {}, 8000); }
        catch (error) {
            return { status: 'idle', message: /Unsupported browser operation/.test(error.message)
                ? 'Reload the nenva extension in Chrome (chrome://extensions) to see the browser here.' : error.message };
        }
    }
    /** The user's own pointer and keys. Only while THEY have control. */
    async input(event) {
        if (!this.connection?.socket) throw new Error('Chrome is not connected.');
        if (this.state().control !== 'human') throw new Error('Take control first.');
        return this.connection.request('input', event, 8000);
    }
    close() { this.controlEpoch++; this.connection?.close(); this.connection = null; }
}
module.exports = { ChromeRuntime, httpURL };
