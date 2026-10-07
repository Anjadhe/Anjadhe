// What left this Mac (js/core/simple-settings-pages.js): the ledger as
// date · service · kind, from code's facts only. Pins that a row is made
// for every LLM call that LEFT and every web search, never for a local
// call, that the newest comes first, and that no prompt text rides along.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

globalThis.SimpleSettings = {};
new Function(fs.readFileSync(path.join(__dirname, '../js/core/simple-settings-pages.js'), 'utf8'))();
const S = globalThis.SimpleSettings;

const llm = [
    { timestamp: '2026-10-06T09:00:00Z', left: false, destination: 'This Mac', source: 'agent', userPrompt: 'my secret' },
    { timestamp: '2026-10-06T10:00:00Z', left: true, destination: 'nenva cloud lite', source: 'email-insights', userPrompt: 'the mail body' },
    { timestamp: '2026-10-05T10:00:00Z', left: true, destination: 'OpenAI (your key)', source: 'agent' },
    { timestamp: '2026-10-04T10:00:00Z', left: undefined, destination: null, source: 'agent' },
    null
];
const searches = [
    { timestamp: '2026-10-06T09:30:00Z', provider: 'anjadhe', query: 'the query' },
    { timestamp: '2026-10-06T11:00:00Z', provider: null }
];
const kinds = { 'email-insights': 'Mail and texts', agent: 'Chat' };
const rows = S.leftRows(llm, searches, { kindOf: s => kinds[s] || null });

assert.equal(rows.length, 4, 'two calls that left + two searches; the local call and the unstamped one stay out');
assert.deepEqual(rows.map(r => r.ts), ['2026-10-06T11:00:00Z', '2026-10-06T10:00:00Z', '2026-10-06T09:30:00Z', '2026-10-05T10:00:00Z'], 'newest first');
assert.deepEqual(rows[1], { ts: '2026-10-06T10:00:00Z', service: 'nenva cloud lite', kind: 'Mail and texts' });
assert.deepEqual(rows[2], { ts: '2026-10-06T09:30:00Z', service: 'anjadhe search', kind: 'Web search' });
assert.equal(rows[0].service, 'Web search', 'a search with no provider name');
assert.equal(rows[3].kind, 'Chat');
for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ['kind', 'service', 'ts'], 'no prompt or query text on a row');
assert.equal(JSON.stringify(rows).includes('secret') || JSON.stringify(rows).includes('the query') || JSON.stringify(rows).includes('mail body'), false);

// A call that left with no destination recorded and no known kind.
assert.deepEqual(S.leftRows([{ timestamp: '2026-10-01T00:00:00Z', left: true, source: 'x' }], []), [{ ts: '2026-10-01T00:00:00Z', service: 'Left this Mac', kind: 'AI' }]);
// Limit and bad input.
assert.equal(S.leftRows(llm, searches, { limit: 2 }).length, 2);
assert.deepEqual(S.leftRows(null, undefined), []);

console.log('simple-settings-left-test: ok');
