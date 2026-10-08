'use strict';
const { sensitiveStep } = require('./browser/sensitive-steps');
/* The workroom browser: the user's own Chrome under a dedicated profile,
 * driven through the extension in browser-extension/. All automation is tied
 * to a live workroom lease.
 *
 * Two verbs (2026-09-21): LOOK and ACT, the contract screen_look/screen_act
 * and mac_look/mac_act already use. An act is one step and returns a fresh
 * look.
 *
 * Approvals are decided HERE, by risk, and the renderer only awaits the
 * answer — there is no permit for a model-side caller to hold or replay:
 *
 *   free      looking, scrolling, finding text, waiting, moving the focus,
 *             closing a cookie notice (which can only ever refuse).
 *   site      the first open / click / type on a website asks ONCE, in the
 *             chat. "Yes" covers this workroom; "Always here" is the saved
 *             website permission on this Mac.
 *   step      anything that reads as buying, paying, confirming, sending,
 *             deleting or signing in asks EVERY time (W24), whatever was
 *             allowed before, and can never become a standing permission.
 *   egress    once a workroom holds the user's private data, opening a
 *             website it has not used yet asks even if that site is saved —
 *             a URL is the one place a page-planted instruction could carry
 *             that data out.
 */
class WorkroomBrowser {
    static ACTIONS = ['look', 'act'];
    static STEPS = ['open', 'back', 'click', 'type', 'select', 'press', 'scroll', 'find', 'wait', 'dismiss_consent'];
    static FREE = new Set(['scroll', 'find', 'wait', 'dismiss_consent']);
    constructor({ store, settings, chrome }) {
        Object.assign(this, { store, settings, chrome });
        if (chrome) chrome.expectedActions = [...WorkroomBrowser.ACTIONS, 'record'];
        this.busy = false;
        this.roomSites = new Map();   // roomId -> Set(origin) the user said yes to for this workroom
        this.lastElements = new Map();
    }
    state() { return { ...this.chrome.state(), working: this.store().leases.size > 0 }; }
    /** Does the copy of the extension Chrome actually loaded speak look/act? */
    extensionReady() {
        const theirs = this.chrome.state().actions;
        return !Array.isArray(theirs) || !theirs.length || WorkroomBrowser.ACTIONS.every(action => theirs.includes(action));
    }
    /* The live view in the chat and the user's forwarded hands (2026-09-21)
     * left with the chat's Browser panel on 2026-10-05: the person drives the
     * Chrome window itself, and the extension forwards no keystrokes. */
    /* ── Recording: the person shows a task (docs/TEACH.md, 2026-10-07) ──
     * The person drives the agent's own Chrome window while the extension
     * notes what they do, by label. It is the person's session, so control is
     * theirs for the whole recording and no job may hold the browser: a job
     * at the wheel is refused, never paused underneath them. The log comes
     * back ONCE, on stop, and main keeps nothing of it. */
    async startRecording() {
        if (this.store().leases.size) throw new Error('A job is using the browser right now. Wait for it to finish, or pause it, then try again.');
        if (this.chrome.state().recording?.active) throw new Error('Already recording. Press Done in the Chrome window, or finish here, before starting another.');
        await this.chrome.ensure();
        await this.chrome.takeover();
        this.holder = null;
        const state = await this.chrome.record('start');
        await this.chrome.launch();   // in front: the person is about to use it
        return { ok: true, url: state.url || null };
    }
    async stopRecording() {
        const log = await this.chrome.record('stop');
        return { startedAt: log.startedAt, endedAt: log.endedAt, full: !!log.full, events: Array.isArray(log.events) ? log.events.slice(0, 400) : [] };
    }
    recordingStatus() {
        const current = this.chrome.state().recording;
        return { active: !!current?.active, done: !!current && !current.active, count: current?.count || 0 };
    }
    /** WHERE a step lands. Resolved from main's own view, never the model's. */
    origin(args = {}) {
        try {
            let target = this.chrome.state().url;
            if (args.action === 'open') target = args.url;
            if (args.action === 'back') target = this.chrome.state().backUrl;
            const url = new URL(target);
            return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
        } catch { return null; }
    }
    rememberElements(observation) {
        if (!Array.isArray(observation?.elements)) return;
        this.lastElements = new Map(observation.elements.filter(row => row && row.n != null).map(row => [String(row.n), row]));
    }
    /** WHAT a step presses, and why it must ask every time — or null. */
    sensitive(args = {}) {
        const action = args.action;
        const row = args.n != null ? this.lastElements.get(String(args.n)) || null : null;
        if (action === 'click' || action === 'select') return sensitiveStep(action === 'select' ? 'select_option' : 'click', { ref: args.n }, row);
        if (action === 'type') {
            const typed = sensitiveStep('type', { ref: args.n, text: args.text }, row);
            if (typed || !args.submit) return typed;
            // Enter in a field presses its form's button: judge THAT label.
            return row?.submits ? sensitiveStep('click', { ref: args.n }, { label: row.submits }) : null;
        }
        if (action === 'press' && args.key === 'Enter') {
            // The keyboard goes wherever the focus is, which main cannot see.
            // If ANY form in view would press something risky, Enter asks.
            for (const item of this.lastElements.values()) {
                const why = item.submits && sensitiveStep('click', { ref: item.n }, { label: item.submits });
                if (why) return why;
            }
        }
        return null;
    }
    trustedSites() { return this.settings.get('workroom-browser-trusted-origins', []); }
    trust(origin) {
        if (!origin || new URL(origin).origin !== origin || !/^https?:\/\//.test(origin)) throw new Error('A website origin is required');
        this.settings.set('workroom-browser-trusted-origins', [...new Set([...this.trustedSites(), origin])]);
    }
    revoke(origin) {
        this.settings.set('workroom-browser-trusted-origins', this.trustedSites().filter(site => site !== origin));
        for (const sites of this.roomSites.values()) sites.delete(origin);
        return this.trustedSites();
    }
    forget(roomId) { this.roomSites.delete(roomId); if (this.holder === roomId) this.holder = null; }
    /* ONE tab, so one workroom at the wheel at a time. This is the only lock
     * workrooms share: rooms that do not need the browser run side by side. */
    async acquire(sender, run) {
        for (;;) {
            this.check(sender, run);
            if (!this.holder || this.holder === run.id || !this.store().leases.has(this.holder)) { this.holder = run.id; return { ok: true }; }
            await new Promise(resolve => setTimeout(resolve, 400));
        }
    }
    release(run) { if (this.holder === run?.id) this.holder = null; return { ok: true }; }
    check(sender, run) {
        const lease = this.store().leases.get(run?.id);
        if (!lease || lease.sender !== sender || lease.token !== run?.token || this.store().get(run.id).status !== 'running') throw new Error('This workroom is paused or no longer active.');
    }
    /** In words, for the approval bubble. Built from main's view of the page. */
    describe(args) {
        const row = args.n != null ? this.lastElements.get(String(args.n)) : null;
        const name = row ? `“${String(row.label || row.placeholder || row.name || row.role).slice(0, 80)}”` : 'a control';
        switch (args.action) {
            case 'open': return `Open ${String(args.url).slice(0, 200)}`;
            case 'back': return 'Go back to the previous page';
            case 'click': return `Click ${name}`;
            case 'type': return `Type “${String(args.text || '').slice(0, 80)}” into ${name}${args.submit ? ' and press Enter' : ''}`;
            case 'select': return `Choose “${String(args.text || '').slice(0, 80)}” in ${name}`;
            case 'press': return `Press ${args.key}`;
            default: return `Browser step: ${args.action}`;
        }
    }
    /** Ask if this step needs asking. Resolves true to go ahead. */
    async approve(sender, run, args, { tainted = false } = {}) {
        const action = args.action;
        if (WorkroomBrowser.FREE.has(action) || (action === 'press' && args.key !== 'Enter')) return { approved: true };
        const origin = this.origin(args);
        if (!origin) return { approved: false, error: action === 'back' ? 'There is no earlier page to go back to.' : 'That is not a website address this browser can open.' };
        const sensitive = this.sensitive(args);
        const mine = this.roomSites.get(run.id) || new Set();
        const known = mine.has(origin) || (this.trustedSites().includes(origin) && !(tainted && action === 'open'));
        if (known && !sensitive) return { approved: true };
        const host = new URL(origin).host;
        const decision = await this.store().requestApproval(run.id, run.token, sender, {
            agent: 'browser', kind: sensitive ? 'step' : 'site', origin, sensitive,
            summary: sensitive ? `${this.describe(args)} on ${host}?` : `Work on ${host}?`,
            detail: sensitive ? sensitive : `First step: ${this.describe(args)}.` });
        if (!decision.approved) return { approved: false, denied: true, cancelled: !!decision.cancelled };
        this.check(sender, run);
        // The page may have changed while the user was deciding.
        if (this.origin(args) !== origin) return { approved: false, error: 'The website changed while waiting for your answer. Look again.' };
        if (!sensitive) {
            this.roomSites.set(run.id, mine.add(origin));
            if (decision.always) this.trust(origin);
        }
        return { approved: true, asked: true };
    }
    async execute(sender, { action, args = {}, run, image = false, tainted = false } = {}) {
        this.check(sender, run);
        if (!WorkroomBrowser.ACTIONS.includes(action)) throw new Error('Unsupported browser action');
        if (action === 'act' && !WorkroomBrowser.STEPS.includes(args.action)) throw new Error(`Unsupported browser step “${args.action}”.`);
        if (!this.extensionReady()) throw new Error('The nenva extension loaded in Chrome is older than this app; nenva reloads it as soon as the browser is idle. Wait a moment, then Continue.');
        let waitedMs = 0;
        if (action === 'act') {
            const started = Date.now();
            const decision = await this.approve(sender, run, args, { tainted });
            waitedMs = decision.asked || decision.denied ? Date.now() - started : 0;
            if (!decision.approved) return { error: decision.error || 'The user did not allow this step. Nothing was done.', denied: !!decision.denied, cancelled: !!decision.cancelled, waitedMs };
        }
        await this.acquire(sender, run);
        if (this.busy) throw new Error('The browser is finishing another step. Try again.');
        this.lastRoomId = run.id; this.busy = true;
        try {
            const observation = await this.chrome.execute(action, args, { image: !!image, expectedOrigin: action === 'act' ? this.origin(args) : null, check: () => this.check(sender, run) });
            this.rememberElements(observation);
            return { ...observation, waitedMs };
        } finally { this.busy = false; }
    }
}
module.exports = WorkroomBrowser;
