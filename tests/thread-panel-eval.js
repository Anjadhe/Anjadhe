#!/usr/bin/env node
/**
 * Thread panel eval: the gate for ThreadPanels.judge's prompt
 * (docs/THREAD_PANELS.md V3). Runs the judge's OWN code against a model;
 * only the transport and the store are stubbed. Fixtures SYNTHETIC.
 *
 * The numbers (all should be zero):
 *   UNPARSED          answers that were not the JSON asked for
 *   LABELS INVENTED   labels in the answer that are not one of the blocks
 *                     shown (B1, B2…; code drops them)
 *   FIGURES INVENTED  figures asked for that the thread does not keep
 *   EXPECTATIONS MISSED  a case's one plain expectation (e.g. the goal's
 *                     own progress before a list of dates) not met
 *
 *   PANELS_PORT=8097 node tests/thread-panel-eval.js [--verbose]
 *   PANELS_URL=https://api.nenva.co/v1/llm PANELS_KEY=<a Connect key> PANELS_MODEL=nenva-cloud-lite node tests/thread-panel-eval.js
 */
const http = require('http');
const https = require('https');
const PORT = Number(process.env.PANELS_PORT) || 8097;
const BASE = process.env.PANELS_URL || `http://127.0.0.1:${PORT}/v1`;
const KEY = process.env.PANELS_KEY || '';
const MODEL = process.env.PANELS_MODEL || 'nenva-local';
const VERBOSE = process.argv.includes('--verbose');

function chat(p) {
    return new Promise((resolve) => {
        const url = new URL(`${BASE.replace(/\/$/, '')}/chat/completions`);
        const body = JSON.stringify({ model: MODEL, messages: p.messages, temperature: 0.2, max_tokens: p.maxTokens || 400, stream: false,
            ...(KEY ? {} : { chat_template_kwargs: { enable_thinking: false } }) });
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname, method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(KEY ? { authorization: `Bearer ${KEY}`, 'X-Nenva-Work': 'background' } : {}) } }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => { try { resolve({ message: JSON.parse(data).choices[0].message }); } catch { resolve({ error: `bad answer (${res.statusCode}): ${String(data).slice(0, 160)}` }); } });
        });
        req.on('error', e => resolve({ error: e.message }));
        req.end(body);
    });
}

let store = { byKey: {} };
let lastRaw = null;
global.StorageManager = { get: () => store, set: (k, v) => { store = v; } };
global.AgentService = { model: MODEL, numCtx: 8192 };
global.LLMLogger = { call: async (source, p) => { const r = await chat(p); lastRaw = r.message ? r.message.content : null; return r; } };
global.AnswerBlocks = require('../js/components/answer-blocks.js');
const ThreadPanels = require('../js/core/thread-panels.js');

const b = (id, label, block) => ({ id, label, block });
const CASES = [
    { id: 'p1', title: 'Better sleep', allGood: 'Asleep by 11 most nights and 7.5 hours or more.',
        blocks: [b('coming', 'Coming up', { kind: 'table', title: 'Coming up', columns: [{ key: 'what' }], rows: [{}, {}] }),
            b('days:s1', 'Days', { kind: 'days', title: 'Log sleep', days: new Array(20).fill({}) }),
            b('progress:line:g1:sleep', 'Progress', { kind: 'line', points: new Array(14).fill({}) }),
            b('progress:stats:g1', 'Progress', { kind: 'stats', items: [{ label: 'sleep now (h)' }, { label: 'Aim' }] })],
        measures: ['sleep', 'bedtime'],
        expect: (arr) => arr.order[0] !== 'coming' && !arr.hidden.includes('progress:stats:g1'),
        expectText: 'where the goal stands comes before the list of dates' },
    { id: 'p2', title: 'Utilities', allGood: 'Every bill paid, no unexplained spike.',
        blocks: [b('coming', 'Coming up', { kind: 'table', title: 'Coming up', columns: [{ key: 'what' }], rows: [{}] }),
            b('amounts:months', 'Amounts', { kind: 'bar', title: 'By month', items: new Array(6).fill({}) }),
            b('amounts:latest', 'Amounts', { kind: 'table', title: 'Amounts', columns: [{ key: 'what' }], rows: new Array(8).fill({}) })],
        measures: [],
        expect: (arr) => !arr.hidden.includes('amounts:months'),
        expectText: 'the monthly amounts are kept (a spike is the point)' },
    { id: 'p3', title: 'Build muscle', allGood: 'Three workouts a week and the lifts going up.',
        blocks: [b('progress:stats:g2', 'Progress', { kind: 'stats', items: [{ label: 'bench press now (lb)' }, { label: 'This stage' }] }),
            b('progress:line:g2:bench press', 'Progress', { kind: 'line', points: new Array(9).fill({}) }),
            b('days:w1', 'Days', { kind: 'days', title: 'Workout', days: new Array(12).fill({}) })],
        measures: ['bench press', 'squat', 'weight'],
        expect: (arr) => arr.hidden.length === 0,
        expectText: 'nothing hidden on a three-block goal' }
];

(async () => {
    const totals = { unparsed: 0, ids: 0, figures: 0, missed: 0 };
    for (const c of CASES) {
        store = { byKey: {} };
        lastRaw = null;
        const row = { key: `sender:${c.id}`, title: c.title, rec: { allGood: c.allGood } };
        const realMeasures = ThreadPanels.measuresOf;
        ThreadPanels.measuresOf = () => c.measures;
        const ok = await ThreadPanels.judge(row, c.blocks, {});
        ThreadPanels.measuresOf = realMeasures;
        let raw = null;
        try { raw = JSON.parse(String(lastRaw || '').replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim()); } catch { raw = null; }
        if (!raw) { totals.unparsed++; console.log(`${c.id} UNPARSED: ${String(lastRaw).slice(0, 200)}`); continue; }
        const labels = new Set(c.blocks.map((x, i) => `B${i + 1}`));
        const invented = [...(raw.order || []), ...(raw.hidden || [])].filter(x => !labels.has(String(x).replace(/[[\]]/g, '').toUpperCase()));
        const figs = (raw.lines || []).filter(m => !c.measures.some(n => n.toLowerCase() === String(m).toLowerCase()));
        totals.ids += invented.length;
        totals.figures += figs.length;
        const arr = store.byKey[row.key] || { order: [], hidden: [], measures: [] };
        const met = ok && c.expect(arr);
        if (!met) totals.missed++;
        console.log(`${c.id} ${met ? 'ok  ' : 'MISS'} order=${JSON.stringify(arr.order)} hidden=${JSON.stringify(arr.hidden)} figures=${JSON.stringify(arr.measures)}${invented.length ? ` invented=${JSON.stringify(invented)}` : ''}${figs.length ? ` figuresInvented=${JSON.stringify(figs)}` : ''}${met ? '' : ` (expected: ${c.expectText})`}`);
        if (VERBOSE) console.log(`   raw: ${lastRaw}`);
    }
    console.log(`\nUNPARSED ${totals.unparsed} · LABELS INVENTED ${totals.ids} · FIGURES INVENTED ${totals.figures} · EXPECTATIONS MISSED ${totals.missed}`);
})();
