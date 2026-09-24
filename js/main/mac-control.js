/**
 * Mac control — the main-process half of the assistant's mac_look / mac_act
 * tools (renderer js/agent/mac-tools.js, native helper
 * native/mac-control/mac-control-helper.swift; docs/COWORK_AGENT.md C14).
 *
 * Owns ONE long-running helper process (JSON lines over stdio), validates
 * every step before it reaches the helper, refuses the apps the assistant
 * must never operate, and shows the floating "nenva is using your Mac ·
 * Stop" bar while it works.
 *
 * Laws:
 *   M1  Never these apps: password managers and Keychain (credentials),
 *       System Settings (the assistant would grant itself permissions),
 *       terminals (run_command has its own scoped consent; typing into
 *       Terminal would walk around it), the login/security prompts, and
 *       nenva itself (screen_act owns that, with its own no-touch rules).
 *       Checked by bundle id on every snapshot and by name on every open.
 *   M2  main re-validates every step (normalizeMacStep): web addresses are
 *       http(s) only, text is bounded, keys come from the allowlist, and the
 *       combos that force-quit, lock, log out or open Spotlight are refused.
 *   M3  The user can always stop it: the bar's Stop reaches every window's
 *       renderer (`mac-stop`), which aborts the running turns.
 *
 * Binary resolution mirrors the Reminders helper (main.js): the CI-prebuilt
 * universal binary shipped via asarUnpack, else a cached compile under
 * userData keyed by source hash, else swiftc on a dev Mac.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { parseKey } = require('./screen-control');

const HELPER = 'mac-control-helper';
const MAX_TEXT = 2000;

const BLOCKED_BUNDLES = [
    /^com\.apple\.keychainaccess$/i, /^com\.apple\.Passwords$/i, /^com\.apple\.systempreferences$/i,
    /^com\.apple\.SystemSettings$/i, /^com\.apple\.SecurityAgent$/i, /^com\.apple\.loginwindow$/i,
    /^com\.apple\.Terminal$/i, /^com\.googlecode\.iterm2$/i, /^dev\.warp\./i, /^com\.mitchellh\.ghostty$/i,
    /^net\.kovidgoyal\.kitty$/i, /^io\.alacritty$/i,
    /^com\.1password\./i, /^com\.agilebits\./i, /^com\.bitwarden\./i, /^com\.lastpass\./i,
    /^com\.dashlane\./i, /^com\.keepassx?c?\./i, /^org\.keepassxc\./i,
    /^com\.anjadhe\./i, /^com\.github\.Electron$/i
];
const BLOCKED_NAMES = /^(keychain access|passwords|system settings|system preferences|terminal|iterm2?|warp|ghostty|kitty|alacritty|1password.*|bitwarden|lastpass|dashlane|keepassxc|anjadhe|nenva|electron)(\.app)?$/i;

// Combos that force-quit, lock the Mac, log out, or open a launcher that
// reaches a blocked app.
const MAC_BLOCKED_COMBOS = new Set([
    'meta+alt+escape', 'meta+alt+shift+escape', 'meta+control+q', 'meta+shift+q', 'meta+alt+shift+q',
    'meta+space', 'control+space', 'meta+alt+space'
]);

function isBlockedBundle(bundleId) {
    return !!bundleId && BLOCKED_BUNDLES.some(re => re.test(bundleId));
}
function isBlockedName(name) {
    return BLOCKED_NAMES.test(String(name || '').trim());
}
const blockedMessage = (label) => `nenva never operates ${label || 'that app'} — password managers, Keychain, System Settings, terminals and nenva itself are off limits (use screen_act for nenva's own window, run_command for shell work). Ask the user to do that part.`;

function int(v) {
    const n = Number(v);
    return Number.isInteger(n) ? n : NaN;
}

/**
 * Validate one step. Returns the normalized step for the helper, or { error }.
 */
function normalizeMacStep(step) {
    const s = step && typeof step === 'object' ? step : {};
    const kind = String(s.kind || '');
    const opt = (k) => s[k] != null && s[k] !== '';
    const withN = (out) => {
        if (!opt('n')) return out;
        const n = int(s.n);
        if (!(n >= 1 && n <= 500)) return { error: 'element must be a number from the latest look.' };
        return { ...out, n };
    };
    switch (kind) {
        case 'press': {
            if (!opt('n')) return { error: 'click needs element (a number from the latest look), or x and y.' };
            return withN({ kind, double: s.double === true });
        }
        case 'click': {
            const x = Number(s.x), y = Number(s.y);
            if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 20000 || y > 20000) {
                return { error: 'click needs x and y inside the screenshot.' };
            }
            return { kind, x, y, double: s.double === true };
        }
        case 'type': {
            if (typeof s.text !== 'string' || !s.text.length) return { error: 'type needs text.' };
            if (s.text.length > MAX_TEXT) return { error: `Text is limited to ${MAX_TEXT} characters per step.` };
            return withN({ kind, text: s.text, clear: s.clear === true });
        }
        case 'key': {
            const k = parseKey(s.key, MAC_BLOCKED_COMBOS);
            if (k.error) return k;
            return { kind, key: k.keyCode, modifiers: k.modifiers, label: String(s.key).trim() };
        }
        case 'scroll': {
            const direction = String(s.direction || 'down').toLowerCase();
            if (direction !== 'up' && direction !== 'down') return { error: 'direction must be up or down.' };
            return withN({ kind, direction });
        }
        case 'menu': {
            const raw = Array.isArray(s.path) ? s.path : String(s.path || '').split('>');
            const path = raw.map(p => String(p).trim()).filter(Boolean);
            if (!path.length || path.length > 5 || path.some(p => p.length > 80)) {
                return { error: 'menu needs a path like "File > Export…".' };
            }
            return { kind, path };
        }
        case 'open': {
            const out = { kind };
            if (opt('app')) {
                const app = String(s.app).trim();
                if (app.length > 80 || /[/\\\n]/.test(app)) return { error: 'app must be an app name like "Safari".' };
                if (isBlockedName(app)) return { error: blockedMessage(app) };
                out.app = app;
            }
            if (opt('url')) {
                const url = String(s.url).trim();
                let u;
                try { u = new URL(url); } catch (_) { return { error: 'url must be a full web address starting with https://' }; }
                if (!/^https?:$/.test(u.protocol) || url.length > 2048) {
                    return { error: 'Only http and https web addresses can be opened.' };
                }
                out.url = u.href;
            }
            if (!out.app && !out.url) return { error: 'open needs app or url.' };
            return out;
        }
        default:
            return { error: 'Unknown step.' };
    }
}

function register({ app, ipcMain, BrowserWindow, screen }) {
    let child = null;
    let buf = '';
    let seq = 0;
    const pending = new Map();
    let target = null;          // { app, bundleId } of the latest snapshot

    const helperSource = () => path.join(__dirname, '..', '..', 'native', 'mac-control', `${HELPER}.swift`);

    async function helperBinary() {
        const bundled = path.join(__dirname, '..', '..', 'native', 'mac-control', 'build', HELPER)
            .replace('app.asar', 'app.asar.unpacked');
        if (fs.existsSync(bundled)) return bundled;
        const src = helperSource();
        if (!fs.existsSync(src)) throw new Error(`${HELPER}.swift missing`);
        const hash = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex').slice(0, 12);
        const dir = path.join(app.getPath('userData'), 'apple-helpers');
        const bin = path.join(dir, `${HELPER}-${hash}`);
        if (fs.existsSync(bin)) return bin;
        fs.mkdirSync(dir, { recursive: true });
        const { execFile } = require('child_process');
        await new Promise((resolve, reject) => {
            execFile('swiftc', ['-O', '-swift-version', '5', src, '-o', bin], { timeout: 180000 }, (err, stdout, stderr) => {
                if (err) {
                    reject(new Error(/not found|xcrun/.test(String(stderr || err.message))
                        ? 'Building the Mac control helper needs the Xcode command-line tools (xcode-select --install).'
                        : `Helper build failed: ${String(stderr || err.message).slice(0, 400)}`));
                } else resolve();
            });
        });
        for (const f of fs.readdirSync(dir)) {
            if (f.startsWith(`${HELPER}-`) && path.join(dir, f) !== bin) {
                try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* best effort */ }
            }
        }
        return bin;
    }

    async function ensure() {
        if (child) return child;
        const bin = await helperBinary();
        if (child) return child;
        const { spawn } = require('child_process');
        const proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        child = proc;
        buf = '';
        proc.stdout.setEncoding('utf8');
        proc.stdout.on('data', (chunk) => {
            buf += chunk;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                let msg;
                try { msg = JSON.parse(line); } catch (_) { continue; }
                const p = pending.get(msg.id);
                if (p) { pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg); }
            }
        });
        proc.stderr.on('data', () => { /* helper diagnostics are not logged: they can name windows */ });
        proc.on('exit', () => {
            if (child === proc) child = null;
            for (const p of pending.values()) { clearTimeout(p.timer); p.resolve({ error: 'The Mac control helper stopped.' }); }
            pending.clear();
        });
        return proc;
    }

    function call(cmd, payload = {}, timeoutMs = 20000) {
        if (process.platform !== 'darwin') return Promise.resolve({ error: 'Using other apps works on macOS only.' });
        return ensure().then(proc => new Promise((resolve) => {
            const id = ++seq;
            const timer = setTimeout(() => {
                pending.delete(id);
                resolve({ error: `The helper did not answer (${cmd}).` });
            }, timeoutMs);
            pending.set(id, { resolve, timer });
            try { proc.stdin.write(JSON.stringify({ ...payload, id, cmd }) + '\n'); }
            catch (e) { clearTimeout(timer); pending.delete(id); resolve({ error: e.message }); }
        })).catch(e => ({ error: e.message }));
    }

    app.on('before-quit', () => { try { child && child.kill(); } catch (_) { /* gone */ } });

    // ── The Stop bar (M3) ────────────────────────────────────────────────
    let bar = null;
    let barTimer = null;
    const BAR_W = 340, BAR_H = 44;
    const BAR_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;height:100%;background:transparent;overflow:hidden}
        .bar{box-sizing:border-box;height:${BAR_H}px;display:flex;align-items:center;gap:10px;padding:0 6px 0 16px;
             background:#171717;color:#fff;border-radius:999px;font:500 12.5px -apple-system,BlinkMacSystemFont,sans-serif;
             -webkit-app-region:drag;user-select:none;cursor:default}
        .dot{width:8px;height:8px;border-radius:50%;background:#5d8bff;flex:none}
        #l{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        a{-webkit-app-region:no-drag;background:#fff;color:#171717;text-decoration:none;padding:6px 14px;border-radius:999px;font-weight:600}
        </style></head><body><div class="bar"><span class="dot"></span><span id="l">nenva is using your Mac</span><a href="#stop">Stop</a></div></body></html>`;

    function stopAll() {
        hideBar();
        for (const w of BrowserWindow.getAllWindows()) {
            if (w !== bar && !w.isDestroyed()) {
                try { w.webContents.send('mac-stop'); } catch (_) { /* closing */ }
            }
        }
    }
    function hideBar() {
        clearTimeout(barTimer);
        if (bar && !bar.isDestroyed()) bar.hide();
    }
    function showBar(label) {
        if (!bar || bar.isDestroyed()) {
            bar = new BrowserWindow({
                width: BAR_W, height: BAR_H, frame: false, transparent: true, resizable: false,
                movable: true, minimizable: false, maximizable: false, fullscreenable: false,
                alwaysOnTop: true, skipTaskbar: true, focusable: false, show: false, hasShadow: true,
                webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true }
            });
            bar.setAlwaysOnTop(true, 'floating');
            bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
            bar.webContents.on('did-navigate-in-page', (_e, url) => {
                if (/#stop$/.test(url)) {
                    bar.webContents.executeJavaScript('history.replaceState(null, "", location.pathname)').catch(() => {});
                    stopAll();
                }
            });
            bar.webContents.on('will-navigate', (e) => e.preventDefault());
            bar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
            bar.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(BAR_HTML));
            const wa = screen().getPrimaryDisplay().workArea;
            bar.setPosition(Math.round(wa.x + (wa.width - BAR_W) / 2), Math.round(wa.y + wa.height - BAR_H - 16));
        }
        const set = () => bar.webContents.executeJavaScript(
            `document.getElementById('l').textContent = ${JSON.stringify(String(label || 'nenva is using your Mac').slice(0, 80))}`
        ).catch(() => {});
        if (bar.webContents.isLoading()) bar.webContents.once('did-finish-load', set); else set();
        if (!bar.isVisible()) bar.showInactive();
        clearTimeout(barTimer);
        // Hidden after a quiet minute; a slow model turn between steps keeps
        // it up because every look and act re-arms it.
        barTimer = setTimeout(hideBar, 60000);
    }

    // ── IPC ──────────────────────────────────────────────────────────────
    ipcMain.handle('mac-status', () => call('status'));
    ipcMain.handle('mac-request-permission', (_e, what) => call('request', { what: what === 'screen' ? 'screen' : 'accessibility' }, 60000));

    ipcMain.handle('mac-snapshot', async (_e, opts = {}) => {
        const name = opts && typeof opts.app === 'string' ? opts.app.trim().slice(0, 80) : '';
        if (name && isBlockedName(name)) return { error: blockedMessage(name) };
        const res = await call('snapshot', { app: name || null, capture: opts.capture === true, maxElements: 150, maxEdge: 1568 }, 25000);
        if (res && res.bundleId && isBlockedBundle(res.bundleId)) {
            target = null;
            await call('forget');
            return { error: blockedMessage(res.app) };
        }
        if (res && !res.error) {
            target = { app: res.app, bundleId: res.bundleId };
            showBar(`nenva is looking at ${res.app}`);
        }
        return res;
    });

    ipcMain.handle('mac-act', async (_e, step) => {
        const norm = normalizeMacStep(step);
        if (norm.error) return norm;
        if (norm.kind !== 'open') {
            if (!target) return { error: 'Look at the app with mac_look first.' };
            if (isBlockedBundle(target.bundleId)) return { error: blockedMessage(target.app) };
        }
        showBar(norm.kind === 'open'
            ? `nenva is opening ${norm.app || 'your browser'}`
            : `nenva is using ${target.app}`);
        const res = await call('act', norm, 25000);
        if (norm.kind === 'open' && res && !res.error) target = null;
        return res;
    });

    // The label under a position click, for the sensitive-step check (M4) —
    // read before the click, relative to the latest snapshot's image frame.
    ipcMain.handle('mac-element-at', async (_e, pt = {}) => {
        const x = Number(pt && pt.x), y = Number(pt && pt.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 20000 || y > 20000) return { error: 'bad point' };
        if (!target) return { error: 'Look at the app with mac_look first.' };
        return call('elementAt', { x, y }, 5000);
    });

    ipcMain.handle('mac-hide-bar', () => { hideBar(); return { ok: true }; });

    // A consent ask while another app is in front: bring nenva forward so
    // the user sees the question. The next step re-activates the target.
    ipcMain.handle('mac-focus-self', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) {
            if (win.isMinimized()) win.restore();
            win.show();
            app.focus({ steal: true });
        }
        return { ok: true };
    });
}

module.exports = { register, normalizeMacStep, isBlockedBundle, isBlockedName, MAC_BLOCKED_COMBOS };
