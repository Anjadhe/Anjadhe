/**
 * TeamJobs — every job nenva runs is a workroom room worked by the team
 * (2026-10-02, by request: "the task engine is not good at all … replace the
 * job engine in assistant chat to use workroom and retire the task engine").
 *
 * A job is a room in main's event log (js/main/workroom-store.js), worked by
 * WorkroomEngine: nenva as the master, specialists brought in one at a time,
 * each report evidence for the next move. Three kinds, set when the room is
 * created and never changed:
 *
 *   chat       `conversationId` — started by `start_task` in a chat.
 *   routine    `routineId` — a routine that acts (runMode 'task'), unattended.
 *   rehearsal  `rehearsal` — a routine's try before it is armed; changes are
 *              described, never made.
 *
 * Laws:
 *   J1 A chat job lives in its CHAT. The turn that started it carries
 *      `metadata.job` and a live line from the room's `now`; the master's last
 *      message is posted into the conversation once (`metadata.jobResult` =
 *      room id + event seq, so a restart does not post it twice).
 *   J2 Specialists may CHANGE data only through the write tools their manifest
 *      declares (`writes`), never delete or send, and only in these jobs:
 *        chat      — every change asks, with the chat's blue approval card;
 *                    "This session" / "Always" become `job:<tool>` grants.
 *        routine   — arming the routine was the consent, so a change runs
 *                    unless the permission system says ask; then the run WAITS
 *                    (Needs you on the Jobs page, Now and the Routines page,
 *                    and a notification). An email- or file-triggered run gets
 *                    no tool in UNTRUSTED_BLOCKED_TOOLS at all.
 *        rehearsal — nothing is written; the change is recorded as "would".
 *   J3 Every change that was made (or would be) is a `status` event
 *      "Changed: <what>" written from the tool call by code, so the "Changed:"
 *      line, the run history and the Jobs page never quote the model about
 *      what it did.
 *   J4 Browser approvals (main's room.approval) are asked in the owning chat;
 *      a routine's wait like a change does.
 *   J5 The Jobs page, Now, Today, the Routines page and its widget read
 *      `all()`: rooms in the shape the task engine's records had, plus the
 *      task engine's old records (`agent-tasks`), read-only, so history
 *      survives the engine's removal.
 */
const TeamJobs = {
    rooms: [],                 // rooms of the three kinds above
    _events: new Map(),        // roomId -> events[]
    _asking: new Map(),        // roomId -> what is being asked right now
    _waits: new Map(),         // roomId -> { resolve, name, args, def, text } (routine waits)
    _browserAsks: new Set(),   // approval ids already put to the user
    _inited: false,

    /** The only write tools a job may use (J2). */
    WRITES: new Set(['create_schedule_item', 'update_schedule_item', 'complete_task', 'save_goal', 'link_items', 'post_update',
        'create_calendar_event', 'update_calendar_event', 'create_note', 'update_note']),
    LEGACY_KEY: 'agent-tasks',
    REHEARSAL_MS: 8 * 60000,

    async init() {
        if (this._inited || !window.electronWorkrooms) return;
        this._inited = true;
        window.electronWorkrooms.onEvent(delta => this.onDelta(delta));
        // Safety net for a queued room nobody announced (a restart, a new owner).
        this._timer = setInterval(() => WorkroomEngine.tick(), 15000);
        await this.refresh();
        WorkroomEngine.tick();
    },

    kind(room) { return room.conversationId ? 'chat' : room.routineId ? 'routine' : room.rehearsal ? 'rehearsal' : null; },

    async refresh() {
        try { this.rooms = (await window.electronWorkrooms.list()).filter(room => this.kind(room)); } catch { return; }
        for (const room of this.rooms) {
            await this._loadEvents(room);
            this._postResult(room);
        }
        this._changed();
    },

    isJob(id) { return this.rooms.some(room => room.id === id); },
    room(id) { return this.rooms.find(room => room.id === id) || null; },

    async _create(input) {
        const room = await window.electronWorkrooms.command('create', input);
        // The create's own delta can land before this reply does: one entry per id.
        if (!this.rooms.some(r => r.id === room.id)) this.rooms.unshift(room);
        if (!this._events.has(room.id)) this._events.set(room.id, []);
        this._changed();
        WorkroomEngine.tick();
        return room;
    },

    /** start_task's handler: one room for the job, tied to this chat. */
    async start(goal, convId) {
        const text = String(goal || '').trim();
        if (!text) return { error: 'start_task needs the goal.' };
        if (!convId) return { error: 'Start a job from a conversation.' };
        const conv = (AgentService.conversations || []).find(c => c.id === convId);
        if (conv && typeof PrivateChat !== 'undefined' && PrivateChat.isPrivate(conv)) return { error: 'A private chat cannot start a job.' };
        const room = await this._create({ goal: `${text}${this._context(conv)}`, conversationId: convId });
        return { ok: true, jobId: room.id };
    },

    /** A routine that acts (PromptFeed._runAsTask). One run per routine at a time. */
    async startRoutine(routineId, goal, { untrusted = false } = {}) {
        if (this.rooms.some(r => r.routineId === routineId && ['queued', 'running'].includes(r.status))) return { deferred: true };
        const room = await this._create({ goal: String(goal || '').trim(), routineId, untrusted: !!untrusted });
        return { ok: true, jobId: room.id };
    },

    /**
     * A routine's try before it is armed (PromptFeed.preview): the team does
     * the job with every change described instead of made (J2), and the room
     * is deleted afterwards. Resolves { text, changes } or { error }.
     */
    async rehearse(goal) {
        const room = await this._create({ goal: String(goal || '').trim(), rehearsal: true });
        const started = Date.now();
        try {
            for (;;) {
                await new Promise(resolve => setTimeout(resolve, 1500));
                const now = this.room(room.id);
                if (!now) return { error: 'The try was stopped.' };
                if (now.status === 'idle' || now.status === 'paused') break;
                if (Date.now() - started > this.REHEARSAL_MS) { await this.stop(room.id); return { error: 'The try took too long and was stopped.' }; }
            }
            await this._loadEvents(this.room(room.id));
            const events = this._events.get(room.id) || [];
            const answer = events.filter(e => e.type === 'message' && e.from === 'master').at(-1);
            const failed = events.filter(e => e.type === 'status' && e.state === 'error').at(-1);
            if (!answer) return { error: failed ? failed.text : 'The try ended without an answer.' };
            return { text: answer.text, changes: this.changes(room.id) };
        } finally {
            this.remove(room.id);
        }
    },

    /** The last few chat lines, so the team knows what "these" refers to. */
    _context(conv) {
        if (!conv || !Array.isArray(conv.messages)) return '';
        const lines = conv.messages.filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
            .slice(-6).map(m => `${m.role === 'user' ? 'User' : 'nenva'}: ${m.content.replace(/\s+/g, ' ').trim().slice(0, 700)}`);
        return lines.length ? `\n\nFrom our chat, for context:\n${lines.join('\n')}` : '';
    },

    async _loadEvents(room) {
        if (!room) return;
        const have = this._events.get(room.id) || [];
        const after = have.at(-1)?.seq || 0;
        try {
            const more = await window.electronWorkrooms.events(room.id, after);
            if (more.length) this._events.set(room.id, [...have, ...more]);
            else if (!this._events.has(room.id)) this._events.set(room.id, have);
        } catch { /* next delta retries */ }
    },

    async onDelta(delta) {
        // The Workrooms app (flag `workrooms`) feeds the engine itself; with it
        // off, this is the engine's only ear.
        if (!(typeof WorkroomsApp !== 'undefined' && WorkroomsApp.active())) WorkroomEngine.onDelta(delta);
        if (delta.deleted) {
            this.rooms = this.rooms.filter(room => room.id !== delta.deleted);
            this._events.delete(delta.deleted);
            this._changed();
            return;
        }
        const room = delta.room;
        if (!room || !this.kind(room)) {
            if (room && room.status === 'queued') WorkroomEngine.tick();
            return;
        }
        const i = this.rooms.findIndex(r => r.id === room.id);
        if (i >= 0) this.rooms[i] = room; else this.rooms.unshift(room);
        if (delta.event) await this._loadEvents(room);
        if (room.approval && !this._browserAsks.has(room.approval.id)) this._askBrowser(room);
        if (room.status === 'idle' || room.status === 'paused') this._postResult(room);
        if (room.status === 'queued') WorkroomEngine.tick();
        this._changed();
    },

    /** J1: a chat job's last message, into the chat, once. */
    _postResult(room) {
        if (!room.conversationId || (room.status !== 'idle' && room.status !== 'paused')) return;
        const events = this._events.get(room.id) || [];
        const last = events.filter(e => e.type === 'message' && e.from === 'master').at(-1);
        const conv = (AgentService.conversations || []).find(c => c.id === room.conversationId);
        if (!conv) return;
        const stopped = room.status === 'paused' ? events.filter(e => e.type === 'status' && ['paused', 'error'].includes(e.state)).at(-1) : null;
        const ev = stopped && (!last || stopped.seq > last.seq) ? stopped : last;
        if (!ev) return;
        if (conv.messages.some(m => m.metadata?.jobResult?.id === room.id && m.metadata.jobResult.seq >= ev.seq)) return;
        const content = ev === stopped
            ? (/^Paused\.?$/.test(String(ev.text || '').trim()) ? 'You stopped the job. Choose Continue under it to pick it up again.' : `The job stopped: ${ev.text}`)
            : String(ev.text || '').trim();
        if (!content) return;
        conv.messages.push({ role: 'assistant', content, metadata: { jobResult: { id: room.id, seq: ev.seq, stopped: ev === stopped }, model: this._model() } });
        conv.updatedAt = new Date().toISOString();
        try {
            AgentService._persistConversation(conv);
            AgentService._syncActiveConversation(conv.id, conv);
            if (AgentService.activeConversationId === conv.id && !AgentService.isConversationStreaming(conv.id) && typeof AgentUI !== 'undefined') AgentUI.renderMessages();
        } catch { /* shows on the next render */ }
        const watching = typeof AgentUI !== 'undefined' && AgentService.activeConversationId === conv.id && !document.hidden
            && (AgentUI.isOpen || (typeof AppManager !== 'undefined' && AppManager.currentApp === 'agent'));
        if (!watching && typeof Notify !== 'undefined') {
            Notify.show(ev === stopped ? 'A job stopped' : 'Job finished', room.title, {
                kind: 'task',
                onClick: () => { if (typeof SimpleExperience !== 'undefined' && SimpleExperience.enabled) SimpleExperience.resume(conv.id); }
            });
        }
    },

    _model() {
        try { return AgentService.displayModelName(AgentService.getDefaultEntry()); } catch { return undefined; }
    },

    // ── J2/J3: what the team may change, and the record of it ──────────

    /** The write tools a specialist gets in this room. */
    writesFor(room, def) {
        if (!this.kind(room)) return [];
        let names = (def.writes || []).filter(name => this.WRITES.has(name));
        if (room.untrusted && typeof AgentService !== 'undefined') names = names.filter(name => !AgentService.UNTRUSTED_BLOCKED_TOOLS.has(name));
        return names;
    },

    /** What the master is told about this kind of job. */
    masterNote(room) {
        const k = this.kind(room);
        if (k === 'chat') return `This job was handed over from your chat with the user; your last message goes back into that chat. In it, the tasks, planner, calendar and notes specialists can also MAKE the changes the job needs (create or update tasks, projects, events and notes); the user approves each change. Ask them to make a change in their brief rather than describing it; never delete or send anything.
- When the user asked for something to be added, created, changed, moved or completed, the job is NOT finished until a specialist has made that change: delegate it with the exact details (title, date, notes, which item). Never hand the user a draft of a change they asked you to make.`;
        if (k === 'routine') return `This is a scheduled run of a routine the user set up; nobody is watching, so never ask the user a question — decide sensibly and say what you assumed. The tasks, planner, calendar and notes specialists can make the changes the routine asks for (the user agreed to them when they set it up). Never delete or send anything. Your last message is the run's report: a few short lines on what was done and found, or that there was nothing to do.`;
        if (k === 'rehearsal') return `This is a TRY of a routine before the user switches it on. Do the job as a real run would, but no change is really made: specialists' change tools only record what they WOULD do. Never ask the user a question. A specialist reporting that a change "would be made" or "was not made because this is a try" has SUCCEEDED; never call that a failure or tell the user to do it by hand. Your last message says, in a few short lines, what the run would do.`;
        return '';
    },

    /** The execute ctx a specialist's tool runs with in this room. */
    ctxFor(room) {
        return { ...(room.conversationId ? { convId: room.conversationId } : {}),
            ...(room.untrusted ? { untrusted: true } : {}), ...(room.routineId || room.rehearsal ? { unattended: true } : {}) };
    },

    /**
     * Before a write runs. Returns null to go ahead, or the result to hand
     * the specialist instead (declined, waiting refused, or a rehearsal).
     */
    async beforeWrite(room, def, name, args, commit) {
        const k = this.kind(room);
        if (k === 'rehearsal') {
            await this._recordChange(commit, name, args, true);
            return { success: true, rehearsal: true, note: 'TRY ONLY: this change was NOT made. Carry on as if it had been, and say what you would do.' };
        }
        if (k === 'chat') {
            if (await this.approve(room, def, name, args)) return null;
            return { error: 'The user said no to this change. It was NOT made. Do not try it again; say so in your report.', cancelled: true };
        }
        // Routine: the arming was the consent, unless the permission system asks.
        let perm = { decision: 'allow' };
        try { perm = await AgentService._resolvePermission(name, args, null); } catch { /* allow stands */ }
        if (perm.decision === 'deny') return { error: perm.reason || 'Not allowed.', denied: true };
        if (perm.decision === 'ask' && !(await this._wait(room, def, name, args))) {
            return { error: 'The user said no to this change. It was NOT made. Do not try it again; say so in your report.', cancelled: true };
        }
        return null;
    },

    /** After a write ran: the change, recorded by code (J3). */
    async afterWrite(room, name, args, result, commit) {
        if (!result || result.error || result.cancelled || result.denied || result.alreadyExisted) return;
        await this._recordChange(commit, name, args, false);
    },

    describe(name, args) {
        let html = '';
        try { html = AgentUI._describeToolAction(name, args); } catch { html = name.replace(/_/g, ' '); }
        const div = document.createElement('div');
        div.innerHTML = String(html).replace(/<br\s*\/?>[\s\S]*$/i, '');
        return div.textContent.replace(/\s+/g, ' ').trim().replace(/\.$/, '');
    },

    async _recordChange(commit, name, args, would) {
        try { await commit({ type: 'status', text: `${would ? 'Would change' : 'Changed'}: ${this.describe(name, args)}` }); } catch { /* the run stopped */ }
    },

    /** The changes a job made (or would), from its own events (J3). */
    changes(id) {
        return (this._events.get(id) || []).filter(e => e.type === 'status' && /^(Would change|Changed): /.test(e.text || ''))
            .map(e => e.text.replace(/^(Would change|Changed): /, ''));
    },

    /** J2 chat: a specialist's change, asked in the chat that owns the job. */
    async approve(room, def, name, args) {
        const key = `job:${name}`;
        if (typeof PermissionManager !== 'undefined') {
            await PermissionManager.ready();
            if (PermissionManager.hasGrant(key)) return true;
        }
        this._asking.set(room.id, `${def.label} is waiting for your approval.`);
        this._changed();
        let decision = { approved: false };
        try {
            decision = await AgentService._confirmWrite(name, args, { grantKey: key,
                note: `${def.label} wants to make this change for the job you started here.` }, room.conversationId);
        } finally {
            this._asking.delete(room.id);
            this._changed();
        }
        if (!decision || !decision.approved) return false;
        if (typeof PermissionManager !== 'undefined') {
            if (decision.scope === 'session') PermissionManager.grantSession(key);
            else if (decision.scope === 'always') await PermissionManager.grantAlways(key);
            PermissionManager.recordDecision?.(`approved-${decision.scope || 'once'}`, key);
        }
        return true;
    },

    /** J2 routine: nobody is here, so the run waits and says so. */
    _wait(room, def, name, args) {
        return new Promise(resolve => {
            const text = this.describe(name, args);
            this._waits.set(room.id, { resolve, name, args, def, text });
            this._asking.set(room.id, `${def.label} wants to: ${text}`);
            this._changed();
            if (typeof Notify !== 'undefined') {
                Notify.show(`${this.routineTitle(room.routineId)} is waiting for you`, text, {
                    kind: 'routine', onClick: () => { if (typeof SimpleExperience !== 'undefined' && SimpleExperience.enabled) SimpleExperience.openJob(room.id); }
                });
            }
        });
    },

    /** The person's answer to a routine's wait (Jobs page, Routines page). */
    answer(id, approved) {
        const w = this._waits.get(id);
        if (!w) return false;
        this._waits.delete(id);
        this._asking.delete(id);
        this._changed();
        w.resolve(!!approved);
        return true;
    },
    waiting(id) { return this._waits.get(id) || null; },

    routineTitle(id) {
        try {
            const n = (StorageManager.get('notes')?.notes || []).find(x => x && x.id === id);
            return (n && n.title) || 'A routine';
        } catch { return 'A routine'; }
    },

    /** J4: a browser step main is waiting on. */
    async _askBrowser(room) {
        const a = room.approval;
        this._browserAsks.add(a.id);
        const once = a.kind === 'step' || !!a.sensitive || !a.origin;
        const summary = [a.summary, a.detail, a.sensitive].filter(Boolean).join(' — ');
        let decision = { approved: false };
        if (room.conversationId) {
            try { decision = await AgentUI.confirmToolCall('browser_act', { summary }, summary, room.conversationId, { onceOnly: once }); }
            catch { /* declined */ }
        } else if (room.routineId) {
            decision = { approved: await this._wait(room, { label: 'Browser' }, 'browser_act', { summary }), scope: 'once' };
        }
        try {
            await window.electronWorkrooms.command('approval', { id: room.id, approvalId: a.id, approved: !!decision.approved,
                always: !!decision.approved && !once && decision.scope === 'always' });
        } catch { /* the step was withdrawn meanwhile */ }
    },

    stop(id) { this.answer(id, false); return window.electronWorkrooms.command('pause', { id }).catch(() => null); },
    resume(id) { return window.electronWorkrooms.command('resume', { id }).then(() => WorkroomEngine.tick()).catch(() => null); },
    remove(id) {
        this.answer(id, false);
        if (this.isJob(id)) return window.electronWorkrooms.command('delete', { id }).catch(() => null);
        return Promise.resolve(this.removeLegacy(id));
    },

    // ── J5: jobs, in one shape ─────────────────────────────────────────

    /** A room in the shape the task engine's records had. */
    asJob(room) {
        const events = this._events.get(room.id) || [];
        const ends = new Map(events.filter(e => e.type === 'task_end').map(e => [e.id, e]));
        const plan = events.filter(e => e.type === 'task').map(e => {
            const end = ends.get(e.id);
            return { step: `${Specialists.label(e.agent)}: ${String(e.text || '').replace(/\s+/g, ' ').slice(0, 140)}`,
                status: end ? (end.status === 'blocked' ? 'failed' : 'done') : room.status === 'running' ? 'running' : 'skipped',
                note: end && end.status === 'partial' ? 'Partly done' : end && end.status === 'blocked' ? String(end.note || end.text || '').slice(0, 160) : '' };
        });
        const asking = this._asking.get(room.id) || (room.approval ? `Browser is asking: ${room.approval.summary}` : '');
        const stopped = events.filter(e => e.type === 'status' && ['paused', 'error'].includes(e.state)).at(-1);
        const status = asking ? 'awaiting_user'
            : ['queued', 'running'].includes(room.status) ? 'running'
            : room.status === 'paused' ? (stopped && stopped.state === 'error' ? 'failed' : 'paused')
            : 'done';
        const now = room.now && room.now.agent && room.now.agent !== 'master' && room.now.text
            ? `${Specialists.label(room.now.agent)} is ${room.now.text}.` : '';
        const changes = this.changes(room.id);
        const answer = events.filter(e => e.type === 'message' && e.from === 'master').at(-1);
        const note = asking || (status === 'running' ? (now || (room.status === 'queued' ? 'Starting…' : 'nenva is deciding the next step.'))
            : status === 'paused' || status === 'failed' ? (stopped?.text || '')
            : this._doneNote(room, changes));
        return { id: room.id, engine: 'team', conversationId: room.conversationId || null, routineId: room.routineId || null,
            goal: room.title, status, plan, note, changes,
            // The run report the Routines page shows: what changed (by code), then the team's answer.
            report: [changes.length ? `Changed: ${changes.join('; ')}` : '', answer ? answer.text : ''].filter(Boolean).join('\n\n'),
            createdAt: room.createdAt, updatedAt: room.updatedAt };
    },

    /** A finished job's line: what changed, else who did the work. */
    _doneNote(room, changes) {
        if (changes.length) return `Changed: ${changes.slice(0, 3).join('; ')}${changes.length > 3 ? ` and ${changes.length - 3} more` : ''}.`;
        const who = (room.members || []).map(id => Specialists.label(id)).filter(Boolean);
        return `${who.length ? `Worked with ${who.join(', ')}. ` : ''}${room.conversationId ? 'The answer is in the chat.' : 'Nothing was changed.'}`;
    },

    /** The task engine's old records, read-only (it was removed 2026-10-02). */
    legacy() {
        let list = [];
        try { list = StorageManager.get(this.LEGACY_KEY); } catch { list = []; }
        return (Array.isArray(list) ? list : []).filter(t => t && t.id).map(t => (
            ['planning', 'running', 'verifying', 'awaiting_user'].includes(t.status)
                ? { ...t, status: 'failed', note: 'Stopped when the old job engine was retired.' } : t));
    },
    removeLegacy(id) {
        try {
            const list = StorageManager.get(this.LEGACY_KEY);
            if (Array.isArray(list)) StorageManager.set(this.LEGACY_KEY, list.filter(t => t && t.id !== id));
        } catch { /* nothing to remove */ }
        return true;
    },

    /** Team jobs (rehearsals excluded) newest first, then the old records. */
    all() {
        return [...this.rooms.filter(r => !r.rehearsal).map(room => this.asJob(room)), ...this.legacy()];
    },
    get(id) {
        const room = this.room(id);
        return room ? this.asJob(room) : (this.legacy().find(t => t.id === id) || null);
    },
    /** Anything the team is working on right now (the reload guard, busy checks). */
    busy() { return this.rooms.filter(r => ['queued', 'running'].includes(r.status)); },

    /** The live line under the chat turn that started a job (J1). */
    stripText(id) {
        const job = this.get(id);
        if (!job) return null;
        const label = { running: 'Working', awaiting_user: 'Needs you', paused: 'Paused', failed: 'Stopped', done: 'Done' }[job.status] || '';
        return { label, note: job.note, live: job.status === 'running', attn: job.status === 'awaiting_user', status: job.status };
    },

    _changed() {
        clearTimeout(this._paint);
        this._paint = setTimeout(() => {
            if (typeof AgentUI !== 'undefined' && AgentUI.paintJobStrips) AgentUI.paintJobStrips();
            if (typeof SimpleExperience !== 'undefined' && SimpleExperience.onTaskUpdate) SimpleExperience.onTaskUpdate();
            if (typeof PromptsApp !== 'undefined' && typeof AppManager !== 'undefined' && AppManager.currentApp === 'prompts' && PromptsApp._renderWaiting) PromptsApp._renderWaiting();
            if (typeof CLIBridge !== 'undefined' && CLIBridge.onJobUpdate) CLIBridge.onJobUpdate();
            document.dispatchEvent(new Event('anjadhe:attention-changed'));
        }, 120);
    }
};

if (typeof module !== 'undefined') module.exports = TeamJobs;
