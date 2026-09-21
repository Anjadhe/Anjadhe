#!/usr/bin/env node
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { _electron } = require('playwright-core');
const { cases, version } = require('./cases.cjs');
const { createScenario, grade, scorecard } = require('./engine.cjs');
const args = process.argv.slice(2), option = (name, fallback) => { const i = args.indexOf(name); if (i < 0) return fallback; if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(name + ' requires a value'); return args[i + 1]; };
const repo = path.resolve(__dirname, '../..'), hash = text => crypto.createHash('sha256').update(text).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function runCase(page, spec) {
    await page.evaluate(({ spec, code }) => {
        window.__specialistEvalResult = null;
        const fixture = (0, eval)('(' + code + ')')(spec);
        const def = Specialists.get(spec.specialty);
        if (!def) throw new Error('Specialist unavailable: ' + spec.specialty);
        const books = def.needs.browser ? Playbooks.forTask(spec.task) : [];
        // The REAL loop, guard, brief and tool schemas; every tool is synthetic.
        // There is never a fallback to a live handler, even on an unexpected call.
        AgentLoop.run({ source: 'workrooms', subject: 'Specialist evaluation', system: Specialists.system(def, { playbooks: Playbooks.text(books) }),
            input: 'Your job, from Anjadhe:\n' + spec.task, tools: AgentTools.definitions.filter(tool => def.tools.includes(tool.function?.name)),
            maxSteps: def.needs.browser ? 40 : 10, budgetMs: 120000, maxTokens: def.id === 'writer' ? 2500 : 1200, vision: false,
            guard: SpecialistRuntime.createGuard(), execute: async (name, args) => fixture.execute(name, args)
        }).then(out => { window.__specialistEvalResult = { ...out, calls: fixture.calls, violations: fixture.violations, url: fixture.url }; })
            .catch(error => { window.__specialistEvalResult = { error: error.message, stop: 'error', text: '', calls: fixture.calls, violations: fixture.violations, url: fixture.url }; });
    }, { spec, code: createScenario.toString() });
    const deadline = Date.now() + 165000;
    while (Date.now() < deadline) {
        const value = await page.evaluate(() => window.__specialistEvalResult);
        if (value) return value;
        await delay(1000);
    }
    // Abort the suite, not just this case: a runaway call must never overlap
    // the next case or contaminate its fixture/score.
    throw new Error('Specialist did not settle within its hard deadline');
}
async function main() {
    if (args.includes('--list')) { for (const spec of cases) console.log(`${spec.specialty}: ${spec.id}${spec.critical ? ' (mandatory)' : ''}`); return; }
    const model = option('--model');
    if (!model) throw new Error('Choose --model explicitly. Use --list to inspect the synthetic cases.');
    const engine = option('--engine', 'llamacpp'), specialty = option('--specialty', ''), filter = option('--filter', '');
    const repeats = Number(option('--repeats', '3')), numCtx = Number(option('--num-ctx', '16384')), think = option('--think', 'off');
    if (!['llamacpp', 'server', 'openai', 'anthropic', 'anjadhe'].includes(engine)) throw new Error('Unsupported engine');
    if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10 || !Number.isInteger(numCtx) || numCtx < 4096 || numCtx > 262144 || !['on', 'off'].includes(think)) throw new Error('Invalid repeats, context size, or thinking setting');
    const baseUrl = option('--base-url'), keyEnv = option('--key-env', 'ANJADHE_EVAL_KEY');
    if (engine === 'server') {
        const url = new URL(baseUrl);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use a server base URL without credentials, query or fragment');
    }
    const key = process.env[keyEnv] || '';
    if (['openai', 'anthropic'].includes(engine) && !key) throw new Error('Set the API key in ' + keyEnv + '; keys are never written into reports');
    const selected = cases.filter(spec => (!specialty || spec.specialty === specialty) && (!filter || spec.id.includes(filter)));
    if (!selected.length) throw new Error('No matching cases');
    // Refuse to compete with the real app's local engine; never kill it.
    if (engine === 'llamacpp') {
        const net = require('node:net');
        const occupied = await new Promise(resolve => { const socket = net.connect(18434, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
        if (occupied) throw new Error('Port 18434 is in use. Unload the local model in Anjadhe before running this local evaluation.');
    }
    const entry = { id: 'specialist-eval-model', engine, model, numCtx, think: think === 'on', ...(engine === 'server' ? { baseUrl } : {}) };
    const config = { model, engine, numCtx, think: think === 'on', ...(baseUrl ? { endpointHash: hash(baseUrl) } : {}) };
    const sources = ['js/agent/agent-loop.js', 'js/agent/specialists/runtime.js', 'js/agent/specialists/registry.js', 'js/agent/specialists/playbooks.js', 'js/agent/specialists/browser-tools.js', 'js/agent/agent-tools.js', 'js/apps/reader/library-tools.js', 'tests/specialist-evals/cases.cjs', 'tests/specialist-evals/engine.cjs', 'tests/specialist-evals/run.cjs'];
    const contractHash = hash(sources.map(file => file + '\n' + fs.readFileSync(path.join(repo, file), 'utf8')).join('\n'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anjadhe-specialist-evals-')), rows = [];
    fs.mkdirSync(path.join(root, 'userData'));
    fs.writeFileSync(path.join(root, 'userData/anjadhe-app-settings.json'), JSON.stringify({ setupComplete: true, syncEnabled: false }));
    const stamp = new Date().toISOString(), outDir = path.resolve(option('--out', path.join(__dirname, '../agent-evals/results')));
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `specialists-${model.replace(/[^a-z0-9.-]/gi, '_')}-${stamp.replace(/[:.]/g, '-')}.json`);
    const save = () => fs.writeFileSync(outPath, JSON.stringify({ version, at: stamp, candidate: config, contractHash, configurationHash: hash(JSON.stringify(config)),
        scope: 'Synthetic specialist fixtures through the actual AgentLoop, guard, briefs and tool schemas. Passing is a fixture gate, not certification of live websites or subjective writing quality.',
        specialties: scorecard(cases, rows), results: rows }, null, 2));
    let ctx;
    try {
        console.log(`Specialist evals: ${selected.length} cases × ${repeats} repeats; ${engine}/${model}. Synthetic data only.`);
        const env = { ...process.env, ANJADHE_DATA_ROOT: root, ANJADHE_EMBED_OFF: '1' }; delete env.ELECTRON_RUN_AS_NODE;
        const app = await _electron.launch({ executablePath: require('electron'), args: [repo], cwd: repo, env });
        ctx = { app, page: await app.firstWindow() };
        ctx.page.setDefaultTimeout(30000);
        await ctx.page.waitForFunction(() => typeof AgentService !== 'undefined' && typeof FEATURES !== 'undefined' && document.querySelector('.view.active'));
        console.log('Isolated app ready; enabling specialist tools.');
        await ctx.page.evaluate(() => FEATURES.setOverride('workrooms', true));
        await ctx.page.reload();
        await ctx.page.waitForFunction(() => typeof Specialists !== 'undefined' && typeof AgentLoop !== 'undefined' && typeof AgentService !== 'undefined' && typeof BrowserTools !== 'undefined');
        await ctx.page.evaluate(async ({ entry, key }) => {
            clearInterval(WorkroomsApp._timer); WorkroomEngine.tick = async () => {};
            AgentService._kickBackgroundAI = () => {};
            for (const id of AgentService._streamingState.keys()) AgentService.abortConversation(id);
            AgentService.saveModelList([entry], entry.id);
            if (key) await electronLLM.setEntryKey(entry.id, key);
            await AgentService._syncBrainToEntry(entry);
        }, { entry, key });
        console.log('Candidate configured; starting model cases.');
        for (let repeat = 1; repeat <= repeats; repeat++) for (const spec of selected) {
            console.log(`RUN ${spec.id} #${repeat}`);
            const started = Date.now();
            const run = await runCase(ctx.page, spec), result = grade(spec, run);
            const kind = run.stop === 'error' ? 'execution-error' : 'model';
            const row = { id: spec.id, specialty: spec.specialty, repeat, kind, ms: Date.now() - started, ...result,
                report: run.text || null, stop: run.stop, stopReason: run.reason?.reason || null, error: run.error || null, calls: run.calls };
            rows.push(row); save();
            console.log(`${row.pass ? 'PASS' : 'FAIL'} ${spec.id} #${repeat} · ${(row.ms / 1000).toFixed(1)}s · ${row.attemptedCalls} calls${row.pass ? '' : ' · ' + [...row.failures, ...row.criticalFailures].join('; ')}`);
        }
    } finally {
        save();
        if (ctx) {
            await ctx.app.close().catch(() => {});
        }
        fs.rmSync(root, { recursive: true, force: true });
        console.log('Scorecard: ' + outPath);
    }
    for (const row of scorecard(cases, rows)) console.log(`${row.specialty}: ${row.status} (${row.passed}/${row.runs})`);
    if (rows.some(row => !row.pass)) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 2; });
