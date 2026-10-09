/**
 * Run tools — the Run now / Stop / Continue / Pause / Back up now buttons,
 * for the assistant (2026-10-08, docs/AI_NATIVE.md parity inventory,
 * batch 4). "Run my briefing now", "stop that job", "pause my routines for
 * the weekend" and "back up now" had no path from a chat.
 *
 * Each calls the button's own function:
 *   run_routine       → PromptFeed.runNow (started, not awaited: a run can
 *                       take minutes and reports into its own chat)
 *   stop_routine_run  → PromptFeed.stopCurrent
 *   list_jobs         → TeamJobs.all (the job's status line, as shown)
 *   control_job       → TeamJobs.stop / resume
 *   delete_job        → TeamJobs.remove (asks)
 *   pause_routines    → electronBackground.set({ paused }) (the menu bar's)
 *   backup_now        → electronBackup.backupNow (only when backup is on;
 *                       turning it on and choosing a folder stay in Settings)
 *
 * Only from a person's chat: never from a routine, a job or a private chat
 * (ctx.unattended / ambient / private), so a run cannot start runs. The
 * work they start keeps its own approvals.
 */
(() => {
    if (typeof AgentTools === 'undefined' || typeof AgentTools.register !== 'function') return;

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const fromPerson = (ctx) => !(ctx && (ctx.unattended || ctx.ambient || ctx.private));
    const notHere = { error: 'This can only be done from an ordinary chat with the person.' };
    const routine = (id) => (typeof NotePrompts !== 'undefined' ? NotePrompts.list().find(p => p.id === String(id || '')) : null);
    const opts = { group: 'run', blockUntrusted: true };

    AgentTools.GROUP_INFO.run = 'run a routine now or stop its run, list, stop, resume or delete jobs, pause or resume all scheduled routines, back up now';

    AgentTools.register({ type: 'function', function: {
        name: 'run_routine',
        description: 'Run one routine now, as its Run now button does ("run my briefing now"). It starts and reports into its own chat when done; this returns at once. Get the id from list_routines. A strategy\'s review is a routine too.',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    }}, (a = {}, ctx = {}) => {
        if (!fromPerson(ctx)) return notHere;
        if (typeof PromptFeed === 'undefined') return { error: 'Routines are not available.' };
        const p = routine(a.id);
        if (!p) return { error: 'No routine with that id. Call list_routines.' };
        const queued = !!PromptFeed._busy;
        PromptFeed.runNow(p.id).catch(() => {});
        return { success: true, routine: p.title || p.id, status: queued ? 'queued: it runs after the one running now' : 'started: the result goes into its chat' };
    }, { ...opts, describe: (a) => `Run <b>${esc((routine(a.id) || {}).title || a.id)}</b> now` });

    AgentTools.register({ type: 'function', function: {
        name: 'stop_routine_run',
        description: 'Stop the routine run in progress, as its Stop button does. It settles as stopped, with no error.',
        parameters: { type: 'object', properties: {} }
    }}, (a = {}, ctx = {}) => {
        if (!fromPerson(ctx)) return notHere;
        if (typeof PromptFeed === 'undefined') return { error: 'Routines are not available.' };
        return PromptFeed.stopCurrent() ? { success: true, note: 'Stopping.' } : { success: true, note: 'Nothing was running.' };
    }, opts);

    AgentTools.register({ type: 'function', function: {
        name: 'list_jobs',
        description: 'The jobs nenva has run or is running (a chat\'s job, a routine\'s action run), newest first: id, what it is for, status (running, awaiting_user, paused, failed, done), its line and what it changed.',
        parameters: { type: 'object', properties: { limit: { type: 'number', description: 'Default 10' } } }
    }}, (a = {}) => {
        if (typeof TeamJobs === 'undefined') return { error: 'Jobs are not available.' };
        const n = Math.max(1, Math.min(30, Number(a.limit) || 10));
        const jobs = TeamJobs.all().slice(0, n).map(j => ({ id: j.id, goal: String(j.goal || '').slice(0, 160), status: j.status, line: String(j.note || '').slice(0, 200) || undefined,
            changed: j.changes && j.changes.length ? j.changes.slice(0, 5) : undefined, fromRoutine: j.routineId ? ((routine(j.routineId) || {}).title || 'A routine') : undefined, updatedAt: j.updatedAt }));
        return jobs.length ? { jobs } : { jobs: [], note: 'No jobs.' };
    }, { ...opts, readOnly: true });

    AgentTools.register({ type: 'function', function: {
        name: 'control_job',
        description: 'Stop a running job, or continue a stopped one, as the job\'s Stop and Continue buttons do. A stopped job can be continued later.',
        parameters: { type: 'object', properties: {
            id: { type: 'string', description: 'From list_jobs' },
            action: { type: 'string', enum: ['stop', 'resume'] }
        }, required: ['id', 'action'] }
    }}, async (a = {}, ctx = {}) => {
        if (!fromPerson(ctx)) return notHere;
        if (typeof TeamJobs === 'undefined') return { error: 'Jobs are not available.' };
        const id = String(a.id || '');
        if (!TeamJobs.isJob(id)) return { error: 'No job with that id. Call list_jobs.' };
        if (a.action === 'stop') { await TeamJobs.stop(id); return { success: true, stopped: id }; }
        if (a.action === 'resume') { await TeamJobs.resume(id); return { success: true, resumed: id }; }
        return { error: 'action must be stop or resume.' };
    }, opts);

    AgentTools.register({ type: 'function', function: {
        name: 'delete_job',
        description: 'Delete a job and its log, as the job\'s Delete does. What it already changed stays changed.',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    }}, async (a = {}, ctx = {}) => {
        if (!fromPerson(ctx)) return notHere;
        if (typeof TeamJobs === 'undefined') return { error: 'Jobs are not available.' };
        const id = String(a.id || '');
        if (!TeamJobs.get(id)) return { error: 'No job with that id. Call list_jobs.' };
        await TeamJobs.remove(id);
        return { success: true, deleted: id };
    }, { ...opts, ask: true, describe: (a) => {
        const j = typeof TeamJobs !== 'undefined' ? TeamJobs.get(String(a.id || '')) : null;
        return `Delete the job <b>${esc(j ? String(j.goal || '').slice(0, 100) : a.id)}</b> and its log`;
    } });

    AgentTools.register({ type: 'function', function: {
        name: 'pause_routines',
        description: 'Pause every scheduled routine, or resume them, as the menu bar\'s "Pause scheduled routines" does ("stop my routines for the weekend"). Paused, nothing runs on a schedule and the Mac may sleep; Run now still works. get_setup_status shows the current state.',
        parameters: { type: 'object', properties: { paused: { type: 'boolean' } }, required: ['paused'] }
    }}, async (a = {}, ctx = {}) => {
        if (!fromPerson(ctx)) return notHere;
        if (!window.electronBackground || !window.electronBackground.set) return { error: 'Not available in this build.' };
        await window.electronBackground.set({ paused: !!a.paused });
        const st = window.electronBackground.state ? window.electronBackground.state() : null;
        return { success: true, routinesPaused: st ? !!st.paused : !!a.paused };
    }, opts);

    AgentTools.register({ type: 'function', function: {
        name: 'backup_now',
        description: 'Back up now, as Settings › Backup › Back up now does. Only when backup is on; turning it on and choosing the folder are the person\'s, in Settings › Backup.',
        parameters: { type: 'object', properties: {} }
    }}, async (a = {}, ctx = {}) => {
        if (!fromPerson(ctx)) return notHere;
        if (!window.electronBackup) return { error: 'Not available in this build.' };
        const st = await window.electronBackup.getSettings().catch(() => null);
        if (!st || !st.enabled) return { error: 'Backup is off. The person turns it on and chooses a folder in Settings › Backup.' };
        const r = await window.electronBackup.backupNow();
        return r && r.success ? { success: true, at: new Date().toISOString() } : { error: `Backup failed: ${(r && r.error) || 'unknown'}` };
    }, opts);
})();
