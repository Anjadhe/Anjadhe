// Main is the authority over standing grants (js/main/agent-grants.js G1-G5).
const assert = require('node:assert/strict');
const G = require('../js/main/agent-grants');

const stored = [
    { id: 'a', tool: 'send_email', exclusions: ['new_recipient'], createdAt: '2026-10-01', budget: 4, usedDay: '2026-10-12', usedCount: 2 },
    { id: 'b', tool: 'shell', scope: 'ls', createdAt: '2026-10-02', expiresAt: '2026-10-20T00:00:00.000Z' },
    { id: 'c', tool: 'mcp:files', createdAt: '2026-10-03' }
];
const today = '2026-10-12';

// G1 + G2 + G3: a new grant is ignored, covered fields stay main's, a removal is kept.
let { next, loosened } = G.mergeGrants(stored, [
    { ...stored[0], tool: 'send_text', exclusions: [], scope: '/' },
    { ...stored[1] },
    { id: 'z', tool: 'run_applescript', createdAt: '2026-10-12' }
], today);
assert.deepEqual(next.map(g => g.id), ['a', 'b']);
assert.equal(next[0].tool, 'send_email'); assert.deepEqual(next[0].exclusions, ['new_recipient']); assert.equal(next[0].scope, undefined);
assert.equal(loosened.length, 0);

// G4: a use count does not go backwards within a day; a new day starts over.
({ next } = G.mergeGrants(stored, [{ ...stored[0], usedCount: 0 }, stored[1], stored[2]], today));
assert.equal(next[0].usedCount, 2);
({ next } = G.mergeGrants(stored, [{ ...stored[0], usedCount: 3 }, stored[1], stored[2]], today));
assert.equal(next[0].usedCount, 3);
({ next } = G.mergeGrants(stored, [{ ...stored[0], usedDay: '2026-10-13', usedCount: 0 }, stored[1], stored[2]], today));
assert.equal(next[0].usedDay, '2026-10-12', 'a day in the future is not taken');

// G5: tightening is kept; loosening comes back apart.
({ next, loosened } = G.mergeGrants(stored, [{ ...stored[0], budget: 2 }, { ...stored[1], expiresAt: '2026-10-15T00:00:00.000Z' }, { ...stored[2], budget: 1 }], today));
assert.equal(loosened.length, 0);
assert.equal(next[0].budget, 2); assert.equal(next[2].budget, 1);
({ next, loosened } = G.mergeGrants(stored, [{ ...stored[0], budget: 0 }, { ...stored[1], expiresAt: undefined }, stored[2]], today));
assert.deepEqual(loosened.map(l => l.before.id), ['a', 'b']);
assert.equal(loosened[0].after.budget, undefined);
assert.deepEqual(next.map(g => g.id), ['c']);

// Labels come from the key, and standing sends start bounded.
assert.match(G.grantLabel('shell', 'rm -rf ~'), /Run this command: rm -rf ~/);
assert.match(G.grantLabel('read_url:https://example.com'), /example\.com/);
assert.deepEqual(G.newToolGrant('send_email').exclusions, ['new_recipient']);
assert.deepEqual(G.newToolGrant('send_text').exclusions, ['other_people']);
assert.equal(G.newToolGrant('mcp:x').exclusions, undefined);
console.log('agent-grants: the renderer may revoke and count, never grant or widen');
