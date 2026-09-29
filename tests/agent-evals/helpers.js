/**
 * Agent eval suite — shared harness (docs/COWORK_AGENT.md C8.8).
 *
 * Launches the real app via playwright-core against a SEEDED demo
 * ANJADHE_DATA_ROOT — never real data (the 2026-07-30 lesson: app objects
 * load lazily and save() overwrites; a harness against the live store wiped
 * 107 journal entries).
 *
 * Stubs installed once per launch:
 * - Notification capture (system notifications land in window.__eval.notifs)
 * - AgentService._confirmWrite auto-approves (headless: a real dialog blocks
 *   forever; the dialog path itself has its own journey via DOM click)
 * - AgentTools.execute recorder (+ per-tool stubs) so a journey can assert
 *   the CALL, not just the outcome, and stub side-effectful tools
 */
const { _electron } = require('playwright-core');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(__dirname, 'fixtures');

async function launchApp({ dataRoot, docsDir, seed = true }) {
  // Seed fresh demo data — journeys assume the demo persona. A mid-suite
  // RELAUNCH (after an app crash) passes seed:false so accumulated journey
  // state survives.
  if (seed) {
    execFileSync(path.join(REPO, 'node_modules', '.bin', 'electron'),
      [path.join(REPO, 'scripts', 'seed-demo-data.js'), dataRoot, '--force'],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' });
  }

  const app = await _electron.launch({
    executablePath: path.join(REPO, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
    args: [REPO],
    cwd: REPO,   // .env must load or Gmail-adjacent code paths silently degrade
    env: {
      ...process.env,
      ANJADHE_DATA_ROOT: dataRoot,
      // Puts journey files inside the fs:read/write no-grant scope so file
      // journeys run without permission prompts and never touch ~/Anjadhe.
      ANJADHE_APPS_DIR: docsDir,
      // The Library's folder gets the same treatment: a journey calling
      // library-scan must create/scan a throwaway dir, never the user's
      // real ~/Anjadhe/library (the never-real-data law).
      ANJADHE_LIBRARY_DIR: path.join(docsDir, '.library'),
      // The embedding engine lives in the SHARED ~/.anjadhe_llamacpp (not
      // redirected — multi-GB weights), so a host that downloaded the
      // model would make the keyword-degrade journeys nondeterministic.
      // The eval app always runs embedder-less; semantic-leg verification
      // is a manual run with this unset.
      ANJADHE_EMBED_OFF: '1'
    }
  });
  const page = await app.firstWindow();
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.electronStore.markSetupComplete());
  await page.reload();
  await page.waitForTimeout(3000);
  await installStubs(page);
  return { app, page };
}

async function installStubs(page) {
  await page.evaluate(() => {
    window.__eval = { notifs: [], calls: [], stubs: {} };
    window.Notification = class {
      // The Notify funnel (js/core/notify.js) only constructs a banner when
      // permission is granted — the stub must say so or nothing is captured.
      static permission = 'granted';
      constructor(title, opts) { window.__eval.notifs.push({ title, body: opts?.body }); }
    };
    AgentService._confirmWrite = async () => ({ approved: true, scope: 'once' });
    const orig = AgentTools.execute.bind(AgentTools);
    // ctx must pass through: the recorder dropping it silently turned every
    // untrusted eval turn into a trusted one (caught by
    // d1-untrusted-turn-skips-recall the day the parameter was added).
    AgentTools.execute = async (name, args, ctx) => {
      window.__eval.calls.push({ name, args });
      if (name in window.__eval.stubs) return window.__eval.stubs[name];
      return orig(name, args, ctx);
    };
  });
}

/** Reset the per-journey slate: agent stores + recorder. App stays up. */
async function resetState(page) {
  await page.evaluate(() => {
    window.__eval.notifs = [];
    window.__eval.calls = [];
    window.__eval.stubs = {};
    StorageManager.set('agent-recipes', []);
    StorageManager.set('agent-write-ledger', []);
    StorageManager.set('agent-automations', []);
    // Settle any live task so one journey's leftovers can't block the next.
    const tasks = (StorageManager.get('agent-tasks') || []).map(t =>
      t && ['planning', 'running', 'verifying', 'awaiting_user', 'paused'].includes(t.status)
        ? { ...t, status: 'failed', note: 'eval reset' } : t);
    StorageManager.set('agent-tasks', tasks);
  });
}

/** Prepare a scratch docs dir with the checked-in fixtures. */
function makeDocsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anjadhe-evals-'));
  for (const f of fs.readdirSync(FIXTURES)) {
    if (f.endsWith('.js')) continue;
    fs.copyFileSync(path.join(FIXTURES, f), path.join(dir, f));
  }
  return dir;
}

module.exports = { REPO, FIXTURES, launchApp, installStubs, resetState, makeDocsDir };
