#!/usr/bin/env node
/**
 * Routine conversion eval (docs/ROUTINES_UX.md step 5): RoutineConvert's OWN
 * proposal call and checks against a real model, over synthetic copies of
 * the kinds of routine a real install has (a visa-bulletin watch, a market
 * verdict, a news roundup, a strategy review, a mail watch, a money
 * check-in, a morning briefing).
 *
 *   MISSING       no valid proposal for a routine
 *   WRONG HOME    the wrong watcher (mail / money / its own)
 *   WRONG TELLS   a watch made a delivery or the reverse
 *
 * LOOK_URL / LOOK_KEY / LOOK_MODEL as in tests/routine-look-eval.js.
 */
const http = require('http');
const https = require('https');
const BASE = process.env.LOOK_URL || `http://127.0.0.1:${Number(process.env.LOOK_PORT) || 8097}/v1`;
const KEY = process.env.LOOK_KEY || '';
const MODEL = process.env.LOOK_MODEL || 'nenva-local';
function chat(p) {
    return new Promise((resolve) => {
        const url = new URL(`${BASE.replace(/\/$/, '')}/chat/completions`);
        const body = JSON.stringify({ model: MODEL, messages: p.messages, temperature: 0.1, max_tokens: 1600, stream: false, response_format: { type: 'json_object' },
            ...(KEY ? {} : { chat_template_kwargs: { enable_thinking: false } }) });
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname, method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(KEY ? { authorization: `Bearer ${KEY}`, 'X-Nenva-Work': 'background' } : {}) } }, (res) => {
            let data = ''; res.on('data', c => { data += c; });
            res.on('end', () => { try { resolve({ message: JSON.parse(data).choices[0].message }); } catch { resolve({ error: `bad answer (${res.statusCode})` }); } });
        });
        req.on('error', e => resolve({ error: e.message }));
        req.end(body);
    });
}
const ls = new Map();
global.localStorage = { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)) };
global.LLMLogger = { call: (_t, p) => chat(p) };
const RC = require('../js/core/routine-convert.js');
RC._has = () => ({ mail: true, money: true });

const R = (id, title, when, body, lastRuns, want) => ({ id, title, when, body, lastRuns, cfg: { offline: true, trigger: { type: 'time' } }, want });
const list = [
    R('visa', 'Latest Visa Bulletin Dates', 'daily at 8:00 AM', 'Look up the latest published US Visa Bulletin and report the Final Action Dates and Dates for Filing for EB-2 and EB-3 in a table, India and Worldwide. State which bulletin is the latest and which chart USCIS honors. List the URL.',
        ['October 2026 Visa Bulletin is the latest — EB-2 India is back from Unavailable at Nov 1, 2013', 'September 2026 bulletin is current — EB-2 India still unavailable.'], { watcher: [null], tells: ['change'] }),
    R('crack', 'AI semiconductor crack watch (daily)', 'weekdays at 5:00 PM', 'Watch for a "crack" in the AI semiconductor trade and report the verdict. WATCH-ONLY: never recommend a trade. Name the index and one firm number. MUST END with a firm verdict.',
        ['Verdict: INTACT — HOLD (none fired).', 'INTACT — HOLD; no crack in the AI semis trade as of Oct 6.'], { watcher: [null, 'money'], tells: ['change'] }),
    R('quantum', 'Quantum Computing News Roundup', 'daily at 8:00 AM', 'Provide a brief news roundup on quantum computing: the state of the field, notable company moves, and recent research. Bold headings and bullet points.',
        ['Quantum roundup — Friday, October 9, 2026', 'Microsoft and Qolab reset the bar for logical qubits'], { watcher: [null], tells: ['each'] }),
    R('strategy', 'Strategy Review: Core Growth', 'weekdays at 8:00 AM', 'Review my investment strategy "Core Growth": check_strategy, refresh prices, read my holdings, then write a short review of drift and whether the plan still fits.',
        ['International sleeve has slipped below band while everything else holds.', 'AI sleeve is 3 points over target; international under its band'], { watcher: ['money'], tells: ['change', 'each'] }),
    R('uspto', 'USPTO trademark mail watch', 'new email from "uspto.gov"', 'When an email from the USPTO about my trademark arrives, summarize what it says and any deadline.',
        [], { watcher: ['mail'], tells: [null] }),
    R('money', 'Money Check-in', 'weekly', 'Once a week, look at my spending, cash and bills and tell me how my money is doing.',
        [], { watcher: ['money'], tells: ['each', 'change'] }),
    R('brief', 'Morning briefing', 'daily at 7:00 AM', 'Write a concise morning briefing: today\'s calendar and tasks, overdue items, and email action items.',
        ['Nothing on the calendar — a clear day, but two calls and a security check need you.'], { watcher: [null], tells: ['each'] })
];
(async () => {
    console.log(`Routine conversion eval — ${MODEL} at ${BASE}\n`);
    await RC.propose(list);
    const st = RC.state();
    let missing = 0, home = 0, tells = 0;
    for (const r of list) {
        const p = st.proposals[r.id] && st.proposals[r.id].proposal;
        const fails = [];
        if (!p) { missing++; fails.push('MISSING'); }
        else {
            if (!r.want.watcher.includes(p.watcher)) { home++; fails.push(`WRONG HOME: ${p.watcher || 'its own'}`); }
            if (!r.want.tells.includes(p.tells)) { tells++; fails.push(`WRONG TELLS: ${p.tells}`); }
        }
        console.log(`${fails.length ? 'FAIL' : 'pass'}  ${r.title}${p ? `  →  ${p.watcher || 'its own'}, ${p.tells || '-'}: "${p.saysBack}"` : ''}`);
        for (const f of fails) console.log(`      ${f}`);
    }
    console.log(`\nMISSING ${missing} · WRONG HOME ${home} · WRONG TELLS ${tells}`);
    process.exit(missing + home + tells ? 1 : 0);
})();
