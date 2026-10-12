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
// In Reminders every to-do is captioned, alone or not, and a member's caption is the door to its page (2026-10-12).
const rem = T.senderTimeline({ id: 'sender:reminders', name: 'Reminders', builtIn: true, confirmed: true }, [tB], null);
assert.ok(T.events(rem).length && T.events(rem).every(x => x.about === 'Print ID cards' && x.member === 'task:c1'));
assert.strictEqual(T.captionHtml(rem[0]), '<button type="button" class="th-about th-about-item" data-th="item" data-key="task:c1" title="Open">Print ID cards</button>');
assert.strictEqual(T.captionHtml(rem[0], 'Print ID cards'), '', 'only when it changes');
assert.strictEqual(T.captionHtml({ about: 'From your chat with nenva', handoff: 'conv_9' }), '<button type="button" class="th-about th-about-link" data-th="nenva-pick" data-id="conv_9">From your chat with nenva</button>');
assert.strictEqual(T.captionHtml({ about: 'Routine', member: 'routine:r1' }), '<div class="th-about">Routine</div>');
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

// The day at the top of nenva's thread (2026-10-11, Threads is home): Today's rows
// with their help, then Coming up folded; open, the next thing, the week strip
// and a tapped day's rows. Pure over SimpleExperience.schedule()'s shape.
{
    const sched = {
        today: [
            { title: 'Standup', time: '10:00 AM', open: { url: 'https://cal/x' }, help: { line: 'Join link ready', live: true } },
            { title: 'Pay the water bill', time: '', open: { matter: 'matter:w' }, help: { line: 'Due today', attn: true } },
            { title: '<b>Odd</b>', time: '', open: null }
        ],
        todayLine: 'Two things today.',
        flat: [{ title: 'Dentist', time: '9:00 AM', date: '2026-10-12', open: { matter: 'matter:d' } }],
        week: { total: 1, next: { index: 0, title: 'Dentist', when: 'Tomorrow · 9:00 AM' },
            days: [{ date: '2026-10-12', dow: 'Tmrw', num: 12, count: 1 }, { date: '2026-10-13', dow: 'Tue', num: 13, count: 0 }] }
    };
    // Folded by default: one heading with the count and the day line, nothing else.
    const closed = T.dayHtml(sched, {});
    assert.ok(/data-th="day-toggle" aria-expanded="false"/.test(closed) && /th-day-count">3</.test(closed) && /Two things today\./.test(closed));
    assert.ok(!/th-day-row/.test(closed) && !/coming-toggle/.test(closed), 'closed, the day shows no rows and no Coming up');
    assert.ok(/A clear day\./.test(T.dayHtml({ today: [], todayLine: '', flat: [], week: null }, {})), 'a clear day says so on the heading');
    // What nenva is reading is on the heading, with its ring (not a bubble in the thread).
    const reading = T.dayHtml(sched, {}, { busy: true, text: 'Reading your email · 37 to go' });
    assert.ok(/th-day-work"><span class="th-busy"[^>]*><\/span>Reading your email · 37 to go/.test(reading));
    assert.ok(!/th-day-work/.test(T.dayHtml(sched, {}, { busy: false, done: 1 })), 'a finished read is not a status');
    const folded = T.dayHtml(sched, { _dayOpen: true });
    assert.ok(/aria-expanded="true"/.test(folded) && /Two things today\./.test(folded));
    assert.ok(/data-th="day-open" data-i="0"[^>]*>Standup</.test(folded), 'a row with a door is a button into it');
    assert.ok(/Anytime/.test(folded), 'an untimed row reads Anytime');
    assert.ok(/th-day-help is-attn">Due today/.test(folded), 'help that needs the person is marked');
    assert.ok(/&lt;b&gt;Odd/.test(folded) && !/<b>Odd/.test(folded), 'titles are text, never markup');
    assert.ok(/<span class="th-day-title">&lt;b&gt;Odd/.test(folded), 'a row with no door is plain text');
    assert.ok(/data-th="coming-toggle" aria-expanded="false"/.test(folded) && !/th-week-day/.test(folded), 'Coming up folds to its heading');
    assert.ok(/th-coming-count">1</.test(folded));
    const open = T.dayHtml(sched, { _dayOpen: true, _comingOpen: true, _comingDay: '2026-10-13' });
    assert.ok(/Tomorrow · 9:00 AM/.test(open) && /data-th="coming-open" data-i="0"/.test(open), 'the next thing, as a door');
    assert.strictEqual((open.match(/th-week-day/g) || []).length, 2);
    assert.ok(/is-clear/.test(open), 'a quiet day sits on the ground');
    assert.ok(/Nothing on Tuesday\./.test(open), 'an open quiet day says so');
    const openDay = T.dayHtml(sched, { _dayOpen: true, _comingOpen: true, _comingDay: '2026-10-12' });
    assert.ok(/th-coming-rows/.test(openDay) && /All day|9:00 AM/.test(openDay));
    // More than DAY_SHOW rows fold behind "N more today".
    const many = { ...sched, today: Array.from({ length: 7 }, (_, i) => ({ title: `T${i}`, time: '' })) };
    assert.ok(/2 more today/.test(T.dayHtml(many, { _dayOpen: true })) && !/>T6</.test(T.dayHtml(many, { _dayOpen: true })));
    assert.ok(/>T6</.test(T.dayHtml(many, { _dayOpen: true, _dayMore: true })) && /Show less/.test(T.dayHtml(many, { _dayOpen: true, _dayMore: true })));
    assert.strictEqual(T.dayHtml(null, {}), '', 'no schedule, no block');
    assert.ok(/A clear day\./.test(T.dayHtml({ today: [], flat: [], week: null }, { _dayOpen: true })));
}
console.log('threads-page-test: the day at the top of nenva’s thread ok');

// ── The list patches rows in place (2026-10-11) ──────────────────────────
// While mail is read every analysed message repaints the page; rebuilding
// the list replaced the row under the pointer (no click, a flickering
// delete button). A thread keeps its element across repaints.
{
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<div id="threads-view"><div class="th-rows" role="list"></div></div>');
    global.window = dom.window; global.document = dom.window.document;
    const page = Object.create(T);
    page._query = ''; page._open = 'nenva';
    const rows = (work) => [
        { key: 'nenva', title: 'nenva', at: '2026-10-11T09:00:00Z', pinned: true, avatar: 'nenva', items: [], working: work },
        { key: 'matter:e1', title: 'Water bill', at: '2026-10-10T09:00:00Z', avatar: 'bill', items: [] }];
    page._rows = rows({ text: 'Reading 3 of 40 emails' });
    page.renderList();
    const host = document.querySelector('.th-rows');
    const bill = host.querySelector('[data-id="matter:e1"]');
    const nenva = host.querySelector('[data-id="nenva"]');
    assert.ok(bill && nenva && host.children.length === 2);
    assert.ok(nenva.textContent.includes('Reading 3 of 40'));
    page._rows = rows({ text: 'Reading 4 of 40 emails' });
    page.renderList();
    assert.strictEqual(host.querySelector('[data-id="matter:e1"]'), bill, 'an unchanged row keeps its element');
    assert.strictEqual(host.querySelector('[data-id="nenva"]'), nenva, 'a changed row keeps its element too');
    assert.ok(nenva.textContent.includes('Reading 4 of 40'), 'and shows the change');
    // Opening another thread moves the class, not the node; a new thread lands in order; a gone one leaves.
    page._open = 'matter:e1';
    page._rows = [rows(null)[0], { key: 'matter:e2', title: 'Dentist', at: '2026-10-10T12:00:00Z', avatar: 'appointment', items: [] }, rows(null)[1]];
    page.renderList();
    assert.ok(bill.classList.contains('is-on') && !nenva.classList.contains('is-on'));
    assert.deepStrictEqual(Array.from(host.children).map(el => el.dataset.id), ['nenva', 'matter:e2', 'matter:e1']);
    page._rows = rows(null).slice(0, 1);
    page.renderList();
    assert.deepStrictEqual(Array.from(host.children).map(el => el.dataset.id), ['nenva']);
    page._rows = []; page.renderList();
    assert.ok(host.querySelector('.th-empty'));
    page._rows = rows(null); page.renderList();
    assert.ok(!host.querySelector('.th-empty') && host.children.length === 2, 'the empty line leaves when rows return');
    delete global.window; delete global.document;
}
// A commitment link from inside its own thread opens its page; from anywhere else, its thread (2026-10-12).
{
    const was = T.threadKeyOf;
    T.threadKeyOf = k => (k === 'task:todo' ? 'sender:reminders' : k === 'task:step' ? 'task:goal' : k);
    assert.strictEqual(T.doorFor('task:todo', 'sender:reminders'), 'page', 'a to-do from the Reminders drawer');
    assert.strictEqual(T.doorFor('task:step', 'task:goal'), 'page', 'a step from its goal\'s thread');
    assert.strictEqual(T.doorFor('task:goal', 'task:goal'), 'page', 'a thread\'s own commitment');
    assert.strictEqual(T.doorFor('task:todo', 'sender:auto'), 'thread', 'from another thread');
    assert.strictEqual(T.doorFor('task:todo', null), 'thread', 'off the page or in a sheet');
    T.threadKeyOf = was;
}
console.log('threads-page-test: rows patched in place ok');
