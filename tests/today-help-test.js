// TodayHelp (js/core/today-help.js; AI-native 2026-10-02): each row's facts and
// allowed actions, the checks on the assistant's answer, and the day line.
const assert = require('node:assert/strict');
const H = require('../js/core/today-help.js');

const now = new Date(2026, 9, 1, 9, 0);
const at = (h, m = 0) => new Date(2026, 9, 1, h, m);

// Meetings: the facts, the allowed actions, and the plain row before (or without) the assistant.
{
    const facts = { people: [{ name: 'Dana' }, { name: 'Sam' }], lastEmail: { ms: at(8).getTime() - 86400000, subject: 'Q3 numbers', from: 'Dana <dana@x.com>', sent: false } };
    let o = H.eventOptions({ summary: 'Sync', start: at(10) }, { key: 'event:1', facts, meeting: { url: 'https://meet.google.com/abc' } }, now.getTime());
    assert.deepEqual(o.allowed.map(a => a.id), ['join', 'chat']);
    assert.equal(o.fallback.action.label, 'Join');
    assert.equal(o.fallback.line, 'Last email (from Dana, yesterday): Q3 numbers');
    assert.match(o.facts, /with Dana and Sam; has a call link; last email from Dana yesterday: "Q3 numbers"/);
    o = H.eventOptions({ summary: 'Dentist', start: at(14), location: '12 Main St' }, { key: 'event:2' }, now.getTime());
    assert.deepEqual(o.allowed.map(a => a.id), ['directions', 'chat']);
    assert.match(o.fallback.action.url, /maps\.apple\.com\/\?q=12%20Main%20St/);
    o = H.eventOptions({ summary: 'X', start: at(15) }, { key: 'event:3', prep: 'Bring the budget slide.', facts }, now.getTime());
    assert.equal(o.fallback.line, 'Bring the budget slide.', 'a stored prep line is shown as stored');
    assert.equal(H.eventOptions({ summary: 'Focus', start: at(16) }, { key: 'e' }, now.getTime()).fallback.action, null, 'nothing to open, no button');
}

// Tasks: facts and allowed actions; the plain row is the email, else Open.
{
    let o = H.taskOptions({ id: 'lib', title: "Return overdue library book 'Rodrick rules'" },
        { key: 'task:lib', email: { id: 'm2', subject: 'Your AC Library materials may be overdue', sender: 'AC Library', due: '2026-09-28' } }, now.getTime());
    assert.deepEqual(o.allowed.map(a => a.id), ['email', 'done', 'open', 'chat']);
    assert.equal(o.fallback.line, 'From AC Library · was due Sep 28');
    assert.equal(o.fallback.action.kind, 'email');
    o = H.taskOptions({ id: 'w', title: 'Workout A', repeat: 'weekly' }, { key: 'task:w', project: { title: 'Strength base' } });
    assert.match(o.facts, /repeats weekly; part of the project "Strength base"/);
    assert.equal(o.fallback.line, 'Next step in Strength base');
    assert.equal(o.fallback.action.kind, 'task');
    assert.ok(H.oneLine('x '.repeat(200)).length <= H.LINE_MAX, 'a help line is one line');
    assert.equal(H.nameFromTitle('Meet with Prakash'), 'Prakash');

    // The checks on the assistant's answer for a row.
    const v = (c) => H.vetRow(o, c);
    assert.deepEqual(v({ help: 'Your weekly lift; tick it off when done.', action: 'done', label: 'Done' }), { line: 'Your weekly lift; tick it off when done.', action: { label: 'Done', kind: 'done', id: 'w' } });
    assert.deepEqual(v({ help: 'Join at 3:15', action: 'join' }), null, 'an action the row does not allow and a number it lacks');
    assert.equal(v({ help: 'Plan the next block', action: 'chat', label: 'Plan it' }).action.kind, 'task', 'a chat with nothing to ask falls back');
    const c = v({ help: 'I can plan the next 4 weeks of this.', action: 'chat', label: 'Plan it', ask: 'Plan my next strength block' });
    assert.equal(c.line, 'Next step in Strength base', 'a number the facts lack drops the line, not the action');
    assert.deepEqual(c.action, { label: 'Plan it', kind: 'chat', prompt: 'Plan my next strength block' });

    // helpFor: the plain row until the assistant has answered for the row AS IT IS.
    assert.deepEqual(H.helpFor(o), o.fallback);
    H._judged = { fp: 'x', map: { 'task:w': { help: 'Tick it off after the gym.', action: 'done', label: 'Done', facts: o.facts } } };
    assert.equal(H.helpFor(o).line, 'Tick it off after the gym.');
    H._judged.map['task:w'].facts = 'older facts';
    assert.deepEqual(H.helpFor(o), o.fallback, 'an answer about the row as it was is not used');
    H._judged = null;
}

// The day line: meetings left, clashes, the longest free stretch, tasks to fit.
{
    const events = [
        { start: at(10), end: at(11), title: 'Standup' },
        { start: at(10, 30), end: at(11, 30), title: '1:1' },
        { start: at(16), end: at(17), title: 'Review' }
    ];
    const line = H.daySummary(events, 2, now);
    assert.match(line, /^3 meetings left; free 11:30\s?AM–4:00\s?PM for your 2 tasks\. Standup and 1:1 overlap at 10:30\s?AM\.$/);
    assert.equal(H.daySummary([], 0, now), 'No more meetings; free 9:00 AM–6:00 PM.'.replace(/ /g, H._hm(now).includes(' ') ? ' ' : ' '));
    assert.match(H.daySummary([], 3, at(17, 30)), /^No more meetings; 3 tasks to fit in\.$/, 'no hour-long gap left: just the count');
}

// Plan my day: the prompt lists today's rows (code) and asks before changing anything.
{
    const p = H.planPrompt([{ kind: 'event', time: '10:00 AM', title: 'Standup' }, { kind: 'task', time: '', title: 'Pay bill' }], now);
    assert.match(p, /Meetings:\n- 10:00 AM Standup/);
    assert.match(p, /Tasks:\n- Pay bill/);
    assert.match(p, /ask before changing any task\.$/);
}

console.log('today-help: meetings, tasks, the day line, plan my day passed');
