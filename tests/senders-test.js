// Senders (js/core/senders.js, docs/SENDERS.md): the pure parts and the store.
const assert = require('assert');
let blob = null;
global.StorageManager = { get: () => blob, set: (_k, v) => { blob = JSON.parse(JSON.stringify(v)); } };
global.SenderKinds = require('../js/core/sender-kinds.js');
const S = require('../js/core/senders.js');
S._changed = () => {};

const now = Date.parse('2026-10-10T12:00:00Z');
const matters = [
    { id: 'matter:e1', kind: 'bill', state: 'open', title: 'GEICO auto renewal', status: 'Renews Nov 2', updatedAt: '2026-10-09T09:00:00Z',
        sources: [{ id: 'e1', kind: 'email', from: 'GEICO', summary: 'Your policy renews Nov 2 at $612' }] },
    { id: 'matter:e2', kind: 'other', state: 'done', title: 'Old receipt', updatedAt: '2026-01-01T09:00:00Z', sources: [] },
    { id: 'matter:s1', kind: 'other', state: 'open', title: 'Slack thing', updatedAt: '2026-10-09T09:00:00Z', sources: [{ id: 's', kind: 'slack' }] }
];
const commitments = [
    { id: 'c1', title: 'Lift weights', state: 'open', repeat: { rule: 'weekly' }, updatedAt: '2026-10-08T09:00:00Z' },
    { id: 'c2', title: 'Squat 3x5', state: 'open', parent: 'c1' },
    { id: 'c3', title: 'Pay GEICO', state: 'open', origin: { kind: 'matter', ref: 'matter:e1' } },
    { id: 'c4', title: 'Plan', state: 'open', origin: { kind: 'plan', ref: 'x' } },
    { id: 'c5', title: 'Done thing', state: 'done' }
];

// Eligible: open or recent matters, never Slack; top-level open commitments not made by a folder or a plan.
let items = S.eligible(matters, commitments, () => false, now);
assert.deepStrictEqual(items.map(i => i.key).sort(), ['matter:e1', 'task:c1']);
assert.ok(items.find(i => i.key === 'matter:e1').text.includes('GEICO'));
assert.deepStrictEqual(S.eligible(matters, commitments, k => k === 'task:c1', now).map(i => i.key), ['matter:e1']);

// The prompt names every item and every shown sender by label.
const shown = [{ id: 'sender:dental', name: 'Your dental', allGood: 'Cleanings on time.', holds: ['Cleaning Oct 14'] }];
const p = S.prompt(items, shown, now);
assert.ok(p.includes('- Your dental') && p.includes('[I1]') && p.includes('[I2]') && p.includes('TOO BIG'));

// Vet: labels it was shown only; each item once; no invented numbers; a "new" with a shown name joins it.
const vetted = S.vet({ placements: [
    { item: 'I1', new: 'Auto insurance', all_good: 'Covered, paid, the renewal not missed.' },
    { item: 'I1', sender: 'S1' },                       // second answer for one item: dropped
    { item: 'I2', new: 'Build muscle 5000', all_good: 'x' }, // a number the items lack: dropped
    { item: 'I9', sender: 'S1' },                       // no such item
    { item: 'I2', sender: 'S7' }                        // no such sender
] }, items, shown);
assert.deepStrictEqual(vetted, [{ key: items[0].key, new: { name: 'Auto insurance', allGood: 'Covered, paid, the renewal not missed.' } }]);
assert.deepStrictEqual(S.vet({ placements: [{ item: '[I2]', new: 'your  DENTAL' }] }, items, shown), [{ key: items[1].key, sender: 'sender:dental' }]);
assert.deepStrictEqual(S.vet(null, items, shown), []);
// A name written in "sender" (a small model's habit) is a new sender, or the shown one it names.
assert.deepStrictEqual(S.vet({ placements: [{ item: 'I1', sender: 'Auto insurance', all_good: 'Covered.' }, { item: 'I2', sender: 'Your dental' }] }, items, shown),
    [{ key: items[0].key, new: { name: 'Auto insurance', allGood: 'Covered.' } }, { key: items[1].key, sender: 'sender:dental' }]);

// Who the mail is from is a fact: joined per matter (domain), shown per sender, compared by `argues`.
const google = { id: 'matter:g1', kind: 'other', state: 'open', title: 'Mark OAuth clients as agentic', status: 'By Nov 11', updatedAt: '2026-10-09T10:00:00Z',
    sources: [{ id: 'g', kind: 'email', at: '2026-10-09T10:00:00Z', from: 'The Google Workspace Team', address: 'workspace-noreply@google.com', summary: 'Mark your OAuth clients as agentic' }] };
const claude = { id: 'matter:a1', kind: 'other', state: 'open', title: 'API key expiring', updatedAt: '2026-10-08T10:00:00Z',
    sources: [{ id: 'a', kind: 'email', at: '2026-10-08T10:00:00Z', from: 'Anthropic', address: 'support@mail.anthropic.com', summary: 'Your key expires' },
        { id: 'a0', kind: 'email', at: '2026-10-01T10:00:00Z', from: 'Anthropic', address: 'billing@anthropic.com', summary: 'Receipt' }] };
assert.deepStrictEqual(S.counterparties([claude]), [{ name: 'Anthropic', key: 'anthropic.com' }]);
assert.strictEqual(S._domain('x@news.bbc.co.uk'), 'bbc.co.uk');
assert.strictEqual(S._domain('+14155551212'), '');
assert.deepStrictEqual(S.counterparties([{ sources: [{ id: 't', kind: 'imessage', from: 'Dr. Lee', address: '+14155551212' }] }]), [{ name: 'Dr. Lee', key: '+14155551212' }]);
assert.deepStrictEqual(S.counterparties([matters[0]]), [], 'a display name with no address is not a counterparty');
assert.ok(S.eligible(matters, [], () => false, now)[0].text.includes('— from GEICO:'), 'the name still shows on the item');
const gItem = S.eligible([google], [], () => false, now)[0];
assert.ok(gItem.text.includes('from The Google Workspace Team (google.com)'), gItem.text);
assert.deepStrictEqual(gItem.from, { name: 'The Google Workspace Team', key: 'google.com' });
const anth = { id: 'sender:anth', name: 'Anthropic account', allGood: 'Every Anthropic message has been read.', holds: ['API key expiring'], from: S.counterparties([claude]) };
const shownWithFrom = S.shown({ senders: { 'sender:anth': { id: 'sender:anth', name: 'Anthropic account', allGood: 'x', updatedAt: 'x' } } }, () => ['API key expiring'], 40, () => S.counterparties([claude]));
assert.deepStrictEqual(shownWithFrom[0].from, [{ name: 'Anthropic', key: 'anthropic.com' }]);
assert.ok(S.prompt([gItem], shownWithFrom, now).includes('- Anthropic account — all good: x — mail from: Anthropic (anthropic.com) — holds:'));
const why = S.argues(gItem, anth);
assert.strictEqual(why, 'its mail comes from Anthropic (anthropic.com); this is from The Google Workspace Team (google.com)');
assert.strictEqual(S.argues(gItem, { ...anth, from: [{ name: 'Google', key: 'google.com' }] }), '', 'a shared domain never argues');
assert.strictEqual(S.argues(gItem, { ...anth, from: [] }), '', 'a sender with no mail never argues');
assert.strictEqual(S.argues(items[1], anth), '', 'a commitment never argues');
assert.strictEqual(S.argues({ ...gItem, from: null }, anth), '');
const sp = S.samePrompt(gItem, anth, why);
assert.ok(sp.includes('THE THREAD: Anthropic account') && sp.includes('mail from: Anthropic (anthropic.com)') && sp.includes(gItem.text) && sp.includes('Note: its mail comes from'));
// The re-judge: the refused sender is named on the item, and an answer naming it again is dropped (by name or label).
const not = { 'matter:g1': { id: 'sender:anth', name: 'Anthropic account', why } };
assert.ok(S.prompt([gItem], shownWithFrom, now, not).includes('(NOT "Anthropic account": its mail comes from'));
assert.deepStrictEqual(S.vet({ placements: [{ item: 'I1', sender: 'Anthropic account' }] }, [gItem], shownWithFrom, not), []);
assert.deepStrictEqual(S.vet({ placements: [{ item: 'I1', sender: 'S1' }] }, [gItem], shownWithFrom, not), []);
assert.deepStrictEqual(S.vet({ placements: [{ item: 'I1', sender: 'Google Cloud for anjadhe.ai', all_good: 'Set up and current.' }] }, [gItem], shownWithFrom, not),
    [{ key: 'matter:g1', new: { name: 'Google Cloud for anjadhe.ai', allGood: 'Set up and current.' } }]);
assert.deepStrictEqual(S.vet({ placements: [{ item: 'I1', sender: 'Anthropic account' }] }, [gItem], shownWithFrom), [{ key: 'matter:g1', sender: 'sender:anth' }], 'without a refusal the name joins');
// "Reminders" is final for a matter too, and always the built-in thread, even beside a stored sender of that name.
assert.deepStrictEqual(S.vet({ placements: [{ item: 'I1', sender: 'Reminders' }] }, [gItem], shownWithFrom), [{ key: 'matter:g1', reminders: true }]);
assert.deepStrictEqual(S.vet({ placements: [{ item: 'I2', sender: 'Reminders' }] }, items, [{ id: 'sender:stored-rem', name: 'Reminders', allGood: '', holds: [] }]), [{ key: 'task:c1', reminders: true }]);
// A cleared placement (null, the sync contract's explicit clearing) is never overridden by the judgment.
{ const dc = S.empty(); dc.place['task:c1'] = null; S.apply(dc, [{ key: 'task:c1', new: { name: 'Gym' } }]); assert.strictEqual(dc.place['task:c1'], null); assert.ok(S.cleared(dc, 'task:c1')); assert.ok(!S.cleared(dc, 'task:zz')); }

// Apply: two "new" answers with one name are one sender; it is unconfirmed (S3); the person's own placement is never re-judged.
const d = S.empty();
d.place['task:c9'] = { sender: 'sender:x', by: 'you', at: 'x' };
const r = S.apply(d, [{ key: 'matter:e1', new: { name: 'Auto insurance', allGood: 'Covered.' } }, { key: 'matter:e9', new: { name: 'auto insurance!', allGood: '' } },
    { key: 'task:c9', new: { name: 'Elsewhere' } }], now);
assert.strictEqual(r.created.length, 1);
const auto = d.senders[r.created[0]];
assert.strictEqual(auto.name, 'Auto insurance');
assert.strictEqual(auto.confirmed, false);
assert.strictEqual(d.place['matter:e1'].sender, auto.id);
assert.strictEqual(d.place['matter:e9'].sender, auto.id);
assert.strictEqual(d.place['task:c9'].sender, 'sender:x');

// senderOf: a folder through its joins; a task from a folder takes the folder's sender; a step takes its parent's.
d.senders['sender:gym'] = { id: 'sender:gym', name: 'Build muscle', state: 'active' };
d.place['task:c1'] = { sender: 'sender:gym', by: 'nenva' };
const byId = Object.fromEntries(commitments.map(c => [c.id, c]));
const ctx = { matterOf: k => (k === 'matter:old' ? { id: 'matter:e1' } : matters.find(m => m.id === k) || null), commitment: id => byId[id] || null,
    folderOfTask: id => (id === 'c7' ? { id: 'matter:e1' } : null) };
assert.strictEqual(S.senderOfIn(d, 'matter:e1', ctx), auto.id);
assert.strictEqual(S.senderOfIn(d, 'matter:old', ctx), auto.id);
assert.strictEqual(S.senderOfIn(d, 'task:c3', ctx), auto.id);
assert.strictEqual(S.senderOfIn(d, 'task:c2', ctx), 'sender:gym');
byId.c7 = { id: 'c7', title: 'Call agent', state: 'open' };
assert.strictEqual(S.senderOfIn(d, 'task:c7', ctx), auto.id);
assert.strictEqual(S.senderOfIn(d, 'task:c5', ctx), null);

// The store: create, move (with undo), fold (with unfold, and placements follow the alias), archive.
blob = null; S._data = null;
global.Matters = { get: k => matters.find(m => m.id === k) || null, all: () => matters };
global.Commitments = { get: id => byId[id] || null, all: () => commitments };
const a = S.create('Auto insurance', 'Covered.');
assert.strictEqual(a.confirmed, true);
assert.strictEqual(S.create('auto insurance').id, a.id);
const b = S.create('Car insurance');
const mv = S.move('matter:e1', b.id);
assert.strictEqual(S.senderOf('matter:e1'), b.id);
assert.strictEqual(S.senderOf('task:c3'), b.id);
S.fold(b.id, a.id);
assert.strictEqual(S.senderOf('matter:e1'), a.id);
assert.strictEqual(S.get(b.id).id, a.id);
assert.ok(S.unfold(b.id));
assert.strictEqual(S.senderOf('matter:e1'), b.id);
S.unmove('matter:e1', mv.before);
assert.strictEqual(S.senderOf('matter:e1'), null);
assert.ok(!Object.hasOwn(S._load().place, 'matter:e1'), 'undoing the first move leaves no record');
// Back to Reminders (2026-10-12): a to-do moved to the built-in Reminders has its placement cleared, never re-judged, with Undo.
S.move('task:c1', b.id);
assert.strictEqual(S.senderOf('task:c1'), b.id);
const rel = S.move('task:c1', S.REMINDERS);
assert.strictEqual(rel.before.sender, b.id);
assert.strictEqual(S.senderOf('task:c1'), null);
assert.strictEqual(S._load().place['task:c1'], null);
assert.strictEqual(S._load().tries['task:c1'], S.TRIES_MAX);
assert.deepStrictEqual(S.keysOf(b.id), [], 'a cleared placement is in no sender');
assert.strictEqual(S.move('matter:e1', S.REMINDERS), null, 'a folder from mail is never a reminder');
S.unmove('task:c1', rel.before);
assert.strictEqual(S.senderOf('task:c1'), b.id);
S.move('task:c1', S.REMINDERS);
S.unmove('task:c1', S.move('task:c1', a.id).before);
assert.strictEqual(S._load().place['task:c1'], null, 'undoing a move from Reminders clears it again');
delete S._load().place['task:c1']; delete S._load().tries['task:c1'];
S.archive(a.id);
assert.ok(!S.all().some(s => s.id === a.id));
assert.ok(S.all({ archived: true }).some(s => s.id === a.id));
assert.strictEqual(S.get('nenva').builtIn, true);

// What the person told nenva about it (M5): same text confirms, same subject replaces, undo, forget, fold carries.
const ins = S.create('Home insurance');
const k1 = S.keepFact(ins.id, { text: 'Agent is Rob.', subject: 'agent', quote: 'agent is Rob' });
assert.strictEqual(k1.status, 'saved');
assert.strictEqual(S.keepFact(ins.id, { text: 'agent is rob' }).status, 'confirmed');
const k2 = S.keepFact(ins.id, { text: 'Agent is Dana.', subject: 'Agent' });
assert.strictEqual(k2.status, 'updated');
assert.strictEqual(k2.before.text, 'Agent is Rob.');
assert.deepStrictEqual(S.factsOf(ins.id).map(f => f.text), ['Agent is Dana.']);
assert.ok(S.undoFact(ins.id, { fact: k2.fact, before: k2.before }));
assert.deepStrictEqual(S.factsOf(ins.id).map(f => f.text), ['Agent is Rob.']);
const k3 = S.keepFact(ins.id, { text: 'Policy HO-3.', subject: 'policy' });
assert.ok(S.undoFact(ins.id, { fact: k3.fact }));
assert.strictEqual(S.factsOf(ins.id).length, 1);

// Links (M8): a document or a routine attaches to one thing; fold carries them; unfold takes them back.
const car = S.create('Car upkeep');
const garage = S.create('Garage');
assert.strictEqual(S.link(car.id, { kind: 'doc', ref: 'd1', title: 'Manual' }).added, true);
assert.strictEqual(S.link(car.id, { kind: 'doc', ref: 'd1' }).added, false);
assert.strictEqual(S.link(car.id, { kind: 'note', ref: 'n1' }), null);
assert.strictEqual(S.holderOf('doc', 'd1'), car.id);
S.link(garage.id, { kind: 'doc', ref: 'd1', title: 'Manual' });
assert.strictEqual(S.holderOf('doc', 'd1'), garage.id, 'one home: attaching moves it');
assert.strictEqual(S.linksOf(car.id).length, 0);
S.link(car.id, { kind: 'routine', ref: 'r1', title: 'Recall check' });
S.fold(car.id, garage.id);
assert.deepStrictEqual(S.linksOf(garage.id).map(l => l.ref).sort(), ['d1', 'r1']);
S.unfold(car.id);
assert.deepStrictEqual(S.linksOf(garage.id).map(l => l.ref), ['d1']);
assert.strictEqual(S.unlink(garage.id, 'doc', 'd1').title, 'Manual');
assert.strictEqual(S.holderOf('doc', 'd1'), null);
const gone = S.forgetFact(ins.id, k1.fact.id);
assert.strictEqual(S.factsOf(ins.id).length, 0);
S.undoFact(ins.id, { forgotten: gone });
assert.strictEqual(S.factsOf(ins.id).length, 1);
assert.strictEqual(S.keepFact(ins.id, { text: '  ' }), null);
const house = S.create('House');
S.keepFact(house.id, { text: 'Roof replaced 2024.' });
S.fold(ins.id, house.id);
assert.deepStrictEqual(S.factsOf(house.id).map(f => f.text).sort(), ['Agent is Rob.', 'Roof replaced 2024.']);
S.unfold(ins.id);
assert.deepStrictEqual(S.factsOf(house.id).map(f => f.text), ['Roof replaced 2024.']);
assert.strictEqual(S.factsOf(ins.id).length, 1);
assert.ok(blob && blob.version === 1);


// ThingCapture T6: which member a sender's turn is about, when a fact decides it.
const TC = require('../js/agent/thing-capture.js');
assert.strictEqual(TC.thingOf({ todayKey: 'sender:auto-x' }).type, 'sender');
const mem = [{ key: 'matter:a', open: true }, { key: 'task:b', open: false }, { key: 'task:c', open: true }];
assert.deepStrictEqual(TC.pickFor({}, mem.slice(0, 2), now), { key: 'matter:a' });                  // only one open
assert.deepStrictEqual(TC.pickFor({}, mem, now), { ask: ['matter:a', 'task:c'] });                  // the model picks
assert.deepStrictEqual(TC.pickFor({ focus: { key: 'task:b', at: now - 60000 } }, mem, now), { key: 'task:b' });   // written from its box
assert.deepStrictEqual(TC.pickFor({ focus: { key: 'task:b', at: now - 3600000 } }, mem, now), { ask: ['matter:a', 'task:c'] }); // stale focus
assert.strictEqual(TC.pickFor({}, [{ key: 'task:b', open: false }], now), null);

// The sweep: batches until nothing is left, unanswered items are retried then left alone.
(async () => {
    blob = null; S._data = null;
    global.AgentService = { model: 'm', numCtx: 8192 };
    let calls = 0;
    global.LLMLogger = { call: async (_tag, prm) => {
        calls++;
        const body = prm.messages[1].content;
        const labels = [...body.matchAll(/\[I(\d+)\] (.*)/g)];
        // Answer only the GEICO item; leave the gym one unanswered.
        const placements = labels.filter(l => l[2].includes('GEICO')).map(l => ({ item: `I${l[1]}`, new: 'Auto insurance', all_good: 'Covered and paid.' }));
        return { message: { content: JSON.stringify({ placements }) } };
    } };
    const out = await S.sweep({ now });
    assert.strictEqual(out.placed, 1);
    assert.strictEqual(S.all()[0].name, 'Auto insurance');
    assert.strictEqual(S.senderOf('task:c3'), S.all()[0].id);
    assert.strictEqual(calls, 1);   // one try per item per sweep
    assert.strictEqual(S._load().tries['task:c1'], 1);
    await S.sweep({ now }); await S.sweep({ now }); await S.sweep({ now });
    assert.strictEqual(calls, S.TRIES_MAX);   // then left alone (it shows as its own row, as before senders)
    assert.strictEqual(S._load().tries['task:c1'], S.TRIES_MAX);

    // The narrow look: the judgment joins the Google notice to the Anthropic sender, the facts argue
    // (anthropic.com vs google.com), one question says "different", and the re-judge with that sender
    // refused makes a sender of its own. Three calls; the Anthropic sender is untouched.
    blob = null; S._data = null; calls = 0;
    const prompts = [];
    global.Matters = { get: k => [claude, google].find(m => m.id === k) || null, all: () => [claude, google], forAmbient: () => [claude, google] };
    global.Commitments = { get: () => null, all: () => [] };
    const anthS = S.create('Anthropic account', 'Every Anthropic message has been read.');
    S.move('matter:a1', anthS.id);
    global.LLMLogger = { call: async (_tag, prm) => {
        calls++;
        const body = prm.messages[1].content;
        prompts.push(body);
        if (body.startsWith('You keep one thread')) return { message: { content: '{"same": false}' } };
        if (body.includes('(NOT "Anthropic account"')) return { message: { content: JSON.stringify({ placements: [{ item: 'I1', sender: 'Google Cloud for anjadhe.ai', all_good: 'Set up, current and nothing to change.' }] }) } };
        return { message: { content: JSON.stringify({ placements: [{ item: 'I1', sender: 'Anthropic account' }] }) } };
    } };
    const nar = await S.sweep({ now });
    assert.strictEqual(calls, 3);
    assert.ok(prompts[0].includes('- Anthropic account — all good: Every Anthropic message has been read. — mail from: Anthropic (anthropic.com) — holds: "API key expiring"'), prompts[0]);
    assert.ok(prompts[1].includes('Note: its mail comes from Anthropic (anthropic.com); this is from The Google Workspace Team (google.com)'));
    assert.strictEqual(nar.placed, 1);
    assert.strictEqual(S.get(S.senderOf('matter:g1')).name, 'Google Cloud for anjadhe.ai');
    assert.deepStrictEqual(S.members(anthS.id), ['matter:a1']);
    // The same question answered "same" keeps the judgment's placement, in two calls.
    blob = null; S._data = null; calls = 0;
    const anth2 = S.create('Anthropic account', 'x'); S.move('matter:a1', anth2.id);
    global.LLMLogger.call = async (_tag, prm) => { calls++; const body = prm.messages[1].content; return { message: { content: body.startsWith('You keep one thread') ? '{"same": true}' : JSON.stringify({ placements: [{ item: 'I1', sender: 'Anthropic account' }] }) } }; };
    await S.sweep({ now });
    assert.strictEqual(calls, 2);
    assert.strictEqual(S.senderOf('matter:g1'), anth2.id);
    console.log('senders-test: ok');
})().catch(e => { console.error(e); process.exit(1); });
