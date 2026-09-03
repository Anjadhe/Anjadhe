/**
 * Bundled app packages — the first-party tier of "an app is a folder"
 * (docs/PLATFORM.md "App packages: one container, two trust tiers").
 *
 * A bundled app lives in js/apps/<id>/ with a manifest.json and is listed in
 * js/apps/bundled.json. At startup, BEFORE user apps mount and before the
 * nav first paints, this loader does for each package what index.html used
 * to do by hand: injects its stylesheets, appends its view fragment to
 * #app-views, adds its registry tile (creating the group section when the
 * package is the first in its group), names it for the breadcrumb, seeds
 * its default-hidden state, then loads its scripts in order. The scripts
 * register the app themselves (AppManager.register, AgentTools.register,
 * GlobalSearch.registerSource, AgentContext.register — the same seams a user
 * app uses through the SDK).
 *
 * Bundled packages run IN-PROCESS with the full vocabulary: they are
 * first-party code shipped in the DMG, the trust boundary is the same as
 * index.html's own script tags. The sandbox is for code the user did not
 * ship (user-app-sandbox.js).
 *
 * A package that fails to load is logged and skipped — the app is simply
 * not there, which is the state the packaging exists to make possible.
 * Nothing else in the shell should reference a bundled app by name for
 * identity, loading or assistant policy; if it does, that is the next
 * thing to move into the package.
 *
 * Load order caveats a package author must know:
 *  - scripts run after DOMContentLoaded and after every core module, so a
 *    package may register into the agent stack (permission tables, search)
 *    at load — unlike a script tag in index.html's app section, which runs
 *    before js/agent/.
 *  - FEATURES.applyToDocument has already run; a package that wants a
 *    feature gate sets data-feature on its own tile (`feature` field) and
 *    this loader re-applies gating for that tile.
 */

const BundledApps = {
    INDEX: 'js/apps/bundled.json',
    // Synced key (app_bundled-apps): { uninstalled: [id] }. Like
    // hidden-apps it is a preference and follows the user across Macs; the
    // app's DATA is never in it, so an uninstall on one Mac and an install
    // on another both find the same records waiting.
    KEY: 'bundled-apps',
    _index: [],    // every package id in bundled.json, installed or not
    _loaded: [],   // manifests in load order (installed packages only)
    _catalog: null, // id -> manifest for every indexed package (lazy)

    async load() {
        let ids;
        try {
            const res = await fetch(this.INDEX);
            ids = await res.json();
        } catch (e) {
            console.warn('[apps] no bundled package index:', e);
            return [];
        }
        if (!Array.isArray(ids)) return [];
        this._index = ids.map(String);
        const off = this.uninstalledIds();
        for (const id of this._index) {
            if (off.has(id)) continue;   // uninstalled: the folder is simply not there
            try {
                await this._loadOne(id);
            } catch (e) {
                console.error(`[apps] bundled package "${id}" failed to load — skipped:`, e);
            }
        }
        return this._loaded;
    },

    /* ------------------------------------------------------------------
     * Install / uninstall (2026-08-30). "Uninstalled" means NOT LOADED:
     * no scripts, no view, no registry tile, no tools, widget or search
     * source — every seam the package registered through is empty, and
     * Anjadhe.use(name) returns null to whoever depended on it. Data stays
     * on disk. The set is read once at load, so a flip takes effect on the
     * next reload (the FEATURES precedent: registries are built at load
     * time and a half-applied live flip is worse than a reload).
     * ---------------------------------------------------------------- */
    uninstalledIds() {
        try {
            const d = StorageManager.get(this.KEY);
            return new Set(Array.isArray(d?.uninstalled) ? d.uninstalled : []);
        } catch (e) { return new Set(); }
    },

    isPackage(id) { return this._index.includes(id); },

    isInstalled(id) { return this.isPackage(id) && !this.uninstalledIds().has(id); },

    setInstalled(id, on) {
        if (!this.isPackage(id)) return false;
        const d = StorageManager.get(this.KEY) || {};
        const set = new Set(Array.isArray(d.uninstalled) ? d.uninstalled : []);
        if (on) set.delete(id); else set.add(id);
        StorageManager.set(this.KEY, { ...d, uninstalled: Array.from(set) });
        // Installing is a request to SEE the app: clear a stale hide so it
        // appears in the nav after the reload rather than needing a
        // second switch on the same page.
        if (on && typeof AppManager !== 'undefined' && AppManager.getHiddenApps) {
            const hidden = AppManager.getHiddenApps();
            if (hidden.delete(id)) AppManager.setHiddenApps(hidden);
        }
        return true;
    },

    /**
     * Every indexed package's manifest, installed or not — what the More
     * apps page needs to offer an Install button for an app that has no
     * registry tile. Uninstalled manifests are fetched once and cached.
     */
    async catalog() {
        if (this._catalog) return this._catalog;
        const map = new Map();
        for (const m of this._loaded) map.set(m.id, m);
        for (const id of this._index) {
            if (map.has(id)) continue;
            try {
                const raw = await (await fetch(`js/apps/${id}/manifest.json`)).json();
                const check = AppManifest.validate(raw, { bundled: true });
                if (check.ok) map.set(id, check.manifest);
            } catch (e) {
                console.warn(`[apps] package "${id}" manifest unreadable:`, e);
            }
        }
        this._catalog = map;
        return map;
    },

    async _loadOne(id) {
        if (!/^[a-z][a-z0-9-]{1,40}$/.test(id)) throw new Error('bad package id');
        const base = `js/apps/${id}/`;
        const raw = await (await fetch(base + 'manifest.json')).json();
        const check = AppManifest.validate(raw, { bundled: true });
        if (!check.ok) throw new Error('invalid manifest: ' + check.errors.join('; '));
        const manifest = check.manifest;
        if (manifest.id !== id) throw new Error(`manifest id "${manifest.id}" does not match folder "${id}"`);
        for (const appId of [id, ...(manifest.extraApps || []).map(a => a.id)]) {
            if (document.getElementById(`${appId}-view`) || (typeof AppManager !== 'undefined' && AppManager.apps[appId])) {
                throw new Error(`id "${appId}" collides with an existing app`);
            }
        }

        for (const file of manifest.styles) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = base + file;
            link.dataset.bundledApp = id;
            document.head.appendChild(link);
        }

        if (manifest.view) {
            const html = await (await fetch(base + manifest.view)).text();
            const tpl = document.createElement('template');
            tpl.innerHTML = html;
            const host = document.getElementById('app-views');
            if (!host) throw new Error('#app-views missing');
            host.appendChild(tpl.content);
            if (!document.getElementById(`${id}-view`)) {
                throw new Error(`${manifest.view} must contain <div id="${id}-view" class="view app-view">`);
            }
        }

        this._addTile(manifest);
        // Extra apps (a second tile + label from one package; no bundled
        // package uses it since Writing Voices became a setting,
        // 2026-09-02). Their scripts and styles ride the package's lists.
        for (const extra of (manifest.extraApps || [])) {
            this._addTile({
                id: extra.id, name: extra.name, icon: extra.icon,
                group: extra.group || manifest.group,
                description: extra.description, subappOf: extra.subappOf,
                feature: manifest.feature
            });
            if (typeof Breadcrumb !== 'undefined' && Breadcrumb.appLabels && !Breadcrumb.appLabels[extra.id]) {
                Breadcrumb.appLabels[extra.id] = extra.name;
            }
        }

        if (typeof Breadcrumb !== 'undefined' && Breadcrumb.appLabels && !Breadcrumb.appLabels[id]) {
            Breadcrumb.appLabels[id] = manifest.name;
        }
        if (manifest.hiddenByDefault && typeof AppManager !== 'undefined'
            && Array.isArray(AppManager.DEFAULT_HIDDEN_APPS) && !AppManager.DEFAULT_HIDDEN_APPS.includes(id)) {
            AppManager.DEFAULT_HIDDEN_APPS.push(id);
        }

        for (const file of manifest.scripts) {
            await this._script(base + file);
        }
        // An app whose state must be live before its view is ever opened
        // (a timer running across a reload) asks for init at load.
        if (manifest.eager && typeof AppManager !== 'undefined' && typeof AppManager.apps[id]?.init === 'function') {
            try { AppManager.apps[id].init(); } catch (e) { console.error(`[apps] ${id} init failed:`, e); }
        }
        this._loaded.push(manifest);
        return manifest;
    },

    /**
     * Registry tile — the same markup index.html carries for the other
     * built-ins, so GlobalSearch.allApps / applyHiddenApps / SideNav /
     * the More apps page all see it without knowing it came from a package.
     */
    _addTile(manifest) {
        // Tiles must sit inside .dash-apps-section — that is what
        // GlobalSearch.allApps (and through it SideNav, ⌘K, the switcher
        // and More apps) selects, not #app-registry itself.
        const registry = document.querySelector('#app-registry .dash-apps-section')
            || document.getElementById('app-registry');
        if (!registry) return;
        const userGroup = document.getElementById('dash-user-apps-group');
        const label = manifest.group || 'Apps';
        let group = null;
        for (const g of registry.querySelectorAll('.dash-apps-group')) {
            const h = g.querySelector('.dash-apps-group-label');
            if (h && h.textContent.trim() === label) { group = g; break; }
        }
        if (!group) {
            group = document.createElement('div');
            group.className = 'dash-apps-group';
            group.dataset.bundledGroup = label;
            const h = document.createElement('h3');
            h.className = 'dash-apps-group-label';
            h.textContent = label;
            const row = document.createElement('div');
            row.className = 'dash-apps-row';
            group.append(h, row);
            // Before "Your Apps" (and the system entries after it), so a
            // package group sits with the other built-in groups.
            if (userGroup && userGroup.parentElement) userGroup.parentElement.insertBefore(group, userGroup);
            else registry.appendChild(group);
        }
        const row = group.querySelector('.dash-apps-row') || group;
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'dash-app-tile';
        tile.dataset.app = manifest.id;
        if (manifest.description) tile.dataset.desc = manifest.description;
        if (manifest.feature) tile.dataset.feature = manifest.feature;
        if (manifest.subappOf) tile.dataset.subappOf = manifest.subappOf;
        const icon = document.createElement('span');
        icon.className = 'dash-app-tile-icon';
        icon.innerHTML = manifest.icon;   // first-party markup (SVG or entity)
        const text = document.createElement('span');
        text.className = 'dash-app-tile-label';
        text.textContent = manifest.name;
        tile.append(icon, text);
        row.appendChild(tile);
        if (manifest.feature && typeof FEATURES !== 'undefined' && FEATURES.applyToDocument) {
            FEATURES.applyToDocument();
        }
    },

    _script(src) {
        return new Promise((resolve, reject) => {
            const el = document.createElement('script');
            el.src = src;
            el.async = false;
            el.onload = () => resolve();
            el.onerror = () => reject(new Error(`failed to load ${src}`));
            document.body.appendChild(el);
        });
    }
};
