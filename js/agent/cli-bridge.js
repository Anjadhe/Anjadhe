/**
 * CLIBridge — renderer side of Terminal access (docs/COWORK_AGENT.md C7.3).
 *
 * Main relays `anjadhe` CLI requests here; this bridge runs them on the
 * REAL agent — same AgentService/TaskService, same permission machinery,
 * same transparency logs — and streams events back over IPC for main to
 * pipe onto the CLI's NDJSON response.
 *
 * All CLI turns land in one persistent "Terminal" conversation
 * (conv.cliTerminal), so the transcript is visible and searchable in the
 * app afterwards. The conversation is never activated in the UI — a CLI
 * request must not hijack whatever chat the user has open. Live streaming
 * works by polling the accumulated stream state (the onChunk callback only
 * fires for the ACTIVE conversation, but the buffer fills regardless).
 *
 * Permission asks during a CLI run go to the TTY instead of the in-app
 * dialog (AgentService._confirmWrite routes here when the conversation has
 * an active CLI request); the resulting grants land in the same
 * PermissionManager either way.
 *
 * The C8.4 write ledger reaches the terminal too: `done` events carry the
 * turn/task's record pills (rendered as a Changed: footer) plus an
 * `undoable` flag, and the undo.preview / undo.run commands drive the same
 * WriteLedger scopes the in-app Undo buttons use.
 */

const CLIBridge = {
    _active: new Map(),       // convId -> requestId (one CLI run per conv at a time)
    _pendingAsks: new Map(),  // askId -> { resolve, timer }
    _taskWatch: new Map(),    // taskId -> { requestId, resolve }
    _seq: 0,

    init() {
        if (!window.electronCLI?.onRequest) return;
        window.electronCLI.onRequest((p) => {
            try { this._handleRequest(p); } catch (e) {
                this.emit(p.requestId, { type: 'error', error: e.message });
            }
        });
        window.electronCLI.onAnswer((p) => this._handleAnswer(p));
    },

    emit(requestId, event) {
        try { window.electronCLI.emit(requestId, event); } catch { /* stream gone */ }
    },

    // The one persistent Terminal conversation. Pushed (not unshift-created
    // via createConversation) so the user's ACTIVE chat never changes.
    _terminalConv() {
        let conv = AgentService.conversations.find(c => c && c.cliTerminal === true);
        if (!conv) {
            conv = {
                id: 'conv_' + Date.now() + '_cli',
                title: 'Terminal',
                cliTerminal: true,
                // The user is AT a terminal — they expect the assistant to
                // actually run commands to find things out, not describe the
                // command for them to run. This rides the conversation's
                // extraContext (folded into the system prompt).
                extraContext: 'TERMINAL SESSION: the user is talking to you from a command line on their Mac. When a question is answered by running a command (checking an installed version, listing files, disk usage, git state, what is running, environment details), just run it with run_command and report the result — do NOT tell the user to run it themselves; you are already on their machine with shell access. Keep answers terminal-friendly: concise, plain text, no heavy markdown.',
                // Ship the shell + filesystem tools on every CLI turn (a
                // terminal user expects the assistant to run things), and
                // force full context — scopedDomains does both. It only ever
                // grows elsewhere, so seeding it here is safe.
                scopedDomains: ['shell', 'files'],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                messages: []
            };
            AgentService.conversations.push(conv);
            AgentService._saveConversations();
        } else {
            // Backfill the terminal behavior onto a conversation created by
            // an older build (before the extraContext/scopedDomains seed).
            let patched = false;
            if (!conv.extraContext) {
                conv.extraContext = 'TERMINAL SESSION: the user is talking to you from a command line on their Mac. When a question is answered by running a command (checking an installed version, listing files, disk usage, git state, what is running, environment details), just run it with run_command and report the result — do NOT tell the user to run it themselves; you are already on their machine with shell access. Keep answers terminal-friendly: concise, plain text, no heavy markdown.';
                patched = true;
            }
            const dom = new Set(Array.isArray(conv.scopedDomains) ? conv.scopedDomains : []);
            if (!dom.has('shell') || !dom.has('files')) { dom.add('shell'); dom.add('files'); conv.scopedDomains = [...dom]; patched = true; }
            if (patched) AgentService._saveConversations();
        }
        return conv;
    },

    async _handleRequest({ requestId, kind, message, autoApprove, command, args }) {
        // Commands (model list/switch, fresh conversation) are instant local
        // operations — no model turn, so they skip the one-run-per-conv gate.
        if (kind === 'command') {
            try {
                const data = await this._runCommand(command, args || {});
                this.emit(requestId, { type: 'done', data });
            } catch (e) {
                this.emit(requestId, { type: 'error', error: e.message || 'command failed' });
            }
            return;
        }
        const conv = this._terminalConv();
        if (this._active.has(conv.id) || AgentService.isConversationStreaming(conv.id)) {
            this.emit(requestId, { type: 'error', error: 'The Terminal conversation is busy with another request — try again in a moment.' });
            return;
        }
        this._active.set(conv.id, requestId);
        try {
            if (kind === 'task') await this._runTask(requestId, conv, message, autoApprove);
            else await this._runAsk(requestId, conv, message);
        } catch (e) {
            this.emit(requestId, { type: 'error', error: e.message || 'request failed' });
        } finally {
            this._active.delete(conv.id);
        }
    },

    async _runAsk(requestId, conv, message) {
        // Delta poller over the accumulated stream buffer (see header note).
        // 80ms ≈ token cadence for a local model, so text flows smoothly to
        // the terminal instead of arriving in 300ms clumps.
        let sent = 0;
        const poll = setInterval(() => {
            const st = AgentService._streamingState.get(conv.id);
            if (!st) return;
            if (st.content.length < sent) { sent = 0; return; } // buffer reset between iterations
            if (st.content.length > sent) {
                this.emit(requestId, { type: 'chunk', text: st.content.slice(sent) });
                sent = st.content.length;
            }
        }, 80);
        try {
            const res = await AgentService.sendMessage(message, null, { convId: conv.id, logTag: 'cli' });
            clearInterval(poll);
            const content = (res && (res.content || res.error)) || '';
            // The write-ledger view of this turn (same data as the in-app
            // pills): what changed, and whether /undo could take it back.
            const records = (res && res.records) || undefined;
            const undoable = !!(res && res.undoScope);
            // Flush the TAIL: the final tokens arrive after the last 80ms poll
            // tick and the stream buffer is gone once sendMessage resolves, so
            // without this the end of every answer was dropped (the CLI
            // ignores `done`.content once anything streamed). `content` is the
            // authoritative final answer and its first `sent` chars are what
            // already streamed, so the remainder is the missing tail.
            if (content.length > sent) {
                this.emit(requestId, { type: 'chunk', text: content.slice(sent) });
                sent = content.length;
            } else if (sent === 0 && content) {
                // Nothing streamed (very fast/short turn) — send it all.
                this.emit(requestId, { type: 'chunk', text: content });
                sent = content.length;
            }
            this.emit(requestId, { type: 'done', content, streamed: sent > 0, records, undoable });
        } finally {
            clearInterval(poll);
        }
    },

    async _runTask(requestId, conv, message, autoApprove) {
        if (typeof TaskService === 'undefined') {
            this.emit(requestId, { type: 'error', error: 'Task mode is not available in this build.' });
            return;
        }
        conv.messages.push({ role: 'user', content: message });
        AgentService._persistConversation(conv);
        const res = await TaskService.start(message, conv.id);
        if (res.error) { this.emit(requestId, { type: 'error', error: res.error }); return; }
        const task = TaskService.get(res.taskId) || {};
        const steps = (task.plan || []).map(s => s.step);
        this.emit(requestId, { type: 'plan', taskId: res.taskId, steps });
        if (!autoApprove) {
            const a = await this.askPermission(conv.id, 'run_plan',
                `${steps.length} step${steps.length === 1 ? '' : 's'}`,
                'Run this plan? The steps execute with tools on this Mac.');
            if (!a.approved) {
                TaskService.cancel(res.taskId);
                this.emit(requestId, { type: 'done', content: 'Plan cancelled — nothing was run.' });
                return;
            }
        }
        const finished = new Promise((resolve) => {
            this._taskWatch.set(res.taskId, { requestId, convId: conv.id, resolve });
        });
        TaskService.approve(res.taskId);
        await finished;
    },

    /** TaskService._notify calls this for every update (CLI-watched or not). */
    onTaskUpdate(task) {
        const w = this._taskWatch.get(task && task.id);
        if (!w) return;
        this.emit(w.requestId, {
            type: 'task_update',
            status: task.status,
            note: task.note || '',
            steps: (task.plan || []).map(s => ({ step: s.step, status: s.status }))
        });
        if (['done', 'failed'].includes(task.status)) {
            this._taskWatch.delete(task.id);
            const conv = AgentService.conversations.find(c => c.id === w.convId);
            const report = conv ? [...conv.messages].reverse().find(m => m.role === 'assistant') : null;
            // The task's ledger view: pills across every run scope, and
            // whether anything is still restorable (drives the /undo hint).
            let records, undoable = false;
            if (typeof WriteLedger !== 'undefined') {
                const pills = (task.ledgerScopes || []).flatMap(id => WriteLedger.pillsForScope(id) || []);
                if (pills.length) records = pills;
                undoable = (task.ledgerScopes || []).some(id => WriteLedger.undoPreview(id));
            }
            this.emit(w.requestId, { type: 'done', content: (report && report.content) || task.note || '', records, undoable });
            w.resolve();
        }
    },

    // ── Commands (instant, no model turn) ───────────────────────────────

    async _runCommand(command, args) {
        if (command === 'models') return this._cmdModels();
        if (command === 'model.set') return this._cmdModelSet(args);
        if (command === 'clear') return this._cmdClear();
        if (command === 'sync.status') return window.electronSync.encryptionStatus();
        if (command === 'sync.unlock') return this._cmdSyncUnlock(args);
        if (command === 'undo.preview') return this._cmdUndoPreview();
        if (command === 'undo.run') return this._cmdUndoRun(args);
        throw new Error(`Unknown command: ${command}`);
    },

    /**
     * Unlock a passphrase-protected sync key from the terminal — the only
     * unlock surface reachable over SSH (the in-app dialog needs a screen).
     * Same IPC path as Settings → Storage & Backup, so the queued journal
     * flush and catch-up merge run identically.
     */
    async _cmdSyncUnlock({ passphrase }) {
        if (!passphrase) throw new Error('Passphrase required.');
        const r = await window.electronSync.unlock(String(passphrase));
        if (!r || r.error) throw new Error((r && r.error) || 'Unlock failed.');
        // Settings may be open on screen — repaint its sync card if so.
        try { if (typeof SettingsApp !== 'undefined' && SettingsApp._renderSyncEncryption) SettingsApp._renderSyncEncryption(); } catch { /* cosmetic */ }
        return { ok: true, cached: r.cached !== false };
    },

    /**
     * The saved model entries, with which one answers THIS terminal
     * (the Terminal conversation's override, else the app default) and
     * which is the app-wide default brain.
     */
    async _cmdModels() {
        await AgentService.ensureModelList();
        const list = AgentService.getModelList();
        const def = AgentService.getDefaultEntry();
        const conv = AgentService.conversations.find(c => c && c.cliTerminal === true);
        const active = conv ? AgentService.getActiveEntry(conv.id) : def;
        return {
            models: list.map(e => ({
                id: e.id,
                engine: e.engine,
                model: e.model,
                isDefault: !!def && e.id === def.id,
                // Match model too: an override naming a since-removed model
                // resolves to a synthetic entry that reuses the default's id.
                isActive: !!active && e.id === active.id && e.model === active.model
            })),
            override: !!(conv && conv.model)
        };
    },

    /**
     * Switch model. ref = 1-based list number, model name, or a unique
     * substring; 'default' clears the terminal override. By default the
     * switch is scoped to the Terminal conversation (a per-conv override,
     * same as the in-app per-chat picker) so it never silently retargets
     * the brain that email insights and every background feature run on;
     * makeDefault switches the app-wide default too (and clears the
     * override so the terminal follows it).
     */
    async _cmdModelSet({ ref, makeDefault }) {
        await AgentService.ensureModelList();
        const list = AgentService.getModelList();
        if (!list.length) throw new Error('No models are set up yet. Add one in Anjadhe: Settings → AI Assistant → Models.');
        const conv = this._terminalConv();
        const want = String(ref || '').trim();
        if (!want) throw new Error('Which model? Use a number or name from /model.');
        if (want.toLowerCase() === 'default') {
            AgentService.setConversationModel(conv.id, null);
            const def = AgentService.getDefaultEntry();
            return { model: def ? def.model : null, engine: def ? def.engine : null, scope: 'cleared' };
        }
        const lower = want.toLowerCase();
        let entry = null;
        const idx = /^\d+$/.test(want) ? parseInt(want, 10) : 0;
        if (idx >= 1 && idx <= list.length) entry = list[idx - 1];
        if (!entry) entry = list.find(e => e.id === want);
        if (!entry) {
            entry = list.find(e => e.model.toLowerCase() === lower && !AgentService.isRemoteEngine(e.engine))
                || list.find(e => e.model.toLowerCase() === lower);
        }
        if (!entry) {
            const matches = list.filter(e => e.model.toLowerCase().includes(lower));
            if (matches.length > 1) throw new Error(`"${want}" matches ${matches.length} models (${matches.map(e => e.model).join(', ')}) — be more specific or use its number.`);
            entry = matches[0];
        }
        if (!entry) throw new Error(`No model matches "${want}" — /model lists what you have.`);
        if (makeDefault === true) {
            AgentService.setConversationModel(conv.id, null);
            await AgentService.setDefaultEntry(entry.id);
            return { model: entry.model, engine: entry.engine, scope: 'default' };
        }
        // Per-conv overrides are bare model names (they predate engines), so
        // a remote entry can only be targeted this way when no local entry
        // shares its name — same resolution getActiveEntry applies.
        AgentService.setConversationModel(conv.id, entry.model);
        return { model: entry.model, engine: entry.engine, scope: 'terminal' };
    },

    /**
     * Clear the terminal's context: the old Terminal conversation is
     * unmarked (and dated) so it stays readable in the app, and the next
     * turn creates a clean one. Model override does not carry over — by
     * design; a fresh conversation follows the app default.
     */
    async _cmdClear() {
        const conv = AgentService.conversations.find(c => c && c.cliTerminal === true);
        if (!conv || !conv.messages.length) return { cleared: false };
        conv.cliTerminal = false;
        conv.title = `Terminal — until ${new Date().toLocaleDateString()}`;
        AgentService._saveConversations();
        return { cleared: true };
    },

    /**
     * The newest undoable activity in the Terminal conversation — a chat
     * turn's single scope, or ALL of a task's run scopes together, exactly
     * matching the two in-app affordances ("Undo this turn" on a message,
     * "Undo writes" on a task card). Preview only; undo.run performs it.
     */
    _cmdUndoPreview() {
        if (typeof WriteLedger === 'undefined') throw new Error('Undo is not available in this build.');
        const conv = AgentService.conversations.find(c => c && c.cliTerminal === true);
        if (!conv) return { found: false, reason: 'Nothing to undo — this terminal has no activity yet.' };
        const candidates = [];
        for (const m of conv.messages) {
            const id = (m && m.role === 'assistant' && m.metadata) ? m.metadata.undoScope : null;
            if (!id || !WriteLedger.undoPreview(id)) continue;
            const s = WriteLedger.getScope(id);
            candidates.push({ kind: 'turn', scopeIds: [id], label: (s && s.label) || 'chat turn', at: (s && s.at) || '' });
        }
        if (typeof TaskService !== 'undefined') {
            for (const t of TaskService.list()) {
                if (!t || t.conversationId !== conv.id) continue;
                const ids = (t.ledgerScopes || []).filter(id => WriteLedger.undoPreview(id));
                if (!ids.length) continue;
                const at = ids.map(id => (WriteLedger.getScope(id) || {}).at || '').sort().pop();
                candidates.push({ kind: 'task', scopeIds: ids, label: t.goal || 'task', at: at || '' });
            }
        }
        if (!candidates.length) {
            return { found: false, reason: 'Nothing to undo — no restorable writes in this terminal’s ledger (it keeps 7 days of app-data and file changes; external actions were never restorable).' };
        }
        candidates.sort((a, b) => String(a.at).localeCompare(String(b.at)));
        const c = candidates[candidates.length - 1];
        const agg = { keys: 0, files: 0, external: 0, overflow: false };
        for (const id of c.scopeIds) {
            const p = WriteLedger.undoPreview(id) || {};
            agg.keys += p.keys || 0;
            agg.files += p.files || 0;
            agg.external += p.external || 0;
            agg.overflow = agg.overflow || !!p.overflow;
        }
        return { found: true, kind: c.kind, label: c.label, scopeIds: c.scopeIds, ...agg };
    },

    /** Perform the undo previewed above. Same ordering rule as the in-app
     *  task undo: newest scope first, so later runs' pre-images land before
     *  earlier ones overwrite them. */
    async _cmdUndoRun({ scopeIds }) {
        if (typeof WriteLedger === 'undefined') throw new Error('Undo is not available in this build.');
        const ids = Array.isArray(scopeIds) ? scopeIds.filter(id => typeof id === 'string') : [];
        if (!ids.length) throw new Error('undo.run needs the scopeIds from undo.preview.');
        const out = { restoredKeys: [], restoredFiles: [], conflictKeys: [], failedFiles: [], external: [], errors: [] };
        for (const id of [...ids].reverse()) {
            const r = await WriteLedger.undoScope(id);
            if (r.error) { out.errors.push(r.error); continue; }
            out.restoredKeys.push(...r.restoredKeys);
            out.restoredFiles.push(...r.restoredFiles);
            out.conflictKeys.push(...r.conflictKeys);
            out.failedFiles.push(...r.failedFiles);
            out.external.push(...r.external);
        }
        return out;
    },

    // ── Permission bridging (TTY instead of the in-app dialog) ──────────

    wantsPermission(convId) {
        return this._active.has(convId);
    },

    askPermission(convId, tool, argsSummary, note) {
        const requestId = this._active.get(convId);
        if (!requestId) return Promise.resolve({ approved: false, scope: 'once' });
        const askId = 'ask_' + Date.now().toString(36) + '_' + (++this._seq);
        return new Promise((resolve) => {
            // Unanswered for 5 minutes → deny (the CLI may have been killed).
            const timer = setTimeout(() => {
                this._pendingAsks.delete(askId);
                resolve({ approved: false, scope: 'once' });
            }, 5 * 60 * 1000);
            this._pendingAsks.set(askId, { resolve, timer });
            let summary = argsSummary;
            if (typeof summary !== 'string') {
                try { summary = JSON.stringify(summary).slice(0, 400); } catch { summary = ''; }
            }
            this.emit(requestId, { type: 'permission_request', askId, tool, args: summary || '', note: note || '' });
        });
    },

    _handleAnswer({ askId, approved, scope }) {
        const p = this._pendingAsks.get(askId);
        if (!p) return;
        clearTimeout(p.timer);
        this._pendingAsks.delete(askId);
        p.resolve({ approved: approved === true, scope: scope || 'once' });
    }
};

if (typeof window !== 'undefined') {
    window.CLIBridge = CLIBridge;
    CLIBridge.init();
}
