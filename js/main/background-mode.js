'use strict';

const path = require('path');

// One application window owns automatic routines. Keeping it alive preserves
// the existing scheduler, permission gates and persisted execution ledger.
class BackgroundMode {
    constructor({ app, ipcMain, Tray, Menu, nativeImage, store, platform, isolated, openWindow }) {
        Object.assign(this, { app, Tray, Menu, nativeImage, store, platform, isolated, openWindow });
        this.windows = new Map();
        this.owner = null;
        this.quitting = false;
        this.status = 'Idle';
        app.on('before-quit', () => { this.quitting = true; });
        app.on('will-quit', () => this.tray?.destroy());
        const allowed = event => this.windows.has(event.sender.id) && (!event.senderFrame || event.senderFrame === event.sender.mainFrame);
        ipcMain.on('background-state', event => { event.returnValue = allowed(event) ? this.state(event.sender.id) : null; });
        ipcMain.handle('background-set', (event, patch) => {
            if (!allowed(event)) throw new Error('Only an app window can change background settings.');
            return this.set(patch);
        });
        ipcMain.on('background-status', (event, status) => {
            if (!allowed(event) || event.sender.id !== this.owner?.webContents.id) return;
            if (!['Idle', 'Running a routine', 'Working in a workroom', 'Needs your attention'].includes(status)) return;
            if (status !== this.status) { this.status = status; this.refreshMenu(); }
        });
    }
    get enabled() { return this.platform === 'darwin' && this.store.get('backgroundMode', false); }
    get paused() { return this.store.get('backgroundRoutinesPaused', false); }
    state(id) {
        const loginAvailable = this.platform === 'darwin' && this.app.isPackaged && !this.isolated;
        return {
            supported: this.platform === 'darwin', enabled: this.enabled, paused: this.paused,
            owner: id === this.owner?.webContents.id, loginAvailable,
            openAtLogin: loginAvailable && this.app.getLoginItemSettings().openAtLogin
        };
    }
    set(patch = {}) {
        if (this.platform !== 'darwin') return this.state();
        if (typeof patch.openAtLogin === 'boolean') {
            if (!this.state().loginAvailable) throw new Error('Launch at login is available in the installed app.');
            this.app.setLoginItemSettings({ openAtLogin: patch.openAtLogin });
        }
        if (typeof patch.enabled === 'boolean') {
            // Build the tray before saving: a failed tray must not strand a hidden window.
            if (patch.enabled) this.ensureTray();
            this.store.set('backgroundMode', patch.enabled);
            if (!patch.enabled) { this.open(); this.tray?.destroy(); this.tray = null; }
        }
        if (typeof patch.paused === 'boolean') this.store.set('backgroundRoutinesPaused', patch.paused);
        this.broadcast();
        this.refreshMenu();
        return this.state();
    }
    register(win) {
        this.windows.set(win.webContents.id, win);
        if (!this.owner) this.owner = win;
        const hiddenLogin = this.enabled && this.windows.size === 1 && !this.isolated && this.app.isPackaged && this.app.getLoginItemSettings().wasOpenedAtLogin;
        if (this.enabled) this.ensureTray();
        win.webContents.setBackgroundThrottling(!(this.enabled && win === this.owner));
        win.on('close', event => {
            if (this.enabled && !this.quitting && win === this.owner) { event.preventDefault(); win.hide(); }
        });
        const id = win.webContents.id;
        win.on('closed', () => {
            this.windows.delete(id);
            if (win === this.owner) { this.owner = this.windows.values().next().value || null; this.status = 'Idle'; }
            this.broadcast();
        });
        win.webContents.on('did-finish-load', () => this.broadcast());
        win.webContents.on('render-process-gone', () => {
            if (win === this.owner) { this.status = 'Background work stopped. Open nenva to resume.'; this.refreshMenu(); }
        });
        return hiddenLogin;
    }
    broadcast() {
        for (const [id, win] of this.windows) {
            if (win.isDestroyed()) continue;
            win.webContents.setBackgroundThrottling(!(this.enabled && win === this.owner));
            win.webContents.send('background-changed', this.state(id));
        }
    }
    open(route) {
        const win = this.owner && !this.owner.isDestroyed() ? this.owner : this.openWindow();
        if (win.webContents.isCrashed?.()) win.webContents.reload();
        if (win.isMinimized()) win.restore();
        win.show(); win.focus();
        if (route) win.webContents.send('background-open', route);
    }
    ensureTray() {
        if (this.tray) return;
        // The sprout n as a macOS template (black on transparent, written by
        // scripts/build-icons.js; the @2x twin is picked up by name), so the
        // menu bar paints it for a light or dark bar. It was a code-drawn "A"
        // until 2026-09-23 — the rebrand regenerated every icon but this one.
        const icon = this.nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
        icon.setTemplateImage(true);
        this.tray = new this.Tray(icon);
        this.tray.setToolTip('nenva');
        this.refreshMenu();
    }
    refreshMenu() {
        if (!this.tray) return;
        this.tray.setContextMenu(this.Menu.buildFromTemplate([
            { label: this.status, enabled: false },
            { label: 'Open nenva', click: () => this.open() },
            { label: 'View updates', click: () => this.open('updates') },
            { type: 'separator' },
            { label: 'Pause scheduled routines', type: 'checkbox', checked: this.paused, click: item => this.set({ paused: item.checked }) },
            { label: 'Launch at login', type: 'checkbox', checked: this.state().openAtLogin, enabled: this.state().loginAvailable, click: item => this.set({ openAtLogin: item.checked }) },
            { type: 'separator' },
            { label: 'Quit nenva', click: () => this.app.quit() }
        ]));
    }
}
module.exports = BackgroundMode;
