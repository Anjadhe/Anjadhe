'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

/* Workrooms, as an append-only event log (2026-09-21).
 *
 * One main-process writer; no renderer read/modify/write. Each room is a
 * JSONL file of events plus a row in a small index, and attachments are
 * files beside it, so nothing ever rewrites or clones a whole conversation:
 *
 *   <dir>/index.json          room summaries (id, title, status, last line)
 *   <dir>/<id>.jsonl          the room's events, one per line
 *   <dir>/<id>.files/<fid>    attachment bodies, fetched on demand
 *
 * It replaced a single workrooms.json that was rewritten synchronously on
 * every tool call and cloned in full (3 MB images included) for every reader,
 * every 300 ms while an approval was pending.
 *
 * What did NOT change: execution leases are ephemeral and token-checked, a
 * restart pauses interrupted work, and every engine write names its lease.
 * What is new: an approval is a PROMISE main resolves, and a user message
 * sent while the team is working is delivered to it instead of restarting it.
 */
const USER_EVENTS = new Set(['message', 'join', 'task', 'activity', 'task_end', 'status']);
const MAX_ROOMS = 100, MAX_RUNNING = 3;

class WorkroomStore {
    constructor(dir, { legacyFile = null, onEvent = () => {} } = {}) {
        this.dir = dir; this.onEvent = onEvent;
        this.leases = new Map();          // roomId -> { token, sender }
        this.pending = new Map();         // approvalId -> { roomId, resolve }
        this.logs = new Map();            // roomId -> events[] (loaded lazily)
        this.rooms = [];
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const index = path.join(dir, 'index.json');
        if (fs.existsSync(index)) {
            const data = JSON.parse(fs.readFileSync(index, 'utf8'));
            if (data.version !== 2 || !Array.isArray(data.rooms)) throw new Error('Unsupported workroom store');
            this.rooms = data.rooms;
        } else if (legacyFile && fs.existsSync(legacyFile)) this.importLegacy(legacyFile);
        // Claims never survive a restart: whatever was running stopped.
        for (const room of this.rooms) if (['running', 'queued'].includes(room.status) || room.approval) {
            const wasRunning = room.status === 'running';
            room.status = room.status === 'queued' ? 'queued' : 'paused'; room.approval = null; room.now = null;
            if (wasRunning) this.append(room, { type: 'status', state: 'paused', text: 'Work stopped when Anjadhe restarted. Continue to pick it up from here.' }, { quiet: true });
        }
        this.saveIndex();
    }

    // ── files ────────────────────────────────────────────────────────────
    logFile(id) { return path.join(this.dir, `${id}.jsonl`); }
    filesDir(id) { return path.join(this.dir, `${id}.files`); }
    saveIndex() {
        clearTimeout(this._indexTimer); this._indexTimer = null;
        const file = path.join(this.dir, 'index.json'), temp = file + '.tmp';
        fs.writeFileSync(temp, JSON.stringify({ version: 2, rooms: this.rooms }), { mode: 0o600 });
        fs.renameSync(temp, file);
    }
    touchIndex() {
        if (this._indexTimer) return;
        this._indexTimer = setTimeout(() => { try { this.saveIndex(); } catch { /* next write retries */ } }, 1500);
        this._indexTimer.unref?.();
    }
    events(id, after = 0) {
        this.get(id);
        if (!this.logs.has(id)) {
            const file = this.logFile(id), events = [];
            if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
                if (!line) continue;
                try { events.push(JSON.parse(line)); } catch { /* a torn final line after a crash */ }
            }
            this.logs.set(id, events);
        }
        const events = this.logs.get(id);
        return after > 0 ? events.filter(event => event.seq > after) : events;
    }
    importLegacy(file) {
        let data; try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
        for (const old of Array.isArray(data?.rooms) ? data.rooms : []) {
            if (!old?.id || !Array.isArray(old.messages)) continue;
            const room = { id: old.id, title: String(old.title || old.goal || 'Workroom').slice(0, 90), status: 'idle', members: [],
                createdAt: old.createdAt || new Date().toISOString(), updatedAt: old.updatedAt || new Date().toISOString(), seq: 0, last: null, approval: null, now: null };
            this.rooms.push(room);
            for (const message of old.messages) {
                if (!['request', 'message', 'finding', 'result'].includes(message.kind) || typeof message.text !== 'string') continue;
                const from = message.from === 'you' ? 'you' : message.kind === 'result' ? 'master' : message.from;
                this.append(room, { type: 'message', from, text: message.text.slice(0, 12000), at: message.at }, { quiet: true });
            }
        }
        try { fs.renameSync(file, file + '.migrated'); } catch { /* read-only volume: import again next time is harmless */ }
    }

    // ── shape checks ─────────────────────────────────────────────────────
    text(value, max = 12000) {
        if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid or oversized text');
        return value.trim();
    }
    attachments(room, value) {
        if (value === undefined) return [];
        if (!Array.isArray(value) || value.length > 4) throw new Error('Up to four files per message.');
        return value.map(file => {
            if (!file || !['text', 'pdf', 'image'].includes(file.kind)
                || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 255
                || !Number.isFinite(file.size) || file.size < 0 || file.size > 20 * 1024 * 1024) throw new Error('Invalid file attachment.');
            const body = { name: file.name, size: file.size, kind: file.kind, truncated: !!file.truncated };
            if (file.kind === 'image') {
                if (typeof file.dataUrl !== 'string' || file.dataUrl.length > 3 * 1024 * 1024
                    || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(file.dataUrl)) throw new Error('Invalid or oversized attached image.');
                body.dataUrl = file.dataUrl; body.mime = file.dataUrl.slice(5, file.dataUrl.indexOf(';'));
                for (const key of ['width', 'height']) if (Number.isInteger(file[key]) && file[key] > 0 && file[key] <= 1568) body[key] = file[key];
            } else {
                if (typeof file.content !== 'string' || file.content.length > 30000) throw new Error('Attached files may contain at most 30,000 characters each.');
                body.content = file.content;
                if (Number.isSafeInteger(file.totalChars) && file.totalChars >= file.content.length) body.totalChars = file.totalChars;
                if (file.kind === 'pdf') { if (Number.isSafeInteger(file.pages) && file.pages > 0) body.pages = file.pages; body.ocr = !!file.ocr; }
            }
            // The body goes to its own file; the event carries the label.
            const fileId = randomUUID();
            fs.mkdirSync(this.filesDir(room.id), { recursive: true, mode: 0o700 });
            fs.writeFileSync(path.join(this.filesDir(room.id), fileId), JSON.stringify(body), { mode: 0o600 });
            return { fileId, name: body.name, size: body.size, kind: body.kind, truncated: body.truncated, ...(body.width ? { width: body.width, height: body.height } : {}) };
        });
    }
    attachment(id, fileId) {
        this.get(id);
        if (!/^[0-9a-f-]{36}$/.test(String(fileId))) throw new Error('Unknown attachment');
        return JSON.parse(fs.readFileSync(path.join(this.filesDir(id), fileId), 'utf8'));
    }
    get(id) {
        const room = this.rooms.find(room => room.id === id);
        if (!room) throw new Error('Workroom not found');
        return room;
    }
    snapshot() { return structuredClone(this.rooms); }

    // ── the one write path ───────────────────────────────────────────────
    append(room, event, { quiet = false } = {}) {
        const full = { seq: ++room.seq, at: event.at || new Date().toISOString(), ...event };
        fs.appendFileSync(this.logFile(room.id), JSON.stringify(full) + '\n', { mode: 0o600 });
        if (this.logs.has(room.id)) this.logs.get(room.id).push(full);
        room.updatedAt = full.at;
        if (full.type === 'message' || full.type === 'task_end') room.last = { from: full.from || full.agent, text: String(full.text).replace(/\s+/g, ' ').slice(0, 140), at: full.at };
        if (full.type === 'approval') room.last = { from: full.agent, text: full.summary, at: full.at };
        if (full.type === 'join' && !room.members.includes(full.agent)) room.members.push(full.agent);
        if (!quiet) { this.touchIndex(); this.onEvent({ room: structuredClone(room), event: full }); }
        return full;
    }
    setStatus(room, status) {
        room.status = status;
        if (status !== 'running') { room.now = null; this.cancelApprovals(room.id); }
        this.saveIndex();
    }

    // ── approvals: a promise main resolves, not a row the renderer polls ─
    requestApproval(id, token, sender, request) {
        const room = this.get(id), lease = this.leases.get(id);
        if (!lease || lease.token !== token || lease.sender !== sender || room.status !== 'running') return Promise.resolve({ approved: false, cancelled: true });
        if (room.approval) return Promise.resolve({ approved: false, cancelled: true });
        const approval = { id: randomUUID(), agent: this.text(request.agent || 'browser', 40), kind: request.kind === 'step' ? 'step' : 'site',
            origin: request.origin || null, summary: this.text(request.summary, 300),
            detail: request.detail ? this.text(request.detail, 600) : null, sensitive: request.sensitive ? this.text(request.sensitive, 300) : null };
        room.approval = approval;
        this.append(room, { type: 'approval', ...approval });
        this.saveIndex();
        return new Promise(resolve => this.pending.set(approval.id, { roomId: id, resolve }));
    }
    settleApproval(room, decision) {
        const approval = room.approval; if (!approval) return;
        room.approval = null;
        const waiter = this.pending.get(approval.id); this.pending.delete(approval.id);
        this.append(room, { type: 'approval_answer', id: approval.id, approved: !!decision.approved, always: !!decision.always, by: decision.by || 'you' });
        this.saveIndex();
        waiter?.resolve({ approved: !!decision.approved, always: !!decision.always, cancelled: !!decision.cancelled });
    }
    cancelApprovals(id) {
        const room = this.rooms.find(room => room.id === id);
        if (room?.approval) this.settleApproval(room, { approved: false, cancelled: true, by: 'system' });
    }

    command(action, input = {}, sender) {
        if (action === 'create') {
            if (this.rooms.length >= MAX_ROOMS) throw new Error('Delete a workroom before creating another.');
            const room = { id: randomUUID(), title: '', status: 'queued', members: [], createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(), seq: 0, last: null, approval: null, now: null };
            const attachments = this.attachments(room, input.attachments);
            const goal = this.text(typeof input.goal === 'string' && !input.goal.trim() && attachments.length
                ? `Review the attached files: ${attachments.map(file => file.name).join(', ')}.` : input.goal, 6000);
            room.title = goal.replace(/\s+/g, ' ').slice(0, 90);
            this.rooms.unshift(room);
            this.append(room, { type: 'message', from: 'you', text: goal, ...(attachments.length ? { attachments } : {}) });
            this.saveIndex(); return structuredClone(room);
        }
        // A deleted room may still have a model response in flight.
        if (action === 'commit' && !this.rooms.some(room => room.id === input.id)) return { executionInactive: true };
        if (action === 'delete') {
            this.cancelApprovals(input.id);
            this.leases.delete(input.id); this.logs.delete(input.id);
            this.rooms = this.rooms.filter(room => room.id !== input.id);
            if (/^[0-9a-f-]{36}$/.test(String(input.id))) {
                fs.rmSync(this.logFile(input.id), { force: true });
                fs.rmSync(this.filesDir(input.id), { recursive: true, force: true });
            }
            this.saveIndex(); this.onEvent({ deleted: input.id });
            return { deleted: true, id: input.id };
        }
        const room = this.get(input.id);
        if (action === 'approval') {
            const approval = room.approval;
            if (room.status !== 'running' || !approval || approval.id !== input.approvalId) throw new Error('This approval is no longer active.');
            if (typeof input.approved !== 'boolean') throw new Error('Approval decision required');
            // A step that asks every time can never become a standing permission.
            if (input.always && (approval.kind !== 'site' || approval.sensitive || !approval.origin)) throw new Error('This step always asks and cannot grant a website permission.');
            this.settleApproval(room, { approved: input.approved, always: input.approved && !!input.always, by: 'you' });
        } else if (action === 'message') {
            const attachments = this.attachments(room, input.attachments);
            const text = this.text(typeof input.text === 'string' && !input.text.trim() && attachments.length
                ? `Review the attached files: ${attachments.map(file => file.name).join(', ')}.` : input.text, 6000);
            this.append(room, { type: 'message', from: 'you', text, ...(attachments.length ? { attachments } : {}) });
            // A running team reads this on its next turn. Anything else queues a run.
            if (room.status !== 'running') this.setStatus(room, 'queued');
        } else if (action === 'pause') {
            if (!['running', 'queued'].includes(room.status)) return structuredClone(room);
            this.leases.delete(room.id);
            this.setStatus(room, 'paused');
            this.append(room, { type: 'status', state: 'paused', text: input.reason ? this.text(input.reason, 500) : 'Paused.' });
        } else if (action === 'resume') {
            if (['running', 'queued'].includes(room.status)) return structuredClone(room);
            this.leases.delete(room.id);
            this.setStatus(room, 'queued');
            this.append(room, { type: 'status', state: 'resumed', text: 'Continuing.' });
        } else if (action === 'claim') {
            if (room.status !== 'queued' || this.leases.size >= MAX_RUNNING) return null;
            const token = randomUUID();
            this.leases.set(room.id, { token, sender });
            this.setStatus(room, 'running');
            this.onEvent({ room: structuredClone(room) });
            return { room: structuredClone(room), token };
        } else if (action === 'commit') {
            const lease = this.leases.get(room.id);
            // Revocation can race an in-flight model response. Reject without
            // mutation, as an expected cancellation.
            if (!lease || lease.sender !== sender || lease.token !== input.token || room.status !== 'running') return { executionInactive: true };
            const event = input.event || {};
            if (event.type === 'now') {
                // Ephemeral "who is doing what": pushed, never logged.
                room.now = event.agent ? { agent: this.text(event.agent, 40), text: event.text ? this.text(event.text, 160) : '' } : null;
                this.onEvent({ room: structuredClone(room) });
                return { ok: true };
            }
            if (event.type === 'finish') {
                // The run is over. `waiting` means the last message asks the user something.
                this.leases.delete(room.id);
                // A message that arrived after the master's last turn still needs an answer.
                const unanswered = this.events(room.id).filter(item => item.type === 'message').at(-1)?.from === 'you';
                this.setStatus(room, event.error ? 'paused' : unanswered ? 'queued' : 'idle');
                if (event.error) this.append(room, { type: 'status', state: 'error', text: this.text(event.error, 1200) });
                else this.onEvent({ room: structuredClone(room) });
                return structuredClone(room);
            }
            if (!USER_EVENTS.has(event.type)) throw new Error('Unknown workroom event');
            const clean = { type: event.type };
            if (event.type === 'message') Object.assign(clean, { from: this.text(event.from, 40), text: this.text(event.text, 60000) });
            if (event.type === 'join') clean.agent = this.text(event.agent, 40);
            if (event.type === 'task') Object.assign(clean, { id: this.text(event.id, 60), agent: this.text(event.agent, 40), text: this.text(event.text, 4000) });
            if (event.type === 'activity') Object.assign(clean, { taskId: this.text(event.taskId, 60), agent: this.text(event.agent, 40), tool: this.text(event.tool, 120),
                phase: ['start', 'ok', 'error'].includes(event.phase) ? event.phase : 'ok',
                ...(event.say ? { say: this.text(event.say, 240) } : {}), ...(event.error ? { error: this.text(String(event.error), 1200) } : {}) });
            if (event.type === 'task_end') Object.assign(clean, { id: this.text(event.id, 60), agent: this.text(event.agent, 40),
                status: event.status === 'done' ? 'done' : 'blocked', text: this.text(event.text, 60000),
                sources: (Array.isArray(event.sources) ? event.sources : []).filter(value => { try { return /^https?:$/.test(new URL(value).protocol); } catch { return false; } }).slice(0, 20) });
            if (event.type === 'status') Object.assign(clean, { state: 'note', text: this.text(event.text, 1200) });
            if (clean.from === 'you') throw new Error('Only the user speaks as the user');
            return { event: this.append(room, clean) };
        } else throw new Error('Unknown workroom command');
        this.onEvent({ room: structuredClone(room) });
        return structuredClone(room);
    }
    /** A window went away: whatever it was running stops. */
    release(sender) {
        for (const [id, lease] of this.leases) if (lease.sender === sender) {
            const room = this.get(id); this.leases.delete(id);
            this.setStatus(room, 'paused');
            this.append(room, { type: 'status', state: 'paused', text: 'The team stopped when its window closed. Continue to pick it up.' });
        }
    }
}
module.exports = WorkroomStore;
