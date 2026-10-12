'use strict';
const assert = require('node:assert/strict');
const fixtures = require('../fixtures/record-merge/cases.json');
const { reduce } = require('../js/sync/record-merge');
let seed = 731, checks = 0;
function shuffled(items) {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const j = seed % (i + 1);
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}
for (const fixture of fixtures) {
    for (let pass = 0; pass < 12; pass++) {
        const operations = pass === 0 ? fixture.operations : shuffled([...fixture.operations, ...fixture.operations]);
        if (fixture.error) assert.throws(() => reduce(operations, 'fixture'), undefined, fixture.name);
        else assert.deepEqual(reduce(operations, 'fixture'), fixture.expected, fixture.name);
        checks++;
    }
}
// Simulate disconnected writers, partial receipts, then complete delivery.
for (let trial = 0; trial < 30; trial++) {
    const operations = [], frontier = {};
    for (let i = 0; i < 40; i++) {
        const writer = ['a', 'b', 'c'][i % 3], sequence = (frontier[writer] || 0) + 1;
        const dependencies = i % 7 === 0 ? { ...frontier } : { [writer]: sequence - 1 };
        // Include all dependencies already observed by this writer.
        const previous = operations.findLast(o => o.deviceId === writer);
        for (const [w, n] of Object.entries(previous?.dependencies || {})) dependencies[w] = Math.max(dependencies[w] || 0, n);
        operations.push({ protocolVersion: 2, schemaVersion: 1, datasetId: 'fixture', membershipEpoch: 1,
            deviceId: writer, sequence, dependencies, recordType: 'note', recordId: `n${i % 4}`,
            mutation: { kind: 'edit', fields: { content: `trial ${trial}, edit ${i}` } } });
        frontier[writer] = sequence;
    }
    const expected = reduce(operations, 'fixture'), delivered = [];
    for (const operation of shuffled(operations)) {
        delivered.push(operation, operation);
        const partial = reduce(delivered, 'fixture');
        for (const [w, n] of Object.entries(partial.frontier)) {
            for (let seq = 1; seq <= n; seq++) assert(partial.applied.includes(`${w}:${seq}`));
        }
    }
    assert.deepEqual(reduce(delivered, 'fixture'), expected);
    checks++;
}
console.log(`record merge: ${fixtures.length} shared fixtures, ${checks} checks passed`);
