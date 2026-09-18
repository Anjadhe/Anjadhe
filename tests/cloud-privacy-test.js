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
    email: true, messages: false, notes: true, journal: false, wellness: false, spending: false,
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

// guardTool: only ambient contexts gate, and only mapped tools.
// Journal's read tools are no longer in the static table — the Journal
// package registers them at runtime (AgentTools.register `dataClass:
// 'journal'` in js/apps/journal/journal-tools.js, since 2026-08-30), which
// lands the same TOOL_CLASS rows. Mirror that registration here.
CP.TOOL_CLASS.list_journal = 'journal';
CP.TOOL_CLASS.get_journal_entry = 'journal';
//
// The gate reads the model that answers THAT source (model-routing.js R4),
// so the seam the tests stub is _entry — brainLeaves and leavesFor are both
// exercised for real through it.
const LOCAL = { id: 'l1', engine: 'llamacpp', model: 'gemma' };
const CLOUD = { id: 'c1', engine: 'anjadhe', model: 'anjadhe-cloud' };
CP._load = () => ({ classes: {}, seen: {} });
CP._entry = () => CLOUD;
CP._noteBlocked = () => {};
assert.strictEqual(CP.guardTool('list_journal', { ambient: false }), null);
assert.strictEqual(CP.guardTool('list_journal', {}), null);
assert.strictEqual(CP.guardTool('create_journal_entry', { ambient: true }), null);
assert.ok(CP.guardTool('list_journal', { ambient: true }).blocked);
assert.strictEqual(CP.guardTool('list_journal', { ambient: true }).blockedClass, 'journal');
assert.ok(CP.guardTool('get_journal_entry', { ambient: true }).blocked);
assert.strictEqual(CP.guardTool('list_emails', { ambient: true }), null);
CP._entry = () => LOCAL;
assert.strictEqual(CP.guardTool('list_journal', { ambient: true }), null);

// guardSource: the LLMLogger safety net
CP._entry = () => CLOUD;
assert.strictEqual(CP.guardSource('agent'), null);
assert.strictEqual(CP.guardSource('email'), null);
CP._load = () => ({ classes: { email: false }, seen: {} });
assert.ok(CP.guardSource('email-threads').blocked);

// R4, both directions: the destination of THIS source decides, not the brain.
// Email routed to a local model while the brain is cloud → nothing leaves,
// so the email switch has nothing to govern and the sweep runs.
CP._entry = (source) => (String(source || '').startsWith('email') ? LOCAL : CLOUD);
assert.strictEqual(CP.guardSource('email-threads'), null, 'email on a local model is not gated');
assert.strictEqual(CP.brainLeaves(), true, 'the brain still leaves');
assert.strictEqual(CP.leavesFor('email'), false);
assert.strictEqual(CP.allowsFor('email', 'email'), true);
assert.strictEqual(CP.allows('email'), false, 'asked of the brain, email is still blocked');
// And the reverse: a local brain with email pointed at the cloud IS gated —
// the case that used to send every message body off the Mac unguarded.
CP._entry = (source) => (String(source || '').startsWith('email') ? CLOUD : LOCAL);
assert.strictEqual(CP.brainLeaves(), false);
assert.ok(CP.guardSource('email-threads').blocked, 'email on a cloud model is gated under a local brain');
// A routine's tool gate follows the run's own source tag.
CP._entry = (source) => (source === 'prompt-feed' ? CLOUD : LOCAL);
CP._load = () => ({ classes: {}, seen: {} });
assert.ok(CP.guardTool('list_journal', { ambient: true, source: 'prompt-feed' }).blocked);
assert.strictEqual(CP.guardTool('list_journal', { ambient: true, source: 'task' }), null);

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
    // bodyForModel: minimized only when the model that reads it is off
    // this Mac, always capped. The destination follows the SOURCE (R4), so
    // a local Email surface keeps the full body under a cloud brain.
    CP._entry = () => LOCAL;
    assert.strictEqual(CP.bodyForModel('a\n> q\nb', 100), 'a\n> q\nb');
    CP._entry = () => CLOUD;
    assert.strictEqual(CP.bodyForModel('a\n> q\nb', 100), 'a\nb');
    assert.strictEqual(CP.bodyForModel('abcdef', 3), 'abc');
    CP._entry = (source) => (String(source || '').startsWith('email') ? LOCAL : CLOUD);
    assert.strictEqual(CP.bodyForModel('a\n> q\nb', 100, 'email'), 'a\n> q\nb');
    assert.strictEqual(CP.bodyForModel('a\n> q\nb', 100), 'a\nb');
}

console.log('cloud-privacy: all assertions passed');
