/**
 * FocusMode — what the WHOLE app does while the user is focusing.
 * ================================================================
 * A focus session (Pomodoro today; any package could drive one) is not a
 * page, it is a state of the user. While it runs the app gets out of the
 * way, and while it runs the rest of the app should not call for
 * attention. Concretely, `enter()` puts `body.is-focusing` on:
 *
 *  1. The TITLEBAR carries the session — `#titlebar-focus-pill`, one 26px
 *     box beside the status pills: a breathing dot, the task, the time
 *     left. It is the way back to the timer from any page, and it shows
 *     for the whole session (running, paused, the break), not only while
 *     the focus phase runs, so the user never has to remember where the
 *     timer went. Click → the driving app.
 *  2. The LEFT NAV folds to icons and its counts disappear
 *     (`SideNav.setTransientCollapsed`). Transient: it never writes the
 *     user's collapse preference, and `exit()` puts the rail back exactly
 *     as it was. A rail full of unread numbers is the opposite of focus.
 *  3. NOTIFICATIONS that are not time-critical are HELD. `Notify.show`
 *     asks `FocusMode.hold(kind, …)` first: email insights and routine
 *     results wait; reminders and task alerts (a meeting in 10 minutes)
 *     still fire. Held notices are released as ONE summary when the focus
 *     phase ends, and the break view lists them — nothing is dropped.
 *
 * Laws:
 *  - `enter/update/exit` are the only writers; the driving app calls them
 *    from its own state transitions and never touches the DOM here.
 *  - This module never persists anything. A restart re-enters from the
 *    driver's restored timer.
 *  - Holding is by KIND, never by content — the module does not read what
 *    a notification says beyond keeping it to release later.
 */
const FocusMode = {
    HELD_KINDS: ['email', 'message', 'routine'],
    active: false,          // body.is-focusing: the focus PHASE is running
    session: null,          // { app, label, phase: 'focus'|'break', running, endsAt, remainingMs }
    _held: [],              // [{ title, body, opts, at }]
    _tick: null,
    _collapsedBefore: null,

    /** Start (or re-assert) the session. `s` = { app, label, phase, running, endsAt, remainingMs }. */
    enter(s) {
        const wasActive = this.active;
        this.session = { ...(this.session || {}), ...s };
        const focusing = this.session.phase === 'focus' && !!this.session.running;
        this.active = focusing;
        document.body.classList.toggle('is-focusing', focusing);
        document.body.dataset.focusPhase = this.session.phase || '';
        if (focusing && !wasActive) {
            if (typeof SideNav !== 'undefined' && SideNav.setTransientCollapsed) SideNav.setTransientCollapsed(true);
        } else if (!focusing && wasActive) {
            if (typeof SideNav !== 'undefined' && SideNav.setTransientCollapsed) SideNav.setTransientCollapsed(false);
            this.releaseHeld();
        }
        this._paintPill();
        this._ensureTick();
        this._announce();
    },

    /** The driver's per-tick / per-transition update. Same shape as enter(). */
    update(s) { this.enter(s); },

    /** The session is over (reset to idle, no timer). Everything goes back. */
    exit() {
        const wasActive = this.active;
        this.active = false;
        this.session = null;
        document.body.classList.remove('is-focusing');
        delete document.body.dataset.focusPhase;
        if (wasActive && typeof SideNav !== 'undefined' && SideNav.setTransientCollapsed) SideNav.setTransientCollapsed(false);
        if (wasActive) this.releaseHeld();
        if (this._tick) { clearInterval(this._tick); this._tick = null; }
        this._paintPill();
        this._announce();
    },

    isFocusing() { return this.active; },

    // ── Notification hold ──

    /**
     * Called by Notify.show BEFORE raising anything. Returns true when the
     * notice was taken into the hold (the caller then raises nothing).
     */
    hold(kind, title, body, opts) {
        if (!this.active) return false;
        if (!this.HELD_KINDS.includes(kind)) return false;
        this._held.push({ kind, title: String(title || ''), body: String(body || ''), opts: opts || {}, at: Date.now() });
        this._paintPill();
        this._announce();
        return true;
    },

    held() { return this._held.slice(); },

    /**
     * Let the held notices out as ONE summary banner (the individual
     * forwards to Telegram / iMessage go out as themselves — a phone reads
     * them later anyway). The list stays readable via `held()` until the
     * next focus phase starts, so the break view can show it.
     */
    releaseHeld() {
        const list = this._held;
        if (!list.length) return;
        const n = list.length;
        const summary = list.slice(0, 4).map(h => h.title).join(' · ') + (n > 4 ? ` · +${n - 4} more` : '');
        try {
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                new Notification(`While you focused: ${n} ${n === 1 ? 'thing' : 'things'}`, { body: summary, silent: true });
            }
        } catch { /* banner unavailable */ }
        for (const h of list) {
            try {
                if (h.opts.telegram !== false) {
                    if (window.electronTelegram) window.electronTelegram.notify(h.title, h.body, h.opts.kind || '').catch(() => {});
                    if (window.electronIMessage) window.electronIMessage.notify(h.title, h.body, h.opts.kind || '').catch(() => {});
                }
            } catch { /* forward lanes are optional */ }
        }
        this._released = list;
        this._held = [];
        this._paintPill();
    },

    /** Notices released at the end of the LAST focus phase — for the break view. */
    lastReleased() { return (this._released || []).slice(); },
    clearReleased() { this._released = []; },

    // ── Titlebar pill ──

    _paintPill() {
        const pill = document.getElementById('titlebar-focus-pill');
        if (!pill) return;
        const s = this.session;
        if (!s) { pill.hidden = true; pill.style.display = 'none'; return; }
        pill.style.display = '';
        pill.hidden = false;
        pill.dataset.phase = s.phase || 'focus';
        pill.dataset.running = s.running ? '1' : '0';
        const label = pill.querySelector('.titlebar-focus-label');
        const time = pill.querySelector('.titlebar-focus-time');
        const heldEl = pill.querySelector('.titlebar-focus-held');
        const name = s.phase === 'focus' ? (s.label || 'Focusing') : (s.phase === 'long' ? 'Long break' : 'Break');
        if (label) label.textContent = name;
        if (time) time.textContent = s.running ? this._fmt(this._remaining()) : 'Paused';
        if (heldEl) {
            const n = this._held.length;
            heldEl.hidden = n === 0;
            heldEl.textContent = n ? String(n) : '';
            heldEl.title = n ? `${n} held until the break` : '';
        }
        pill.title = s.phase === 'focus'
            ? `Focusing on ${s.label || 'a task'} — ${s.running ? this._fmt(this._remaining()) + ' left' : 'paused'}. Click to open the timer.`
            : `On a break — ${s.running ? this._fmt(this._remaining()) + ' left' : 'paused'}. Click to open the timer.`;
    },

    _remaining() {
        const s = this.session;
        if (!s) return 0;
        if (s.running && s.endsAt) return Math.max(0, s.endsAt - Date.now());
        return Math.max(0, s.remainingMs || 0);
    },

    _fmt(ms) {
        const t = Math.max(0, Math.ceil(ms / 1000));
        return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    },

    _ensureTick() {
        if (this._tick) return;
        this._tick = setInterval(() => {
            if (!this.session) { clearInterval(this._tick); this._tick = null; return; }
            const time = document.querySelector('#titlebar-focus-pill .titlebar-focus-time');
            if (time && this.session.running) time.textContent = this._fmt(this._remaining());
        }, 1000);
    },

    _announce() {
        document.dispatchEvent(new CustomEvent('anjadhe:focus-changed', { detail: { active: this.active, session: this.session } }));
    },

    init() {
        if (this._wired) return;
        this._wired = true;
        const pill = document.getElementById('titlebar-focus-pill');
        if (pill) pill.addEventListener('click', () => {
            const app = this.session?.app || 'pomodoro';
            if (typeof AppManager !== 'undefined') AppManager.openApp(app);
        });
        this._paintPill();
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = FocusMode;
