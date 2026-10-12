'use strict';
const assert = require('node:assert/strict');
const S = require('../js/shared/conversation-sync');
const M = require('../js/sync/record-merge');
const fixtures = require('../fixtures/record-merge/cases.json');
const empty = { conversations: [] };
const initial = { conversations: [{ id: 'chat', title: 'School', todayKey: 'sender:school', createdAt: '2026-10-12',
    messages: [{ id: 'u', role: 'user', content: 'When is tuition due?', timestamp: '2026-10-12' },
        { id: 'tool', role: 'tool', content: 'TOOL_SECRET', requestId: 'NO_SYNC' },
        { id: 'a', role: 'assistant', content: 'October 20.', timestamp: '2026-10-12', metadata: { model: 'DEVICE_MODEL' } }] },
    { private: true, messages: [{ content: 'PRIVATE_SECRET' }] }] };
const plan = S.plan(empty, initial);
assert.equal(plan.mutations.length, 3);
assert.equal(plan.value.conversations.length, 1);
assert.doesNotMatch(JSON.stringify(plan.mutations), /PRIVATE_SECRET|TOOL_SECRET|NO_SYNC|DEVICE_MODEL/);
assert.equal(plan.mutations[2].mutation.fields.message.parentId, 'u');
const operations = plan.mutations.map((m,i) => ({protocolVersion:2,schemaVersion:1,datasetId:'fixture',membershipEpoch:1,
    deviceId:'a',sequence:i+1,dependencies:i?{a:i}:{},recordType:m.type,recordId:m.id,mutation:m.mutation}));
const records = M.reduce(operations,'fixture').records;
assert.deepEqual(S.plan(plan.value, initial, records).mutations, []);
const after = structuredClone(plan.value);
after.conversations[0].messages.push({ id:'u2',role:'user',content:'Add it as a commitment',timestamp:'2026-10-12' });
assert.equal(S.plan(plan.value, after, records).mutations.length, 1);
assert.throws(() => S.plan(plan.value, empty, records), /explicit sync delete/);
assert.throws(() => S.plan(plan.value, after, []), /bootstrap/);
assert.throws(() => S.plan(empty, initial, records), /collision/);
const stale = structuredClone(records); stale.find(r=>r.type==='conversation').fields.title.value = 'Changed elsewhere';
assert.throws(() => S.plan(plan.value, after, stale), /conflict review/);
const missingID = structuredClone(initial); delete missingID.conversations[0].messages[0].id;
assert.throws(() => S.plan(empty, missingID), /migration/);
const retarget = structuredClone(plan.value); retarget.conversations[0].messages[2].parentId = null;
assert.throws(() => S.plan(plan.value, retarget, records), /parent or speaker/);
const branches = S.project(fixtures.find(f=>f.name==='conversation-concurrent-branches').expected.records);
assert.deepEqual(branches.conversations[0].messages.map(m=>m.id), ['root','mac-reply','phone-reply']);
const conflicts = S.project(fixtures.find(f=>f.name==='conversation-concurrent-message-versions').expected.records);
assert.equal(conflicts.conversations[0].messages[1].syncConflicts.length, 2);
const privacy = S.project(fixtures.find(f=>f.name==='conversation-concurrent-privacy').expected.records);
assert.equal(privacy.conversations[0].untrusted, true);
assert.equal(privacy.conversations[0].contextMode, 'simple');
const orphans = S.project(records.filter(r=>r.id!=='4:chat:u'));
assert.equal(orphans.conversations[0].orphanMessages.length, 1);
assert.equal(S.project(records.filter(r=>r.type!=='conversation')).orphanMessages.length, 2);
console.log('Conversation sync: private exclusion, stable parents, branches, conflicts, stale baselines and missing-history preservation passed');
