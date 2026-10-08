// ClaimCheck: the model lists what a reply says is already true; code
// decides what nothing supports. These pin code's half.
const assert = require('assert');
const CC = require('../js/agent/claim-check.js');

const write = (ok = true) => ({ tool: 'change_commitment', ok, readOnly: false, error: ok ? null : 'cancelled' });
const read = { tool: 'list_commitments', ok: true, readOnly: true };
const is = (text, day, time, about = true) => ({ text, kind: 'is', about_this: about, day, time });
const did = (text) => ({ text, kind: 'did', about_this: false, day: null, time: null });

// V5: which turns are looked at.
assert.ok(CC.worthLooking({ reply: "It's set for 9:00 AM tomorrow.", canWrite: true, ran: [] }));
assert.ok(CC.worthLooking({ reply: 'Done, moved to Friday.', canWrite: true, ran: [write(false)] }));
assert.ok(!CC.worthLooking({ reply: 'Moved to Friday at 9.', canWrite: true, ran: [write(true)] }), 'every write succeeded');
assert.ok(!CC.worthLooking({ reply: 'Canberra is the capital.', canWrite: false, ran: [] }), 'nothing could have been changed');
assert.ok(CC.worthLooking({ reply: 'Your visit is on Thursday.', canWrite: true, ran: [read] }));
assert.ok(CC.worthLooking({ reply: 'Moved to Friday at 9.', canWrite: true, ran: [write(true)], tied: true }), 'V6: a chat tied to a commitment is checked after a change too');

// V6: after a change that succeeded, a clock the record does not hold for that day is unbacked.
{
    const reply = 'Workout B now sits at 6:30 PM today. Next Monday it\'s back at 8:45 AM.';
    const raw = { claims: [is('Workout B now sits at 6:30 PM today.', '2026-10-05', '18:30'), is('Next Monday it\'s back at 8:45 AM.', '2026-10-12', '08:45')] };
    const series = { date: '2026-10-05', time: '18:30', at: d => (d === '2026-10-05' || d === '2026-10-12' ? { time: '18:30' } : null) };   // every Monday moved
    assert.deepStrictEqual(CC.vet(raw, reply, { ran: [write(true)], standing: series }).unbacked, ['Next Monday it\'s back at 8:45 AM.']);
    const oneDay = { date: '2026-10-05', time: '18:30', at: d => (d === '2026-10-05' ? { time: '18:30' } : d === '2026-10-12' ? { time: '08:45' } : null) };
    assert.deepStrictEqual(CC.vet(raw, reply, { ran: [write(true)], standing: oneDay }).unbacked, [], 'one day moved: both sentences are what the record shows');
    assert.deepStrictEqual(CC.vet({ claims: [did('Done, I moved it.')] }, 'Done, I moved it.', { ran: [write(true)], standing: series }).unbacked, [], 'the change itself was made');
    // With no change, a later day it really happens on is not "the wrong day".
    assert.deepStrictEqual(CC.vet({ claims: [is('Next Monday it\'s back at 8:45 AM.', '2026-10-12', '08:45')] }, reply, { ran: [], standing: oneDay }).unbacked, []);
    assert.match(CC.nudge(['x'], { ran: [write(true)], standingText: 'Repeats: weekly' }), /further than the person asked/);
}

// The report: set for tomorrow, the record says today, nothing ran.
{
    const reply = "It's set for 9:00 AM tomorrow.";
    const raw = { claims: [is(reply, '2026-10-06', '09:00')] };
    assert.deepStrictEqual(CC.vet(raw, reply, { ran: [], standing: { date: '2026-10-05', time: '09:00' } }).unbacked, [reply]);
    assert.deepStrictEqual(CC.vet(raw, reply, { ran: [], standing: { date: '2026-10-06', time: '09:00' } }).unbacked, [], 'the record already shows it');
    assert.deepStrictEqual(CC.vet(raw, reply, { ran: [], standing: { date: '2026-10-06', time: '10:00' } }).unbacked, [reply], 'right day, wrong time');
    assert.deepStrictEqual(CC.vet(raw, reply, { ran: [write(true)], standing: { date: '2026-10-05', time: '09:00' } }).unbacked, [], 'a change succeeded this turn');
    assert.deepStrictEqual(CC.vet(raw, reply, { ran: [], standing: null }).unbacked, [], 'no record to hold a state to');
}

// "did" needs a change that succeeded.
{
    const reply = "I've added milk to your shopping list.";
    assert.deepStrictEqual(CC.vet({ claims: [did(reply)] }, reply, { ran: [] }).unbacked, [reply]);
    assert.deepStrictEqual(CC.vet({ claims: [did(reply)] }, reply, { ran: [read] }).unbacked, [reply], 'a read is not a change');
    assert.deepStrictEqual(CC.vet({ claims: [did(reply)] }, reply, { ran: [write(false)] }).unbacked, [reply], 'a declined change is not a change');
    assert.deepStrictEqual(CC.vet({ claims: [did(reply)] }, reply, { ran: [write(true)] }).unbacked, []);
}

// A day read about something else is let through; without a read it is about this chat's thing.
{
    const reply = 'Your gym session is on Friday at 6:00 PM.';
    const raw = { claims: [is(reply, '2026-10-09', '18:00', false)] };
    const st = { date: '2026-10-05', time: '09:00' };
    assert.deepStrictEqual(CC.vet(raw, reply, { ran: [read], standing: st }).unbacked, []);
    assert.deepStrictEqual(CC.vet(raw, reply, { ran: [], standing: st }).unbacked, [reply]);
}

// V3: the reader is checked too.
{
    const reply = 'Want me to move it to tomorrow?';
    assert.deepStrictEqual(CC.vet({ claims: [did('I moved it to tomorrow.')] }, reply, { ran: [] }).unbacked, [], 'not the reply\'s words');
    assert.strictEqual(CC.vet(null, reply).ok, false);
    assert.strictEqual(CC.vet({ claims: 'no' }, reply).ok, false);
    assert.deepStrictEqual(CC.vet({ claims: [] }, reply), { unbacked: [], ok: true });
    assert.deepStrictEqual(CC.parse('```json\n{"claims": []}\n```'), { claims: [] });
    assert.strictEqual(CC.parse('sorry'), null);
}

// The days are code's: today and tomorrow are named.
{
    const t = CC.dayTable(new Date('2026-10-05T12:00:00').getTime()).join('\n');
    assert.ok(/2026-10-05 = Monday, October 5 = TODAY/.test(t) && /2026-10-06 = Tuesday, October 6 = tomorrow/.test(t));
    assert.ok(CC.prompt({ reply: 'x', thing: 'Log weight' }).includes('THE THING: Log weight'));
    assert.ok(CC.nudge(['It is set.'], { ran: [] }).includes('no change was made'));
}

// A failing reader never blocks a turn.
(async () => {
    const r = await CC.look({ reply: "I've sent it.", ran: [] }, async () => ({ error: 'offline' }));
    assert.deepStrictEqual(r.unbacked, []);
    const r2 = await CC.look({ reply: "I've sent it.", ran: [] }, async () => ({ message: { content: '{"claims":[{"text":"I\'ve sent it.","kind":"did"}]}' } }));
    assert.deepStrictEqual(r2.unbacked, ["I've sent it."]);
    console.log('claim-check-test: ok');
})();
