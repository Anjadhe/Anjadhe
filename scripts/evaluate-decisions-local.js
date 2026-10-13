#!/usr/bin/env node
'use strict';
/**
 * Real models, no fakes (Ram, 2026-10-13): the decision model is Microsoft-
 * Decision-1 through OpenRouter, reached through a REAL nenva Connect booted
 * here in-process from the sibling checkout; the generative baseline is the
 * local llama-server (Ram's Qwen on 127.0.0.1:8080), which Connect is pointed
 * at as its upstream, so `--compare-current` goes through Connect's own
 * /v1/llm path. Nothing is deployed and Ram's servers are never started or
 * stopped. Receipts and results land in reports/decision-local-<day>/.
 *
 *   node scripts/evaluate-decisions-local.js --sets sender-demo,matter-demo [--compare-current]
 *   node scripts/evaluate-decisions-local.js --threads-demo [--only auto,dental] [--verbose]
 *   node scripts/evaluate-decisions-local.js --serve
 *
 * Sets: sender, sender-holdout, sender-demo, matter, matter-demo.
 * --threads-demo boots Connect in ACTIVE mode with provisional thresholds
 * (the approved policies: sender 0.96 same / 0.65 different, matter 0.90 / 0.90, qualification "demo-2026-10-13";
 * never a production value) and runs tests/threads-demo-eval.js with the real
 * decision client wired in (THREADS_DECISION_URL), the local Qwen as the brain.
 *
 * The OpenRouter key: DECISION_API_KEY in the environment, or --key-file <path>
 * (default /tmp/nenva-decision-key-azu_enki.env, the file the first live
 * screening used; never in Git).
 */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const CONNECT = process.env.NENVA_CONNECT_DIR || path.resolve(ROOT, '../anjadhe-connect');
const args = process.argv.slice(2);
const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const LLM_URL = (process.env.NENVA_LOCAL_LLM_URL || 'http://127.0.0.1:8080/v1').replace(/\/$/, '');
const LLM_MODEL = process.env.NENVA_LOCAL_LLM_MODEL || 'qwen3.8-27b';
const EXPECTED = process.env.DECISION_EXPECTED_MODEL || 'microsoft/microsoft-decision-1-20261009';

function readKey() {
    if (process.env.DECISION_API_KEY) return process.env.DECISION_API_KEY;
    const file = value('--key-file') || '/tmp/nenva-decision-key-azu_enki.env';
    if (!fs.existsSync(file)) throw new Error('No OpenRouter key: set DECISION_API_KEY or --key-file');
    const line = fs.readFileSync(file, 'utf8').split('\n').find(l => l.startsWith('DECISION_API_KEY='));
    if (!line) throw new Error('Key file holds no DECISION_API_KEY');
    return line.slice('DECISION_API_KEY='.length).trim();
}
async function bootConnect({ mode, matterMode }) {
    if (!fs.existsSync(path.join(CONNECT, 'lib/decisions.js'))) throw new Error('Connect checkout with decision support is required: ' + CONNECT);
    const health = await fetch(LLM_URL + '/models', { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (!health || !health.ok) throw new Error('The local llama-server is not answering at ' + LLM_URL + ' (never started from here)');
    delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
    Object.assign(process.env, {
        DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'nenva-decision-local-')), NODE_ENV: 'development',
        ENV_LABEL: 'local-evaluation', SEARCH_MOCK: '1', ADMIN_TOKEN: crypto.randomBytes(16).toString('hex'),
        LICENSE_SIGNING_KEY: '',
        // The local Qwen is Connect's generative upstream for both public tiers.
        LLM_UPSTREAM_URL: LLM_URL, LLM_UPSTREAM_KEY: 'local',
        LLM_MODELS: JSON.stringify({ 'nenva-cloud-lite': { upstream: LLM_MODEL, label: 'nenva cloud lite (local Qwen)' },
            'nenva-cloud-pro': { upstream: LLM_MODEL, label: 'nenva cloud pro (local Qwen)' } }),
        LLM_TIER_QUOTAS: JSON.stringify({ free: { requests: 5000, tokens: 50000000 } }), LLM_BUDGET_TOKENS: '100000000',
        // One install runs every case back to back (two calls each): lift the per-minute gate for it.
        LLM_PER_MINUTE: JSON.stringify({ free: 600 }), LLM_MAX_CONCURRENT: JSON.stringify({ free: 8 }),
        // The real decision backend, exactly as production would be configured.
        DECISION_MODE: mode, DECISION_API_KEY: readKey(), DECISION_DIGEST_KEY: crypto.randomBytes(32).toString('hex'),
        DECISION_ZDR_VERIFIED: '1', DECISION_EXPECTED_MODEL: EXPECTED, DECISION_QUALIFICATION_ID: 'demo-2026-10-13',
        // The candidate policies the 2026-10-13 screening chose (docs/DECISION_MODELS.md
        // "Live screening on the demo"): sender 0.96 / 0.65, matter 0.90 / 0.90.
        DECISION_SENDER_ACCEPT_AT: '0.96', DECISION_SENDER_DIFFERENT_AT: '0.65',
        DECISION_MATTER_MODE: matterMode, DECISION_MATTER_ACCEPT_AT: '0.9', DECISION_MATTER_DIFFERENT_AT: '0.9',
        DECISION_MATTER_QUALIFICATION_ID: 'demo-2026-10-13', DECISION_BUDGET_TOKENS: '2000000', DECISION_ROLLOUT_PERCENT: '100'
    });
    delete process.env.LLM_MOCK; delete process.env.DECISION_MOCK;
    const app = require(path.join(CONNECT, 'server'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const base = 'http://127.0.0.1:' + server.address().port;
    const mint = await fetch(base + '/v1/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installId: 'local-evaluation-' + crypto.randomUUID() }) });
    const key = (await mint.json()).apiKey;
    const cap = await (await fetch(base + '/v1/decisions/capabilities')).json();
    if (cap.mode !== mode) throw new Error('Connect did not enable decisions (mode ' + cap.mode + '); check the key and env');
    console.log(`Connect (local, in-process) at ${base}: decisions ${cap.mode}, matter ${cap.useCases?.['matter-membership']?.mode}, backend ${cap.backendRevision}; LLM upstream ${LLM_URL} (${LLM_MODEL})`);
    return { base, key, server };
}
async function runSets(sets, compareCurrent) {
    const E = require('./evaluate-decisions');
    const C = require('../js/shared/decision-contract');
    const { base, key, server } = await bootConnect({ mode: 'evaluate', matterMode: 'evaluate' });
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(ROOT, 'reports', 'decision-local-' + day);
    fs.mkdirSync(dir, { recursive: true });
    const SETS = {
        'sender': ['sender-membership', E.USE_CASES['sender-membership'].fixtures],
        'sender-holdout': ['sender-membership', E.USE_CASES['sender-membership'].holdout],
        'sender-demo': ['sender-membership', E.USE_CASES['sender-membership'].demo],
        'matter': ['matter-membership', E.USE_CASES['matter-membership'].fixtures],
        'matter-demo': ['matter-membership', E.USE_CASES['matter-membership'].demo]
    };
    const summaries = {};
    try {
        for (const name of sets) {
            if (!SETS[name]) throw new Error('Unknown set ' + name + '; one of ' + Object.keys(SETS).join(', '));
            const [useCase, cases] = SETS[name];
            const reportFile = path.join(dir, `${name}-${crypto.randomUUID().slice(0, 8)}.json`);
            console.log(`\n== ${name}: ${cases.length} cases, ${useCase}${compareCurrent ? ', paired with the local generative check' : ''} -> ${path.relative(ROOT, reportFile)}`);
            const t0 = Date.now();
            const report = await E.evaluate({ base, key, cloudModel: C.CLOUD_MODELS[0], compareCurrent, cases, reportFile, useCase });
            summaries[name] = { useCase, cases: cases.length, seconds: Math.round((Date.now() - t0) / 1000), ...report.summary };
            printSummary(name, cases, report);
        }
    } finally { await new Promise(resolve => server.close(resolve)); }
    fs.writeFileSync(path.join(dir, 'summary-' + Date.now() + '.json'), JSON.stringify(summaries, null, 2));
    return summaries;
}
function printSummary(name, cases, report) {
    const d = report.summary.decision;
    console.log(`  decision: ${d.attempts} scored, ${d.tokensIn} tokens in, ${d.costMicros == null ? 'cost unknown' : '$' + (d.costMicros / 1e6).toFixed(4)}, p50 ${d.latencyMs.p50} ms, p95 ${d.latencyMs.p95} ms, Brier ${d.brier == null ? 'n/a' : d.brier.toFixed(3)}`);
    for (const t of d.thresholds) console.log(`    same>=${t.acceptAt} different>=${t.differentAt}: wrong joins ${t.falseJoins}, wrong refusals ${t.wrongRefusals}, known resolved ${t.knownResolved}/${t.known}, ambiguous resolved ${t.ambiguousResolved}/${t.ambiguous}${t.passesSyntheticScreening ? '  PASS' : ''}`);
    if (report.summary.baseline) {
        const b = report.summary.baseline;
        console.log(`  local generative check: wrong joins ${b.falseJoins}, wrong refusals ${b.wrongRefusals}, known resolved ${b.knownResolved}/${b.known}, ambiguous resolved ${b.ambiguousResolved}/${b.ambiguous}, p50 ${b.latencyMs.p50} ms, p95 ${b.latencyMs.p95} ms`);
    }
    // The misses, by fixture id (ids only; the report keeps no source text either).
    const byId = Object.fromEntries(cases.map(c => [c.id, c]));
    for (const o of report.outcomes) {
        if (o.decision?.status !== 'scored') continue;
        const p = o.decision;
        const read = p.choice === 'same' && p.probability >= 0.96 ? true : p.choice === 'different' && p.differentProbability >= 0.65 ? false : null;
        const tag = read === true && o.expected !== true ? 'WRONG JOIN' : read === false && o.expected === true ? 'WRONG REFUSAL' : read !== null && o.expected === null ? 'AMBIGUOUS RESOLVED' : read === null && o.expected !== null ? 'deferred' : null;
        if (tag && tag !== 'deferred' || (tag === 'deferred' && args.includes('--verbose'))) console.log(`    ${tag}: ${o.fixture} (expected ${o.expected}, ${p.choice} same=${p.probability.toFixed(3)} different=${p.differentProbability.toFixed(3)}${o.baseline ? `; generative said ${o.baseline.same}` : ''})`);
        void byId;
    }
}
async function runThreadsDemo() {
    const { base, key, server } = await bootConnect({ mode: 'active', matterMode: 'active' });
    try {
        const extra = ['--only', '--verbose'].flatMap(f => f === '--only' ? (value('--only') ? ['--only', value('--only')] : []) : args.includes(f) ? [f] : []);
        console.log(`\n== tests/threads-demo-eval.js with REAL decisions (${base}) and the local brain ${LLM_MODEL}\n`);
        const code = await new Promise(resolve => {
            const child = spawn(process.execPath, [path.join(ROOT, 'tests/threads-demo-eval.js'), ...extra], { stdio: 'inherit', env: { ...process.env,
                THREADS_URL: LLM_URL, THREADS_MODEL: LLM_MODEL, THREADS_KEY: '',
                THREADS_DECISION_URL: base, THREADS_DECISION_KEY: key } });
            child.on('exit', resolve);
        });
        console.log(`\nthreads-demo-eval exit ${code}`);
        const stats = await (await fetch(base + '/v1/admin/decisions', { headers: { Authorization: 'Bearer ' + process.env.ADMIN_TOKEN } })).json();
        if (Array.isArray(stats.decisions)) console.log('Connect accounting:', JSON.stringify(stats.decisions));
        return code;
    } finally { await new Promise(resolve => server.close(resolve)); }
}
/**
 * --serve: keep the local Connect up in ACTIVE mode with the approved policies
 * so a real nenva instance can use it (Ram, 2026-10-13: "test with real data
 * and iterate"). Launch nenva against it with ANJADHE_CONNECT_URL; every
 * Connect call (catalog, key, cloud chat, decisions) goes there, and its
 * "nenva cloud lite" is the local Qwen. Ctrl-C stops it; nothing is deployed.
 */
async function serve() {
    const { base, server } = await bootConnect({ mode: 'active', matterMode: 'active' });
    console.log(`\nLocal Connect is up with decisions ACTIVE (sender 0.96 / 0.65, matter 0.90 / 0.90). Launch a test nenva against it:\n`);
    console.log(`  ANJADHE_CONNECT_URL=${base} ANJADHE_DATA_ROOT=/tmp/nenva-decision-test ANJADHE_SIM=1 npm start -- --use-mock-keychain`);
    console.log(`\nPick nenva cloud lite as the brain there (decisions fire only on a nenva cloud route), seed with --scenario threads-demo or connect a mailbox, and watch Threads. Ctrl-C here to stop.\n`);
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
    await new Promise(resolve => server.close(resolve));
    console.log('Local Connect stopped.');
}
(async () => {
    if (args.includes('--serve')) { await serve(); return; }
    if (args.includes('--threads-demo')) { process.exitCode = await runThreadsDemo(); return; }
    const sets = (value('--sets') || 'sender-demo,matter-demo').split(',').map(s => s.trim()).filter(Boolean);
    await runSets(sets, args.includes('--compare-current'));
})().catch(error => { console.error(error.message || error); process.exitCode = 1; });
