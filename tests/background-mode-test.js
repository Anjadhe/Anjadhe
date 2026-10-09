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
// The menu-bar icon is the sprout n template build-icons.js writes, not a
// code-drawn glyph — and the file it names must exist.
const trayPaths = [];
// The sleep assertion: one id at a time, counted so a leak shows.
const blocker = { held: new Set(), next: 0, start(type) { assert.equal(type, 'prevent-app-suspension'); const id = this.next++; this.held.add(id); return id; }, stop(id) { this.held.delete(id); } };
const manager = new BackgroundMode({ app, ipcMain: ipc, Tray, Menu: { buildFromTemplate: items => items }, nativeImage: { createFromPath: (p) => { trayPaths.push(p); return { setTemplateImage() {} }; } }, store, platform: 'darwin', isolated: false, openWindow: makeWindow, powerSaveBlocker: blocker });
const transitions = [];
manager.on('changed', () => transitions.push({ owner: manager.owner?.webContents.id, paused: manager.paused, quitting: manager.quitting }));
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
// Scheduled work keeps the Mac awake: only the owner's report counts, Pause releases it, resuming holds it again.
const report = (win, hold, reason) => ipc.emit('background-awake', { sender: { id: win.webContents.id } }, { hold, reason });
report(second, true, '1 routine is scheduled');
assert.equal(manager.awake, false, 'A window that is not the owner cannot hold the Mac awake');
report(first, true, '2 routines are scheduled');
assert.equal(manager.awake, true);
assert.equal(blocker.held.size, 1);
assert.equal(manager.state(first.webContents.id).awakeReason, '2 routines are scheduled');
assert.ok(manager.tray.menu.some(x => x.label === 'Keeping this Mac awake: 2 routines are scheduled'));
manager.set({ paused: true, openAtLogin: true });
assert.equal(transitions.at(-1).paused, true, 'Main readers observe pause synchronously');
assert.equal(manager.awake, false, 'Pause lets the Mac sleep');
assert.equal(blocker.held.size, 0);
manager.set({ paused: false });
assert.equal(manager.awake, true, 'Resuming holds it again without a new report');
manager.set({ paused: true });
assert.equal(manager.state(first.webContents.id).paused, true);
assert.equal(login, true);
assert.equal(manager.tray.menu.find(x => x.label === 'Pause scheduled routines').checked, true);
app.quit();
assert.equal(transitions.at(-1).quitting, true, 'Quit cancels main readers before windows close');
first.emit('close', { preventDefault() { prevented = true; } });
assert.equal(prevented, false, 'Quit must actually close retained window');
manager.quitting = false;
manager.set({ enabled: false });
assert.equal(manager.tray, null);
assert.equal(first.visible, true);
assert.equal(first.throttled, true);
manager.set({ paused: false });
report(first, true, '1 routine is scheduled');
assert.equal(manager.awake, true);
first.emit('closed');
assert.equal(transitions.at(-1).owner, second.webContents.id, 'Main readers observe owner handoff');
assert.equal(manager.state(second.webContents.id).owner, true);
assert.equal(manager.awake, false, 'The old owner\'s report dies with it; the new owner speaks for itself');
report(second, true, '1 routine is scheduled');
assert.equal(manager.awake, true);
report(second, false, '');
assert.equal(manager.awake, false, 'An empty schedule lets the Mac sleep');
assert.equal(blocker.held.size, 0);
report(second, true, '1 job is running');
app.emit('will-quit');
assert.equal(manager.awake, false, 'Quit releases the assertion');
assert.equal(blocker.held.size, 0);
const event = { sender: { id: 999 } };
ipc.emit('background-state', event);
assert.equal(event.returnValue, null);
assert.throws(() => ipc['background-set'](event, { enabled: true }));

// A login launch retains a hidden window only when explicitly enabled.
manager.set({ enabled: true });
app.getLoginItemSettings = () => ({ openAtLogin: true, wasOpenedAtLogin: true });
const loginManager = new BackgroundMode({ app, ipcMain: new class extends EventEmitter { handle() {} }(), Tray, Menu: { buildFromTemplate: items => items }, nativeImage: { createFromPath: (p) => { trayPaths.push(p); return { setTemplateImage() {} }; } }, store, platform: 'darwin', isolated: false, openWindow: makeWindow });
assert.equal(loginManager.register(makeWindow()), true);
assert.equal(loginManager.register(makeWindow()), false, 'Additional windows must remain visible');
manager.quitting = true;
manager.quitting = false; // native unload prompt: Stay
prevented = false;
second.emit('close', { preventDefault() { prevented = true; } });
assert.equal(prevented, true, 'Cancelling Quit restores close-to-menu-bar');
const beforeCrash = transitions.length;
second.webContents.emit('render-process-gone');
assert.equal(transitions.length, beforeCrash + 1, 'A renderer crash wakes main lifecycle consumers');
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

assert.ok(trayPaths.length > 0, 'the tray loaded an icon');
for (const p of trayPaths) {
    assert.ok(/assets[\/\\]trayTemplate\.png$/.test(p), `tray icon is the template: ${p}`);
    assert.ok(require('fs').existsSync(p), `tray icon exists: ${p}`);
}
console.log('background-mode: tray icon is the sprout n template');
