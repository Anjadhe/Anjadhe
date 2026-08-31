#!/usr/bin/env node
/**
 * CloudPrivacy gate arithmetic (js/core/cloud-privacy.js) — the decision
 * behind "may ambient AI send this class of data off the Mac". Pure, so it
 * runs standalone:
 *
 *   node tests/cloud-privacy-test.js
 *
 * Pins: the defaults (journal + wellness off, the rest on), the local-brain
 * bypass (nothing is gated when nothing leaves), an explicit setting beating
 * the default in both directions, unknown classes passing (a gate that
 * fails closed on a typo would silently kill features), the source/tool
 * maps naming only real classes, and the refusal naming the class.
 */
const assert = require('assert');
const CP = require('../js/core/cloud-privacy.js');

const ids = CP.CLASSES.map(c => c.id);

// defaults
assert.deepStrictEqual(CP.defaults(), {
    email: true, notes: true, journal: false, wellness: false,
    portfolio: true, browse: true, files: true
});

// local brain: everything allowed, whatever the settings say
for (const id of ids) {
    assert.strictEqual(CP.decide(id, {}, false).allowed, true, `${id} local`);
    assert.strictEqual(CP.decide(id, { [id]: false }, false).allowed, true, `${id} local, off`);
}

// cloud brain, no settings: defaults rule
assert.strictEqual(CP.decide('email', null, true).allowed, true);
assert.strictEqual(CP.decide('journal', null, true).allowed, false);
assert.strictEqual(CP.decide('wellness', {}, true).allowed, false);

// explicit setting beats the default both ways
assert.strictEqual(CP.decide('journal', { journal: true }, true).allowed, true);
assert.strictEqual(CP.decide('email', { email: false }, true).allowed, false);
// a non-boolean stored value is ignored, not trusted
assert.strictEqual(CP.decide('journal', { journal: 'yes' }, true).allowed, false);

// unknown class: allowed (fail open by design — see the module header)
assert.strictEqual(CP.decide('calendar', { calendar: false }, true).allowed, true);

// the refusal names the class and the door
const d = CP.decide('wellness', {}, true);
assert.match(d.reason, /Wellness stays on this Mac/);
assert.match(d.reason, /Cloud privacy/);
assert.match(d.reason, /chat still works/);

// every mapped source / tool points at a real class
for (const [k, v] of Object.entries(CP.SOURCE_CLASS)) assert.ok(ids.includes(v), `source ${k} → ${v}`);
for (const [k, v] of Object.entries(CP.TOOL_CLASS)) assert.ok(ids.includes(v), `tool ${k} → ${v}`);
// interactive sources are never gated
for (const s of ['agent', 'email-compose', 'maker', 'memory-extract']) assert.ok(!CP.SOURCE_CLASS[s], s);

// guardTool: only ambient contexts gate, and only mapped tools
CP._load = () => ({ classes: {}, seen: {} });
CP.brainLeaves = () => true;
CP._noteBlocked = () => {};
assert.strictEqual(CP.guardTool('list_journal', { ambient: false }), null);
assert.strictEqual(CP.guardTool('list_journal', {}), null);
assert.strictEqual(CP.guardTool('create_journal_entry', { ambient: true }), null);
assert.ok(CP.guardTool('list_journal', { ambient: true }).blocked);
assert.strictEqual(CP.guardTool('list_journal', { ambient: true }).blockedClass, 'journal');
assert.ok(CP.guardTool('get_journal_entry', { ambient: true }).blocked);
assert.strictEqual(CP.guardTool('list_emails', { ambient: true }), null);
CP.brainLeaves = () => false;
assert.strictEqual(CP.guardTool('list_journal', { ambient: true }), null);

// guardSource: the LLMLogger safety net
CP.brainLeaves = () => true;
assert.strictEqual(CP.guardSource('agent'), null);
assert.strictEqual(CP.guardSource('email'), null);
CP._load = () => ({ classes: { email: false }, seen: {} });
assert.ok(CP.guardSource('email-threads').blocked);

// minimize: quoted history, signature, quote lines, tracking params, whitespace
{
    const body = [
        'Hi Ram,', '', 'Your order ships Friday. Track it at https://shop.example/track/123?utm_source=mail&utm_id=99 today.', '',
        '> earlier quoted line', 'Thanks,', 'Sam', '-- ', 'Sam Lee | Example Corp', '',
        'On Mon, Aug 24, 2026 at 9:00 AM Ram <ram@example.com> wrote:', '> where is my order?', '> thanks'
    ].join('\n');
    const m = CP.minimize(body);
    assert.ok(m.includes('Your order ships Friday'));
    assert.ok(m.includes('https://shop.example/track/123 today'), m);
    assert.ok(!m.includes('utm_'));
    assert.ok(!m.includes('earlier quoted'));
    assert.ok(!m.includes('Example Corp'));
    assert.ok(!m.includes('wrote:') && !m.includes('where is my order'));
    // a short body never gets emptied by a false cut
    assert.strictEqual(CP.minimize('ok\n-- \nx'), 'ok\n--\nx');
    assert.strictEqual(CP.minimize('   \n\n\n'), '');
    // bodyForModel: minimized only when the brain leaves, always capped
    CP.brainLeaves = () => false;
    assert.strictEqual(CP.bodyForModel('a\n> q\nb', 100), 'a\n> q\nb');
    CP.brainLeaves = () => true;
    assert.strictEqual(CP.bodyForModel('a\n> q\nb', 100), 'a\nb');
    assert.strictEqual(CP.bodyForModel('abcdef', 3), 'abc');
}

console.log('cloud-privacy: all assertions passed');
