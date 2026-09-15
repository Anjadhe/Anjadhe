/**
 * AI Activity store — the renderer-side model behind the AI Activity page.
 *
 * Main emits an `ai-activity` IPC event for every LLM request (start/run/end)
 * and every engine model load/unload, across ALL callers — including the ones
 * that bypass LLMLogger (task mode, model warm-up). This
 * store turns that stream into two lists the page renders directly:
 *
 *   active  — requests in flight right now (and a model currently loading)
 *   recent  — the last completed items, newest first, persisted per-Mac
 *
 * This is deliberately NOT another log: entries are human-readable activities
 * ("Email insights", "Model warm-up") with status and timing; the full
 * request/response detail stays in LLM Logs, linked via logId when the call
 * went through LLMLogger.
 */

const AIActivity = {
    active: new Map(),   // main-side id -> item
    recent: [],          // completed items, newest first
    maxRecent: 60,
    _storageKey: 'ai-activity',
    _listeners: [],
    _persistTimer: null,

    // tag -> how the row reads. `auto: true` marks work the app started on its
    // own (the answer to "why is the GPU busy when I'm not chatting").
    TAG_INFO: {
        'agent':                { label: 'Assistant chat', desc: 'Answering your message in the assistant' },
        'interactive':          { label: 'Assistant chat', desc: 'Answering your message in the assistant' },
        'email':                { label: 'Email insights', desc: 'Reading new email for summaries and action items', auto: true },
        'imessage':             { label: 'Text insights', desc: 'Reading a new iMessage conversation for summaries and action items', auto: true },
        'email-bundles':        { label: 'Email bundling', desc: 'Grouping new inbox email into bundles', auto: true },
        'email-compose':        { label: 'Email drafting', desc: 'Writing the email draft you asked for' },
        'goal-update':          { label: 'Goal progress', desc: 'Updating goal progress after your chat', auto: true },
        'goal-breakdown':       { label: 'Project breakdown', desc: 'Breaking a project into steps' },
        'memory-extract':       { label: 'Memory', desc: 'Noting things worth remembering from your chat', auto: true },
        'memory-consolidate':   { label: 'Memory tidy-up', desc: 'Reorganizing the assistant’s memory pages', auto: true },
        'memory-compact':       { label: 'Memory tidy-up', desc: 'Compacting the assistant’s memory pages', auto: true },
        'actions-filing':       { label: 'Actions suggestions', desc: 'Suggesting a project or date for unfiled tasks — chips you confirm', auto: true },
        'actions-review':       { label: 'Actions review', desc: 'Preparing your Actions review' },
        'prompt-feed':          { label: 'Routine', desc: 'Running one of your routines', auto: true },
        'browse-reader-improve':{ label: 'Reader cleanup', desc: 'Cleaning up a page for reader view' },
        'doc-tidy':             { label: 'Document tidy', desc: 'Rewriting an extracted document as readable text' },
        'portfolio-profile':    { label: 'Stock profile', desc: 'Writing today’s business profile of a stock you hold or watch', auto: true },
        'portfolio-brief':      { label: 'Portfolio brief', desc: 'Writing today’s brief on the market and your portfolio', auto: true },
        'prompt-suggestions':   { label: 'Suggested prompts', desc: 'Writing fresh "Try asking…" prompts from what is on your plate', auto: true },
        'doc-vision':           { label: 'Document reading', desc: 'Reading a document\'s pages with a vision model' },
        'task-plan':            { label: 'Assistant task', desc: 'Planning the task you gave the assistant' },
        'task-step':            { label: 'Assistant task', desc: 'Working through a task step' },
        'task-verify':          { label: 'Assistant task', desc: 'Checking a task’s results' },
        'task-verdicts':        { label: 'Assistant task', desc: 'Judging task results' },
        'prewarm':              { label: 'Model warm-up', desc: 'Loading the model so your first message answers fast', auto: true },
        'background':           { label: 'Background AI task', desc: 'A background task using the AI engine', auto: true }
    },

    init() {
        try {
            const restored = this.restoreSaved(StorageManager.get(this._storageKey));
            this.recent = restored.recent;
            if (restored.lost) this._schedulePersist();
        } catch (e) {
            console.warn('Failed to load AI activity history:', e);
        }
        if (window.electronAIActivity) {
            window.electronAIActivity.onEvent((ev) => this._onEvent(ev));
        }
    },

    /**
     * Rebuild the recent list from what was persisted. Pure — pinned by
     * tests/ai-activity-test.js.
     *
     * Two shapes: the legacy bare array of recent items, and
     * `{recent, active}` (since 2026-09-04). Anything still in `active` at
     * the last save never got its 'end' event — the app was quit or killed
     * mid-run — so it is folded into recent as status 'lost'. Before this,
     * a run killed after 100 minutes left NO row anywhere: the in-flight
     * list lived only in memory and the history only records endings.
     */
    restoreSaved(saved) {
        const recent = Array.isArray(saved) ? saved
            : (saved && Array.isArray(saved.recent)) ? saved.recent : [];
        const active = (saved && !Array.isArray(saved) && Array.isArray(saved.active)) ? saved.active : [];
        const lost = active
            .filter(it => it && it.kind === 'request' && it.startedAt)
            .map(it => ({
                ...it,
                status: 'lost',
                // Unknown end: the app was gone. lastSeenAt is the save that
                // still had it running — a floor on how long it ran.
                endedAt: null,
                durationMs: null,
                lastSeenAt: it.lastSeenAt || null,
                error: 'Did not finish — the app was closed while this ran'
            }))
            .sort((a, b) => b.startedAt - a.startedAt);
        const out = [...lost, ...recent].slice(0, this.maxRecent);
        // Items persisted before uids existed still need one — the detail
        // view finds items by uid.
        out.forEach((it, i) => { if (!it.uid) it.uid = 'old-' + i + '-' + (it.startedAt || 0); });
        return { recent: out, lost: lost.length };
    },

    subscribe(fn) {
        this._listeners.push(fn);
        return () => { this._listeners = this._listeners.filter(l => l !== fn); };
    },

    _notify() {
        for (const fn of this._listeners) {
            try { fn(); } catch { /* one bad listener must not break the rest */ }
        }
    },

    _onEvent(ev) {
        if (!ev || !ev.kind) return;
        if (ev.kind === 'request') this._onRequestEvent(ev);
        else if (ev.kind === 'engine') this._onEngineEvent(ev);
        this._notify();
    },

    _onRequestEvent(ev) {
        if (ev.event === 'start') {
            const info = this.TAG_INFO[ev.tag] || {};
            this.active.set(ev.id, {
                uid: 'r' + ev.id,
                kind: 'request',
                tag: ev.tag,
                label: info.label || this._fallbackLabel(ev.tag),
                desc: info.desc || null,
                // Known tags say explicitly whether the app started the work
                // (a task run is background-CLASS but user-asked); only
                // unknown tags fall back to the scheduler class.
                auto: info.label ? !!info.auto : (ev.jobClass === 'background'),
                jobClass: ev.jobClass,
                model: ev.model,
                engine: ev.engine,
                local: ev.local,
                msgs: ev.msgs || 0,
                promptChars: ev.promptChars || 0,
                toolCount: ev.toolCount || 0,
                maxTokens: ev.maxTokens || null,
                preview: ev.preview || null,
                // What the work is about (a routine's title) and the handle
                // Stop uses ('conv:<id>' | 'task:<id>') — see stop().
                subject: ev.subject || null,
                runId: ev.runId || null,
                logId: ev.logId || null,
                // Local jobs may wait in the scheduler queue (on ≤16 GB
                // machines even chat waits for the job in flight); 'run'
                // flips this to running — instantly when there was no wait,
                // since both events arrive together.
                status: ev.local ? 'queued' : 'running',
                startedAt: ev.ts
            });
            // In-flight rows are persisted too (with recent, one blob), so a
            // run the app dies under still shows up next launch — as 'lost'.
            this._schedulePersist();
            return;
        }
        const item = this.active.get(ev.id);
        if (!item) return; // started before this window loaded (e.g. pre-refresh)
        if (ev.event === 'run') {
            if (item.status === 'queued') item.queuedMs = ev.ts - item.startedAt;
            item.status = 'running';
            this._schedulePersist();
            return;
        }
        if (ev.event === 'end') {
            this.active.delete(ev.id);
            item.endedAt = ev.ts;
            item.durationMs = ev.ts - item.startedAt;
            item.status = ev.aborted ? 'stopped' : (ev.error ? 'failed' : 'done');
            item.error = ev.error || null;
            if (ev.promptTokens != null) item.promptTokens = ev.promptTokens;
            if (ev.completionTokens != null) item.completionTokens = ev.completionTokens;
            this._addRecent(item);
        }
    },

    _onEngineEvent(ev) {
        const key = 'engine-' + ev.engine;
        const engineName = 'llama.cpp';
        if (ev.event === 'loading') {
            this.active.set(key, {
                uid: 'e' + ev.ts + '-' + ev.engine,
                kind: 'engine',
                tag: 'model-load',
                label: 'Loading model',
                desc: `Loading ${this._shortModel(ev.model)} into memory (${engineName}) — heavy for a moment`,
                auto: true,
                model: ev.model,
                engine: ev.engine,
                status: 'running',
                startedAt: ev.ts
            });
            return;
        }
        if (ev.event === 'ready' || ev.event === 'load-failed') {
            const item = this.active.get(key);
            this.active.delete(key);
            const base = item || { uid: 'e' + ev.ts + '-' + ev.engine, kind: 'engine', tag: 'model-load', label: 'Loading model', auto: true, model: ev.model, engine: ev.engine, startedAt: ev.ts };
            base.endedAt = ev.ts;
            base.durationMs = ev.ts - base.startedAt;
            base.status = ev.event === 'ready' ? 'done' : 'failed';
            base.label = ev.event === 'ready' ? 'Model loaded' : 'Model failed to load';
            base.desc = `${this._shortModel(ev.model)} (${engineName})`;
            this._addRecent(base);
            return;
        }
        if (ev.event === 'stopped') {
            // A stop during a model switch is part of the load already shown —
            // only record standalone unloads (no load in flight, or a crash of
            // the very model being loaded is reported by 'load-failed' anyway).
            if (this.active.has(key)) return;
            this._addRecent({
                uid: 'u' + ev.ts + '-' + ev.engine,
                kind: 'engine', tag: 'model-unload', label: 'Model unloaded', auto: true,
                desc: `${this._shortModel(ev.model)} released its memory (${engineName})`,
                model: ev.model, engine: ev.engine,
                status: 'done', startedAt: ev.ts, endedAt: ev.ts, durationMs: null
            });
        }
    },

    /**
     * A row for work the app chose NOT to send (CloudPrivacy's data-class
     * gate). No request happened, so it never passes through the event
     * stream; it lands straight in recent, status 'blocked'.
     */
    noteBlocked({ label, desc, cls }) {
        const ts = Date.now();
        this._addRecent({
            uid: 'b' + ts + '-' + (cls || 'x'),
            kind: 'request', tag: 'cloud-privacy',
            label: label || 'Kept on this Mac', desc: desc || null,
            auto: true, jobClass: 'background', local: true,
            status: 'blocked', startedAt: ts, endedAt: ts, durationMs: 0
        });
        this._notify();
    },

    _addRecent(item) {
        this.recent.unshift(item);
        if (this.recent.length > this.maxRecent) this.recent = this.recent.slice(0, this.maxRecent);
        this._schedulePersist();
    },

    // Coalesce bursts (an agent tool loop can end several calls per second)
    // into one storage write.
    _schedulePersist() {
        if (this._persistTimer) return;
        this._persistTimer = setTimeout(() => {
            this._persistTimer = null;
            try { StorageManager.set(this._storageKey, this._toSaved()); }
            catch (e) { console.warn('Failed to persist AI activity history:', e); }
        }, 1000);
    },

    _toSaved() {
        const now = Date.now();
        const active = [...this.active.values()]
            .filter(it => it.kind === 'request')
            .map(it => ({ ...it, lastSeenAt: now }));
        return { recent: this.recent, active };
    },

    /**
     * Stop the work behind an active row. The row's runId names the owner:
     *   'conv:<id>' — a chat turn or a headless (routine / channel) run:
     *                 AgentService.abortConversation, the chat Stop button's
     *                 own path; PromptFeed is told so the routine settles as
     *                 "stopped by you" instead of posting an error card.
     *   'task:<id>' — a task-mode run: TaskService.cancel.
     * Returns false when nothing could be stopped (already ended, or the
     * owner is gone).
     */
    stop(runId) {
        const m = /^(conv|task):(.+)$/.exec(String(runId || ''));
        if (!m) return false;
        const [, kind, id] = m;
        try {
            if (kind === 'task') {
                if (typeof TaskService === 'undefined') return false;
                TaskService.cancel(id);
                return true;
            }
            let stopped = false;
            if (typeof PromptFeed !== 'undefined' && typeof PromptFeed.stopCurrent === 'function') {
                stopped = PromptFeed.stopCurrent(id) || stopped;
            }
            if (typeof AgentService !== 'undefined' && typeof AgentService.abortConversation === 'function') {
                stopped = AgentService.abortConversation(id) || stopped;
            }
            return stopped;
        } catch (e) {
            console.warn('[ai-activity] stop failed:', e);
            return false;
        }
    },

    _fallbackLabel(tag) {
        const t = String(tag || 'AI request');
        return (t.charAt(0).toUpperCase() + t.slice(1)).replace(/-/g, ' ');
    },

    // A model id can be a full GGUF path — show just the model name.
    _shortModel(model) {
        return String(model || 'model').split('/').pop().replace(/\.gguf$/i, '');
    },

    /** Find an item (active or recent) by its uid — the detail view's lookup. */
    findByUid(uid) {
        for (const item of this.active.values()) if (item.uid === uid) return item;
        return this.recent.find(it => it.uid === uid) || null;
    },

    clear() {
        this.recent = [];
        this._schedulePersist();
        this._notify();
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = AIActivity;
