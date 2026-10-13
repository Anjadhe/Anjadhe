#!/usr/bin/env node
// A thread turn's asks as one ribbon (docs/THREADS_DEMO.md D1): changes are
// batched, a send never is, and a batch has a cap. The rule is lifted from
// the shipped source the way ask-nudge-test does.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '../js/agent/agent-ui.js'), 'utf8');
const start = src.indexOf('    ASK_BATCH_MAX: 6,');
const end = src.indexOf('    _buildAskBatchCard(asks, slotId) {');
assert.ok(start > 0 && end > start, 'the batch members are where the test expects');
const subject = new Function(`return { ${src.slice(start, end)} };`)();
const ask = (toolName, n) => ({ attentionId: `permission-${n}`, toolName, args: {}, settled: false });

let r = subject.batchAsks([ask('update_calendar_event', 1), ask('create_calendar_event', 2), ask('add_commitment', 3)]);
assert.deepEqual(r.batch.map(a => a.attentionId), ['permission-1', 'permission-2', 'permission-3']);
assert.deepEqual(r.singles, []);
r = subject.batchAsks([ask('send_email', 1), ask('update_calendar_event', 2), ask('add_commitment', 3), ask('send_text', 4)]);
assert.deepEqual(r.batch.map(a => a.toolName), ['update_calendar_event', 'add_commitment'], 'changes batch');
assert.deepEqual(r.singles.map(a => a.toolName), ['send_email', 'send_text'], 'a send is never in the batch');
r = subject.batchAsks([ask('add_commitment', 1)]);
assert.deepEqual(r.batch, []); assert.equal(r.singles.length, 1, 'one change is its own card');
r = subject.batchAsks([ask('send_email', 1), ask('add_commitment', 2)]);
assert.deepEqual(r.batch, []); assert.equal(r.singles.length, 2, 'a send and one change: two cards');
r = subject.batchAsks(Array.from({ length: 9 }, (_, i) => ask('add_commitment', i + 1)));
assert.equal(r.batch.length, 6, 'capped'); assert.equal(r.singles.length, 3, 'the rest wait as their own cards');
assert.deepEqual(subject.batchAsks([]), { batch: [], singles: [] });
console.log('ask-batch-test: ok');
