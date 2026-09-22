const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const BackgroundMode = require('../js/main/background-mode');
const app = new EventEmitter();
app.isPackaged = true;
let login = false;
app.getLoginItemSettings = () => ({ openAtLogin: login, wasOpenedAtLogin: false });
app.setLoginItemSettings = settings => { login = settings.openAtLogin; };
app.quit = () => app.emit('before-quit');
const ipc = new EventEmitter();
ipc.handle = (name, fn) => { ipc[name] = fn; };
const data = new Map();
const store = { get: (key, fallback) => data.has(key) ? data.get(key) : fallback, set: (key, value) => data.set(key, value) };
class Tray { setToolTip() {} setContextMenu(menu) { this.menu = menu; } destroy() { this.destroyed = true; } }
let nextId = 0;
function makeWindow() {
    const win = new EventEmitter();
    win.webContents = new EventEmitter();
    win.webContents.id = ++nextId;
    win.webContents.setBackgroundThrottling = value => { win.throttled = value; };
    win.webContents.send = (...args) => { win.lastMessage = args; };
    win.isDestroyed = () => false;
    win.isMinimized = () => false;
    win.show = () => { win.visible = true; };
    win.hide = () => { win.visible = false; };
    win.focus = () => {};
    return win;
}
const manager = new BackgroundMode({ app, ipcMain: ipc, Tray, Menu: { buildFromTemplate: items => items }, nativeImage: { createFromBitmap: () => ({ setTemplateImage() {} }) }, store, platform: 'darwin', isolated: false, openWindow: makeWindow });
const first = makeWindow(), second = makeWindow();
manager.register(first); manager.register(second);
assert.equal(manager.state(first.webContents.id).owner, true);
assert.equal(manager.state(second.webContents.id).owner, false);
manager.set({ enabled: true });
assert.equal(first.throttled, false);
assert.equal(second.throttled, true);
let prevented = false;
first.emit('close', { preventDefault() { prevented = true; } });
assert.equal(prevented, true);
assert.equal(first.visible, false);
manager.open('updates');
assert.equal(first.visible, true);
assert.deepEqual(first.lastMessage, ['background-open', 'updates']);
prevented = false;
second.emit('close', { preventDefault() { prevented = true; } });
assert.equal(prevented, false);
manager.set({ paused: true, openAtLogin: true });
assert.equal(manager.state(first.webContents.id).paused, true);
assert.equal(login, true);
assert.equal(manager.tray.menu.find(x => x.label === 'Pause scheduled routines').checked, true);
app.quit();
first.emit('close', { preventDefault() { prevented = true; } });
assert.equal(prevented, false, 'Quit must actually close retained window');
manager.quitting = false;
manager.set({ enabled: false });
assert.equal(manager.tray, null);
assert.equal(first.visible, true);
assert.equal(first.throttled, true);
first.emit('closed');
assert.equal(manager.state(second.webContents.id).owner, true);
const event = { sender: { id: 999 } };
ipc.emit('background-state', event);
assert.equal(event.returnValue, null);
assert.throws(() => ipc['background-set'](event, { enabled: true }));

// A login launch retains a hidden window only when explicitly enabled.
manager.set({ enabled: true });
app.getLoginItemSettings = () => ({ openAtLogin: true, wasOpenedAtLogin: true });
const loginManager = new BackgroundMode({ app, ipcMain: new class extends EventEmitter { handle() {} }(), Tray, Menu: { buildFromTemplate: items => items }, nativeImage: { createFromBitmap: () => ({ setTemplateImage() {} }) }, store, platform: 'darwin', isolated: false, openWindow: makeWindow });
assert.equal(loginManager.register(makeWindow()), true);
assert.equal(loginManager.register(makeWindow()), false, 'Additional windows must remain visible');
manager.quitting = true;
manager.quitting = false; // native unload prompt: Stay
prevented = false;
second.emit('close', { preventDefault() { prevented = true; } });
assert.equal(prevented, true, 'Cancelling Quit restores close-to-menu-bar');
second.webContents.emit('render-process-gone');
assert.match(manager.status, /stopped/);

// Single-flight and authoritative pause gates, including a pause while an
// asynchronous trigger evaluation is pending. No network/model calls.
const engine = require('../js/agent/routine-engine');
global.window = { electronBackground: { state: () => ({ owner: true, paused: false }) } };
global.AgentService = { model: 'test' };
global.NotePrompts = { config: () => ({ runMode: 'digest' }) };
engine.armedRoutines = () => [{ id: 'one' }];
engine.noteChecked = engine.noteMatched = () => {};
let resolveCheck, checks = 0, queued = 0;
engine._firedFor = async () => { checks++; return new Promise(resolve => { resolveCheck = resolve; }); };
engine.enqueue = () => queued++;
engine.drain = async () => {};
(async () => {
    const pending = engine.tick();
    await engine.tick();
    assert.equal(checks, 1);
    window.electronBackground.state = () => ({ owner: true, paused: true });
    resolveCheck({ fired: [{ id: 'message' }] });
    await pending;
    assert.equal(queued, 0);
    assert.equal(engine._ticking, false);
    window.electronBackground.state = () => ({ owner: false, paused: false });
    await engine.tick();
    assert.equal(checks, 1, 'Secondary window cannot evaluate triggers');
    console.log('background-mode: lifecycle, menu, ownership and scheduler checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
