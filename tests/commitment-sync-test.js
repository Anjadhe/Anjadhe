'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const S = require('../js/shared/commitment-sync'), M = require('../js/sync/record-merge');
const initial = require('../fixtures/commitment-sync/snapshot.json'), empty = { items: [] };
const plan = S.plan(empty, initial);
assert.equal(plan.mutations.length, 4);
assert.doesNotMatch(JSON.stringify(plan.mutations), /LOCAL_ONLY|ledger|updatedAt/);
const op = (deviceId, sequence, dependencies, type, id, fields) => ({protocolVersion:2,schemaVersion:1,datasetId:'fixture',membershipEpoch:1,deviceId,sequence,dependencies,recordType:type,recordId:id,mutation:{kind:'edit',fields}});
const ops = plan.mutations.map((m,i) => op('a',i+1,i ? {a:i} : {},m.type,m.id,m.mutation.fields));
const records = M.reduce(ops, 'fixture').records;
assert.deepEqual(S.plan(initial, initial, records).mutations, []);
assert.throws(() => S.plan(initial, initial, []), /bootstrap/);
assert.throws(() => S.plan(empty, initial, records), /bootstrap|collision/);
const change = fn => {const c=structuredClone(initial);fn(c);return c;};
const edited = change(c => {c.items[1].title='Run gently'; c.items[1].updatedAt='tomorrow';});
assert.deepEqual(S.plan(initial, edited, records).mutations[0].mutation.fields, {title:'Run gently'});
assert.throws(() => S.plan(initial, change(c=>c.items.pop()), records), /Missing commitment/);
assert.throws(() => S.plan(initial, change(c=>c.items[1].createdAt='changed'), records), /immutable/);
for (const fn of [c=>c.items[1].tags=['important'],c=>c.items[1].attached=[{kind:'note',id:'x'}],c=>c.items[1].privacySources=['slack'],c=>c.items[1].timer={total:2},c=>c.items[1].sourceSnapshot={title:'Apple'},c=>c.items[1].legacy={notes:'old'},c=>c.tombstones.old='now',c=>c.items[1].origin.kind='plan']) {
    assert.throws(()=>S.plan(initial,change(fn),records), /migration|wire fields/);
}
assert.throws(()=>S.plan(initial, change(c=>c.items[1].parent='missing'),records), /parent/);
assert.throws(()=>S.plan(initial, change(c=>c.items[0].parent='run'),records), /parent/);
assert.throws(()=>S.plan(initial, change(c=>c.items[1].when.end='06:00'),records), /wire fields/);
assert.throws(()=>S.plan(initial, change(c=>c.items[1].until='2026-10-01'),records), /wire fields/);
assert.throws(()=>S.plan(initial, change(c=>c.items[1].history['2026-02-30']='done'),records), /day wire/);
// Independent prose and schedule edits merge; a schedule is never spliced.
const schedule = {...plan.mutations[1].mutation.fields.schedule, when:{date:'2026-10-09',time:'08:00',end:'08:40'}};
const rename=op('b',1,{a:4},'commitment','run',{title:'Run gently'}), move=op('c',1,{a:4},'commitment','run',{schedule});
const independent=M.reduce([...ops,rename,move],'fixture');
const projected=S.project(independent.records), run=projected.items.find(c=>c.id==='run');
assert.equal(run.title,'Run gently');assert.equal(run.when.time,'08:00');assert.equal(run.when.end,'08:40');assert.deepEqual(projected.issues,[]);
assert.throws(()=>S.plan(initial,initial,independent.records),/conflict review/);
// Two different days union. Same-day concurrent report versus clear keeps
// BOTH complete versions, including the original quote and its figures.
const dayID=S.dayID('run','2026-10-11'), day=records.find(r=>r.id===dayID).fields.day.value;
const complete=op('b',1,{a:4},'commitment-day',dayID,{day:{...day,mark:'dropped'}});
const reopen=op('c',1,{a:4},'commitment-day',dayID,{day:S.emptyDay('run','2026-10-11')});
const disputed=M.reduce([...ops,complete,reopen],'fixture');
assert.equal(S.project(disputed.records).days.find(d=>d.id===dayID).versions.length,2);
assert.ok(S.project(disputed.records).issues.includes('run'));
assert.equal(disputed.records.find(r=>r.id===dayID).fields.day.versions[0].value.log[0].measures[0].value,4);
const cleared=change(c=>{delete c.items[1].history['2026-10-11'];delete c.items[1].log['2026-10-11'];});
const clearing=S.plan(initial,cleared,records);
assert.deepEqual(clearing.mutations[0].mutation.fields.day,S.emptyDay('run','2026-10-11'));
const clearedOps=[...ops,op('a',5,{a:4},'commitment-day',dayID,clearing.mutations[0].mutation.fields)];
const clearedRecords=M.reduce(clearedOps,'fixture').records;
assert.deepEqual(S.plan(cleared,cleared,clearedRecords).mutations,[]);
assert.equal(S.plan(cleared,initial,clearedRecords).mutations.length,1,'report after a clear observes and replaces that day');
const missing=S.project(records.filter(r=>r.id!=='goal'));
assert.ok(missing.items[0].syncIssues.includes('missing-parent'));
const cycles=S.project(M.reduce([...ops,op('b',1,{a:4},'commitment','goal',{parent:'run'})],'fixture').records);
assert.ok(cycles.items.every(c=>c.syncIssues.includes('parent-cycle')));
const orphan=S.project(records.filter(r=>r.type!=='commitment'));
assert.ok(orphan.days.every(d=>d.missingTarget));
const inbound=op('b',1,{a:4},'commitment','peer',{title:'Peer addition'});
assert.throws(()=>S.plan(initial,initial,M.reduce([...ops,inbound],'fixture').records),/bootstrap|review/);
assert.throws(()=>S.plan(empty,{items:Array.from({length:257},(_,i)=>({...initial.items[0],id:'c'+i}))}),/paged migration/);
// The exact bundled planner/projection executes without browser or host APIs.
const context=vm.createContext({});vm.runInContext(fs.readFileSync('ios-engine/Anjadhe/Sources/AnjadheCore/Resources/shared-core.js','utf8'),context);
const call=vm.runInContext('(method,args)=>NenvaCore.call(method,JSON.stringify(args))',context);
assert.deepEqual(JSON.parse(call('commitments.syncPlan',[empty,initial,[]])),plan);
assert.deepEqual(JSON.parse(call('commitments.syncProject',[records])),S.project(records));
assert.deepEqual(initial,require('../fixtures/commitment-sync/snapshot.json'),'planning never mutates the baseline');
console.log('Commitment sync: grouped schedule/lifecycle, day evidence, concurrent versions, parent review and migration gates passed');
