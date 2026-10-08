#!/usr/bin/env node
// The matter page (js/apps/fyi/matter-page.js, 2026-10-07): the pure parts
// of one tracked thing's sheet — its facts line, state word and back label —
// and the law that the page reads stored fields only (MP1, MP2).
const assert = require('assert');

global.Matters = {
    SOURCES: { email: { message: true }, imessage: { message: true }, chat: { message: false }, calendar: { message: false } },
    messagesOf(m) { return ((m && m.sources) || []).filter(s => !s.kind || (this.SOURCES[s.kind] || {}).message); },
    titleOf(m) { return (m && m.title) || 'Something to look at'; }
};
const MP = require('../js/apps/fyi/matter-page.js');
const now = new Date('2026-10-07T09:00:00');

// ── The facts line: kind · when · amount · place · messages ──
{
    const m = { id: 'matter:a', kind: 'appointment', state: 'open', title: 'Dentist', when: { date: '2026-10-08', time: '14:30' },
        sources: [{ id: 'a', kind: 'email', at: '2026-10-01T10:00:00Z' }, { id: 'b', kind: 'imessage', at: '2026-10-02T10:00:00Z' }, { id: 'c', kind: 'calendar' }] };
    const line = MP.factsLine(m, now);
    assert.ok(line.startsWith('Appointment · Tomorrow, '), line);
    assert.ok(line.endsWith(' · 2 messages'), 'the calendar observation is not a message: ' + line);
    assert.equal(MP.factsLine({ kind: 'bill', when: { date: '2026-10-07' }, amount: '$84.12', sources: [{ id: 'x' }] }, now), 'Bill · Today · $84.12 · 1 message');
    assert.equal(MP.factsLine({ kind: 'reservation', vendor: 'Alaska', code: 'QX7P2', sources: [] }, now), 'Reservation · Alaska · #QX7P2');
    assert.equal(MP.factsLine({ kind: 'other', sources: [] }, now), '', 'nothing invented when nothing is known');
    assert.equal(MP.factsLine({ kind: 'bill', amount: 'null', sources: [] }, now), 'Bill', 'a "null" amount is no amount');
}

// ── State and where you came from ──
{
    assert.equal(MP.stateWord({ state: 'open' }), '', 'open shows the step, not a word');
    assert.equal(MP.stateWord({ state: 'past' }), 'Past');
    assert.equal(MP.stateWord({ state: 'ignored' }), 'Ignored');
    assert.equal(MP.stateWord({ state: 'cancelled' }), 'Cancelled');
    assert.equal(MP.fromLabel(null), 'Now'); assert.equal(MP.fromLabel('home'), 'Now');
    assert.equal(MP.fromLabel('commitments'), 'Commitments'); assert.equal(MP.fromLabel('fyi'), 'Insights'); assert.equal(MP.fromLabel('agent'), 'Chat');
}

// ── The tasks about it: Commitments first, the old blob as the fallback ──
{
    global.Commitments = { _inited: true, get: id => id === 't1' ? { id, title: 'Pay the dentist', state: 'open', when: { date: '2026-10-09' } } : null };
    global.StorageManager = { get: k => k === 'schedule' ? { scheduleItems: [{ id: 't2', title: 'Old task', lastCompletedDate: '2026-10-01' }] } : null };
    const tasks = MP.tasksOf({ tasks: ['t1', 't2', 'gone'], next: { taskId: 't1' } });
    assert.deepEqual(tasks.map(t => [t.id, t.state]), [['t1', 'Open'], ['t2', 'Done']], 'each task once, the missing one skipped');
}

// ── MP1 / MP2: no inputs, no model words; the source is a row, the chat key is the folder's id ──
{
    const src = require('fs').readFileSync(require.resolve('../js/apps/fyi/matter-page.js'), 'utf8');
    assert.ok(!/<input|<textarea|contenteditable/.test(src), 'the facts are read-only (MP1)');
    assert.ok(!/LLMLogger|AgentService\.(chat|complete)|callModel/.test(src), 'nothing model-written at render (MP2)');
    assert.ok(/PageChat\.html\(m\.id/.test(src), 'the box is keyed by the folder id, Now\'s thingKey (MP3)');
    assert.ok(/data-mp="message"/.test(src) && !/data-mp="open-source"/.test(src), 'each message has its own door (MP4)');
}

// Slack evidence shares the page, with its own safe source door.
{
    const actual = require('../js/core/matters');
    global.Matters.SOURCES.slack = { message: true };
    global.Matters.sourceUrl = actual.sourceUrl;
    const m = { sources: [{ id: 'slack:1', kind: 'slack', from: 'Alex', summary: '<script>private</script>',
        slack: { workspaceId: 'T123', channelId: 'D123', invalidated: true, sourceUrl: 'https://evil.example' } }] };
    const html = MP.messagesHtml(m);
    assert.match(html, /Slack from Alex/); assert.match(html, /Open in Slack/); assert.match(html, /Needs review/);
    assert.ok(!html.includes('<script>'));
    global.Matters.forSource = () => m;
    let opened;
    global.AppManager = { openExternal: url => { opened = url; } };
    MP.openMessage('slack:1');
    assert.equal(opened, 'https://slack.com/app_redirect?team=T123&channel=D123');
    opened = null; m.sources[0].slack.channelId = 'D123&team=EVIL'; MP.openMessage('slack:1');
    assert.equal(opened, null);
}

console.log('matter-page-test: ok');
