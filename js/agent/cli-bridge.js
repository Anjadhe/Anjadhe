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
                profile: (typeof ProfileManager !== 'undefined' && ProfileManager.getProfileForNewItem)
                    ? ProfileManager.getProfileForNewItem() : 'default',
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

    async _handleRequest({ requestId, kind, message, autoApprove }) {
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
            this.emit(requestId, { type: 'done', content, streamed: sent > 0 });
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
            this.emit(w.requestId, { type: 'done', content: (report && report.content) || task.note || '' });
            w.resolve();
        }
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
