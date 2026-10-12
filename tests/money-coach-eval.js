#!/usr/bin/env node
/**
 * Money coach eval (docs/MONEY_COACH.md; docs/SENDERS.md M6b): does the
 * coach's OWN look (MoneyCoach.look over Coach.runLook and the real
 * AgentLoop, with its real checks) raise what deserves it, and name the
 * [item …] a raise is about, so its card lands in that thing's thread?
 * Only the transport, the sheet's sources and the read tools are stubbed.
 * Fixtures SYNTHETIC.
 *
 * The numbers (all should be zero):
 *   EXPECTATIONS MISSED  a scenario that needs a raise got none
 *   ITEM MISSING         a raise about the scenario's one bill or goal named no item
 *   WRONG ITEM           a raise named a different item
 *   WRITES ATTEMPTED     calls to a tool the look does not have
 *
 *   SENDERS_PORT=8097 node tests/money-coach-eval.js [--verbose]
 *   SENDERS_URL=https://api.nenva.co/v1/llm SENDERS_KEY=<a Connect key> SENDERS_MODEL=nenva-cloud-lite node tests/money-coach-eval.js
 */
const http = require('http');
const https = require('https');
const PORT = Number(process.env.SENDERS_PORT) || 8097;
const BASE = process.env.SENDERS_URL || `http://127.0.0.1:${PORT}/v1`;
const KEY = process.env.SENDERS_KEY || '';
const MODEL = process.env.SENDERS_MODEL || 'nenva-local';
const VERBOSE = process.argv.includes('--verbose');

function chat(p) {
    return new Promise((resolve) => {
        const url = new URL(`${BASE.replace(/\/$/, '')}/chat/completions`);
        const body = JSON.stringify({ model: MODEL, messages: p.messages, temperature: 0.2, max_tokens: p.maxTokens || 900, stream: false,
            ...(p.tools ? { tools: p.tools } : {}), ...(KEY ? {} : { chat_template_kwargs: { enable_thinking: false } }) });
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname, method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(KEY ? { authorization: `Bearer ${KEY}`, 'X-Nenva-Work': 'background' } : {}) } }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => { try { resolve({ message: JSON.parse(data).choices[0].message }); } catch { resolve({ error: `bad answer (${res.statusCode}): ${String(data).slice(0, 160)}` }); } });
        });
        req.on('error', e => resolve({ error: e.message }));
        req.setTimeout(180000, () => req.destroy(new Error('timeout')));
        req.end(body);
    });
}
global.LLMLogger = { call: (_tag, p) => chat(p) };
global.AgentService = { model: MODEL, numCtx: 16384 };
const ls = new Map();
global.localStorage = { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) };
global.AgentLoop = require('../js/agent/agent-loop.js');
global.Coach = require('../js/core/coach.js');
const MF = require('../js/core/money-facts.js');
global.MoneyFacts = MF;
const MC = require('../js/core/money-coach.js');
{ const vet = MC.vetRaise.bind(MC); MC.vetRaise = (...a) => { const r = vet(...a); if (VERBOSE && r.error) console.log(`      ! ${r.error}`); return r; }; }

let WRITES = 0;
{
    const run = AgentLoop.run.bind(AgentLoop);
    AgentLoop.run = (o) => run({ ...o, onEvent: (e) => {
        if (e.type === 'tool' && e.phase === 'start' && !(o.tools || []).some(t => t.function && t.function.name === e.name)) WRITES++;
        if (VERBOSE && e.type === 'tool' && e.phase === 'start') console.log(`      > ${e.name} ${JSON.stringify(e.args || {}).slice(0, 300)}`);
    } });
}
global.AgentTools = { definitions: [{ type: 'function', function: { name: 'list_commitments', description: 'Their open commitments.', parameters: { type: 'object', properties: {} } } }],
    execute: async (name) => (name === 'list_commitments' ? { items: [] } : (WRITES++, { error: 'not allowed' })) };

const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const ym = n => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const bank = (checking, savings) => ({ accounts: [{ name: 'Checking', type: 'checking', balance: checking }, { name: 'Savings', type: 'savings', balance: savings }],
    months: [{ month: ym(0), spend: 900, refunds: 0, income: 0, byCategory: [] }, { month: ym(1), spend: 4200, refunds: 0, income: 5200, byCategory: [] },
        { month: ym(2), spend: 4100, refunds: 0, income: 5200, byCategory: [] }, { month: ym(3), spend: 4300, refunds: 0, income: 5200, byCategory: [] }], recurring: [] });

const SCENARIOS = [
    { id: 'c1', name: 'Property tax of $3,850 due in 5 days, $1,240 in the bank', expect: 'raise', item: 'matter:tax', data: () => ({ withheld: [], portfolio: null,
        spending: bank(1240, 0), matters: [{ id: 'matter:tax', kind: 'bill', state: 'open', title: 'County property tax, second installment', amount: '$3,850', due: day(5), step: 'Pay by the due date' }] }) },
    { id: 'c2', name: 'Emergency fund goal far behind pace, $9,000 idle in checking', expect: 'raise', item: 'task:c-fund', data: () => ({ withheld: [], portfolio: null,
        spending: bank(9000, 600), matters: [], goals: [{ id: 'c-fund', title: 'Emergency fund', amount: 15000, by: day(120), accounts: ['Savings'] }],
        progress: (g, a, t) => ({ id: g.id, title: g.title, target: g.amount, saved: 600, pct: 4, by: g.by, left: 14400, monthsLeft: 4, perMonthNeeded: 3600 }) }) },
    { id: 'c3', name: 'All calm: bills small, cash steady, no goals', expect: 'any', data: () => ({ withheld: [], portfolio: null,
        spending: bank(12000, 20000), matters: [{ id: 'matter:water', kind: 'bill', state: 'open', title: 'City water bill', amount: '$84', due: day(12) }] }) }
];

(async () => {
    const out = { missed: [], noItem: [], wrong: [] };
    for (const sc of SCENARIOS) {
        ls.clear();
        const data = sc.data();
        MoneyFacts.current = (_ctx, now) => MF.sheet(data, now);
        const t0 = Date.now();
        const r = await MC.look(new Date());
        const raised = (r && r.raised) || [];
        console.log(`${sc.id} ${sc.name} (${((Date.now() - t0) / 1000).toFixed(0)}s, ${r ? r.stop : 'no look'})`);
        for (const c of raised) console.log(`    RAISED [${c.item || 'no item'}]: ${c.title} — ${c.body}`);
        if (sc.expect === 'raise' && !raised.length) out.missed.push(sc.id);
        if (sc.item && raised.length && !raised.some(c => c.item === sc.item)) out.noItem.push(sc.id);
        for (const c of raised) if (c.item && sc.item && c.item !== sc.item) out.wrong.push(`${sc.id}:${c.item}`);
    }
    console.log(`\nEXPECTATIONS MISSED ${out.missed.length} ${out.missed.join(' ')} · ITEM MISSING ${out.noItem.length} ${out.noItem.join(' ')} · WRONG ITEM ${out.wrong.length} ${out.wrong.join(' ')} · WRITES ATTEMPTED ${WRITES}`);
    process.exit(out.missed.length + out.noItem.length + out.wrong.length + WRITES ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
