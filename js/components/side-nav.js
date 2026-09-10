/**
 * SideNav — the global left rail (2026-08-07).
 *
 * One always-visible list of every app, beside the content rather than
 * behind a button. It answers "where are my apps?" without a click, which
 * neither ⌘K (type first) nor the titlebar switcher (open first) does.
 *
 * ITS LIST IS THE APP SWITCHER'S LIST. Both read
 * GlobalSearch.launcherApps() and apply the same two filters — the synced
 * `hidden-apps` set and feature gating — so the rail, the switcher popover
 * and ⌘K's empty-query list can never disagree about what "your apps"
 * means, and adding an app to the registry in index.html still adds it
 * everywhere. Sub-apps (Inbox) stay out for the same reason they stay out
 * of the switcher: they have one door, inside their parent.
 *
 * Ordering is registry order, grouped under the registry's own group
 * labels — stable, so the rail can be used by muscle memory. Deliberately
 * NOT frequency-ranked: a list that reshuffles as you use it cannot be
 * aimed at, which is the same call ⌘K's empty list documents in reverse
 * (it ranks, because it is already a typing surface).
 *
 * Collapsed state is per-Mac (localStorage) like the theme and the ⌘K
 * usage counts: how much furniture a 13" screen can spare is a property of
 * the machine, not of the user's data.
 */
const SideNav = {
    _KEY: 'side-nav-collapsed',
    _wired: false,

    init() {
        const nav = document.getElementById('app-sidenav');
        if (!nav) return;

        if (localStorage.getItem(this._KEY) === '1') {
            document.body.classList.add('sidenav-collapsed');
        }
        this._paintCollapseBtn();

        if (!this._wired) {
            this._wired = true;
            // The footer is static markup (index.html) precisely so these
            // two bindings survive the list above being rewritten.
            document.getElementById('sidenav-customize')?.addEventListener('click', () => {
                AppManager.openAppVisibilityModal('dashboard');
            });
            document.getElementById('sidenav-collapse')?.addEventListener('click', () => {
                this.toggleCollapsed();
            });
            document.getElementById('sidenav-list')
                ?.addEventListener('keydown', (e) => this._onKeydown(e));
        }

        this.render();
    },

    // ── Collapse ──

    isCollapsed() {
        return document.body.classList.contains('sidenav-collapsed');
    },

    toggleCollapsed() {
        const next = !this.isCollapsed();
        document.body.classList.toggle('sidenav-collapsed', next);
        localStorage.setItem(this._KEY, next ? '1' : '0');
        this._paintCollapseBtn();
        // Titles carry the labels once the words are gone.
        this.render();
    },

    _paintCollapseBtn() {
        const btn = document.getElementById('sidenav-collapse');
        if (!btn) return;
        const collapsed = this.isCollapsed();
        btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
        btn.setAttribute('aria-label', btn.title);
        const label = btn.querySelector('.sidenav-label');
        if (label) label.textContent = 'Collapse';
    },

    // ── Render ──

    /**
     * Rebuild the list. Cheap and idempotent — call it whenever the set of
     * apps or their state changes (hidden-apps edits, lock/unlock, a user
     * app mounting). AppManager does exactly that from applyHiddenApps,
     * renderLockedApps and _loadUserApps.
     */
    render() {
        const list = document.getElementById('sidenav-list');
        if (!list) return;

        const esc = (s) => (typeof UIUtils !== 'undefined'
            ? UIUtils.escapeHtml(s) : String(s));
        const hidden = (typeof AppManager?.getHiddenApps === 'function')
            ? AppManager.getHiddenApps() : new Set();
        const gatedOff = (id) => typeof FEATURES !== 'undefined'
            && FEATURES.isGated(id) && !FEATURES.isEnabled(id);
        const isLocked = (id) => typeof AppManager?.isAppLocked === 'function'
            && AppManager.isAppLocked(id) && !AppManager.sensitiveUnlocked;

        const apps = (typeof GlobalSearch !== 'undefined'
            ? GlobalSearch.launcherApps() : [])
            .filter(a => !hidden.has(a.id) && !gatedOff(a.id));

        const current = AppManager?.currentApp || null;
        const collapsed = this.isCollapsed();

        // Home is a destination like any other and belongs in the same
        // column — the wordmark is a logo first, and a logo is not where
        // everyone looks for a way home (same reasoning that made the
        // titlebar's left slot a real Back button).
        const rows = [
            `<button class="sidenav-item${!current ? ' is-active' : ''}" type="button" ` +
            `data-app="home" title="Home"${!current ? ' aria-current="page"' : ''}>` +
            `<span class="sidenav-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5"/></svg></span>` +
            `<span class="sidenav-label">Home</span></button>`,
        ];

        // Group labels are the registry's own ("Do", "Stay on top", …).
        // Collapsed they become a plain hairline — the words would not fit,
        // but the grouping is still the thing that makes a 15-item column
        // scannable.
        let lastGroup = null;
        for (const a of apps) {
            if (a.group !== lastGroup) {
                lastGroup = a.group;
                rows.push(collapsed || !a.group
                    ? `<div class="sidenav-rule" role="presentation"></div>`
                    : `<div class="sidenav-group">${esc(a.group)}</div>`);
            }
            const active = a.id === current;
            rows.push(
                `<button class="sidenav-item${active ? ' is-active' : ''}" type="button" ` +
                `data-app="${esc(a.id)}" title="${esc(a.title)}"` +
                `${active ? ' aria-current="page"' : ''}>` +
                // Registry markup (inline SVG, or emoji text on user-app
                // tiles) — our own HTML, re-injected the same way the
                // switcher and the Customize page do.
                `<span class="sidenav-icon">${a.icon}</span>` +
                `<span class="sidenav-label">${esc(a.title)}</span>` +
                (isLocked(a.id)
                    ? `<span class="sidenav-lock" aria-label="Locked">` +
                      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
                      `<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></span>`
                    : '') +
                `</button>`
            );
        }

        list.innerHTML = rows.join('');

        list.querySelectorAll('.sidenav-item').forEach(item => {
            item.addEventListener('click', () => {
                const app = item.dataset.app;
                if (app === 'home') { AppManager.showDashboard(); return; }
                // openApp puts up the unlock overlay itself for a locked app.
                AppManager.openApp(app);
            });
        });
    },

    /**
     * Mark where we are. Called from AppManager.updateSidebarActive — the
     * one place that already knows, and which every openApp/showDashboard
     * passes through, so the rail cannot drift from the view on screen.
     */
    setActive(appName) {
        const list = document.getElementById('sidenav-list');
        if (!list) return;
        const id = (!appName || appName === 'home') ? 'home' : appName;
        list.querySelectorAll('.sidenav-item').forEach(item => {
            const on = item.dataset.app === id;
            item.classList.toggle('is-active', on);
            if (on) item.setAttribute('aria-current', 'page');
            else item.removeAttribute('aria-current');
        });
    },

    // Roving arrow keys down the column; Enter/Space activate natively.
    _onKeydown(e) {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp'
            && e.key !== 'Home' && e.key !== 'End') return;
        const items = Array.from(
            document.querySelectorAll('#sidenav-list .sidenav-item'));
        const i = items.indexOf(document.activeElement);
        if (i === -1 || !items.length) return;
        let next = i;
        if (e.key === 'ArrowDown') next = Math.min(i + 1, items.length - 1);
        else if (e.key === 'ArrowUp') next = Math.max(i - 1, 0);
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = items.length - 1;
        e.preventDefault();
        items[next].focus();
    },
};
