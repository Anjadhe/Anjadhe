/**
 * Write ledger + undo (docs/COWORK_AGENT.md C8.4).
 *
 * Findings 21/22/25/34/36 were one failure: truth about "what did the agent
 * change" derived from prose. This module is the structural fix — ONE
 * recorder that every mutating tool result passes through, appending
 * {at, tool, target, ...} to a per-turn (chat) or per-task scope. The record
 * pills under an answer are a VIEW of this ledger, not a parallel
 * derivation, and undo is replaying the ledger's pre-images backwards.
 *
 * Pre-image capture is generic, not per-tool: while a write tool executes
 * (the captureToolRun window), a hook on StorageManager.set snapshots each
 * app-data key's prior value (deep-copied via JSON — the app mutates live
 * objects in place) the first time this scope touches it. File writes get
 * their pre-image in MAIN (agent-fs-* handlers copy the target aside before
 * overwriting — the `fsUndo` handle in their results). External actions
 * (email sends, calendar, MCP, shell) cannot be taken back and the ledger
 * says so plainly.
 *
 * Scopes are addressable (a chat turn and a task run can overlap without
 * stealing each other's entries) and self-persist on every recorded entry —
 * no code path has to remember to close one; a crash loses nothing.
 *
 * Storage: `agent-write-ledger`, machine-local (SYNC_EXCLUDE — pre-images
 * can be large and undo is a local affair; file pre-images live in this
 * Mac's userData/agent-undo). Honest limits everywhere: undo covers what
 * the ledger holds, skips keys the user has since changed (conflict =
 * current value no longer matches the recorded after-image), and never
 * claims to reverse the irreversible.
 */
const WriteLedger = {
    STORE_KEY: 'agent-write-ledger',
    MAX_SCOPES: 20,
    MAX_PREIMAGE_CHARS_PER_SCOPE: 2 * 1024 * 1024,

    // Actions that leave the machine or drive other software — nothing we
    // could restore. name.startsWith('mcp_') is handled in code.
    EXTERNAL_TOOLS: new Set([
        'send_email', 'trash_email', 'mark_email_read', 'mark_email_unread',
        'create_calendar_event', 'update_calendar_event',
        'run_command', 'run_applescript', 'run_shortcut',
        'process_start', 'process_stop',
        'create_routine', 'update_routine'
    ]),

    // tool → [app, wrapper key in the tool result] — how a written record's
    // id/title are found for the navigation pills (moved here from
    // agent-service's RECORD_TOOLS so the pills are a ledger view).
    RECORD_TOOLS: {
        create_note: ['notes', 'note'],
        update_note: ['notes', 'note'],
        create_goal: ['goals', 'goal'],
        update_goal: ['goals', 'goal'],
        save_goal: ['goals', 'goal'],
        create_schedule_item: ['schedule', 'item'],
        update_schedule_item: ['schedule', 'item'],
        complete_task: ['schedule', 'item'],
        // create_journal_entry: registered by the Journal package (record opt).
        // Packages add their own rows through AgentTools.register `record`
        // (wellness: js/apps/wellness/wellness-tools.js).
        create_calendar_event: ['calendar', 'created'],
        update_calendar_event: ['calendar', 'updated'],
        // '.' = the id/title sit on the tool result itself, not a wrapper key.
        create_routine: ['prompts', '.'],
        update_routine: ['prompts', '.']
    },

    // Keys whose writes union record arrays with the stored blob
    // (main.js RECORD_MERGED_KEYS, unprefixed) — a pre-image write alone
    // cannot remove records the scope created, so undo must tombstone them.
    RECORD_MERGED_ARRAYS: {
        notes: ['notes'],
        promptFeed: ['items'],
        'agent-decisions': ['decisions']
        // App packages add theirs (registerMergedArrays) — portfolio does.
    },

    /** An app package whose key is in main.js RECORD_MERGED_KEYS declares
     *  the arrays a whole-blob restore cannot shrink, so undo tombstones. */
    registerMergedArrays(key, arrays) {
        if (!key || !Array.isArray(arrays)) return false;
        this.RECORD_MERGED_ARRAYS[key] = arrays.slice();
        return true;
    },

    // Keys that churn during a turn without being the agent's *work* —
    // capturing them would make undo clobber bookkeeping.
    CAPTURE_EXCLUDE: new Set([
        'agent-conversations', 'agent-settings', 'agent-tasks', 'agent-recipes',
        'agent-write-ledger', 'llm-logs', 'search-logs', 'network-logs',
        'feed-prefs', 'priceCache'
    ]),

    _open: new Map(),        // scopeId -> live scope object
    _captureScope: null,     // scope currently armed for StorageManager captures
    _hooked: false,

    // ── scopes ────────────────────────────────────────────────────────────

    beginScope(kind, label) {
        this._installHook();
        const scope = {
            id: `wl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            kind, label: String(label || '').slice(0, 120),
            at: new Date().toISOString(),
            entries: [], preImages: {}, afterHash: {}, preChars: 0, overflow: false
        };
        this._open.set(scope.id, scope);
        // A scope that never records anything is simply forgotten; cap the
        // open map so abandoned scopes can't accumulate over a long session.
        if (this._open.size > 8) this._open.delete(this._open.keys().next().value);
        return scope.id;
    },

    /** Close an open scope (it persisted itself on every entry). */
    endScope(scopeId) {
        const scope = this._open.get(scopeId);
        this._open.delete(scopeId);
        if (this._captureScope && this._captureScope.id === scopeId) this._captureScope = null;
        return scope && scope.entries.length ? scope.id : null;
    },

    _all() {
        const v = StorageManager.get(this.STORE_KEY);
        return Array.isArray(v) ? v.filter(Boolean) : [];
    },

    _saveAll(scopes) {
        // Raw electronStore write, NOT StorageManager.set — the capture hook
        // wraps that, and the ledger must never ledger itself.
        try { window.electronStore.set(`app_${this.STORE_KEY}`, scopes.slice(0, this.MAX_SCOPES)); }
        catch (e) { console.warn('[ledger] save failed:', e.message); }
    },

    _persist(scope) {
        if (!scope || !scope.entries.length) return;
        const scopes = this._all().filter(s => s.id !== scope.id);
        scopes.unshift(scope);
        this._saveAll(scopes);
    },

    getScope(id) {
        return this._open.get(id) || this._all().find(s => s.id === id) || null;
    },

    /** App-start hygiene: drop scopes older than 7 days. */
    init() {
        try {
            const cutoff = Date.now() - 7 * 86400000;
            const scopes = this._all();
            const kept = scopes.filter(s => Date.parse(s.at) > cutoff);
            if (kept.length !== scopes.length) this._saveAll(kept);
        } catch { /* hygiene only */ }
    },

    // ── pre-image capture (StorageManager.set hook) ───────────────────────

    _installHook() {
        if (this._hooked || typeof StorageManager === 'undefined') return;
        this._hooked = true;
        const origSet = StorageManager.set.bind(StorageManager);
        const self = this;
        StorageManager.set = function (appName, data) {
            try {
                const scope = self._captureScope;
                if (scope && !scope.overflow
                    && !self.CAPTURE_EXCLUDE.has(appName)
                    && !(appName in scope.preImages)) {
                    // Deep copy via JSON: callers mutate live objects in
                    // place, so a reference would rot into the after-state.
                    const beforeJson = JSON.stringify(StorageManager.get(appName) ?? null);
                    if (scope.preChars + beforeJson.length > self.MAX_PREIMAGE_CHARS_PER_SCOPE) {
                        scope.overflow = true;   // honest limit: undo won't cover past this point
                    } else {
                        scope.preImages[appName] = beforeJson;
                        scope.preChars += beforeJson.length;
                    }
                }
            } catch (e) { console.warn('[ledger] capture failed:', e.message); }
            return origSet(appName, data);
        };
    },

    /** Run ONE write-tool execution with capture armed for this scope. */
    async captureToolRun(scopeId, fn) {
        const prev = this._captureScope;
        this._captureScope = this._open.get(scopeId) || null;
        try { return await fn(); }
        finally { this._captureScope = prev; }
    },

    // ── recording ─────────────────────────────────────────────────────────

    /**
     * Record one completed mutating tool call. Called by both tool loops
     * AFTER execution; no-op for reads, errors, and cancellations.
     */
    noteToolResult(scopeId, tool, args, result) {
        const scope = this._open.get(scopeId);
        if (!scope) return;
        if (!tool || (typeof AgentService !== 'undefined' && AgentService._isReadOnlyTool(tool))) return;
        if (tool === 'think' || tool === 'start_task' || tool === 'run_recipe') return;
        if (!result || result.error || result.cancelled) return;

        const external = this.EXTERNAL_TOOLS.has(tool) || /^mcp_/.test(tool);
        const entry = {
            at: new Date().toISOString(),
            tool,
            action: tool === 'complete_task' ? 'completed'
                : /^update|^edit/.test(tool) ? 'updated'
                : /trash|delete/.test(tool) ? 'deleted'
                : /^create|^log|^add|^save/.test(tool) ? 'created' : 'changed',
            target: this._targetFor(tool, args)
        };
        if (external) {
            entry.external = true;
            entry.note = 'cannot be undone from here';
        }

        // Navigation pill data for in-app records.
        const spec = this.RECORD_TOOLS[tool];
        if (spec) {
            const rec = spec[1] === '.' ? result : result[spec[1]];
            if (rec && rec.id) {
                entry.app = spec[0];
                entry.recordId = rec.id;
                entry.target = String(rec.title || rec.summary || rec.date
                    || (args && (args.title || args.summary)) || entry.target || '').trim().slice(0, 80);
            }
        }

        // Files/folders written on disk get navigation pills too — the pill
        // reveals the path in Finder (agent-ui). fs_move points at the
        // destination; the main-process result echoes the ~-expanded path,
        // args are the fallback.
        if (tool === 'fs_write' || tool === 'fs_mkdir' || tool === 'fs_move') {
            const p = result.to || result.path || (args && (args.to || args.path)) || '';
            if (p) {
                entry.path = String(p);
                entry.pathKind = tool === 'fs_mkdir' ? 'folder' : 'file';
                // fs_write's pre-image kind says whether the file existed:
                // 'restore' = overwrote, 'remove' = brand new.
                entry.action = tool === 'fs_move' ? 'updated'
                    : (result.fsUndo && result.fsUndo.kind === 'restore') ? 'updated' : 'created';
            }
        }

        // File pre-image handles from main (agent-fs-* results).
        if (result.fsUndo) entry.fsUndo = result.fsUndo;
        if (tool === 'fs_trash') { entry.external = false; entry.note = 'recoverable from the macOS Trash'; }

        // Now that the write landed, remember what "done" looks like per
        // captured key so undo can detect later user edits (conflicts).
        for (const key of Object.keys(scope.preImages)) {
            try { scope.afterHash[key] = this._hash(JSON.stringify(StorageManager.get(key) ?? null)); }
            catch { /* leave prior hash */ }
        }

        scope.entries.push(entry);
        if (scope.entries.length > 100) scope.entries.splice(0, scope.entries.length - 100);
        this._persist(scope);
    },

    /**
     * Record into whichever scope's capture window is currently armed —
     * how run_recipe's INNER steps land in the calling turn/task's ledger
     * (the run_recipe wrapper itself is deliberately not an entry).
     */
    noteInCurrentCapture(tool, args, result) {
        if (this._captureScope) this.noteToolResult(this._captureScope.id, tool, args, result);
    },

    _targetFor(tool, args) {
        if (!args) return '';
        const t = args.path || args.to || args.name || args.title || args.subject || args.command || '';
        return String(t).slice(0, 120);
    },

    _hash(s) {
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        return `${s.length}:${h}`;
    },

    /** The record pills for a scope — in-app records ({app, id}) and files/
     *  folders on disk ({path, kind}), deduped, capped, in creation order. */
    pillsForScope(scopeId) {
        const scope = this.getScope(scopeId);
        if (!scope) return null;
        const pills = [];
        for (const e of scope.entries) {
            if (e.app && e.recordId) {
                const existing = pills.find(p => p.app === e.app && p.id === e.recordId);
                if (existing) {
                    existing.action = e.action;
                    if (e.target) existing.title = e.target;
                    continue;
                }
                if (pills.length >= 8) continue;
                pills.push({ app: e.app, id: e.recordId, title: e.target, action: e.action });
            } else if (e.path && !/trash|delete/.test(e.action || '')) {
                const existing = pills.find(p => p.path === e.path);
                if (existing) { existing.action = e.action; continue; }
                if (pills.length >= 8) continue;
                pills.push({
                    path: e.path,
                    kind: e.pathKind || 'file',
                    title: e.path.replace(/\/+$/, '').split('/').pop() || e.path,
                    action: e.action
                });
            }
        }
        return pills.length ? pills : null;
    },

    // ── undo ──────────────────────────────────────────────────────────────

    /** What would undo do? Drives the affordance + its honest copy. */
    undoPreview(scopeId) {
        const scope = this.getScope(scopeId);
        if (!scope || scope.undone || !scope.entries.length) return null;
        const keys = Object.keys(scope.preImages).length;
        const files = scope.entries.filter(e => e.fsUndo).length;
        const external = scope.entries.filter(e => e.external).length;
        if (!keys && !files) return null;   // nothing restorable — no affordance
        return { keys, files, external, overflow: !!scope.overflow };
    },

    /**
     * Records present in the current blob but absent from the pre-image
     * were created inside this scope. On record-merged keys their removal
     * must ride a tombstone, or the union on write resurrects them.
     */
    _tombstoneRemoved(key, before) {
        const arrays = this.RECORD_MERGED_ARRAYS[key];
        if (!arrays || !before || typeof before !== 'object') return;
        const current = StorageManager.get(key);
        if (!current || typeof current !== 'object') return;
        const now = new Date().toISOString();
        for (const name of arrays) {
            const keep = new Set((Array.isArray(before[name]) ? before[name] : [])
                .map(r => r && r.id).filter(Boolean));
            for (const r of (Array.isArray(current[name]) ? current[name] : [])) {
                if (r && r.id && !keep.has(r.id)) {
                    (before.tombstones = before.tombstones || {})[r.id] = now;
                }
            }
        }
    },

    /**
     * Undo everything this scope holds. Restores app-data keys to their
     * pre-scope value (skipping any the user has since changed), restores
     * file pre-images via main, and reports — honestly — what it could not
     * touch. Marks the scope undone so the affordance disappears.
     */
    async undoScope(scopeId) {
        const open = this._open.get(scopeId);
        const scopes = this._all();
        let scope = scopes.find(s => s.id === scopeId) || open;
        if (!scope) return { error: 'Nothing to undo — this activity is no longer in the ledger.' };
        if (scope.undone) return { error: 'Already undone.' };

        const restoredKeys = [], conflictKeys = [];
        for (const [key, beforeJson] of Object.entries(scope.preImages)) {
            try {
                const currentJson = JSON.stringify(StorageManager.get(key) ?? null);
                if (scope.afterHash[key] && this._hash(currentJson) !== scope.afterHash[key]) {
                    conflictKeys.push(key);   // changed since — restoring would eat newer edits
                    continue;
                }
                const before = JSON.parse(beforeJson);
                this._tombstoneRemoved(key, before);
                StorageManager.set(key, before);
                restoredKeys.push(key);
            } catch (e) {
                conflictKeys.push(key);
                console.warn(`[ledger] undo of ${key} failed:`, e.message);
            }
        }

        const restoredFiles = [], failedFiles = [];
        // Newest action first: a move after a write must un-move before the
        // write's pre-image can land on the original path.
        for (const e of [...scope.entries].reverse()) {
            if (!e.fsUndo) continue;
            try {
                const r = await window.electronAgentFS.undo(e.fsUndo);
                (r && !r.error ? restoredFiles : failedFiles).push(e.target || e.tool);
            } catch { failedFiles.push(e.target || e.tool); }
        }

        const external = scope.entries.filter(x => x.external)
            .map(x => `${x.tool}${x.target ? ` (${x.target})` : ''}`);

        scope.undone = true;
        if (open) open.undone = true;
        const idx = scopes.findIndex(s => s.id === scopeId);
        if (idx !== -1) scopes[idx] = scope; else scopes.unshift(scope);
        this._saveAll(scopes);
        try { window.dispatchEvent(new CustomEvent('ledger-undo', { detail: { restoredKeys } })); } catch { /* UI refresh is best-effort */ }
        return {
            restoredKeys, restoredFiles,
            conflictKeys, failedFiles,
            external,
            overflow: !!scope.overflow
        };
    }
};

if (typeof window !== 'undefined') {
    window.WriteLedger = WriteLedger;
    // Hygiene only — drop week-old scopes (their file pre-images are pruned
    // by main on the same schedule).
    setTimeout(() => { try { WriteLedger.init(); } catch { /* optional */ } }, 0);
}
