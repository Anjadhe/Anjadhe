// The first read of a mailbox (2026-10-05): a window of days with a cap, a
// floor for a quiet inbox, and no "now" alert for mail that is days old.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ctx = { console, window: {}, document: { addEventListener() {} }, localStorage: { getItem: () => null, setItem() {} }, AppManager: { register() {} } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/apps/email/email-app.js'), 'utf8') + '\nthis.EmailApp = EmailApp;', ctx);
const E = ctx.EmailApp;
const now = Date.parse('2026-10-05T12:00:00Z');
const after = Math.floor((now - 14 * 86400000) / 1000);

// Starts with the window, never a bare count.
assert.deepEqual({ ...E.firstReadStep({}, now) }, { maxResults: 100, afterTs: after });
// Pages on while there is more, up to the cap.
assert.deepEqual({ ...E.firstReadStep({ fetched: 100, pages: 1, nextPageToken: 'p2' }, now) }, { maxResults: 100, afterTs: after, pageToken: 'p2' });
assert.deepEqual({ ...E.firstReadStep({ fetched: 250, pages: 3, nextPageToken: 'p4' }, now) }, { maxResults: 50, afterTs: after, pageToken: 'p4' });
assert.equal(E.firstReadStep({ fetched: 300, pages: 4, nextPageToken: 'p5' }, now), null, 'the cap');
assert.equal(E.firstReadStep({ fetched: 60, pages: 1, nextPageToken: null }, now), null, 'the window is exhausted');
// A quiet inbox: its newest fifty, once.
assert.deepEqual({ ...E.firstReadStep({ fetched: 4, pages: 1, nextPageToken: null }, now) }, { maxResults: 50, floor: true });
assert.equal(E.firstReadStep({ fetched: 54, pages: 2, nextPageToken: null, floorTried: true }, now), null);
assert.equal(E.firstReadStep({ fetched: 4, pages: 2, nextPageToken: 'x', floorTried: true }, now), null, 'the floor never pages on');

// "Now" is for mail that just arrived.
assert.equal(E._arrivedRecently({ internalDate: String(now - 3600000) }, now), true);
assert.equal(E._arrivedRecently({ internalDate: String(now - 5 * 86400000) }, now), false);
assert.equal(E._arrivedRecently({}, now), true, 'unknown age is not held back');
console.log('email-first-read: the window, the cap, the floor, old mail waits passed');
