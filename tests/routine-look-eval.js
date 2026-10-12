#!/usr/bin/env node
/**
 * Routine look eval — the gate for the scheduled look's prompt and checks
 * (docs/ROUTINES_UX.md "Routines are instructions", step 1; flag
 * `routinelooks` stays off until this passes on nenva cloud lite and nenva
 * local). Runs RoutineLook's OWN run (its input, prompt, AgentLoop and
 * checks) against a real model; only the model transport and the read
 * tools are stubbed. Fixtures are SYNTHETIC, shaped like the visa-bulletin
 * routine that reported unchanged dates for a month (2026-10-09).
 *
 * The gate's numbers (all should be 0):
 *   FALSE NEWS        a report with changes when nothing changed (same
 *                     bulletin; a third-party summary that disagrees with
 *                     the official page; a source that failed)
 *   MISSED NEWS       a new bulletin with no report, or a report whose
 *                     changes miss the moved value
 *   CARD AGAINST WISH a card for a change the person said not to be told about
 *   REPEATED ITEMS    a delivery that re-reports an item already delivered
 *   NO NOTEBOOK       a look that read the source and kept nothing
 * Also printed: CHECK REFUSALS (the checks corrected the model; fine in
 * moderation, a sign the prompt is unclear when high).
 *
 * A local model (llama-server, OpenAI-compatible):
 *   ~/.nenva_llamacpp/engine/llama-server -m <model>.gguf --port 8097 -c 16384 --jinja
 *   LOOK_PORT=8097 LOOK_MODEL=nenva-local node tests/routine-look-eval.js [--only s1,s3] [--verbose]
 * nenva cloud lite, metered as background work on that key's allowance:
 *   LOOK_URL=https://api.nenva.co/v1/llm LOOK_KEY=<a Connect key> LOOK_MODEL=nenva-cloud-lite node tests/routine-look-eval.js
 */
const http = require('http');
const https = require('https');
const PORT = Number(process.env.LOOK_PORT) || 8097;
const BASE = process.env.LOOK_URL || `http://127.0.0.1:${PORT}/v1`;
const KEY = process.env.LOOK_KEY || '';
const MODEL = process.env.LOOK_MODEL || 'nenva-local';
const VERBOSE = process.argv.includes('--verbose');
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? new Set(String(process.argv[i + 1] || '').split(',')) : null; })();

function chat(p) {
    return new Promise((resolve) => {
        const url = new URL(`${BASE.replace(/\/$/, '')}/chat/completions`);
        const body = JSON.stringify({ model: MODEL, messages: p.messages, temperature: 0.2, max_tokens: p.maxTokens || 1600, stream: false,
            ...(p.tools ? { tools: p.tools } : {}), ...(KEY ? {} : { chat_template_kwargs: { enable_thinking: false } }) });
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname, method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(KEY ? { authorization: `Bearer ${KEY}`, 'X-Nenva-Work': 'background' } : {}) } }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                try { const j = JSON.parse(data); resolve({ message: j.choices[0].message }); }
                catch { resolve({ error: `bad answer (${res.statusCode}): ${String(data).slice(0, 160)}` }); }
            });
        });
        req.on('error', e => resolve({ error: e.message }));
        req.setTimeout(180000, () => { req.destroy(new Error('timeout')); });
        req.end(body);
    });
}
global.LLMLogger = { call: (_tag, p) => chat(p) };
global.AgentService = { model: MODEL, numCtx: 16384, getActiveModel: () => MODEL };
global.AgentLoop = require('../js/agent/agent-loop.js');
global.window = { electronSearch: { getStatus: async () => ({ enabled: true, unset: false }) } };
const L = require('../js/core/routine-look.js');

// ── Fixtures ──
const OFFICIAL = 'https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html';
const bulletin = (month, v) => `Visa Bulletin For ${month} 2026. A. FINAL ACTION DATES FOR EMPLOYMENT-BASED PREFERENCE CASES: 2nd: All Chargeability ${v.eb2w}; INDIA ${v.eb2i}. 3rd: All Chargeability ${v.eb3w}; INDIA ${v.eb3i}. B. DATES FOR FILING: 2nd: All Chargeability ${v.f2w}; INDIA ${v.f2i}. 3rd: All Chargeability ${v.f3w}; INDIA ${v.f3i}. USCIS: for ${month} 2026 use the ${v.chart} chart for employment-based filings.`;
const OCT = { eb2w: '01JAN25', eb2i: '01NOV13', eb3w: '15MAY24', eb3i: '01JAN14', f2w: '01DEC23', f2i: '15JAN15', f3w: '01JAN23', f3i: '15JAN15', chart: 'Dates for Filing' };
const NOV = { ...OCT, eb2i: '01JAN14', eb3i: '15FEB14' };
const NOTEBOOK = `October 2026 bulletin (${OFFICIAL}). Final Action: EB-2 Worldwide 01JAN25, EB-2 India 01NOV13, EB-3 Worldwide 15MAY24, EB-3 India 01JAN14. Dates for Filing: EB-2 Worldwide 01DEC23, EB-2 India 15JAN15, EB-3 Worldwide 01JAN23, EB-3 India 15JAN15. USCIS honoring Dates for Filing.`;
const LAST_RUN = `October 2026 bulletin: EB-2 India final action 01NOV13.\n\n| Category | India | Worldwide |\n|---|---|---|\n| EB-2 FAD | 01NOV13 | 01JAN25 |\n| EB-3 FAD | 01JAN14 | 15MAY24 |\n\nSource: ${OFFICIAL}`;
const VISA = 'Look up the latest published US Visa Bulletin and keep track of the Final Action Dates and Dates for Filing for EB-2 and EB-3, India and Worldwide, and which chart USCIS honors. List the URL.';

const scenarios = [
    { id: 's1', name: 'Same October bulletin, nothing moved', body: VISA, notebook: NOTEBOOK, lastRuns: [LAST_RUN],
        reads: { web_search: { results: [{ title: 'Visa Bulletin For October 2026', url: OFFICIAL, content: bulletin('October', OCT) }] }, read_url: { url: OFFICIAL, text: bulletin('October', OCT) } },
        expect: { report: false } },
    { id: 's2', name: 'A third-party summary disagrees; the official page has not changed', body: VISA, notebook: NOTEBOOK, lastRuns: [LAST_RUN],
        reads: { web_search: { results: [{ title: 'October 2026 Visa Bulletin predictions recap', url: 'https://example-immigration-blog.test/oct', content: 'October 2026: EB-3 Worldwide 01JAN22, EB-2 Worldwide 01SEP21 (estimates)' }] }, read_url: { url: OFFICIAL, text: bulletin('October', OCT) } },
        expect: { report: false } },
    { id: 's3', name: 'The November bulletin is out: EB-2 and EB-3 India moved', body: VISA, notebook: NOTEBOOK, lastRuns: [LAST_RUN],
        reads: { web_search: { results: [{ title: 'Visa Bulletin For November 2026', url: OFFICIAL, content: bulletin('November', NOV) }] }, read_url: { url: OFFICIAL, text: bulletin('November', NOV) } },
        expect: { report: true, card: true, moved: ['01JAN14', '15FEB14'] } },
    { id: 's4', name: 'The source fails', body: VISA, notebook: NOTEBOOK, lastRuns: [LAST_RUN],
        reads: { web_search: { error: 'search provider timed out' }, read_url: { error: 'HTTP 403 Forbidden' } },
        expect: { report: false } },
    { id: 's5', name: 'First look, empty notebook', body: VISA, notebook: null, lastRuns: [],
        reads: { web_search: { results: [{ title: 'Visa Bulletin For October 2026', url: OFFICIAL, content: bulletin('October', OCT) }] }, read_url: { url: OFFICIAL, text: bulletin('October', OCT) } },
        expect: { keep: true } },
    { id: 's6', name: 'The person said only EB-2 India matters; only EB-3 India moved', body: VISA, notebook: NOTEBOOK, lastRuns: [LAST_RUN],
        said: ['only tell me when EB-2 India moves, nothing else'],
        reads: { web_search: { results: [{ title: 'Visa Bulletin For November 2026', url: OFFICIAL, content: bulletin('November', { ...OCT, eb3i: '15FEB14' }) }] }, read_url: { url: OFFICIAL, text: bulletin('November', { ...OCT, eb3i: '15FEB14' }) } },
        expect: { noCard: true } },
    { id: 's7', name: 'A roundup delivered daily: one item is new', web: true,
        body: 'Each morning, give me a brief roundup of quantum computing news: company moves and research results.',
        notebook: 'Delivered Oct 8: IonQ completed its Capella acquisition; Microsoft and Qolab logical-qubit result (12 logical qubits).',
        lastRuns: ['Two quantum stories.\n\n- IonQ completed its acquisition of Capella.\n- Microsoft and Qolab reported 12 logical qubits.'],
        reads: { web_search: { results: [
            { title: 'IonQ completes Capella acquisition', url: 'https://news.test/ionq', content: 'IonQ completed its acquisition of Capella Space.' },
            { title: 'Microsoft, Qolab show 12 logical qubits', url: 'https://news.test/msft', content: '12 logical qubits with error rates below threshold.' },
            { title: 'Quantinuum raises $600M at $10B valuation', url: 'https://news.test/qtnm', content: 'Quantinuum raised $600 million at a $10 billion valuation on Oct 9.' }] } },
        expect: { report: true, mentions: ['Quantinuum'], notNew: ['Capella'] } }
];

let FALSE_NEWS = 0, MISSED = 0, CARD_WISH = 0, REPEATS = 0, NO_NOTEBOOK = 0, REFUSALS = 0;

async function runOne(sc) {
    const conv = { id: sc.id, title: sc.id === 's7' ? 'Quantum roundup' : 'Visa bulletin', messages: [], standing: { body: sc.body, config: {},
        ...(sc.notebook ? { notebook: { text: sc.notebook, at: new Date(Date.now() - 86400000).toISOString() } } : {}) } };
    for (const s of sc.said || []) conv.messages.push({ role: 'user', content: s });
    const runs = (sc.lastRuns || []).map((content, i) => ({ createdAt: new Date(Date.now() - (i + 1) * 86400000).toISOString(), content, error: null }));
    global.NotePrompts = { conversationOf: () => conv, config: () => ({ web: true, useContext: false, trigger: { type: 'time' } }),
        runs: () => runs, bodyText: () => sc.body, scheduleLabel: () => 'daily at 8:00 AM', isRun: () => false };
    const calls = [];
    global.AgentTools = {
        definitions: ['web_search', 'read_url'].map(name => ({ type: 'function', function: { name,
            description: name === 'web_search' ? 'Search the web.' : 'Read a web page by URL.',
            parameters: { type: 'object', properties: name === 'web_search' ? { query: { type: 'string' } } : { url: { type: 'string' } }, required: [name === 'web_search' ? 'query' : 'url'] } } })),
        async execute(name, args) {
            calls.push(name);
            // A page read finds the search result with that URL, unless the scenario says otherwise.
            if (name === 'read_url' && !sc.reads.read_url) {
                const hit = ((sc.reads.web_search || {}).results || []).find(x => x.url === (args && args.url));
                return hit ? { url: hit.url, text: `${hit.title}. ${hit.content}` } : { error: 'HTTP 404' };
            }
            return sc.reads[name] || { error: 'not available' };
        }
    };
    let refusals = 0;
    const loopRun = AgentLoop.run.bind(AgentLoop);
    AgentLoop.run = (o) => loopRun({ ...o, onEvent: (e) => { if (e.type === 'tool' && e.phase === 'error' && ['report', 'keep'].includes(e.name)) { refusals++; if (VERBOSE) console.log(`    refused ${e.name}: ${e.result.error}`); } } });
    const out = await L.run({ id: sc.id, title: conv.title });
    AgentLoop.run = loopRun;
    REFUSALS += refusals;
    const r = out.report;
    const fails = [];
    const e = sc.expect;
    if (out.error) fails.push(`run error: ${out.error}`);
    if (e.report === false && r) { FALSE_NEWS++; fails.push(`FALSE NEWS: ${r.changes.length ? r.changes.map(c => `${c.what} ${c.before}→${c.after}`).join('; ') : `"${r.headline}" (no changes)`}`); }
    if (e.report === true && !r) { MISSED++; fails.push('MISSED NEWS: no report'); }
    if (e.moved && r && !e.moved.every(v => r.changes.some(c => c.after === v))) { MISSED++; fails.push(`MISSED NEWS: changes ${JSON.stringify(r.changes)}`); }
    if (e.card && r && !r.card) fails.push('expected a card');
    if (e.noCard && r && r.card) { CARD_WISH++; fails.push('CARD AGAINST WISH'); }
    if (e.mentions && r && !e.mentions.every(m => r.body.includes(m))) { MISSED++; fails.push(`MISSED NEWS: body lacks ${e.mentions.join(', ')}`); }
    // An old item presented as news: in the headline, or a line naming it that does not say it was already covered.
    const SAID_OLD = /unchanged|already|yesterday|earlier|before|previous|covered|no change/i;
    if (e.notNew && r && e.notNew.some(m => r.headline.includes(m) || r.body.split('\n').some(l => l.includes(m) && !SAID_OLD.test(l)))) { REPEATS++; fails.push('REPEATED ITEMS'); }
    if (calls.length && Object.values(sc.reads).some(x => !x.error) && !out.keep) { NO_NOTEBOOK++; fails.push('NO NOTEBOOK'); }
    if (e.keep && !out.keep) fails.push('expected a notebook');
    console.log(`${fails.length ? 'FAIL' : 'pass'}  ${sc.id} ${sc.name}`);
    console.log(`      ${r ? `report${r.card ? ' +card' : ''}: "${r.headline}" ${r.changes.map(c => `[${c.what}: ${c.before || '∅'} → ${c.after}]`).join(' ')}` : `no report — ${out.reason || ''}`}${refusals ? ` (${refusals} refused)` : ''}`);
    if (out.dropped) console.log(`      (code dropped a no-change report: "${out.dropped}")`);
    for (const f of fails) console.log(`      ${f}`);
    if (VERBOSE && out.keep) console.log(`      kept: ${out.keep}`);
}

(async () => {
    console.log(`Routine look eval — ${MODEL} at ${BASE}\n`);
    for (const sc of scenarios) if (!ONLY || ONLY.has(sc.id)) await runOne(sc);
    console.log(`\nFALSE NEWS ${FALSE_NEWS} · MISSED NEWS ${MISSED} · CARD AGAINST WISH ${CARD_WISH} · REPEATED ITEMS ${REPEATS} · NO NOTEBOOK ${NO_NOTEBOOK} · check refusals ${REFUSALS}`);
    process.exit(FALSE_NEWS + MISSED + CARD_WISH + REPEATS + NO_NOTEBOOK ? 1 : 0);
})();
