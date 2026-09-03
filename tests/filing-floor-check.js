#!/usr/bin/env node
/**
 * Filing check for the Actions assistant-filing prompt, two tiers:
 *
 *  - floor: the original 3-task 12B-floor spot check (docs/POSITIONING.md
 *    release gate) — untouched as the regression floor.
 *  - v2 (2026-08-31): harder judgment probes named on the 16 GB reference
 *    Mac, where the tuned 4B filed "Buy stamps" into the taxes project the
 *    moment the eval matched the app's real think-off call shape. Ambiguous
 *    everyday tasks that PULL toward a listed project must land "none";
 *    clear mappings sit alongside so answering "none" everywhere can't pass.
 *
 * Sends the EXACT prompt + call shape ActionsApp._fileActions uses
 * (700-token cap, think off, JSON mode — the capped-think trap's third
 * appearance was this eval timing out at 4B generation speed without them).
 *
 * Start a server first, e.g.:
 *   llama-server -m ~/.anjadhe_llamacpp/models/<model>.gguf --port 8080 --jinja
 * then:
 *   node tests/filing-floor-check.js            # uses gemma4:12b-it-qat (the shipped default)
 *   FILING_MODEL=llama4-13b FILING_PORT=8080 node tests/filing-floor-check.js
 */

const http = require('http');

const MODEL = process.env.FILING_MODEL || 'gemma4:12b-it-qat';
const PORT = Number(process.env.FILING_PORT) || 8080;
const TODAY = new Date().toISOString().slice(0, 10);

const systemFor = (goalLines) => `You are a personal task-filing assistant. Today is ${TODAY}.

The user's open projects:
${goalLines}

For each numbered task below, decide:
- "goal": the project id (G1, G2, ...) the task CLEARLY serves, or "none". Most everyday tasks serve no listed project — when unsure, use "none".
- "date": only for tasks marked (no date), and ONLY when the task text clearly implies a timeframe — a specific day, event, or deadline. Format YYYY-MM-DD. Omit "date" otherwise.

Respond ONLY with a JSON object mapping each task number to its verdict, e.g. {"1":{"goal":"G2"},"2":{"goal":"none","date":"${TODAY}"}}.`;

const SCENARIOS = [
    {
        tier: 'floor',
        goals: 'G1: Learn piano — practice daily\nG2: File 2025 taxes',
        tasks: `1. Book piano lesson (no date)\n2. Gather W2 and 1099 forms (no date)\n3. Buy stamps (scheduled ${TODAY})`,
        checks: [
            ['piano task -> G1', (m) => m['1']?.goal === 'G1'],
            ['tax-forms task -> G2', (m) => m['2']?.goal === 'G2'],
            ['stamps task -> none', (m) => (m['3']?.goal || 'none') === 'none'],
        ],
    },
    {
        tier: 'v2',
        goals: 'G1: File 2025 taxes\nG2: Plan Mom’s 70th birthday party\nG3: Renovate the bathroom',
        tasks: [
            `1. Buy stamps (no date)`,                              // pulls toward taxes AND invitations — none
            `2. Order tile samples (no date)`,                      // clearly G3
            `3. Send party invitations (no date)`,                  // clearly G2
            `4. Pick up prescription refill (scheduled ${TODAY})`,  // everyday — none
            `5. Get quotes from two contractors (no date)`,         // clearly G3
            `6. Call the accountant about the extension (no date)`, // clearly G1
        ].join('\n'),
        checks: [
            ['stamps (ambiguous pull) -> none', (m) => (m['1']?.goal || 'none') === 'none'],
            ['tile samples -> G3', (m) => m['2']?.goal === 'G3'],
            ['party invitations -> G2', (m) => m['3']?.goal === 'G2'],
            ['prescription -> none', (m) => (m['4']?.goal || 'none') === 'none'],
            ['contractor quotes -> G3', (m) => m['5']?.goal === 'G3'],
            ['accountant extension -> G1', (m) => m['6']?.goal === 'G1'],
        ],
    },
];

function call(scenario) {
    const body = JSON.stringify({
        model: MODEL,
        stream: false,
        // Mirror _fileActions' call shape: 700-token cap + think off (the app
        // sends think:false, which main.js openaiRequest translates to this
        // kwarg) + JSON mode + greedy decoding. Without these the check
        // drifts from the shipped call — caught 2026-08-31 on the reference
        // Mac, where unbounded hidden thinking blew the 180s timeout.
        temperature: 0,
        response_format: { type: 'json_object' },
        max_tokens: 700,
        chat_template_kwargs: { enable_thinking: false },
        messages: [
            { role: 'system', content: systemFor(scenario.goals) },
            { role: 'user', content: scenario.tasks },
        ],
    });
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port: PORT, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' } },
            (res) => {
                let d = '';
                res.on('data', (c) => d += c);
                res.on('end', () => resolve(d));
            }
        );
        req.on('error', (e) => reject(new Error(`No OpenAI-compatible server reachable on 127.0.0.1:${PORT} (${e.message})`)));
        req.setTimeout(180000, () => { req.destroy(); reject(new Error('Timed out')); });
        req.end(body);
    });
}

(async () => {
    let fails = 0;
    const tierScores = [];
    for (const sc of SCENARIOS) {
        let map;
        try {
            const d = await call(sc);
            const content = JSON.parse(d).choices[0].message.content;
            map = JSON.parse(content.match(/\{[\s\S]*\}/)[0]);
        } catch (e) {
            console.error(`FAIL  [${sc.tier}] ${e.message || 'response did not parse as JSON'}`);
            fails += sc.checks.length;
            tierScores.push(`${sc.tier} 0/${sc.checks.length}`);
            continue;
        }
        let tierPass = 0;
        for (const [name, check] of sc.checks) {
            const pass = check(map);
            console.log(`${pass ? 'PASS' : 'FAIL'}  [${sc.tier}] ${name}`);
            if (pass) tierPass++; else fails++;
        }
        tierScores.push(`${sc.tier} ${tierPass}/${sc.checks.length}`);
        console.log(`  verdicts=${JSON.stringify(map)}`);
    }
    console.log(`\nmodel=${MODEL} · ${tierScores.join(' · ')}`);
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(2); });
