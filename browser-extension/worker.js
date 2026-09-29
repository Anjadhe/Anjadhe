'use strict';
importScripts('config.js', 'page-operations.js');
let port, connecting = false, queue = Promise.resolve(), control = 'human', controlEpoch = 0;
let tabId = null, windowId = null, generation = 0, backUrl = null, connected = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const origin = value => { try { const u = new URL(value); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.origin : null; } catch { return null; } };
async function state() {
    let tab; try { if (tabId !== null) tab = await chrome.tabs.get(tabId); } catch {}
    return { tabId: tab?.id || null, windowId: tab?.windowId || null, url: tab?.url || 'about:blank',
        title: tab?.title || 'Chrome', generation, control, connected, backUrl, actions: ACTIONS };
}
/* Every state change also tells the agent's tab who is driving, so its shield
 * (human-input.js) is up exactly while the agent is. */
function tellPage(message) { return tabId === null ? Promise.resolve() : chrome.tabs.sendMessage(tabId, message).catch(() => {}); }
async function publish(reason) {
    tellPage({ kind: 'mode', agent: connected && control === 'agent' });
    try { port?.postMessage({ kind: 'state', state: { ...await state(), reason } }); } catch {}
}
async function ensure() {
    if (tabId !== null) { try { await chrome.tabs.get(tabId); return state(); } catch { tabId = null; windowId = null; } }
    const saved = await chrome.storage.session.get(['agentTab']);
    if (saved.agentTab) {
        try { const tab = await chrome.tabs.get(saved.agentTab); tabId = tab.id; windowId = tab.windowId; }
        catch {}
    }
    if (tabId === null) {
        const savedPage = await chrome.storage.local.get(['agentURL']);
        const win = await chrome.windows.create({ url: origin(savedPage.agentURL) ? savedPage.agentURL : 'about:blank', focused: false, width: 1200, height: 850 });
        tabId = win.tabs[0].id; windowId = win.id; generation++;
    }
    await chrome.storage.session.set({ agentTab: tabId }); await publish(); return state();
}
async function script(func, args = []) {
    const result = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func, args });
    return result[0]?.result;
}
async function setHuman(reason = 'takeover') {
    control = 'human'; controlEpoch++; backUrl = null;
    releaseDebugger();
    await publish(reason);
}
function guard(epoch) {
    if (!connected || control !== 'agent' || controlEpoch !== epoch) throw new Error('The user has control. Return to Anjadhe and Continue when ready.');
}
/* ── One debugger session per agent turn at the wheel (2026-09-21) ──────
 * Attach/detach around every screenshot and every history read flickered
 * Chrome's "is debugging this browser" bar and cost a round trip each time.
 * The session now lives as long as the agent has control and is dropped the
 * moment the user takes over, the tab goes away or Chrome detaches it. It
 * also carries the TRUSTED input events: a synthetic el.click() is ignored
 * by a fair share of real sites, a CDP mouse event is not. */
let attachedTo = null, agentInputUntil = 0;
async function cdp(method, params = {}) {
    if (attachedTo !== tabId) {
        if (attachedTo !== null) await chrome.debugger.detach({ tabId: attachedTo }).catch(() => {});
        attachedTo = null;
        await chrome.debugger.attach({ tabId }, '1.3');
        attachedTo = tabId;
        // The agent window is unfocused by design; pages must still behave
        // as if they had focus or text insertion goes nowhere.
        await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    }
    return chrome.debugger.sendCommand({ tabId }, method, params);
}
async function releaseDebugger() {
    const id = attachedTo; attachedTo = null;
    if (id !== null) await chrome.debugger.detach({ tabId: id }).catch(() => {});
}
chrome.debugger.onDetach.addListener(source => { if (source.tabId === attachedTo) attachedTo = null; });
async function history(back) {
    const entries = await cdp('Page.getNavigationHistory');
    if (back) {
        guard(back.epoch);
        const destination = entries.entries[entries.currentIndex - 1];
        if (!origin(destination?.url) || origin(destination.url) !== back.expectedOrigin) throw new Error('The page to go back to changed. Look again.');
        // tabs.goBack follows Chrome's UI history-skipping rules, which may
        // skip every entry created by the agent. Navigate to the exact
        // observed entry instead.
        await cdp('Page.navigateToHistoryEntry', { entryId: destination.id });
    }
    return entries;
}
async function settle(epoch) {
    const deadline = Date.now() + 8000;
    await delay(300); guard(epoch);
    while (Date.now() < deadline) {
        const tab = await chrome.tabs.get(tabId); guard(epoch);
        if (tab.status !== 'loading') break;
        // Ads/images can keep tabs.status loading after the document is ready.
        // A pending destination still has to settle before observing controls.
        if (!tab.pendingUrl || tab.pendingUrl === tab.url) {
            try { const ready = await script(() => document.readyState !== 'loading'); guard(epoch); if (ready) break; } catch { guard(epoch); }
        }
        await delay(100); guard(epoch);
    }
}
/* What THIS copy of the extension can do. Chrome keeps running the worker it
 * loaded until the extension is reloaded, so an app newer than the loaded
 * copy would ask for actions that are not in here. It is reported in every
 * state message so the app can name the fix instead of meeting a bare
 * refusal mid-assignment. */
const ACTIONS = ['look', 'act'];
const STEPS = ['open', 'back', 'click', 'type', 'select', 'press', 'scroll', 'find', 'wait', 'dismiss_consent'];
const KEYS = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, PageDown: 34, PageUp: 33, Backspace: 8 };
// Trusted pointer/key events look exactly like the user's own to the page's
// watcher. While the agent is pressing, they are the agent's.
// shield, which swallows stray input while the agent drives. Open a short
// window first, and wait for the page to hear it.
const agentInput = (ms = 700) => { agentInputUntil = Date.now() + ms; return tellPage({ kind: 'agent-input', ms }); };
async function pressKey(key) {
    const code = KEYS[key];
    const base = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
    await agentInput();
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
    if (key === 'Enter') await cdp('Input.dispatchKeyEvent', { type: 'char', ...base, text: '\r', unmodifiedText: '\r' });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
async function trustedClick(point) {
    await agentInput();
    const at = { x: point.x, y: point.y, button: 'left', clickCount: 1 };
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, buttons: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at });
}
/** One step. Trusted input first; the page-script fallback when Chrome will
 *  not give us a debugger session or the control cannot be hit by a pointer. */
async function step(args, epoch) {
    const page = input => script(interact, [input, MANUAL_FIELDS]);
    const act = args.action;
    if (act === 'scroll' || act === 'find') return page(args);
    if (act === 'wait') { await delay(Math.max(0, Math.min(3000, Number(args.ms) || 1500))); return { ok: true }; }
    if (act === 'dismiss_consent') return { ok: true, consent: await script(dismissConsent, [{ ...(args.n != null ? { ref: String(args.n) } : {}), x: args.x, y: args.y }]) };
    if (act === 'press') {
        if (!Object.hasOwn(KEYS, args.key)) return { error: `press takes one of: ${Object.keys(KEYS).join(', ')}.` };
        const focus = await page({ action: 'focus-info' }); guard(epoch);
        if (focus?.error) return focus;
        if (focus.manual) return { error: 'The keyboard is in a field only the user can fill. Stop here and say so.', manualRequired: true };
        try { await pressKey(args.key); return { ok: true }; }
        catch (error) { return { error: 'Chrome would not deliver that key: ' + String(error.message || error).slice(0, 160) }; }
    }
    // click, type, select: all name a control by number.
    let where = await page({ action: 'locate', n: args.n }); guard(epoch);
    if (where?.error) return where;
    // locate scrolls the control into view. Hit-testing a pointer event
    // against a scroll the compositor has not committed yet lands on whatever
    // WAS there, so let it settle and take the point again.
    await delay(90); guard(epoch);
    where = await page({ action: 'locate', n: args.n }); guard(epoch);
    if (where?.error) return where;
    if (act === 'select' || where.select) return page({ ...args, action: act === 'click' ? 'click' : 'select' });
    let trusted = where.hit;
    if (trusted) {
        try { await trustedClick(where); guard(epoch); } catch { trusted = false; }
    }
    if (act === 'click') return trusted ? { ok: true, target: where.target, trusted: true } : page(args);
    // type: the click above put the caret in the field.
    if (typeof args.text !== 'string' || args.text.length > 4000) return { error: 'type needs text of at most 4000 characters.' };
    if (trusted && where.editable) {
        try {
            const ready = await page({ action: 'select-text', n: args.n }); guard(epoch);
            const focus = await page({ action: 'focus-info' }); guard(epoch);
            if (!ready?.error && focus?.editable && !focus.manual) {
                await agentInput(1200);
                if (args.text) await cdp('Input.insertText', { text: args.text });
                else await pressKey('Backspace');
                guard(epoch);
                if (args.submit) { await delay(120); await pressKey('Enter'); }
                return { ok: true, target: where.target, trusted: true };
            }
        } catch { /* fall through to the page-script path */ }
    }
    return page(args);
}
async function capture(observation, epoch) {
    const documentGeneration = generation, target = tabId;
    const mask = await script(screenshotMask, [true, MANUAL_FIELDS]); guard(epoch);
    await script(marks, [true]); guard(epoch);
    try {
        const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 60,
            clip: { x: mask.x, y: mask.y, width: mask.width, height: mask.height, scale: Math.min(1, 1280 / Math.max(mask.width, mask.height)) }, captureBeyondViewport: false });
        guard(epoch);
        const now = await chrome.tabs.get(target); guard(epoch);
        if (target !== tabId || generation !== documentGeneration || now.url !== observation.url || mask.url !== observation.url) throw new Error('The page changed during capture.');
        const dataUrl = 'data:image/jpeg;base64,' + shot.data;
        if (dataUrl.length > 850000) throw new Error('The picture of this page is too large.');
        observation.images = [{ dataUrl }];
        observation.imageViewport = { width: mask.width, height: mask.height, scale: Math.min(1, 1280 / Math.max(mask.width, mask.height)) };
    } catch (error) { observation.imageError = String(error.message || error).slice(0, 200); }
    finally {
        await chrome.scripting.executeScript({ target: { tabId: target }, world: 'ISOLATED', func: marks, args: [false] }).catch(() => {});
        await chrome.scripting.executeScript({ target: { tabId: target }, world: 'ISOLATED', func: screenshotMask, args: [false, MANUAL_FIELDS] }).catch(() => {});
    }
}
async function execute(input) {
    const { action, args = {}, expectedOrigin } = input;
    if (!ACTIONS.includes(action)) throw new Error(`This copy of the Anjadhe extension cannot "${action}". Open chrome://extensions and reload it, then Continue.`);
    const epoch = controlEpoch; guard(epoch);
    const tab = await chrome.tabs.get(tabId); guard(epoch);
    if (input.tabId !== tabId) throw new Error('The browser tab changed. Look again.');
    let result = null;
    if (action === 'act') {
        const kind = args.action;
        if (!STEPS.includes(kind)) throw new Error(`Unsupported browser step "${kind}".`);
        if (kind === 'open') {
            if (!origin(args.url) || origin(args.url) !== expectedOrigin) throw new Error('Use an HTTP(S) address without credentials.');
            await chrome.tabs.update(tabId, { url: args.url }); guard(epoch);
            result = { ok: true };
        } else {
            if (input.generation !== generation || tab.pendingUrl && tab.pendingUrl !== tab.url) throw new Error('The page changed. Look again.');
            if (kind === 'back') { await history({ epoch, expectedOrigin }); guard(epoch); result = { ok: true }; }
            else {
                if (origin(tab.url) !== expectedOrigin) throw new Error('The website changed since this step was decided. Look again.');
                result = await step(args, epoch); guard(epoch);
                if (result?.error) return { ...result, url: tab.url };
            }
        }
        if (!['find', 'scroll', 'wait'].includes(kind)) await settle(epoch); else await delay(150);
    } else if (Number.isFinite(args.waitMs)) { await delay(Math.max(0, Math.min(3000, args.waitMs))); guard(epoch); }
    const current = await chrome.tabs.get(tabId); guard(epoch);
    if (!origin(current.url)) return { url: current.url, text: '', elements: [], error: 'The browser is on a blank page. Open a website first.' };
    const observation = await script(look, [crypto.randomUUID(), {}, MANUAL_FIELDS]); guard(epoch);
    if (input.image && !observation.blocker) await capture(observation, epoch);
    // Back is offered only when its destination was observed from real history.
    try { const h = await history(); backUrl = h.entries[h.currentIndex - 1]?.url || null; } catch { backUrl = null; }
    guard(epoch);
    await publish(); guard(epoch);
    return { ...observation, ...(result && action === 'act' ? { step: result } : {}), targetId: tabId, generation, canGoBack: !!backUrl,
        ...(observation.readyState === 'loading' ? { loading: true } : {}) };
}
/* ── The live view, and the user's hands on it (2026-09-21) ─────────────
 * Workrooms shows this tab inside the chat. `view` is a scaled picture of the
 * viewport plus its size in CSS pixels, in EITHER control mode. `input` is
 * the user's own pointer and keyboard, forwarded as trusted events — and only
 * while control is 'human', so the agent and the user are never both at the
 * wheel. Nothing here is logged or kept: keys go straight to Chrome. While
 * the user drives, the debugger stays attached for them and is dropped a few
 * seconds after the last frame is asked for. */
let viewIdle = null;
function keepViewAlive() {
    clearTimeout(viewIdle);
    viewIdle = setTimeout(() => { if (control === 'human') releaseDebugger(); }, 6000);
}
async function view() {
    await ensure();
    const tab = await chrome.tabs.get(tabId);
    if (!origin(tab.url)) return { status: 'waiting', message: 'No website is open yet.', control };
    // Capture the designated target, including in the background. Capturing a
    // window's visible tab could accidentally capture a different user tab.
    const documentGeneration = generation;
    const size = await script(() => ({ w: innerWidth, h: innerHeight })).catch(() => null);
    if (!size?.w) return { status: 'waiting', message: 'The page is loading…', control };
    const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 55, captureBeyondViewport: false,
        clip: { x: 0, y: 0, width: size.w, height: size.h, scale: Math.min(1, 1100 / size.w) } });
    keepViewAlive();
    const current = await chrome.tabs.get(tab.id);
    if (tab.id !== tabId || generation !== documentGeneration) return { status: 'waiting', message: 'The page changed.', control };
    const image = 'data:image/jpeg;base64,' + shot.data;
    if (image.length > 900000) return { status: 'waiting', message: 'This page is too large to show here. Open it in Chrome.', control };
    return { status: 'live', image, url: current.url, title: current.title, viewport: size, control, checkedAt: Date.now() };
}
const num = (value, max) => Math.max(0, Math.min(max, Math.round(Number(value) || 0)));
const EDIT_COMMANDS = { a: 'selectAll', c: 'copy', x: 'cut', z: 'undo' };
async function userInput(event = {}) {
    if (control !== 'human') throw new Error('Take control first.');
    keepViewAlive();
    const modifiers = num(event.modifiers, 15);
    if (event.type === 'mouse') {
        const type = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved' }[event.action];
        if (!type) throw new Error('Unsupported pointer event');
        const button = event.action === 'move' ? 'none' : event.button === 2 ? 'right' : 'left';
        await cdp('Input.dispatchMouseEvent', { type, x: num(event.x, 10000), y: num(event.y, 10000), button, modifiers,
            buttons: event.action === 'down' ? 1 : 0, clickCount: event.action === 'move' ? 0 : Math.max(1, num(event.clickCount, 3)) });
    } else if (event.type === 'wheel') {
        await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: num(event.x, 10000), y: num(event.y, 10000), modifiers,
            deltaX: Math.max(-2000, Math.min(2000, Number(event.deltaX) || 0)), deltaY: Math.max(-2000, Math.min(2000, Number(event.deltaY) || 0)) });
    } else if (event.type === 'key') {
        const key = String(event.key || '').slice(0, 32), code = String(event.code || '').slice(0, 32), vk = num(event.keyCode, 255);
        const printable = key.length === 1 && !(modifiers & 6); // no Ctrl / Meta
        const command = (modifiers & 4) && EDIT_COMMANDS[key.toLowerCase()];
        await cdp('Input.dispatchKeyEvent', { type: event.action === 'up' ? 'keyUp' : printable || key === 'Enter' ? 'keyDown' : 'rawKeyDown',
            key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers,
            ...(event.action !== 'up' && printable ? { text: key, unmodifiedText: key } : {}),
            ...(event.action !== 'up' && key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}),
            ...(event.action !== 'up' && command ? { commands: [command] } : {}) });
    } else if (event.type === 'text') {
        const text = String(event.text || '').slice(0, 8000);
        if (text) await cdp('Input.insertText', { text });
    } else throw new Error('Unsupported input');
    return { ok: true };
}
async function dispatch(message) {
    if (message.operation === 'ensure') return ensure();
    if (message.operation === 'show') { await ensure(); await chrome.tabs.update(tabId, { active: true }); await chrome.windows.update(windowId, { focused: true }); return state(); }
    if (message.operation === 'control') {
        if (message.args.control !== 'agent') throw new Error('Invalid browser control');
        await ensure();
        if (control !== 'agent') { controlEpoch++; control = 'agent'; }
        const tab = await chrome.tabs.get(tabId);
        await publish(); return state();
    }
    if (message.operation === 'execute') return execute(message.args);
    if (message.operation === 'view') return view();
    if (message.operation === 'input') return userInput(message.args);
    throw new Error('Unsupported browser operation');
}
function reply(id, value, error, destination = port) {
    try { destination?.postMessage({ kind: 'result', id, ...(error ? { error: String(error.message || error).slice(0, 300) } : { value }) }); } catch {}
}
function connect() {
    if (port || connecting) return;
    connecting = true;
    try {
        const connection = chrome.runtime.connectNative(ANJADHE_HOST); port = connection;
        connection.onMessage.addListener(message => {
            if (message.kind === 'ready') { connected = true; connecting = false; publish(); return; }
            if (message.kind !== 'command' || typeof message.id !== 'string') return;
            if (message.operation === 'control' && message.args?.control === 'human') {
                // Priority path: invalidate queued work before waiting for it.
                const stopped = setHuman('app');
                Promise.all([stopped, queue.catch(() => {})]).then(() => state()).then(value => reply(message.id, value, null, connection));
                return;
            }
            const epoch = controlEpoch;
            const work = queue.then(() => {
                if (connection !== port || !connected || epoch !== controlEpoch) throw new Error('Browser control changed. Retry from the current page.');
                return dispatch(message);
            });
            queue = work.catch(() => {});
            work.then(value => reply(message.id, value, null, connection), error => reply(message.id, null, error, connection));
        });
        connection.onDisconnect.addListener(() => {
            void chrome.runtime.lastError;
            if (port === connection) { port = null; connected = false; connecting = false; setHuman('disconnect'); }
        });
    } catch { port = null; connected = false; connecting = false; }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.kind === 'mode?') { respond({ agent: connected && control === 'agent' && sender.tab?.id === tabId }); return; }
    if (message.kind === 'take-control' && sender.tab?.id === tabId) {
        // The click that BRINGS the agent's window forward is not a takeover:
        // looking at the work is not doing the work. Only the worker sees both
        // the window gaining focus and the press, so it decides, not the page.
        if (message.press === 'pointer' && Date.now() - windowFocusedAt < ACTIVATION_MS) { respond({ ok: false, activation: true }); return; }
        setHuman('takeover'); respond({ ok: true }); return;
    }
    // Only this extension's popup can manage its connection.
    if (sender.tab || sender.url !== chrome.runtime.getURL('popup.html')) return;
    if (message.kind === 'connect') { connect(); respond({ ok: true }); }
    if (message.kind === 'state') { state().then(respond); return true; }
    if (message.kind === 'takeover') { setHuman('takeover').then(() => queue).then(() => state()).then(respond); return true; }
});
/* Window focus, so the shield's press can be told from the click that merely
 * raised the window. Nothing here reads a key, a field or any page text. */
const ACTIVATION_MS = 700;
let windowFocusedAt = 0;
chrome.windows.onFocusChanged.addListener(id => { if (windowId !== null && id === windowId) windowFocusedAt = Date.now(); });
chrome.tabs.onUpdated.addListener((id, change) => {
    if (id !== tabId) return;
    if (change.status === 'loading' || change.url) { generation++; backUrl = null; }
    if (origin(change.url)) chrome.storage.local.set({ agentURL: change.url });
    publish();
});
chrome.tabs.onCreated.addListener(tab => {
    if (tab.openerTabId !== tabId) return;
    tabId = tab.id; windowId = tab.windowId; generation++; backUrl = null;
    chrome.storage.session.set({ agentTab: tabId }); publish();
});
chrome.tabs.onRemoved.addListener(id => {
    if (id !== tabId) return;
    tabId = null; windowId = null; generation++; setHuman('tab-gone'); chrome.storage.session.remove('agentTab');
});
chrome.alarms.create('connect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'connect') connect(); });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
