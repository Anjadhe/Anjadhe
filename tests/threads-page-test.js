// Threads (js/core/threads-page.js): a folder told as a text thread. Pure parts.
const assert = require('assert');
const T = require('../js/core/threads-page.js');

const m = { id: 'matter:e1', kind: 'bill', state: 'open', title: 'Water bill', status: 'Due Oct 14', updatedAt: '2026-10-08T09:00:00Z',
    sources: [{ id: 'e1', kind: 'email', at: '2026-10-08T09:00:00Z', from: 'City Water', summary: 'Your $84 bill is due Oct 14' },
        { id: 'c1', kind: 'chat', at: '2026-10-08T10:00:00Z', summary: 'own words' }],
    log: [{ at: '2026-10-08T08:00:00Z', from: 'calendar', text: 'Added to your calendar' }] };
const conv = { messages: [
    { role: 'assistant', content: 'This chat is about “Water bill”.', metadata: { fromCard: true }, timestamp: '2026-10-09T11:00:00Z' },
    { role: 'user', content: 'paid it', timestamp: '2026-10-09T12:00:00Z' },
    { role: 'tool', content: '{}', timestamp: '2026-10-09T12:00:01Z' },
    { role: 'assistant', content: 'Got it, **marked paid**.', timestamp: '2026-10-09T12:00:05Z' }] };

// Mail is a bubble from the sender; the person's own words are not a message; the code-written opener and tool rows are not shown.
let items = T.timeline(m, conv, null);
assert.deepStrictEqual(items.map(x => x.side + ':' + x.kind), ['them:log', 'them:message', 'me:chat', 'them:chat']);
assert.strictEqual(items[1].text, 'City Water emailed. Your $84 bill is due Oct 14.');
// The status already said by a bubble is not repeated.
assert.ok(!items.some(x => x.kind === 'now'));
assert.strictEqual(T.preview(items), 'Got it, marked paid.');
assert.strictEqual(T.preview(items.slice(0, 3)), 'You: paid it');

// An open Now card is always the newest bubble and carries the card.
const card = { key: 'matter:matter:e1:next', body: 'Pay it by Oct 14', title: 'Water bill' };
items = T.timeline(m, conv, card);
assert.strictEqual(items[items.length - 1].card, card);
assert.strictEqual(items[items.length - 1].text, 'Pay it by Oct 14.');

// A settled folder says how it ended.
items = T.timeline({ ...m, state: 'done', sources: [], log: [] }, null, null);
assert.deepStrictEqual(items.map(x => x.text), ['All done with this one.']);

// List times read like Messages.
const now = Date.parse('2026-10-10T15:00:00');
assert.strictEqual(T.timeLabel(Date.parse('2026-10-09T09:00:00'), now), 'Yesterday');
assert.ok(/\d/.test(T.timeLabel(Date.parse('2026-10-10T09:05:00'), now)));

// What the model is given for a thread: the facts and the thread as seen, without the chat lines (the conversation has them).
global.Matters = { get: id => (id === m.id ? m : null), titleOf: x => x.title, whenText: () => 'Tue, Oct 14', openStep: () => ({ what: 'Pay it', by: '2026-10-14', how: 'link' }) };
global.SimpleExperience = { thingKey: c => c.matter || (c.commitment ? `task:${c.commitment}` : c.key), cards: () => [{ ...card, matter: m.id }], cardActs: () => [{ act: 'primary', label: 'Open the link' }, { act: 'dismiss', label: 'Already done' }, { act: 'notuseful', label: 'Not useful', feedback: true }] };
const ctx = T.contextFor({ todayKey: m.id, messages: conv.messages });
assert.ok(ctx.includes('Thing: Water bill · bill · Tue, Oct 14'));
assert.ok(ctx.includes('Open next step: Pay it (by 2026-10-14) [link]'));
assert.ok(ctx.includes('City Water emailed. Your $84 bill is due Oct 14.'));
assert.ok(ctx.includes('noted: Added to your calendar'));
assert.ok(ctx.includes('you (nenva) asked, newest: "Pay it by Oct 14." with buttons: Open the link / Already done'));
assert.ok(!ctx.includes('paid it'), 'chat lines stay in the conversation');
assert.strictEqual(T.contextFor({ todayKey: 'matter:gone' }), '');

// A commitment as a thread: how it came, what changed (in words, by code), its chat, and where it stands.
const c = { id: 'c1', title: 'Renew passport', state: 'open', origin: { kind: 'you' }, createdAt: '2026-10-01T09:00:00', updatedAt: '2026-10-05T09:00:00',
    when: { date: '2026-10-08', time: null }, repeat: { rule: 'none', days: [] } };
const ledger = [{ op: 'create', target: 'c1', at: '2026-10-01T09:00:00', after: { title: 'Renew passport' } },
    { op: 'change', target: 'c1', at: '2026-10-05T09:00:00', before: { when: null }, after: { when: { date: '2026-10-08', time: null } } }];
const cconv = { messages: [{ role: 'user', content: 'I need photos first', timestamp: '2026-10-06T10:00:00' }] };
let ci = T.commitmentTimeline(c, cconv, null, ledger, Date.parse('2026-10-10T12:00:00'), '2026-10-10');
assert.deepStrictEqual(ci.map(x => x.kind), ['log', 'log', 'chat', 'status']);
assert.strictEqual(ci[0].text, 'You added this.');
assert.ok(/^Moved to /.test(ci[1].text));
assert.ok(/^This was due /.test(ci[3].text), 'past its day: says it was due');
// Where it stands is not an event: out of the timeline, the preview and the time.
assert.deepStrictEqual(T.events(ci).map(x => x.kind), ['log', 'log', 'chat']);
assert.ok(/^This was due /.test(T.statusOf(ci)));
assert.strictEqual(T.preview(ci), 'You: I need photos first');
assert.strictEqual(T.lastAt(ci, {}), Date.parse('2026-10-06T10:00:00'));
// Done, and with a card the card speaks last.
assert.strictEqual(T.commitmentTimeline({ ...c, state: 'done' }, null, null, [], Date.now(), '2026-10-10').pop().text, 'All done with this one.');
ci = T.commitmentTimeline(c, null, { key: 'k', body: 'Want me to find a photo place near you' }, [], Date.now(), '2026-10-10');
assert.strictEqual(ci.pop().text, 'Want me to find a photo place near you.');
assert.strictEqual(T.ledgerWords({ op: 'done', after: { history: { '2026-10-09': 'done' } } }).startsWith('Marked done for '), true);
assert.strictEqual(T.ledgerWords({ op: 'reopen', after: {} }), 'Opened again.');
assert.strictEqual(T.commitmentWhen({ when: { time: '09:00' }, repeat: { rule: 'daily' } }).startsWith('Every day at '), true);

// Unread first, then newest; the thread just opened keeps its place.
const rows = [{ key: 'a', at: 3, unread: false }, { key: 'b', at: 1, unread: true }, { key: 'c', at: 2, unread: false }, { key: 'd', at: 0, unread: false }];
assert.deepStrictEqual(T.order(rows).map(r => r.key), ['b', 'a', 'c', 'd']);
assert.deepStrictEqual(T.order(rows, 'd').map(r => r.key), ['b', 'd', 'a', 'c']);
// A deleted thread comes back on a new event, not on a status line.
assert.strictEqual(T.lastEventAt([{ at: 5, kind: 'chat' }, { at: 9, kind: 'status' }]), 5);


// A sender's thread (docs/SENDERS.md M2): its members' events in time order, each tagged with what it is about;
// the open card last; the intro first while unconfirmed; where it stands from the open member that changed last.
const sender = { id: 'sender:auto', name: 'Auto insurance', allGood: 'Covered and paid', confirmed: false, createdAt: '2026-10-09T08:00:00Z' };
const mA = { key: 'matter:e1', title: 'GEICO renewal', settled: false, at: Date.parse('2026-10-09T09:00:00Z'), items: [
    { at: Date.parse('2026-10-09T09:00:00Z'), side: 'them', kind: 'message', text: 'GEICO emailed.' },
    { at: Date.parse('2026-10-09T09:00:00Z'), side: 'them', kind: 'status', text: 'Renews Nov 2.' },
    { at: Date.parse('2026-10-09T09:30:00Z'), side: 'them', kind: 'now', text: 'Compare prices?', card: { key: 'k' } }] };
const tB = { key: 'task:c1', title: 'Print ID cards', settled: true, at: Date.parse('2026-10-08T09:00:00Z'), items: [
    { at: Date.parse('2026-10-08T09:00:00Z'), side: 'them', kind: 'log', text: 'You added this.' },
    { at: Date.parse('2026-10-08T09:00:00Z'), side: 'them', kind: 'status', text: 'All done with this one.' }] };
const sconv = { messages: [{ role: 'user', content: 'is it covered?', timestamp: '2026-10-10T10:00:00Z' }] };
const st = T.senderTimeline(sender, [mA, tB], sconv);
assert.deepStrictEqual(st.map(x => x.kind), ['intro', 'log', 'message', 'chat', 'now', 'status']);
assert.strictEqual(st[0].text, 'I started keeping track of Auto insurance for you. All good means: Covered and paid.');
assert.strictEqual(st[1].about, 'Print ID cards');
assert.strictEqual(st[2].about, 'GEICO renewal');
assert.strictEqual(st[3].about, undefined);
assert.strictEqual(st[st.length - 1].text, 'GEICO renewal: Renews Nov 2.');
// One member: no captions; a confirmed sender: no intro.
const one = T.senderTimeline({ ...sender, confirmed: true }, [mA], null);
assert.ok(!one.some(x => x.kind === 'intro') && one.every(x => !x.about));
assert.strictEqual(T.statusOf(one), 'Renews Nov 2.');
assert.strictEqual(T._letter('  auto insurance'), 'A');

// A sender's info page (M3): open first, settled apart; dated things ahead, soonest first; what the mail said, once each.
const rows3 = [
    { key: 'matter:r', type: 'matter', title: 'GEICO renewal', settled: false, at: 3, facts: 'bill · Nov 2', items: [{ kind: 'status', text: 'Renews Nov 2.' }],
        rec: { when: { date: '2026-11-02' }, amount: '$612', code: 'P-77', vendor: 'GEICO' } },
    { key: 'matter:c', type: 'matter', title: 'ID cards', settled: true, at: 1, facts: '', items: [], rec: { when: { date: '2026-09-01' }, vendor: 'GEICO' } },
    { key: 'task:t', type: 'commitment', title: 'Compare quotes', settled: false, at: 2, facts: '', items: [], rec: { id: 't', by: '2026-10-25', when: {} } },
    { key: 'task:old', type: 'commitment', title: 'Old', settled: false, at: 0, facts: '', items: [], rec: { id: 'old', when: { date: '2026-01-01' } } }
];
const inf = T.senderInfo(rows3, '2026-10-10', (c) => (c.when && c.when.date) || null);
assert.deepStrictEqual(inf.open.map(i => i.key), ['matter:r', 'task:t', 'task:old']);
assert.deepStrictEqual(inf.settled.map(i => i.key), ['matter:c']);
assert.strictEqual(inf.open[0].status, 'Renews Nov 2.');
assert.deepStrictEqual(inf.upcoming.map(u => [u.key, u.date, !!u.by]), [['task:t', '2026-10-25', true], ['matter:r', '2026-11-02', false]]);
assert.deepStrictEqual(inf.facts.map(f => `${f.label}=${f.value}`), ['Amount=$612', 'Number=#P-77', 'From=GEICO']);

// nenva's conversations (M4): general chats only, never a thing's, a page's, a routine's, a private one or one nobody spoke in.
const u = [{ role: 'user', content: 'hi' }];
assert.ok(T.isGeneral({ id: 'c1', messages: u }));
for (const c of [{ id: 'c2', todayKey: 'task:x', messages: u }, { id: 'c3', pageKey: 'page:portfolio', messages: u }, { id: 'c4', standing: {}, messages: u },
    { id: 'c5', private: true, messages: u }, { id: 'ephemeral_1', messages: u }, { id: 'c6', messages: [{ role: 'assistant', content: 'hello' }] }]) assert.ok(!T.isGeneral(c), c.id);
// A note handed off from a general chat says where it came from and links back.
const ho = T.senderTimeline({ id: 'sender:a', name: 'A', confirmed: true }, [], { messages: [{ role: 'assistant', content: 'Renewal is Nov 2.', timestamp: '2026-10-10T10:00:00Z', metadata: { handoff: { from: 'conv_9' } } }] });
assert.strictEqual(ho[0].about, 'From your chat with nenva');
assert.strictEqual(ho[0].handoff, 'conv_9');

// M7: a card with no thread of its own lands in nenva's, and so does every approval (Now shows none).
{
    const thing = c => c.thing;
    const cards = [{ key: 'a', thing: 'matter:x' }, { key: 'b', thing: 'task:y' }, { key: 'c', thing: 'sender:z' }, { key: 'd', thing: 'money:cash' },
        { key: 'e', thing: 'trip:t1' }, { key: 'f', thing: 'event:ev1' }, { key: 'g', thing: 'event:ev2' }, { key: 'h', thing: 'ask:1', kind: 'approval' }];
    assert.deepStrictEqual(T.homeless(cards, thing, id => id === 'ev1').map(c => c.key), ['d', 'e', 'g', 'h']);
    // M8: a routine attached to a thing has its card there, not in nenva's.
    const rc = [{ key: 'r', thing: 'routine:r1' }, { key: 'r2', thing: 'routine:r2' }];
    assert.deepStrictEqual(T.homeless(rc, thing, () => false, id => id === 'r1').map(c => c.key), ['r2']);
    // A routine's plain post names its routine; a job from a thing's chat is reported in that thread.
    assert.deepStrictEqual(T.homeless([{ key: 'p', thing: 'post:x', routineOf: 'r1' }, { key: 'j', thing: 'job:1', job: '1' }, { key: 'j2', thing: 'job:2', job: '2' }],
        thing, () => false, id => id === 'r1', id => id === '1').map(c => c.key), ['j2']);
}
// M7: pins lead the list, in pin order; a pinned thing in a sender pins the sender; one not listed gets a row.
{
    const rows = [{ key: 'matter:a' }, { key: 'sender:s', members: ['task:p2'] }, { key: 'task:p1' }];
    const out = T.pinnedFirst(rows, ['task:p1', 'task:p2', 'task:p3', 'task:p9'], k => (k === 'task:p3' ? { key: 'task:p3' } : null));
    assert.deepStrictEqual(out.pinned.map(r => r.key), ['task:p1', 'sender:s', 'task:p3']);
    assert.ok(out.pinned.every(r => r.pin));
    assert.deepStrictEqual(out.rest.map(r => r.key), ['matter:a']);
}

// The list's width (by request): held inside its bounds, a bad value is the default.
assert.strictEqual(T.clampWidth(100), T.LIST_W.min);
assert.strictEqual(T.clampWidth(9999), T.LIST_W.max);
assert.strictEqual(T.clampWidth('400'), 400);
assert.strictEqual(T.clampWidth('wide'), T.LIST_W.def);

// A reply stamped before the question it answers (an error path) still draws after it.
{
    const conv = { updatedAt: '2026-10-11T08:30:00Z', messages: [
        { role: 'user', content: 'What should I cook?', timestamp: '2026-10-11T08:28:10Z' },
        { role: 'assistant', content: 'Could not reach the model.', timestamp: '2026-10-11T08:28:05Z' }] };
    const out = T.senderTimeline({ id: 'nenva', builtIn: true }, [], conv).filter(x => x.kind === 'chat');
    assert.deepStrictEqual(out.map(x => x.side), ['me', 'them']);
}

// nenva says what it is reading (2026-10-11): Now's words, a done line once, nothing when quiet.
{
    const conn = Date.parse('2026-10-11T10:00:00Z');
    assert.deepStrictEqual(T.workState({ email: { reading: true, line: 'Reading your email · 40 to go' }, connectedAt: conn }), { busy: true, text: 'Reading your email · 40 to go' });
    assert.deepStrictEqual(T.workState({ email: { caughtUp: true }, connectedAt: conn, lastSync: 0 }), { busy: true, text: 'Getting your recent email…' }, 'connected, no sync yet: not "done"');
    assert.deepStrictEqual(T.workState({ email: { caughtUp: true }, connectedAt: conn, lastSync: conn + 5000 }), { busy: false, done: conn });
    assert.deepStrictEqual(T.workState({ email: { caughtUp: true }, connectedAt: conn, lastSync: conn + 5000, calendar: 'Reading your calendar…' }), { busy: true, text: 'Reading your calendar…' }, 'the calendar is still being read');
    assert.strictEqual(T.workState({ email: { reading: true, blocked: 'model' }, connectedAt: conn }), null, 'a blocked read is the fix card’s to say, never "reading"');
    assert.strictEqual(T.workState({}), null);
    assert.match(T.readDoneText(3), /keeping track of 3 things/);
    assert.match(T.readDoneText(1), /one thing/);
    assert.match(T.readDoneText(0), /Nothing in it needs you/);
}

console.log('threads-page-test: ok');
