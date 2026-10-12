#!/usr/bin/env node
/**
 * Sender look eval: the gate for SenderLook's prompt (docs/SENDERS.md M6).
 * Runs the look's OWN code (SenderLook.look over Coach.runLook and the real
 * AgentLoop, with its real checks) against a model; only the transport, the
 * folders, the Now cards and the read tools are stubbed. Fixtures SYNTHETIC,
 * dated relative to today.
 *
 * The numbers (all should be zero):
 *   EXPECTATIONS MISSED   a scenario that needs a raise got none, or a quiet
 *                         one (everything fine, or already in front of them)
 *                         got one
 *   NUMBERS NOT READ      raises refused for a number nobody read
 *   REPEATS REFUSED       raises refused for an item already in front of them
 *   WRITES ATTEMPTED      calls to a tool the look does not have
 *
 *   SENDERS_PORT=8097 node tests/sender-look-eval.js [--only l1,l3] [--verbose]
 *   SENDERS_URL=https://api.nenva.co/v1/llm SENDERS_KEY=<a Connect key> SENDERS_MODEL=nenva-cloud-lite node tests/sender-look-eval.js
 */
const http = require('http');
const https = require('https');
const PORT = Number(process.env.SENDERS_PORT) || 8097;
const BASE = process.env.SENDERS_URL || `http://127.0.0.1:${PORT}/v1`;
const KEY = process.env.SENDERS_KEY || '';
const MODEL = process.env.SENDERS_MODEL || 'nenva-local';
const VERBOSE = process.argv.includes('--verbose');
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? new Set(String(process.argv[i + 1] || '').split(',')) : null; })();

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

let blob = null;
const ls = new Map();
global.StorageManager = { get: () => blob, set: (_k, v) => { blob = JSON.parse(JSON.stringify(v)); } };
global.localStorage = { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) };
global.Commitments = require('../js/core/commitments.js');
global.CoachDomains = require('../js/core/coach-domains.js');
global.SenderKinds = require('../js/core/sender-kinds.js');
global.AgentLoop = require('../js/agent/agent-loop.js');
global.Coach = require('../js/core/coach.js');
global.Senders = require('../js/core/senders.js');
Senders._changed = () => {};
const L = require('../js/core/sender-look.js');

let WRITES = 0, refusedNums = 0, refusedRepeat = 0;
{
    const run = AgentLoop.run.bind(AgentLoop);
    AgentLoop.run = (o) => run({ ...o, onEvent: (e) => {
        if (e.type === 'tool' && e.phase === 'start' && !(o.tools || []).some(t => t.function && t.function.name === e.name)) WRITES++;
        if (VERBOSE && e.type === 'tool' && e.phase === 'start') console.log(`      > ${e.name} ${JSON.stringify(e.args || {}).slice(0, 300)}`);
    } });
    const vet = L.vetRaise.bind(L);
    L.vetRaise = (a, o) => { const r = vet(a, o); if (r.error && /not in anything/.test(r.error)) refusedNums++; if (r.error && /already in front/.test(r.error)) refusedRepeat++; if (VERBOSE && r.error) console.log(`      ! ${r.error}`); return r; };
}

const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const ago = h => new Date(Date.now() - h * 3600000).toISOString();
let MATTERS = [], ON_NOW = {};
global.Matters = {
    get: id => MATTERS.find(m => m.id === id) || null, all: () => MATTERS,
    titleOf: m => m.title, openStep: m => m.next || null, messagesOf: m => (m.messages || []).map(x => ({ from: x.from, at: x.date, summary: x.said })), whenText: m => (m.when && m.when.date ? m.when.date : '')
};
global.ThreadsPage = { _cardFor: key => (ON_NOW[key] ? { title: ON_NOW[key] } : null) };
const READS = {
    get_matter: { def: { name: 'get_matter', description: 'One tracked item in full: its facts, next step and every email filed on it.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
        run: a => { const id = String(a.id || ''); const m = Matters.get(id) || Matters.get(`matter:${id}`); return m ? { title: m.title, kind: m.kind, state: m.state, status: m.status, when: m.when, amount: m.amount, next: m.next, messages: m.messages } : { error: 'No item with that id.' }; } },
    get_commitment: { def: { name: 'get_commitment', description: 'One commitment in full.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
        run: a => { const c = Commitments.get(String(a.id || '').replace(/^task:/, '')); return c ? { title: c.title, state: c.state, when: c.when, by: c.by } : { error: 'No commitment with that id.' }; } },
    list_calendar_events: { def: { name: 'list_calendar_events', description: 'Calendar events in a date range.', parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } } }, run: () => ({ events: [] }) }
};
global.AgentTools = { definitions: Object.values(READS).map(t => ({ type: 'function', function: t.def })),
    execute: async (name, args) => (READS[name] ? READS[name].run(args || {}) : (WRITES++, { error: 'not allowed' })) };

const M = (id, kind, title, o = {}) => ({ id: `matter:${id}`, kind, state: 'open', title, updatedAt: ago(5), ...o });
const SCENARIOS = [
    { id: 'l1', name: 'Auto insurance: renewal in 6 days, nothing done', expect: 'raise', sender: ['Auto insurance', 'Covered, paid, the renewal not missed, the price still fair.'], build() {
        MATTERS = [M('r', 'bill', 'GEICO auto policy renewal', { status: 'Renews soon; payment not set up', amount: '$684', when: { date: day(6) }, next: { what: 'Review the renewal and pay' },
            messages: [{ from: 'GEICO', date: day(-4), said: `Your 6-month policy renews on ${day(6)} at $684 (was $612). Log in to review and pay.` }] }),
            M('i', 'other', 'New ID cards', { state: 'done', status: 'Printed' })];
    } },
    { id: 'l2', name: 'Utilities: everything paid, next bill on autopay', expect: 'quiet', sender: ['Utilities', 'Every bill paid on time, no unexplained spike.'], build() {
        MATTERS = [M('w', 'bill', 'City water bill', { state: 'done', status: 'Paid' }), M('e', 'bill', 'PG&E electric bill', { state: 'done', status: 'Paid' }),
            M('e2', 'bill', 'PG&E October statement', { status: 'Autopay scheduled', amount: '$142', when: { date: day(20) }, messages: [{ from: 'PG&E', date: day(-1), said: `Your statement of $142 will be paid automatically on ${day(20)}. Last month: $138.` }] })];
    } },
    { id: 'l3', name: 'Subscriptions: Netflix price goes up next month', expect: 'raise', sender: ['Subscriptions', 'Every charge is one they want; trials cancelled before they charge.'], build() {
        MATTERS = [M('n', 'subscription', 'Netflix price change', { status: 'Goes up next month', amount: '$24.99', when: { date: day(25) },
            messages: [{ from: 'Netflix', date: day(-2), said: `Your Standard plan goes from $17.99 to $24.99 a month starting ${day(25)}.` }] }),
            M('s', 'subscription', 'Spotify Premium', { status: 'Renews monthly', amount: '$11.99' })];
    } },
    { id: 'l4', name: 'Your dental: the cleaning is already on Now', expect: 'quiet', sender: ['Your dental', 'Cleanings every six months, nothing left unpaid.'], build() {
        MATTERS = [M('d', 'appointment', 'Dental cleaning with Dr. Lee', { status: 'Confirmed', when: { date: day(9) }, next: { what: 'Confirm the appointment' },
            messages: [{ from: 'Lee Family Dentistry', date: day(-1), said: `Reminder: cleaning on ${day(9)} at 9:00 AM. Reply C to confirm.` }] })];
        ON_NOW = { 'matter:d': 'Confirm your cleaning with Dr. Lee' };
    } },
    { id: 'l5', name: 'Maya\'s music classes: tuition due in 3 days, unpaid', expect: 'raise', sender: ['Maya\'s music classes', 'Tuition paid on time, recitals on the calendar.'], build() {
        MATTERS = [M('t', 'bill', 'Harmony Music School tuition', { status: 'Due soon', amount: '$240', when: { date: day(3) }, next: { what: 'Pay October tuition' },
            messages: [{ from: 'Harmony Music School', date: day(-5), said: `October tuition of $240 for Maya's piano lessons is due ${day(3)}.` }] }),
            M('rc', 'appointment', 'Winter piano recital', { status: 'Save the date', when: { date: day(60) } })];
    } }
];

(async () => {
    const missed = [];
    for (const sc of SCENARIOS) {
        if (ONLY && !ONLY.has(sc.id)) continue;
        blob = null; Senders._data = null; ls.clear(); MATTERS = []; ON_NOW = {};
        sc.build();
        const s = Senders.create(sc.sender[0], sc.sender[1]);
        for (const m of MATTERS) Senders.move(m.id, s.id);
        const t0 = Date.now();
        const r = await L.look(s.id, new Date());
        const raised = (r && r.raised) || [];
        console.log(`${sc.id} ${sc.name} (${((Date.now() - t0) / 1000).toFixed(0)}s, ${r ? r.stop : 'no look'})`);
        for (const c of raised) console.log(`    RAISED: ${c.title} — ${c.body} [${c.offer}] ask: ${c.prompt}`);
        for (const n of (r && r.notes) || []) console.log(`    note: ${n.text}`);
        if (sc.expect === 'raise' && !raised.length) missed.push(`${sc.id} (no raise)`);
        if (sc.expect === 'quiet' && raised.length) missed.push(`${sc.id} (raised)`);
    }
    console.log(`\nEXPECTATIONS MISSED ${missed.length} ${missed.join(' ')} · NUMBERS NOT READ ${refusedNums} · REPEATS REFUSED ${refusedRepeat} · WRITES ATTEMPTED ${WRITES}`);
    process.exit(missed.length + WRITES ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
