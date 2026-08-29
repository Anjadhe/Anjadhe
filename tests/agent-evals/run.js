#!/usr/bin/env node
/**
 * Agent eval runner (docs/COWORK_AGENT.md C8.8).
 *
 *   node tests/agent-evals/run.js                  # everything, default model
 *   node tests/agent-evals/run.js --det-only       # harness net only (no model)
 *   node tests/agent-evals/run.js --model gemma4:12b-it-qat
 *   node tests/agent-evals/run.js --filter c84     # id substring
 *   node tests/agent-evals/run.js --gate           # fail on baseline regressions
 *
 * Deterministic journeys are the harness regression net — they stub the
 * model and must always pass. Model journeys produce the per-model
 * scorecard (pass rate, tool calls, wall clock) that gives the release-time
 * model-catalog review evidence. The gate compares against baseline.json:
 * a journey that passed there must pass now.
 *
 * Never run against real data: the runner seeds a throwaway
 * ANJADHE_DATA_ROOT and puts fixtures in a temp dir inside the fs scope.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { launchApp, resetState, makeDocsDir } = require('./helpers');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : d; };

const MODEL = opt('--model', 'qwen3.5:9b');
const FILTER = opt('--filter', '');
const DET_ONLY = flag('--det-only');
const GATE = flag('--gate');
const DATA_ROOT = '/tmp/anjadhe-agent-evals';
const RESULTS_DIR = path.join(__dirname, 'results');
const BASELINE = path.join(__dirname, 'baseline.json');
const JOURNEY_TIMEOUT_MS = { det: 60 * 1000, model: 7 * 60 * 1000 };

function loadJourneys() {
  const dir = path.join(__dirname, 'journeys');
  const all = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (f.endsWith('.js')) all.push(...require(path.join(dir, f)));
  }
  return all.filter(j =>
    (!FILTER || j.id.includes(FILTER)) && (!DET_ONLY || j.kind === 'det'));
}

async function main() {
  const journeys = loadJourneys();
  if (!journeys.length) { console.error('no journeys match'); process.exit(2); }

  // The C8.7 journeys need the local spec MCP server.
  const mcpServer = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'mcp-test-server.js')], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 500));

  const docs = makeDocsDir();
  console.log(`agent-evals: ${journeys.length} journeys · model ${MODEL} · docs ${docs}`);
  let ctx = await launchApp({ dataRoot: DATA_ROOT, docsDir: docs });
  await ctx.page.evaluate((m) => AgentService.setGlobalModel(m), MODEL);

  // The suite must SURVIVE an app crash mid-journey: mark the journey
  // failed, relaunch (without re-seeding), and keep going — a dead app must
  // never eat the scorecard.
  const ensureAlive = async () => {
    try { await ctx.page.evaluate(() => 1); return; } catch { /* dead */ }
    console.warn('app died — relaunching');
    try { await ctx.app.close(); } catch { /* already gone */ }
    // A crashed Electron orphans its llama-server child, which keeps port
    // 18434 and its OLD api key — the relaunched app then gets "Invalid API
    // Key" on every model call. Reap orphans (ppid 1 + the managed engine
    // path) before relaunching; a healthy app's server has a live parent
    // and is untouched.
    try {
      const { execSync } = require('child_process');
      const rows = execSync("ps -axo pid=,ppid=,command= | grep '.anjadhe_llamacpp/engine/llama-server' | grep -v grep || true", { encoding: 'utf8' });
      for (const line of rows.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+1\s/);
        if (m) { console.warn(`reaping orphaned llama-server ${m[1]}`); process.kill(Number(m[1])); }
      }
    } catch { /* best effort */ }
    ctx = await launchApp({ dataRoot: DATA_ROOT, docsDir: docs, seed: false });
    await ctx.page.evaluate((m) => AgentService.setGlobalModel(m), MODEL);
  };

  const results = [];
  for (const j of journeys) {
    await ensureAlive();
    await resetState(ctx.page).catch(() => {});
    const callsBefore = await ctx.page.evaluate(() => window.__eval.calls.length).catch(() => 0);
    const t0 = Date.now();
    let out;
    try {
      out = await Promise.race([
        j.run({ page: ctx.page, docs, model: MODEL }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('journey timed out')), JOURNEY_TIMEOUT_MS[j.kind] || 60000))
      ]);
    } catch (e) {
      out = { pass: false, detail: `threw: ${e.message}` };
    }
    const ms = Date.now() - t0;
    const toolCalls = (await ctx.page.evaluate(() => window.__eval.calls.length).catch(() => callsBefore)) - callsBefore;
    const row = { id: j.id, kind: j.kind, pass: !!out?.pass, ms, toolCalls, detail: (out?.detail || '').slice(0, 400) };
    results.push(row);
    console.log(`${row.pass ? 'PASS' : 'FAIL'} [${j.kind}] ${j.id} (${(ms / 1000).toFixed(1)}s, ${toolCalls} calls)${row.pass ? '' : ' — ' + row.detail}`);
  }

  await ctx.app.close().catch(() => {});
  mcpServer.kill();
  fs.rmSync(DATA_ROOT, { recursive: true, force: true });
  fs.rmSync(docs, { recursive: true, force: true });

  const det = results.filter(r => r.kind === 'det');
  const model = results.filter(r => r.kind === 'model');
  const scorecard = {
    model: MODEL,
    at: new Date().toISOString(),
    det: { pass: det.filter(r => r.pass).length, total: det.length },
    modelJourneys: { pass: model.filter(r => r.pass).length, total: model.length },
    wallClockMs: results.reduce((s, r) => s + r.ms, 0),
    toolCalls: results.reduce((s, r) => s + r.toolCalls, 0),
    results
  };
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outFile = path.join(RESULTS_DIR, `${MODEL.replace(/[^a-z0-9.-]+/gi, '_')}-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outFile, JSON.stringify(scorecard, null, 2));
  console.log(`\nScorecard: det ${scorecard.det.pass}/${scorecard.det.total}`
    + (model.length ? ` · model ${scorecard.modelJourneys.pass}/${scorecard.modelJourneys.total}` : '')
    + ` · ${(scorecard.wallClockMs / 60000).toFixed(1)} min · ${scorecard.toolCalls} tool calls`);
  console.log(`Saved ${outFile}`);

  // Gate: everything that passed in the baseline must still pass.
  if (GATE) {
    if (!fs.existsSync(BASELINE)) { console.error('gate: no baseline.json — run once and copy a scorecard in'); process.exit(2); }
    const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    const nowById = new Map(results.map(r => [r.id, r]));
    const regressions = (base.passing || []).filter(id => nowById.has(id) && !nowById.get(id).pass);
    if (regressions.length) {
      console.error(`\nGATE FAILED — regressions vs baseline (${base.model}): ${regressions.join(', ')}`);
      process.exit(1);
    }
    console.log(`\nGate passed — no regressions vs baseline (${base.model}).`);
  }

  process.exit(results.every(r => r.pass) ? 0 : 1);
}

main().catch(e => { console.error('runner error:', e); process.exit(2); });
