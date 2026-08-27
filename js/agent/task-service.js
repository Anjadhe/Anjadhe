/**
 * TaskService — task mode: plan → act → verify → report
 * (docs/COWORK_AGENT.md §4, phase C4).
 *
 * The behavioral difference between chatbot and coworker: the user hands
 * over an OUTCOME, the harness plans it as steps, executes each step in a
 * bounded tool loop, adversarially verifies the work, and reports back —
 * interruptible and inspectable the whole way.
 *
 * Reliability is engineered in the harness, not the prompt (the design
 * target is a ~12B local model):
 *   - the plan is one forced-JSON call, capped at 6 steps, each naming the
 *     tool groups it needs — a step's LLM calls carry ONLY those groups
 *     plus core, and NO briefing (the goal + step is the context), keeping
 *     step prompts inside the same budget chat uses
 *   - steps end with a DONE:/FAILED: sentinel line; runaway caps bound
 *     iterations per step, tool calls per task, and wall-clock
 *   - the verify pass gets read-only tools only, then a tiny forced-JSON
 *     call turns its findings into per-step verdicts; failed steps re-run
 *     ONCE with the issue attached, then the report is honest about the rest
 *
 * Every tool call rides the SAME permission gate as chat
 * (AgentService._resolvePermission → confirm dialog → PermissionManager);
 * a denied permission pauses the task as awaiting_user instead of plowing on.
 *
 * Tasks persist in the `agent-tasks` StorageManager key (synced — it's user
 * content). A task interrupted by an app restart resumes as `paused`, never
 * auto-runs.
 */

const TaskService = {
    STORE_KEY: 'agent-tasks',
    MAX_TASKS: 30,

    // Budgets (per docs: per-step iteration caps, per-task budgets). Sized
    // for fan-out tasks ("find N things, look up a field for each") — the
    // ten-lead research run burned 6 rounds/step on one search per round and
    // died at 30 total calls with two steps unstarted (finding #37). The
    // horizon is deliberately long; what keeps it safe is PROGRESS GATING,
    // not the ceilings: identical-call stall detection fails a stuck step,
    // two consecutive failed steps abort the rest, and budget/time hits
    // pause the task (resumable) instead of killing it.
    MAX_STEPS: 8,
    MAX_STEP_ITERATIONS: 12,
    MAX_TOTAL_TOOL_CALLS: 120,
    MAX_WALL_CLOCK_MS: 30 * 60 * 1000,
    STEP_TIME_MS: 6 * 60 * 1000,
    MAX_VERIFY_ITERATIONS: 4,
    MODEL_ERROR_RETRIES: 2,
    MAX_CONTEXT_CHARS: 6000,
    // Replans per task: when a step fails, the harness asks the planner to
    // REVISE the remaining plan around the failure (different approach,
    // smaller batches) instead of marching the old plan into the same wall.
    // Bounded hard — a plan that keeps failing after two revisions is
    // blocked on something replanning can't fix.
    MAX_REPLANS: 2,
    // C9.1 foreach: per-item work runs in harness-owned chunks this big.
    // ~5 is the knee in the batch-degradation curve for small models —
    // past it they silently drop items; below it local latency dominates.
    FOREACH_CHUNK: 5,
    CHUNK_ITERATIONS: 8,
    // C9.2: per-step cap on what the results map stores. It rides the
    // synced agent-tasks blob until the task settles, so it must stay
    // bounded; overflow drops whole rows (never mid-row truncation).
    RESULT_STORE_CAP: 12000,

    _controls: new Map(),   // taskId -> { pause: bool, cancel: bool }

    // Task ids running IN THIS WINDOW right now. The tasks blob syncs, so a
    // stored 'running' status can belong to another Mac (or to a run this
    // window lost in a crash) — neither is work a reload here would destroy.
    // Maintained in _update, the single funnel every status change goes
    // through, and seeded at creation since 'planning' is stamped there.
    // Deliberately in-memory: a fresh page has, by definition, no runs.
    _activeRuns: new Set(),

    // ── Store ────────────────────────────────────────────────────────────

    _all() {
        const t = StorageManager.get(this.STORE_KEY);
        return Array.isArray(t) ? t : [];
    },

    _saveAll(tasks) {
        StorageManager.set(this.STORE_KEY, tasks.slice(0, this.MAX_TASKS));
    },

    get(taskId) {
        return this._all().find(t => t && t.id === taskId) || null;
    },

    list() {
        const tasks = this._all();
        return tasks;
    },

    _update(taskId, patch) {
        const tasks = this._all();
        const t = tasks.find(x => x && x.id === taskId);
        if (!t) return null;
        // Working-time bookkeeping rides the status transitions: entering a
        // busy state starts the clock, leaving one folds the stretch into
        // elapsedMs. The card's live timer shows elapsedMs (+ the running
        // stretch), so paused time never counts as work.
        if (patch.status) {
            const busy = ['planning', 'running', 'verifying'];
            if (busy.includes(patch.status) && !t.runStartedAt) {
                patch.runStartedAt = Date.now();
            } else if (!busy.includes(patch.status) && t.runStartedAt) {
                patch.elapsedMs = (t.elapsedMs || 0) + (Date.now() - t.runStartedAt);
                patch.runStartedAt = null;
            }
            // Same transition drives the live-run set a reload consults.
            if (busy.includes(patch.status)) this._activeRuns.add(taskId);
            else this._activeRuns.delete(taskId);
        }
        Object.assign(t, patch, { updatedAt: new Date().toISOString() });
        this._saveAll(tasks);
        this._notify(t);
        return t;
    },

    // ── C9.5 run journal (docs/TASK_ENGINE.md) ───────────────────────────
    //
    // Machine-local, append-only record of every tool call a run makes —
    // localStorage, NEVER a synced key (volatile execution state must not
    // ride synced blobs). Three consumers: exactly-once write replay (a
    // gate-retried or resumed step must not send the email twice), the
    // evidence-derived activity summary on the card and report, and
    // debugging. Pruned when the task settles; capped hard.
    JOURNAL_MAX_ENTRIES: 400,

    _journalKey(taskId) { return `task-journal-${taskId}`; },

    _journal(taskId) {
        try { return JSON.parse(localStorage.getItem(this._journalKey(taskId))) || []; }
        catch { return []; }
    },

    _journalAppend(taskId, entry) {
        try {
            const j = this._journal(taskId);
            j.push(entry);
            while (j.length > this.JOURNAL_MAX_ENTRIES) j.shift();
            localStorage.setItem(this._journalKey(taskId), JSON.stringify(j));
        } catch { /* journal is best-effort — never break the run */ }
    },

    _journalPrune(taskId) {
        try { localStorage.removeItem(this._journalKey(taskId)); } catch { /* fine */ }
    },

    /** Evidence-derived activity line ("web search ×12 · read url ×3") —
     *  what actually ran, counted from the journal, never model prose (I6). */
    _activitySummary(taskId) {
        const j = this._journal(taskId).filter(e => e && e.t === 'tool');
        if (!j.length) return '';
        const counts = new Map();
        for (const e of j) counts.set(e.name, (counts.get(e.name) || 0) + 1);
        const label = (n) => String(n).replace(/^mcp_[^_]+_/, '').replace(/_/g, ' ');
        return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
            .map(([n, c]) => c > 1 ? `${label(n)} ×${c}` : label(n)).join(' · ');
    },

    // C8.3: append one executed call to the task's replayable record.
    _recordToolCall(taskId, stepIndex, tool, args, result) {
        try {
            const tasks = this._all();
            const t = tasks.find(x => x && x.id === taskId);
            if (!t) return;
            if (!Array.isArray(t.toolLog)) t.toolLog = [];
            if (t.toolLog.length >= 40) { t.toolLogOverflow = true; return; }
            let entry = { step: stepIndex + 1, tool, ok: !(result && result.error) };
            let argsJson = '';
            try { argsJson = JSON.stringify(args ?? {}); } catch { argsJson = null; }
            if (argsJson !== null && argsJson.length <= 1500) entry.args = args ?? {};
            else entry.argsOmitted = true;
            t.toolLog.push(entry);
            this._saveAll(tasks);
        } catch { /* recording must never break the run */ }
    },

    _log(taskId, message) {
        const tasks = this._all();
        const t = tasks.find(x => x && x.id === taskId);
        if (!t) return;
        t.log.push({ at: new Date().toISOString(), message: String(message).slice(0, 500) });
        if (t.log.length > 100) t.log.splice(0, t.log.length - 100);
        this._saveAll(tasks);
    },

    _notify(task) {
        try {
            if (typeof AgentUI !== 'undefined' && AgentUI.onTaskUpdate) AgentUI.onTaskUpdate(task);
        } catch { /* display must never break the run */ }
        try {
            if (typeof CLIBridge !== 'undefined' && CLIBridge.onTaskUpdate) CLIBridge.onTaskUpdate(task);
        } catch { /* CLI stream must never break the run */ }
    },

    // How long after launch an interrupted unattended run picks itself back
    // up. Deliberately behind the model prewarm and the routine scheduler's
    // own 8s catch-up pass: a resumed run's first act is a model call, and a
    // cold llama-server load is the normal case at that moment.
    RESUME_DELAY_MS: 12000,

    /**
     * App-start hygiene: anything that was mid-flight when the app died
     * resumes as paused — an ATTENDED task must never auto-run on launch.
     *
     * An UNATTENDED one is the opposite case (TASK_ENGINE.md §v3.8). Nobody
     * is watching it, so "paused" is not a state anyone will discover: the
     * 16:58 invoice run sat silently paused until the user went looking.
     * Its arming was the consent, and I8's reconcile note + idempotency keys
     * are what make picking a write-bearing step back up safe — so it
     * resumes itself, and where it cannot, it says so out loud.
     */
    init() {
        const tasks = this._all();
        let changed = false;
        let resumable = 0;
        for (const t of tasks) {
            if (t && ['planning', 'running', 'verifying'].includes(t.status)) {
                t.status = 'paused';
                if (t.unattended) {
                    t.note = 'Paused by the app restarting — picking it back up.';
                    t.resumeOnLaunch = true;
                    resumable++;
                } else {
                    t.note = 'Paused by app restart — resume from the task card.';
                }
                changed = true;
            }
        }
        if (changed) this._saveAll(tasks);
        if (resumable) {
            setTimeout(() => { this._resumeUnattendedRuns(); }, this.RESUME_DELAY_MS);
        }
        // C9.5 hygiene: journals whose task settled without a report
        // (cancelled) or no longer exists must not pile up in localStorage.
        try {
            const live = new Set(tasks
                .filter(t => t && !['done', 'failed'].includes(t.status))
                .map(t => this._journalKey(t.id)));
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const k = localStorage.key(i);
                if (k && k.startsWith('task-journal-') && !live.has(k)) localStorage.removeItem(k);
            }
        } catch { /* cleanup is best-effort */ }
    },

    /** A human took over — the run is theirs now, not the launch sweep's. */
    _clearResumeFlag(taskId) {
        const tasks = this._all();
        const t = tasks.find(x => x && x.id === taskId);
        if (t && t.resumeOnLaunch) { delete t.resumeOnLaunch; this._saveAll(tasks); }
    },

    /**
     * §v3.8 — resume-or-notify. Never silence.
     *
     * Deliberately NOT `resume()`: that marks the run attended, which would
     * make its next `ask` open a dialog nobody is present to click — the
     * exact stall C8.5 was built to avoid. One task slot, so the rest keep
     * their flag and are picked up when this one settles (see _report) or on
     * the next launch, whichever comes first.
     */
    async _resumeUnattendedRuns() {
        // A run interrupted before it had a plan has nothing to pick up;
        // settling it honestly beats leaving it paused forever.
        for (const t of this._all().filter(t => t && t.resumeOnLaunch && t.status === 'paused')) {
            if (!Array.isArray(t.plan) || !t.plan.length) {
                this._clearResumeFlag(t.id);
                this._update(t.id, { status: 'failed', note: 'The app restarted before this run had a plan — it did not run.' });
                this._notifySystem('A routine run did not survive a restart', t.goal);
            }
        }
        const pending = this._all().filter(t => t && t.resumeOnLaunch && t.status === 'paused');
        if (!pending.length) return;
        const goal = String(pending[0].goal || '').slice(0, 100);

        if (this._all().some(t => ['planning', 'running', 'verifying'].includes(t?.status))) {
            this._notifySystem('A routine run is waiting', `${goal} — it resumes when the current task finishes.`);
            return;
        }
        if (typeof AgentService === 'undefined' || !this._model()) {
            this._notifySystem('A routine run is paused', `${goal} — no model is selected, so it could not resume.`);
            return;
        }

        const t = pending[0];
        this._clearResumeFlag(t.id);
        this._controls.set(t.id, { pause: false, cancel: false });
        this._log(t.id, 'resumed automatically after an app restart (unattended run)');
        this._update(t.id, { status: 'running', note: 'Resumed automatically after the app restarted.' });
        this._notifySystem('Anjadhe resumed a routine run', t.goal);
        this._run(t.id);
    },

    // ── LLM plumbing (same seam the engines use — one brain) ─────────────

    _model() {
        if (typeof AgentService !== 'undefined' && AgentService.getActiveModel) {
            const m = AgentService.getActiveModel(AgentService.activeConversationId);
            if (m) return m;
        }
        return StorageManager.get('agent-settings')?.selectedModel || null;
    },

    // Metered-brain pacing + informed throttle retries (I4; ISSUES.md #2a).
    // Anjadhe Cloud's free tier allows 30 requests/minute and 2 concurrent,
    // and one agentic step turn can legitimately make ~16 calls — on a
    // ~1s/call cloud brain the engine outruns its own quota and the run's
    // LAST call dies over work already done. Same 2.5s spacing (and reason)
    // as the email drain; local brains pace themselves by inference time.
    TASK_CALL_SPACING_MS: 2500,
    THROTTLE_RETRIES: 2,
    _lastChatAt: 0,

    async _chat(params) {
        // Same remote-entry routing as LLMLogger: a server/cloud brain needs
        // its entry's API key resolved in main, or task-mode calls fail with
        // "Invalid API key" while chat works.
        const routing = (typeof AgentService !== 'undefined' && AgentService.remoteEntryRouting)
            ? AgentService.remoteEntryRouting() : {};
        const metered = (typeof AgentService !== 'undefined') && !!AgentService.isMeteredBrain?.();
        for (let attempt = 0; ; attempt++) {
            if (metered) {
                const wait = this._lastChatAt + this.TASK_CALL_SPACING_MS - Date.now();
                if (wait > 0) await new Promise(r => setTimeout(r, wait));
            }
            this._lastChatAt = Date.now();
            const resp = await window.electronLLM.chat({ model: this._model(), think: false, ...routing, ...params });
            // A cloud throttle (rate/busy) is I4-Transient with a KNOWN
            // reopen time — retry here with the server's retry-after
            // honored. The generic 2s/4s backoffs downstream all land
            // inside a still-closed 60s window and burn the caller.
            const throttleMs = (typeof AgentService !== 'undefined' && AgentService.throttleWaitFrom)
                ? AgentService.throttleWaitFrom(resp) : 0;
            if (!throttleMs || attempt >= this.THROTTLE_RETRIES) return resp;
            console.warn(`[task] throttled (${resp.errorCode}): waiting ${Math.round(throttleMs / 1000)}s before retry ${attempt + 1}`);
            await new Promise(r => setTimeout(r, Math.min(throttleMs, 75000)));
        }
    },

    // Forced-JSON call with a real schema as `format` — llama-server compiles
    // it into a sampling grammar so the SHAPE is decode-time enforced, not
    // prompt discipline (C8.1). Schemas stay shallow (declared-property
    // objects are closed on the llama.cpp grammar path). A server that
    // rejects json_schema gets one downgrade to plain format:'json'.
    async _jsonChat(params, schema) {
        const resp = await this._chat({ ...params, format: schema });
        if (resp?.error && schema && typeof schema === 'object') {
            console.warn(`[task] ${params.logTag || 'json call'}: schema format rejected (${String(resp.error).slice(0, 120)}) — retrying as plain json`);
            return await this._chat({ ...params, format: 'json' });
        }
        return resp;
    },

    // Tool groups that exist right now (feature flags trim files/shell/mcp).
    // Mini-app registrations (userapp:*) stay out of tasks, but MCP servers
    // are first-class capabilities: their internal group `userapp:mcp:<name>`
    // is exposed to the planner under the alias `mcp:<name>`. Excluding them
    // entirely was the CNBC failure — the model was handed a browser task
    // with no browser tools and honestly refused every step.
    _availableGroups() {
        const groups = new Set(Object.values(AgentTools._toolGroups));
        return [...groups]
            .filter(g => !g.startsWith('userapp:') || g.startsWith('userapp:mcp:'))
            .map(g => g.startsWith('userapp:mcp:') ? g.slice('userapp:'.length) : g);
    },

    /**
     * Deterministic capability routing: when the GOAL itself names a
     * domain, every step gets that domain's tools regardless of what the
     * planner wrote per step — a small model routinely mislabels which
     * step needs which group, and a step without its tools can only fail
     * (the browser version of this was the CNBC failure; the email version
     * was the NVDA-transactions failure of 2026-07-28).
     */
    _impliedGroups(goalText) {
        const goal = String(goalText || '');
        const implied = [];
        if (typeof MCPTools !== 'undefined' && MCPTools.browserServers && MCPTools.browserServers.size
            && /(browser|browse|website|web ?page|screenshot|navigate|url|www\.|https?:\/\/|\.com\b|\.org\b)/i.test(goal)) {
            for (const s of MCPTools.browserServers) implied.push(`mcp:${s}`);
        }
        if (/\b(e-?mails?|inbox|gmail|mailbox)\b/i.test(goal)) implied.push('email');
        // Files (finding #52 — the CNBC class in the fs domain): a goal
        // naming a folder, files, or document types must carry the files
        // group on EVERY step — the doc-family live run planned its foreach
        // with 'shell' only, and the chunks fought read_url with file: URLs
        // while fs_read (with the C8.2 PDF extractors) sat unshipped.
        if (/\b(files?|folders?|director(?:y|ies)|pdfs?|documents?|invoices?|spreadsheets?|\.(?:pdf|csv|xlsx|docx|txt|md))\b/i.test(goal)
            || /(?:^|[\s"'])(?:~\/|\/(?:Users|tmp|home|var|private)\/)/.test(goal)) {
            implied.push('files');
        }
        if (/\b(portfolio|stocks?|holdings?|shares|tickers?|trades?|brokerage)\b/i.test(goal)) implied.push('portfolio');
        if (/\b(calendar|meetings?|appointments?)\b/i.test(goal)) implied.push('calendar');
        if (/\b(journal|diary)\b/i.test(goal)) implied.push('journal');
        if (/\b(goals?|focus areas?)\b/i.test(goal)) implied.push('goals');
        // Routines (2026-08-03, the same C10 regression that hit chat's
        // _domainsForMessage — fixed there, missed here). "Help me set up an
        // automation. Every time I get an invoice email, create a task" got
        // planned as one `help` step, and the model answered "I don't have a
        // create_routine function" while the handler sat right there. The
        // planner picks groups per step and a small model routinely picks
        // wrong; a goal that says "automation" always needs these.
        if (/\b(routines?|automations?|automate|automatic(ally)?|recurring|scheduled? prompts?)\b/i.test(goal)
            || /\b(every|each) time\b/i.test(goal)
            || /\bwhenever\b/i.test(goal)) implied.push('prompts');
        return implied;
    },

    _toolsForGroups(groupNames, extraGroups, untrusted = false) {
        const wanted = new Set([...(groupNames || []), ...(extraGroups || [])]);
        // Same gating as chat: with the master toggle off, the web_search
        // schema must not ship — a step that calls it gets an error it tends
        // to read as "no web at ALL" and abandons browser/read_url work
        // it could have done.
        const searchOff = typeof AgentService !== 'undefined' && AgentService._webSearchReady === false;
        // Prompt-injection backstop for a run whose INPUT is attacker-supplied
        // (a routine fired by an incoming email, now able to read that email's
        // attachments). Chat applies the same list via AppManager.currentApp;
        // a headless run has no current app, so it has to be carried on the
        // task. ONE list, in AgentService, blocked at both points.
        const blocked = (untrusted && typeof AgentService !== 'undefined' && AgentService.UNTRUSTED_BLOCKED_TOOLS)
            ? AgentService.UNTRUSTED_BLOCKED_TOOLS : null;
        return AgentTools.definitions.filter(d => {
            const g = AgentTools._toolGroups[d.function.name] || 'core';
            if (d.function.name === 'start_task') return false;  // no nesting
            if (searchOff && d.function.name === 'web_search') return false;
            if (blocked && blocked.has(d.function.name)) return false;
            const alias = g.startsWith('userapp:mcp:') ? g.slice('userapp:'.length) : g;
            return g === 'core' || wanted.has(g) || wanted.has(alias);
        });
    },

    /**
     * Snapshot the tail of the originating conversation. The goal alone is
     * NOT the whole request — "research the movies listed above" references
     * conversation content the task loop can never see (steps deliberately
     * run without chat's briefing), and the 100-movie streaming task died
     * exactly there: the planner planned "extract the list from conversation
     * history", a step that was impossible by construction. Text turns only
     * (tool traffic and image parts don't carry the user's data), newest
     * kept, capped so step prompts stay inside a small model's budget.
     */
    _conversationContext(conversationId) {
        try {
            if (!conversationId || typeof AgentService === 'undefined') return '';
            const conv = (AgentService.conversations || []).find(c => c && c.id === conversationId);
            if (!conv || !Array.isArray(conv.messages)) return '';
            const lines = [];
            let total = 0;
            for (let i = conv.messages.length - 1; i >= 0 && lines.length < 20; i--) {
                const m = conv.messages[i];
                if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
                let text = '';
                if (typeof m.content === 'string') text = m.content;
                else if (Array.isArray(m.content)) {
                    text = m.content.filter(p => p && p.type === 'text' && typeof p.text === 'string')
                        .map(p => p.text).join('\n');
                }
                text = String(text || '').trim();
                // Attachment text rides along (finding #48): stored messages
                // keep file attachments BESIDE content, not in it, so a task
                // over an attached list/PDF used to see only the user's
                // one-line ask. Images can't become text here — start()
                // transcribes those with one vision call.
                if (m.role === 'user' && Array.isArray(m.attachments)) {
                    for (const a of m.attachments) {
                        if (a && a.kind !== 'image' && typeof a.content === 'string' && a.content.trim()) {
                            text += `${text ? '\n' : ''}[Attached file ${a.name || ''}]:\n${a.content.slice(0, 3000)}`;
                        }
                    }
                }
                if (!text) continue;
                const line = `${m.role === 'user' ? 'User' : 'Assistant'}: ${text.slice(0, 4000)}`;
                if (lines.length && total + line.length > this.MAX_CONTEXT_CHARS) break;
                lines.push(line);
                total += line.length;
            }
            return lines.reverse().join('\n\n');
        } catch { return ''; }
    },

    /** Data-URL images attached to the conversation's newest user messages
     *  (stored messages keep attachments beside content, not in it). */
    _conversationImages(conversationId) {
        try {
            if (!conversationId || typeof AgentService === 'undefined') return [];
            const conv = (AgentService.conversations || []).find(c => c && c.id === conversationId);
            if (!conv || !Array.isArray(conv.messages)) return [];
            const urls = [];
            for (let i = conv.messages.length - 1; i >= 0 && urls.length < 3; i--) {
                const m = conv.messages[i];
                if (!m || m.role !== 'user' || !Array.isArray(m.attachments)) continue;
                for (const a of m.attachments) {
                    if (a && a.kind === 'image' && typeof a.dataUrl === 'string'
                        && /^data:image\//.test(a.dataUrl) && urls.length < 3) {
                        urls.push(a.dataUrl);
                    }
                }
            }
            return urls.reverse();
        } catch { return []; }
    },

    // ── Lifecycle ─────────────────────────────────────────────────────────

    /**
     * Create a task and produce its plan. Ends in `awaiting_user` — the
     * plan-approval card is the consent moment; nothing executes before
     * approve().
     */
    async start(goal, conversationId, opts = {}) {
        const text = String(goal || '').trim();
        if (!text) return { error: 'goal required' };
        if (this._all().some(t => ['planning', 'running', 'verifying'].includes(t?.status))) {
            return { error: 'Another task is already running. One task at a time.' };
        }

        const task = {
            id: 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            // C8.5: an armed automation started this without a human present.
            // The arming was the explicit consent; asks still PAUSE (never
            // auto-approve) and fire a system notification instead of a
            // dialog nobody is there to click.
            unattended: !!opts.unattended,
            // C10: the routine that armed this run, if any. Its result posts
            // to that routine's feed series when the task settles.
            routineId: opts.routineId || null,
            // The goal itself carries attacker-supplied content (an incoming
            // email's subject/sender, a dropped file's name) and the run will
            // go on to READ that email or file. Withholds the irreversible
            // tool classes for every step — see _toolsForGroups.
            untrustedInput: !!opts.untrustedInput,
            conversationId: conversationId || null,
            goal: text,
            // Persisted with the task so a resume after an app restart still
            // has it; pruned when the task settles (_report) — dead weight in
            // the synced blob after that.
            context: this._conversationContext(conversationId),
            plan: [],
            // C9.2: the results map — each step's full structured output,
            // keyed by 1-based step number. Steps consume earlier output by
            // reference ($N); data never round-trips through model prose.
            // Pruned on settle (it rides the synced blob until then).
            results: {},
            status: 'planning',
            note: '',
            stepIndex: 0,
            retried: false,
            toolCalls: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            log: [],
            // C8.3: the recorded tool sequence a clean run can be saved from.
            // Kept only while it might become a recipe (_report prunes it).
            toolLog: []
        };
        this._saveAll([task, ...this._all()]);
        this._controls.set(task.id, { pause: false, cancel: false });
        // 'planning' is stamped on the literal above, not through _update,
        // so the live-run set is seeded by hand here.
        this._activeRuns.add(task.id);
        this._notify(task);

        // Finding #48: data that exists only as an attached IMAGE (a
        // screenshotted list) never reaches the text-only context snapshot —
        // the third live 100-movie run planned fine and then every step
        // honestly reported "no titles were provided in the context". One
        // vision call at start turns the pixels into text ONCE; the planner
        // and every step then work from ordinary text state.
        try {
            const images = this._conversationImages(conversationId);
            if (images.length) {
                try { await AgentService.ensureVisionInfo(); } catch { /* stays cached/null */ }
                // Per-purpose capability routing (deterministic, never model
                // judgment): this ONE call needs vision. When the task brain
                // can't see, an installed vision-capable model serves it —
                // logged, never silent. No vision anywhere → unchanged
                // honest behavior (steps report what they couldn't read).
                let visionModel;
                if (AgentService.supportsVision(AgentService.getActiveEntry(conversationId))) {
                    visionModel = null;   // the active brain serves the call
                } else {
                    const alt = (AgentService.getModelList() || []).find(e =>
                        e && !AgentService.isRemoteEngine(e.engine) && AgentService.supportsVision(e));
                    visionModel = alt ? alt.model : undefined;
                    if (visionModel) this._log(task.id, `image transcription routed to ${visionModel} (the active brain has no vision)`);
                }
                if (visionModel !== undefined) {
                    const resp = await this._chat({
                        ...(visionModel ? { model: visionModel } : {}),
                        messages: [
                            { role: 'system', content: 'Transcribe the data in the attached image(s) that the goal needs. Lists IN FULL — every numbered item, exactly as written — tables as plain lines. No commentary, no summarizing, no omissions.' },
                            { role: 'user', content: [
                                { type: 'text', text: `Goal: ${text}\nTranscribe everything in the image(s) that this goal refers to.` },
                                ...images.map(u => ({ type: 'image_url', image_url: { url: u } }))
                            ] }
                        ],
                        options: { num_predict: 3000 },
                        maxTokens: 3000,
                        logTag: 'task-image-extract'
                    });
                    const extracted = String(resp?.message?.content || '').trim();
                    if (extracted) {
                        const tasks = this._all();
                        const t = tasks.find(x => x && x.id === task.id);
                        if (t) {
                            t.context = (t.context ? t.context + '\n\n' : '')
                                + 'Data transcribed from the image(s) attached in the conversation:\n'
                                + extracted.slice(0, 8000);
                            this._saveAll(tasks);
                            task.context = t.context;
                        }
                        this._log(task.id, `transcribed ${extracted.length} chars from ${images.length} attached image(s)`);
                    }
                }
            }
        } catch { /* no transcription — steps will say honestly what's missing */ }

        // Intake readiness gate (I1): a goal that REFERS to material ("the
        // list", "the attached…") must have that material in hand BEFORE
        // planning — run #48 burned two replans rediscovering an absence
        // knowable in one look. Deterministic pre-filter so ordinary goals
        // skip the call; the check itself is told to pass when unsure, so
        // it only stops truly doomed tasks.
        try {
            if (this._goalReferencesMaterial(text)) {
                const gateResp = await this._jsonChat({
                    messages: [
                        // STARTING material vs DELIVERABLE, spelled out: the
                        // first live run of this gate blocked a valid task
                        // because "the material does not contain streaming
                        // availability" — the thing the task existed to FIND.
                        { role: 'system', content: 'A task is about to run with tools (web search, files, apps) — it will GATHER new information itself, so missing ANSWERS or results are expected and fine. You check ONE thing only: the STARTING MATERIAL. The goal refers to something the user provided (a list, a document, pasted text). Is that referenced material present below? Present (even partially, even messy) → ready:true. Reply ready:false ONLY when the referenced starting material itself is absent (the goal says "the list above" and there is no list at all). When unsure, ready:true. JSON only: {"ready":true,"missing":""} — missing names the absent STARTING material, never the answers the task will go find.' },
                        { role: 'user', content: `Goal: ${text}\n\nMaterial:\n${(this.get(task.id)?.context || '(none)').slice(0, 8000)}` }
                    ],
                    options: { num_predict: 200 },
                    maxTokens: 200,
                    logTag: 'task-intake'
                }, {
                    type: 'object',
                    properties: { ready: { type: 'boolean' }, missing: { type: 'string' } },
                    required: ['ready', 'missing']
                });
                const g = JSON.parse(gateResp?.message?.content || '{}');
                if (g.ready === false && String(g.missing || '').trim()) {
                    const missing = String(g.missing).trim().slice(0, 200);
                    this._update(task.id, { status: 'failed', note: `Can't start: ${missing} — add it to the chat and start the task again.` });
                    if (task.unattended) this._notifySystem('Anjadhe task could not start', missing);
                    return { error: `missing input: ${missing}` };
                }
            }
        } catch { /* unreadable gate → proceed; the plan lints are the next net */ }

        // Task-grade advice (docs/TASK_ENGINE.md): multi-step reliability is
        // a MODEL property. When the active brain isn't certified for tasks
        // and an installed one is, the plan card says so with a one-tap
        // switch — the USER decides; the harness never swaps brains silently.
        try {
            if (!task.unattended) {
                await AgentService.ensureVisionInfo();
                const entry = AgentService.getActiveEntry(conversationId);
                if (!AgentService.isTaskGrade(entry)) {
                    const alt = (AgentService.getModelList() || []).find(e =>
                        e && !AgentService.isRemoteEngine(e.engine) && AgentService.isTaskGrade(e));
                    if (alt) {
                        this._update(task.id, { brainAdvice: {
                            current: (entry && entry.model) || 'the current model',
                            recommended: alt.model
                        } });
                    }
                }
            }
        } catch { /* advice is optional — never block the task */ }

        const groups = this._availableGroups();
        // The plan must reflect what's actually usable: with the web-search
        // toggle off, a "search the web" step is unrunnable, but URL reading
        // and connected browser tools still work.
        let searchOff = false;
        try { searchOff = (await AgentService._ensureWebSearchState(true)) === false; } catch { /* keep last known */ }
        let coreLine = searchOff
            ? 'Steps may also rely on always-available core tools (reading a web page by URL, notes, schedule list). Web SEARCH is turned off in the user\'s settings — never plan a "search the web" step; plan around known URLs and browser tools instead.'
            : 'Steps may also rely on always-available core tools (search, web, notes, schedule list).';
        // Browser plans have a physical constraint a small model doesn't
        // know: one page open at a time. "Navigate to all pages" as its own
        // step is pure wasted work — each navigation overwrites the last.
        if (this._impliedGroups(text).length) {
            coreLine += ' Browser rule: the browser shows ONE page at a time — for multi-page work, make one step that handles EACH page fully (navigate, read, extract) before the next page; never plan a separate "navigate to all pages" step.';
        }
        // Planning gets the same engine-down patience as steps (C8.5): an
        // automation firing at 7am against a cold llama-server is the NORMAL
        // unattended case — the model may need a minute to load. Without
        // this, every first-of-the-morning automation failed at planning.
        const planWithRetry = async () => {
            for (let attempt = 0; ; attempt++) {
                const resp = await this._planChat(text, groups, coreLine, task.context);
                if (!resp?.error) return resp;
                const engineDown = /not running|no server|still loading|loading the model|timed out|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|network/i.test(resp.error);
                const maxRetries = engineDown ? 4 : this.MODEL_ERROR_RETRIES;
                if (attempt >= maxRetries) return resp;
                this._log(task.id, `planning model error (retry ${attempt + 1}): ${resp.error}`);
                // A throttle that leaked past _chat's own retries carries a
                // known reopen time — waiting less than that burns the retry.
                const throttleMs = AgentService.throttleWaitFrom?.(resp) || 0;
                await new Promise(r => setTimeout(r, throttleMs ? Math.min(throttleMs, 75000) : (engineDown ? 15000 : 2000 * (attempt + 1))));
            }
        };
        const planResp = await planWithRetry();
        if (planResp?.error) {
            return this._update(task.id, { status: 'failed', note: `Planning failed: ${planResp.error}` }) && { error: planResp.error };
        }

        let steps = this._parsePlanSteps(planResp, groups);
        // C9.1 plan-shape guard: when the goal is per-item work over many
        // items, the SHAPE of the plan is knowable before anything runs —
        // a plan without a foreach step is wrong by inspection, and the
        // first live run proved prompt guidance alone doesn't make a 26B
        // comply (finding #46: one mega-step, "1 of 1"). One pointed
        // revision round; if the model still won't emit foreach, the
        // harness plans the shape itself — do-fail-replan is for
        // surprises, never for structure known up front.
        const lint = steps.length ? this._lintPlanShape(text, steps) : null;
        if (lint) {
            this._log(task.id, `plan shape: ${lint} — asking for a revision`);
            const fixResp = await this._planChat(text, groups, coreLine, task.context, lint);
            const fixed = fixResp?.error ? [] : this._parsePlanSteps(fixResp, groups);
            if (fixed.length && !this._lintPlanShape(text, fixed)) {
                steps = fixed;
            } else {
                steps = await this._fallbackForeachPlan(text, fixed.length ? fixed : steps);
                this._log(task.id, 'plan shape: model would not emit foreach — using the harness fan-out plan');
            }
        }
        if (!steps.length) {
            this._update(task.id, { status: 'failed', note: 'The model could not produce a usable plan for this goal.' });
            return { error: 'no usable plan' };
        }
        steps = this._ensureDeliveryStep(steps);

        this._log(task.id, `Planned ${steps.length} steps`);
        if (task.unattended) {
            // The user armed this to run without them — plan approval is the
            // arming, not a dialog nobody is present to click.
            this._update(task.id, { plan: steps, status: 'running', note: '' });
            this._notifySystem('Anjadhe started an automated task', text);
            this._run(task.id);
        } else {
            this._update(task.id, { plan: steps, status: 'awaiting_user', note: 'Review the plan, then run it.' });
        }
        return { ok: true, taskId: task.id, steps: steps.map(s => s.step) };
    },

    /** I5 delivery guarantee: a plan whose LAST step is a foreach ends at
     *  raw rows — the first real-search run did the work and still failed
     *  its goal verdict ("a compiled table" missing) because nothing
     *  compiled them (finding #50). Deterministic append, no model call:
     *  the goal text rides into the step, so generic wording resolves at
     *  run time. */
    _ensureDeliveryStep(steps) {
        if (Array.isArray(steps) && steps.length && steps.length < this.MAX_STEPS
            && steps[steps.length - 1].kind === 'foreach') {
            steps = [...steps, {
                kind: 'single', status: 'pending', note: '',
                tools: steps[steps.length - 1].tools || [],
                step: 'Compile the per-item results into the deliverable the goal asks for (table, note, or summary), using the rows from the previous step.'
            }];
        }
        return steps;
    },

    /** Intake pre-filter (I1): does the goal REFER to material it expects
     *  to be in hand? Only these goals pay for the readiness check. */
    _goalReferencesMaterial(goal) {
        return /\b(the|this|these|that|those)\s+(list|movies?|items?|emails?|files?|documents?|data|numbers?|names?|table|titles?)\b|\battach(?:ed|ment)|\bprovided\b|\babove\b|\bin the (chat|conversation|image)\b/i
            .test(String(goal || ''));
    },

    /** C9.1: is this plan the right SHAPE for the goal? Conservative on
     *  purpose — it only fires when the goal explicitly reads as per-item
     *  work ("for each …", or "each/every/all" alongside a count ≥ 10)
     *  and the plan carries no foreach step. Returns the objection, or
     *  null when the shape is fine. */
    _lintPlanShape(goalText, steps) {
        if (steps.some(s => s.kind === 'foreach')) return null;
        const g = String(goalText || '');
        const explicit = /\bfor (?:each|every)\b/i.test(g);
        const count = parseInt((g.match(/\b(\d{2,4})\b/) || [])[1], 10);
        const many = count >= 10 && /\b(each|every|all)\b/i.test(g);
        if (explicit || many) {
            return 'the goal is per-item work over many items, but the plan has no kind:"foreach" step — one giant step will fail';
        }
        return null;
    },

    /** The harness's own fan-out plan, used when the planner refuses to
     *  emit foreach for an obviously per-item goal. The STRUCTURE is
     *  non-negotiable (list step → foreach), but the wording the user
     *  reviews must be the goal's, not machinery's ("list every item the
     *  goal asks to process" reads generic — the user rejected exactly
     *  that): one tiny schema-forced fill-in call writes goal-specific
     *  step text and the per-item instruction. Generic text survives
     *  only as the last-resort default when even the fill-in fails.
     *  Tools are inherited from the rejected plan — the model usually
     *  named the right groups even when it got the shape wrong. */
    async _fallbackForeachPlan(goalText, rejected) {
        const tools = [...new Set((rejected || []).flatMap(s => s.tools || []))];
        let fill = null;
        try {
            const resp = await this._jsonChat({
                messages: [
                    { role: 'system', content:
                        'A plan\'s STRUCTURE is already decided: step 1 produces the list of items, step 2 processes the items one by one in small batches, step 3 compiles the results into the deliverable the goal asks for. You write only the WORDING, specific to the goal.\n' +
                        'Reply ONLY with JSON: {"list_step":"imperative sentence for step 1, naming the actual items","work_step":"imperative sentence for step 2, naming the actual per-item work","per_item":"what to do for ONE item — imperative, specific","deliver_step":"imperative sentence for step 3, naming the actual deliverable (the table, note, summary the goal asks for)"}.' },
                    { role: 'user', content: `Goal: ${goalText}` }
                ],
                options: { num_predict: 400 },
                maxTokens: 400,
                logTag: 'task-plan-fill'
            }, {
                type: 'object',
                properties: {
                    list_step: { type: 'string' },
                    work_step: { type: 'string' },
                    per_item: { type: 'string' },
                    deliver_step: { type: 'string' }
                },
                required: ['list_step', 'work_step', 'per_item', 'deliver_step']
            });
            fill = JSON.parse(resp?.message?.content || '');
        } catch { fill = null; }
        const listStep = String(fill?.list_step || '').trim().slice(0, 200)
            || 'List every item the goal asks to process, one per line, from the goal and the conversation above.';
        const workStep = String(fill?.work_step || '').trim().slice(0, 200)
            || 'Work through the items in small batches, doing what the goal asks for each one.';
        const perItem = String(fill?.per_item || '').trim().slice(0, 300)
            || 'Do exactly what the goal asks, for this ONE item, and report what you found.';
        // The delivery step is what run #45 was missing: a fan-out that ends
        // at raw rows never produced the table/note the user asked for.
        const deliverStep = String(fill?.deliver_step || '').trim().slice(0, 200)
            || 'Compile the per-item results into the format the goal asks for.';
        return [
            { kind: 'single', status: 'pending', note: '', tools, step: listStep },
            { kind: 'foreach', status: 'pending', note: '', tools, itemsFrom: 1, perItem, step: workStep },
            { kind: 'single', status: 'pending', note: '', tools, step: deliverStep }
        ];
    },

    /** Model plan JSON → validated step objects (shared by the initial
     *  plan and replans). Post-conditions kept only when well-formed and
     *  actually checkable (a check without an arg is noise). C9.1: a
     *  foreach step must reference an EARLIER step for its item list and
     *  say what to do per item, or it downgrades to single — a malformed
     *  foreach must degrade to the old behavior, never crash the run.
     *  `baseIndex` is how many already-planned steps precede these (0 for
     *  the initial plan; failedIndex+1 for a replan's replacement tail),
     *  so $N references validate against FINAL plan positions. */
    _parsePlanSteps(planResp, groups, baseIndex = 0) {
        try {
            const parsed = JSON.parse(planResp?.message?.content || '{}');
            return (parsed.steps || [])
                .filter(s => s && typeof s.step === 'string' && s.step.trim())
                .slice(0, this.MAX_STEPS)
                .map((s, pos) => {
                    const out = {
                        step: s.step.trim().slice(0, 200),
                        tools: (Array.isArray(s.tools) ? s.tools : []).filter(t => groups.includes(t)),
                        status: 'pending',
                        note: '',
                        kind: 'single'
                    };
                    const ref = /^\$(\d+)$/.exec(String(s.items_from || '').trim());
                    const refN = ref ? parseInt(ref[1], 10) : 0;
                    if (s.kind === 'foreach' && refN >= 1 && refN < baseIndex + pos + 1
                        && String(s.per_item || '').trim()) {
                        out.kind = 'foreach';
                        out.itemsFrom = refN;
                        out.perItem = String(s.per_item).trim().slice(0, 300);
                    }
                    const c = s.check;
                    if (c && typeof c === 'object' && c.kind && c.kind !== 'none'
                        && ['file_exists', 'note_titled', 'schedule_item_titled'].includes(c.kind)
                        && String(c.arg || '').trim()) {
                        out.check = { kind: c.kind, arg: String(c.arg).trim().slice(0, 300) };
                    }
                    return out;
                });
        } catch { return []; }
    },

    /** The steps schema both plan calls share — the enum makes hallucinated
     *  group names unemittable (C8.1), and check kinds stay well-formed
     *  (C8.4). */
    _planSchema(groups) {
        return {
            type: 'object',
            properties: {
                steps: {
                    type: 'array', maxItems: this.MAX_STEPS,
                    items: {
                        type: 'object',
                        properties: {
                            kind: { type: 'string', enum: ['single', 'foreach'] },
                            step: { type: 'string' },
                            tools: { type: 'array', items: groups.length ? { type: 'string', enum: groups } : { type: 'string' } },
                            items_from: { type: 'string' },
                            per_item: { type: 'string' },
                            check: {
                                type: 'object',
                                properties: {
                                    kind: { type: 'string', enum: ['none', 'file_exists', 'note_titled', 'schedule_item_titled'] },
                                    arg: { type: 'string' }
                                },
                                required: ['kind', 'arg']
                            }
                        },
                        required: ['kind', 'step', 'tools', 'items_from', 'per_item', 'check']
                    }
                }
            },
            required: ['steps']
        };
    },

    /** The plan call itself — schema-constrained (C8.1), post-condition
     *  aware (C8.4). Split from start() so the retry wrapper stays legible.
     *  `reviseNote` is the plan-shape lint's objection — one pointed
     *  re-ask before the harness plans the shape itself. */
    _planChat(text, groups, coreLine, context, reviseNote) {
        return this._jsonChat({
            messages: [
                { role: 'system', content:
                    'You break a user goal into a SHORT checklist of concrete steps for an assistant that has tools.\n' +
                    `Available tool groups: ${groups.join(', ')}. ${coreLine}\n` +
                    'Reply ONLY with JSON: {"steps":[{"kind":"single","step":"imperative description","tools":["group",...],"items_from":"","per_item":"","check":{"kind":"none","arg":""}}]}\n' +
                    `Rules: at most ${this.MAX_STEPS} steps; each step one action; tools lists only groups from the list above (may be empty). Prefer the FEWEST steps the goal needs — a simple goal is 1–2 steps.\n` +
                    'kind: "single" is one action (items_from and per_item stay ""). When the SAME work applies to EACH of several items (look something up for every movie, every contact, every article), plan ONE step with kind:"foreach": items_from = "$N" naming the earlier step whose output is the item list, per_item = what to do for ONE item. The app runs foreach steps item by item, which is far more reliable — NEVER write a single step that says "for all N items…".\n' +
                    'When a conversation transcript follows the goal, the facts in it are already in hand for every step — never plan a step to retrieve, extract, or look up things from conversation history (but a step that LISTS items already present in the transcript is fine as a foreach\'s item source).\n' +
                    'check = a POST-CONDITION the app verifies mechanically after the step runs. Use it when the outcome is objectively checkable: {"kind":"file_exists","arg":"<full path the step creates>"} or {"kind":"note_titled","arg":"<note title>"} or {"kind":"schedule_item_titled","arg":"<task title>"}. Otherwise {"kind":"none","arg":""}.' },
                { role: 'user', content: `Goal: ${text}`
                    + (context ? `\n\nConversation that led to this goal (data the goal references may already be here):\n${context}` : '')
                    + (reviseNote ? `\n\nREVISION REQUIRED — your previous plan was rejected: ${reviseNote}. Re-plan: one step that produces the item list, then ONE kind:"foreach" step with items_from pointing at it ("$1") and a per_item instruction. Add other steps only if the goal needs them.` : '') }
            ],
            options: { num_predict: 800 },
            maxTokens: 800,
            logTag: 'task-plan'
        }, this._planSchema(groups));
    },

    /**
     * Replan the REMAINDER after a step failed: the planner sees the goal,
     * the conversation context, and every step's outcome (including the
     * failure), and returns replacement steps for the not-yet-done part —
     * a different approach, not the same step re-issued. Empty steps means
     * "only the user can fix this" and the caller falls back to the normal
     * failure path. Bounded by MAX_REPLANS.
     */
    async _replan(taskId, failedIndex) {
        const task = this.get(taskId);
        if (!task) return false;
        const groups = this._availableGroups();
        const searchOff = typeof AgentService !== 'undefined' && AgentService._webSearchReady === false;
        const coreLine = searchOff
            ? 'Web SEARCH is turned off — never plan a "search the web" step; plan around known URLs and browser tools instead.'
            : 'Always-available core tools also exist (search, web, notes, schedule list).';
        const failed = task.plan[failedIndex];
        const resp = await this._jsonChat({
            messages: [
                { role: 'system', content:
                    'A step of a running plan FAILED. You revise the rest of the plan.\n' +
                    `Available tool groups: ${groups.join(', ')}. ${coreLine}\n` +
                    'Reply ONLY with JSON: {"steps":[{"kind":"single","step":"imperative description","tools":["group",...],"items_from":"","per_item":"","check":{"kind":"none","arg":""}}]} — these steps REPLACE everything not yet done.\n' +
                    'kind: "single" is one action (items_from and per_item stay ""). For per-item work use ONE step with kind:"foreach": items_from = "$N" naming the earlier step whose output is the item list, per_item = what to do for ONE item — the app runs it item by item.\n' +
                    `Rules: at most ${this.MAX_STEPS} steps; address the failure with a DIFFERENT approach (per-item foreach, a different tool or source, splitting one big step into several) — never re-issue the failed step unchanged; never repeat work already marked done; if only the user can fix it (information only they have, a permission they declined), reply {"steps":[]}.\n` +
                    'The revised plan must still DELIVER the goal: its final step produces the goal\'s actual output (the answer, table, file, records the user asked for). Preparation alone — splitting work into batches, making a list, planning — is NEVER a complete plan.' },
                { role: 'user', content:
                    `Goal: ${task.goal}` +
                    (task.context ? `\n\nConversation that led to this goal (data the goal references may already be here):\n${task.context}` : '') +
                    `\n\nPlan so far:\n` +
                    task.plan.map((s, i) => `${i + 1}. [${s.status}] ${s.step}${s.result || s.note ? ` — ${(s.result || s.note).slice(0, 300)}` : ''}`).join('\n') +
                    `\n\nStep ${failedIndex + 1} FAILED: ${failed.note || 'no detail'}\nPlan the remaining work around this failure. Done steps keep their numbers; your first replacement step is number ${failedIndex + 2}, and items_from may reference any earlier number.` }
            ],
            options: { num_predict: 800 },
            maxTokens: 800,
            logTag: 'task-replan'
        }, this._planSchema(groups));
        if (resp?.error) {
            this._log(taskId, `replan failed to run: ${resp.error}`);
            return false;
        }
        let steps = this._parsePlanSteps(resp, groups, failedIndex + 1);
        if (!steps.length) {
            this._log(taskId, 'replan: the model saw no workable revision');
            return false;
        }
        // Replan-shape guard: on the 100-title run the foreach failed and
        // the revision REPLACED it with "create a list of the movies" —
        // prep again, fan-out gone, goal-verdict failure guaranteed. A
        // per-item goal whose per-item work hasn't produced rows yet must
        // keep a foreach in the revised tail; when the model drops it, the
        // harness installs its own fan-out tail (same fill-in as the plan
        // guard), pointed at the tail's own list step.
        const rowsDone = Object.values(task.results || {})
            .some(r => r && Array.isArray(r.rows) && r.rows.length);
        if (!rowsDone && this._lintPlanShape(task.goal, steps)) {
            const fb = await this._fallbackForeachPlan(task.goal, steps);
            fb[1].itemsFrom = failedIndex + 2;
            steps = fb;
            this._log(taskId, 'replan shape: revision dropped the fan-out — using the harness fan-out tail');
        }
        steps = this._ensureDeliveryStep(steps);
        // History (everything up to and including the failed step) stays as
        // the honest record; the unrun tail is replaced by the revision.
        // The failed step is retagged 'replanned' — recovered, not terminal:
        // the report must not count a failure the revision worked around.
        const tasks = this._all();
        const t = tasks.find(x => x && x.id === taskId);
        if (!t) return false;
        const f = t.plan[failedIndex];
        f.status = 'replanned';
        f.note = `failed (${(f.note || 'no detail').slice(0, 140)}) — revised the plan around it`;
        t.plan = [...t.plan.slice(0, failedIndex + 1), ...steps];
        t.replans = (t.replans || 0) + 1;
        t.note = `Replanned after step ${failedIndex + 1} failed.`;
        t.updatedAt = new Date().toISOString();
        this._saveAll(tasks);
        this._notify(t);
        this._log(taskId, `Replanned after step ${failedIndex + 1} failed: ${steps.length} revised step(s)`);
        return true;
    },

    /**
     * C9.4 boundary prune (the living plan): after a successful step, one
     * cheap call asks which REMAINING steps still need doing — a step's
     * results often obviate later ones ("step 2 already answered step 4").
     * PRUNE-ONLY by construction: the revision may drop or reword pending
     * steps, never grow the plan, and a revision that grows, empties, or
     * fails the shape lints is IGNORED — the guard rails make "ignore" the
     * worst case, so a small model can't mangle a good plan mid-run.
     */
    async _boundaryPrune(taskId, doneIndex) {
        try {
            const task = this.get(taskId);
            if (!task) return;
            const head = task.plan.slice(0, doneIndex + 1);
            const remaining = task.plan.slice(doneIndex + 1);
            // Nothing worth a model call unless there are 2+ pending steps
            // (with one, there is nothing to prune against).
            if (remaining.filter(s => s.status === 'pending').length < 2) return;
            const groups = this._availableGroups();
            const resp = await this._jsonChat({
                messages: [
                    { role: 'system', content:
                        'A plan is mid-run; a step just finished. You PRUNE the remaining steps: keep the ones still needed to deliver the goal (unchanged when they are right), DROP any the finished work made unnecessary. NEVER add steps, NEVER redo finished work.\n' +
                        `Reply ONLY with JSON: {"steps":[{"kind":"single","step":"…","tools":["group",...],"items_from":"","per_item":"","check":{"kind":"none","arg":""}}]} — at most ${remaining.length} steps, fewest that deliver the goal.` },
                    { role: 'user', content:
                        `Goal: ${task.goal}\n\nFinished so far:\n` +
                        head.map((s, i) => `${i + 1}. [${s.status}] ${s.step}${s.result ? ` — ${String(s.result).slice(0, 200)}` : ''}`).join('\n') +
                        `\n\nRemaining steps (prune these):\n` +
                        remaining.map((s, i) => `${doneIndex + 2 + i}. ${s.step}`).join('\n') }
                ],
                options: { num_predict: 800 },
                maxTokens: 800,
                logTag: 'task-prune'
            }, this._planSchema(groups));
            if (resp?.error) return;
            const revised = this._parsePlanSteps(resp, groups, doneIndex + 1);
            if (!revised.length || revised.length > remaining.length) return;
            // The pruned plan must still be goal-shaped: a per-item goal
            // whose per-item work is undone keeps its foreach.
            const rowsDone = Object.values(task.results || {})
                .some(r => r && Array.isArray(r.rows) && r.rows.length);
            if (!rowsDone && this._lintPlanShape(task.goal, [...head, ...revised])) return;
            if (revised.length === remaining.length
                && revised.every((s, i) => s.step === remaining[i].step && s.kind === remaining[i].kind)) return;
            const tasks = this._all();
            const t = tasks.find(x => x && x.id === taskId);
            if (!t) return;
            t.plan = [...t.plan.slice(0, doneIndex + 1), ...revised];
            t.updatedAt = new Date().toISOString();
            this._saveAll(tasks);
            this._notify(t);
            this._log(taskId, `Boundary prune after step ${doneIndex + 1}: ${remaining.length} remaining step(s) → ${revised.length}`);
        } catch { /* pruning is an optimization — never break the run */ }
    },

    /** System notification for unattended moments — best-effort, silent-fail. */
    _notifySystem(title, body) {
        try { new Notification(title, { body: String(body || '').slice(0, 180), silent: false }); }
        catch { /* notifications unavailable — the Routines page still shows it */ }
    },

    /**
     * One line naming what this run actually CHANGED, counted from the C8.4
     * write ledger. Evidence, never the model's account of itself — same rule
     * the verifier uses. Empty string when the run wrote nothing, so callers
     * can omit the line rather than print "changed: nothing".
     */
    _ledgerSummary(task) {
        if (typeof WriteLedger === 'undefined') return '';
        try {
            const entries = (task.ledgerScopes || [])
                .map(id => WriteLedger.getScope(id)).filter(Boolean)
                .flatMap(s => (s && s.entries) || []);
            if (!entries.length) return '';
            const counts = new Map();
            for (const e of entries) {
                const k = `${e.action} ${e.tool}`.trim();
                counts.set(k, (counts.get(k) || 0) + 1);
            }
            const parts = [...counts].slice(0, 6).map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
            if (counts.size > 6) parts.push(`+${counts.size - 6} more`);
            return parts.join(', ');
        } catch {
            return '';
        }
    },

    /**
     * I8: the idempotency scope for this run's record-creating writes.
     *
     * ROUTINE-scoped when a routine armed the run, so the key holds ACROSS
     * RUNS — the 2026-08-03 invoice routine fired three times and each fire
     * re-created every earlier fire's tasks, because no layer knew the
     * records already existed. Task-scoped otherwise (a chat-started task's
     * retries are the only thing it has to converge).
     */
    _idemScopeFor(task) {
        if (!task) return null;
        return task.routineId ? `routine:${task.routineId}` : `task:${task.id}`;
    },

    /**
     * I8: what this run has ALREADY written, in the model's own terms.
     *
     * "A re-run of any unit that already executed writes must reconcile
     * against the ledger/journal FIRST and must not repeat a write it cannot
     * prove is missing." The idempotency keys make a repeat a no-op; this
     * note is what stops the model from TRYING — which matters because a
     * model told to "cover exactly these" and finding its work apparently
     * missing will invent a distinguishable title ("… (dup 2)") to satisfy
     * the demand, which is exactly what the live runs did.
     *
     * Two sources, both evidence rather than prose: the C8.4 write ledger
     * (what this run did) and the idempotency ledger for the run's scope
     * (what EARLIER runs of the same routine did).
     */
    _priorWritesNote(task) {
        const seen = new Map();
        try {
            if (typeof WriteLedger !== 'undefined') {
                for (const id of (task.ledgerScopes || [])) {
                    const s = WriteLedger.getScope(id);
                    for (const e of ((s && s.entries) || [])) {
                        if (!e || !e.target || /trash|delete/.test(e.action || '')) continue;
                        const k = `${e.tool}::${String(e.target).toLowerCase()}`;
                        if (!seen.has(k)) seen.set(k, `${e.action} ${e.tool} — ${e.target}`);
                    }
                }
            }
            if (typeof AgentTools !== 'undefined' && AgentTools.priorRecordsForScope) {
                for (const r of AgentTools.priorRecordsForScope(this._idemScopeFor(task))) {
                    const k = `${r.tool}::${String(r.title).toLowerCase()}`;
                    if (!seen.has(k)) seen.set(k, `created ${r.tool} — ${r.title}`);
                }
            }
        } catch { return ''; }
        if (!seen.size) return '';
        return '\n\nALREADY DONE — these records EXIST (this run, or an earlier run of the same routine). '
            + 'Do NOT create them again, and do NOT re-word one to make it look new. If a record needs a '
            + 'change, update it; if the work in front of you is already covered by one, say so and move on:\n'
            + [...seen.values()].slice(0, 15).map(l => `- ${l}`).join('\n');
    },

    /** User approved the plan — run it. */
    async approve(taskId) {
        const task = this.get(taskId);
        if (!task || task.status !== 'awaiting_user') return { error: 'task is not awaiting approval' };
        this._clearResumeFlag(taskId);
        this._controls.set(taskId, { pause: false, cancel: false });
        // A human clicked — the run is attended from here on (C8.5): asks
        // show their normal dialog instead of pausing again.
        this._update(taskId, { status: 'running', note: '', unattended: false });
        this._run(taskId);  // fire and forget — the card tracks progress
        return { ok: true };
    },

    /**
     * C8.3: turn this clean-verified run into a recipe. Card-button entry
     * point; derivation itself lives in RecipeService.
     */
    async saveAsRecipe(taskId) {
        const task = this.get(taskId);
        if (!task) return { error: 'task not found' };
        if (!task.recipeEligible) return { error: 'only a fully verified run can become a recipe' };
        if (task.recipeId) return { error: 'this run is already saved as a recipe' };
        const out = await RecipeService.deriveFromTask(taskId);
        if (out.error) return out;
        // Recording served its purpose — stop carrying it in the synced blob.
        const tasks = this._all();
        const t = tasks.find(x => x && x.id === taskId);
        if (t) { t.recipeId = out.recipe.id; delete t.toolLog; delete t.toolLogOverflow; this._saveAll(tasks); this._notify(t); }
        return out;
    },

    pause(taskId) {
        const c = this._controls.get(taskId);
        if (c) c.pause = true;
        return { ok: true };
    },

    async resume(taskId) {
        const task = this.get(taskId);
        if (!task || task.status !== 'paused') return { error: 'task is not paused' };
        this._clearResumeFlag(taskId);
        this._controls.set(taskId, { pause: false, cancel: false });
        this._update(taskId, { status: 'running', note: '', unattended: false });
        this._run(taskId);
        return { ok: true };
    },

    cancel(taskId) {
        const c = this._controls.get(taskId);
        if (c) c.cancel = true;
        this._clearResumeFlag(taskId);
        const task = this.get(taskId);
        // Not mid-flight (awaiting_user / paused): settle immediately.
        if (task && ['awaiting_user', 'paused', 'planning'].includes(task.status)) {
            this._update(taskId, { status: 'failed', note: 'Cancelled by the user.' });
        }
        return { ok: true };
    },

    // ── The run loop ──────────────────────────────────────────────────────

    _interrupted(taskId) {
        const c = this._controls.get(taskId) || {};
        if (c.cancel) {
            this._update(taskId, { status: 'failed', note: 'Cancelled by the user.' });
            return true;
        }
        if (c.pause) {
            this._update(taskId, { status: 'paused', note: 'Paused — resume from the task card.' });
            return true;
        }
        return false;
    },

    async _run(taskId) {
        // The wall clock is per RUN, not per task lifetime: every Resume
        // grants a fresh window, so a long task extends by pressing Resume
        // rather than dying — pausing is the safeguard, the user is the
        // extension consent.
        const startedAt = Date.now();
        // C8.4: each run gets its own ledger scope (a resumed task
        // accumulates several — undo walks them all, newest first).
        if (typeof WriteLedger !== 'undefined') {
            const scopeId = WriteLedger.beginScope('task', this.get(taskId)?.goal);
            const tasks = this._all();
            const t = tasks.find(x => x && x.id === taskId);
            if (t) {
                t.ledgerScopes = [...(t.ledgerScopes || []), scopeId].slice(-10);
                this._saveAll(tasks);
            }
            this._activeScopeByTask = this._activeScopeByTask || new Map();
            this._activeScopeByTask.set(taskId, scopeId);
        }
        try {
            // Vision capability drives the screenshot hand-off in _runStep.
            try { await AgentService.ensureVisionInfo(); } catch { /* stays cached/null */ }
            let task = this.get(taskId);
            let consecFails = 0;
            for (let i = task.stepIndex; i < task.plan.length; i++) {
                if (this._interrupted(taskId)) return;
                if (Date.now() - startedAt > this.MAX_WALL_CLOCK_MS) {
                    this._update(taskId, { status: 'paused', note: `Paused at the ${Math.round(this.MAX_WALL_CLOCK_MS / 60000)}-minute safety window — press Resume to keep going.` });
                    return;
                }
                this._update(taskId, { stepIndex: i });
                this._setStep(taskId, i, { status: 'active' });
                // C9.1 dispatch — fresh read: a replan may have replaced
                // this position since `task` was captured.
                const kind = (this.get(taskId)?.plan?.[i] || {}).kind;
                let result = kind === 'foreach'
                    ? await this._runForeach(taskId, i)
                    : await this._runStep(taskId, i);
                if (result.interrupted) return;
                // Step gate (I3): a step's output is validated BEFORE any
                // later step consumes it — an empty items list or a failed
                // post-condition is caught HERE, with one informed re-run,
                // not a step later when the foreach starves (finding #47's
                // discovery-lag). Only a step that claims ok pays the gate.
                if (result.ok) {
                    const gate = await this._gateStep(taskId, i);
                    if (!gate.ok) {
                        this._log(taskId, `Step ${i + 1} gate: ${gate.reason} — one informed re-run`);
                        this._setStep(taskId, i, { status: 'active', note: `redo: ${gate.reason.slice(0, 160)}` });
                        result = kind === 'foreach'
                            ? await this._runForeach(taskId, i, gate.reason)
                            : await this._runStep(taskId, i, gate.reason);
                        if (result.interrupted) return;
                        if (result.ok) {
                            const gate2 = await this._gateStep(taskId, i);
                            if (!gate2.ok) result = { ok: false, note: gate2.reason.slice(0, 200), result: result.result };
                        }
                    }
                }
                this._setStep(taskId, i, {
                    status: result.ok ? 'done' : 'failed',
                    note: result.note, result: result.result,
                    // I9: a done step whose bookkeeping the harness could not
                    // read carries the count, which is what marks it △ in the
                    // report and keeps it out of the verify retry pass.
                    unverified: result.unverified || 0
                });
                this._log(taskId, `Step ${i + 1}: ${result.ok ? 'done' : 'FAILED'} — ${result.note}`);
                // C9.4 living plan: a finished step may have obviated later
                // ones — prune-only, guard-railed (see _boundaryPrune).
                if (result.ok && i + 1 < this.get(taskId).plan.length) {
                    await this._boundaryPrune(taskId, i);
                    task = this.get(taskId);
                }
                // Adaptive replanning: a failed step with more work ahead
                // gets ONE shot (per replan budget) at a revised remainder —
                // smaller batches, a different tool — before the old plan
                // marches into the same wall. The revision replaces the
                // unrun tail; re-read the task so the loop walks it.
                if (!result.ok && (this.get(taskId)?.replans || 0) < this.MAX_REPLANS) {
                    if (this._interrupted(taskId)) return;
                    const replanned = await this._replan(taskId, i);
                    if (replanned) {
                        task = this.get(taskId);
                        consecFails = 0;
                        continue;
                    }
                }
                // Progress gate: two failed steps in a row means the later
                // steps are almost certainly blocked on the same root cause —
                // burning their budget produces five copies of one failure
                // (the CNBC task did exactly that). Skip the rest honestly
                // and let verify/report say what happened.
                consecFails = result.ok ? 0 : consecFails + 1;
                if (consecFails >= 2 && i + 1 < task.plan.length) {
                    for (let j = i + 1; j < task.plan.length; j++) {
                        this._setStep(taskId, j, { status: 'skipped', note: 'skipped — the two steps before it failed the same way' });
                    }
                    this._log(taskId, `Steps ${i + 2}–${task.plan.length} skipped after two consecutive failures`);
                    break;
                }
            }

            // Verify, retry failures once, report.
            task = this.get(taskId);
            this._update(taskId, { status: 'verifying', note: 'Checking the work…' });
            const verified = await this._verify(taskId);
            if (this._interrupted(taskId)) return;
            const verdicts = verified ? verified.verdicts : null;
            const goalVerdict = verified ? verified.goal : null;

            const failedIdx = (verdicts || [])
                .map((v, i) => (v && v.ok === false ? i : -1))
                // Skipped steps don't get the retry pass — their
                // prerequisites failed, so re-running them alone can't work.
                // Replanned steps are superseded history — re-running one
                // would redo exactly what the revision replaced.
                .filter(i => i !== -1 && i < task.plan.length
                    && !['skipped', 'replanned'].includes(task.plan[i].status));
            // I9: a step already reported △ because the harness could not read
            // its bookkeeping must not be re-run. The verifier reads the same
            // unreadable rows and reaches the same doubt, so honouring it here
            // would re-run write-bearing work off evidence already known to be
            // unsound — the second half of the invoice-run cascade.
            const unverifiedIdx = failedIdx.filter(i => task.plan[i].unverified);
            for (const i of unverifiedIdx) {
                this._log(taskId, `Step ${i + 1}: verify doubt not retried — its rows are unverified, not absent (I9)`);
            }
            const retryIdx = failedIdx.filter(i => !task.plan[i].unverified);
            if (retryIdx.length && !task.retried) {
                this._update(taskId, { status: 'running', retried: true, note: `Fixing ${retryIdx.length} step(s) that didn't check out…` });
                for (const i of retryIdx) {
                    if (this._interrupted(taskId)) return;
                    const issue = verdicts[i]?.issue || 'did not achieve its intent';
                    this._setStep(taskId, i, { status: 'active', note: `retry: ${issue}` });
                    const result = (task.plan[i] && task.plan[i].kind === 'foreach')
                        ? await this._runForeach(taskId, i, issue)
                        : await this._runStep(taskId, i, issue);
                    if (result.interrupted) return;
                    this._setStep(taskId, i, {
                        status: result.ok ? 'done' : 'failed', note: result.note,
                        result: result.result, unverified: result.unverified || 0
                    });
                }
            }

            await this._report(taskId, verdicts, goalVerdict);
        } catch (e) {
            console.error('[task] run failed:', e);
            this._update(taskId, { status: 'failed', note: `Task crashed: ${e.message}` });
        } finally {
            if (typeof WriteLedger !== 'undefined' && this._activeScopeByTask) {
                const scopeId = this._activeScopeByTask.get(taskId);
                this._activeScopeByTask.delete(taskId);
                if (scopeId) WriteLedger.endScope(scopeId);
            }
        }
    },

    _setStep(taskId, index, patch) {
        const tasks = this._all();
        const t = tasks.find(x => x && x.id === taskId);
        if (!t || !t.plan[index]) return;
        Object.assign(t.plan[index], patch);
        t.updatedAt = new Date().toISOString();
        this._saveAll(tasks);
        this._notify(t);
    },

    /**
     * One step: a bounded tool loop with ONLY the step's tool groups + core,
     * no briefing. The loop ends when the model stops calling tools (or the
     * caps land); a typed closing call reports the outcome (C9.3) and the
     * step's structured output lands in the results map (C9.2).
     */
    async _runStep(taskId, index, retryIssue) {
        const task = this.get(taskId);
        const step = task.plan[index];
        const tools = this._toolsForGroups(step.tools, this._impliedGroups(task.goal), task.untrustedInput);
        const messages = [
            { role: 'system', content: this._stepSystemPrompt(tools) },
            { role: 'user', content:
                `Overall goal: ${task.goal}\n` +
                (task.context ? `Conversation that led to this task (data the goal references may already be here — use it, don't re-find it):\n${task.context}\n---\n` : '') +
                `Plan so far: ${task.plan.map((s, i) => `${i + 1}. ${s.step}${s.status === 'done' ? ` (done: ${s.result || s.note})` : ''}`).join(' | ')}\n` +
                `Your step (#${index + 1}): ${step.step}` +
                (retryIssue ? `\nA verification pass found a problem with your earlier attempt: ${retryIssue}. Fix it.` : '') +
                // I8: reconcile before any re-run that could repeat a write.
                // Carried on every step, not just retries — a later step can
                // duplicate an earlier one's record just as easily, and the
                // note costs nothing when the run has written nothing.
                this._priorWritesNote(task) }
        ];
        // Fan-out language still doubles the round allowance (one step may
        // legitimately read several pages); true per-item work should be a
        // foreach step and never lean on this.
        const fanOut = /\b(each|every|all\s+(the\s+)?\w+s)\b/i.test(step.step);
        const unit = await this._runUnit(taskId, index, messages, tools, {
            roundCap: fanOut ? this.MAX_STEP_ITERATIONS * 2 : this.MAX_STEP_ITERATIONS,
            closing: this._closingFor(task, index),
            recite: `You are on step #${index + 1} of the plan: "${step.step}". Do ONLY this step.`
        });
        if (unit.interrupted) return unit;
        // C9.2: the FULL structured output is state; the note is display.
        this._setResult(taskId, index, { result: unit.result, items: unit.items });
        return unit;
    },

    /** The step-loop system prompt, shared by single steps and foreach
     *  chunks — same tool discipline, same web/browser notes. */
    _stepSystemPrompt(tools, chunkMode) {
        return (chunkMode
            ? 'You are doing ONE batch of a larger fan-out step, using tools. Handle EVERY item listed and nothing else.\n'
            : 'You are executing ONE step of an approved plan, using tools. Do only this step.\n') +
            'When you need the same lookup for several independent items, put SEVERAL tool calls in ONE reply — they run together and cost one round; one lookup at a time wastes your limited rounds.\n' +
            'When the work is complete, stop calling tools and reply "DONE:" followed by the CONCRETE DATA you produced — the actual names, emails, figures, links, findings. If you cannot complete it, reply: FAILED: <why>.' +
            (typeof AgentService !== 'undefined' && AgentService._webSearchReady === false
                ? '\nNote: web SEARCH is turned off in the user\'s settings — but that disables only searching. Opening specific URLs (read_url) and any browser tools still work; use them rather than declaring web work impossible.'
                : '') +
            // Task steps don't carry chat's BROWSING guidance, so a small
            // model fought cnbc.com with read_url (thin JS-rendered text)
            // while browser tools sat unused. One line fixes the reach.
            (tools.some(d => /^mcp_.*browser/i.test(d.function?.name || ''))
                ? '\nWeb pages: if read_url returns thin, blocked, or navigation-only text, the site needs a real browser — use the browser_* tools (navigate ONCE per URL, then read/snapshot/screenshot it) instead of retrying read_url.'
                : '');
    },

    /** C9.3: the typed ending for a single step. `items` is demanded only
     *  when a later foreach consumes this step's output — the producing
     *  step then MUST emit the full list, decode-time enforced. */
    _closingFor(task, index) {
        const needsItems = (task.plan || []).some((s, j) =>
            j > index && s.kind === 'foreach' && s.itemsFrom === index + 1);
        const properties = {
            status: { type: 'string', enum: ['done', 'failed'] },
            result: { type: 'string' },
            note: { type: 'string' }
        };
        const required = ['status', 'result', 'note'];
        if (needsItems) {
            properties.items = { type: 'array', items: { type: 'string' } };
            required.push('items');
        }
        return {
            schema: { type: 'object', properties, required },
            // An items-producing closing must NOT carry the list twice: the
            // 100-title run put the list in `result` AND `items`, blew the
            // 1200-token closing cap, the truncated JSON failed to parse,
            // and the sentinel fallback carried no items at all (finding
            // #47). Items get the tokens; result becomes a one-liner.
            maxTokens: needsItems ? 3000 : 1200,
            instruction: needsItems
                ? 'The step is over. Report it as JSON only: "status" is "done" or "failed"; "items" is the COMPLETE list this step produced, one item per string, in full — a later step processes each one; "result" is a ONE-SENTENCE summary (never repeat the list in it); "note" is one short line for the task card.'
                : 'The step is over. Report it as JSON only: "status" is "done" or "failed"; "result" is the CONCRETE data this step produced — the actual names, figures, links, findings (later steps see nothing else); "note" is one short line for the task card.'
        };
    },

    /** C9.2: store a step's structured output, bounded. Rows drop whole
     *  entries on overflow (a truncated row is worse than a missing one —
     *  the foreach re-covers missing items on resume). */
    _setResult(taskId, index, value) {
        try {
            const tasks = this._all();
            const t = tasks.find(x => x && x.id === taskId);
            if (!t) return;
            if (!t.results || typeof t.results !== 'object') t.results = {};
            let v = { ...value };
            const size = (x) => { try { return JSON.stringify(x).length; } catch { return Infinity; } };
            if (size(v) > this.RESULT_STORE_CAP && Array.isArray(v.rows)) {
                const rows = [...v.rows];
                while (rows.length && size({ ...v, rows }) > this.RESULT_STORE_CAP) rows.pop();
                v = { ...v, rows, truncatedRows: v.rows.length - rows.length };
            }
            if (size(v) > this.RESULT_STORE_CAP) {
                v.result = String(v.result || '').slice(0, 8000);
                if (Array.isArray(v.items)) v.items = v.items.slice(0, 300);
            }
            t.results[String(index + 1)] = v;
            t.updatedAt = new Date().toISOString();
            this._saveAll(tasks);
        } catch { /* results are best-effort state — never break the run */ }
    },

    _itemKey(s) {
        return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    },

    /** Mechanical item-list extraction from numbered/bulleted result text —
     *  the salvage behind a typed closing that failed to carry `items`.
     *  Returns a deduped array, or null when the text has no usable list. */
    _salvageItems(text) {
        const lines = [...String(text || '').matchAll(/^\s*(?:\d{1,4}[.)]|[-*•])\s+(.+?)\s*$/gm)]
            .map(m => m[1].trim()).filter(Boolean);
        return lines.length >= 2 ? [...new Set(lines)] : null;
    },

    /** Match a model-written row label back to the input item it covers —
     *  tolerant of decoration ("Boyhood (2014)" covers "Boyhood"), exact
     *  for very short names where containment would mis-match. */
    _matchItem(rowItem, items) {
        const k = this._itemKey(rowItem);
        if (!k) return null;
        for (const it of items) {
            const ik = this._itemKey(it);
            if (k === ik) return it;
            if (ik.length >= 4 && (k.includes(ik) || ik.includes(k))) return it;
        }
        return null;
    },

    _missingItems(items, rows) {
        const covered = new Set((rows || []).map(r => this._itemKey(r.item)));
        return items.filter(it => !covered.has(this._itemKey(it)));
    },

    /**
     * C9.1: a foreach step. The HARNESS owns the iteration: items come from
     * an earlier step's typed output, run in chunks of FOREACH_CHUNK with a
     * count check and one informed retry per chunk, and aggregate in JS. The
     * model only ever sees one small chunk — the batched-mega-query failure
     * is impossible by construction. Progress lands on the card per chunk,
     * and already-covered items are skipped on resume and on verify-retry.
     */
    async _runForeach(taskId, index, retryIssue) {
        const task = this.get(taskId);
        const step = task.plan[index];
        const src = (task.results || {})[String(step.itemsFrom)];
        let items = (src && Array.isArray(src.items))
            ? [...new Set(src.items.map(s => String(s).trim()).filter(Boolean))] : [];
        if (!items.length) {
            // Salvage (I3): the producing step often HAS the list in its
            // result text even when its typed closing failed to carry
            // `items` (finding #47's truncated closing). Mechanical
            // extraction beats failing the whole fan-out over a formatting
            // miss.
            const salvaged = this._salvageItems([src?.result, task.plan[step.itemsFrom - 1]?.result]
                .find(t => typeof t === 'string' && t.trim()) || '');
            if (salvaged) {
                items = salvaged;
                this._log(taskId, `foreach: salvaged ${items.length} items from step ${step.itemsFrom}'s result text`);
            }
        }
        if (!items.length) {
            return { ok: false, note: `step ${step.itemsFrom} did not produce the item list this step needs` };
        }
        const tools = this._toolsForGroups(step.tools, this._impliedGroups(task.goal), task.untrustedInput);
        const prior = (task.results || {})[String(index + 1)];
        // Prior UNKNOWN and UNVERIFIED rows are re-attempted on resume/retry —
        // they're placeholders, not coverage. Re-attempting an unverified item
        // is write-safe under I8 (the reconcile note + idempotency keys).
        const rows = (prior && Array.isArray(prior.rows))
            ? prior.rows.filter(r => !r.unknown && !r.unverified) : [];
        const covered = new Set(rows.map(r => this._itemKey(r.item)));
        const todo = items.filter(it => !covered.has(this._itemKey(it)));
        const missed = [];
        // I9: items the harness could not READ an answer for, as distinct from
        // items nothing answered. See _runChunk's `unsound`.
        const unverified = [];
        const started = Date.now();
        for (let c = 0; c < todo.length; c += this.FOREACH_CHUNK) {
            if (this._interrupted(taskId)) return { interrupted: true };
            // The single-step time box scales poorly to a long list; the
            // foreach gets its own window and PAUSES resumably at it —
            // covered rows are already in the results map, so Resume picks
            // up mid-list instead of starting over.
            if (Date.now() - started > this.STEP_TIME_MS * 4) {
                this._setStep(taskId, index, { status: 'pending', note: `paused at ${rows.length}/${items.length} items` });
                this._update(taskId, { status: 'paused', note: `Paused mid-list (${rows.length}/${items.length} done) — press Resume to continue.` });
                return { interrupted: true };
            }
            const chunk = todo.slice(c, c + this.FOREACH_CHUNK);
            const first = await this._runChunk(taskId, index, task, step, tools, chunk, retryIssue);
            if (first.interrupted) return first;
            let got = first.rows;
            let unsound = first.unsound;
            // Count check, then ONE informed retry scoped to what's missing.
            //
            // I9: only SOUND evidence of absence earns that retry. When the
            // batch's own result could not be read (unparseable closing, rows
            // whose labels map to nothing that was asked), "missing" is a
            // bookkeeping artefact, and re-running it with "cover exactly
            // these" is precisely what forced the model to abandon its own
            // correct consolidation and create tasks titled "…(dup 2)" in the
            // 2026-08-03 invoice runs. Mismatch is not absence.
            let missing = this._missingItems(chunk, got);
            let retryBroke = false;
            if (missing.length && !unsound) {
                const again = await this._runChunk(taskId, index, task, step, tools, missing,
                    `A previous pass covered ${chunk.length - missing.length} of ${chunk.length} items and MISSED the ones listed below. Cover exactly these.`);
                if (again.interrupted) return again;
                got = [...got, ...again.rows];
                unsound = again.unsound;
                retryBroke = !!again.broke;
                missing = this._missingItems(chunk, got);
            }
            for (const r of got) {
                const k = this._itemKey(r.item);
                if (!covered.has(k)) { covered.add(k); rows.push(r); }
            }
            if (missing.length && unsound) {
                for (const it of missing) unverified.push({ item: it, why: unsound });
                this._log(taskId, `foreach: ${missing.length} item(s) unverified — ${unsound}`);
            } else if (missing.length && !first.broke && !retryBroke) {
                // I9, closing the last hole (ISSUES.md #2d): every batch for
                // these items CONCLUDED — status done, readable closing — and
                // still returned no row for them. The model believes the work
                // is done (often consolidated into one artifact, e.g. "write
                // the document" planned as per-item edits); the harness just
                // cannot map its result back per item. That is bookkeeping
                // mismatch, not evidence of absence, and a false ✗ re-runs
                // writes. Settle unresolved as unverified — the v3 design
                // states this rule verbatim ("unresolved items settle as
                // unverified (I9), not as retry fuel").
                const why = 'the batch concluded without a readable per-item row — unresolved, not proven absent';
                for (const it of missing) unverified.push({ item: it, why });
                this._log(taskId, `foreach: ${missing.length} item(s) unverified — ${why} (I9)`);
            } else {
                missed.push(...missing);
            }
            this._setResult(taskId, index, { rows });
            this._setStep(taskId, index, { note: `${rows.length}/${items.length} items` });
        }
        // I9: unverified is NOT failed. A step whose work the harness cannot
        // read back reports △ with an honest note; a failed one is reserved
        // for evidence that the work is genuinely absent. A false ✗ is the
        // most expensive verdict the engine can emit — it re-runs writes.
        const ok = missed.length === 0;
        // No silent holes (research: a dropped row is indistinguishable from
        // "not available" in a table): every unresolved item gets an explicit
        // UNKNOWN row. The step still counts as failed and the note names
        // the misses — the table is complete, the honesty is intact, and a
        // retry re-attempts exactly the unknown rows.
        const resolved = rows.length;
        if (missed.length || unverified.length) {
            for (const it of missed) {
                rows.push({ item: it, data: 'unknown: could not be resolved in this run', unknown: true });
            }
            // An unverified row is honest about WHICH kind of ignorance it is:
            // nobody claimed this item was impossible — the harness could not
            // read the answer. It renders △ and never becomes retry fuel.
            for (const u of unverified) {
                rows.push({ item: u.item, data: `unverified: ${u.why}`, unverified: true });
            }
            this._setResult(taskId, index, { rows });
            const bits = [];
            if (missed.length) bits.push(`${missed.length} unknown`);
            if (unverified.length) bits.push(`${unverified.length} unverified`);
            this._setStep(taskId, index, { note: `${resolved}/${items.length} items (${bits.join(', ')})` });
        }
        const notes = [];
        if (missed.length) notes.push(`unknown: ${missed.slice(0, 5).join('; ')}${missed.length > 5 ? '…' : ''}`);
        if (unverified.length) notes.push(`${unverified.length} unverified (${unverified[0].why})`);
        return {
            ok,
            unverified: unverified.length,
            note: notes.length
                ? `covered ${resolved} of ${items.length} items — ${notes.join(' · ')}`
                : `covered all ${items.length} items`,
            result: rows.map(r => `${r.item}: ${r.data}`).join('\n').slice(0, 4000)
        };
    },

    /** One chunk = one bounded tool loop over ≤FOREACH_CHUNK items with a
     *  rows-typed closing. Rows are canonicalized back to the input items.
     *
     *  I9: a row for an item that wasn't asked used to be dropped SILENTLY,
     *  and the item it should have covered then read as missing — the harness
     *  reporting absence where it actually had a reading failure. That is the
     *  cascade that cost the 2026-08-03 invoice runs 28 duplicate schedule
     *  writes. The signal is now returned as `unsound`, and the caller settles
     *  those items as unverified rather than failed. */
    async _runChunk(taskId, index, task, step, tools, chunk, extraNote) {
        const messages = [
            { role: 'system', content: this._stepSystemPrompt(tools, true) },
            { role: 'user', content:
                `Overall goal: ${task.goal}\n` +
                `For EACH item below: ${step.perItem}\n` +
                (extraNote ? `${extraNote}\n` : '') +
                `Items (${chunk.length}):\n${chunk.map((it, i) => `${i + 1}. ${it}`).join('\n')}` +
                this._priorWritesNote(task) }
        ];
        const closing = {
            schema: {
                type: 'object',
                properties: {
                    status: { type: 'string', enum: ['done', 'failed'] },
                    rows: { type: 'array', items: {
                        type: 'object',
                        properties: { item: { type: 'string' }, data: { type: 'string' } },
                        required: ['item', 'data']
                    } },
                    note: { type: 'string' }
                },
                required: ['status', 'rows', 'note']
            },
            instruction: 'The batch is over. Report it as JSON only: "status" is "done" or "failed"; "rows" has ONE entry per item — "item" repeats the item exactly as listed, "data" is what you found for it (or "not found: <why>"); "note" is one short line.'
        };
        const unit = await this._runUnit(taskId, index, messages, tools, {
            roundCap: this.CHUNK_ITERATIONS, closing,
            recite: 'You are handling the batch of items listed above — cover EVERY item in it.'
        });
        if (unit.interrupted) return unit;
        const typed = Array.isArray(unit.rows);
        const rows = [];
        let unmatched = 0;
        for (const r of (unit.rows || [])) {
            const m = this._matchItem(r.item, chunk);
            if (m) rows.push({ item: m, data: String(r.data || '').slice(0, 1000) });
            else unmatched++;
        }
        // Three outcomes, not two. A batch that BROKE (model error, stall,
        // time box — unit.ok === false) is a genuine failure and keeps
        // failing; a batch that ran to a conclusion the harness could not
        // read is unsound evidence about the items, not evidence about them.
        let unsound = null;
        if (!typed && unit.ok !== false) {
            unsound = 'the batch finished but its result could not be read as per-item rows';
        } else if (typed && unmatched) {
            unsound = `${unmatched} result row(s) could not be matched back to the listed items`;
        }
        // `broke` = the batch itself DIED (model error, stall, time box) —
        // the only outcome that licenses treating its items as absent.
        return { rows, unsound, broke: unit.ok === false };
    },

    /** C9.3: the closing call — transcript + closing instruction → typed
     *  outcome. Returns null when the response defies even the plain-json
     *  downgrade; the caller falls back to sentinel parsing. */
    async _closeUnit(messages, closing, prefixNote) {
        const cap = closing.maxTokens || 1200;
        const resp = await this._jsonChat({
            messages: [...messages, { role: 'user', content: (prefixNote ? prefixNote + ' ' : '') + closing.instruction }],
            options: { num_predict: cap },
            maxTokens: cap,
            logTag: 'task-close'
        }, closing.schema);
        let parsed = null;
        try { parsed = JSON.parse(resp?.message?.content || ''); } catch { return null; }
        if (!parsed || (parsed.status !== 'done' && parsed.status !== 'failed')) return null;
        const ok = parsed.status === 'done';
        const out = {
            ok,
            note: String(parsed.note || parsed.result || (ok ? 'completed' : 'failed')).slice(0, 200),
            result: String(parsed.result || '').slice(0, 4000)
        };
        if (Array.isArray(parsed.items)) out.items = parsed.items.map(x => String(x).trim()).filter(Boolean);
        if (Array.isArray(parsed.rows)) out.rows = parsed.rows.filter(r => r && typeof r === 'object');
        return out;
    },

    /**
     * The bounded tool loop shared by single steps and foreach chunks:
     * permission-gated execution, stall detection, budgets, vision hand-off,
     * and the typed closing (C9.3).
     */
    async _runUnit(taskId, index, messages, tools, opts = {}) {
        const task = this.get(taskId);
        // Stall detection: a step that keeps issuing the SAME call with the
        // SAME args is looping, not working. First repeat past two runs gets
        // a corrective note instead of a wasted execution; the next one
        // fails the step honestly. Observation tools (snapshot/screenshot/
        // continue_output) legitimately repeat — the page state is what
        // changes — so they're exempt, same as chat's repeat cap.
        const callCounts = new Map();
        const repeatExempt = (n) => /^mcp_/.test(n)
            && /(snapshot|screenshot|console|network|tabs?|find|continue_output)/.test(n);
        // One-shot corrective for a step that ends by NARRATING unfinished
        // work instead of doing it (finding #44).
        let nudgedNarration = false;
        // C9.6: one-shot transcript fold — see below.
        let folded = false;
        const stepStart = Date.now();
        const roundCap = opts.roundCap || this.MAX_STEP_ITERATIONS;

        for (let iter = 0; iter < roundCap; iter++) {
            if (this._interrupted(taskId)) return { interrupted: true };
            if (Date.now() - stepStart > this.STEP_TIME_MS) {
                return { ok: false, note: `step ran past its ${Math.round(this.STEP_TIME_MS / 60000)}-minute time box` };
            }
            // C9.6 recitation: a long unit drifts off-mission (lost in the
            // middle) — every 4th round restates it at the TAIL of context.
            // Append-only, so the cached prefix never moves.
            if (opts.recite && iter > 0 && iter % 4 === 0) {
                messages.push({ role: 'user', content: `Progress check: ${opts.recite} Continue with tool calls, or finish with "DONE:" followed by the concrete data.` });
            }
            // C9.6 observation folding: ONE rare large jump when the
            // transcript outgrows a small model's usable window (effective
            // context ≈ half of advertised) — tool results older than the
            // last 4 rounds fold to stubs; the data they carried lives in
            // harness state. One fold, not continuous trimming: every
            // rewrite reprocesses the whole prefix on local hardware.
            if (!folded && messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0) > 24000) {
                const toolIdx = messages.map((m, ix) => (m.role === 'tool' ? ix : -1)).filter(ix => ix !== -1);
                const foldable = toolIdx.slice(0, Math.max(0, toolIdx.length - 4));
                // The flag flips only when a fold actually happened — an
                // over-budget transcript whose old results are all still in
                // the keep-window must stay eligible for later rounds.
                if (foldable.length) {
                    folded = true;
                    for (const ix of foldable) {
                        const m = messages[ix];
                        m.content = `(earlier ${m.name || 'tool'} result folded to save room — its data was noted when first read: ${String(m.content).slice(0, 120)}…)`;
                    }
                    this._log(taskId, `unit transcript folded once past 24k chars (${foldable.length} result(s))`);
                }
            }

            // Transient model errors get retries before the step is declared
            // failed — a hiccup must not kill 20 minutes of task progress.
            // "Backend not running" is special: it usually means llama-server
            // is mid-(re)load, which takes up to a minute — patient 15s waits
            // there, quick 2s/4s ones for everything else.
            let resp = null;
            for (let attempt = 0; ; attempt++) {
                resp = await this._chat({
                    messages, tools,
                    options: { num_predict: 1500 },
                    maxTokens: 1500,
                    logTag: 'task-step'
                });
                if (!resp?.error) break;
                const engineDown = /not running|no server|still loading|loading the model|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|network/i.test(resp.error);
                const maxRetries = engineDown ? 4 : this.MODEL_ERROR_RETRIES;
                if (attempt >= maxRetries) break;
                this._log(taskId, `model error (retry ${attempt + 1}): ${resp.error}`);
                // Same throttle-aware wait as planning: honor a known reopen
                // time instead of retrying into a still-closed window.
                const throttleMs = AgentService.throttleWaitFrom?.(resp) || 0;
                await new Promise(r => setTimeout(r, throttleMs ? Math.min(throttleMs, 75000) : (engineDown ? 15000 : 2000 * (attempt + 1))));
                if (this._interrupted(taskId)) return { interrupted: true };
            }
            if (resp?.error) return { ok: false, note: `model error: ${resp.error}` };
            const msg = resp?.message || {};
            (msg.tool_calls || []).forEach((tc, i) => { if (!tc.id) tc.id = `call_${Date.now().toString(36)}_${i}`; });
            messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });

            const calls = msg.tool_calls || [];
            if (!calls.length) {
                const text = (msg.content || '').trim();
                // A sentinel-less reply that PROMISES work ("I am currently
                // researching…, I will compile the results once complete")
                // is a stall dressed as progress: the loop ends right after
                // it, so the promised work never happens — and marking it ✓
                // handed later steps a status update instead of data
                // (finding #44). One pointed nudge, because the model may
                // genuinely be mid-plan; narrating AGAIN fails the step.
                const narrating = !/^(DONE|FAILED):/i.test(text)
                    && /\b(i\s*(?:am|'m)\s+(?:currently|now|still)\b|i\s+will\s+(?:compile|continue|proceed|provide|begin|start)\b|working\s+my\s+way\s+through\b|in\s+the\s+process\s+of\b|once\s+(?:the\s+|this\s+|my\s+)?\w+(?:\s+\w+)?\s+is\s+(?:complete|finished|done)\b)/i.test(text);
                if (narrating && !nudgedNarration) {
                    nudgedNarration = true;
                    messages.push({ role: 'user', content: 'Nothing runs after your reply — work you describe as "in progress" or promise for later will NEVER happen. Either make the tool calls now, or finish honestly: reply "DONE:" followed by the concrete data you actually gathered, or "FAILED: <why>".' });
                    continue;
                }
                if (narrating) {
                    return { ok: false, note: 'step ended with a promise of future work instead of doing it' };
                }
                // C9.3: typed ending — one forced-JSON closing call turns the
                // finished loop into {status, result, …}, decode-time
                // enforced: a step can no longer end on prose the harness
                // has to guess about. Sentinel parsing below survives only
                // as the fallback when even the plain-json downgrade fails.
                const closed = await this._closeUnit(messages, opts.closing);
                if (closed) return closed;
                // Honest completion: FAILED: is explicit, but small models
                // also write plain refusals with no sentinel ("I cannot
                // proceed because…") — those are failures too, and marking
                // them ✓ made the CNBC task card lie about what happened.
                // They ALSO wrap refusals in DONE: ("DONE: I was unable
                // to…"), so a DONE whose body OPENS with inability phrasing
                // counts as failed — a genuine negative result ("DONE: found
                // 0 matching emails") doesn't start that way.
                const doneBody = text.replace(/^DONE:\s*/i, '');
                const failed = /^FAILED:/i.test(text)
                    || (!/^DONE:/i.test(text) && /\b(cannot|can't|cant|unable to|could not|not able to|never completed)\b/i.test(text.slice(0, 240)))
                    || (/^DONE:/i.test(text) && /^(i\s+)?(was\s+|am\s+)?(unable|cannot|can'?t|could\s*n[o']t)\b/i.test(doneBody));
                // note = short display line for the task card; result = the
                // full DONE payload that later steps / verify / the report
                // consume. Capping result at 200 chars was finding #37's
                // root cause: step 2's ten-business list got beheaded and
                // the compile step had nothing to compile.
                const body = text.replace(/^(DONE|FAILED):\s*/i, '') || 'completed';
                // 4k result: a 10-item fan-out's summaries must survive into
                // later steps and the report (2k beheaded them — #37 redux).
                return { ok: !failed, note: body.slice(0, 200), result: body.slice(0, 4000) };
            }

            for (const tc of calls) {
                const name = tc.function?.name;
                let args = tc.function?.arguments;
                if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }

                // Stall gate (before spending budget on a duplicate).
                if (!repeatExempt(name)) {
                    let sig;
                    try { sig = `${name}|${JSON.stringify(args)}`; } catch { sig = name; }
                    const n = (callCounts.get(sig) || 0) + 1;
                    callCounts.set(sig, n);
                    if (n === 3) {
                        messages.push({ role: 'tool', content: JSON.stringify({ error: 'Skipped: you already made this exact call twice in this step — its result is above and will not change. Do the NEXT action, or finish with DONE:/FAILED:.' }), name, tool_call_id: tc.id });
                        continue;
                    }
                    if (n > 3) {
                        return { ok: false, note: `stalled — repeated ${name} with identical arguments ${n} times` };
                    }
                }

                // Task-level budget: hitting it PAUSES (resumable with a
                // fresh allowance via budgetRounds) instead of failing —
                // running out of budget is not the same as being unable
                // to do the work.
                const t = this.get(taskId);
                const allowance = this.MAX_TOTAL_TOOL_CALLS * ((t.budgetRounds || 0) + 1);
                if (t.toolCalls >= allowance) {
                    this._setStep(taskId, index, { status: 'pending', note: 'paused mid-step at the tool budget' });
                    this._update(taskId, {
                        status: 'paused',
                        budgetRounds: (t.budgetRounds || 0) + 1,
                        note: `Paused at the ${allowance}-tool-call safety budget — press Resume to continue with a fresh allowance.`
                    });
                    return { interrupted: true };
                }
                this._update(taskId, { toolCalls: t.toolCalls + 1 });

                // Same permission gate as chat. A denial pauses the task —
                // the user said no (or wasn't sure); don't plow on.
                let result;
                // C9.5 exactly-once: a WRITE this run already completed
                // (same tool, same args, journaled ok with its result)
                // replays the recorded result instead of executing — a
                // gate-retried or resumed step must not create the note or
                // send the email twice. Reads always re-run: cheap, and
                // freshness matters. Replay needs no permission — the
                // action was approved and happened; nothing runs again.
                let replayed = false;
                let argsJson = null;
                try { argsJson = JSON.stringify(args || {}); } catch { argsJson = null; }
                const isWrite = !(typeof AgentService !== 'undefined'
                    && AgentService._isReadOnlyTool && AgentService._isReadOnlyTool(name));
                if (isWrite && argsJson !== null && argsJson.length <= 2000) {
                    const prior = this._journal(taskId).find(e =>
                        e && e.t === 'tool' && e.name === name && e.args === argsJson && e.ok && e.result);
                    if (prior) {
                        try { result = JSON.parse(prior.result); replayed = true; } catch { result = undefined; }
                        if (replayed) this._log(taskId, `tool ${name}: replayed from the run journal (already executed this run)`);
                    }
                }
                const perm = replayed ? { decision: 'allow' } : await AgentService._resolvePermission(name, args);
                if (perm.decision === 'deny') {
                    result = { error: `Blocked by permissions: ${perm.reason || 'not allowed'}` };
                } else if (perm.decision === 'ask' && this.get(taskId)?.unattended) {
                    // C8.5: nobody is present to answer a dialog. Pause to
                    // awaiting_user and NOTIFY — a pause must never be a
                    // silent stall. Resuming (a human click) marks the task
                    // attended, so the retry shows the normal ask dialog.
                    const why = perm.budgetExhausted ? ' (its standing permission hit its daily limit)' : '';
                    this._setStep(taskId, index, { status: 'pending', note: `needs your approval: ${name}${why}` });
                    this._update(taskId, { status: 'awaiting_user', note: `Waiting for your approval to run ${name}${why} — open the task to continue.` });
                    this._notifySystem('Anjadhe task needs your approval', `${task.goal.slice(0, 100)} — wants to run ${name}${why}`);
                    return { interrupted: true };
                } else if (perm.decision === 'ask') {
                    // conversationId lets a CLI-driven task route its asks to
                    // the TTY (CLIBridge); in-app tasks see no difference.
                    const decision = await AgentService._confirmWrite(name, args, perm, task.conversationId);
                    if (!decision.approved) {
                        this._setStep(taskId, index, { status: 'pending', note: 'needs a permission you declined' });
                        this._update(taskId, { status: 'awaiting_user', note: `Step ${index + 1} needs a permission you declined. Resume to try again, or cancel.` });
                        PermissionManager.recordDecision('denied', name);
                        return { interrupted: true };
                    }
                    if (perm.grantClass && perm.suggestedScope) {
                        await PermissionManager.grantScoped(perm.grantClass, perm.suggestedScope, decision.scope || 'once');
                    } else if (decision.scope === 'session') {
                        PermissionManager.grantSession(perm.grantKey || name);
                    } else if (decision.scope === 'always') {
                        await PermissionManager.grantAlways(perm.grantKey || name);
                    }
                    PermissionManager.recordDecision(`approved-${decision.scope || 'once'}`, name);
                }
                if (!result) {
                    // C8.4: run under the task scope's capture window so the
                    // write's touched storage keys get pre-imaged; then
                    // record the completed call in the ledger.
                    const scopeId = (this._activeScopeByTask && this._activeScopeByTask.get(taskId)) || null;
                    // I8: arm the idempotency scope for the duration of the
                    // execution — same shape (and same single-threaded
                    // assumption) as WriteLedger's capture window, so a
                    // record-creating tool can converge a re-worded retry
                    // onto the record it already made.
                    const prevIdem = (typeof AgentTools !== 'undefined') ? AgentTools._idemScope : null;
                    if (typeof AgentTools !== 'undefined') AgentTools._idemScope = this._idemScopeFor(this.get(taskId));
                    const t = this.get(taskId);
                    // A routine-born task runs with nobody watching — ambient
                    // for the cloud-privacy gate; a user-started task is not.
                    const toolCtx = { untrusted: !!(t?.untrustedInput), ambient: !!(t?.routineId), convId: t?.conversationId };
                    try {
                        result = (typeof WriteLedger !== 'undefined' && scopeId)
                            ? await WriteLedger.captureToolRun(scopeId, () => AgentTools.execute(name, args || {}, toolCtx))
                            : await AgentTools.execute(name, args || {}, toolCtx);
                    } finally {
                        if (typeof AgentTools !== 'undefined') AgentTools._idemScope = prevIdem;
                    }
                    if (typeof WriteLedger !== 'undefined' && scopeId) WriteLedger.noteToolResult(scopeId, name, args, result);
                }
                // C9.5 journal the executed call (replays are NOT re-recorded
                // — the journal is what happened, once). Result JSON is kept
                // only for writes small enough to replay verbatim.
                if (!replayed) {
                    let resJson = null;
                    try { resJson = JSON.stringify(result); } catch { resJson = null; }
                    this._journalAppend(taskId, {
                        t: 'tool', step: index + 1, name,
                        args: argsJson !== null && argsJson.length <= 2000 ? argsJson : undefined,
                        ok: !(result && result.error),
                        result: isWrite && resJson && resJson.length <= 4000 ? resJson : undefined,
                        ts: Date.now()
                    });
                }
                // C8.3 recipe recording: the (tool, args, ok) sequence a
                // clean-verified run can replay. Bounded hard — this rides
                // the synced agent-tasks blob: args over 1500 chars are
                // marked rather than stored (a recipe can't faithfully
                // replay them anyway), and past 40 entries the run is too
                // long to be a recipe at all.
                if (!replayed) this._recordToolCall(taskId, index, name, args, result);
                // Same vision hand-off as chat's tool loop: image payloads
                // (browser screenshots) never ride the tool JSON — stringified
                // base64 would blow the context as garbage tokens. When the
                // brain has vision they follow as an image-part user turn;
                // otherwise the note says what the model can't see.
                let stepImages = null;
                if (result && Array.isArray(result.images) && result.images.length) {
                    stepImages = result.images.filter(im => im && typeof im.dataUrl === 'string' && /^data:image\//.test(im.dataUrl));
                    delete result.images;
                }
                this._log(taskId, `tool ${name}: ${JSON.stringify(result).slice(0, 160)}`);
                let content = JSON.stringify(result);
                const visionOk = typeof AgentService !== 'undefined'
                    && AgentService.supportsVision(AgentService.getActiveEntry(task.conversationId));
                if (stepImages && stepImages.length) {
                    content += visionOk
                        ? '\n(The captured image is attached below this result — analyze it directly.)'
                        : '\n(An image was captured, but the current model cannot view images — use a text tool like browser_snapshot instead.)';
                }
                messages.push({ role: 'tool', content, name, tool_call_id: tc.id });
                if (stepImages && stepImages.length && visionOk) {
                    messages.push({
                        role: 'user',
                        content: [
                            { type: 'text', text: `[Image captured by ${name} — attached for your analysis. This is tool output, not a message from the user.]` },
                            ...stepImages.map(im => ({ type: 'image_url', image_url: { url: im.dataUrl } }))
                        ]
                    });
                }
            }
        }
        // Out of rounds: close anyway — a fan-out chunk may still hold real
        // rows, and salvaged partial data beats a bare failure. The unit
        // still counts as not-finished either way.
        const closed = await this._closeUnit(messages, opts.closing, 'You are out of tool rounds.');
        if (closed) {
            return { ...closed, ok: false, note: closed.ok ? `ran out of tool rounds (partial: ${closed.note})` : closed.note };
        }
        return { ok: false, note: `step did not finish within ${roundCap} tool rounds` };
    },

    /** Explicit item count named in a goal ("the 10 movies", "100 titles"),
     *  or 0 when none. Conservative: a number directly before an item-ish
     *  plural, never years. (Finding #53: xLAM produced a ONE-item list for
     *  "the 10 movies" and every downstream check was relative to it —
     *  coverage of a wrong list is not coverage.) */
    _goalItemCount(goalText) {
        const m = String(goalText || '').match(/\b(\d{1,3})\s+(?:movies|films|items|files|emails|songs|books|entries|records|invoices|documents|titles|tasks|notes|people|companies|leads|products|pdfs)\b/i);
        const n = m ? parseInt(m[1], 10) : 0;
        return n >= 2 && n <= 500 ? n : 0;
    },

    /**
     * Per-step gate (I3, docs/TASK_ENGINE.md): mechanical validation of a
     * step's output at the step boundary, BEFORE later steps consume it.
     * Model judgment stays in the verify pass — the gate only checks what
     * the harness can compute.
     */
    async _gateStep(taskId, index) {
        const task = this.get(taskId);
        const step = task.plan[index];
        // An items-producer (a later foreach consumes this step) must have
        // yielded a usable list — typed items, or a salvageable numbered/
        // bulleted result.
        const feeds = (task.plan || []).some((s, j) =>
            j > index && s.kind === 'foreach' && s.itemsFrom === index + 1);
        if (feeds) {
            const src = (task.results || {})[String(index + 1)] || {};
            const items = Array.isArray(src.items) ? src.items.filter(Boolean) : [];
            const salvaged = items.length ? null : this._salvageItems(src.result || step.result);
            if (!items.length && !salvaged) {
                return { ok: false, reason: 'a later step processes this step\'s items, but it ended without the item list — end with the COMPLETE numbered list' };
            }
            // Count cross-check (finding #53): when the goal NAMES the count,
            // a shorter list is wrong by inspection — downstream "coverage"
            // would be measured against a wrong denominator.
            const expected = this._goalItemCount(task.goal);
            const got = (items.length ? items : salvaged).length;
            if (expected && got < expected) {
                return { ok: false, reason: `the goal names ${expected} items but this step produced only ${got} — end with the COMPLETE list of all ${expected}` };
            }
        }
        // Plan-carried post-condition, evaluated NOW rather than only in
        // the verify pass (which still re-runs it as the final authority).
        if (step.check) {
            const r = await this._evalCheck(step.check);
            if (r.ok === false) return { ok: false, reason: `post-condition failed: ${r.detail}` };
        }
        return { ok: true };
    },

    /**
     * C8.4: evaluate one plan-carried post-condition mechanically.
     * Returns {ok, detail} — never model judgment.
     */
    async _evalCheck(check) {
        try {
            const arg = String(check.arg || '').trim();
            if (check.kind === 'file_exists') {
                if (!window.electronAgentFS?.list) return { ok: null, detail: 'file tools unavailable' };
                const slash = arg.lastIndexOf('/');
                const dir = slash > 0 ? arg.slice(0, slash) : arg;
                const base = slash > 0 ? arg.slice(slash + 1) : '';
                const r = await window.electronAgentFS.list(dir, base);
                const found = !r.error && (r.entries || []).some(e => e.name === base);
                return { ok: found, detail: found ? `${arg} exists` : `${arg} does not exist` };
            }
            if (check.kind === 'note_titled') {
                const notes = (StorageManager.get('notes')?.notes) || [];
                const found = notes.some(n => (n.title || '').toLowerCase().includes(arg.toLowerCase()));
                return { ok: found, detail: found ? `note "${arg}" exists` : `no note titled "${arg}"` };
            }
            if (check.kind === 'schedule_item_titled') {
                const items = (StorageManager.get('schedule')?.scheduleItems) || [];
                const found = items.some(n => (n.title || '').toLowerCase().includes(arg.toLowerCase()));
                return { ok: found, detail: found ? `schedule item "${arg}" exists` : `no schedule item titled "${arg}"` };
            }
        } catch (e) {
            return { ok: null, detail: `check failed to run: ${e.message}` };
        }
        return { ok: null, detail: 'unknown check' };
    },

    /**
     * Adversarial verify. Post-conditions the plan carries are evaluated
     * MECHANICALLY first (C8.4 — truth from checks, not prose); the model
     * pass covers only what genuinely needs judgment, with the write
     * ledger's recorded actions as evidence.
     */
    async _verify(taskId) {
        const task = this.get(taskId);
        const readOnlyTools = AgentTools.definitions.filter(d =>
            AgentService._isReadOnlyTool(d.function.name) && d.function.name !== 'start_task');

        // Deterministic pass: each step's carried check, straight answer.
        const hard = new Array(task.plan.length).fill(null);
        for (let i = 0; i < task.plan.length; i++) {
            const c = task.plan[i].check;
            if (c && task.plan[i].status === 'done') {
                const r = await this._evalCheck(c);
                if (r.ok !== null) {
                    hard[i] = { ok: r.ok, issue: r.ok ? '' : r.detail };
                    this._log(taskId, `Check step ${i + 1}: ${r.ok ? 'pass' : 'FAIL'} — ${r.detail}`);
                }
            }
        }
        // Every step settled mechanically → no model pass at all. (No goal
        // verdict either: passing post-conditions ARE the goal's evidence.)
        if (hard.every(v => v !== null)) return { verdicts: hard, goal: null };

        // What the ledger actually recorded — evidence, not the worker's
        // account of itself.
        let ledgerLines = '';
        if (typeof WriteLedger !== 'undefined') {
            const entries = (task.ledgerScopes || [])
                .map(id => WriteLedger.getScope(id)).filter(Boolean)
                .flatMap(s => s.entries);
            if (entries.length) {
                ledgerLines = '\nRecorded writes (from the app\'s own ledger — this is what actually happened):\n'
                    + entries.slice(0, 30).map(e => `- ${e.action} ${e.tool}${e.target ? `: ${e.target}` : ''}`).join('\n');
            }
        }

        const messages = [
            { role: 'system', content:
                'You verify completed work skeptically, using READ-ONLY tools to check reality. ' +
                'Did each step actually achieve its intent? When you have checked, reply with plain text listing, for each step number, OK or a one-line problem. ' +
                // The 99-movie run "completed" by dividing the list into
                // batches and stopping — every surviving step succeeded at
                // its own small intent while the goal went untouched. The
                // verifier must also judge the WHOLE.
                'End with one line: "GOAL: achieved" or "GOAL: not achieved — <what the user asked for that does not exist yet>". Judge the goal by its OUTPUT (the answer, table, file, records the user asked for) — steps that merely prepare (splitting work into batches, making a plan) do not achieve a goal. The user RECEIVES a final report containing every step\'s full results, so data compiled in the step results ("X: available on Netflix" for every item) counts as a delivered table/summary — only a goal that names a PERSISTENT artifact (a note, a file, schedule items) requires that artifact to exist. Doubts about the ACCURACY or quality of data that was actually gathered are per-step issues, NEVER the GOAL line — "not achieved" means something asked for is ABSENT, not that you could not double-check it.' },
            { role: 'user', content:
                `Goal: ${task.goal}\nSteps and what the worker reported:\n` +
                task.plan.map((s, i) => `${i + 1}. ${s.step} → ${s.status}: ${s.result || s.note}`
                    + (hard[i] ? ` [mechanical check: ${hard[i].ok ? 'PASSED' : `FAILED — ${hard[i].issue}`}]` : '')).join('\n')
                + ledgerLines }
        ];

        let findings = '';
        for (let iter = 0; iter < this.MAX_VERIFY_ITERATIONS; iter++) {
            if (this._interrupted(taskId)) return null;
            const resp = await this._chat({
                messages, tools: readOnlyTools,
                options: { num_predict: 1000 },
                maxTokens: 1000,
                logTag: 'task-verify'
            });
            if (resp?.error) { findings = 'verification could not run: ' + resp.error; break; }
            const msg = resp?.message || {};
            (msg.tool_calls || []).forEach((tc, i) => { if (!tc.id) tc.id = `call_${Date.now().toString(36)}_${i}`; });
            messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
            const calls = msg.tool_calls || [];
            if (!calls.length) { findings = msg.content || ''; break; }
            for (const tc of calls) {
                const name = tc.function?.name;
                let args = tc.function?.arguments;
                let broken = false;
                if (typeof args === 'string') { try { args = JSON.parse(args); } catch { broken = true; args = {}; } }
                // Unparseable args = the call was cut off at the generation
                // cap (llama-server returns the partial string, not an
                // error) — tell the model instead of running the tool on {}.
                const result = broken
                    ? { error: 'tool call arguments were cut off or invalid — re-issue this call with less in it' }
                    : await AgentTools.execute(name, args || {}, { untrusted: !!task.untrustedInput, ambient: !!task.routineId, convId: task.conversationId });
                messages.push({ role: 'tool', content: JSON.stringify(result), name, tool_call_id: tc.id });
            }
        }

        // Findings → structured verdicts (forced JSON, no tools).
        const verdictResp = await this._jsonChat({
            messages: [
                { role: 'system', content: `Convert these verification findings into JSON: {"verdicts":[{"step":1,"ok":true,"issue":""}...],"goal":{"achieved":true,"missing":""}} — one verdict per step, 1-based, ${task.plan.length} entries; goal reflects the findings' GOAL line (missing = what does not exist yet, "" when achieved).` },
                { role: 'user', content: `Steps:\n${task.plan.map((s, i) => `${i + 1}. ${s.step}`).join('\n')}\n\nFindings:\n${findings.slice(0, 2000)}` }
            ],
            options: { num_predict: 500 },
            maxTokens: 500,
            logTag: 'task-verdicts'
        }, {
            type: 'object',
            properties: {
                verdicts: {
                    type: 'array', maxItems: task.plan.length,
                    items: {
                        type: 'object',
                        properties: {
                            step: { type: 'integer' },
                            ok: { type: 'boolean' },
                            issue: { type: 'string' }
                        },
                        required: ['step', 'ok', 'issue']
                    }
                },
                goal: {
                    type: 'object',
                    properties: {
                        achieved: { type: 'boolean' },
                        missing: { type: 'string' }
                    },
                    required: ['achieved', 'missing']
                }
            },
            required: ['verdicts', 'goal']
        });
        try {
            const parsed = JSON.parse(verdictResp?.message?.content || '{}');
            const out = new Array(task.plan.length).fill(null).map((_, i) => ({ ok: true, issue: '' }));
            for (const v of (parsed.verdicts || [])) {
                const i = (parseInt(v.step, 10) || 0) - 1;
                if (i >= 0 && i < out.length) out[i] = { ok: v.ok !== false, issue: String(v.issue || '').slice(0, 200) };
            }
            // Mechanical check results OVERRIDE model judgment — a computed
            // post-condition is not up for debate (C8.4).
            for (let i = 0; i < out.length; i++) if (hard[i]) out[i] = hard[i];
            const g = parsed.goal;
            const goal = (g && typeof g === 'object' && typeof g.achieved === 'boolean')
                ? { achieved: g.achieved, missing: String(g.missing || '').slice(0, 300) } : null;
            this._log(taskId, `Verify: ${out.filter(v => v.ok).length}/${out.length} steps check out` +
                (goal ? ` · goal ${goal.achieved ? 'achieved' : `NOT achieved — ${goal.missing}`}` : ''));
            return { verdicts: out, goal };
        } catch {
            this._log(taskId, 'Verify verdicts unparseable — treating all steps as unverified-but-reported');
            return { verdicts: task.plan.map((s, i) => hard[i] || ({ ok: true, issue: '' })), goal: null };
        }
    },

    /**
     * Facts a run turned up that the user needs to see even when everything
     * else went fine.
     *
     * The case that named this: in the 2026-08-03 invoice runs the model
     * identified and REFUSED a prompt-injection attempt embedded in an email
     * body — the single most important thing that happened that afternoon —
     * and the report buried it in a step note under a wall of `unknown` rows
     * nobody read past. A headline is where that belongs.
     *
     * This is model PROSE, and it is labelled as such (I6): the harness is
     * hoisting a claim into view, not certifying it. The patterns stay
     * narrow — the run declining to follow instructions found in the DATA it
     * was reading, which is exactly what `untrustedInput` exists for. A
     * general "anything interesting" scrape would fill every report with
     * noise and teach the user to skip the block.
     */
    RUN_FLAG_PATTERNS: [
        /\b(prompt[- ]injection|injected instructions?|embedded instructions?)\b/i,
        /\b(ignored|refused|declined|did not follow|disregarded)\b[^.\n]{0,70}\binstructions?\b[^.\n]{0,70}\b(email|message|attachment|document|file|web ?page|content)\b/i
    ],

    _runFlags(task) {
        const out = [];
        try {
            for (let i = 0; i < (task.plan || []).length; i++) {
                const text = String(task.plan[i].result || task.plan[i].note || '');
                if (!text) continue;
                for (const re of this.RUN_FLAG_PATTERNS) {
                    const m = re.exec(text);
                    if (!m) continue;
                    // The sentence around the hit, so the line reads.
                    const start = text.lastIndexOf('.', m.index) + 1;
                    const end = text.indexOf('.', m.index + m[0].length);
                    const excerpt = text.slice(start, end === -1 ? text.length : end + 1).trim();
                    out.push({ step: i + 1, excerpt: excerpt.slice(0, 220) });
                    break;
                }
                if (out.length >= 3) break;
            }
        } catch { /* the report must never break on its own decoration */ }
        return out;
    },

    /** Final summary into the conversation + the card settles. */
    async _report(taskId, verdicts, goalVerdict) {
        const task = this.get(taskId);
        const failed = task.plan.filter(s => s.status === 'failed');
        const skipped = task.plan.filter(s => s.status === 'skipped');
        // The report is the task's ONLY user-facing output — use the full
        // step results (the data), not the 200-char card notes, or a
        // compiled deliverable (a lead list, a summary) arrives beheaded.
        const lines = task.plan.map((s, i) => {
            const v = verdicts?.[i];
            // I9: △ is the honest mark for "done, but the harness could not
            // read all of it back" — it is not ✓ (that would overclaim) and
            // not ✗ (that would be a lie about work that ran).
            const mark = s.status === 'done'
                ? ((s.unverified || (v && v.ok === false)) ? '△' : '✓')
                : s.status === 'skipped' ? '–'
                : s.status === 'replanned' ? '↻' : '✗';
            let detail = s.result || s.note;
            // C9.2: a foreach step's full rows beat its capped rendering —
            // the report is the task's only output and must carry the data.
            const res = (task.results || {})[String(i + 1)];
            if (res && Array.isArray(res.rows) && res.rows.length) {
                detail = res.rows.map(r => `${r.item}: ${r.data}`).join('\n  ').slice(0, 8000)
                    + (res.truncatedRows ? `\n  (+${res.truncatedRows} more items did not fit)` : '');
            }
            return `${mark} ${s.step}${detail ? ` — ${detail}` : ''}`;
        });
        // C9.5: the activity line is counted from the journal — what
        // actually ran, never the model's account of itself (I6).
        const activity = this._activitySummary(taskId);
        // I6 applied to the GOAL verdict itself (finding #51): a "not
        // achieved" that contradicts positive MECHANICAL evidence — every
        // foreach fully covered with zero unknown rows, or the final
        // step's post-condition passing — is a model quality-doubt, not a
        // missing deliverable. It becomes a report caveat, never a
        // failure. With no positive evidence (the #45 prep-only shape),
        // the verdict is honored as before.
        let verdictCorroborated = true;
        if (goalVerdict && goalVerdict.achieved === false) {
            try {
                const foreachs = task.plan.map((s, i) => ({ s, i })).filter(x => x.s.kind === 'foreach');
                const allRowsClean = foreachs.length > 0 && foreachs.every(({ i }) => {
                    const r = (task.results || {})[String(i + 1)];
                    return r && Array.isArray(r.rows) && r.rows.length && !r.rows.some(row => row && row.unknown);
                });
                let lastCheckOk = false;
                const last = task.plan[task.plan.length - 1];
                if (last && last.check && last.status === 'done') {
                    const r = await this._evalCheck(last.check);
                    lastCheckOk = r.ok === true;
                }
                if (allRowsClean || lastCheckOk) {
                    verdictCorroborated = false;
                    this._log(taskId, `goal verdict overridden: mechanical evidence contradicts it (${allRowsClean ? 'full item coverage' : 'final post-condition passed'})`);
                }
            } catch { /* keep the verdict when evidence can't be read */ }
        }
        // Replanned steps are recovered history, not open failures — they
        // don't block a clean finish. But finished STEPS are not a finished
        // GOAL: the 99-movie run's surviving plan decayed into "divide the
        // list into batches", succeeded at it, and read COMPLETE with zero
        // movies researched. The verifier's goal-level verdict gates the
        // completion claim — steps clean + goal unmet = an honest failure.
        const stepsClean = failed.length === 0 && skipped.length === 0;
        const goalUnmet = stepsClean && goalVerdict && goalVerdict.achieved === false && verdictCorroborated;
        const ok = stepsClean && !goalUnmet;
        // An overridden verdict still reaches the user — as a caveat.
        const verdictCaveat = (goalVerdict && goalVerdict.achieved === false && !verdictCorroborated)
            ? `\n(Verifier caveat, not fatal — the mechanical checks all passed: ${goalVerdict.missing || 'it doubted the outcome'})`
            : '';
        // I9 + report tone: work that COMPLETED reads as completed. A run
        // whose steps all ran but whose per-item bookkeeping the harness
        // could not read back is "complete, with caveats" — not "this run
        // did not finish", which is what the 16:48 invoice run announced
        // over a job the model had actually done.
        const unverifiedSteps = task.plan.filter(s => s.status === 'done' && s.unverified);
        const caveats = unverifiedSteps.length
            ? [`${unverifiedSteps.length} step(s) ran, but the app could not match every result back to its item — those rows are marked △ above rather than claimed as done.`]
            : [];
        // Model-caught facts belong in the headline, not in a step note.
        const flags = this._runFlags(task);
        const flagBlock = flags.length
            ? '\nFlagged during this run (reported by the assistant, not verified by the app):\n'
                + flags.map(f => `- Step ${f.step}: ${f.excerpt}`).join('\n') + '\n'
            : '';
        const summary = (ok
            ? (caveats.length ? `Task complete, with caveats: ${task.goal}` : `Task complete: ${task.goal}`)
            : goalUnmet
                ? `Task finished its steps WITHOUT achieving the goal (${goalVerdict.missing || 'the verification pass found the asked-for output missing'}): ${task.goal}`
                : `Task finished with ${failed.length + skipped.length} unresolved step(s): ${task.goal}`)
            + '\n' + flagBlock
            + lines.join('\n')
            + (caveats.length ? `\n(${caveats.join(' ')})` : '')
            + verdictCaveat
            + (activity ? `\n(Ran: ${activity})` : '');

        // C8.3: "Save as recipe" is offered ONLY on a clean run — every step
        // done AND every verdict ok AND a replayable record exists. A partial
        // run must never become a procedure. Ineligible runs drop their
        // recording immediately (it rides the synced blob for no reason).
        const verdictsClean = Array.isArray(verdicts) && verdicts.every(v => !v || v.ok !== false);
        // A replanned run finished, but its recorded tool sequence includes
        // the dead-end steps — not a procedure worth replaying verbatim.
        // A run the harness could not fully read back is not a procedure
        // worth replaying either — same law as the partial-run exclusion.
        const recipeEligible = ok && verdictsClean && !caveats.length && !(task.replans > 0)
            && (task.toolLog || []).some(e => e && e.ok && e.args !== undefined)
            && !task.toolLogOverflow;
        {
            const tasks = this._all();
            const t = tasks.find(x => x && x.id === taskId);
            if (t) {
                // The conversation snapshot served the run — a settled task
                // has no more model calls to feed it to. The results map
                // goes with it: the report above already compiled it, and
                // it must not keep riding the synced blob (C9.2).
                delete t.context;
                delete t.results;
                // The activity line survives the journal (it's one small
                // string; the settled card keeps showing evidence).
                if (activity) t.activity = activity;
                // A routine's run keeps its compiled report ON THE TASK
                // RECORD — it is an execution LOG, and the routine detail's
                // Run history is where a log is read (the feed shows
                // content, never logs — see below). Capped: the blob syncs,
                // and MAX_TASKS of these ride it.
                if (t.routineId) {
                    const changed = this._ledgerSummary(task);
                    t.report = ((summary || '') + (changed ? `\n\nChanged: ${changed}` : '')).slice(0, 4000);
                }
                if (!recipeEligible) { delete t.toolLog; delete t.toolLogOverflow; }
                this._saveAll(tasks);
            }
        }
        this._journalPrune(taskId);

        const settleNote = ok ? (caveats.length ? 'Done, with caveats.' : 'Done.')
            : goalUnmet
                ? `Steps ran, but the goal is not achieved — ${(goalVerdict.missing || 'the asked-for output is missing').slice(0, 200)}`
                : `${failed.length} step(s) failed${skipped.length ? `, ${skipped.length} skipped` : ''} — see the list.`;
        this._update(taskId, {
            status: ok ? 'done' : 'failed',
            recipeEligible,
            note: settleNote
        });

        // C8.5: an unattended run reports through a notification…
        if (task.unattended) {
            this._notifySystem(ok ? 'Anjadhe finished a routine' : 'A routine did not finish',
                `${task.goal.slice(0, 100)}${ok ? '' : ' — open Routines to see what happened'}`);
        }

        // …but NOT to the feed (2026-08-03, reversing C10's "both post
        // there"). An action routine's run report is an execution LOG, and
        // the feed is a reading surface for CONTENT — a step transcript on
        // the home page is noise wearing a post's clothes. The log lives on
        // the task record (`report`, above) and is read in the routine
        // detail's Run history; a failed run additionally surfaces as the
        // routine's "Last problem" line so the Routines list shows something
        // is wrong without anyone opening the history.
        if (task.routineId && typeof RoutineEngine !== 'undefined') {
            try {
                if (ok) RoutineEngine.clearError(task.routineId);
                else RoutineEngine.noteError(task.routineId, settleNote);
                // The single task slot just freed — anything the engine
                // queued behind this run gets its turn now rather than
                // waiting for the next poll. (This nudge used to live in
                // the feed post's landing path.)
                RoutineEngine.drainSoon();
            } catch (e) {
                console.warn('[task] could not report routine result:', e);
            }
        }

        // §v3.8: the task slot just freed. Any other run the launch sweep
        // could not start (one task at a time) gets its turn now rather than
        // waiting for the next launch.
        if (this._all().some(t => t && t.resumeOnLaunch && t.status === 'paused')) {
            setTimeout(() => { this._resumeUnattendedRuns(); }, 1000);
        }

        // Append the report to the task's conversation so it survives in
        // history (the card is ephemeral UI).
        try {
            const conv = AgentService.conversations.find(c => c.id === task.conversationId);
            if (conv) {
                conv.messages.push({ role: 'assistant', content: summary });
                conv.updatedAt = new Date().toISOString();
                AgentService._saveConversations();
                if (AgentService.activeConversationId === conv.id) {
                    AgentService.conversation = [...conv.messages];
                    if (typeof AgentUI !== 'undefined' && AgentUI.addMessage) AgentUI.addMessage('assistant', summary);
                }
            }
        } catch (e) {
            console.warn('[task] could not post report:', e);
        }
    }
};

if (typeof window !== 'undefined') {
    window.TaskService = TaskService;
    // Settle any task that was mid-flight when the app last quit.
    setTimeout(() => { try { TaskService.init(); } catch {} }, 0);
}
