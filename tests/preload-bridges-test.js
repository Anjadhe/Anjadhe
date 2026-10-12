// preload.js: every contextBridge name is exposed exactly once. A second
// exposeInMainWorld with the same name throws at load and silently drops
// every bridge after it (2026-10-01: a duplicate `electronWindow` would have
// taken Google sign-in and the rest of the file down with it).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');
const names = [...src.matchAll(/exposeInMainWorld\(\s*'([^']+)'/g)].map(m => m[1]);
const seen = new Set();
for (const n of names) {
    assert.ok(!seen.has(n), `preload exposes '${n}' twice`);
    seen.add(n);
}
assert.ok(names.length > 10, 'found the bridges');
console.log(`preload-bridges: ${names.length} bridges, each exposed once`);
