#!/usr/bin/env node
// MatterCapture (js/agent/matter-capture.js): what the person says in a chat
// tied to a folder reaches that folder. The checks on the assistant's answer
// are tested here; the judgment itself is the model's.
const assert = require('assert');
const C = require('../js/agent/matter-capture.js');
const NOW = Date.parse('2026-10-05T12:00:00');

const bill = { id: 'matter:w1', kind: 'bill', state: 'open', title: 'City Water bill', status: 'Due Oct 12', amount: '$41.00',
    when: { date: '2026-10-12', time: null }, next: { what: 'Pay $41.00', state: 'open' }, sources: [{ kind: 'email', summary: 'Amount due $41.00 by Oct 12' }] };

// Which call it is: a folder holding texts rides the stricter class.
assert.equal(C.sourceFor(bill), 'matter-chat');
assert.equal(C.sourceFor({ sources: [{ kind: 'email' }, { kind: 'imessage' }] }), 'matter-chat-text');

// The quote is the person's own words, or nothing is kept.
{
    const said = 'I paid that yesterday, all sorted';
    const j = C.vet({ change: 'done', quote: 'I paid that yesterday', status: 'Paid' }, bill, said, NOW);
    assert.deepEqual([j.about, j.change, j.status, j.tell, j.kind], ['matter:w1', 'done', 'Paid', 'file', 'bill']);
    assert.equal(j.note, 'You said: "I paid that yesterday"', 'the history keeps their words, not a rewrite');
    assert.equal(j.receipt, 'marked done');
    assert.equal(C.vet({ change: 'done', quote: 'The bill has been paid', status: 'Paid' }, bill, said, NOW), null, 'words they did not type');
    assert.equal(C.vet({ change: 'done', status: 'Paid' }, bill, said, NOW), null, 'no quote');
    assert.equal(C.vet({ change: 'none', quote: 'I paid that yesterday' }, bill, said, NOW), null);
    assert.equal(C.vet({ change: 'exploded', quote: 'I paid that yesterday' }, bill, said, NOW), null, 'an unknown answer is "none"');
    assert.equal(C.vet(null, bill, said, NOW), null);
    const closing = C.vet({ change: 'cancelled', quote: 'all sorted', when: '2026-10-20', next: { what: 'Call them' } }, bill, said, NOW);
    assert.deepEqual([closing.change, closing.when, closing.next, closing.receipt], ['cancelled', null, null, 'marked cancelled'], 'a closed thing gets no new date or step');
}
// A change must survive the checks to count.
{
    const said = 'they moved it, I now have to pay by the 20th and it went up to $48';
    const j = C.vet({ change: 'changed', quote: 'pay by the 20th', status: 'Due Oct 20, now $48', when: '2026-10-20', time: '25:00',
        next: { what: 'Pay $48', by: '2026-10-20', yours: true } }, bill, said, NOW);
    assert.deepEqual([j.change, j.status, j.when, j.time], ['changed', 'Due Oct 20, now $48', '2026-10-20', null]);
    assert.deepEqual([j.next.what, j.next.by, j.next.yours, j.next.how], ['Pay $48', '2026-10-20', true, 'none']);
    assert.equal(j.receipt, 'Due Oct 20, now $48');
    const invented = C.vet({ change: 'changed', quote: 'pay by the 20th', status: 'Now $55', next: { what: 'Pay $55' } }, bill, said, NOW);
    assert.equal(invented, null, 'an amount neither they nor the folder gave leaves nothing to change');
    const far = C.vet({ change: 'changed', quote: 'they moved it', when: '2031-01-01' }, bill, said, NOW);
    assert.equal(far, null, 'a date too far off');
    const fromFolder = C.vet({ change: 'changed', quote: 'they moved it', status: 'Still $41.00, date moved' }, bill, said, NOW);
    assert.equal(fromFolder.status, 'Still $41.00, date moved', 'a number the folder already holds is fine');
}
// A note changes nothing but the history.
{
    const j = C.vet({ change: 'note', quote: 'my landlord covers half', status: 'Half paid', when: '2026-10-09', next: { what: 'Ask landlord' } }, bill, 'fyi my landlord covers half of this', NOW);
    assert.deepEqual([j.change, j.status, j.when, j.next, j.receipt], ['same', '', null, null, 'noted']);
}
// Which chats: only one tied to a folder.
{
    global.Matters = Object.assign(Object.create(require('../js/core/matters.js')), { get: id => (id === 'matter:w1' ? bill : null) });
    assert.equal(C.folderFor({ todayKey: 'matter:w1' }), bill);
    assert.equal(C.folderFor({ todayKey: 'matter:matter:w1' }), bill, 'a chat tied under the old doubled key');
    assert.equal(C.folderFor({ todayKey: 'task:t1' }), null);
    assert.equal(C.folderFor({}), null);
    delete global.Matters;
    assert.equal(C.eligible({ id: 'c' }), true);
    assert.equal(C.eligible({ id: 'c', contextMode: 'simple' }), false);
    assert.equal(C.eligible({ id: 'c' }, { untrusted: true }), false);
}
console.log('matter-capture: the quote, the checks, notes, which chats passed');
