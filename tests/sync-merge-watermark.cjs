#!/usr/bin/env node
/**
 * Mac<->Mac merge watermarks (main.js `mergeFromOtherMachines`, 2026-09-20).
 *
 * The merge used to read and decrypt EVERY journal file from every other Mac
 * on every run — synchronously, on the main process, so the renderer's store
 * reads were blocked throughout. A peer file whose mtime and size are what we
 * merged last time cannot hold anything new, so it is now skipped before the
 * read.
 *
 * This is an Electron harness, not a unit test: the merge lives in main.js
 * and needs a real app boot. Run it by hand (it is not in `npm test`):
 *
 *   node tests/sync-merge-watermark.cjs
 *
 * What it proves, on a throwaway ANJADHE_DATA_ROOT with a fake second Mac:
 *   1. the first merge actually merges the peer's keys;
 *   2. the second merge skips every unchanged file — and is much faster;
 *   3. touching one peer file re-merges THAT file and still skips the rest;
 *   4. a changed value still lands (the skip is not hiding real work).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron } = require(path.join(__dirname, '..', 'node_modules', 'playwright-core'));

const REPO = path.resolve(__dirname, '..');
const ELECTRON = path.join(REPO, 'node_modules', '.bin', 'electron');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'anjadhe-merge-'));
const PEER = 'FakeSecondMac';
const SYNC = path.join(ROOT, 'sync');
const PEER_DIR = path.join(SYNC, PEER);

let failed = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
};

// main.js encodes a key to a filename with hex escapes for unsafe chars.
const keyToFilename = (key) =>
  key.replace(/[^a-zA-Z0-9_-]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')) + '.json';

// Plaintext journal entries are read as-is (the ENC: prefix is optional, kept
// for backward compat) — so the fixture needs no sync key.
function writePeerKey(key, value, modifiedAt) {
  fs.writeFileSync(path.join(PEER_DIR, keyToFilename(key)),
    JSON.stringify({ key, value, modifiedAt, machineId: PEER }));
}

fs.mkdirSync(PEER_DIR, { recursive: true });
fs.mkdirSync(path.join(ROOT, 'userData'), { recursive: true });

// Sync is opt-in, and the machine id defaults to the hostname — pin both
// before the first boot. electron-store's file is named by the `name` option
// given to `new Store(...)` in main.js.
fs.writeFileSync(path.join(ROOT, 'userData', 'anjadhe-app-settings.json'),
  JSON.stringify({ syncEnabled: true, machineId: 'ThisTestMac', setupComplete: true }));

// A peer with one big record-merged key (the expensive case) and some small ones.
const bigNotes = {
  notes: Array.from({ length: 2400 }, (_, i) => ({
    id: 'peer-n' + i,
    title: 'Peer note ' + i,
    content: '<p>' + 'text '.repeat(400) + '</p>',
    createdAt: '2026-09-01T10:00:00.000Z',
    modifiedAt: '2026-09-01T10:00:00.000Z',
  })),
};
writePeerKey('app_notes', bigNotes, '2026-09-19T10:00:00.000Z');
for (let i = 0; i < 25; i++) {
  writePeerKey('app_filler' + i, { rows: Array.from({ length: 50 }, (_, j) => ({ id: j, t: 'x'.repeat(200) })) },
    '2026-09-19T10:00:00.000Z');
}
const peerBytes = fs.readdirSync(PEER_DIR).reduce((n, f) => n + fs.statSync(path.join(PEER_DIR, f)).size, 0);
console.log(`fixture: ${fs.readdirSync(PEER_DIR).length} peer journal files, ${(peerBytes / 1048576).toFixed(1)} MB\n`);

// Boot the app just long enough for the startup merge (it runs on
// did-finish-load), then close it.
async function boot() {
  const app = await _electron.launch({
    executablePath: ELECTRON,
    args: [REPO],
    env: { ...process.env, ANJADHE_DATA_ROOT: ROOT },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // Poll the log rather than sleeping a fixed time.
  const before = mergeLines(syncLog()).length;
  for (let i = 0; i < 80; i++) {
    if (mergeLines(syncLog()).length > before) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  // Give the second, same-session merge a moment to land too.
  await new Promise((r) => setTimeout(r, 900));
  await app.close();
}

/** "…in 1234ms" off the merge-complete line. */
function mergeMs(line) {
  const m = /in (\d+)ms/.exec(line);
  return m ? Number(m[1]) : NaN;
}

function syncLog() {
  const f = path.join(SYNC, 'ThisTestMac', 'sync.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}
function mergeLines(log) {
  return log.split('\n').filter((l) => l.includes('Merge complete'));
}
function lastMergeLine(log) {
  const lines = mergeLines(log);
  return lines[lines.length - 1] || '';
}
// NOTE: the merge runs more than once per launch (did-finish-load fires for
// more than one load), so each boot appends several lines. The FIRST line a
// boot adds is the one that describes a cold merge; the later ones show the
// same-session repeat (the Cmd+R path), which the watermark also makes free.
let logMark = 0;
function bootMergeLines() {
  const lines = mergeLines(syncLog());
  const mine = lines.slice(logMark);
  logMark = lines.length;
  return mine;
}

(async () => {
  console.log('first boot (nothing merged before)');
  await boot();
  let lines = bootMergeLines();
  let first = lines[0] || '';
  const coldMs = mergeMs(first);
  check('the peer keys are merged', /Merge complete: 2[0-9] changes/.test(first), first.trim());
  check('nothing is skipped on a first merge', !first.includes('skipped'), first.trim());
  const repeat = lines[1] || '';
  const repeatMs = mergeMs(repeat);
  if (repeat) {
    check('a second merge in the SAME session is already free',
      /skipped/.test(repeat) && repeatMs * 3 < coldMs, `${coldMs}ms -> ${repeatMs}ms`);
  }

  console.log('\nsecond boot (nothing changed on the peer)');
  await boot();
  first = bootMergeLines()[0] || '';
  const warmMs = mergeMs(first);
  check('every unchanged peer file is skipped', /\(2[0-9] unchanged file\(s\) skipped\)/.test(first), first.trim());
  check('nothing is merged twice', /Merge complete: 0 changes/.test(first), first.trim());
  check('the merge is dramatically cheaper', warmMs * 3 < coldMs,
    `${coldMs}ms of blocked main process -> ${warmMs}ms`);

  console.log('\nthird boot (one peer file changed)');
  writePeerKey('app_filler7', { rows: [{ id: 0, t: 'CHANGED' }] }, '2026-09-20T12:00:00.000Z');
  await boot();
  first = bootMergeLines()[0] || '';
  check('the changed file is merged', /Merge complete: 1 changes/.test(first), first.trim());
  check('the rest are still skipped', /\(25 unchanged file\(s\) skipped\)/.test(first), first.trim());

  console.log(failed ? `\n${failed} check(s) FAILED  — root kept at ${ROOT}` : '\nAll checks passed');
  if (!failed) fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
