/**
 * Bookmarks — the package's contribution to the assistant and the shell.
 *
 * Registered from the app's own folder (docs/PLATFORM.md "App packages"):
 * the create_bookmark tool (with its record pill), the words that summon
 * the group, the ⌘K/search_all source, the `bookmark` link type (the
 * prompt's link grammar), the `bookmark` record type (the conversation
 * banner + open door), the link-picker entry (with its "+ New Bookmark"
 * button), and the cross-app API Browse acts through —
 * Anjadhe.expose('bookmarks') — so the browser's star button and
 * blank-state list hold no store of their own. Loads last in the package.
 */

(function registerBookmarksPackage() {
    if (typeof AgentTools === 'undefined' || typeof BookmarksApp === 'undefined') return;

    const SOURCE = 'bookmarks';

    function store() {
        const data = StorageManager.get('bookmarks') || {};
        return {
            data,
            bookmarks: Array.isArray(data.bookmarks) ? data.bookmarks : [],
            groups: Array.isArray(data.groups) ? data.groups : []
        };
    }
    function write(bookmarks, groups, data) {
        StorageManager.set('bookmarks', { ...(data || {}), bookmarks, groups: groups || [] });
        if (typeof AppManager !== 'undefined' && AppManager.updateStats) AppManager.updateStats();
        refresh();
    }
    function refresh() {
        if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'bookmarks') {
            BookmarksApp.loadData();
            BookmarksApp.render?.();
        }
    }
    function newId() {
        return (typeof UIUtils !== 'undefined' && UIUtils.generateId) ? UIUtils.generateId()
            : 'bm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }
    const later = (fn) => setTimeout(fn, 0);

    // One-time fold of the browser's legacy browser-only bookmarks into the
    // shared store (was Browse's _migrateLegacyBookmarks; the store's owner
    // runs it now, on first read).
    let migrated = false;
    function migrateLegacy() {
        if (migrated) return;
        migrated = true;
        const legacy = StorageManager.get('browse_bookmarks') || null;
        if (!legacy || legacy.migrated || !Array.isArray(legacy.items) || legacy.items.length === 0) {
            if (legacy && !legacy.migrated) StorageManager.set('browse_bookmarks', { items: [], migrated: true });
            return;
        }
        const s = store();
        const seen = new Set(s.bookmarks.map(b => b.url));
        let added = 0;
        for (const it of legacy.items) {
            if (!it || !it.url || seen.has(it.url)) continue;
            const ts = it.addedAt ? new Date(it.addedAt).toISOString() : new Date().toISOString();
            s.bookmarks.unshift({ id: newId(), title: it.title || it.url, url: it.url, description: '', group: null,
                notes: '', tags: [], profile: null, createdAt: ts, modifiedAt: ts });
            seen.add(it.url);
            added++;
        }
        if (added) write(s.bookmarks, s.groups, s.data);
        StorageManager.set('browse_bookmarks', { items: [], migrated: true });
    }

    // ── Cross-app API (Anjadhe.use('bookmarks')) — Browse's star + list ──
    if (typeof Anjadhe !== 'undefined') {
        Anjadhe.expose(SOURCE, {
            /** Every bookmark, most recent first (copies). */
            list() {
                migrateLegacy();
                return [...store().bookmarks].sort((a, b) =>
                    new Date(b.createdAt || b.modifiedAt || 0) - new Date(a.createdAt || a.modifiedAt || 0)).map(b => ({ ...b }));
            },
            has(url) { return !!url && store().bookmarks.some(b => b.url === url); },
            /** Add { url, title?, description?, group?, notes?, tags? }; returns the id. */
            add(fields) {
                if (!fields || !fields.url) return null;
                const s = store();
                const now = new Date().toISOString();
                const b = { id: newId(), title: fields.title || fields.url, url: fields.url, description: fields.description || '',
                    group: fields.group ?? null, notes: fields.notes || '', tags: Array.isArray(fields.tags) ? fields.tags : [],
                    favicon: '', createdAt: now, modifiedAt: now };
                s.bookmarks.unshift(b);
                write(s.bookmarks, s.groups, s.data);
                return b.id;
            },
            /** Remove every bookmark with this url; returns how many. */
            removeByUrl(url) {
                const s = store();
                const keep = s.bookmarks.filter(b => b.url !== url);
                const n = s.bookmarks.length - keep.length;
                if (n) write(keep, s.groups, s.data);
                return n;
            },
            openEditor(id, opts) {
                AppManager.openApp('bookmarks', false);
                later(() => BookmarksApp.openEditor?.(id, opts || {}));
            }
        });
    }

    // ── The words that summon the group ────────────────────────────────
    AgentTools.registerDomain(SOURCE, /\bbookmarks?\b|save\s+(this\s+)?(link|url|page)/);

    // ── Tool ───────────────────────────────────────────────────────────
    AgentTools.register({ type: 'function', function: {
        name: 'create_bookmark',
        description: 'Create a bookmark.',
        parameters: { type: 'object', properties: {
            url: { type: 'string' },
            title: { type: 'string', description: 'Auto-fetched if omitted' },
            description: { type: 'string' },
            group: { type: 'string' }
        }, required: ['url'] }
    }}, (args) => {
        const s = store();
        const now = new Date().toISOString();
        const b = { id: newId(), url: args.url, title: args.title || args.url, description: args.description || '',
            group: args.group || 'Uncategorized', favicon: '', createdAt: now };
        s.bookmarks.unshift(b);
        write(s.bookmarks, s.groups, s.data);
        return { success: true, bookmark: { id: b.id, title: b.title, url: b.url } };
    }, { source: SOURCE, group: SOURCE, record: { app: SOURCE, key: 'bookmark', label: 'Bookmark' } });

    // ── Search (⌘K + search_all) ───────────────────────────────────────
    if (typeof GlobalSearch !== 'undefined') {
        GlobalSearch.registerSource(SOURCE, {
            label: 'Bookmark',
            index(push, get) {
                for (const b of get('bookmarks', 'bookmarks')) {
                    push(b.id, b.title, `${b.url || ''} ${b.description || ''}`, { sub: b.url || '', meta: {} });
                }
            },
            open(hit) { AppManager.openApp('bookmarks'); later(() => BookmarksApp.openEditor?.(hit.id)); }
        });
    }

    // ── Link type (model prose) + record type (chat banner / open door) ──
    const exists = (id) => store().bookmarks.some(b => b && String(b.id) === String(id));
    const open = (id) => { AppManager.openApp('bookmarks', false); later(() => BookmarksApp.openEditor?.(id)); };
    if (typeof RecordLinks !== 'undefined') RecordLinks.register('bookmark', { label: 'bookmark', exists, open });
    if (typeof RecordTypes !== 'undefined') {
        // Not @-mentionable and not a decision host (as before); this gives
        // the banner its word and the record its door.
        RecordTypes.register('bookmark', { label: 'Bookmark', plural: 'bookmarks', words: [], app: SOURCE, decisions: false,
            recordKey: (id) => `bookmarks:${id}`, match: /^bookmarks:(.+)$/, open });
    }

    // ── Link picker ────────────────────────────────────────────────────
    if (typeof LinkManager !== 'undefined') {
        LinkManager.registerApp(SOURCE, {
            label: 'Bookmark', plural: 'Bookmarks',
            getItemMeta(id) {
                const b = store().bookmarks.find(x => x.id === id);
                return b ? { title: b.title, url: b.url, group: b.group } : null;
            },
            getAppItems() { return store().bookmarks.map(b => ({ id: b.id, title: b.title, url: b.url, group: b.group })); },
            renderMeta: (item) => [item.url || '', item.group || ''].filter(Boolean).join(' · '),
            open(id) { AppManager.openApp('bookmarks'); if (id) later(() => BookmarksApp.openEditor?.(id)); },
            createLabel: '+ New Bookmark',
            createNew(ctx, origin) {
                BookmarksApp.autoLinkContext = ctx;
                AppManager.openApp('bookmarks');
                later(() => BookmarksApp.openEditor?.(null, { origin }));
            }
        });
    }
})();
