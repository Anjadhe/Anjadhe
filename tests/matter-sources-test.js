#!/usr/bin/env node
// MatterSources (js/core/matter-sources.js): the person's own tasks and
// calendar events as sources for their folders. What counts as new, the
// check on the triage answer, and the observation handed to the door.
const assert = require('assert');
const S = require('../js/core/matter-sources.js');
const M = require('../js/core/matters.js');
const NOW = Date.parse('2026-10-05T12:00:00');
const day = n => new Date(NOW + n * 86400000);

// ── Which tasks are the person's own and new (S4) ──
{
    const c = (id, title, extra = {}) => ({ id, title, state: 'open', createdAt: '2026-10-03T10:00:00Z', origin: { kind: 'you' }, repeat: { rule: 'none' }, ...extra });
    const items = [
        c('a', 'Renew passport', { when: '2026-11-01', note: 'expires in March' }),
        c('b', 'Pay the water bill', { origin: { kind: 'matter', ref: 'matter:w1' } }),
        c('c', 'Reply to the school', { origin: { kind: 'email', ref: 'e1' } }),
        c('d', 'Morning run', { repeat: { rule: 'daily' } }),
        c('e', 'Old thing', { createdAt: '2026-08-01T10:00:00Z' }),
        c('f', 'Done thing', { state: 'done' }),
        c('g', 'Said in chat', { origin: { kind: 'chat' }, createdAt: '2026-10-04T10:00:00Z' }),
        c('h', '   '),
        c('i', 'From Reminders', { origin: { kind: 'apple' }, createdAt: '2026-10-04T12:00:00Z', by: '2026-10-09' })
    ];
    const own = S.ownCommitments(items, {}, NOW);
    assert.deepEqual(own.map(x => x.id), ['a', 'g', 'i'], 'not what came from a folder or a message, a habit, an old or finished task');
    assert.deepEqual([own[0].key, own[0].kind, own[0].when, own[0].note], ['c:a', 'commitment', '2026-11-01', 'expires in March']);
    assert.equal(own[2].when, '2026-10-09');
    assert.deepEqual(S.ownCommitments(items, { 'c:a': 'x', 'c:g': 'x' }, NOW).map(x => x.id), ['i'], 'each is looked at once');
}
// ── Which events ──
{
    const e = (id, summary, start, extra = {}) => ({ id, summary, start, ...extra });
    const events = [
        e('1', 'Mom surgery', day(9), { location: 'St. Mary Hospital', attendees: [{}, {}] }),
        e('2', 'Standup', day(1), { recurringEventId: 'series-1' }),
        e('3', 'Yesterday', day(-1)),
        e('4', 'Far off', day(90)),
        e('5', 'Cancelled', day(3), { status: 'cancelled' }),
        e('6', 'Dentist', day(4)),
        e('7', 'Trip', day(20), { allDay: true })
    ];
    const own = S.ownEvents(events, {}, NOW, id => id === '6');
    assert.deepEqual(own.map(x => x.id), ['1', '7'], 'ahead, once-off, not cancelled, and not already a folder\'s event');
    assert.deepEqual([own[0].key, own[0].kind, own[0].when, own[0].time, own[0].note], ['e:1', 'calendar', M._iso(day(9)), '12:00', 'at St. Mary Hospital; 2 people']);
    assert.equal(own[1].time, null, 'an all-day event has no time');
    assert.deepEqual(S.ownEvents(events, { 'e:1': 'x' }, NOW).map(x => x.id), ['6', '7']);
}
// ── The triage answer, and what the door is handed ──
{
    const items = [{ key: 'c:a', kind: 'commitment', id: 'a', title: 'Buy milk' }, { key: 'c:b', kind: 'commitment', id: 'b', title: 'Renew passport', when: '2026-11-01', note: 'expires in March' }];
    assert.deepEqual(S.vetTriage({ keep: ['I2', 'I<1>', 'I9', 'x', 'I2'] }, items), [0, 1], 'only labels it was shown, however written');
    assert.deepEqual(S.vetTriage({ keep: [] }, items), []);
    assert.deepEqual(S.vetTriage(null, items), []);
    const p = S.triagePrompt(items, 'commitment', NOW);
    assert.match(p, /\[I1\] Buy milk\n\[I2\] Renew passport — 2026-11-01 — expires in March/);
    assert.match(S.triagePrompt(items, 'calendar', NOW), /events on the person's own calendar/);
    const f = S.observationFor(items[1], NOW);
    assert.deepEqual([f.id, f.source, f.own, f.subject, f.dates, f.summary], ['c:b', 'commitment', true, 'Renew passport', ['2026-11-01'], 'Renew passport (2026-11-01)']);
    assert.equal(M.SOURCES[f.source].message, false);
    assert.equal(M._sourceFor(f), 'matter-own'); assert.equal(M._sourceFor({ source: 'imessage' }), 'imessage-matter');
    // S2: what they made themselves never notifies and opens no step.
    const j = M.vet({ about: 'new', kind: 'other', title: 'Passport renewal', status: 'To do', next: { what: 'Renew the passport', how: 'none', yours: true }, tell: 'now' }, f, [], NOW);
    assert.deepEqual([j.about, j.next, j.tell], ['new', null, 'file']);
    const m = M.apply({}, j, f, NOW);
    assert.deepEqual([m.sources[0].kind, m.sources[0].from, M.messagesOf(m).length, M.card(m)], ['commitment', 'You', 0, null], 'a silent folder: no message, no card');
    global.StorageManager = { set() {}, get() { return null; } };
    M._data = { version: 2, matters: { 'matter:w1': { id: 'matter:w1', kind: 'bill', title: 'City Water bill', status: 'Due Oct 12', state: 'open', sources: [] } }, aliases: {} };
    const join = M.ownJoin(f, { about: 'matter:w1', kind: 'other', title: 'Passport', status: 'Paid', change: 'done', when: '2026-11-01', tell: 'file' });
    assert.deepEqual([join.about, join.kind, join.title, join.status, join.change, join.when], ['matter:w1', 'bill', '', '', 'same', null], 'joining a folder changes nothing it says');
    assert.equal(M.ownJoin(f, { about: 'new', title: 'Passport' }).title, 'Passport', 'a new thing keeps its answer');
    assert.equal(M.ownJoin(M.observation({ id: 'chat:1', source: 'chat', text: 'paid' }), { about: 'matter:w1', status: 'Paid', change: 'done' }).change, 'done', 'what they SAID does change it');
    M._data = null;
}
// ── One batch: triage, the door, and the links made by code (S3) ──
(async () => {
    let blob = null;
    global.StorageManager = { get: () => blob, set: (_k, v) => { blob = v; } };
    global.AgentService = { model: 'x', numCtx: 8192 };
    const answers = [{ keep: ['I2', 'I3'] },
        { about: 'new', kind: 'other', title: 'Passport renewal', status: 'To do', change: 'new', when: '2026-11-01', tell: 'file' },
        { about: 'none' }];
    global.LLMLogger = { call: async () => ({ message: { content: JSON.stringify(answers.shift()) } }) };
    global.Matters = M; M._data = null; M._changed = () => {};
    const seen = {};
    const items = [{ key: 'c:a', kind: 'commitment', id: 'a', title: 'Buy milk' }, { key: 'c:b', kind: 'commitment', id: 'b', title: 'Renew passport', when: '2026-11-01' }, { key: 'c:c', kind: 'commitment', id: 'c', title: 'Call the plumber' }];
    const r = await S.runBatch(items, 'commitment', seen, NOW);
    assert.deepEqual([r.looked, r.kept, r.filed.length], [3, 2, 1], 'kept by triage is not yet filed: the door still decides');
    assert.deepEqual(Object.keys(seen).sort(), ['c:a', 'c:b', 'c:c'], 'all looked at once, kept or not');
    const m = M.all()[0];
    assert.deepEqual([m.title, m.tasks, m.sources[0].id], ['Passport renewal', ['b'], 'c:b'], 'the task is linked to its folder by code');
    answers.push({ keep: ['I1'] }, { about: 'new', kind: 'appointment', title: 'Mom\'s surgery', change: 'new', tell: 'file' });
    const ev = await S.runBatch([{ key: 'e:1', kind: 'calendar', id: 'ev-1', title: 'Mom surgery', when: '2026-10-14', time: '09:00' }], 'calendar', seen, NOW);
    const s = M.get(ev.filed[0].id);
    assert.deepEqual([s.calendarEventId, s.when], ['ev-1', { date: '2026-10-14', time: '09:00' }], 'the event is the folder\'s event, with its day');
    global.LLMLogger = { call: async () => ({ error: 'offline' }) };
    assert.equal(await S.runBatch([{ key: 'c:z', kind: 'commitment', id: 'z', title: 'x' }], 'commitment', seen, NOW), null, 'not asked: nothing is marked seen');
    assert.ok(!seen['c:z']);
    assert.equal(S.enabled(), false, 'off unless the flag is on');
    console.log('matter-sources: which are new, triage, the observation, one batch passed');
})().catch(e => { console.error(e); process.exit(1); });
