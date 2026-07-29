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

    _controls: new Map(),   // taskId -> { pause: bool, cancel: bool }

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
        return (typeof ProfileManager !== 'undefined')
            ? ProfileManager.filterByActiveProfile(tasks)
            : tasks;
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
        }
        Object.assign(t, patch, { updatedAt: new Date().toISOString() });
        this._saveAll(tasks);
        this._notify(t);
        return t;
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

    /**
     * App-start hygiene: anything that was mid-flight when the app died
     * resumes as paused — a task must never auto-run on launch.
     */
    init() {
        const tasks = this._all();
        let changed = false;
        for (const t of tasks) {
            if (t && ['planning', 'running', 'verifying'].includes(t.status)) {
                t.status = 'paused';
                t.note = 'Paused by app restart — resume from the task card.';
                changed = true;
            }
        }
        if (changed) this._saveAll(tasks);
    },

    // ── LLM plumbing (same seam the engines use — one brain) ─────────────

    _model() {
        if (typeof AgentService !== 'undefined' && AgentService.getActiveModel) {
            const m = AgentService.getActiveModel(AgentService.activeConversationId);
            if (m) return m;
        }
        return StorageManager.get('agent-settings')?.selectedModel || null;
    },

    async _chat(params) {
        // Same remote-entry routing as LLMLogger: a server/cloud brain needs
        // its entry's API key resolved in main, or task-mode calls fail with
        // "Invalid API key" while chat works.
        const routing = (typeof AgentService !== 'undefined' && AgentService.remoteEntryRouting)
            ? AgentService.remoteEntryRouting() : {};
        return await window.electronLLM.chat({ model: this._model(), think: false, ...routing, ...params });
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
        if (/\b(portfolio|stocks?|holdings?|shares|tickers?|trades?|brokerage)\b/i.test(goal)) implied.push('portfolio');
        if (/\b(calendar|meetings?|appointments?)\b/i.test(goal)) implied.push('calendar');
        if (/\b(journal|diary)\b/i.test(goal)) implied.push('journal');
        if (/\b(goals?|focus areas?)\b/i.test(goal)) implied.push('goals');
        return implied;
    },

    _toolsForGroups(groupNames, extraGroups) {
        const wanted = new Set([...(groupNames || []), ...(extraGroups || [])]);
        // Same gating as chat: with the master toggle off, the web_search
        // schema must not ship — a step that calls it gets an error it tends
        // to read as "no web at ALL" and abandons browser/read_url work
        // it could have done.
        const searchOff = typeof AgentService !== 'undefined' && AgentService._webSearchReady === false;
        return AgentTools.definitions.filter(d => {
            const g = AgentTools._toolGroups[d.function.name] || 'core';
            if (d.function.name === 'start_task') return false;  // no nesting
            if (searchOff && d.function.name === 'web_search') return false;
            const alias = g.startsWith('userapp:mcp:') ? g.slice('userapp:'.length) : g;
            return g === 'core' || wanted.has(g) || wanted.has(alias);
        });
    },

    // ── Lifecycle ─────────────────────────────────────────────────────────

    /**
     * Create a task and produce its plan. Ends in `awaiting_user` — the
     * plan-approval card is the consent moment; nothing executes before
     * approve().
     */
    async start(goal, conversationId) {
        const text = String(goal || '').trim();
        if (!text) return { error: 'goal required' };
        if (this._all().some(t => ['planning', 'running', 'verifying'].includes(t?.status))) {
            return { error: 'Another task is already running. One task at a time.' };
        }

        const task = {
            id: 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            conversationId: conversationId || null,
            goal: text,
            plan: [],
            status: 'planning',
            note: '',
            stepIndex: 0,
            retried: false,
            toolCalls: 0,
            profile: (typeof ProfileManager !== 'undefined') ? ProfileManager.getProfileForNewItem() : null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            log: []
        };
        this._saveAll([task, ...this._all()]);
        this._controls.set(task.id, { pause: false, cancel: false });
        this._notify(task);

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
        const planResp = await this._chat({
            messages: [
                { role: 'system', content:
                    'You break a user goal into a SHORT checklist of concrete steps for an assistant that has tools.\n' +
                    `Available tool groups: ${groups.join(', ')}. ${coreLine}\n` +
                    'Reply ONLY with JSON: {"steps":[{"step":"imperative description","tools":["group",...]}]}\n' +
                    `Rules: at most ${this.MAX_STEPS} steps; each step one action; tools lists only groups from the list above (may be empty).` },
                { role: 'user', content: `Goal: ${text}` }
            ],
            format: 'json',
            options: { num_predict: 800 },
            maxTokens: 800,
            logTag: 'task-plan'
        });
        if (planResp?.error) {
            return this._update(task.id, { status: 'failed', note: `Planning failed: ${planResp.error}` }) && { error: planResp.error };
        }

        let steps = [];
        try {
            const parsed = JSON.parse(planResp?.message?.content || '{}');
            steps = (parsed.steps || [])
                .filter(s => s && typeof s.step === 'string' && s.step.trim())
                .slice(0, this.MAX_STEPS)
                .map(s => ({
                    step: s.step.trim().slice(0, 200),
                    tools: (Array.isArray(s.tools) ? s.tools : []).filter(t => groups.includes(t)),
                    status: 'pending',
                    note: ''
                }));
        } catch { /* fall through to the empty-plan error */ }
        if (!steps.length) {
            this._update(task.id, { status: 'failed', note: 'The model could not produce a usable plan for this goal.' });
            return { error: 'no usable plan' };
        }

        this._log(task.id, `Planned ${steps.length} steps`);
        this._update(task.id, { plan: steps, status: 'awaiting_user', note: 'Review the plan, then run it.' });
        return { ok: true, taskId: task.id, steps: steps.map(s => s.step) };
    },

    /** User approved the plan — run it. */
    async approve(taskId) {
        const task = this.get(taskId);
        if (!task || task.status !== 'awaiting_user') return { error: 'task is not awaiting approval' };
        this._controls.set(taskId, { pause: false, cancel: false });
        this._update(taskId, { status: 'running', note: '' });
        this._run(taskId);  // fire and forget — the card tracks progress
        return { ok: true };
    },

    pause(taskId) {
        const c = this._controls.get(taskId);
        if (c) c.pause = true;
        return { ok: true };
    },

    async resume(taskId) {
        const task = this.get(taskId);
        if (!task || task.status !== 'paused') return { error: 'task is not paused' };
        this._controls.set(taskId, { pause: false, cancel: false });
        this._update(taskId, { status: 'running', note: '' });
        this._run(taskId);
        return { ok: true };
    },

    cancel(taskId) {
        const c = this._controls.get(taskId);
        if (c) c.cancel = true;
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
                const result = await this._runStep(taskId, i);
                if (result.interrupted) return;
                this._setStep(taskId, i, { status: result.ok ? 'done' : 'failed', note: result.note, result: result.result });
                this._log(taskId, `Step ${i + 1}: ${result.ok ? 'done' : 'FAILED'} — ${result.note}`);
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
            const verdicts = await this._verify(taskId);
            if (this._interrupted(taskId)) return;

            const failedIdx = (verdicts || [])
                .map((v, i) => (v && v.ok === false ? i : -1))
                // Skipped steps don't get the retry pass — their
                // prerequisites failed, so re-running them alone can't work.
                .filter(i => i !== -1 && i < task.plan.length && task.plan[i].status !== 'skipped');
            if (failedIdx.length && !task.retried) {
                this._update(taskId, { status: 'running', retried: true, note: `Fixing ${failedIdx.length} step(s) that didn't check out…` });
                for (const i of failedIdx) {
                    if (this._interrupted(taskId)) return;
                    const issue = verdicts[i]?.issue || 'did not achieve its intent';
                    this._setStep(taskId, i, { status: 'active', note: `retry: ${issue}` });
                    const result = await this._runStep(taskId, i, issue);
                    if (result.interrupted) return;
                    this._setStep(taskId, i, { status: result.ok ? 'done' : 'failed', note: result.note, result: result.result });
                }
            }

            await this._report(taskId, verdicts);
        } catch (e) {
            console.error('[task] run failed:', e);
            this._update(taskId, { status: 'failed', note: `Task crashed: ${e.message}` });
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
     * no briefing. Ends on a DONE:/FAILED: line, a no-tool reply, or the
     * iteration cap.
     */
    async _runStep(taskId, index, retryIssue) {
        const task = this.get(taskId);
        const step = task.plan[index];
        const tools = this._toolsForGroups(step.tools, this._impliedGroups(task.goal));
        const messages = [
            { role: 'system', content:
                'You are executing ONE step of an approved plan, using tools. Do only this step.\n' +
                'When you need the same lookup for several independent items, put SEVERAL tool calls in ONE reply — they run together and cost one round; one lookup at a time wastes your limited rounds.\n' +
                'When the step is complete, reply "DONE:" followed by the CONCRETE DATA this step produced — the actual names, emails, figures, links, findings that later steps need. Later steps see ONLY your DONE text, never your tool results, so anything you leave out of it is lost.\n' +
                'If you cannot complete it, reply: FAILED: <why>.' +
                (typeof AgentService !== 'undefined' && AgentService._webSearchReady === false
                    ? '\nNote: web SEARCH is turned off in the user\'s settings — but that disables only searching. Opening specific URLs (read_url) and any browser tools still work; use them rather than declaring web work impossible.'
                    : '') +
                // Task steps don't carry chat's BROWSING guidance, so a small
                // model fought cnbc.com with read_url (thin JS-rendered text)
                // while browser tools sat unused. One line fixes the reach.
                (tools.some(d => /^mcp_.*browser/i.test(d.function?.name || ''))
                    ? '\nWeb pages: if read_url returns thin, blocked, or navigation-only text, the site needs a real browser — use the browser_* tools (navigate ONCE per URL, then read/snapshot/screenshot it) instead of retrying read_url.'
                    : '') },
            { role: 'user', content:
                `Overall goal: ${task.goal}\n` +
                `Plan so far: ${task.plan.map((s, i) => `${i + 1}. ${s.step}${s.status === 'done' ? ` (done: ${s.result || s.note})` : ''}`).join(' | ')}\n` +
                `Your step (#${index + 1}): ${step.step}` +
                (retryIssue ? `\nA verification pass found a problem with your earlier attempt: ${retryIssue}. Fix it.` : '') }
        ];

        // Stall detection: a step that keeps issuing the SAME call with the
        // SAME args is looping, not working. First repeat past two runs gets
        // a corrective note instead of a wasted execution; the next one
        // fails the step honestly. Observation tools (snapshot/screenshot/
        // continue_output) legitimately repeat — the page state is what
        // changes — so they're exempt, same as chat's repeat cap.
        const callCounts = new Map();
        const repeatExempt = (n) => /^mcp_/.test(n)
            && /(snapshot|screenshot|console|network|tabs?|find|continue_output)/.test(n);
        const stepStart = Date.now();
        // Fan-out steps ("read EACH article", "for EVERY item…") need far
        // more rounds than a single action: navigate + read + page-through
        // per item. Ten articles died at the flat 12-round cap — iteration
        // language doubles the allowance (time box and call budget still
        // bound the worst case).
        const fanOut = /\b(each|every|all\s+(the\s+)?\w+s)\b/i.test(step.step);
        const roundCap = fanOut ? this.MAX_STEP_ITERATIONS * 2 : this.MAX_STEP_ITERATIONS;

        for (let iter = 0; iter < roundCap; iter++) {
            if (this._interrupted(taskId)) return { interrupted: true };
            if (Date.now() - stepStart > this.STEP_TIME_MS) {
                return { ok: false, note: `step ran past its ${Math.round(this.STEP_TIME_MS / 60000)}-minute time box` };
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
                const engineDown = /not running|no server|still loading|loading the model/i.test(resp.error);
                const maxRetries = engineDown ? 4 : this.MODEL_ERROR_RETRIES;
                if (attempt >= maxRetries) break;
                this._log(taskId, `model error (retry ${attempt + 1}): ${resp.error}`);
                await new Promise(r => setTimeout(r, engineDown ? 15000 : 2000 * (attempt + 1)));
                if (this._interrupted(taskId)) return { interrupted: true };
            }
            if (resp?.error) return { ok: false, note: `model error: ${resp.error}` };
            const msg = resp?.message || {};
            (msg.tool_calls || []).forEach((tc, i) => { if (!tc.id) tc.id = `call_${Date.now().toString(36)}_${i}`; });
            messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });

            const calls = msg.tool_calls || [];
            if (!calls.length) {
                const text = (msg.content || '').trim();
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
                const perm = await AgentService._resolvePermission(name, args);
                if (perm.decision === 'deny') {
                    result = { error: `Blocked by permissions: ${perm.reason || 'not allowed'}` };
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
                if (!result) result = await AgentTools.execute(name, args || {});
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
        return { ok: false, note: `step did not finish within ${this.MAX_STEP_ITERATIONS} tool rounds` };
    },

    /**
     * Adversarial verify: read-only tools only, then a tiny forced-JSON
     * call converts the findings into per-step verdicts.
     */
    async _verify(taskId) {
        const task = this.get(taskId);
        const readOnlyTools = AgentTools.definitions.filter(d =>
            AgentService._isReadOnlyTool(d.function.name) && d.function.name !== 'start_task');

        const messages = [
            { role: 'system', content:
                'You verify completed work skeptically, using READ-ONLY tools to check reality. ' +
                'Did each step actually achieve its intent? When you have checked, reply with plain text listing, for each step number, OK or a one-line problem.' },
            { role: 'user', content:
                `Goal: ${task.goal}\nSteps and what the worker reported:\n` +
                task.plan.map((s, i) => `${i + 1}. ${s.step} → ${s.status}: ${s.result || s.note}`).join('\n') }
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
                if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
                const result = await AgentTools.execute(name, args || {});
                messages.push({ role: 'tool', content: JSON.stringify(result), name, tool_call_id: tc.id });
            }
        }

        // Findings → structured verdicts (forced JSON, no tools).
        const verdictResp = await this._chat({
            messages: [
                { role: 'system', content: `Convert these verification findings into JSON: {"verdicts":[{"step":1,"ok":true,"issue":""}...]} — one entry per step, 1-based, ${task.plan.length} entries.` },
                { role: 'user', content: `Steps:\n${task.plan.map((s, i) => `${i + 1}. ${s.step}`).join('\n')}\n\nFindings:\n${findings.slice(0, 2000)}` }
            ],
            format: 'json',
            options: { num_predict: 500 },
            maxTokens: 500,
            logTag: 'task-verdicts'
        });
        try {
            const parsed = JSON.parse(verdictResp?.message?.content || '{}');
            const out = new Array(task.plan.length).fill(null).map((_, i) => ({ ok: true, issue: '' }));
            for (const v of (parsed.verdicts || [])) {
                const i = (parseInt(v.step, 10) || 0) - 1;
                if (i >= 0 && i < out.length) out[i] = { ok: v.ok !== false, issue: String(v.issue || '').slice(0, 200) };
            }
            this._log(taskId, `Verify: ${out.filter(v => v.ok).length}/${out.length} steps check out`);
            return out;
        } catch {
            this._log(taskId, 'Verify verdicts unparseable — treating all steps as unverified-but-reported');
            return task.plan.map(() => ({ ok: true, issue: '' }));
        }
    },

    /** Final summary into the conversation + the card settles. */
    async _report(taskId, verdicts) {
        const task = this.get(taskId);
        const failed = task.plan.filter(s => s.status === 'failed');
        const skipped = task.plan.filter(s => s.status === 'skipped');
        // The report is the task's ONLY user-facing output — use the full
        // step results (the data), not the 200-char card notes, or a
        // compiled deliverable (a lead list, a summary) arrives beheaded.
        const lines = task.plan.map((s, i) => {
            const v = verdicts?.[i];
            const mark = s.status === 'done' ? (v && v.ok === false ? '△' : '✓')
                : s.status === 'skipped' ? '–' : '✗';
            const detail = s.result || s.note;
            return `${mark} ${s.step}${detail ? ` — ${detail}` : ''}`;
        });
        const ok = failed.length === 0 && skipped.length === 0;
        const summary = (ok
            ? `Task complete: ${task.goal}`
            : `Task finished with ${failed.length + skipped.length} unresolved step(s): ${task.goal}`)
            + '\n' + lines.join('\n');

        this._update(taskId, {
            status: ok ? 'done' : 'failed',
            note: ok ? 'Done.'
                : `${failed.length} step(s) failed${skipped.length ? `, ${skipped.length} skipped` : ''} — see the list.`
        });

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
