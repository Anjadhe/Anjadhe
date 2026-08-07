/**
 * BackgroundWork — what is running in this window right now.
 *
 * Everything the app does with a model runs in the RENDERER: the email
 * insight drain, a routine's scheduled run, an assistant reply, a task-mode
 * run, a Maker build. A page reload throws all of it away mid-flight, and
 * Cmd+R has always been a normal thing to press here — it is how a sync merge
 * is triggered (main.js runs mergeFromOtherMachines on did-finish-load). So
 * the app's one habitual gesture is also its one way to kill half an hour of
 * local inference.
 *
 * This is the list a reload asks before it happens (AppManager.requestReload).
 * It is deliberately a REGISTRY OF QUESTIONS, not a set of flags the workers
 * have to remember to raise: each source reads state the worker already keeps
 * for its own reasons, so a new code path cannot forget to deregister itself
 * and leave the app permanently "busy".
 *
 * `resumable` is the load-bearing field. Work that survives a reload on its
 * own must NOT prompt — prompting for it would train the user to click
 * through the dialog, and then the prompt that matters gets clicked through
 * too. Email analysis persists its backlog and re-queues on the next launch,
 * so it is resumable. A model mid-sentence is not.
 */
const BackgroundWork = {
    /**
     * Each source returns null (idle) or { id, label, resumable }.
     * `label` is shown to the user, so it says what is happening in plain
     * words, not the name of the thing doing it.
     */
    _sources: [
        // Email insight analysis. Resumable: the backlog is persisted
        // (pendingAnalysisIds) and requeueMissedAnalyses picks up whatever
        // was lost mid-call on the next launch.
        () => {
            if (typeof EmailApp === 'undefined') return null;
            // Ask the STORE, not the in-memory array: a session that never
            // opened the mail app has an unloaded EmailApp whose queue is an
            // empty default, and that answered "idle" over a backlog of
            // hundreds. AppManager.init now resumes that backlog on any view,
            // which is what makes `resumable` below true.
            const { queued, reanalyzing } = EmailApp.analysisBacklogStatus
                ? EmailApp.analysisBacklogStatus()
                : { queued: (EmailApp.pendingAnalysisIds || []).length, reanalyzing: false };
            if (!EmailApp.isAnalyzing && !queued) return null;
            // A Re-analyze run is the user's own bulk job over a range they
            // picked. It resumes like any backlog, so it is not LOSABLE — but
            // it is worth being told about, which is what `warn` means.
            if (reanalyzing) {
                return {
                    id: 'email-reanalysis',
                    label: queued
                        ? `Re-analyzing your mail (${queued} email${queued === 1 ? '' : 's'} left)`
                        : 'Re-analyzing your mail',
                    resumable: true,
                    warn: true,
                };
            }
            return {
                id: 'email-analysis',
                label: queued
                    ? `Reading email for insights (${queued} queued)`
                    : 'Reading email for insights',
                resumable: true,
            };
        },

        // The assistant writing a reply. One entry per streaming
        // conversation — with several windows open on the same app, only
        // this window's streams are in this renderer's state.
        () => {
            if (typeof AgentService === 'undefined' || !AgentService.getActiveStreamingConvIds) return null;
            const n = AgentService.getActiveStreamingConvIds().length;
            if (!n) return null;
            return {
                id: 'agent-stream',
                label: n === 1 ? 'The assistant is writing a reply' : `The assistant is writing ${n} replies`,
                resumable: false,
            };
        },

        // A task-mode run started on this Mac. Reads TaskService's live set
        // rather than the stored status: the tasks blob syncs, so a run on
        // ANOTHER Mac would otherwise look like work in this window.
        () => {
            if (typeof TaskService === 'undefined' || !TaskService._activeRuns?.size) return null;
            const ids = [...TaskService._activeRuns];
            const goal = TaskService.get(ids[0])?.goal || '';
            return {
                id: 'task-run',
                label: ids.length === 1
                    ? `A task is running${goal ? `: ${goal.slice(0, 60)}` : ''}`
                    : `${ids.length} tasks are running`,
                resumable: false,
            };
        },

        // A Maker build writing an artifact.
        () => {
            if (typeof MakerService === 'undefined' || !MakerService._running) return null;
            return { id: 'maker-build', label: 'Maker is building an artifact', resumable: false };
        },

        // A routine's scheduled run (PromptFeed). Not resumable within the
        // session, but the scheduler's catch-up will run it again later — it
        // is the model call in flight that is lost, not the routine.
        () => {
            if (typeof PromptFeed === 'undefined' || !PromptFeed._busy) return null;
            // Two queues, and both are waiting on this run: the manual
            // "Run now" clicks stacked on the feed, and the engine's fired
            // triggers (R5). Neither is lost to a reload — the engine's is
            // persisted and its catch-up pass drains it — so this stays
            // non-resumable only because the model call in flight is.
            const queued = (PromptFeed._queue || []).length
                + ((typeof RoutineEngine !== 'undefined' && RoutineEngine.queue().length) || 0);
            return {
                id: 'routine-run',
                label: queued ? `A routine is running (${queued} queued)` : 'A routine is running',
                resumable: false,
            };
        },

        // A memory rebuild the user is watching. Already guarded by the
        // beforeunload hook for window close; listed here so the reload
        // dialog names it rather than the native "Leave anyway?" appearing
        // on top of our own.
        () => {
            if (typeof AgentService === 'undefined' || !AgentService._foregroundMemoryOp) return null;
            return { id: 'memory-rebuild', label: 'Building your memory summary', resumable: false };
        },
    ],

    /** Everything currently running, resumable or not. */
    running() {
        const out = [];
        for (const source of this._sources) {
            try {
                const w = source();
                if (w) out.push(w);
            } catch (e) {
                // A broken source must never be the reason a reload hangs.
                console.warn('[background-work] source failed:', e);
            }
        }
        return out;
    },

    /** Only the work a reload would actually destroy. */
    losable() {
        return this.running().filter(w => !w.resumable);
    },

    /**
     * Work a reload only INTERRUPTS: it comes back by itself, but the user
     * asked to be told about it anyway (a Re-analyze run over hundreds of
     * emails). Kept separate from losable() so the dialog can say the true
     * thing about each — "would stop" and "would pause" are different
     * promises, and a dialog that says the wrong one is how a warning stops
     * being read.
     */
    pausable() {
        return this.running().filter(w => w.resumable && w.warn);
    },
};
