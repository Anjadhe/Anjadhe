// One conversation list across Macs and the phone (docs/MOBILE_NATIVE.md
// "M5"): `agent-conversations` is record-merged, and two copies of ONE
// conversation union their messages. Runs main.js's own merge code, cut out
// of the file by text (main.js is the Electron main process and cannot be
// required here).
const assert = require('assert');
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '../main.js'), 'utf8');
const start = src.indexOf('const RECORD_MERGE_ARRAYS = {');
const end = src.indexOf('// Renderer writes of record-merged keys union');
assert(start > 0 && end > start, 'merge code not found in main.js');
const merge = new Function(src.slice(start, end) + '\nreturn mergeRecordBlobs;')();
const KEY = 'app_agent-conversations';
// Relative to now: tombstones older than 90 days are pruned by the merge.
const at = (m) => new Date(Date.now() - (60 - m) * 60000).toISOString();
const conv = (id, updated, messages, extra = {}) => ({ id, createdAt: at(0), updatedAt: at(updated), messages, ...extra });
const U = (content) => ({ role: 'user', content });
const A = (content, metadata) => ({ role: 'assistant', content, ...(metadata ? { metadata } : {}) });
const texts = (c) => c.messages.map(m => m.content);

// Different conversations on two devices both survive (the old LWW lost one).
{
    const mac = { conversations: [conv('c1', 5, [U('hi'), A('hello')])] };
    const phone = { conversations: [conv('c2', 6, [U('plan my day'), A('here')])] };
    const out = merge(KEY, mac, phone);
    assert.deepStrictEqual(out.conversations.map(c => c.id).sort(), ['c1', 'c2']);
}

// The phone answered while the Mac was away AND the Mac added a turn to the
// same conversation: both sides' turns are kept, the newer copy's order first.
{
    const base = [U('What is on today?'), A('Two tasks.')];
    const mac = { conversations: [conv('c1', 7, [...base, U('from the Mac'), A('Mac answer')])] };
    const phone = { conversations: [conv('c1', 9, [...base, U('And tomorrow?'), A('One event.', { answeredOn: 'phone', model: 'nenva Cloud' })])] };
    const ab = merge(KEY, mac, phone), ba = merge(KEY, phone, mac);
    assert.deepStrictEqual(texts(ab.conversations[0]),
        ['What is on today?', 'Two tasks.', 'And tomorrow?', 'One event.', 'from the Mac', 'Mac answer']);
    assert.strictEqual(JSON.stringify(ab), JSON.stringify(ba), 'merge must not depend on argument order');
    assert.strictEqual(ab.conversations[0].messages[3].metadata.answeredOn, 'phone');
}

// A stale copy (a prefix of the newer one) adds nothing.
{
    const newer = conv('c1', 9, [U('a'), A('b'), U('c'), A('d')]);
    const stale = conv('c1', 3, [U('a'), A('b')]);
    assert.deepStrictEqual(texts(merge(KEY, { conversations: [stale] }, { conversations: [newer] }).conversations[0]), ['a', 'b', 'c', 'd']);
}

// A turn cut by "edit last message" does not come back from an older copy,
// and the same text sent again after the edit stays.
{
    const full = conv('c1', 5, [U('a'), A('b'), U('typo'), A('answer to typo')]);
    const edited = conv('c1', 8, [U('a'), A('b'), U('typo')], {
        removedMessages: ['user\u0000typo\u00001', 'assistant\u0000answer to typo\u00001'],
    });
    const out = merge(KEY, { conversations: [full] }, { conversations: [edited] }).conversations[0];
    assert.deepStrictEqual(texts(out), ['a', 'b', 'typo']);
    assert.strictEqual(out.removedMessages.length, 2);
}

// Identical repeated messages are distinct by occurrence.
{
    const a1 = conv('c1', 5, [U('yes'), A('ok'), U('yes')]);
    const b1 = conv('c1', 6, [U('yes'), A('ok')]);
    assert.deepStrictEqual(texts(merge(KEY, { conversations: [a1] }, { conversations: [b1] }).conversations[0]), ['yes', 'ok', 'yes']);
}

// A deleted conversation stays deleted; an edit newer than the delete wins.
{
    const mac = { conversations: [conv('c1', 5, [U('x')]), conv('c2', 5, [U('y')])] };
    const other = { conversations: [], tombstones: { c1: at(6), c2: at(4) } };
    const out = merge(KEY, mac, other);
    assert.deepStrictEqual(out.conversations.map(c => c.id), ['c2']);
}

console.log('conversation-merge-test: ok');
