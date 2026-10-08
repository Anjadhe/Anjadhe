'use strict';

const { SlackMonitorIntake } = require('./slack-monitor-intake');
const { isSlack } = require('./slack-mcp');

/** Exactly one main-process scheduler. The existing background owner decides
 * liveness; no renderer timer, hidden-window duplication or sleep assertion.
 * Release gate defaults OFF until reviewed setup + insights are connected. */
class SlackMonitorRuntime {
    constructor({ store, mcp, background, enabled = () => false, changed = () => {}, now = Date.now,
        setInterval: schedule = setInterval, clearInterval: unschedule = clearInterval }) {
        Object.assign(this, { mcp, background, enabled, changed, schedule, unschedule });
        this.started = false;
        this.suspended = false;
        this.busy = false;
        this.outcome = 'off';
        this.intake = new SlackMonitorIntake({ store, readerFor: name => mcp.slackReader(name),
            allowed: () => this.allowed(), now });
        this.onBackground = () => this.refresh();
    }

    _owner() {
        const owner = this.background.owner;
        if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed?.() || owner.webContents.isCrashed?.()
            || !this.background.windows.has(owner.webContents.id)) return null;
        return owner.webContents.id;
    }

    allowed() {
        return this.started && this.enabled() === true && !this.suspended && !this.background.paused
            && !this.background.quitting && this._owner() !== null;
    }

    start() {
        if (this.started) return;
        this.started = true;
        this.background.on('changed', this.onBackground);
        this.timer = this.schedule(() => { void this.pump(); }, 15000);
        this.timer?.unref?.();
        this.refresh();
    }

    attach(worker) {
        this.worker = worker;
        this.intake.onCancel = () => worker.cancel();
        this.intake.onReset = () => worker.clear();
    }

    refresh() {
        try {
            const key = `${this._owner()}:${this.allowed()}`;
            if (key !== this.ownerKey) { this.ownerKey = key; this.intake.cancelActive(); }
        } catch { this.ownerKey = null; this.intake.cancelActive(); this.outcome = 'store_unavailable'; }
        // Avoid running from inside an OAuth store-write callback; that path
        // can be in the middle of refreshing a token for this very reader.
    }

    connectionsChanged() {
        try {
            const name = this.intake.connection();
            if (!name) return true;
            const server = this.mcp.listServers().find(s => s.name === name);
            if (!server || !isSlack(server.url) || server.auth !== 'oauth' || !server.enabled || server.authStatus !== 'connected') {
                this.intake.stop(); // disconnect/re-authorize never inherits monitoring consent
                this.outcome = 'off';
            }
            return true;
        } catch { this.intake.cancelActive(); this.outcome = 'store_unavailable'; return false; }
    }

    suspend() { this.suspended = true; this.refresh(); }
    resume() { this.suspended = false; this.refresh(); void this.pump(); }

    async pump() {
        if (this.busy) return;
        this.busy = true;
        try {
            this.refresh();
            if (!this.allowed() || !this.connectionsChanged()) return;
            const result = await this.intake.tick();
            this.outcome = result.state;
            if (result.state === 'account_changed') this.intake.stop();
            else if (result.state === 'needs_sign_in') this.intake.pause(true);
            if (this.allowed()) await this.worker?.step();
        } catch { this.outcome = 'store_unavailable'; }
        finally { this.busy = false; this.changed(); }
    }

    status() { return { ...this.intake.status(), ...this.worker?.status(), available: this.enabled() === true, running: this.allowed(), outcome: this.outcome }; }

    shutdown() {
        this.started = false;
        this.intake.cancelActive();
        this.background.off('changed', this.onBackground);
        if (this.timer != null) this.unschedule(this.timer);
        this.timer = null;
    }
}

module.exports = { SlackMonitorRuntime };
