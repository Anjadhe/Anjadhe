/**
 * Teaching by showing — the assistant's side (2026-10-07, docs/TEACH.md).
 *
 * "Let me show you how I …" is a conversation, not a feature with a page:
 *
 *   start_teaching     opens nenva's own Chrome window in front and starts
 *                      watching (an ASK: the person sees what it means
 *                      before the window opens).
 *   finish_teaching    stops watching and hands the assistant the recording
 *                      as a numbered transcript, ONCE (T1). The person may
 *                      have pressed Done in the window already; either way.
 *   save_taught_task   keeps the write-up as a playbook (an ASK whose dialog
 *                      shows the whole note, T2; code checks the facts, T3).
 *   list_taught_tasks  what has been taught, and how to run one.
 *   remove_taught_task forgets one (an ASK).
 *
 * All untrusted-blocked, and the two that drive the window refuse an
 * ambient run: a routine cannot start a recording. The group loads on
 * demand like any other (use_tools), described by one line below.
 *
 * Running a taught task is NOT here. It is the ordinary job engine: the
 * person asks ("get the Schoology assignments"), the chat starts a job, the
 * master hands it to Browser with the title in the brief, and the playbook
 * rides along (TaughtTasks T4). A routine does the same on a schedule.
 */
const TeachTools = { _active: null };   // the recording in progress, for the toast
(function registerTeachTools() {
    if (typeof AgentTools === 'undefined' || typeof TaughtTasks === 'undefined') return;
    if (typeof FEATURES === 'undefined' || !FEATURES.isEnabled('teach')) return;

    const GROUP = 'teach';
    const esc = value => typeof UIUtils !== 'undefined' ? UIUtils.escapeHtml(String(value ?? '')) : String(value ?? '');
    AgentTools.GROUP_INFO[GROUP] = 'teach nenva a website task by showing it once in nenva\'s own Chrome window ("let me show you how I…"): it watches, writes the steps up as a note you confirm, and can then do the task again when asked or on a schedule; also list or remove taught tasks';
    const common = { source: 'teach', group: GROUP, blockUntrusted: true, dataClass: 'browse' };

    // The IPC wraps main's message; the model reads the message alone.
    const plain = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    const browser = (action, input) => window.electronAgentBrowser.command(action, input || {});
    let lastLog = null;      // the recording just finished, until it is saved or replaced

    AgentTools.register({ type: 'function', function: {
        name: 'start_teaching',
        description: 'Start WATCHING the user show you a website task in nenva\'s own Chrome window. Call this when they say "let me show you how I…", "watch me", "I\'ll teach you". The window opens in front; they do the task the way they always do (signing in if needed: passwords, codes and card numbers are never recorded); they end it with Done in the window or by telling you. Then call finish_teaching. Do not call this for a task you can simply do.',
        parameters: { type: 'object', properties: {
            what: { type: 'string', description: 'What they are about to show you, in their words, e.g. "how I download the Chase statement".' }
        }, required: ['what'] }
    } }, async function start_teaching(args, ctx) {
        if (ctx && ctx.ambient) return { error: 'A recording can only start from a chat with the user present.' };
        try {
            const result = await browser('record-start');
            lastLog = null;
            TeachTools._active = { what: String(args.what || '').slice(0, 200), convId: ctx?.convId || null, startedAt: Date.now() };
            return { ok: true, recording: true, url: result.url || null,
                note: 'Recording. The Chrome window is in front: the user does the task there, then presses Done in the window or says done here. Reply in one short line that you are watching and will write up what they do; do not describe steps you have not seen. When they say done, call finish_teaching.' };
        } catch (error) { return { error: plain(error) }; }
    }, { ...common, ask: true,
        describe: args => `Watch you do <strong>${esc(args.what || 'this task')}</strong> in nenva's own Chrome window, until you press Done. What you click, choose and type is noted by name; passwords, codes and card numbers are never recorded.` });

    AgentTools.register({ type: 'function', function: {
        name: 'finish_teaching',
        description: 'Stop watching and get the recording: a numbered transcript of what the user did, page by page. Call it when they say they are done (or when the recording already ended with Done in the window). Then WRITE THE PLAYBOOK from it and call save_taught_task: where things are on the site, in what order, what each step is for, what the finished result looks like, and where it may trip (a sign-in, a picker). Write for an agent that will see the site fresh; use the labels from the transcript.',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
    } }, async function finish_teaching(args, ctx) {
        if (ctx && ctx.ambient) return { error: 'Only a chat with the user can finish a recording.' };
        let log;
        try { log = await browser('record-stop'); } catch (error) { return { error: plain(error) }; }
        const steps = (log.events || []).filter(event => event.type !== 'page');
        if (!steps.length) { lastLog = null; return { error: 'Nothing was recorded: no click, choice or typing happened in the Chrome window. Ask the user to show the task again with start_teaching, or whether they did it in another browser.' }; }
        lastLog = log;
        const hosts = TaughtTasks.hostsOf(log);
        return { steps: steps.length, sites: hosts, transcript: TaughtTasks.transcript(log),
            ...(log.full ? { note: 'The recording reached its limit; later steps were not kept.' } : {}),
            next: 'Write the playbook now and call save_taught_task with a short title the user would say, the sites (from the list above only) and the note. Then show the user the note and ask them to correct anything.' };
    }, common);

    AgentTools.register({ type: 'function', function: {
        name: 'save_taught_task',
        description: 'Keep a taught task: the write-up of what the user showed you, as a note the Browser agent follows later. Pass `id` to replace an existing one (after the user corrects it).',
        parameters: { type: 'object', properties: {
            title: { type: 'string', description: 'Short, the way the user would ask for it: "Schoology check", "Chase statement download".' },
            hosts: { type: 'array', items: { type: 'string' }, description: 'The sites it runs on, from the recording.' },
            note: { type: 'string', description: 'The playbook in plain words, under 2400 characters: the starting address, the path through the site by the labels the user clicked, what to type or choose and why, what the finished result is (a page to read, a file downloaded), and what only the user can do (sign in, a code).' },
            id: { type: 'string', description: 'An existing taught task to replace.' }
        }, required: ['title', 'note'] }
    } }, async function save_taught_task(args) {
        const existing = args.id ? TaughtTasks.get(args.id) : null;
        if (args.id && !existing) return { error: 'No taught task has that id. Omit id to save a new one.' };
        const check = TaughtTasks.vet(args, { log: lastLog, existing });
        if (check.error) return { error: check.error };
        try { TaughtTasks.save(check.item); } catch (error) { return { error: error.message }; }
        lastLog = null; TeachTools._active = null;
        if (typeof SimpleSettings !== 'undefined' && AppManager?.currentApp === 'simplesettings') SimpleSettings.render?.();
        return { ok: true, id: check.item.id, title: check.item.title, hosts: check.item.hosts,
            note: `Saved. The user can read and edit it at Settings › Memory › Taught tasks. To run it: they ask for it by name in a chat, or say "do this every …" for a routine. Tell them both in one line.` };
    }, { ...common, ask: true,
        describe: args => `Keep what you showed nenva as <strong>${esc(args.title || 'a taught task')}</strong>${Array.isArray(args.hosts) && args.hosts.length ? ` on ${esc(args.hosts.join(', '))}` : ''}:<pre class="teach-note">${esc(args.note || '')}</pre>You can edit it later under Settings › Memory › Taught tasks.` });

    AgentTools.register({ type: 'function', function: {
        name: 'list_taught_tasks',
        description: 'The tasks the user taught you by showing them, with their notes. To RUN one, hand it to the team with start_task, naming the task by its exact title in the goal (the Browser agent gets the note). Use this when the user asks for a taught task by name or asks what you know how to do on a site.',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
    } }, async function list_taught_tasks() {
        const items = TaughtTasks.all();
        if (!items.length) return { tasks: [], note: 'Nothing taught yet. The user can show you a task: "let me show you how I…" (start_teaching).' };
        return { tasks: items.map(item => ({ id: item.id, title: item.title, hosts: item.hosts, taughtAt: item.taughtAt, lastRun: item.lastRun || null, note: item.note })),
            howToRun: 'start_task with a goal like: Run the taught task “<title>” and report what it found.' };
    }, { ...common, readOnly: true });

    AgentTools.register({ type: 'function', function: {
        name: 'remove_taught_task',
        description: 'Forget a taught task the user no longer wants.',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    } }, async function remove_taught_task(args) {
        const gone = TaughtTasks.remove(String(args.id || ''));
        if (!gone) return { error: 'No taught task has that id. Call list_taught_tasks first.' };
        if (typeof SimpleSettings !== 'undefined' && AppManager?.currentApp === 'simplesettings') SimpleSettings.render?.();
        return { ok: true, removed: gone.title };
    }, { ...common, ask: true, describe: args => { const item = TaughtTasks.get(String(args.id || '')); return `Forget the taught task <strong>${esc(item ? item.title : args.id)}</strong>.`; } });

    // The person pressed Done in the Chrome window: say so here, since the
    // recording ends there and the write-up happens in the chat.
    if (window.electronWorkrooms?.onEvent) {
        window.electronWorkrooms.onEvent(delta => {
            if (delta?.recording !== 'record-done' || !TeachTools._active) return;
            if (typeof UIUtils !== 'undefined') UIUtils.showToast('Recording finished. Tell nenva you are done and it will write up what it saw.', 'info', 6000);
        });
    }
})();
