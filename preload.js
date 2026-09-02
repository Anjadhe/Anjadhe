/**
 * Preload script - Exposes storage to the renderer
 * All reads/writes go through synchronous IPC to the SQLite store in main.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const Store = require('electron-store');
const path = require('path');

// Settings store - always in default location to remember custom path
const settingsStore = new Store({
    name: 'anjadhe-app-settings',
    defaults: {
        customStoragePath: null,
        setupComplete: false
    }
});

const storeApi = {
    get: (key) => ipcRenderer.sendSync('store-get-sync', key),
    set: (key, value) => ipcRenderer.sendSync('store-set-sync', key, value),
    delete: (key) => ipcRenderer.sendSync('store-delete-sync', key),
    clear: () => ipcRenderer.sendSync('store-clear-sync'),
    getAll: () => ipcRenderer.sendSync('store-get-all-sync'),
    has: (key) => ipcRenderer.sendSync('store-has-sync', key),
    keysWithPrefix: (prefix) => ipcRenderer.sendSync('store-keys-prefix-sync', prefix),
    getPath: () => ipcRenderer.sendSync('store-get-path-sync')
};

// Expose storage API to renderer
contextBridge.exposeInMainWorld('electronStore', {
    ...storeApi,

    // First-run setup
    isFirstRun: () => !settingsStore.get('setupComplete'),
    markSetupComplete: () => settingsStore.set('setupComplete', true),

    // Storage location management
    getCustomStoragePath: () => settingsStore.get('customStoragePath'),

    setCustomStoragePath: (newPath, migrateData = true) => {
        return ipcRenderer.invoke('set-custom-storage-path', newPath, migrateData);
    },

    // Check if data exists at a path (SQLite db file presence + key list)
    checkDataAtPath: (folderPath) => ipcRenderer.invoke('check-data-at-path', folderPath),

    // Get default storage path
    getDefaultPath: () => {
        const defaultStore = new Store({ name: 'anjadhe-app-data' });
        return path.dirname(defaultStore.path);
    },

    // Folder that holds the data file. Returned without the DB filename —
    // users picked a folder, so showing them a file path is misleading.
    getStorageFolder: () => {
        const custom = settingsStore.get('customStoragePath');
        if (custom) return custom;
        const defaultStore = new Store({ name: 'anjadhe-app-data' });
        return path.dirname(defaultStore.path);
    }
});

// User-built apps (docs/PLATFORM.md): listing, enablement, hot reload, and
// the .errors.log channel coding agents use to self-correct.
contextBridge.exposeInMainWorld('electronApps', {
    list: () => ipcRenderer.invoke('user-apps-list'),
    status: () => ipcRenderer.invoke('user-apps-status'),
    enable: () => ipcRenderer.invoke('user-apps-enable'),
    openFolder: () => ipcRenderer.invoke('user-apps-open-folder'),
    logError: (dirName, message) => ipcRenderer.invoke('user-apps-log-error', dirName, message),
    onChanged: (callback) => ipcRenderer.on('user-apps-changed', (event, dirs) => callback(dirs)),
    // File writes/deletes — cross-Mac source sync (UserAppsSync); contained
    // to one app folder + file allowlist in main.
    writeFile: (dirName, fileName, content) => ipcRenderer.invoke('user-apps-write-file', dirName, fileName, content),
    deleteFolder: (dirName) => ipcRenderer.invoke('user-apps-delete-folder', dirName),
    clearErrors: (dirName) => ipcRenderer.invoke('user-apps-clear-errors', dirName),
    // Sandbox (SECURITY H3): stage the composed guest HTML so the
    // anjadhe-userapp:// scheme can serve it from its own origin.
    stage: (id, html) => ipcRenderer.invoke('userapp-stage', { id, html }),
    unstage: (id) => ipcRenderer.invoke('userapp-unstage', id)
});

// Notes + Journal as Markdown files in ~/Anjadhe/ (docs/CONTENT_FILES.md).
contextBridge.exposeInMainWorld('electronContentFiles', {
    getEnabled: () => ipcRenderer.invoke('content-files-get-enabled'),
    setEnabled: (enabled) => ipcRenderer.invoke('content-files-set-enabled', enabled),
    list: (kind) => ipcRenderer.invoke('content-files-list', kind),
    read: (kind, name) => ipcRenderer.invoke('content-files-read', { kind, name }),
    write: (kind, name, text) => ipcRenderer.invoke('content-files-write', { kind, name, text }),
    rename: (kind, from, to) => ipcRenderer.invoke('content-files-rename', { kind, from, to }),
    remove: (kind, name) => ipcRenderer.invoke('content-files-remove', { kind, name }),
    writeAsset: (kind, name, dataUrl) => ipcRenderer.invoke('content-files-write-asset', { kind, name, dataUrl }),
    readAsset: (kind, name) => ipcRenderer.invoke('content-files-read-asset', { kind, name }),
    reveal: (kind) => ipcRenderer.invoke('content-files-reveal', kind),
    onChanged: (callback) => ipcRenderer.on('content-files-changed', (event, payload) => callback(payload))
});

// Library — the user's original content + local semantic index (docs/LIBRARY.md).
contextBridge.exposeInMainWorld('electronLibrary', {
    status: () => ipcRenderer.invoke('library-status'),
    scan: () => ipcRenderer.invoke('library-scan'),
    list: () => ipcRenderer.invoke('library-list'),
    search: (query, opts) => ipcRenderer.invoke('library-search', { query, ...(opts || {}) }),
    readDoc: (docId, offset, cap) => ipcRenderer.invoke('library-read-doc', { docId, offset, cap }),
    openDoc: (docId) => ipcRenderer.invoke('library-open-doc', { docId }),
    revealDoc: (docId) => ipcRenderer.invoke('library-reveal-doc', { docId }),
    deleteDoc: (docId) => ipcRenderer.invoke('library-delete-doc', { docId }),
    reindex: () => ipcRenderer.invoke('library-reindex'),
    openFolder: () => ipcRenderer.invoke('library-open-folder'),
    // Import = COPY into the folder (V1: the folder is the corpus). No paths
    // → main shows its own file picker.
    importFiles: (collection) => ipcRenderer.invoke('library-import', { collection }),
    importPaths: (paths, collection) => ipcRenderer.invoke('library-import', { paths, collection }),
    createCollection: (name) => ipcRenderer.invoke('library-create-collection', { name }),
    starterVoices: () => ipcRenderer.invoke('library-starter-voices'),
    importStarter: (name) => ipcRenderer.invoke('library-import-starter', { name }),
    // Sandboxed renderers can't read File.path any more; this is the one
    // sanctioned way to turn a dropped File into an absolute path.
    pathForFile: (file) => webUtils.getPathForFile(file),
    pullEmbedModel: () => ipcRenderer.invoke('library-embed-pull'),
    onProgress: (callback) => ipcRenderer.on('library-progress', (event, status) => callback(status)),
    onPullProgress: (callback) => ipcRenderer.on('library-embed-pull-progress', (event, p) => callback(p))
});

// Generic document export (Notes viewer, future in-app documents).
contextBridge.exposeInMainWorld('electronExport', {
    htmlToPdf: (params) => ipcRenderer.invoke('export-html-to-pdf', params)
});

// Apple Reminders import (EventKit helper in main — see apple-reminders IPC)
contextBridge.exposeInMainWorld('electronAppleImport', {
    remindersStatus: () => ipcRenderer.invoke('apple-reminders-status'),
    fetchReminders: () => ipcRenderer.invoke('apple-reminders-fetch'),
    fetchEvents: () => ipcRenderer.invoke('apple-events-fetch'),
    notesMeta: () => ipcRenderer.invoke('apple-notes-meta'),
    notesBodies: (ids) => ipcRenderer.invoke('apple-notes-bodies', { ids })
});

// Expose backup API
contextBridge.exposeInMainWorld('electronBackup', {
    getSettings: () => ipcRenderer.invoke('backup-get-settings'),
    setEnabled: (enabled) => ipcRenderer.invoke('backup-set-enabled', enabled),
    setFrequency: (frequency) => ipcRenderer.invoke('backup-set-frequency', frequency),
    backupNow: () => ipcRenderer.invoke('backup-now'),
    listBackups: () => ipcRenderer.invoke('backup-list'),
    restore: (backupPath) => ipcRenderer.invoke('backup-restore', backupPath)
});

// Expose sync API
contextBridge.exposeInMainWorld('electronSync', {
    getStatus: () => ipcRenderer.invoke('sync-get-status'),
    // Multi-Mac sync opt-in. Enabling seeds the journal and merges peers.
    setEnabled: (enabled) => ipcRenderer.invoke('sync-set-enabled', enabled),
    forceMerge: () => ipcRenderer.invoke('sync-force-merge'),
    forceExport: () => ipcRenderer.invoke('sync-force-export'),
    getLog: () => ipcRenderer.invoke('sync-get-log'),
    onDataUpdated: (callback) => ipcRenderer.on('sync-data-updated', (event, result) => callback(result)),
    onMergeResult: (callback) => ipcRenderer.on('sync-merge-result', (event, result) => callback(result)),
    // Sync-key passphrase protection (H6)
    encryptionStatus: () => ipcRenderer.invoke('sync-encryption-status'),
    setPassphrase: (passphrase) => ipcRenderer.invoke('sync-encryption-set-passphrase', passphrase),
    unlock: (passphrase) => ipcRenderer.invoke('sync-encryption-unlock', passphrase),
    changePassphrase: (newPassphrase) => ipcRenderer.invoke('sync-encryption-change-passphrase', newPassphrase)
});

// Expose the phone<->Mac channel API (device pairing)
contextBridge.exposeInMainWorld('electronChannel', {
    ensure: () => ipcRenderer.invoke('channel-ensure'),
    getInfo: () => ipcRenderer.invoke('channel-get-info'),
    beginPairing: () => ipcRenderer.invoke('channel-begin-pairing'),
    cancelPairing: () => ipcRenderer.invoke('channel-cancel-pairing'),
    listDevices: () => ipcRenderer.invoke('channel-list-devices'),
    removeDevice: (pub) => ipcRenderer.invoke('channel-remove-device', pub),
    onPaired: (callback) => ipcRenderer.on('channel-paired', (event, info) => callback(info))
});

// Phone chat: the paired phone as a remote channel to the assistant. Main
// forwards a chat-send from the encrypted channel via onMessage; the renderer
// (MobileChannel) runs the assistant and answers with sendResult(), which main
// pushes back to the phone as a chat-reply.
contextBridge.exposeInMainWorld('electronMobileChat', {
    onMessage: (callback) => ipcRenderer.on('mobile-chat-message', (event, msg) => callback(msg)),
    sendResult: (res) => ipcRenderer.invoke('mobile-chat-result', res)
});

// Mac-served phone views (mobile restructure lane 2): main forwards a
// view-get from the channel; the renderer (MobileViews) computes the
// read-only digest and answers, main routes it back over the same request.
contextBridge.exposeInMainWorld('electronMobileViews', {
    onRequest: (callback) => ipcRenderer.on('mobile-view-request', (event, msg) => callback(msg)),
    sendResult: (res) => ipcRenderer.invoke('mobile-view-result', res)
});

// Telegram bridge: token/link management for Settings, plus the message
// pipeline — main forwards linked-chat text via onMessage, the renderer
// answers with send() after running the assistant.
contextBridge.exposeInMainWorld('electronTelegram', {
    getStatus: () => ipcRenderer.invoke('telegram-status'),
    setToken: (token) => ipcRenderer.invoke('telegram-set-token', token),
    setEnabled: (on) => ipcRenderer.invoke('telegram-set-enabled', on),
    beginLink: () => ipcRenderer.invoke('telegram-begin-link'),
    cancelLink: () => ipcRenderer.invoke('telegram-cancel-link'),
    unlink: () => ipcRenderer.invoke('telegram-unlink'),
    disconnect: () => ipcRenderer.invoke('telegram-disconnect'),
    send: (text) => ipcRenderer.invoke('telegram-send', text),
    setNotify: (on) => ipcRenderer.invoke('telegram-set-notify', on),
    notify: (title, body, kind) => ipcRenderer.invoke('telegram-notify', title, body, kind),
    typing: () => ipcRenderer.invoke('telegram-typing'),
    onMessage: (callback) => ipcRenderer.on('telegram-message', (event, msg) => callback(msg)),
    onLinked: (callback) => ipcRenderer.on('telegram-linked', (event, info) => callback(info))
});

// iMessage as a notification lane (outbound only — see js/main/imessage-bridge.js).
contextBridge.exposeInMainWorld('electronIMessage', {
    getStatus: () => ipcRenderer.invoke('imessage-status'),
    setNotify: (on) => ipcRenderer.invoke('imessage-set-notify', on),
    setHandle: (handle) => ipcRenderer.invoke('imessage-set-handle', handle),
    sendTest: () => ipcRenderer.invoke('imessage-test'),
    notify: (title, body, kind) => ipcRenderer.invoke('imessage-notify', title, body, kind),
});

// Expose network API for authenticated Yahoo Finance calls
contextBridge.exposeInMainWorld('electronNet', {
    fetchYahooQuoteSummary: (ticker, modules) => ipcRenderer.invoke('yahoo-quote-summary', ticker, modules),
    fetchYahooOptionQuote: (occSymbol) => ipcRenderer.invoke('yahoo-option-quote', occSymbol),
    fetchYahooQuotes: (symbols) => ipcRenderer.invoke('yahoo-quotes', symbols),
    fetchUrlTitle: (url) => ipcRenderer.invoke('fetch-url-title', url)
});

// Network transparency log — read-only view of every outbound request the
// app has made (main-process http/https + renderer fetch). Metadata only.
contextBridge.exposeInMainWorld('electronNetLog', {
    getLogs: () => ipcRenderer.invoke('net-log-get'),
    clear: () => ipcRenderer.invoke('net-log-clear')
});

// Expose dialog functions
contextBridge.exposeInMainWorld('electronDialog', {
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    checkPath: (folderPath) => ipcRenderer.invoke('check-path', folderPath)
});

// Expose menu action listener
contextBridge.exposeInMainWorld('electronMenu', {
    onMenuAction: (callback) => {
        ipcRenderer.on('menu-action', (event, action) => callback(action));
    },
    // Synchronous on purpose: called from inside a beforeunload handler,
    // which cannot await. Tells main what the "Leave anyway?" dialog should
    // say when the renderer cancels the unload.
    setUnloadGuard: (info) => ipcRenderer.sendSync('unload-guard', info)
});

// Multi-window. Opens a fresh BrowserWindow and optionally routes it
// directly at an app (e.g. "notes"). Used by Cmd-click on sidebar items.
contextBridge.exposeInMainWorld('electronWindow', {
    openNew: (appName) => ipcRenderer.invoke('window-open-new', appName)
});

// Remote config (models, flags, version info)
contextBridge.exposeInMainWorld('electronConfig', {
    get: () => ipcRenderer.invoke('remote-config-get')
});

// Auto-updater (electron-updater). The renderer subscribes to `onAvailable`
// / `onProgress` / `onDownloaded` to drive the titlebar update pill. When
// the download is ready, calling `install()` triggers quitAndInstall() in
// the main process. `check()` is a manual trigger available via the
// "Check for Updates…" menu item.
contextBridge.exposeInMainWorld('electronUpdater', {
    check: () => ipcRenderer.invoke('updater-check'),
    install: () => ipcRenderer.invoke('updater-install'),
    getState: () => ipcRenderer.invoke('updater-state'),
    onAvailable: (cb) => ipcRenderer.on('updater:available', (_, info) => cb(info)),
    onProgress: (cb) => ipcRenderer.on('updater:progress', (_, info) => cb(info)),
    onDownloaded: (cb) => ipcRenderer.on('updater:downloaded', (_, info) => cb(info)),
    onManualCheckResult: (cb) => ipcRenderer.on('updater:manual-check-result', (_, result) => cb(result)),
    // A newer release the license gate declined to download
    // ({version, reason: 'updates-ended'|'trial-ended', updatesUntil}).
    onBlocked: (cb) => ipcRenderer.on('updater:blocked', (_, info) => cb(info))
});

// The app license — verified offline in main (js/main/license-store.js).
// The renderer only sees status objects; the key file and the public key
// never cross the bridge. claimAlpha sends the typed email to Connect.
contextBridge.exposeInMainWorld('electronLicense', {
    get: () => ipcRenderer.invoke('license-get'),
    set: (keyText) => ipcRenderer.invoke('license-set', keyText),
    clear: () => ipcRenderer.invoke('license-clear'),
    openFile: () => ipcRenderer.invoke('license-open-file'),
    claimAlpha: (email) => ipcRenderer.invoke('license-claim-alpha', email),
    remoteStatus: () => ipcRenderer.invoke('license-remote-status')
});

// macOS native share sheet (Messages, Mail, AirDrop, Notes, …). `available`
// exists so the renderer can hide/disable the Share button on non-macOS.
contextBridge.exposeInMainWorld('electronShare', {
    available: process.platform === 'darwin',
    share: (sharingItem) => ipcRenderer.invoke('share-menu-show', sharingItem)
});

// llama.cpp engine (llama-server) — the local AI engine. Chat goes through
// electronLLM; these cover engine install and GGUF model management.
contextBridge.exposeInMainWorld('electronLlamaCpp', {
    status: () => ipcRenderer.invoke('llamacpp-status'),
    // {installed, latest, updateAvailable} — compares the on-disk engine
    // build against the one pinned in remote config. install() performs
    // the upgrade (it replaces engine/ in place).
    checkEngineUpdate: () => ipcRenderer.invoke('llamacpp-engine-update-check'),
    install: (onProgress) => {
        const handler = (_, progress) => onProgress && onProgress(progress);
        ipcRenderer.on('llamacpp-install-progress', handler);
        return ipcRenderer.invoke('llamacpp-install').then(result => {
            ipcRenderer.removeListener('llamacpp-install-progress', handler);
            return result;
        }).catch(err => {
            ipcRenderer.removeListener('llamacpp-install-progress', handler);
            throw err;
        });
    },
    pullModel: (modelName, onProgress) => {
        const handler = (_, progress) => onProgress(progress);
        ipcRenderer.on('llamacpp-pull-progress', handler);
        return ipcRenderer.invoke('llamacpp-pull-model', modelName).then(result => {
            ipcRenderer.removeListener('llamacpp-pull-progress', handler);
            return result;
        }).catch(err => {
            ipcRenderer.removeListener('llamacpp-pull-progress', handler);
            throw err;
        });
    },
    listModels: () => ipcRenderer.invoke('llamacpp-list-models'),
    deleteModel: (modelName) => ipcRenderer.invoke('llamacpp-delete-model', modelName),
    // Load the model into llama-server ahead of the first chat (prewarm),
    // and stop the server to free the model's RAM (unload). numCtx (optional)
    // pins the context window for the boot; omitted → the machine-global
    // agentNumCtx setting, then the auto RAM tier.
    start: (modelName, numCtx) => ipcRenderer.invoke('llamacpp-start', { modelName, numCtx }),
    unload: () => ipcRenderer.invoke('llamacpp-unload'),
    // Share the running llama-server on the local network (bind 0.0.0.0 with
    // a persistent key) so other devices can use this Mac's model. Restarts
    // the server when a model is loaded — the caller should warn about that.
    setShare: (enabled) => ipcRenderer.invoke('llamacpp-share-set', enabled)
});

// Live AI-activity feed (the AI Activity page): main emits one event per LLM
// request start/run/end and per engine model load/unload, across ALL callers —
// including ones that never touch the renderer-side LLMLogger.
contextBridge.exposeInMainWorld('electronAIActivity', {
    onEvent: (cb) => {
        const handler = (_, ev) => { try { cb(ev); } catch { /* listener error must not kill IPC */ } };
        ipcRenderer.on('ai-activity', handler);
        return () => ipcRenderer.removeListener('ai-activity', handler);
    }
});

// Expose unified LLM API (routes to the local engine, the user's own server, or a BYOK cloud entry)
contextBridge.exposeInMainWorld('electronLLM', {
    chat: (params) => ipcRenderer.invoke('llm-chat', params),
    chatStream: (params, onChunk) => {
        // Stream ID echoed back on every chunk so concurrent callers can filter
        // out chunks from other streams (IPC channels are global). The caller
        // may supply its own id (so it can later abort the stream); otherwise
        // we generate one.
        const streamId = params.streamId || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const chunkHandler = (_, chunk, msgStreamId) => {
            if (msgStreamId === streamId) onChunk(chunk);
        };
        // Live reasoning trace (model "thinking"), streamed on its own channel
        // so the renderer can show it apart from the answer.
        const thinkingHandler = (_, chunk, msgStreamId) => {
            if (msgStreamId === streamId) onChunk(chunk, 'thinking');
        };
        const thinkingDoneHandler = (_, msgStreamId) => {
            if (msgStreamId === streamId) onChunk(null, 'thinking-done');
        };
        // Tool-call arguments being generated ({name, chars}) — the only
        // signal during an otherwise-silent stretch of the stream.
        const toolProgressHandler = (_, info, msgStreamId) => {
            if (msgStreamId === streamId) onChunk(info, 'tool-progress');
        };
        ipcRenderer.on('llm-stream-chunk', chunkHandler);
        ipcRenderer.on('llm-stream-thinking', thinkingHandler);
        ipcRenderer.on('llm-stream-thinking-done', thinkingDoneHandler);
        ipcRenderer.on('llm-stream-tool-progress', toolProgressHandler);
        const cleanup = () => {
            ipcRenderer.removeListener('llm-stream-chunk', chunkHandler);
            ipcRenderer.removeListener('llm-stream-thinking', thinkingHandler);
            ipcRenderer.removeListener('llm-stream-thinking-done', thinkingDoneHandler);
            ipcRenderer.removeListener('llm-stream-tool-progress', toolProgressHandler);
        };
        return ipcRenderer.invoke('llm-chat-stream', { ...params, streamId }).then(result => {
            cleanup();
            return result;
        }).catch(err => {
            cleanup();
            throw err;
        });
    },
    // Abort an in-flight streaming generation by its streamId (Stop button).
    abortStream: (streamId) => ipcRenderer.invoke('llm-chat-abort', { streamId }),
    getSettings: () => ipcRenderer.invoke('llm-get-settings'),
    // Local-LLM scheduler telemetry: background queue-wait stats.
    schedulerStats: () => ipcRenderer.invoke('llm-scheduler-stats'),
    setProvider: (provider) => ipcRenderer.invoke('llm-set-provider', provider),
    // Cloud brain pointer (default entry is an OpenAI/Anthropic model):
    // which model + key entry provider-routed features should use.
    setCloudBrain: (cfg) => ipcRenderer.invoke('llm-set-cloud-brain', cfg),
    // Custom OpenAI-compatible endpoint (local llama-server / vLLM / LM Studio / remote).
    setCustomConfig: (cfg) => ipcRenderer.invoke('llm-set-custom-config', cfg),
    setCustomKey: (key) => ipcRenderer.invoke('llm-set-custom-key', key),
    // Per-entry server keys (assistant model list) — encrypted in main.
    setEntryKey: (entryId, key) => ipcRenderer.invoke('llm-set-entry-key', { entryId, key }),
    entryKeyStatus: (entryId) => ipcRenderer.invoke('llm-entry-key-status', entryId),
    testCustom: (cfg) => ipcRenderer.invoke('llm-test-custom', cfg),
    detectCustom: () => ipcRenderer.invoke('llm-detect-custom'),
    // Cloud providers (OpenAI / Anthropic, user's own key): live model list
    // + connectivity test. cfg: { engine, apiKey?, entryId?, model? }.
    cloudModels: (cfg) => ipcRenderer.invoke('llm-cloud-models', cfg),
    // Anjadhe Cloud catalog for the Settings picker (keyless; falls back to
    // the single launch model when Connect is old or unreachable).
    anjadheModels: () => ipcRenderer.invoke('anjadhe-llm-models'),
    anjadheVersion: () => ipcRenderer.invoke('anjadhe-version'),
    testCloud: (cfg) => ipcRenderer.invoke('llm-cloud-test', cfg),
    getNumCtx: () => ipcRenderer.invoke('llm-get-num-ctx'),
    setNumCtx: (value) => ipcRenderer.invoke('llm-set-num-ctx', value)
});

// Lightweight host info — total RAM, CPU count, arch, platform — used
// to size local-model context windows automatically.
contextBridge.exposeInMainWorld('electronSystem', {
    getInfo: () => ipcRenderer.invoke('system-get-info')
});

// Assistant permission grants — machine-local (settingsStore, never syncs);
// see docs/COWORK_AGENT.md C1.
contextBridge.exposeInMainWorld('electronPermissions', {
    getGrants: () => ipcRenderer.invoke('agent-permissions-get'),
    setGrants: (grants) => ipcRenderer.invoke('agent-permissions-set', grants),
    appendLog: (entry) => ipcRenderer.invoke('agent-permissions-log-append', entry),
    getLog: () => ipcRenderer.invoke('agent-permissions-log-get'),
    // Scoped fs/shell access (C3): pre-flight check + grant. Enforcement is
    // main-side; these just drive the confirm-dialog UX.
    check: (params) => ipcRenderer.invoke('agent-access-check', params),
    grant: (params) => ipcRenderer.invoke('agent-access-grant', params)
});

// MCP servers — the assistant's external tool servers (docs/COWORK_AGENT.md
// C2). Server processes and their secrets live in main.
contextBridge.exposeInMainWorld('electronMCP', {
    listServers: () => ipcRenderer.invoke('mcp-list-servers'),
    addServer: (params) => ipcRenderer.invoke('mcp-add-server', params),
    removeServer: (name) => ipcRenderer.invoke('mcp-remove-server', name),
    setEnabled: (name, enabled) => ipcRenderer.invoke('mcp-set-enabled', { name, enabled }),
    testServer: (name) => ipcRenderer.invoke('mcp-test-server', name),
    checkRuntime: (binary) => ipcRenderer.invoke('mcp-check-runtime', binary),
    callTool: (server, tool, args) => ipcRenderer.invoke('mcp-call-tool', { server, tool, args }),
    continueOutput: (name) => ipcRenderer.invoke('mcp-continue-output', name)
});

// Assistant fs/shell tools — main enforces path scopes and command
// allowlists (docs/COWORK_AGENT.md C3).
// PDF text extraction for chat attachments — pdf.js runs in the main
// process, fully local. Takes the raw bytes of a user-picked file.
contextBridge.exposeInMainWorld('electronPdf', {
    extractText: (data, name) => ipcRenderer.invoke('agent-pdf-extract', { data, name })
});

contextBridge.exposeInMainWorld('electronAgentFS', {
    list: (p, pattern) => ipcRenderer.invoke('agent-fs-list', { path: p, pattern }),
    read: (p, offset) => ipcRenderer.invoke('agent-fs-read', { path: p, offset }),
    search: (p, query) => ipcRenderer.invoke('agent-fs-search', { path: p, query }),
    write: (p, content) => ipcRenderer.invoke('agent-fs-write', { path: p, content }),
    mkdir: (p) => ipcRenderer.invoke('agent-fs-mkdir', { path: p }),
    trash: (p) => ipcRenderer.invoke('agent-fs-trash', { path: p }),
    move: (from, to) => ipcRenderer.invoke('agent-fs-move', { from, to }),
    reveal: (p) => ipcRenderer.invoke('agent-fs-reveal', { path: p }),
    undo: (u) => ipcRenderer.invoke('agent-fs-undo', u),
    run: (command, cwd, timeoutSec) => ipcRenderer.invoke('agent-run-command', { command, cwd, timeoutSec }),
    runAppleScript: (script) => ipcRenderer.invoke('agent-run-applescript', { script }),
    listShortcuts: () => ipcRenderer.invoke('agent-list-shortcuts'),
    runShortcut: (name) => ipcRenderer.invoke('agent-run-shortcut', { name }),
    processStart: (command, cwd) => ipcRenderer.invoke('agent-process-start', { command, cwd }),
    processStatus: (processId) => ipcRenderer.invoke('agent-process-status', { processId }),
    processStop: (processId) => ipcRenderer.invoke('agent-process-stop', { processId }),
    processList: () => ipcRenderer.invoke('agent-process-list')
});

// Terminal access (C7.3): the CLI bridge — main relays `anjadhe` CLI
// requests here; the renderer runs them on the real agent and streams
// events back.
contextBridge.exposeInMainWorld('electronCLI', {
    setEnabled: (enabled) => ipcRenderer.invoke('cli-set-enabled', enabled),
    status: () => ipcRenderer.invoke('cli-status'),
    installCommand: () => ipcRenderer.invoke('cli-install-command'),
    uninstallCommand: () => ipcRenderer.invoke('cli-uninstall-command'),
    onRequest: (cb) => ipcRenderer.on('cli-request', (e, payload) => cb(payload)),
    onAnswer: (cb) => ipcRenderer.on('cli-answer', (e, payload) => cb(payload)),
    emit: (requestId, event) => ipcRenderer.send('cli-event', { requestId, event })
});

// Web search — agent-only capability; the renderer never calls the provider
// directly so the API key stays in the main process.
contextBridge.exposeInMainWorld('electronSearch', {
    query: (query, maxResults) => ipcRenderer.invoke('web-search', { query, maxResults }),
    read: (url, find) => ipcRenderer.invoke('read-url', { url, find }),
    getStatus: () => ipcRenderer.invoke('search-get-status'),
    setEnabled: (enabled) => ipcRenderer.invoke('search-set-enabled', enabled),
    setProvider: (provider) => ipcRenderer.invoke('search-set-provider', provider),
    setApiKey: (provider, key) => ipcRenderer.invoke('search-set-api-key', { provider, key }),
    setConcurrency: (provider, concurrency) => ipcRenderer.invoke('search-set-concurrency', { provider, concurrency }),
    // 1-result live query against ONE provider's stored key (Settings Test).
    test: (provider) => ipcRenderer.invoke('search-test', provider),
    // Anjadhe Connect plan + usage; provision=true mints this machine's key.
    connectUsage: (provision) => ipcRenderer.invoke('search-connect-usage', { provision }),
    // News headlines (docs/DISCOVER.md D1) — routed by provider choice in
    // main (Connect relay vs direct RSS). The channel keeps its
    // `discover-` name; only the UI it fed was removed.
    news: (topics) => ipcRenderer.invoke('discover-news', { topics })
});

// Expose Email API (Gmail OAuth + Sync)
contextBridge.exposeInMainWorld('electronEmail', {
    startOAuth: () => ipcRenderer.invoke('email-start-oauth'),
    fetchEmails: (email, options) => ipcRenderer.invoke('email-fetch-emails', email, options),
    fetchHistory: (email, startHistoryId) => ipcRenderer.invoke('email-fetch-history', email, startHistoryId),
    fetchMessagesByIds: (email, messageIds) => ipcRenderer.invoke('email-fetch-messages-by-ids', email, messageIds),
    getProfile: (email) => ipcRenderer.invoke('email-get-profile', email),
    revokeOAuth: (email) => ipcRenderer.invoke('email-revoke-oauth', email),
    markRead: (email, messageId) => ipcRenderer.invoke('email-mark-read', email, messageId),
    modifyLabels: (email, messageId, addLabelIds, removeLabelIds) => ipcRenderer.invoke('email-modify-labels', email, messageId, addLabelIds, removeLabelIds),
    trash: (email, messageId) => ipcRenderer.invoke('email-trash', email, messageId),
    sendEmail: (email, params) => ipcRenderer.invoke('email-send', email, params),
    createDraft: (email, params) => ipcRenderer.invoke('email-create-draft', email, params),
    updateDraft: (email, draftId, params) => ipcRenderer.invoke('email-update-draft', email, draftId, params),
    deleteDraft: (email, draftId) => ipcRenderer.invoke('email-delete-draft', email, draftId),
    listDrafts: (email) => ipcRenderer.invoke('email-list-drafts', email),
    getDraft: (email, draftId) => ipcRenderer.invoke('email-get-draft', email, draftId),
    getAttachment: (email, messageId, attachmentId) => ipcRenderer.invoke('email-get-attachment', email, messageId, attachmentId),
    // The assistant's read_email_attachment: fetch + extract entirely in
    // main, so bytes never cross the bridge and scanned PDFs can reach the
    // disk-based OCR helper.
    readAttachmentText: (params) => ipcRenderer.invoke('agent-email-attachment-text', params),
    getAttachmentsMeta: (email, messageId) => ipcRenderer.invoke('email-get-attachments-meta', email, messageId),
    saveAttachment: (email, messageId, attachmentId, filename) => ipcRenderer.invoke('email-save-attachment', email, messageId, attachmentId, filename),
    pickAttachments: () => ipcRenderer.invoke('email-pick-attachments'),
    sanitizeHtml: (html) => ipcRenderer.sendSync('email-sanitize-html-sync', html),
    openExternal: (url) => ipcRenderer.invoke('email-open-external', url),
    onPowerState: (callback) => ipcRenderer.on('power-state', (_, state) => callback(state)),
    // macOS memory-pressure level (2 = warn, 4 = critical) — main fires this so
    // the agent can free the local model when the Mac is low on RAM.
    onMemoryPressure: (callback) => ipcRenderer.on('memory-pressure', (_, level) => callback(level))
});

// Local email DB — per-message rows (not the kv blob)
contextBridge.exposeInMainWorld('electronEmailDb', {
    listByAccounts: (accounts) => ipcRenderer.invoke('emails-list-by-accounts', accounts),
    get: (messageId) => ipcRenderer.invoke('emails-get', messageId),
    getBody: (messageId) => ipcRenderer.invoke('emails-get-body', messageId),
    searchBodies: (accounts, needles) => ipcRenderer.invoke('emails-search-bodies', accounts, needles),
    upsertBatch: (emails) => ipcRenderer.invoke('emails-upsert-batch', emails),
    update: (messageId, patch) => ipcRenderer.invoke('emails-update', messageId, patch),
    delete: (messageId) => ipcRenderer.invoke('emails-delete', messageId),
    deleteByAccount: (account) => ipcRenderer.invoke('emails-delete-by-account', account),
    countByAccount: (account) => ipcRenderer.invoke('emails-count-by-account', account),
    countUnreadInbox: (accounts) => ipcRenderer.invoke('emails-count-unread-inbox', accounts),
    countByFromTerms: (accounts, terms) => ipcRenderer.invoke('emails-count-by-from-terms', accounts, terms),
    dbSize: () => ipcRenderer.invoke('emails-db-size'),
    // Per-message AI verdicts (insights + analyzed-nothing-to-show tombstones)
    listAnalyses: () => ipcRenderer.invoke('email-analyses-list'),
    putAnalyses: (entries) => ipcRenderer.invoke('email-analyses-put', entries),
    deleteAnalyses: (messageIds) => ipcRenderer.invoke('email-analyses-delete', messageIds)
});

// Expose unified Accounts API — single OAuth grant for all Google services
contextBridge.exposeInMainWorld('electronAccounts', {
    googleOAuth: () => ipcRenderer.invoke('account-google-oauth'),
    revokeGoogle: (email) => ipcRenderer.invoke('account-google-revoke', email),
    // Per-Mac token presence: { email: { mail: bool, calendar: bool } }.
    // Sync — AccountsManager needs it while wiring apps up at startup.
    tokenStatus: (emails) => ipcRenderer.sendSync('account-token-status-sync', emails)
});

// Expose Calendar API (Google Calendar OAuth + CRUD)
contextBridge.exposeInMainWorld('electronCalendar', {
    startOAuth: () => ipcRenderer.invoke('calendar-start-oauth'),
    revokeOAuth: (email) => ipcRenderer.invoke('calendar-revoke-oauth', email),
    listCalendars: (email) => ipcRenderer.invoke('calendar-list-calendars', email),
    syncEvents: (email, options) => ipcRenderer.invoke('calendar-sync-events', email, options),
    getEvent: (email, calendarId, eventId) => ipcRenderer.invoke('calendar-get-event', email, calendarId, eventId),
    createEvent: (email, calendarId, eventData) => ipcRenderer.invoke('calendar-create-event', email, calendarId, eventData),
    updateEvent: (email, calendarId, eventId, eventData) => ipcRenderer.invoke('calendar-update-event', email, calendarId, eventId, eventData),
    deleteEvent: (email, calendarId, eventId) => ipcRenderer.invoke('calendar-delete-event', email, calendarId, eventId)
});

// Browse sub-app — events from the hardened webview session in main.
// Includes drive-by download notifications and the privacy/anti-tracking
// channels that feed the toolbar shield UI.
contextBridge.exposeInMainWorld('electronBrowse', {
    onDownloadBlocked: (callback) => {
        ipcRenderer.on('browse-download-blocked', (_e, info) => callback(info));
    },
    // Wipes cookies, cache, storage, service workers, auth + DNS caches
    // for the persist:browse session. Returns { ok, error? }.
    clearData: () => ipcRenderer.invoke('browse-clear-data'),
    // Wipes the ephemeral private partition. Renderer calls this when the
    // last private tab closes so the session state vanishes immediately.
    clearPrivate: () => ipcRenderer.invoke('browse-clear-private'),

    // Per-block stream from main's webRequest filter. Payload:
    //   { webContentsId, topUrl, blockedHost }
    // Renderer matches webContentsId to its tab to update the badge.
    onPrivacyBlocked: (callback) => {
        ipcRenderer.on('browse-privacy-blocked', (_e, info) => callback(info));
    },
    // Returns { ok, blocklist: { blockedHosts, exceptionHosts, fetchedAt,
    // sourcesLoaded }, allowlistSize, disabledHosts }.
    getPrivacyStats: () => ipcRenderer.invoke('browse-privacy-stats'),
    // Flip per-site protection. `protect: true` re-enables blocking for
    // that site; `false` adds it to the allowlist (blocking off).
    setSiteProtection: (host, protect) =>
        ipcRenderer.invoke('browse-privacy-set-site', { host, protect }),
    // Resolve a URL to its canonical eTLD+1 site-key + current protect
    // state. Used by the shield popover on tab change.
    resolveSiteKey: (url) =>
        ipcRenderer.invoke('browse-privacy-site-key', url),
    // Open a URL in the user's default browser. Used by the WAF-block
    // banner; main validates the scheme is http(s).
    openExternal: (url) => ipcRenderer.invoke('browse-open-external', url),

    // target="_blank" / window.open from a page. Main denies the native
    // popup and forwards { url, openerWebContentsId } so the owning
    // window opens it as a new in-app tab.
    onOpenTab: (callback) => {
        ipcRenderer.on('browse-open-tab', (_e, info) => callback(info));
    },

    // Sanitize reader-mode HTML in main via DOMPurify + JSDOM. The renderer
    // never trusts its own DOMParser walker for foreign hostile HTML — the
    // sanitized result is what gets innerHTML'd into the reader pane.
    sanitizeReaderHtml: (html, baseUrl) =>
        ipcRenderer.invoke('browse-sanitize-reader-html', { html, baseUrl })
});

// Expose Touch ID authentication API
contextBridge.exposeInMainWorld('electronAuth', {
    canPromptTouchID: () => ipcRenderer.invoke('auth-can-prompt-touch-id'),
    promptTouchID: () => ipcRenderer.invoke('auth-prompt-touch-id'),
    onLockScreen: (callback) => {
        ipcRenderer.on('app-lock', () => callback());
    },
    getAuthEnabled: () => ipcRenderer.invoke('settings-get-auth-enabled'),
    setAuthEnabled: (enabled) => ipcRenderer.invoke('settings-set-auth-enabled', enabled),
    getAutoLockTimeout: () => ipcRenderer.invoke('settings-get-auto-lock-timeout'),
    setAutoLockTimeout: (minutes) => ipcRenderer.invoke('settings-set-auto-lock-timeout', minutes),
    toggleDevTools: () => ipcRenderer.invoke('toggle-dev-tools'),
    isDevToolsOpen: () => ipcRenderer.invoke('is-dev-tools-open'),
    openExternal: (url) => ipcRenderer.invoke('open-external', url)
});
