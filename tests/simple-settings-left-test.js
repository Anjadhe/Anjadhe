// What left this Mac (js/core/simple-settings-pages.js): the ledger as
// date · service · kind, from code's facts only. Pins that a row is made
// for every LLM call that LEFT, every web search and every piece of work
// CloudPrivacy kept on this Mac (an AIActivity 'blocked' row), never for a
// local call, that the newest comes first, and that no prompt text rides along.
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
assert.deepEqual(rows[2], { ts: '2026-10-06T09:30:00Z', service: 'nenva agent web search', kind: 'Web search' });
assert.equal(rows[0].service, 'Web search', 'a search with no provider name');
assert.equal(rows[3].kind, 'Chat');
for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ['kind', 'service', 'ts'], 'no prompt or query text on a row');
assert.equal(JSON.stringify(rows).includes('secret') || JSON.stringify(rows).includes('the query') || JSON.stringify(rows).includes('mail body'), false);

// A call that left with no destination recorded and no known kind.
assert.deepEqual(S.leftRows([{ timestamp: '2026-10-01T00:00:00Z', left: true, source: 'x' }], []), [{ ts: '2026-10-01T00:00:00Z', service: 'Left this Mac', kind: 'AI' }]);
// Limit and bad input.
assert.equal(S.leftRows(llm, searches, { limit: 2 }).length, 2);
assert.deepEqual(S.leftRows(null, undefined), []);

// Work kept on this Mac (2026-10-07): an AIActivity row with status 'blocked'
// is a ledger line too, so a switched-off kind is never skipped silently.
// Only blocked rows count; a finished call is not a line here.
const kept = [
    { uid: 'b1', status: 'blocked', label: 'Messages kept on this Mac', desc: 'why', startedAt: Date.parse('2026-10-06T10:30:00Z'), endedAt: Date.parse('2026-10-06T10:30:00Z') },
    { uid: 'r1', status: 'done', label: 'Assistant chat', startedAt: Date.parse('2026-10-06T12:00:00Z'), endedAt: Date.parse('2026-10-06T12:00:01Z') },
    null
];
const withKept = S.leftRows(llm, searches, { kindOf: s => kinds[s] || null, kept });
assert.equal(withKept.length, 5, 'one kept row joins the four');
assert.deepEqual(withKept[1], { ts: '2026-10-06T10:30:00.000Z', service: 'Kept on this Mac', kind: 'Messages' }, 'the kept row sits in time order, service says kept, kind is the class');
assert.equal(JSON.stringify(withKept).includes('why'), false, 'the row carries no description');
assert.deepEqual(S.leftRows([], [], { kept: [{ status: 'blocked', label: 'Kept on this Mac', startedAt: Date.parse('2026-10-01T00:00:00Z') }] }), [{ ts: '2026-10-01T00:00:00.000Z', service: 'Kept on this Mac', kind: 'Kept on this Mac' }], 'a bare label stays');

console.log('simple-settings-left-test: ok');
