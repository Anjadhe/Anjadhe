/**
 * Screen control — the main-process half of the assistant's screen tools
 * (renderer half: js/agent/screen-tools.js; docs/COWORK_AGENT.md C13).
 *
 * Two IPC handlers, both scoped to the CALLING window's own webContents:
 *
 *   screen-capture  capturePage() of the window, downscaled to MAX_EDGE on
 *                   its long side, returned as a JPEG data URL. The renderer
 *                   draws the element marks on it and hands it to a vision
 *                   model; nothing is written to disk or logged.
 *   screen-input    one validated input step — a click at CSS coordinates
 *                   (mouseMove/Down/Up through sendInputEvent, so pages see
 *                   the same trusted events a real click makes), text
 *                   insertion (webContents.insertText) or a key press.
 *
 * Laws:
 *   - This window only. A <webview> guest (Browse) or any other webContents
 *     calling in is refused; the tools never reach other Mac apps.
 *   - main re-validates every step (normalizeInput) — the renderer's checks
 *     are UX, this is the boundary: coordinates inside the viewport, text
 *     bounded, keys from an allowlist, and no combo that closes, hides or
 *     reloads the app (a Cmd+R would kill the very run that sent it).
 *   - What may be TOUCHED (never the assistant's own chat or a consent
 *     dialog) is decided in the renderer, where the DOM is; main cannot see
 *     it and does not pretend to.
 *
 * Electron is injected through register() so the pure half loads in plain
 * Node for tests/screen-tools-test.js.
 */

const MAX_EDGE = 1568;
const MAX_TEXT = 2000;

const NAMED_KEYS = {
    enter: 'Enter', return: 'Enter',
    escape: 'Escape', esc: 'Escape',
    tab: 'Tab', backspace: 'Backspace', delete: 'Delete', space: 'Space',
    up: 'Up', arrowup: 'Up', down: 'Down', arrowdown: 'Down',
    left: 'Left', arrowleft: 'Left', right: 'Right', arrowright: 'Right',
    pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End'
};
const MODIFIERS = {
    cmd: 'meta', command: 'meta', meta: 'meta',
    ctrl: 'control', control: 'control',
    alt: 'alt', option: 'alt', opt: 'alt',
    shift: 'shift'
};
const MOD_ORDER = ['meta', 'control', 'alt', 'shift'];
// Combos that end, hide or reload the app instead of operating a page.
const BLOCKED_COMBOS = new Set([
    'meta+q', 'meta+w', 'meta+shift+w', 'meta+r', 'meta+shift+r', 'control+r',
    'meta+m', 'meta+h', 'meta+alt+h', 'meta+alt+i'
]);

function parseKey(spec, blocked = BLOCKED_COMBOS) {
    const parts = String(spec == null ? '' : spec).trim().toLowerCase()
        .split(/\s*\+\s*/).filter(Boolean);
    if (!parts.length || parts.length > 4) {
        return { error: 'key must look like "Enter", "Escape", "Down" or "cmd+a".' };
    }
    const keyPart = parts.pop();
    const mods = [];
    for (const p of parts) {
        const m = MODIFIERS[p];
        if (!m) return { error: `Unknown modifier "${p}" — use cmd, ctrl, alt or shift.` };
        if (!mods.includes(m)) mods.push(m);
    }
    mods.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
    let keyCode;
    if (NAMED_KEYS[keyPart]) keyCode = NAMED_KEYS[keyPart];
    else if (/^[a-z0-9]$/.test(keyPart)) keyCode = keyPart;
    else return { error: `Unsupported key "${keyPart}". Use Enter, Escape, Tab, Backspace, Delete, Space, Up, Down, Left, Right, PageUp, PageDown, Home, End, a letter or a digit — to enter text, use action "type".` };
    const combo = [...mods, keyCode.toLowerCase()].join('+');
    if (blocked.has(combo)) {
        return { error: `${spec} is not allowed — it would quit, close, hide, lock or reload something outside the task.` };
    }
    return { keyCode, modifiers: mods };
}

/**
 * Validate one input step against the window's CSS viewport. Returns the
 * normalized step, or { error } the model can read.
 */
function normalizeInput(req, viewport) {
    const r = req && typeof req === 'object' ? req : {};
    const type = String(r.type || '');
    if (type === 'click') {
        const x = Number(r.x), y = Number(r.y);
        const w = Number(viewport && viewport.width), h = Number(viewport && viewport.height);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'click needs numeric x and y.' };
        if (Number.isFinite(w) && Number.isFinite(h) && (x < 0 || y < 0 || x > w || y > h)) {
            return { error: 'That point is outside the window.' };
        }
        return { type: 'click', x, y };
    }
    if (type === 'type') {
        if (typeof r.text !== 'string' || !r.text.length) return { error: 'type needs non-empty text.' };
        if (r.text.length > MAX_TEXT) return { error: `Text is limited to ${MAX_TEXT} characters per step.` };
        return { type: 'type', text: r.text };
    }
    if (type === 'key') {
        const k = parseKey(r.key);
        if (k.error) return k;
        return { type: 'key', keyCode: k.keyCode, modifiers: k.modifiers };
    }
    return { error: 'Unknown input type.' };
}

async function sendInput(wc, input) {
    if (input.type === 'click') {
        const z = (typeof wc.getZoomFactor === 'function' && wc.getZoomFactor()) || 1;
        const x = Math.round(input.x * z), y = Math.round(input.y * z);
        wc.sendInputEvent({ type: 'mouseMove', x, y });
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        return;
    }
    if (input.type === 'type') {
        await wc.insertText(input.text);
        return;
    }
    if (input.type === 'key') {
        const { keyCode, modifiers } = input;
        wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
        // A printable key only produces text through a char event — and only
        // without a command modifier (cmd+a is a shortcut, not an "a").
        const printable = keyCode === 'Enter' || keyCode === 'Space' || keyCode.length === 1;
        if (printable && !modifiers.some(m => m !== 'shift')) {
            const ch = keyCode === 'Enter' ? '\r' : keyCode === 'Space' ? ' '
                : (modifiers.includes('shift') ? keyCode.toUpperCase() : keyCode);
            wc.sendInputEvent({ type: 'char', keyCode: ch, modifiers });
        }
        wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    }
}

function register({ ipcMain, BrowserWindow }) {
    // The caller's own top-level window, or null (a webview guest, a
    // destroyed window).
    const ownWindow = (event) => {
        const wc = event.sender;
        if (!wc || (typeof wc.getType === 'function' && wc.getType() !== 'window')) return null;
        const win = BrowserWindow.fromWebContents(wc);
        return win && !win.isDestroyed() ? win : null;
    };

    ipcMain.handle('screen-capture', async (event) => {
        const win = ownWindow(event);
        if (!win) return { error: 'Only the nenva window can be captured.' };
        if (win.isMinimized() || !win.isVisible()) {
            return { error: 'The nenva window is minimized or hidden, so there is nothing to see. Ask the user to bring it back on screen.' };
        }
        try {
            const img = await event.sender.capturePage();
            if (!img || img.isEmpty()) return { error: 'The capture came back empty — the window may be covered or asleep.' };
            const { width, height } = img.getSize();
            const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
            const out = scale < 1
                ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' })
                : img;
            const size = out.getSize();
            return {
                dataUrl: 'data:image/jpeg;base64,' + out.toJPEG(92).toString('base64'),
                width: size.width,
                height: size.height
            };
        } catch (e) {
            return { error: 'Could not capture the window: ' + (e && e.message || e) };
        }
    });

    ipcMain.handle('screen-input', async (event, req) => {
        const win = ownWindow(event);
        if (!win) return { error: 'Only the nenva window can be operated.' };
        const wc = event.sender;
        const z = (typeof wc.getZoomFactor === 'function' && wc.getZoomFactor()) || 1;
        const b = win.getContentBounds();
        const input = normalizeInput(req, { width: b.width / z, height: b.height / z });
        if (input.error) return input;
        try {
            await sendInput(wc, input);
            return { ok: true };
        } catch (e) {
            return { error: 'The input step failed: ' + (e && e.message || e) };
        }
    });
}

module.exports = { register, normalizeInput, parseKey, MAX_EDGE, MAX_TEXT };
