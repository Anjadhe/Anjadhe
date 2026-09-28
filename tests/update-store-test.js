// Pins js/core/update-store.js — the project/task Updates log. DOM-free:
// StorageManager and RecordTypes are stubbed, the store runs in plain Node.
const assert = require('assert');

const blobs = {};
global.StorageManager = {
    get: (k) => blobs[k] ? JSON.parse(JSON.stringify(blobs[k])) : null,
    set: (k, v) => { blobs[k] = JSON.parse(JSON.stringify(v)); }
};
const liveGoals = new Set(['g1']);
global.RecordTypes = {
    get: (t) => t === 'goal' ? { ids: () => liveGoals } : t === 'task' ? { ids: () => null } : null
};

const UpdateStore = require('../js/core/update-store.js');

// add: validation, attribution, kind, dedupe by postId
assert.ok(UpdateStore.add({ key: 'goal:g1', body: '   ' }).error, 'empty body refused');
assert.ok(UpdateStore.add({ key: 'nope', body: 'x' }).error, 'bad key refused');
const u1 = UpdateStore.add({ key: 'goal:g1', body: 'Sent the deck.' }).update;
assert.strictEqual(u1.source, 'user');
assert.strictEqual(u1.kind, 'update');
const u2 = UpdateStore.add({ key: 'goal:g1', body: 'Moving, but the date is tight.', source: 'ai', kind: 'review', postId: 'post-1' }).update;
assert.strictEqual(u2.source, 'ai');
assert.strictEqual(u2.kind, 'review');
const again = UpdateStore.add({ key: 'goal:g1', body: 'dup', source: 'ai', kind: 'review', postId: 'post-1' });
assert.strictEqual(again.deduped, true);
assert.strictEqual(again.update.id, u2.id, 'same postId returns the existing record');
assert.strictEqual(UpdateStore.add({ key: 'task:t1', body: 'x', kind: 'bogus' }).update.kind, 'update', 'unknown kind falls back');

// listFor: newest first, scoped by key; latestFor / latestForKeys
u2.createdAt = new Date(2030, 0, 1, 12).toISOString(); UpdateStore._save();
assert.deepStrictEqual(UpdateStore.listFor('goal:g1').map(u => u.id), [u2.id, u1.id]);
assert.strictEqual(UpdateStore.listFor('goal:g1', { limit: 1 }).length, 1);
assert.strictEqual(UpdateStore.latestFor('goal:g1').id, u2.id);
assert.strictEqual(UpdateStore.latestFor('goal:none'), null);
const latest = UpdateStore.latestForKeys(['goal:g1', 'task:t1', 'goal:zz']);
assert.strictEqual(latest.get('goal:g1').id, u2.id);
assert.ok(latest.get('task:t1'));
assert.strictEqual(latest.has('goal:zz'), false);

// persisted shape + reload sees another writer's rows
assert.strictEqual(blobs.updates.updates.length, 3);
blobs.updates.updates.push({ id: 'ext', key: 'goal:g1', body: 'from the other Mac', source: 'user', kind: 'update', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' });
UpdateStore.reload();
assert.strictEqual(UpdateStore.listFor('goal:g1').length, 3);

// remove tombstones first; removeFor clears a key
assert.strictEqual(UpdateStore.remove('ext').id, 'ext');
assert.ok(blobs.updates.tombstones.ext, 'removal stamped a tombstone');
assert.strictEqual(UpdateStore.remove('ext'), null);
assert.strictEqual(UpdateStore.removeFor('task:t1'), 1);
assert.strictEqual(UpdateStore.listFor('task:t1').length, 0);

// daysSince / ago: local-midnight arithmetic
const now = new Date(2026, 8, 10, 15, 0, 0);
assert.strictEqual(UpdateStore.daysSince(new Date(2026, 8, 10, 1, 0).toISOString(), now), 0);
assert.strictEqual(UpdateStore.daysSince(new Date(2026, 8, 9, 23, 30).toISOString(), now), 1);
assert.strictEqual(UpdateStore.ago(new Date(2026, 8, 9, 23, 30).toISOString(), now), 'yesterday');
assert.strictEqual(UpdateStore.ago(new Date(2026, 8, 3).toISOString(), now), '7 days ago');
assert.strictEqual(UpdateStore.ago(new Date(2026, 7, 10).toISOString(), now), '4 weeks ago');
assert.strictEqual(UpdateStore.ago('garbage', now), '');

// forContext: newest first, attribution + kind tag, quiet note past QUIET_DAYS
const ctx = UpdateStore.forContext('goal:g1', new Date(2030, 0, 20));
assert.ok(ctx.startsWith('- [Jan 1, 2030, Anjadhe review] Moving, but the date is tight.'), ctx);
assert.ok(ctx.includes('user] Sent the deck.'));
assert.ok(ctx.includes('(no update for 19 days)'), ctx);
assert.strictEqual(UpdateStore.forContext('goal:none'), '');
assert.ok(!UpdateStore.forContext('goal:g1', new Date(2030, 0, 2)).includes('no update for'), 'fresh log is not quiet');

// pruneOrphans: grace window, tri-state hosts, tombstones
UpdateStore.add({ key: 'goal:gone', body: 'orphan but fresh' });
const old = UpdateStore.add({ key: 'goal:gone', body: 'orphan and old' }).update;
old.createdAt = '2020-01-01T00:00:00.000Z';
const oldTask = UpdateStore.add({ key: 'task:gone', body: 'task host unknowable' }).update;
oldTask.createdAt = '2020-01-01T00:00:00.000Z';
UpdateStore._save();
assert.strictEqual(UpdateStore.pruneOrphans(), 1, 'only the old orphan on a KNOWN host type is pruned');
assert.strictEqual(UpdateStore.get(old.id), null);
assert.ok(blobs.updates.tombstones[old.id]);
assert.ok(UpdateStore.get(oldTask.id), 'unknowable host blob never prunes');
assert.strictEqual(UpdateStore.listFor('goal:gone').length, 1, 'inside grace survives');

console.log('update-store-test: ok');
