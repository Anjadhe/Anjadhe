#!/usr/bin/env node
/**
 * Instructions read by watchers that already exist (docs/ROUTINES_UX.md I2,
 * step 3): the pure helpers, the mail filer following one (a scripted
 * model), and the money coach's look carrying them.
 */
const assert = require('assert');
const I = require('../js/core/instructions.js');
global.Instructions = I;

const uspto = { id: 'r-uspto', title: 'USPTO watch', body: 'When the USPTO writes about my trademark, tell me right away.', when: null };
const sleeve = { id: 'r-sleeve', title: 'Core Growth bands', body: 'Tell me when a Core Growth sleeve leaves its band.', when: 'weekdays at 8:00 AM' };

// ── Pure ──
assert.deepEqual(I.lines([uspto, sleeve]), [
    '[I1] USPTO watch: When the USPTO writes about my trademark, tell me right away.',
    '[I2] Core Growth bands: Tell me when a Core Growth sleeve leaves its band. (asked for weekdays at 8:00 AM)']);
assert.equal(I.idOf('I2', [uspto, sleeve]), 'r-sleeve');
assert.equal(I.idOf('[I1]', [uspto, sleeve]), 'r-uspto');
assert.equal(I.idOf('I3', [uspto, sleeve]), null, 'a label it was not shown is nothing');
assert.equal(I.idOf(null, [uspto]), null);
assert.notEqual(I.signature([uspto]), I.signature([{ ...uspto, body: 'Only office actions.' }]), 'an edit changes the signature');

// ── forWatcher reads armed routines by their config ──
{
    const list = [
        { id: 'a', title: 'A', body: 'mail one', cfg: { offline: true, watcher: 'mail', trigger: { type: 'time', time: null } } },
        { id: 'b', title: 'B', body: 'money one', cfg: { offline: true, watcher: 'money', trigger: { type: 'time', time: '08:00' } } },
        { id: 'c', title: 'C', body: 'not armed', cfg: { offline: false, watcher: 'mail', trigger: { type: 'time' } } },
        { id: 'd', title: 'D', body: 'its own run', cfg: { offline: true, watcher: null, trigger: { type: 'time' } } }
    ];
    global.NotePrompts = { list: () => list, config: r => r.cfg, bodyText: r => r.body, scheduleLabel: () => 'daily at 8:00 AM' };
    assert.deepEqual(I.forWatcher('mail').map(x => x.id), ['a']);
    assert.deepEqual(I.forWatcher('money'), [{ id: 'b', title: 'B', body: 'money one', when: 'daily at 8:00 AM' }]);
    assert.deepEqual(I.forWatcher('news'), [], 'only the watchers that exist');
}

// ── The mail filer follows an instruction (Matters, with a scripted model) ──
(async () => {
    const recorded = [];
    I.forWatcher = (w) => (w === 'mail' ? [uspto] : []);
    I.record = (id, o) => { recorded.push({ id, ...o }); return {}; };
    let blob = null;
    global.StorageManager = { get: () => blob, set: (_k, v) => { blob = v; } };
    const M = require('../js/core/matters.js');
    let prompt = '';
    M._inference = async ({ params }) => {
        prompt = params.messages[1].content;
        return { message: { content: JSON.stringify({ about: 'new', kind: 'other', title: 'Trademark office action', status: 'Response due Jan 9', change: 'new',
            when: null, time: null, next: null, instruction: 'I1', tell: 'now' }) } };
    };
    const f = M.facts({ messageId: 'u1', from: 'TEAS <teas@uspto.gov>', subject: 'Office action on serial 98765432', bodyText: 'An office action was issued for your trademark application. Response due Jan 9.', date: '2026-10-09T10:00:00Z' },
        { summary: 'Office action issued' }, 'An office action was issued for your trademark application. Response due Jan 9.');
    const out = await M.observe(f);
    assert.match(prompt, /THEIR STANDING INSTRUCTIONS ABOUT MAIL AND TEXTS/);
    assert.match(prompt, /\[I1\] USPTO watch: When the USPTO writes about my trademark, tell me right away\./);
    assert.match(prompt, /"instruction": the label of the standing instruction/);
    assert.equal(out.j.instruction, 'r-uspto', 'the label maps back to the routine');
    assert.equal(out.j.tell, 'now');
    assert.equal(recorded.length, 1, 'the routine hears what was done');
    assert.equal(recorded[0].id, 'r-uspto');
    assert.equal(recorded[0].headline, 'Filed “Trademark office action”');
    assert.match(recorded[0].body, /Told you right away\./);

    // A label it was not shown is refused; with no instructions none is asked for.
    M._inference = async ({ params }) => { prompt = params.messages[1].content; return { message: { content: JSON.stringify({ about: 'new', kind: 'other', title: 'Second letter', status: 'x', change: 'new', instruction: 'I4', tell: 'file' }) } }; };
    const f2 = M.facts({ messageId: 'u2', from: 'TEAS <teas@uspto.gov>', subject: 'Notice', bodyText: 'A notice.', date: '2026-10-09T11:00:00Z' }, { summary: 'Notice' }, 'A notice.');
    const out2 = await M.observe(f2);
    assert.equal(out2.j.instruction, null);
    assert.equal(recorded.length, 1);
    I.forWatcher = () => [];
    const f3 = M.facts({ messageId: 'u3', from: 'Shop <a@shop.test>', subject: 'Receipt', bodyText: 'Paid $12.', date: '2026-10-09T12:00:00Z' }, { summary: 'Receipt' }, 'Paid $12.');
    await M.observe(f3);
    assert.doesNotMatch(prompt, /STANDING INSTRUCTIONS|"instruction"/, 'no instructions, no question about them');

    // ── The money coach carries them, and a focused look names the one whose time came ──
    I.forWatcher = (w) => (w === 'money' ? [sleeve] : []);
    global.MoneyFacts = { lines: () => ['Net worth $100,000.'] };
    const MC = require('../js/core/money-coach.js');
    const st = { figures: null, journal: [], notes: [], subjects: {}, lookedAt: 0 };
    let input = MC._input({}, st, new Date(2026, 9, 9, 8), MC._instructions());
    assert.match(input, /THEIR STANDING INSTRUCTIONS TO YOU/);
    assert.match(input, /\[I1\] Core Growth bands: Tell me when a Core Growth sleeve leaves its band\. \(asked for weekdays at 8:00 AM\)/);
    assert.doesNotMatch(input, /the one they asked for at its time/);
    input = MC._input({}, st, new Date(2026, 9, 9, 8), MC._instructions(), 'r-sleeve');
    assert.match(input, /This look is the one they asked for at its time by \[I1\]/);
    I.forWatcher = () => [];
    assert.doesNotMatch(MC._input({}, st, new Date(2026, 9, 9, 8), MC._instructions()), /STANDING INSTRUCTIONS/);
    const raiseTool = MC.TOOLS.find(t => t.function.name === 'raise');
    assert.ok(raiseTool.function.parameters.properties.instruction, 'a raise can name the instruction it answers');

    console.log('instructions: helpers, the mail filer and the money coach passed');
})().catch(e => { console.error(e); process.exit(1); });
