/**
 * Recent Switcher — Ctrl+Tab cycling over recently opened apps, the way a
 * browser cycles tabs (or macOS ⌘Tab cycles apps).
 *
 * Hold Ctrl and tap Tab: a horizontal strip of recent apps appears, most
 * recent first, with the selection starting on the *previous* app — so a
 * quick Ctrl+Tab tap bounces straight back to where you just were. Keep
 * tapping Tab (Shift+Tab reverses) to walk the list; release Ctrl to
 * switch; Esc cancels.
 *
 * The titlebar clock button (#titlebar-recents-btn) opens the same strip
 * in POINTER mode: it stays put until a tile is clicked (or Enter), and
 * Esc / clicking elsewhere closes it — releasing Ctrl only commits when
 * the strip was driven there by Ctrl+Tab. Starting to cycle with
 * Ctrl+Tab while it is open hands it back to hold mode.
 *
 * This is the one deliberately RECENCY-ordered launcher. ⌘K ranks by
 * frequency and the titlebar app switcher by registry order because a
 * launcher answers "where do I go?" and must hold still for muscle
 * memory. A Ctrl+Tab switcher answers the opposite question — "where was
 * I?" — and recency is the only correct order for that.
 *
 * The MRU list is derived, not tracked: AppManager.recordAppUse already
 * stamps `last` on every open (localStorage 'app-usage', per-Mac), so
 * sorting by `last` IS the recency stack, and it survives restarts.
 * Hidden apps stay in the list — they were genuinely opened (via ⌘K by
 * name); hiding declutters launchers, but this strip only ever shows
 * where you actually were. Gated-off apps are dropped, matching openApp's
 * own refusal.
 *
 * Known limit: keystrokes inside a <webview> (Browse, Maker preview)
 * don't reach this document, so Ctrl+Tab is inert while one has focus.
 */
const RecentSwitcher = {
    _open: false,
    _sel: 0,
    _apps: [],
    // Opened by Ctrl+Tab (commit when Ctrl is released) vs the titlebar
    // button (stay until click/Enter/Esc).
    _holdMode: false,
    _MAX: 7,

    init() {
        // Capture phase, so cycling works even while focus sits in an
        // input or another component's key handling.
        document.addEventListener('keydown', (e) => this._onKeydown(e), true);
        document.addEventListener('keyup', (e) => {
            if (this._open && this._holdMode && e.key === 'Control') this._commit();
        }, true);

        const btn = document.getElementById('titlebar-recents-btn');
        btn?.addEventListener('click', (e) => {
            // Don't let this click reach the outside-close listener below.
            e.stopPropagation();
            if (this._open) this._cancel();
            else this._show(1, false);
        });
        // Losing the window (or clicking outside the strip) mid-hold means
        // the Ctrl keyup may never arrive here — treat both as a cancel.
        window.addEventListener('blur', () => { if (this._open) this._cancel(); });
        document.addEventListener('click', (e) => {
            if (this._open && !document.getElementById('recent-switcher')?.contains(e.target)) {
                this._cancel();
            }
        });
    },

    _onKeydown(e) {
        if (e.key === 'Tab' && e.ctrlKey && !e.metaKey && !e.altKey) {
            // Ctrl+Tab must never fall through to focus navigation.
            e.preventDefault();
            e.stopPropagation();
            const dir = e.shiftKey ? -1 : 1;
            if (this._open) {
                // Cycling by keyboard puts a button-opened strip into hold
                // mode — from here, releasing Ctrl commits, as expected.
                this._holdMode = true;
                this._move(dir);
            } else {
                this._show(dir);
            }
            return;
        }
        if (!this._open) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            this._cancel();
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            this._move(1);
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            this._move(-1);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            this._commit();
        }
    },

    /** Recently opened apps, most recent first, resolved against the registry. */
    _recentApps() {
        if (typeof AppManager?.getAppUsage !== 'function'
            || typeof GlobalSearch === 'undefined') return [];
        const usage = AppManager.getAppUsage();
        const byId = new Map(GlobalSearch.allApps().map(a => [a.id, a]));
        const gatedOff = (id) => typeof FEATURES !== 'undefined'
            && FEATURES.isGated(id) && !FEATURES.isEnabled(id);
        return Object.keys(usage)
            .filter(id => byId.has(id) && !gatedOff(id))
            .sort((a, b) => (usage[b]?.last || 0) - (usage[a]?.last || 0))
            .slice(0, this._MAX)
            .map(id => byId.get(id));
    },

    _show(dir, hold = true) {
        this._apps = this._recentApps();
        const len = this._apps.length;
        if (!len) return;
        const current = AppManager.currentApp;
        // The current app leads the list (recordAppUse ran when it opened),
        // so start the selection one past it — the previous app. From home
        // there is no current entry, and slot 0 is already "the last app I
        // was in".
        const start = this._apps[0]?.id === current ? 1 : 0;
        if (len <= start) return;   // only the current app is here — nothing to switch to
        this._sel = dir === 1 ? start : len - 1;
        this._holdMode = hold;

        const panel = this._ensurePanel();
        this._render(panel);
        panel.hidden = false;
        this._open = true;
        document.getElementById('titlebar-recents-btn')
            ?.setAttribute('aria-expanded', 'true');
    },

    _move(dir) {
        const len = this._apps.length;
        if (!len) return;
        this._sel = (this._sel + dir + len) % len;
        this._paintSelection();
    },

    _commit() {
        const app = this._apps[this._sel];
        this._close();
        // Re-opening the app you're already in would just re-render it.
        if (app && app.id !== AppManager.currentApp) AppManager.openApp(app.id);
    },

    _cancel() {
        this._close();
    },

    _close() {
        const panel = document.getElementById('recent-switcher');
        if (panel) panel.hidden = true;
        this._open = false;
        this._holdMode = false;
        this._apps = [];
        document.getElementById('titlebar-recents-btn')
            ?.setAttribute('aria-expanded', 'false');
    },

    _ensurePanel() {
        let panel = document.getElementById('recent-switcher');
        if (panel) return panel;
        panel = document.createElement('div');
        panel.id = 'recent-switcher';
        panel.className = 'recent-switcher';
        panel.hidden = true;
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Recent apps');
        document.body.appendChild(panel);
        return panel;
    },

    _render(panel) {
        const esc = (s) => (typeof UIUtils !== 'undefined'
            ? UIUtils.escapeHtml(s) : String(s));
        const isLocked = (id) => typeof AppManager?.isAppLocked === 'function'
            && AppManager.isAppLocked(id) && !AppManager.sensitiveUnlocked;

        // Icon markup is our own registry markup (inline SVGs; user-app
        // tiles may be emoji text) — same re-injection the app switcher does.
        panel.innerHTML = this._apps.map((a, i) =>
            `<button class="recent-switcher-tile${i === this._sel ? ' is-selected' : ''}" ` +
            `type="button" data-app="${esc(a.id)}" data-index="${i}">` +
            `<span class="recent-switcher-icon">${a.icon}</span>` +
            `<span class="recent-switcher-label">${esc(a.title)}</span>` +
            (isLocked(a.id)
                ? `<span class="app-switcher-lockbadge" aria-label="Locked">` +
                  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
                  `<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></span>`
                : '') +
            `</button>`
        ).join('');

        panel.querySelectorAll('.recent-switcher-tile').forEach(tile => {
            // Mouse works too: hovering moves the selection, clicking commits
            // (openApp handles the App Lock overlay itself when needed).
            tile.addEventListener('mouseenter', () => {
                this._sel = Number(tile.dataset.index);
                this._paintSelection();
            });
            tile.addEventListener('click', (e) => {
                e.stopPropagation();
                this._sel = Number(tile.dataset.index);
                this._commit();
            });
        });
    },

    _paintSelection() {
        const panel = document.getElementById('recent-switcher');
        if (!panel) return;
        panel.querySelectorAll('.recent-switcher-tile').forEach((tile, i) => {
            tile.classList.toggle('is-selected', i === this._sel);
        });
        panel.querySelector('.recent-switcher-tile.is-selected')
            ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
};
