/**
 * Storage Manager
 * Interface for storage via Electron (SQLite backend)
 */

const StorageManager = {
    /*
     * Read cache (2026-09-09). `electronStore.get` is a synchronous IPC
     * round trip: main reads the row, JSON-parses it, structured-clones it
     * across the bridge and the renderer deserialises it — about 28 ms for
     * the 7 MB `notes` blob, and home read that blob fourteen times per
     * paint. Each key is fetched once and kept here; a write to the key
     * from ANY path drops it (`set`/`clear` below synchronously, and
     * main's `store-key-changed` broadcast for writes this window did not
     * make — the iCloud merge, a phone change, another window). Reads
     * hand out a structuredClone so callers keep the isolation they always
     * had: mutating what you were given never touches the cache, and a
     * blob mutated in place then abandoned cannot poison the next reader.
     */
    _cache: new Map(),
    _cacheWired: false,

    _wireCache() {
        if (this._cacheWired) return;
        this._cacheWired = true;
        try {
            window.electronStore.onKeyChanged?.((key) => {
                if (key == null) { this._cache.clear(); return; }
                const k = String(key);
                if (k.startsWith('app_')) this._cache.delete(k.slice(4));
            });
        } catch { /* no bridge — every read goes to main, as before */ }
    },

    /** Forget a cached key (or all of them) — the next read hits main. */
    invalidate(appName = null) {
        if (appName == null) this._cache.clear();
        else this._cache.delete(appName);
    },

    /**
     * Get data for a specific app
     * @param {string} appName - Name of the app
     * @returns {object} App data
     */
    get(appName) {
        try {
            this._wireCache();
            if (!this._cache.has(appName)) {
                this._cache.set(appName, window.electronStore.get(`app_${appName}`) || null);
            }
            const v = this._cache.get(appName);
            return v === null ? null : structuredClone(v);
        } catch (error) {
            console.error(`Error reading ${appName} data:`, error);
            return null;
        }
    },

    /**
     * Save data for a specific app
     * @param {string} appName - Name of the app
     * @param {object} data - Data to save
     */
    set(appName, data) {
        try {
            // Dropped rather than replaced with `data`: record-merged keys
            // are unioned with the stored copy on the way in
            // (mergedForWrite), so what lands can differ from what was sent.
            this._cache.delete(appName);
            window.electronStore.set(`app_${appName}`, data);
            this._cache.delete(appName);
            // Notes/Journal → Markdown projection (docs/CONTENT_FILES.md). Hooked
            // here, the one funnel every writer of those blobs passes through.
            if (typeof ContentFiles !== 'undefined') ContentFiles.onKeyWritten(appName);
            return true;
        } catch (error) {
            console.error(`Error saving ${appName} data:`, error);
            return false;
        }
    },

    /**
     * Get all data from all apps
     * @returns {object} All app data
     */
    getAll() {
        const allData = {};
        const store = window.electronStore.getAll();
        for (const key in store) {
            if (key.startsWith('app_')) {
                const appName = key.replace('app_', '');
                allData[appName] = store[key];
            }
        }
        return allData;
    },

    /**
     * Clear data for a specific app
     * @param {string} appName - Name of the app
     */
    clear(appName) {
        try {
            this._cache.delete(appName);
            window.electronStore.delete(`app_${appName}`);
            return true;
        } catch (error) {
            console.error(`Error clearing ${appName} data:`, error);
            return false;
        }
    },

    /**
     * Clear all app data
     */
    clearAll() {
        try {
            this._cache.clear();
            window.electronStore.clear();
            return true;
        } catch (error) {
            console.error('Error clearing all data:', error);
            return false;
        }
    },

    /**
     * Get storage usage information
     * @returns {object} Storage stats
     */
    getStorageInfo() {
        let totalSize = 0;
        const appSizes = {};

        const store = window.electronStore.getAll();
        for (const key in store) {
            if (key.startsWith('app_')) {
                const value = JSON.stringify(store[key]);
                const size = new Blob([value]).size;
                const appName = key.replace('app_', '');
                appSizes[appName] = size;
                totalSize += size;
            }
        }

        return {
            totalSize,
            totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
            appSizes,
            itemCount: Object.keys(appSizes).length
        };
    },

    /**
     * Get storage file path
     * @returns {string}
     */
    getStoragePath() {
        return window.electronStore.getPath();
    }
};
