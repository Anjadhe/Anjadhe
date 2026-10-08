// Chat jobs on the workroom engine (js/agent/team-jobs.js, 2026-10-02):
// the store ties a room to its chat, a room reads as a job (J4), and a
// specialist's writes exist only in a chat job (J2).
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');

const WorkroomStore = require('../js/main/workroom-store.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatjobs-'));
const store = new WorkroomStore(dir);
const room = store.command('create', { goal: 'Plan a week of dinners\n\nFrom our chat, for context:\nUser: I am vegetarian', conversationId: 'conv_123' });
assert.equal(room.conversationId, 'conv_123', 'the room belongs to its chat');
assert.equal(room.title, 'Plan a week of dinners', 'the title is the ask, not the context');
const plain = store.command('create', { goal: 'A workroom of its own', conversationId: '../../etc' });
assert.equal(plain.conversationId, undefined, 'a malformed chat id is not stored');
const run = store.command('create', { goal: 'Tidy my tasks', routineId: 'note_r1', untrusted: true });
assert.equal(run.routineId, 'note_r1', 'a routine run names its routine');
assert.equal(run.untrusted, true, 'an email- or file-triggered run is marked');
const both = store.command('create', { goal: 'x', conversationId: 'c9', routineId: 'r9', rehearsal: true });
assert.ok(both.conversationId && !both.routineId && !both.rehearsal, 'a room is ONE kind');
const tryRoom = store.command('create', { goal: 'Try it', rehearsal: true });
assert.equal(tryRoom.rehearsal, true);
fs.rmSync(dir, { recursive: true, force: true });

global.Specialists = require('../js/agent/specialists/registry.js');
global.FEATURES = { isEnabled: () => false };
const TeamJobs = require('../js/agent/team-jobs.js');
const base = { id: 'r1', conversationId: 'c1', title: 'Plan dinners', members: ['tasks'], createdAt: 'x', updatedAt: 'y' };
const ev = [
    { seq: 1, type: 'message', from: 'you', text: 'Plan dinners' },
    { seq: 2, type: 'task', id: 't1', agent: 'tasks', text: 'Read the week' },
    { seq: 3, type: 'task_end', id: 't1', agent: 'tasks', status: 'done', text: 'ok' },
    { seq: 4, type: 'task', id: 't2', agent: 'notes', text: 'Write the list' }
];
TeamJobs._events.set('r1', ev);
let job = TeamJobs.asJob({ ...base, status: 'running', now: { agent: 'notes', text: 'reading the brief' } });
assert.equal(job.status, 'running');
assert.equal(job.engine, 'team');
assert.equal(job.note, 'Notes is reading the brief.');
assert.deepEqual(job.plan.map(p => p.status), ['done', 'running']);
TeamJobs._asking.set('r1', 'Tasks is waiting for your approval.');
assert.equal(TeamJobs.asJob({ ...base, status: 'running' }).status, 'awaiting_user', 'an open approval is "needs you"');
TeamJobs._asking.clear();
job = TeamJobs.asJob({ ...base, status: 'idle' });
assert.equal(job.status, 'done');
assert.match(job.note, /Worked with Tasks\. The answer is in the chat\./, 'a finished line names who worked, never repeats the answer');
TeamJobs._events.set('r1', [...ev, { seq: 5, type: 'status', state: 'error', text: 'The model call failed' }]);
assert.equal(TeamJobs.asJob({ ...base, status: 'paused' }).status, 'failed');

// J2: writes are declared on the private-data specialists only, and every
// one is in the set TeamJobs approves.
for (const def of Specialists._defs.values()) {
    for (const w of def.writes || []) assert.ok(TeamJobs.WRITES.has(w), `${def.id}: ${w} is an approved write`);
    if (def.id === 'research' || def.id === 'browser' || def.id === 'writer') assert.ok(!(def.writes || []).length, `${def.id} holds no writes`);
    assert.ok(!(def.writes || []).some(w => /delete|send|trash/.test(w)), `${def.id}: never delete or send`);
}
// J2: what each kind may write, and a try never writes.
global.AgentService = { UNTRUSTED_BLOCKED_TOOLS: new Set(['create_calendar_event', 'update_calendar_event']) };
const planner = Specialists._defs.get('planner');
assert.ok(TeamJobs.writesFor({ conversationId: 'c' }, planner).includes('create_calendar_event'));
assert.ok(!TeamJobs.writesFor({ routineId: 'r', untrusted: true }, planner).includes('create_calendar_event'), 'an untrusted run gets no blocked tool');
assert.ok(TeamJobs.writesFor({ routineId: 'r', untrusted: true }, planner).includes('create_schedule_item'));
assert.deepEqual(TeamJobs.writesFor({}, planner), [], 'a plain workroom gets no writes');
(async () => {
    const committed = [];
    global.document = { createElement: () => ({ set innerHTML(v) { this.textContent = String(v).replace(/<[^>]+>/g, ''); }, textContent: '' }) };
    global.AgentUI = { _describeToolAction: (n, a) => `Add the task <strong>“${a.title}”</strong>.` };
    const out = await TeamJobs.beforeWrite({ id: 'try', rehearsal: true }, planner, 'create_schedule_item', { title: 'Run 5k' }, async e => committed.push(e));
    assert.equal(out.rehearsal, true, 'a try hands back a stand-in result');
    assert.equal(committed[0].type, 'status');
    assert.equal(committed[0].text, 'Would change: Add the task “Run 5k”', 'the change is recorded by code');
    TeamJobs._events.set('r2', [{ seq: 1, type: 'status', state: 'note', text: 'Changed: Add the task “Run 5k”' },
        { seq: 2, type: 'message', from: 'master', text: 'Added your run.' }]);
    const job = TeamJobs.asJob({ id: 'r2', routineId: 'rt', title: 'Plan runs', status: 'idle', members: ['tasks'] });
    assert.deepEqual(job.changes, ['Add the task “Run 5k”']);
    assert.equal(job.note, 'Changed: Add the task “Run 5k”.', 'a finished run says what it changed');
    assert.match(job.report, /^Changed: Add the task “Run 5k”\n\nAdded your run\.$/, 'the report leads with what changed');
    // J5: the retired engine's records stay readable; a live one reads as stopped.
    global.StorageManager = { get: () => [{ id: 'old1', status: 'running', goal: 'Old job' }, { id: 'old2', status: 'done', goal: 'Older' }] };
    const legacy = TeamJobs.legacy();
    assert.equal(legacy[0].status, 'failed');
    assert.equal(legacy[1].status, 'done');
    console.log('team-jobs: job kinds, writes, tries, changes, history passed');
})().catch(e => { console.error(e); process.exit(1); });
