/**
 * App Switcher — a compact popover grid under the titlebar wordmark.
 *
 * Reintroduced 2026-07-30, the same day the old Apps button and All apps
 * sheet went. ⌘K remains the keyboard launcher; this is the one-click,
 * mouse-first way to switch apps without typing — a single small panel,
 * not a second full-page surface.
 *
 * It paints nothing until opened and reads the app registry through
 * GlobalSearch.allApps() on every open, so user-built apps, hidden-app
 * changes and feature gates are always current. Ordering is registry
 * order on purpose — stable, so it can be used by muscle memory (the
 * same reason ⌘K ranks by frequency, never recency).
 */
const AppSwitcher = {
    _open: false,
    _COLS: 4,

    init() {
        const btn = document.getElementById('titlebar-apps-btn');
        if (!btn) return;

        btn.addEventListener('click', (e) => {
            // Don't let this click reach the document-level outside-close.
            e.stopPropagation();
            this.toggle();
        });

        document.addEventListener('click', (e) => {
            if (!this._open) return;
            const panel = document.getElementById('app-switcher');
            if (panel && !panel.contains(e.target)) this.close();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this._open) this.close(true);
        });
    },

    toggle() {
        if (this._open) this.close();
        else this.show();
    },

    show() {
        const panel = this._ensurePanel();
        this._render(panel);
        panel.hidden = false;
        // Next frame, so the open transition actually runs.
        requestAnimationFrame(() => panel.classList.add('is-open'));
        this._open = true;
        document.getElementById('titlebar-apps-btn')
            ?.setAttribute('aria-expanded', 'true');
        // Focus the current app (or the first tile) so the arrow keys work
        // immediately.
        (panel.querySelector('.app-switcher-tile.is-active')
            || panel.querySelector('.app-switcher-tile'))?.focus();
    },

    close(refocus = false) {
        const panel = document.getElementById('app-switcher');
        if (panel) {
            panel.classList.remove('is-open');
            panel.hidden = true;
        }
        this._open = false;
        const btn = document.getElementById('titlebar-apps-btn');
        btn?.setAttribute('aria-expanded', 'false');
        if (refocus) btn?.focus();
    },

    _ensurePanel() {
        let panel = document.getElementById('app-switcher');
        if (panel) return panel;
        panel = document.createElement('div');
        panel.id = 'app-switcher';
        panel.className = 'app-switcher';
        panel.hidden = true;
        panel.setAttribute('role', 'group');
        panel.setAttribute('aria-label', 'Switch app');
        panel.addEventListener('keydown', (e) => this._onKeydown(e, panel));
        document.body.appendChild(panel);
        return panel;
    },

    _render(panel) {
        const esc = (s) => (typeof UIUtils !== 'undefined'
            ? UIUtils.escapeHtml(s) : String(s));
        const hidden = (typeof AppManager?.getHiddenApps === 'function')
            ? AppManager.getHiddenApps() : new Set();
        const gatedOff = (id) => typeof FEATURES !== 'undefined'
            && FEATURES.isGated(id) && !FEATURES.isEnabled(id);

        // One hidden set for every launcher (the 'hidden-apps' key,
        // curated via the Customize row below): a hidden app leaves this
        // grid and ⌘K's empty-query list alike, but stays findable by
        // typing its name in ⌘K — hiding declutters, it never disables.
        //
        // launcherApps(), not allApps(): a sub-app (Inbox, reached from
        // Email AI) is not a peer of the apps in this grid and does not get
        // a tile. Same bargain as hiding — still there in ⌘K by name.
        const apps = (typeof GlobalSearch !== 'undefined'
            ? GlobalSearch.launcherApps() : [])
            .filter(a => !hidden.has(a.id) && !gatedOff(a.id));

        const current = AppManager.currentApp;
        const isLocked = (id) => typeof AppManager?.isAppLocked === 'function'
            && AppManager.isAppLocked(id) && !AppManager.sensitiveUnlocked;

        // Icon markup is our own registry markup (inline SVGs; user-app
        // tiles may be emoji text) — re-injecting it is safe, same as the
        // Customize-home-apps page does.
        panel.innerHTML = apps.map(a =>
            `<button class="app-switcher-tile${a.id === current ? ' is-active' : ''}" ` +
            `type="button" data-app="${esc(a.id)}"` +
            `${a.id === current ? ' aria-current="page"' : ''}>` +
            `<span class="app-switcher-icon">${a.icon}</span>` +
            `<span class="app-switcher-label">${esc(a.title)}</span>` +
            (isLocked(a.id)
                ? `<span class="app-switcher-lockbadge" aria-label="Locked">` +
                  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
                  `<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></span>`
                : '') +
            `</button>`
        ).join('')
        + `<button class="app-switcher-customize" type="button">Customize&hellip;</button>`;

        panel.querySelectorAll('.app-switcher-tile').forEach(tile => {
            tile.addEventListener('click', () => {
                this.close();
                // openApp handles the App Lock overlay itself when the
                // target is locked.
                AppManager.openApp(tile.dataset.app);
            });
        });

        // The show/hide + favourites list (Settings › Appearance also links
        // here). Its checkboxes write the same 'hidden-apps' set this grid
        // and ⌘K's empty list read.
        panel.querySelector('.app-switcher-customize')?.addEventListener('click', () => {
            this.close();
            AppManager.openAppVisibilityModal('dashboard');
        });
    },

    // Roving arrow-key navigation over the grid; Enter/Space activate via
    // the buttons' native behavior.
    _onKeydown(e, panel) {
        const tiles = Array.from(panel.querySelectorAll('.app-switcher-tile'));
        const i = tiles.indexOf(document.activeElement);
        if (i === -1 || tiles.length === 0) return;
        const cols = this._COLS;
        let next = null;
        if (e.key === 'ArrowRight') next = Math.min(i + 1, tiles.length - 1);
        else if (e.key === 'ArrowLeft') next = Math.max(i - 1, 0);
        else if (e.key === 'ArrowDown') next = Math.min(i + cols, tiles.length - 1);
        else if (e.key === 'ArrowUp') next = Math.max(i - cols, 0);
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = tiles.length - 1;
        if (next === null) return;
        e.preventDefault();
        tiles[next].focus();
    }
};
